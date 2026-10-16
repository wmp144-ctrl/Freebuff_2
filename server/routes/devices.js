/**
 * NetWatch — API تجهیزات
 */
import express from 'express';
import multer from 'multer';
import { db, getSettings, STATUS } from '../db.js';
import {
  listDevices,
  getDevice,
  createDevice,
  updateDevice,
  deleteDevices,
  parseListQuery,
  attachTags,
  buildDeviceWhere,
  serializeDevice,
  tagsFor,
  groupByName,
} from '../store.js';
import { engine } from '../engine.js';
import { parseBuffer, validateRows, buildWorkbook, workbookToBuffer, templateRows, EXPORT_HEADERS } from '../impexp.js';
import { isValidIp } from '../ping.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const RANGE_BUCKETS = {
  '15m': { ms: 60 * 1000, label: '۱ دقیقه' },
  '1h': { ms: 60 * 1000, label: '۱ دقیقه' },
  '6h': { ms: 5 * 60 * 1000, label: '۵ دقیقه' },
  '24h': { ms: 15 * 60 * 1000, label: '۱۵ دقیقه' },
  '7d': { ms: 60 * 60 * 1000, label: '۱ ساعت' },
  '30d': { ms: 6 * 60 * 60 * 1000, label: '۶ ساعت' },
  '90d': { ms: 24 * 60 * 60 * 1000, label: '۱ روز' },
};
const RANGE_MS = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

export function seriesFor(deviceId, range = '1h') {
  const bucket = RANGE_BUCKETS[range] || RANGE_BUCKETS['1h'];
  const from = Date.now() - (RANGE_MS[range] || RANGE_MS['1h']);
  const rows = db
    .prepare(
      `SELECT (ts / ?) * ? AS bucket,
              COUNT(*) AS samples,
              SUM(ok) AS ok_count,
              AVG(CASE WHEN ok = 1 THEN rtt_ms END) AS rtt,
              MIN(CASE WHEN ok = 1 THEN rtt_ms END) AS min_rtt,
              MAX(CASE WHEN ok = 1 THEN rtt_ms END) AS max_rtt,
              AVG(CASE WHEN ok = 1 THEN 0 ELSE 100 END) AS loss,
              AVG(ok) * 100 AS availability
       FROM samples WHERE device_id = ? AND ts >= ?
       GROUP BY bucket ORDER BY bucket ASC`
    )
    .all(bucket.ms, bucket.ms, Number(deviceId), from);
  return {
    range,
    bucketMs: bucket.ms,
    bucketLabel: bucket.label,
    from,
    to: Date.now(),
    points: rows.map((r) => ({
      t: r.bucket,
      rtt: r.rtt == null ? null : Math.round(r.rtt * 100) / 100,
      minRtt: r.min_rtt == null ? null : Math.round(r.min_rtt * 100) / 100,
      maxRtt: r.max_rtt == null ? null : Math.round(r.max_rtt * 100) / 100,
      loss: r.loss == null ? 0 : Math.round(r.loss * 10) / 10,
      availability: r.availability == null ? 0 : Math.round(r.availability * 10) / 10,
      samples: r.samples,
      ok: r.ok_count || 0,
      down: r.samples - (r.ok_count || 0),
      status: (r.ok_count || 0) === 0 ? 'offline' : (r.availability || 0) < 99 ? 'warning' : 'online',
    })),
  };
}

/* --------------------------- فهرست و جزئیات --------------------------- */

router.get('/', (req, res) => {
  const filters = parseListQuery(req.query);
  res.json(listDevices(filters));
});

router.get('/meta', (_req, res) => {
  res.json({
    groups: db.prepare('SELECT g.*, (SELECT COUNT(*) FROM devices d WHERE d.group_id = g.id) AS device_count FROM groups g ORDER BY g.name').all(),
    tags: db.prepare('SELECT t.*, (SELECT COUNT(*) FROM device_tags dt WHERE dt.tag_id = t.id) AS device_count FROM tags t ORDER BY t.name').all(),
    types: db.prepare('SELECT device_type AS value, COUNT(*) AS count FROM devices GROUP BY device_type ORDER BY count DESC').all(),
    locations: db.prepare("SELECT location AS value, COUNT(*) AS count FROM devices WHERE location != '' GROUP BY location ORDER BY count DESC").all(),
    vendors: db.prepare("SELECT vendor AS value, COUNT(*) AS count FROM devices WHERE vendor != '' GROUP BY vendor ORDER BY count DESC").all(),
    priorities: db.prepare('SELECT priority AS value, COUNT(*) AS count FROM devices GROUP BY priority').all(),
    layers: db.prepare('SELECT * FROM map_layers ORDER BY is_default DESC, name').all(),
    settings: getSettings(),
  });
});

router.get('/export', (req, res) => {
  const format = String(req.query.format || 'csv').toLowerCase() === 'xlsx' ? 'xlsx' : 'csv';
  const settings = getSettings();
  const filters = { ...parseListQuery({ ...req.query, page: '1', pageSize: '500' }) };
  let rows;
  if (req.query.ids) {
    const ids = String(req.query.ids).split(',').map((n) => Number(n)).filter(Boolean);
    rows = ids.map((id) => getDevice(id)).filter(Boolean);
  } else {
    filters.pageSize = 5000;
    rows = listDevices(filters).items;
  }
  const data = rows.map((d) => ({
    ...d,
    priority: d.priority,
    tags: (d.tags || []).map((t) => t.name).join(', '),
    enabled: d.enabled ? 1 : 0,
    monitoring_enabled: d.monitoringEnabled ? 1 : 0,
    location: d.location,
    group: d.groupName,
    device_type: d.deviceType,
    latitude: d.latitude,
    longitude: d.longitude,
    last_rtt_ms: d.lastRtt,
    uptime_pct: d.uptimePct,
    loss_pct: d.lossPct,
    status: d.status,
  }));
  const wb = buildWorkbook(data, EXPORT_HEADERS);
  const buf = workbookToBuffer(wb, format);
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="netwatch-devices-${stamp}.${format}"`);
  res.send(buf);
});

router.get('/template', (req, res) => {
  const format = String(req.query.format || 'xlsx').toLowerCase() === 'csv' ? 'csv' : 'xlsx';
  const wb = buildWorkbook(templateRows());
  const buf = workbookToBuffer(wb, format);
  res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="netwatch-devices-template.${format}"`);
  res.send(buf);
});

/** پیش‌نمایش ورود گروهی از فایل */
router.post('/import/preview', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایلی دریافت نشد' });
  try {
    const { rows, headers } = parseBuffer(req.file.buffer, req.file.originalname);
    const existing = db.prepare('SELECT id, name, ip FROM devices').all();
    const result = validateRows(rows, existing);
    res.json({
      fileName: req.file.originalname,
      headers,
      totalRows: rows.length,
      valid: result.valid,
      errors: result.errors,
      duplicates: result.duplicates,
      summary: {
        valid: result.valid.length,
        invalid: result.errors.length,
        duplicates: result.duplicates.length,
        newGroups: [...new Set(result.valid.map((r) => r.group).filter(Boolean))].filter(
          (g) => !db.prepare('SELECT 1 FROM groups WHERE name = ?').get(g)
        ),
        newTags: [...new Set(result.valid.flatMap((r) => r.tags))].filter((t) => !db.prepare('SELECT 1 FROM tags WHERE name = ?').get(t)),
      },
    });
  } catch (e) {
    res.status(400).json({ error: `خطا در خواندن فایل: ${e.message}` });
  }
});

/** ثبت نهایی ورود گروهی */
router.post('/import/commit', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایلی دریافت نشد' });
  const onlyValid = String(req.body?.onlyValid ?? '1') !== '0';
  let inserted = 0;
  const failed = [];
  try {
    const { rows } = parseBuffer(req.file.buffer, req.file.originalname);
    const existing = db.prepare('SELECT id, name, ip FROM devices').all();
    const { valid, errors } = validateRows(rows, existing);
    const list = onlyValid ? valid : [...valid, ...errors.filter((e) => e.ip && isValidIp(e.ip))];
    db.exec('BEGIN');
    for (const r of list) {
      try {
        createDevice(r, { source: 'import' });
        inserted++;
      } catch (e) {
        failed.push({ name: r.name, ip: r.ip, reason: e.message });
      }
    }
    db.exec('COMMIT');
    db.prepare('INSERT INTO engine_log(ts, level, message) VALUES (?,?,?)').run(
      Date.now(),
      'info',
      `ورود گروهی: ${inserted} تجهیز افزوده شد، ${failed.length} ناموفق.`
    );
    res.json({ inserted, failed, skipped: onlyValid ? errors.length : 0 });
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    res.status(400).json({ error: `خطا در ثبت داده‌ها: ${e.message}` });
  }
});

/** خروجی مختصات جغرافیایی */
router.get('/export/geo', (req, res) => {
  const format = String(req.query.format || 'csv').toLowerCase() === 'xlsx' ? 'xlsx' : 'csv';
  const rows = db
    .prepare("SELECT name, ip, device_type AS type, location, latitude, longitude, status FROM devices WHERE latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY name")
    .all()
    .map((r) => ({ 'نام تجهیز': r.name, 'آدرس IP': r.ip, 'نوع': r.type, 'موقعیت': r.location, 'عرض جغرافیایی': r.latitude, 'طول جغرافیایی': r.longitude, 'وضعیت': r.status }));
  const wb = buildWorkbook(rows, Object.keys(rows[0] || { 'نام تجهیز': '', 'آدرس IP': '', 'نوع': '', 'موقعیت': '', 'عرض جغرافیایی': '', 'طول جغرافیایی': '', 'وضعیت': '' }).map((k) => [k, k]));
  const buf = workbookToBuffer(wb, format);
  res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="netwatch-locations.${format}"`);
  res.send(buf);
});

/** ورود مختصات جغرافیایی */
router.post('/import/geo', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایلی دریافت نشد' });
  try {
    const { rows } = parseBuffer(req.file.buffer, req.file.originalname);
    let updated = 0;
    const errors = [];
    const upd = db.prepare('UPDATE devices SET latitude = ?, longitude = ?, updated_at = ? WHERE ip = ?');
    const byName = db.prepare('SELECT id FROM devices WHERE name = ?');
    for (const r of rows) {
      const lat = Number(r.latitude);
      const lng = Number(r.longitude);
      const ip = String(r.ip ?? '').trim();
      const name = String(r.name ?? '').trim();
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        errors.push({ row: r.__row, reason: 'مختصات نامعتبر' });
        continue;
      }
      if (ip) {
        const n = upd.run(lat, lng, Date.now(), ip).changes;
        if (n) {
          updated += n;
          continue;
        }
      }
      if (name) {
        const d = byName.get(name);
        if (d) {
          db.prepare('UPDATE devices SET latitude=?, longitude=?, updated_at=? WHERE id=?').run(lat, lng, Date.now(), d.id);
          updated++;
          continue;
        }
      }
      errors.push({ row: r.__row, reason: 'تجهیزی با این IP یا نام یافت نشد' });
    }
    res.json({ updated, errors });
  } catch (e) {
    res.status(400).json({ error: `خطا در خواندن فایل: ${e.message}` });
  }
});

/* --------------------------- عملیات گروهی --------------------------- */

router.post('/bulk', (req, res) => {
  const { ids = [], action, payload = {} } = req.body || {};
  const list = ids.map(Number).filter(Boolean);
  if (!list.length) return res.status(400).json({ error: 'هیچ تجهیزی انتخاب نشده است' });
  const ph = list.map(() => '?').join(',');
  let affected = 0;
  switch (action) {
    case 'enable':
      affected = db.prepare(`UPDATE devices SET enabled=1, updated_at=? WHERE id IN (${ph})`).run(Date.now(), ...list).changes;
      break;
    case 'disable':
      affected = db.prepare(`UPDATE devices SET enabled=0, updated_at=? WHERE id IN (${ph})`).run(Date.now(), ...list).changes;
      break;
    case 'monitoring_on':
      affected = db.prepare(`UPDATE devices SET monitoring_enabled=1, updated_at=? WHERE id IN (${ph})`).run(Date.now(), ...list).changes;
      break;
    case 'monitoring_off':
      affected = db.prepare(`UPDATE devices SET monitoring_enabled=0, updated_at=? WHERE id IN (${ph})`).run(Date.now(), ...list).changes;
      break;
    case 'delete':
      affected = deleteDevices(list);
      break;
    case 'group': {
      const g = groupByName(payload.group);
      affected = g ? db.prepare(`UPDATE devices SET group_id=?, updated_at=? WHERE id IN (${ph})`).run(g.id, Date.now(), ...list).changes : 0;
      break;
    }
    case 'priority':
      affected = db.prepare(`UPDATE devices SET priority=?, updated_at=? WHERE id IN (${ph})`).run(payload.priority || 'normal', Date.now(), ...list).changes;
      break;
    case 'interval':
      affected = db.prepare(`UPDATE devices SET ping_interval=?, updated_at=? WHERE id IN (${ph})`).run(payload.interval ? Number(payload.interval) : null, Date.now(), ...list).changes;
      break;
    case 'tag': {
      for (const id of list) attachTags(id, [payload.tag]);
      affected = list.length;
      break;
    }
    case 'untag':
      affected = payload.tagId
        ? db.prepare(`DELETE FROM device_tags WHERE tag_id=? AND device_id IN (${ph})`).run(Number(payload.tagId), ...list).changes
        : 0;
      break;
    case 'ping': {
      affected = list.length;
      res.json({ queued: true, affected });
      Promise.all(list.map((id) => pingDevice(id, { manual: true }))).catch(() => {});
      return;
    }
    default:
      return res.status(400).json({ error: `عملیات ناشناخته: ${action}` });
  }
  db.prepare('INSERT INTO engine_log(ts, level, message) VALUES (?,?,?)').run(
    Date.now(),
    'info',
    `عملیات گروهی «${action}» روی ${affected} تجهیز اجرا شد.`
  );
  res.json({ affected, action });
});

/** به‌روزرسانی سریع موقعیت روی نقشه */
router.post('/positions', (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const upd = db.prepare('UPDATE devices SET latitude=?, longitude=?, map_layer_id=COALESCE(?, map_layer_id), updated_at=? WHERE id=?');
  let n = 0;
  for (const it of items) {
    const lat = it.latitude == null ? null : Number(it.latitude);
    const lng = it.longitude == null ? null : Number(it.longitude);
    n += upd.run(lat, lng, it.mapLayerId ?? null, Date.now(), Number(it.id)).changes;
  }
  res.json({ updated: n });
});

/** سری نمونه‌ای سبک برای نمودار کارت‌های فهرست تجهیزات */
router.get('/sparklines', (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map(Number)
    .filter(Boolean)
    .slice(0, 300);
  const range = String(req.query.range || '1h');
  if (!ids.length) return res.json({ range, series: {} });
  const bucket = RANGE_BUCKETS[range] || RANGE_BUCKETS['1h'];
  const from = Date.now() - (RANGE_MS[range] || RANGE_MS['1h']);
  const ph = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT device_id, (ts / ?) * ? AS bucket,
              AVG(CASE WHEN ok=1 THEN rtt_ms END) AS rtt,
              AVG(ok) * 100 AS availability
       FROM samples WHERE device_id IN (${ph}) AND ts >= ?
       GROUP BY device_id, bucket ORDER BY bucket`
    )
    .all(bucket.ms, bucket.ms, ...ids, from);
  const series = {};
  for (const r of rows) {
    if (!series[r.device_id]) series[r.device_id] = [];
    series[r.device_id].push({
      t: r.bucket,
      rtt: r.rtt == null ? null : Math.round(r.rtt * 100) / 100,
      loss: r.availability == null ? 0 : Math.round((100 - r.availability) * 10) / 10,
    });
  }
  res.json({ range, bucketMs: bucket.ms, series });
});

/* --------------------------- CRUD --------------------------- */

router.get('/:id', (req, res) => {
  const d = getDevice(req.params.id);
  if (!d) return res.status(404).json({ error: 'تجهیز یافت نشد' });
  const s = getSettings();
  const interval = d.pingInterval || s.ping_interval;
  res.json({
    ...d,
    effective: {
      pingInterval: interval,
      timeoutMs: d.timeoutMs || s.timeout_ms,
      packetCount: d.packetCount || s.packet_count,
      retries: d.retries ?? s.retries,
      latencyThreshold: d.latencyThreshold ?? s.latency_threshold,
      lossThreshold: d.lossThreshold ?? s.loss_threshold,
    },
    stats: {
      outages: d.outageCount || 0,
      openOutage: d.currentOutageStartedAt ? Math.max(0, Math.round((Date.now() - d.currentOutageStartedAt) / 1000)) : null,
      packets: { sent: d.totalChecks, received: d.successCount, lost: d.failCount },
    },
  });
});

router.post('/', (req, res) => {
  try {
    const d = createDevice(req.body || {});
    res.status(201).json(d);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const d = updateDevice(req.params.id, req.body || {});
    if (!d) return res.status(404).json({ error: 'تجهیز یافت نشد' });
    res.json(d);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/:id', (req, res) => {
  try {
    const d = updateDevice(req.params.id, req.body || {});
    if (!d) return res.status(404).json({ error: 'تجهیز یافت نشد' });
    res.json(d);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  const n = deleteDevices([req.params.id]);
  if (!n) return res.status(404).json({ error: 'تجهیز یافت نشد' });
  res.json({ deleted: n });
});

/* --------------------------- بررسی لحظه‌ای --------------------------- */

// مرزگذاری پارامترهای ورودی کاربر (تعداد packet و مدت انتظار از بدنهٔ درخواست می‌آید)
function clamp(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

async function pingDevice(id, opts = {}) {
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(Number(id));
  if (!row) return null;
  return engine.checkDevice(row, { manual: true, source: 'manual', ...opts });
}

router.post('/:id/ping', async (req, res) => {
  const d = getDevice(req.params.id, { withTags: false });
  if (!d) return res.status(404).json({ error: 'تجهیز یافت نشد' });
  try {
    const body = req.body || {};
    const before = { ...d };
    let result;
    if (body.mode && body.mode !== 'engine') {
      const { icmpPing, tcpPing } = await import('../ping.js');
      const timeoutMs = clamp(body.timeout || d.timeoutMs || d.effective?.timeoutMs || 1200, 100, 15000);
      const count = clamp(body.count || 1, 1, 10);
      const port = clamp(body.port || 80, 1, 65535);
      result =
        body.mode === 'tcp'
          ? await tcpPing(d.ip, { timeoutMs, count: 1, port })
          : body.mode === 'icmp'
            ? await icmpPing(d.ip, { timeoutMs, count })
            : await pingDevice(d.id);
    } else {
      result = await pingDevice(d.id);
    }
    const after = getDevice(d.id);
    res.json({ result, device: after, before: { status: before.status, lastRtt: before.lastRtt } });
  } catch (e) {
    res.status(500).json({ error: `خطا در ارسال Ping: ${e.message}` });
  }
});

/* --------------------------- تاریخچه --------------------------- */

router.get('/:id/series', (req, res) => {
  res.json(seriesFor(req.params.id, String(req.query.range || '1h')));
});

router.get('/:id/outages', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '100', 10) || 100));
  const rows = db
    .prepare('SELECT * FROM outages WHERE device_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(Number(req.params.id), limit);
  const total = db.prepare('SELECT COUNT(*) AS c FROM outages WHERE device_id = ?').get(Number(req.params.id)).c;
  const openRow = db.prepare('SELECT * FROM outages WHERE device_id = ? AND open = 1 ORDER BY started_at DESC LIMIT 1').get(Number(req.params.id));
  res.json({
    total,
    open: openRow
      ? { ...openRow, durationSec: Math.round((Date.now() - openRow.started_at) / 1000) }
      : null,
    items: rows.map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      durationSec: r.ended_at ? r.duration_sec ?? Math.round((r.ended_at - r.started_at) / 1000) : Math.round((Date.now() - r.started_at) / 1000),
      cause: r.cause,
      detail: r.detail,
      lat: r.lat,
      lng: r.lng,
      open: !!r.open,
      maintenance: db.prepare('SELECT id, action, technician FROM maintenance_records WHERE outage_id = ?').get(r.id) || null,
    })),
  });
});

router.get('/:id/availability', (req, res) => {
  const range = String(req.query.range || '24h');
  const series = seriesFor(req.params.id, range);
  const buckets = series.points;
  const overall = buckets.length ? buckets.reduce((a, b) => a + b.availability, 0) / buckets.length : 100;
  const checks = buckets.reduce((a, b) => a + b.samples, 0);
  const failed = buckets.reduce((a, b) => a + b.down, 0);
  res.json({
    range,
    bucketLabel: series.bucketLabel,
    overall: Math.round(overall * 100) / 100,
    checks,
    failed,
    worstBucket: buckets.length ? buckets.reduce((a, b) => (a.availability <= b.availability ? a : b)) : null,
    buckets: buckets.map((b) => ({ t: b.t, availability: b.availability, down: b.down, samples: b.samples })),
  });
});

router.get('/:id/samples', (req, res) => {
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit || '200', 10) || 200));
  const rows = db
    .prepare('SELECT ts, rtt_ms, loss_pct, status, ok, mode, packets_sent, packets_recv FROM samples WHERE device_id = ? ORDER BY ts DESC LIMIT ?')
    .all(Number(req.params.id), limit);
  res.json({
    items: rows.map((r) => ({
      ts: r.ts,
      rtt: r.rtt_ms,
      lossPct: r.loss_pct,
      status: r.status,
      ok: !!r.ok,
      mode: r.mode,
      sent: r.packets_sent,
      received: r.packets_recv,
    })),
  });
});

/** نمای کلی سلامت تجهیز برای سربرگ صفحه جزئیات */
router.get('/:id/health', (req, res) => {
  const d = getDevice(req.params.id);
  if (!d) return res.status(404).json({ error: 'تجهیز یافت نشد' });
  const day = db
    .prepare('SELECT * FROM daily_stats WHERE device_id = ? ORDER BY day DESC LIMIT 14')
    .all(Number(req.params.id));
  const mtbf = db
    .prepare('SELECT AVG(diff) AS mtbf FROM (SELECT started_at - LAG(ended_at) OVER (ORDER BY started_at) AS diff FROM outages WHERE device_id = ? AND ended_at IS NOT NULL)')
    .get(Number(req.params.id));
  const mttr = db.prepare('SELECT AVG(duration_sec) AS mttr FROM outages WHERE device_id = ? AND ended_at IS NOT NULL').get(Number(req.params.id));
  res.json({
    deviceId: d.id,
    daily: day.reverse(),
    mtbfSec: mtbf?.mtbf ? Math.round(mtbf.mtbf / 1000) : null,
    mttrSec: mttr?.mttr ? Math.round(mttr.mttr) : null,
    maintenance: db
      .prepare('SELECT COUNT(*) AS c FROM maintenance_records WHERE device_id = ?')
      .get(Number(req.params.id)).c,
  });
});

router.get('/:id/maintenance', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM maintenance_records WHERE device_id = ? ORDER BY started_at DESC')
    .all(Number(req.params.id));
  res.json({ items: rows });
});

export { pingDevice, RANGE_BUCKETS, RANGE_MS };
export default router;
