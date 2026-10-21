/**
 * NetWatch — محاسبهٔ MTTR
 * ----------------------------------------------------------------
 * معیار: فاصلهٔ زمانی «شروع قطعی» تا «وصل مجدد» (ended_at) برای قطعی‌هایی که
 * برای آن‌ها عملیات تعمیر ثبت شده است (maintenance_records.outage_id).
 *
 * چرا این تفکیک لازم است؟ پیش‌تر میانگین همهٔ قطعی‌ها به‌عنوان MTTR گزارش
 * می‌شد؛ قطعی‌ای که هنوز بررسی/تعمیر نشده یا بدون سند تعمیر بسته شده، MTTR
 * را مصنوعی پایین می‌آورد. رخدادهای بدون تعمیر از محاسبه حذف و تعدادشان
 * جداگانه گزارش می‌شود تا شفاف باشد.
 */
import { db } from './db.js';

const ROUND = (v) => (v == null ? null : Math.round(v * 100) / 100);

/**
 * @param {{from:number,to:number,clause?:string,params?:any[],limit?:number}} options
 *        `clause` همان فیلتر گزارش‌هاست (با AND شروع می‌شود) و روی devices/groups.
 */
export function mttrReport({ from, to, clause = '', params = [], limit = 200 } = {}) {
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 200));
  const join = 'FROM outages o JOIN devices d ON d.id = o.device_id LEFT JOIN groups g ON g.id = d.group_id';

  const totalOutages = db
    .prepare(`SELECT COUNT(*) AS c ${join} WHERE o.ended_at IS NOT NULL AND o.started_at BETWEEN ? AND ? ${clause}`)
    .get(from, to, ...params).c;

  const agg = db
    .prepare(
      `SELECT COUNT(*) AS count,
              AVG(CAST(MAX(o.ended_at - o.started_at, 0) AS REAL) / 1000.0) AS avg_sec,
              MIN(CAST(MAX(o.ended_at - o.started_at, 0) AS REAL) / 1000.0) AS min_sec,
              MAX(CAST(MAX(o.ended_at - o.started_at, 0) AS REAL) / 1000.0) AS max_sec
       ${join}
       WHERE o.ended_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM maintenance_records m WHERE m.outage_id = o.id)
         AND o.started_at BETWEEN ? AND ? ${clause}`
    )
    .get(from, to, ...params);

  const events = db
    .prepare(
      `SELECT o.id, o.device_id, d.name AS device_name, d.ip, o.started_at, o.ended_at,
              CAST(MAX(o.ended_at - o.started_at, 0) AS INTEGER) / 1000 AS duration_sec,
              m.id AS maintenance_id, m.action, m.technician, m.cause
       ${join}
       JOIN maintenance_records m ON m.id = (
         SELECT m2.id FROM maintenance_records m2 WHERE m2.outage_id = o.id ORDER BY m2.id ASC LIMIT 1
       )
       WHERE o.ended_at IS NOT NULL AND EXISTS (
         SELECT 1 FROM maintenance_records mx WHERE mx.outage_id = o.id
       ) AND o.started_at BETWEEN ? AND ? ${clause}
       ORDER BY o.started_at DESC
       LIMIT ?`
    )
    .all(from, to, ...params, safeLimit)
    .map((r) => ({
      outageId: r.id,
      deviceId: r.device_id,
      deviceName: r.device_name,
      ip: r.ip,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      durationSec: Math.max(0, Math.round(r.duration_sec)),
      maintenanceId: r.maintenance_id,
      action: r.action || '',
      technician: r.technician || '',
      cause: r.cause || '',
    }));

  const byDevice = db
    .prepare(
      `SELECT d.id, d.name, d.ip, COUNT(*) AS events,
              AVG(CAST(MAX(o.ended_at - o.started_at, 0) AS REAL) / 1000.0) AS avg_sec
       ${join}
       WHERE o.ended_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM maintenance_records m WHERE m.outage_id = o.id)
         AND o.started_at BETWEEN ? AND ? ${clause}
       GROUP BY d.id ORDER BY avg_sec DESC`
    )
    .all(from, to, ...params)
    .map((r) => ({ id: r.id, name: r.name, ip: r.ip, events: r.events, avgSec: ROUND(r.avg_sec) }));

  const count = Number(agg?.count) || 0;
  return {
    avgSec: count ? Math.round(agg.avg_sec) : null,
    minSec: count ? Math.round(agg.min_sec) : null,
    maxSec: count ? Math.round(agg.max_sec) : null,
    count,
    excluded: Math.max(0, Number(totalOutages) - count),
    totalOutages: Number(totalOutages),
    events,
    eventsTruncated: count > events.length,
    byDevice,
    criteria: 'فاصلهٔ شروع قطعی تا وصل مجدد، فقط برای قطعی‌هایی که رکورد تعمیر متصل دارند.',
  };
}

export default { mttrReport };
