/**
 * NetWatch — API عملیات: هشدارها، تعمیرات، موتور و تنظیمات
 */
import express from 'express';
import { db, getSettings, setSettings, sanitizeSettings, log } from '../db.js';
import { engine, bus } from '../engine.js';

const router = express.Router();

/* ------------------------------ هشدارها ------------------------------ */

function serializeAlert(a) {
  return {
    id: a.id,
    deviceId: a.device_id,
    deviceName: a.deviceName,
    deviceIp: a.deviceIp,
    ruleId: a.rule_id,
    ruleName: a.ruleName,
    severity: a.severity,
    kind: a.kind,
    title: a.title,
    message: a.message,
    value: a.value,
    createdAt: a.created_at,
    status: a.status,
    acknowledgedAt: a.acknowledged_at,
    acknowledgedBy: a.acknowledged_by,
    resolvedAt: a.resolved_at,
  };
}

router.get('/alerts', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize || '25', 10) || 25));
  const where = [];
  const params = [];
  if (req.query.status && req.query.status !== 'all') {
    where.push('a.status = ?');
    params.push(String(req.query.status));
  }
  if (req.query.severity && req.query.severity !== 'all') {
    where.push('a.severity = ?');
    params.push(String(req.query.severity));
  }
  if (req.query.kind && req.query.kind !== 'all') {
    where.push('a.kind = ?');
    params.push(String(req.query.kind));
  }
  if (req.query.deviceId) {
    where.push('a.device_id = ?');
    params.push(Number(req.query.deviceId));
  }
  if (req.query.search) {
    where.push('(a.title LIKE ? OR a.message LIKE ? OR d.name LIKE ? OR d.ip LIKE ?)');
    const s = `%${req.query.search}%`;
    params.push(s, s, s, s);
  }
  if (req.query.from) {
    where.push('a.created_at >= ?');
    params.push(Number(req.query.from));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM alerts a LEFT JOIN devices d ON d.id=a.device_id ${clause}`)
    .get(...params).c;
  const rows = db
    .prepare(
      `SELECT a.*, d.name AS deviceName, d.ip AS deviceIp, r.name AS ruleName
       FROM alerts a LEFT JOIN devices d ON d.id=a.device_id LEFT JOIN alert_rules r ON r.id=a.rule_id
       ${clause} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  const stats = db
    .prepare("SELECT status, COUNT(*) c FROM alerts GROUP BY status")
    .all()
    .reduce((acc, r) => ({ ...acc, [r.status]: r.c }), {});
  const bySeverity = db
    .prepare("SELECT severity, COUNT(*) c FROM alerts WHERE status='active' GROUP BY severity")
    .all()
    .reduce((acc, r) => ({ ...acc, [r.severity]: r.c }), {});
  res.json({
    items: rows.map(serializeAlert),
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    stats: { active: stats.active || 0, acknowledged: stats.acknowledged || 0, resolved: stats.resolved || 0, suppressed: stats.suppressed || 0, bySeverity },
  });
});

router.post('/alerts/:id/ack', (req, res) => {
  const by = String(req.body?.by || 'مدیر شبکه');
  const n = db.prepare("UPDATE alerts SET status='acknowledged', acknowledged_at=?, acknowledged_by=? WHERE id=? AND status='active'").run(Date.now(), by, Number(req.params.id)).changes;
  bus.emit('alerts-changed', { id: Number(req.params.id) });
  res.json({ updated: n });
});

router.post('/alerts/:id/resolve', (req, res) => {
  const n = db.prepare("UPDATE alerts SET status='resolved', resolved_at=? WHERE id=?").run(Date.now(), Number(req.params.id)).changes;
  bus.emit('alerts-changed', { id: Number(req.params.id) });
  res.json({ updated: n });
});

router.post('/alerts/bulk', (req, res) => {
  const { ids = [], action } = req.body || {};
  const list = ids.map(Number).filter(Boolean);
  if (!list.length) return res.status(400).json({ error: 'هیچ هشداری انتخاب نشده است' });
  const ph = list.map(() => '?').join(',');
  let n;
  if (action === 'ack') n = db.prepare(`UPDATE alerts SET status='acknowledged', acknowledged_at=?, acknowledged_by=? WHERE id IN (${ph})`).run(Date.now(), 'مدیر شبکه', ...list).changes;
  else if (action === 'resolve') n = db.prepare(`UPDATE alerts SET status='resolved', resolved_at=? WHERE id IN (${ph})`).run(Date.now(), ...list).changes;
  else if (action === 'delete') n = db.prepare(`DELETE FROM alerts WHERE id IN (${ph})`).run(...list).changes;
  else return res.status(400).json({ error: 'عملیات نامعتبر' });
  bus.emit('alerts-changed', { ids: list });
  res.json({ updated: n });
});

router.delete('/alerts/:id', (req, res) => {
  const n = db.prepare('DELETE FROM alerts WHERE id=?').run(Number(req.params.id)).changes;
  res.json({ deleted: n });
});

/* --------------------------- قوانین هشدار --------------------------- */

router.get('/alert-rules', (_req, res) => {
  res.json({
    items: db
      .prepare('SELECT r.*, g.name AS groupName FROM alert_rules r LEFT JOIN groups g ON g.id=r.scope_group_id ORDER BY r.id')
      .all(),
    meta: { groups: db.prepare('SELECT id, name, color FROM groups ORDER BY name').all() },
  });
});

const ruleBody = (b = {}) => [
  String(b.name || 'قانون بدون نام').slice(0, 120),
  b.enabled === undefined ? 1 : Number(b.enabled) ? 1 : 0,
  ['offline', 'latency', 'loss', 'recovery'].includes(b.metric) ? b.metric : 'offline',
  ['gte', 'lte', 'eq'].includes(b.comparator) ? b.comparator : 'gte',
  Number(b.threshold) || 0,
  Number(b.duration_sec) || 0,
  ['info', 'warning', 'critical'].includes(b.severity) ? b.severity : 'warning',
  b.scope_group_id ? Number(b.scope_group_id) : null,
  Number(b.cooldown_sec) || 600,
  Number(b.apply_to_unmon) ? 1 : 0,
  Number(b.silent) ? 1 : 0,
];

router.post('/alert-rules', (req, res) => {
  const v = ruleBody(req.body);
  const r = db
    .prepare(
      'INSERT INTO alert_rules(name, enabled, metric, comparator, threshold, duration_sec, severity, scope_group_id, cooldown_sec, apply_to_unmon, silent, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    )
    .run(...v, Date.now());
  engine.invalidate();
  res.status(201).json(db.prepare('SELECT * FROM alert_rules WHERE id=?').get(Number(r.lastInsertRowid)));
});

router.put('/alert-rules/:id', (req, res) => {
  const v = ruleBody(req.body);
  const n = db
    .prepare(
      'UPDATE alert_rules SET name=?, enabled=?, metric=?, comparator=?, threshold=?, duration_sec=?, severity=?, scope_group_id=?, cooldown_sec=?, apply_to_unmon=?, silent=? WHERE id=?'
    )
    .run(...v, Number(req.params.id)).changes;
  engine.invalidate();
  res.json({ updated: n });
});

router.delete('/alert-rules/:id', (req, res) => {
  const n = db.prepare('DELETE FROM alert_rules WHERE id=?').run(Number(req.params.id)).changes;
  engine.invalidate();
  res.json({ deleted: n });
});

/* ---------------------------- تعمیرات ---------------------------- */

router.get('/maintenance', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.deviceId) {
    where.push('m.device_id = ?');
    params.push(Number(req.query.deviceId));
  }
  if (req.query.cause) {
    where.push('m.cause = ?');
    params.push(String(req.query.cause));
  }
  if (req.query.action) {
    where.push('m.action = ?');
    params.push(String(req.query.action));
  }
  if (req.query.status) {
    where.push('m.status = ?');
    params.push(String(req.query.status));
  }
  if (req.query.from) {
    where.push('m.started_at >= ?');
    params.push(Number(req.query.from));
  }
  if (req.query.to) {
    where.push('m.started_at <= ?');
    params.push(Number(req.query.to));
  }
  if (req.query.search) {
    where.push('(m.title LIKE ? OR m.description LIKE ? OR m.notes LIKE ? OR d.name LIKE ? OR d.ip LIKE ? OR m.technician LIKE ?)');
    const s = `%${req.query.search}%`;
    params.push(s, s, s, s, s, s);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize || '25', 10) || 25));
  const total = db.prepare(`SELECT COUNT(*) c FROM maintenance_records m LEFT JOIN devices d ON d.id=m.device_id ${clause}`).get(...params).c;
  const rows = db
    .prepare(
      `SELECT m.*, d.name AS deviceName, d.ip AS deviceIp, g.name AS groupName, g.color AS groupColor
       FROM maintenance_records m LEFT JOIN devices d ON d.id=m.device_id LEFT JOIN groups g ON g.id=d.group_id
       ${clause} ORDER BY m.started_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  const s = getSettings();
  res.json({
    items: rows.map((m) => ({
      id: m.id,
      deviceId: m.device_id,
      deviceName: m.deviceName,
      deviceIp: m.deviceIp,
      groupName: m.groupName,
      groupColor: m.groupColor,
      outageId: m.outage_id,
      title: m.title,
      cause: m.cause,
      action: m.action,
      startedAt: m.started_at,
      endedAt: m.ended_at,
      downtimeSec: m.downtime_sec,
      technician: m.technician,
      cost: m.cost,
      description: m.description,
      notes: m.notes,
      status: m.status,
      createdAt: m.created_at,
    })),
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    meta: { causes: s.repair_causes, actions: s.repair_actions },
  });
});

router.post('/maintenance', (req, res) => {
  const b = req.body || {};
  if (!b.device_id) return res.status(400).json({ error: 'انتخاب تجهیز الزامی است' });
  const started = Number(b.started_at) || Date.now();
  const ended = b.ended_at ? Number(b.ended_at) : null;
  const dur = ended ? Math.max(0, Math.round((ended - started) / 1000)) : 0;
  const r = db
    .prepare(
      'INSERT INTO maintenance_records(device_id, outage_id, title, cause, action, started_at, ended_at, downtime_sec, technician, cost, description, notes, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    )
    .run(
      Number(b.device_id),
      b.outage_id ? Number(b.outage_id) : null,
      String(b.title || ''),
      String(b.cause || 'سایر'),
      String(b.action || 'سایر'),
      started,
      ended,
      dur,
      String(b.technician || ''),
      Number(b.cost) || 0,
      String(b.description || ''),
      String(b.notes || ''),
      ended ? 'closed' : 'open',
      Date.now()
    );
  log('info', `سابقه تعمیرات برای تجهیز #${b.device_id} ثبت شد.`);
  res.status(201).json(db.prepare('SELECT * FROM maintenance_records WHERE id=?').get(Number(r.lastInsertRowid)));
});

router.put('/maintenance/:id', (req, res) => {
  const b = req.body || {};
  const existing = db.prepare('SELECT * FROM maintenance_records WHERE id=?').get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'سابقه یافت نشد' });
  const started = b.started_at ? Number(b.started_at) : existing.started_at;
  const ended = b.ended_at === null ? null : b.ended_at ? Number(b.ended_at) : existing.ended_at;
  const dur = ended ? Math.max(0, Math.round((ended - started) / 1000)) : 0;
  db.prepare(
    'UPDATE maintenance_records SET title=?, cause=?, action=?, started_at=?, ended_at=?, downtime_sec=?, technician=?, cost=?, description=?, notes=?, status=? WHERE id=?'
  ).run(
    b.title ?? existing.title,
    b.cause ?? existing.cause,
    b.action ?? existing.action,
    started,
    ended,
    dur,
    b.technician ?? existing.technician,
    b.cost === undefined ? existing.cost : Number(b.cost) || 0,
    b.description ?? existing.description,
    b.notes ?? existing.notes,
    ended ? 'closed' : 'open',
    Number(req.params.id)
  );
  res.json(db.prepare('SELECT * FROM maintenance_records WHERE id=?').get(Number(req.params.id)));
});

router.delete('/maintenance/:id', (req, res) => {
  res.json({ deleted: db.prepare('DELETE FROM maintenance_records WHERE id=?').run(Number(req.params.id)).changes });
});

/* ------------------------ پنجره‌های تعمیرات ------------------------ */

router.get('/maintenance-windows', (_req, res) => {
  res.json({
    items: db
      .prepare('SELECT w.*, d.name AS deviceName FROM maintenance_windows w LEFT JOIN devices d ON d.id=w.device_id ORDER BY w.device_id IS NULL DESC, w.id')
      .all(),
  });
});

router.post('/maintenance-windows', (req, res) => {
  const b = req.body || {};
  const r = db
    .prepare('INSERT INTO maintenance_windows(device_id, title, days, start_time, end_time, enabled, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(b.device_id ? Number(b.device_id) : null, String(b.title || 'پنجره تعمیرات'), String(b.days || '0,1,2,3,4,5,6'), String(b.start_time || '01:00'), String(b.end_time || '03:00'), b.enabled === undefined ? 1 : Number(b.enabled) ? 1 : 0, Date.now());
  engine.invalidate();
  res.status(201).json(db.prepare('SELECT * FROM maintenance_windows WHERE id=?').get(Number(r.lastInsertRowid)));
});

router.put('/maintenance-windows/:id', (req, res) => {
  const b = req.body || {};
  const n = db
    .prepare('UPDATE maintenance_windows SET device_id=?, title=?, days=?, start_time=?, end_time=?, enabled=? WHERE id=?')
    .run(b.device_id ? Number(b.device_id) : null, String(b.title || ''), String(b.days || '0,1,2,3,4,5,6'), String(b.start_time || '01:00'), String(b.end_time || '03:00'), Number(b.enabled) ? 1 : 0, Number(req.params.id)).changes;
  engine.invalidate();
  res.json({ updated: n });
});

router.delete('/maintenance-windows/:id', (req, res) => {
  const n = db.prepare('DELETE FROM maintenance_windows WHERE id=?').run(Number(req.params.id)).changes;
  engine.invalidate();
  res.json({ deleted: n });
});

/* -------------------- رویدادهای قطع و وصل (لاگ) -------------------- */

function clampHours(v, def = 24, max = 24 * 90) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(1, n));
}

/** لاگ قطع و وصل شدن تجهیزات به‌صورت فهرست و نمودار زمانی */
router.get('/events/flaps', (req, res) => {
  const hours = clampHours(req.query.hours, 24);
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const now = Date.now();
  const from = now - hours * 3600000;
  const rows = db
    .prepare(
      `SELECT o.id, o.device_id, o.started_at, o.ended_at, o.duration_sec, o.cause, o.open,
              d.name AS deviceName, d.ip AS deviceIp
       FROM outages o JOIN devices d ON d.id = o.device_id
       WHERE o.started_at >= ? OR COALESCE(o.ended_at, ?) >= ?
       ORDER BY o.started_at DESC LIMIT ?`
    )
    .all(from, now, from, limit);

  const events = [];
  for (const o of rows) {
    const base = { outageId: o.id, deviceId: o.device_id, deviceName: o.deviceName, deviceIp: o.deviceIp, cause: o.cause };
    if (o.started_at >= from)
      events.push({ ...base, id: `${o.id}-down`, kind: 'down', ts: o.started_at, durationSec: null });
    if (o.ended_at && o.ended_at >= from)
      events.push({
        ...base,
        id: `${o.id}-up`,
        kind: 'up',
        ts: o.ended_at,
        durationSec: o.duration_sec ?? Math.round((o.ended_at - o.started_at) / 1000),
      });
  }
  events.sort((a, b) => b.ts - a.ts);

  const bucketMs = hours <= 6 ? 5 * 60000 : hours <= 48 ? 15 * 60000 : hours <= 24 * 14 ? 3600000 : 6 * 3600000;
  const start = Math.floor(from / bucketMs) * bucketMs;
  const series = [];
  const index = new Map();
  for (let t = start; t <= now; t += bucketMs) {
    const b = { t, down: 0, up: 0 };
    series.push(b);
    index.set(t, b);
  }
  for (const o of rows) {
    if (o.started_at >= start) {
      const b = index.get(Math.floor(o.started_at / bucketMs) * bucketMs);
      if (b) b.down += 1;
    }
    if (o.ended_at && o.ended_at >= start) {
      const b = index.get(Math.floor(o.ended_at / bucketMs) * bucketMs);
      if (b) b.up += 1;
    }
  }
  res.json({ hours, from, to: now, bucketMs, series, items: events.slice(0, limit) });
});

/**
 * قطعی‌های هم‌زمان: بازه‌هایی که حداقل دو تجهیز همزمان قطع بوده‌اند.
 * با الگوریتم جاروبی (sweep-line) روی ابتدا/پایان قطعی‌ها محاسبه می‌شود تا
 * تشخیص داده شود مشکل همه آن‌ها یکی است یا نه.
 */
router.get('/events/simultaneous', (req, res) => {
  const hours = clampHours(req.query.hours, 24);
  const now = Date.now();
  const from = now - hours * 3600000;
  const rows = db
    .prepare(
      `SELECT o.id, o.device_id, o.started_at, COALESCE(o.ended_at, ?) AS ended_at, d.name AS deviceName
       FROM outages o JOIN devices d ON d.id = o.device_id
       WHERE o.started_at <= ? AND COALESCE(o.ended_at, ?) >= ?`
    )
    .all(now, now, from, from);

  const byTs = new Map();
  const push = (ts, delta, row) => {
    if (!byTs.has(ts)) byTs.set(ts, []);
    byTs.get(ts).push({ delta, row });
  };
  for (const o of rows) {
    push(Math.max(o.started_at, from), 1, o);
    push(Math.min(o.ended_at, now), -1, o);
  }
  const tsList = [...byTs.keys()].sort((a, b) => a - b);
  const active = new Map();
  const clusters = [];
  const segments = [];
  let open = null;
  let prevTs = from;
  for (const ts of tsList) {
    if (ts > prevTs) segments.push({ from: prevTs, to: ts, count: active.size });
    for (const p of byTs.get(ts)) {
      if (p.delta === 1) active.set(p.row.device_id, p.row);
      else active.delete(p.row.device_id);
    }
    if (active.size >= 2) {
      if (!open) open = { start: ts, devices: new Map() };
      for (const [id, row] of active) if (!open.devices.has(id)) open.devices.set(id, row.deviceName);
    } else if (open) {
      open.end = ts;
      clusters.push(open);
      open = null;
    }
    prevTs = ts;
  }
  if (prevTs < now) segments.push({ from: prevTs, to: now, count: active.size });
  if (open) {
    open.end = now;
    clusters.push(open);
  }

  // نمودار همزمانی: مقدار تجهیزات قطع‌شدهٔ هم‌زمان در هر بازه
  const bucketMs = hours <= 6 ? 5 * 60000 : hours <= 48 ? 15 * 60000 : 3600000;
  const bStart = Math.floor(from / bucketMs) * bucketMs;
  const series = [];
  let segIdx = 0;
  for (let t = bStart; t <= now; t += bucketMs) {
    while (segIdx < segments.length && segments[segIdx].to <= t) segIdx++;
    const seg = segments[segIdx];
    series.push({ t, concurrent: seg && t >= seg.from && t < seg.to ? seg.count : 0 });
  }

  const items = clusters
    .map((c) => ({
      start: c.start,
      end: c.end,
      durationSec: Math.max(1, Math.round((c.end - c.start) / 1000)),
      count: c.devices.size,
      devices: [...c.devices.entries()].map(([id, name]) => ({ id, name })),
    }))
    .sort((a, b) => b.durationSec - a.durationSec)
    .slice(0, 100);
  res.json({ hours, from, to: now, bucketMs, series, items, overlapping: items.length });
});

/** خط زمانی (تایم‌لاین) قطعی‌ها برای بازهٔ انتخابی */
router.get('/events/timeline', (req, res) => {
  const hours = clampHours(req.query.hours, 24);
  const now = Date.now();
  const from = now - hours * 3600000;
  const rows = db
    .prepare(
      `SELECT o.id, o.device_id, o.started_at, COALESCE(o.ended_at, ?) AS ended_at, o.cause, o.open,
              d.name AS deviceName, d.ip AS deviceIp
       FROM outages o JOIN devices d ON d.id = o.device_id
       WHERE o.started_at <= ? AND COALESCE(o.ended_at, ?) >= ?
       ORDER BY o.started_at ASC LIMIT 2000`
    )
    .all(now, now, from, from);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.device_id))
      map.set(r.device_id, { deviceId: r.device_id, name: r.deviceName, ip: r.deviceIp, bars: [] });
    map.get(r.device_id).bars.push({
      id: r.id,
      start: Math.max(r.started_at, from),
      end: Math.min(r.ended_at, now),
      open: !!r.open,
      cause: r.cause,
    });
  }
  const devices = [...map.values()].sort((a, b) => b.bars.length - a.bars.length);
  res.json({ hours, from, to: now, devices, total: rows.length });
});

/** تجهیزات با بیشترین تعداد قطعی (آمار) */
router.get('/events/top-outage-devices', (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  const now = Date.now();
  const from = now - days * 86400000;
  const items = db
    .prepare(
      `SELECT d.id, d.name, d.ip, d.status, g.name AS groupName, g.color AS groupColor,
              COUNT(o.id) AS outages,
              COALESCE(SUM(COALESCE(o.duration_sec, (? - o.started_at)/1000)),0) AS downtimeSec,
              MAX(o.started_at) AS lastOutageAt
       FROM devices d LEFT JOIN groups g ON g.id = d.group_id
       LEFT JOIN outages o ON o.device_id = d.id AND o.started_at >= ?
       GROUP BY d.id HAVING outages > 0
       ORDER BY outages DESC, downtimeSec DESC LIMIT 20`
    )
    .all(now, from)
    .map((r) => ({ ...r, downtimeSec: Math.round(r.downtimeSec) }));
  res.json({ days, from, to: now, items });
});

/* ------------------------------ موتور ------------------------------ */

router.get('/engine/status', (_req, res) => {
  res.json({
    ...engine.getStatus(),
    mode: getSettings().engine_mode,
    lastLogs: db.prepare('SELECT ts, level, message FROM engine_log ORDER BY ts DESC LIMIT 30').all(),
  });
});

router.post('/engine/control/:action', async (req, res) => {
  const action = req.params.action;
  if (!['start', 'stop', 'restart'].includes(action)) return res.status(400).json({ error: 'عملیات نامعتبر' });
  try {
    if (action === 'stop') engine.stop();
    else if (action === 'restart') {
      engine.stop();
      await engine.start();
    } else await engine.start();
    res.json(engine.getStatus());
  } catch (e) {
    log('error', `تغییر وضعیت موتور ناموفق بود: ${e.message}`);
    res.status(500).json({ error: 'تغییر وضعیت موتور ناموفق بود.' });
  }
});

router.post('/engine/check/:id', async (req, res) => {
  const row = db.prepare('SELECT * FROM devices WHERE id=?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'تجهیز یافت نشد' });
  try {
    const result = await engine.checkDevice(row, { manual: true, source: 'manual' });
    res.json({ result });
  } catch (e) {
    log('error', `بررسی دستی تجهیز #${row.id} ناموفق بود: ${e.message}`);
    res.status(500).json({ error: 'بررسی تجهیز ناموفق بود.' });
  }
});

// همهٔ تجهیزات برای بررسی «سررسید» علامت می‌خورند و موتور با همان محدودیت هم‌زمانی
// خود آن‌ها را بررسی می‌کند. پیش‌تر این مسیر صدها بررسی را به‌صورت زنجیره‌ای و بدون
// سقف هم‌زمانی اجرا می‌کرد و می‌توانست ساعت‌ها طول بکشد.
router.post('/engine/check-all', (_req, res) => {
  const n = db
    .prepare('UPDATE devices SET next_check_at = 0 WHERE enabled = 1 AND monitoring_enabled = 1')
    .run().changes;
  log('info', `بررسی دستی همهٔ تجهیزات در صف موتور قرار گرفت (${n} تجهیز).`);
  res.json({ queued: Number(n) });
});

/* ---------------------------- تنظیمات ---------------------------- */

router.get('/settings', (_req, res) => {
  const s = getSettings();
  res.json({
    settings: s,
    engine: engine.getStatus(),
    icmpAvailable: engine.getStatus().icmpAvailable,
    dbSize: db.prepare("SELECT COUNT(*) AS c FROM samples").get().c,
    paths: { dbFile: 'data/netwatch.db', tilesDir: 'data/mbtiles' },
  });
});

router.put('/settings', (req, res) => {
  // فقط کلیدهای شناخته‌شده پذیرفته و مقدارها در db.js مرزگذاری می‌شوند
  const { clean, rejected } = sanitizeSettings(req.body || {});
  const s = setSettings(clean);
  // کش موتور باطل می‌شود تا تغییر بازه/حالت پایش در همان چرخهٔ بعدی اعمال شود
  engine.invalidate();
  log('info', `تنظیمات برنامه به‌روزرسانی شد${rejected.length ? ` (مقدارهای نامعتبر: ${rejected.join(', ')})` : ''}.`);
  res.json({ settings: s, engine: engine.getStatus(), rejected });
});

/**
 * بازنشانی دادهٔ نمونه فقط وقتی فعال است که اپراتور صریحاً آن را روشن کرده باشد.
 * این اندپوینت کل پایگاه‌داده را پاک می‌کند و سامانه احراز هویت ندارد؛ پس در نصب
 * پیش‌فرض روی شبکه در دسترس نخواهد بود و برای بازنشانی، اپراتور باید
 * NETWATCH_ALLOW_RESET=1 را تنظیم کند. معادل خط فرمان
 * (`npm run seed:reset`) مستقل از این پرچم در دسترس است.
 */
function resetEnabled() {
  return String(process.env.NETWATCH_ALLOW_RESET || '') === '1';
}

/** بازنشانی کامل داده‌های نمونه */
router.post('/settings/reset-demo', (req, res) => {
  if (String(req.body?.confirm) !== 'reset') {
    return res.status(400).json({ error: 'برای بازنشانی، مقدار confirm را «reset» بفرستید.' });
  }
  // پیش از هر کار مخرب: اگر قابلیت فعال نیست، هیچ چیزی خوانده یا حذف نمی‌شود
  if (!resetEnabled()) {
    log('warn', 'درخواست بازنشانی داده‌ها رد شد: قابلیت بازنشانی فعال نیست (NETWATCH_ALLOW_RESET=1).');
    return res.status(403).json({
      error: 'بازنشانی داده‌ها در این نصب غیرفعال است. برای فعال‌سازی، NETWATCH_ALLOW_RESET=1 را تنظیم و سرویس را دوباره راه‌اندازی کنید؛ یا از دستور «npm run seed:reset» استفاده کنید.',
    });
  }
  engine.stop();
  const { seedIfEmpty } = req.app.locals;
  try {
    seedIfEmpty({ force: true });
  } catch (e) {
    log('error', `بازنشانی داده‌های نمونه ناموفق بود: ${e.message}`);
    engine.start().catch(() => {});
    return res.status(500).json({ error: 'بازنشانی داده‌های نمونه ناموفق بود.' });
  }
  engine.invalidate();
  engine.start().catch(() => {});
  res.json({ ok: true, message: 'داده‌های نمونه بازنشانی شد.' });
});

/* ------------------------------ لاگ ------------------------------ */

router.get('/engine/log', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '100', 10) || 100));
  res.json({ items: db.prepare('SELECT ts, level, message FROM engine_log ORDER BY ts DESC LIMIT ?').all(limit) });
});

export default router;
