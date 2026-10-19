/**
 * NetWatch — تجمیع روزانهٔ مشترک
 * ----------------------------------------------------------------
 * این ماژول میان موتور پایش و Retention Engine مشترک است:
 *   • موتور روز جاری/گذشته را تازه‌سازی می‌کند.
 *   • Retention پیش از حذف نمونه‌های خام، مطمئن می‌شود هر روزی که نمونه دارد
 *     در `daily_stats` هم ثبت شده است؛ دادهٔ تاریخی هرگز با حذف نمونه‌ها از
 *     بین نمی‌رود.
 *
 * مرز روزها «روز تقویمی محلی» بر پایهٔ `timezone_offset_minutes` است — همان
 * مرزی که گزارش‌ها و موتور به کار می‌برند.
 */
import { db, transaction } from './db.js';
import { DAY_MS, dayLabel } from './daily.js';

const stmts = {
  daySamples: db.prepare(
    `SELECT device_id, COUNT(*) AS checks,
            SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS failed,
            AVG(CASE WHEN ok=1 THEN rtt_ms END) AS avg_rtt,
            MIN(CASE WHEN ok=1 THEN rtt_ms END) AS min_rtt,
            MAX(CASE WHEN ok=1 THEN rtt_ms END) AS max_rtt,
            AVG(CASE WHEN ok=0 THEN 100 ELSE 0 END) AS loss_pct
     FROM samples WHERE ts >= ? AND ts < ? GROUP BY device_id`
  ),
  dayOutages: db.prepare(
    `SELECT device_id, COUNT(*) AS outages, COALESCE(SUM(duration_sec),0) AS downtime_sec
     FROM outages WHERE started_at >= ? AND started_at < ? GROUP BY device_id`
  ),
  upsertDay: db.prepare(
    `INSERT INTO daily_stats(device_id, day, checks, failed, avg_rtt, min_rtt, max_rtt, loss_pct, outages, downtime_sec, uptime_pct)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(device_id, day) DO UPDATE SET checks=excluded.checks, failed=excluded.failed,
       avg_rtt=excluded.avg_rtt, min_rtt=excluded.min_rtt, max_rtt=excluded.max_rtt, loss_pct=excluded.loss_pct,
       outages=excluded.outages, downtime_sec=excluded.downtime_sec, uptime_pct=excluded.uptime_pct`
  ),
  dayExists: db.prepare('SELECT 1 AS ok FROM daily_stats WHERE day = ? LIMIT 1'),
  oldestSample: db.prepare('SELECT MIN(ts) AS ts FROM samples'),
  samplesInDay: db.prepare('SELECT COUNT(*) AS c FROM samples WHERE ts >= ? AND ts < ?'),
};

/** شروع روز تقویمی محلی که شامل `ts` است (همان تعریف engine/daily) */
export function localDayStart(ts, offsetMin = 0) {
  const off = (Number(offsetMin) || 0) * 60000;
  return Math.floor((ts + off) / DAY_MS) * DAY_MS - off;
}

/**
 * تجمیع آمار یک روز تقویمی محلی.
 * idempotent است: اجرای دوباره همان مقادیر را بازنویسی می‌کند.
 * @param {number} dayStartMs
 * @param {number} offsetMin
 * @returns {number} تعداد تجهیزهای تجمیع‌شده
 */
export function rollupDay(dayStartMs, offsetMin = 0) {
  const day = dayLabel(dayStartMs, offsetMin);
  const agg = stmts.daySamples.all(dayStartMs, dayStartMs + DAY_MS);
  if (!agg.length) return 0;
  const outages = new Map(stmts.dayOutages.all(dayStartMs, dayStartMs + DAY_MS).map((o) => [o.device_id, o]));
  transaction(
    () => {
      for (const a of agg) {
        const o = outages.get(a.device_id);
        const uptime = a.checks ? Number((((a.checks - a.failed) / a.checks) * 100).toFixed(2)) : null;
        stmts.upsertDay.run(
          a.device_id,
          day,
          a.checks,
          a.failed,
          a.avg_rtt == null ? null : Number(a.avg_rtt),
          a.min_rtt == null ? null : Number(a.min_rtt),
          a.max_rtt == null ? null : Number(a.max_rtt),
          a.loss_pct == null ? null : Number(Number(a.loss_pct).toFixed(2)),
          o ? o.outages : 0,
          o ? o.downtime_sec : 0,
          uptime
        );
      }
    },
    { label: 'rollup.day' }
  );
  return agg.length;
}

/**
 * پیش از حذف نمونه‌های قدیمی، روزهای دارای نمونه را بررسی می‌کند و روزهای
 * فاقد ردیف تجمیعی را (تا سقف `limit`) می‌سازد.
 *
 * @param {{cutoff:number, offsetMin?:number, limit?:number, dryRun?:boolean}} options
 * @returns {{days:number, missing:string[], rolledUp:number, remaining:number, oldest:number|null}}
 */
export function ensureDailyStatsBefore({ cutoff, offsetMin = 0, limit = 31, dryRun = false }) {
  const out = { days: 0, missing: [], rolledUp: 0, remaining: 0, oldest: null };
  const oldest = stmts.oldestSample.get()?.ts;
  if (oldest == null) return out;
  out.oldest = oldest;
  // فهرست روزهای دارای نمونه که هنوز تجمیع نشده‌اند، از قدیمی‌ترین تا مبدأ قطع.
  // برای هر روز فقط وجود یک ردیف daily_stats کافی است (تجمیع گروهی همهٔ تجهیزها
  // را پوشش می‌دهد)؛ علاوه بر آن روزهایی که هنوز هیچ تجمیعی ندارند بررسی می‌شوند.
  for (let start = localDayStart(oldest, offsetMin); start < cutoff; start += DAY_MS) {
    const startTs = start;
    const endTs = Math.min(start + DAY_MS, cutoff);
    if (!stmts.samplesInDay.get(startTs, endTs).c) continue;
    out.days += 1;
    if (stmts.dayExists.get(dayLabel(startTs, offsetMin))) continue;
    out.missing.push(dayLabel(startTs, offsetMin));
    if (dryRun) continue;
    if (out.rolledUp >= limit) continue;
    rollupDay(startTs, offsetMin);
    out.rolledUp += 1;
    // تجمیع ممکن است ردیفی نسازد (اگر همهٔ نمونه‌های روز حذف شده باشند)؛
    // در این حالت روز دیگر در فهرست missing نمی‌ماند چون نمونه‌ای ندارد.
  }
  out.remaining = Math.max(0, out.missing.length - out.rolledUp);
  return out;
}
