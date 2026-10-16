/**
 * NetWatch — API گزارش‌گیری و تحلیل
 */
import express from 'express';
import { db, getSettings } from '../db.js';
import { dailySeries, tzModifier } from '../daily.js';
import { buildWorkbook, workbookToBuffer } from '../impexp.js';

const router = express.Router();

const RANGE_MS = {
  '24h': 24 * 3600 * 1000,
  '7d': 7 * 86400000,
  '30d': 30 * 86400000,
  '90d': 90 * 86400000,
};

export function resolveRange(q = {}) {
  const s = getSettings();
  const now = Date.now();
  let to = q.to ? Number(q.to) : now;
  let from;
  if (q.from) from = Number(q.from);
  else from = to - (RANGE_MS[q.range] || RANGE_MS['7d']);
  if (!Number.isFinite(from)) from = to - RANGE_MS['7d'];
  if (!Number.isFinite(to)) to = now;
  if (from > to) [from, to] = [to, from];
  const offsetMin = Number(s.timezone_offset_minutes) || 0;
  return { from, to, offsetMin, mod: tzModifier(offsetMin) };
}

function filters(q) {
  const where = [];
  const params = [];
  if (q.group) {
    where.push('(d.group_id = ? OR g.name = ?)');
    params.push(Number(q.group) || -1, String(q.group));
  }
  if (q.tag) {
    where.push('EXISTS (SELECT 1 FROM device_tags dt JOIN tags t ON t.id=dt.tag_id WHERE dt.device_id=d.id AND (t.id=? OR t.name=?))');
    params.push(Number(q.tag) || -1, String(q.tag));
  }
  if (q.ids) {
    const ids = String(q.ids).split(',').map(Number).filter(Boolean);
    if (ids.length) {
      where.push(`d.id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
  }
  if (q.device) {
    where.push('d.id = ?');
    params.push(Number(q.device));
  }
  return { clause: where.length ? ` AND ${where.join(' AND ')}` : '', params };
}

router.get('/summary', (req, res) => {
  const { from, to, offsetMin, mod } = resolveRange(req.query);
  const f = filters(req.query);

  const rows = db
    .prepare(
      `SELECT d.id, d.name, d.ip, d.device_type AS deviceType, d.status, d.priority,
              g.name AS groupName, g.color AS groupColor, d.location,
              COUNT(s.id) AS checks, SUM(COALESCE(s.ok,0)) AS okCount,
              MIN(CASE WHEN s.ok=1 THEN s.rtt_ms END) AS minRtt,
              MAX(CASE WHEN s.ok=1 THEN s.rtt_ms END) AS maxRtt,
              AVG(CASE WHEN s.ok=1 THEN s.rtt_ms END) AS avgRtt,
              AVG(CASE WHEN s.ok=1 THEN 0 ELSE 100 END) AS loss,
              (SELECT COUNT(*) FROM outages o WHERE o.device_id = d.id AND o.started_at BETWEEN ? AND ?) AS outages,
              (SELECT COALESCE(SUM(COALESCE(o.duration_sec, (? - o.started_at)/1000)),0) FROM outages o WHERE o.device_id = d.id AND o.started_at BETWEEN ? AND ?) AS downtimeSec,
              (SELECT COALESCE(AVG(o.duration_sec),0) FROM outages o WHERE o.device_id = d.id AND o.ended_at IS NOT NULL AND o.started_at BETWEEN ? AND ?) AS mttrSec,
              (SELECT COUNT(*) FROM alerts a WHERE a.device_id = d.id AND a.created_at BETWEEN ? AND ?) AS alerts
       FROM devices d
       LEFT JOIN groups g ON g.id = d.group_id
       LEFT JOIN samples s ON s.device_id = d.id AND s.ts BETWEEN ? AND ?
       WHERE 1=1 ${f.clause}
       GROUP BY d.id ORDER BY d.name`
    )
    .all(from, to, to, from, to, from, to, from, to, from, to, ...f.params);

  const items = rows.map((r) => {
    const availability = r.checks ? (r.okCount / r.checks) * 100 : null;
    const downtime = Math.round(r.downtimeSec || 0);
    const windowSec = Math.max(1, Math.round((to - from) / 1000));
    const mtbf = r.outages > 0 ? Math.round((windowSec - downtime) / r.outages) : null;
    return {
      id: r.id,
      name: r.name,
      ip: r.ip,
      deviceType: r.deviceType,
      status: r.status,
      priority: r.priority,
      groupName: r.groupName,
      groupColor: r.groupColor,
      location: r.location,
      checks: r.checks,
      okCount: r.okCount || 0,
      failed: r.checks - (r.okCount || 0),
      availability: availability == null ? null : Math.round(availability * 100) / 100,
      minRtt: r.minRtt == null ? null : Math.round(r.minRtt * 100) / 100,
      maxRtt: r.maxRtt == null ? null : Math.round(r.maxRtt * 100) / 100,
      avgRtt: r.avgRtt == null ? null : Math.round(r.avgRtt * 100) / 100,
      lossPct: r.loss == null ? null : Math.round(r.loss * 100) / 100,
      outages: r.outages,
      downtimeSec: downtime,
      mttrSec: Math.round(r.mttrSec || 0),
      mtbfSec: mtbf,
      alerts: r.alerts,
    };
  });

  // سری روزانه: روزهای کامل از جدول تجمیعی و فقط روز جاری از نمونه‌های خام.
  // این کار گزارش‌های چندده روزه را از اسکن میلیون‌ها ردیف نمونه رها می‌کند و
  // بازه‌هایی را که نمونهٔ خام‌شان هرس شده (ولی جمع روزانه‌شان مانده) هم پوشش می‌دهد.
  const days = dailySeries({ from, to, clause: f.clause, params: f.params, offsetMin });

  const dailyOutages = db
    .prepare(
      `SELECT date(o.started_at/1000,'unixepoch',?) AS day, COUNT(*) AS count,
              COALESCE(SUM(COALESCE(o.duration_sec,0)),0) AS downtimeSec
       FROM outages o JOIN devices d ON d.id = o.device_id
       LEFT JOIN groups g ON g.id = d.group_id
       WHERE o.started_at BETWEEN ? AND ? ${f.clause}
       GROUP BY day ORDER BY day`
    )
    .all(mod, from, to, ...f.params)
    .map((r) => ({ day: r.day, count: r.count, downtimeSec: Math.round(r.downtimeSec) }));

  const causes = db
    .prepare(
      `SELECT o.cause AS label, COUNT(*) AS count, COALESCE(SUM(COALESCE(o.duration_sec,0)),0) AS downtimeSec
       FROM outages o JOIN devices d ON d.id = o.device_id
       LEFT JOIN groups g ON g.id = d.group_id
       WHERE o.started_at BETWEEN ? AND ? ${f.clause}
       GROUP BY o.cause ORDER BY count DESC`
    )
    .all(from, to, ...f.params)
    .map((r) => ({ ...r, downtimeSec: Math.round(r.downtimeSec) }));

  const actions = db
    .prepare(
      `SELECT m.action AS label, COUNT(*) AS count, COALESCE(SUM(m.cost),0) AS cost
       FROM maintenance_records m JOIN devices d ON d.id = m.device_id
       LEFT JOIN groups g ON g.id = d.group_id
       WHERE m.started_at BETWEEN ? AND ? ${f.clause}
       GROUP BY m.action ORDER BY count DESC`
    )
    .all(from, to, ...f.params);

  const totals = items.reduce(
    (acc, r) => ({
      devices: acc.devices + 1,
      checks: acc.checks + r.checks,
      failed: acc.failed + r.failed,
      outages: acc.outages + r.outages,
      downtimeSec: acc.downtimeSec + r.downtimeSec,
      alerts: acc.alerts + r.alerts,
      rttSum: acc.rttSum + (r.avgRtt || 0),
      rttCount: acc.rttCount + (r.avgRtt == null ? 0 : 1),
      maxRtt: Math.max(acc.maxRtt, r.maxRtt || 0),
    }),
    { devices: 0, checks: 0, failed: 0, outages: 0, downtimeSec: 0, alerts: 0, rttSum: 0, rttCount: 0, maxRtt: 0 }
  );

  res.json({
    range: { from, to, days: Math.max(1, Math.round((to - from) / 86400000)) },
    totals: {
      ...totals,
      availability: totals.checks ? Math.round(((totals.checks - totals.failed) / totals.checks) * 10000) / 100 : null,
      avgRtt: totals.rttCount ? Math.round((totals.rttSum / totals.rttCount) * 100) / 100 : null,
      mttrSec: items.filter((i) => i.mttrSec).length
        ? Math.round(items.reduce((a, b) => a + b.mttrSec, 0) / items.filter((i) => i.mttrSec).length)
        : 0,
    },
    items,
    days,
    dailyOutages,
    causes,
    actions,
  });
});

router.get('/export', (req, res) => {
  const format = String(req.query.format || 'csv').toLowerCase() === 'xlsx' ? 'xlsx' : 'csv';
  const { from, to } = resolveRange(req.query);
  const f = filters(req.query);
  const rows = db
    .prepare(
      `SELECT d.name, d.ip, d.device_type, g.name AS grp, d.location,
              COUNT(s.id) AS checks, SUM(COALESCE(s.ok,0)) AS okCount,
              AVG(CASE WHEN s.ok=1 THEN s.rtt_ms END) AS avgRtt,
              MAX(CASE WHEN s.ok=1 THEN s.rtt_ms END) AS maxRtt,
              AVG(CASE WHEN s.ok=1 THEN 0 ELSE 100 END) AS loss,
              (SELECT COUNT(*) FROM outages o WHERE o.device_id=d.id AND o.started_at BETWEEN ? AND ?) AS outages,
              (SELECT COALESCE(SUM(COALESCE(o.duration_sec,0)),0) FROM outages o WHERE o.device_id=d.id AND o.started_at BETWEEN ? AND ?) AS downtime
       FROM devices d LEFT JOIN groups g ON g.id=d.group_id
       LEFT JOIN samples s ON s.device_id=d.id AND s.ts BETWEEN ? AND ?
       WHERE 1=1 ${f.clause} GROUP BY d.id ORDER BY d.name`
    )
    .all(from, to, from, to, from, to, ...f.params)
    .map((r) => ({
      'نام تجهیز': r.name,
      'آدرس IP': r.ip,
      'نوع': r.device_type,
      'گروه': r.grp || '',
      'موقعیت': r.location || '',
      'تعداد بررسی': r.checks,
      'بررسی موفق': r.okCount || 0,
      'بررسی ناموفق': r.checks - (r.okCount || 0),
      'دسترس‌پذیری (٪)': r.checks ? Math.round(((r.okCount || 0) / r.checks) * 10000) / 100 : '',
      'میانگین تأخیر (ms)': r.avgRtt == null ? '' : Math.round(r.avgRtt * 100) / 100,
      'بیشترین تأخیر (ms)': r.maxRtt == null ? '' : Math.round(r.maxRtt * 100) / 100,
      'افت بسته (٪)': r.loss == null ? '' : Math.round(r.loss * 100) / 100,
      'تعداد قطعی': r.outages,
      'مدت قطعی (ثانیه)': Math.round(r.downtime || 0),
    }));
  const headers = Object.keys(rows[0] || { 'نام تجهیز': '' }).map((k) => [k, k]);
  const wb = buildWorkbook(rows, headers);
  const buf = workbookToBuffer(wb, format);
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="netwatch-report-${stamp}.${format}"`);
  res.send(buf);
});

export default router;
