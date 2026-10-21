/**
 * NetWatch — API گزارش‌گیری و تحلیل
 */
import express from 'express';
import { db, getSettings } from '../db.js';
import { dailySeries, deviceTotals, tzModifier } from '../daily.js';
import { mttrReport } from '../mttr.js';
import { parseDateInput, jalaliLabelFromMs } from '../jalali.js';
import { runJob } from '../jobs.js';
import { requirePermission } from '../permissions.js';

const router = express.Router();

router.use(requirePermission('reports:read'));

/**
 * کش کوتاه گزارش خلاصه (۸ ثانیه).
 *
 * گزارش خلاصه برای بازه‌های بلند چند پرس‌وجوی سنگین روی samples/daily_stats
 * اجرا می‌کند و SQLite تک‌رشته‌ای است؛ چند اپراتور که هم‌زمان صفحهٔ گزارش را
 * باز کنند، همان اسکن را چند بار تکرار می‌کردند. کلید شامل همهٔ پارامترهای مؤثر
 * است و برای دادهٔ تازه حداکثر ۸ ثانیه تأخیر دارد. `?nocache=1` کش را دور می‌زند.
 */
const SUMMARY_TTL_MS = 8000;
const summaryCache = new Map();

function cacheKey(query) {
  const keys = Object.keys(query)
    .filter((k) => k !== 'nocache')
    .sort();
  return keys.map((k) => `${k}=${String(query[k])}`).join('&');
}

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
    where.push(
      `(d.group_id = ? OR g.name = ? OR EXISTS (
         SELECT 1 FROM device_group_members m JOIN groups mg ON mg.id = m.group_id
         WHERE m.device_id = d.id AND (mg.id = ? OR mg.name = ?)))`
    );
    params.push(Number(q.group) || -1, String(q.group), Number(q.group) || -1, String(q.group));
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
  const key = cacheKey(req.query);
  const bypass = String(req.query.nocache || '') === '1';
  if (!bypass) {
    const hit = summaryCache.get(key);
    if (hit && Date.now() - hit.at < SUMMARY_TTL_MS) {
      return res.setHeader('X-Cache', 'hit').json(hit.body);
    }
  }
  const { from, to, offsetMin, mod } = resolveRange(req.query);
  const f = filters(req.query);

  // شاخص‌های نمونه‌محور (تعداد بررسی، تأخیر، افت) از مسیر تجمیعی می‌آید:
  // روزهای کامل از daily_stats و فقط لبه‌های ناقص/روز جاری از samples.
  // بدون این کار، گزارش ۹۰ روزه روی میلیون‌ها ردیف نمونه اسکن می‌کرد.
  const aggByDevice = deviceTotals({ from, to, clause: f.clause, params: f.params, offsetMin });

  // به‌جای چهار زیرپرس‌وجوی همبسته برای هر تجهیز، قطعی‌ها و هشدارهای بازه
  // یک‌بار تجمیع و سپس JOIN می‌شوند. با ۱۰۰۰ تجهیز این تفاوت از O(devices ×
  // rows) به O(rows) کاهش می‌یابد.
  const rows = db
    .prepare(
      `SELECT d.id, d.name, d.ip, d.device_type AS deviceType, d.status, d.priority,
              g.name AS groupName, g.color AS groupColor, d.location,
              COALESCE(o.outages, 0) AS outages,
              COALESCE(o.downtimeSec, 0) AS downtimeSec,
              COALESCE(o.mttrSec, 0) AS mttrSec,
              COALESCE(o.mttrEvents, 0) AS mttrEvents,
              COALESCE(al.alerts, 0) AS alerts
       FROM devices d
       LEFT JOIN groups g ON g.id = d.group_id
       LEFT JOIN (
         SELECT device_id,
                COUNT(*) AS outages,
                COALESCE(SUM(COALESCE(duration_sec, (? - started_at) / 1000)), 0) AS downtimeSec,
                COALESCE(AVG(CASE WHEN ended_at IS NOT NULL AND EXISTS (
                  SELECT 1 FROM maintenance_records m WHERE m.outage_id = outages.id
                ) THEN CAST(MAX(ended_at - started_at, 0) AS REAL) / 1000.0 END), 0) AS mttrSec,
                SUM(CASE WHEN ended_at IS NOT NULL AND EXISTS (
                  SELECT 1 FROM maintenance_records m WHERE m.outage_id = outages.id
                ) THEN 1 ELSE 0 END) AS mttrEvents
         FROM outages WHERE started_at BETWEEN ? AND ? GROUP BY device_id
       ) o ON o.device_id = d.id
       LEFT JOIN (
         SELECT device_id, COUNT(*) AS alerts
         FROM alerts WHERE created_at BETWEEN ? AND ? GROUP BY device_id
       ) al ON al.device_id = d.id
       WHERE 1=1 ${f.clause}
       ORDER BY d.name`
    )
    .all(to, from, to, from, to, ...f.params);

  const items = rows.map((r) => {
    const t = aggByDevice.get(r.id) || { checks: 0, failed: 0, rttSum: 0, rttCount: 0, minRtt: null, maxRtt: null };
    const checks = t.checks;
    const okCount = checks - t.failed;
    const avgRtt = t.rttCount ? t.rttSum / t.rttCount : null;
    const availability = checks ? (okCount / checks) * 100 : null;
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
      checks,
      okCount,
      failed: t.failed,
      availability: availability == null ? null : Math.round(availability * 100) / 100,
      minRtt: t.minRtt == null ? null : Math.round(t.minRtt * 100) / 100,
      maxRtt: t.maxRtt == null ? null : Math.round(t.maxRtt * 100) / 100,
      avgRtt: avgRtt == null ? null : Math.round(avgRtt * 100) / 100,
      lossPct: checks ? Math.round((t.failed / checks) * 10000) / 100 : null,
      outages: r.outages,
      downtimeSec: downtime,
      mttrSec: r.mttrEvents ? Math.round(r.mttrSec || 0) : null,
      mttrEvents: r.mttrEvents || 0,
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

  // MTTR شفاف: فقط قطعی‌های دارای تعمیر ثبت‌شده؛ تعداد مبنا و موارد حذف‌شده
  // جداگانه برگردانده می‌شوند تا مدیر بتواند کیفیت شاخص را بسنجد.
  const mttr = mttrReport({ from, to, clause: f.clause, params: f.params, limit: 100 });

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

  const body = {
    range: { from, to, days: Math.max(1, Math.round((to - from) / 86400000)) },
    totals: {
      ...totals,
      availability: totals.checks ? Math.round(((totals.checks - totals.failed) / totals.checks) * 10000) / 100 : null,
      avgRtt: totals.rttCount ? Math.round((totals.rttSum / totals.rttCount) * 100) / 100 : null,
      // میانگین وزنی رویدادها (نه میانگین میانگین‌ها) — فقط مبنای تعمیرشده
      mttrSec: mttr.avgSec ?? 0,
      mttrEvents: mttr.count,
      mttrExcluded: mttr.excluded,
    },
    mttr,
    items,
    days,
    dailyOutages,
    causes,
    actions,
  };
  if (!bypass) {
    summaryCache.set(key, { at: Date.now(), body });
    if (summaryCache.size > 8) summaryCache.delete(summaryCache.keys().next().value);
  }
  return res.setHeader('X-Cache', 'miss').json(body);
});

/**
 * گزارش تاریخ نصب: بازهٔ پیش‌فرض «سه ماه اخیر» است و بازهٔ دلخواه هم پذیرفته
 * می‌شود. ورودی تاریخ می‌تواند epoch یا ISO میلادی باشد؛ نمایش شمسی در UI
 * انجام می‌شود و دادهٔ ذخیره‌شده همیشه استاندارد می‌ماند.
 */
export function installationReport(q = {}) {
  const settings = getSettings();
  const offsetMin = Number(settings.timezone_offset_minutes) || 0;
  const now = Date.now();
  let to = parseDateInput(q.to, offsetMin) ?? now;
  let from = parseDateInput(q.from, offsetMin);
  const months = Math.min(60, Math.max(1, Number(q.months) || 3));
  if (from === null) from = to - months * 30 * 86400000;
  if (from > to) [from, to] = [to, from];
  const f = filters(q);
  const rows = db
    .prepare(
      `SELECT d.id, d.name, d.ip, d.device_type, d.status, d.installed_at, d.vendor, d.model,
              d.location, g.name AS groupName, g.color AS groupColor
       FROM devices d LEFT JOIN groups g ON g.id = d.group_id
       WHERE d.installed_at IS NOT NULL AND d.installed_at BETWEEN ? AND ? ${f.clause}
       ORDER BY d.installed_at DESC LIMIT 5000`
    )
    .all(from, to, ...f.params);
  const items = rows.map((r) => ({
    id: r.id,
    name: r.name,
    ip: r.ip,
    deviceType: r.device_type,
    status: r.status,
    installedAt: r.installed_at,
    installedAtLabel: jalaliLabelFromMs(r.installed_at, offsetMin),
    vendor: r.vendor || '',
    model: r.model || '',
    location: r.location || '',
    groupName: r.groupName || null,
    groupColor: r.groupColor || null,
  }));
  const byType = new Map();
  const byMonth = new Map();
  for (const it of items) {
    byType.set(it.deviceType, (byType.get(it.deviceType) || 0) + 1);
    const label = it.installedAtLabel.slice(0, 7);
    byMonth.set(label, (byMonth.get(label) || 0) + 1);
  }
  return {
    range: { from, to, months, label: `${months} ماه` },
    total: items.length,
    items,
    byType: [...byType.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
    byMonth: [...byMonth.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => a.label.localeCompare(b.label)),
  };
}

router.get('/mttr', (req, res) => {
  const { from, to } = resolveRange(req.query);
  const f = filters(req.query);
  const report = mttrReport({ from, to, clause: f.clause, params: f.params, limit: Number(req.query.limit) || 200 });
  res.json({ range: { from, to }, ...report });
});

router.get('/installations', (req, res) => {
  res.json(installationReport(req.query));
});

router.get('/installations/export', async (req, res) => {
  const format = String(req.query.format || 'csv').toLowerCase() === 'xlsx' ? 'xlsx' : 'csv';
  const report = installationReport(req.query);
  const rows = report.items.map((r) => ({
    'نام تجهیز': r.name,
    'آدرس IP': r.ip,
    'نوع': r.deviceType,
    'گروه': r.groupName || '',
    'موقعیت': r.location || '',
    'سازنده': r.vendor,
    'مدل': r.model,
    'تاریخ نصب (شمسی)': r.installedAtLabel,
    'وضعیت': r.status,
  }));
  const headers = Object.keys(rows[0] || { 'نام تجهیز': '' }).map((k) => [k, k]);
  const result = await runJob('export', { rows, headers, format }, { timeoutMs: 120000 });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="netwatch-installations-${stamp}.${format}"`);
  res.send(Buffer.from(result.buffer));
});

router.get('/export', async (req, res) => {
  const format = String(req.query.format || 'csv').toLowerCase() === 'xlsx' ? 'xlsx' : 'csv';
  const { from, to } = resolveRange(req.query);
  const f = filters(req.query);
  const totals = deviceTotals({ from, to, clause: f.clause, params: f.params, offsetMin: resolveRange(req.query).offsetMin });
  const rows = db
    .prepare(
      `SELECT d.id, d.name, d.ip, d.device_type, g.name AS grp, d.location,
              COALESCE(o.outages, 0) AS outages, COALESCE(o.downtime, 0) AS downtime
       FROM devices d LEFT JOIN groups g ON g.id=d.group_id
       LEFT JOIN (
         SELECT device_id, COUNT(*) AS outages,
                COALESCE(SUM(COALESCE(duration_sec, 0)), 0) AS downtime
         FROM outages WHERE started_at BETWEEN ? AND ? GROUP BY device_id
       ) o ON o.device_id = d.id
       WHERE 1=1 ${f.clause} ORDER BY d.name`
    )
    .all(from, to, ...f.params)
    .map((r) => {
      const t = totals.get(r.id) || { checks: 0, failed: 0, rttSum: 0, rttCount: 0, minRtt: null, maxRtt: null };
      const okCount = t.checks - t.failed;
      const avgRtt = t.rttCount ? t.rttSum / t.rttCount : null;
      return {
        'نام تجهیز': r.name,
        'آدرس IP': r.ip,
        'نوع': r.device_type,
        'گروه': r.grp || '',
        'موقعیت': r.location || '',
        'تعداد بررسی': t.checks,
        'بررسی موفق': okCount,
        'بررسی ناموفق': t.failed,
        'دسترس‌پذیری (٪)': t.checks ? Math.round((okCount / t.checks) * 10000) / 100 : '',
        'میانگین تأخیر (ms)': avgRtt == null ? '' : Math.round(avgRtt * 100) / 100,
        'بیشترین تأخیر (ms)': t.maxRtt == null ? '' : Math.round(t.maxRtt * 100) / 100,
        'افت بسته (٪)': t.checks ? Math.round((t.failed / t.checks) * 10000) / 100 : '',
        'تعداد قطعی': r.outages,
        'مدت قطعی (ثانیه)': Math.round(r.downtime || 0),
      };
    });
  const headers = Object.keys(rows[0] || { 'نام تجهیز': '' }).map((k) => [k, k]);
  const result = await runJob('export', { rows, headers, format }, { timeoutMs: 120000 });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="netwatch-report-${stamp}.${format}"`);
  res.send(Buffer.from(result.buffer));
});

export default router;
