/**
 * NetWatch — API عملیات: هشدارها، تعمیرات، موتور و تنظیمات
 */
import express from 'express';
import { db, getSettings, setSettings, log } from '../db.js';
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
  let n = 0;
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
  Number(b.cooldown_sec) ?? 600,
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
  res.status(201).json(db.prepare('SELECT * FROM alert_rules WHERE id=?').get(Number(r.lastInsertRowid)));
});

router.put('/alert-rules/:id', (req, res) => {
  const v = ruleBody(req.body);
  const n = db
    .prepare(
      'UPDATE alert_rules SET name=?, enabled=?, metric=?, comparator=?, threshold=?, duration_sec=?, severity=?, scope_group_id=?, cooldown_sec=?, apply_to_unmon=?, silent=? WHERE id=?'
    )
    .run(...v, Number(req.params.id)).changes;
  res.json({ updated: n });
});

router.delete('/alert-rules/:id', (req, res) => {
  res.json({ deleted: db.prepare('DELETE FROM alert_rules WHERE id=?').run(Number(req.params.id)).changes });
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
  res.status(201).json(db.prepare('SELECT * FROM maintenance_windows WHERE id=?').get(Number(r.lastInsertRowid)));
});

router.put('/maintenance-windows/:id', (req, res) => {
  const b = req.body || {};
  const n = db
    .prepare('UPDATE maintenance_windows SET device_id=?, title=?, days=?, start_time=?, end_time=?, enabled=? WHERE id=?')
    .run(b.device_id ? Number(b.device_id) : null, String(b.title || ''), String(b.days || '0,1,2,3,4,5,6'), String(b.start_time || '01:00'), String(b.end_time || '03:00'), Number(b.enabled) ? 1 : 0, Number(req.params.id)).changes;
  res.json({ updated: n });
});

router.delete('/maintenance-windows/:id', (req, res) => {
  res.json({ deleted: db.prepare('DELETE FROM maintenance_windows WHERE id=?').run(Number(req.params.id)).changes });
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
  if (action === 'stop') engine.stop();
  else if (action === 'restart') {
    engine.stop();
    await engine.start();
  } else await engine.start();
  res.json(engine.getStatus());
});

router.post('/engine/check/:id', async (req, res) => {
  const row = db.prepare('SELECT * FROM devices WHERE id=?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'تجهیز یافت نشد' });
  const result = await engine.checkDevice(row, { manual: true, source: 'manual' });
  res.json({ result });
});

router.post('/engine/check-all', async (_req, res) => {
  const rows = db.prepare('SELECT * FROM devices WHERE enabled=1').all();
  res.json({ queued: rows.length });
  for (const d of rows) {
    try {
      await engine.checkDevice(d, { manual: true, source: 'manual' });
    } catch {}
  }
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
  const patch = req.body || {};
  const clean = {};
  for (const [k, v] of Object.entries(patch)) {
    if (['engine_mode', 'ping_interval', 'timeout_ms', 'retries', 'packet_count', 'max_workers', 'latency_threshold', 'loss_threshold', 'failures_for_offline', 'successes_for_online', 'retention_days', 'chart_default_range', 'site_name', 'engine_enabled', 'alerting_enabled', 'alert_cooldown', 'alert_delay', 'suppression_enabled', 'suppression_start', 'suppression_end', 'notify_browser', 'calendar', 'timezone_offset_minutes', 'tcp_port', 'repair_causes', 'repair_actions', 'map_default_center', 'map_default_zoom', 'map_show_labels'].includes(k)) {
      clean[k] = v;
    }
  }
  const s = setSettings(clean);
  log('info', 'تنظیمات برنامه به‌روزرسانی شد.');
  res.json({ settings: s, engine: engine.getStatus() });
});

/** بازنشانی کامل داده‌های نمونه */
router.post('/settings/reset-demo', (req, res) => {
  if (String(req.body?.confirm) !== 'reset') {
    return res.status(400).json({ error: 'برای بازنشانی، مقدار confirm را «reset» بفرستید.' });
  }
  engine.stop();
  const { seedIfEmpty } = req.app.locals;
  seedIfEmpty({ force: true });
  engine.start();
  res.json({ ok: true, message: 'داده‌های نمونه بازنشانی شد.' });
});

/* ------------------------------ لاگ ------------------------------ */

router.get('/engine/log', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '100', 10) || 100));
  res.json({ items: db.prepare('SELECT ts, level, message FROM engine_log ORDER BY ts DESC LIMIT ?').all(limit) });
});

export default router;
