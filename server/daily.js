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
