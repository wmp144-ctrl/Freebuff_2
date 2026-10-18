/**
 * NetWatch — سری‌های روزانه
 * ----------------------------------------------------------------
 * جدول samples پس از `retention_days` هرس می‌شود و گزارش‌های بلندمدت نمی‌توانند
 * روی آن تکیه کنند؛ جدول daily_stats (که موتور هر چند دقیقه به‌روزش می‌کند) برای
 * همین کار ساخته شده است.
 *
 * این ماژول یک نقطهٔ مشترک برای خواندن همان داده‌هاست:
 *   • روزهای کامل‌شده  ← daily_stats  (بدون اسکن میلیون‌ها ردیف نمونه)
 *   • روز جاری         ← samples      (تا اعداد داشبورد تازه بمانند)
 *
 * مرز روزها همان روز تقویمی محلی (timezone_offset_minutes) است — دقیقاً همان
 * مرزی که موتور در تجمیع به کار می‌برد — پس نتیجهٔ دو مسیر یکسان است.
 */
import { db } from './db.js';

export const DAY_MS = 86400000;

/** شروع روز تقویمی محلی که شامل `ts` است */
export function dayStart(ts, offsetMin = 0) {
  const off = (Number(offsetMin) || 0) * 60000;
  return Math.floor((ts + off) / DAY_MS) * DAY_MS - off;
}

/** برچسب تاریخ (YYYY-MM-DD) روزی که از `dayStartMs` شروع می‌شود */
export function dayLabel(dayStartMs, offsetMin = 0) {
  return new Date(dayStartMs + (Number(offsetMin) || 0) * 60000).toISOString().slice(0, 10);
}

/** عبارت تغییر زمانی SQLite برای همان اختلاف زمانی */
export function tzModifier(offsetMin = 0) {
  const m = Number(offsetMin) || 0;
  return `${m >= 0 ? '+' : '-'}${Math.abs(m)} minutes`;
}

const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

function point({ day, checks, okCount, rttSum, rttCount }) {
  const c = Number(checks) || 0;
  const ok = Number(okCount) || 0;
  const rttN = Number(rttCount) || 0;
  return {
    day,
    checks: c,
    availability: c ? round2((ok / c) * 100) : null,
    avgRtt: rttN ? round2(Number(rttSum) / rttN) : null,
    lossPct: c ? round2(((c - ok) / c) * 100) : null,
  };
}

/**
 * سری روزانه در بازهٔ [from, to].
 * @param {{from:number,to:number,clause?:string,params?:Array,offsetMin?:number}} options
 *        `clause` همان شرط فیلتر گزارش‌هاست (با AND شروع می‌شود) و روی جدول‌های
 *        devices/groups اعمال می‌شود تا فیلتر گروه/تگ/تجهیز در هر دو مسیر یکسان باشد.
 */
/**
 * بازه‌های زمانی را به «روزهای کامل» و «لبه‌های ناقص» تقسیم می‌کند تا
 * گزارش‌ها روزهای کامل را از daily_stats (بدون اسکن نمونه خام) و فقط روزهای
 * ناقص/جاری را از samples بخوانند.
 */
export function splitRange(from, to, offsetMin = 0) {
  const offset = Number(offsetMin) || 0;
  const fromDay = dayStart(from, offset);
  const toDay = dayStart(to, offset);
  // روزی کامل است که از ابتدای روز شروع شود و تا انتهای همان روز ادامه داشته باشد
  const fullStart = from <= fromDay ? fromDay : fromDay + DAY_MS;
  const fullEnd = to >= toDay + DAY_MS - 1 ? toDay + DAY_MS : toDay;
  const edges = [];
  if (fullStart < fullEnd) {
    const leftTo = Math.min(to, fullStart - 1);
    if (from <= leftTo) edges.push([from, leftTo]);
    const rightFrom = Math.max(from, fullEnd);
    if (rightFrom <= to) edges.push([rightFrom, to]);
  } else {
    if (from <= to) edges.push([from, to]);
  }
  return { fullStart, fullEnd, hasFullDays: fullStart < fullEnd, edges };
}

/**
 * مجموع شاخص‌های هر تجهیز در بازه: روزهای کامل از daily_stats و لبه‌ها از
 * samples. خروجی Map با کلید شناسهٔ تجهیز است.
 * @returns {Map<number, {checks:number, failed:number, rttSum:number, rttCount:number, minRtt:number|null, maxRtt:number|null}>}
 */
export function deviceTotals({ from, to, clause = '', params = [], offsetMin = 0 }) {
  const out = new Map();
  if (!(to >= from)) return out;
  const { fullStart, fullEnd, hasFullDays, edges } = splitRange(from, to, offsetMin);
  const offset = Number(offsetMin) || 0;
  const fullWindow = missingFullDays(fullStart, fullEnd, hasFullDays, offset);

  const merge = (row) => {
    const cur = out.get(row.id) || { checks: 0, failed: 0, rttSum: 0, rttCount: 0, minRtt: null, maxRtt: null };
    cur.checks += Number(row.checks) || 0;
    cur.failed += Number(row.failed) || 0;
    cur.rttSum += Number(row.rtt_sum) || 0;
    cur.rttCount += Number(row.rtt_count) || 0;
    if (row.min_rtt != null) cur.minRtt = cur.minRtt == null ? Number(row.min_rtt) : Math.min(cur.minRtt, Number(row.min_rtt));
    if (row.max_rtt != null) cur.maxRtt = cur.maxRtt == null ? Number(row.max_rtt) : Math.max(cur.maxRtt, Number(row.max_rtt));
    out.set(row.id, cur);
  };

  if (hasFullDays) {
    db.prepare(
      `SELECT ds.device_id AS id,
              SUM(ds.checks) AS checks, SUM(ds.failed) AS failed,
              SUM(CASE WHEN ds.avg_rtt IS NOT NULL THEN ds.avg_rtt * (ds.checks - ds.failed) ELSE 0 END) AS rtt_sum,
              SUM(CASE WHEN ds.avg_rtt IS NOT NULL THEN ds.checks - ds.failed ELSE 0 END) AS rtt_count,
              MIN(ds.min_rtt) AS min_rtt, MAX(ds.max_rtt) AS max_rtt
         FROM daily_stats ds
         JOIN devices d ON d.id = ds.device_id
         LEFT JOIN groups g ON g.id = d.group_id
        WHERE ds.day >= ? AND ds.day < ? ${clause}
        GROUP BY ds.device_id`
    )
      .all(dayLabel(fullStart, offset), dayLabel(fullEnd, offset), ...params)
      .forEach(merge);
  }

  const sampleStmt = db.prepare(
    `SELECT s.device_id AS id, COUNT(*) AS checks,
            SUM(CASE WHEN s.ok=0 THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN s.ok=1 THEN s.rtt_ms END) AS rtt_sum,
            SUM(CASE WHEN s.ok=1 THEN 1 ELSE 0 END) AS rtt_count,
            MIN(CASE WHEN s.ok=1 THEN s.rtt_ms END) AS min_rtt,
            MAX(CASE WHEN s.ok=1 THEN s.rtt_ms END) AS max_rtt
       FROM samples s
       JOIN devices d ON d.id = s.device_id
       LEFT JOIN groups g ON g.id = d.group_id
      WHERE s.ts BETWEEN ? AND ? ${clause}
      GROUP BY s.device_id`
  );
  for (const [edgeFrom, edgeTo] of edges) sampleStmt.all(edgeFrom, edgeTo, ...params).forEach(merge);

  // روزهای کاملی که در daily_stats رکورد ندارند (مثلاً دادهٔ نمایشی اولیه یا
  // دوره‌ای که موتور خاموش بوده) از نمونهٔ خام خوانده می‌شوند تا گزارش سوراخ نشود.
  if (fullWindow) {
    const placeholders = fullWindow.days.map(() => '?').join(',');
    db.prepare(
      `SELECT s.device_id AS id, COUNT(*) AS checks,
              SUM(CASE WHEN s.ok=0 THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN s.ok=1 THEN s.rtt_ms END) AS rtt_sum,
              SUM(CASE WHEN s.ok=1 THEN 1 ELSE 0 END) AS rtt_count,
              MIN(CASE WHEN s.ok=1 THEN s.rtt_ms END) AS min_rtt,
              MAX(CASE WHEN s.ok=1 THEN s.rtt_ms END) AS max_rtt
         FROM samples s
         JOIN devices d ON d.id = s.device_id
         LEFT JOIN groups g ON g.id = d.group_id
        WHERE s.ts >= ? AND s.ts < ?
          AND date(s.ts/1000,'unixepoch',?) IN (${placeholders}) ${clause}
        GROUP BY s.device_id`
    )
      .all(fullWindow.from, fullWindow.to, tzModifier(offset), ...fullWindow.days, ...params)
      .forEach(merge);
  }

  return out;
}

/**
 * روزهای کامل بازه که در daily_stats رکورد ندارند.
 * @returns {{from:number,to:number,days:string[]}|null}
 */
function missingFullDays(fullStart, fullEnd, hasFullDays, offsetMin) {
  if (!hasFullDays || fullStart >= fullEnd) return null;
  const present = new Set(
    db
      .prepare('SELECT DISTINCT day FROM daily_stats WHERE day >= ? AND day < ?')
      .all(dayLabel(fullStart, offsetMin), dayLabel(fullEnd, offsetMin))
      .map((r) => r.day)
  );
  const days = [];
  for (let t = fullStart; t < fullEnd; t += DAY_MS) {
    const label = dayLabel(t, offsetMin);
    if (!present.has(label)) days.push(label);
  }
  return days.length ? { from: fullStart, to: fullEnd, days } : null;
}

export function dailySeries({ from, to, clause = '', params = [], offsetMin = 0 }) {
  if (!(to > from)) return [];
  const offset = Number(offsetMin) || 0;
  const todayStart = dayStart(Math.min(to, Date.now()), offset);
  const out = [];

  const pastTo = Math.min(to, todayStart - 1);
  if (pastTo >= from) {
    const rows = db
      .prepare(
        `SELECT ds.day AS day,
                SUM(ds.checks) AS checks,
                SUM(ds.checks - ds.failed) AS okCount,
                SUM(CASE WHEN ds.avg_rtt IS NULL THEN 0 ELSE ds.avg_rtt * (ds.checks - ds.failed) END) AS rttSum,
                SUM(CASE WHEN ds.avg_rtt IS NULL THEN 0 ELSE ds.checks - ds.failed END) AS rttCount
         FROM daily_stats ds
         JOIN devices d ON d.id = ds.device_id
         LEFT JOIN groups g ON g.id = d.group_id
         WHERE ds.day >= ? AND ds.day <= ? ${clause}
         GROUP BY ds.day ORDER BY ds.day`
      )
      .all(dayLabel(from, offset), dayLabel(pastTo, offset), ...params);
    for (const r of rows) out.push(point(r));

    // روزهای جامانده در daily_stats از نمونهٔ خام خوانده می‌شوند (نمودار نباید
    // سوراخ شود؛ مثلاً وقتی دادهٔ نمایشی هنوز تجمیع نشده است).
    const labels = [];
    for (let t = dayStart(from, offset); t <= pastTo; t += DAY_MS) labels.push(dayLabel(t, offset));
    const present = new Set(rows.map((r) => r.day));
    const missing = labels.filter((l) => !present.has(l));
    if (missing.length) {
      const fallback = db
        .prepare(
          `SELECT date(s.ts/1000,'unixepoch',?) AS day,
                  COUNT(*) AS checks,
                  SUM(COALESCE(s.ok,0)) AS okCount,
                  SUM(CASE WHEN s.ok=1 THEN s.rtt_ms END) AS rttSum,
                  SUM(CASE WHEN s.ok=1 THEN 1 ELSE 0 END) AS rttCount
             FROM samples s
             JOIN devices d ON d.id = s.device_id
             LEFT JOIN groups g ON g.id = d.group_id
            WHERE s.ts >= ? AND s.ts <= ?
              AND date(s.ts/1000,'unixepoch',?) IN (${missing.map(() => '?').join(',')}) ${clause}
            GROUP BY day ORDER BY day`
        )
        .all(tzModifier(offset), from, pastTo, tzModifier(offset), ...missing, ...params);
      for (const r of fallback) out.push(point(r));
      out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    }
  }

  const liveFrom = Math.max(from, todayStart);
  if (to >= liveFrom) {
    const rows = db
      .prepare(
        `SELECT date(s.ts/1000,'unixepoch',?) AS day,
                COUNT(*) AS checks,
                SUM(COALESCE(s.ok,0)) AS okCount,
                SUM(CASE WHEN s.ok=1 THEN s.rtt_ms END) AS rttSum,
                SUM(CASE WHEN s.ok=1 THEN 1 ELSE 0 END) AS rttCount
         FROM samples s
         JOIN devices d ON d.id = s.device_id
         LEFT JOIN groups g ON g.id = d.group_id
         WHERE s.ts BETWEEN ? AND ? ${clause}
         GROUP BY day ORDER BY day`
      )
      .all(tzModifier(offset), liveFrom, to, ...params);
    for (const r of rows) out.push(point(r));
  }

  return out;
}
