/**
 * NetWatch — API کشف شبکه
 * ----------------------------------------------------------------
 * خواندن برای نقش‌های دارای devices:read و هر تغییر برای devices:write.
 * اجرای اسکن علاوه بر آن مجوز probe:run می‌خواهد (اسکن فعال شبکه است).
 */
import express from 'express';
import { db, getSettings } from '../db.js';
import { routePermission, requirePermission } from '../permissions.js';
import {
  MAX_RANGES,
  HARD_MAX_HOSTS,
  validateRangeInput,
  runDiscoveryScan,
  discoveryStatus,
  importDiscoveryResult,
  dismissDiscoveryResult,
  pruneExpired,
  hostCount,
} from '../discovery.js';
import { normalizeCidrList, resolveProbeCidrs } from '../net-policy.js';

const router = express.Router();

router.use(routePermission({ read: 'devices:read', write: 'devices:write' }));

function serializeRange(row) {
  const hosts = hostCount(row.cidr);
  return {
    id: row.id,
    name: row.name,
    cidr: row.cidr,
    enabled: !!row.enabled,
    intervalHours: row.interval_hours,
    notes: row.notes || '',
    hosts,
    lastScanAt: row.last_scan_at,
    lastScanStatus: row.last_scan_status,
    lastScanMessage: row.last_scan_message || '',
    lastFoundCount: row.last_found_count || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.get('/ranges', (_req, res) => {
  const settings = getSettings();
  res.json({
    items: db.prepare('SELECT * FROM discovery_ranges ORDER BY name').all().map(serializeRange),
    limits: {
      maxRanges: MAX_RANGES,
      maxHosts: Math.min(HARD_MAX_HOSTS, Number(settings.discovery_max_hosts) || 256),
      allowedCidrs: normalizeCidrList(resolveProbeCidrs(settings)) || [],
      retainHours: Number(settings.discovery_retain_hours) || 24,
      intervalHours: Number(settings.discovery_interval_hours) || 24,
    },
    discovery: { enabled: !!settings.discovery_enabled, scan: discoveryStatus() },
  });
});

router.post('/ranges', (req, res) => {
  let payload;
  try {
    payload = validateRangeInput(req.body || {});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (db.prepare('SELECT id FROM discovery_ranges WHERE cidr = ?').get(payload.cidr)) {
    return res.status(409).json({ error: 'این محدوده قبلاً تعریف شده است.' });
  }
  const now = Date.now();
  const r = db
    .prepare(
      `INSERT INTO discovery_ranges(name, cidr, enabled, interval_hours, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(payload.name, payload.cidr, payload.enabled, payload.interval_hours, payload.notes, now, now);
  return res.status(201).json(serializeRange(db.prepare('SELECT * FROM discovery_ranges WHERE id=?').get(Number(r.lastInsertRowid))));
});

router.put('/ranges/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM discovery_ranges WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'محدوده یافت نشد' });
  const body = req.body || {};
  let payload;
  try {
    const count = db.prepare('SELECT COUNT(*) AS c FROM discovery_ranges WHERE id != ?').get(id).c;
    if (count >= MAX_RANGES) throw new Error(`حداکثر ${MAX_RANGES} محدوده قابل تعریف است.`);
    payload = validateRangeInput({ ...existing, ...body, name: body.name ?? existing.name, cidr: body.cidr ?? existing.cidr }, { settings: getSettings() });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const dup = db.prepare('SELECT id FROM discovery_ranges WHERE cidr = ? AND id != ?').get(payload.cidr, id);
  if (dup) return res.status(409).json({ error: 'محدودهٔ دیگری با همین CIDR وجود دارد.' });
  db.prepare(
    'UPDATE discovery_ranges SET name=?, cidr=?, enabled=?, interval_hours=?, notes=?, updated_at=? WHERE id=?'
  ).run(payload.name, payload.cidr, payload.enabled, payload.interval_hours, payload.notes, Date.now(), id);
  return res.json(serializeRange(db.prepare('SELECT * FROM discovery_ranges WHERE id=?').get(id)));
});

router.delete('/ranges/:id', (req, res) => {
  const id = Number(req.params.id);
  const n = db.prepare('DELETE FROM discovery_ranges WHERE id=?').run(id).changes;
  if (!n) return res.status(404).json({ error: 'محدوده یافت نشد' });
  return res.json({ deleted: n });
});

/** اجرای اسکن فوری؛ پاسخ پیش از پایان اسکن برمی‌گردد و وضعیت از /status خوانده می‌شود. */
router.post('/scan', requirePermission('probe:run'), (req, res) => {
  if (discoveryStatus().running) {
    return res.status(409).json({ error: 'یک اسکن در حال اجراست؛ پس از پایان آن دوباره تلاش کنید.' });
  }
  const ids = Array.isArray(req.body?.rangeIds) ? req.body.rangeIds.map(Number).filter(Boolean) : null;
  if (ids && ids.length) {
    const enabled = db
      .prepare(`SELECT COUNT(*) AS c FROM discovery_ranges WHERE enabled = 1 AND id IN (${ids.map(() => '?').join(',')})`)
      .get(...ids).c;
    if (!enabled) return res.status(400).json({ error: 'هیچ محدودهٔ فعالی انتخاب نشده است.' });
  }
  // اسکن در پس‌زمینه اجرا می‌شود؛ خطاها در وضعیت/لاگ ثبت می‌شوند.
  runDiscoveryScan({ rangeIds: ids, trigger: 'manual', actor: req.user?.username || '' }).catch(() => {});
  return res.status(202).json({ started: true, status: discoveryStatus() });
});

router.get('/status', (_req, res) => {
  res.json({ scan: discoveryStatus(), pending: db.prepare("SELECT COUNT(*) AS c FROM discovery_results WHERE status='new' AND expires_at > ?").get(Date.now()).c });
});

/** فهرست تجهیزات کشف‌شده (پیش‌فرض: فقط ردیف‌های تازه و منقضی‌نشده) */
router.get('/results', (req, res) => {
  const now = Date.now();
  pruneExpired(now);
  const status = String(req.query.status || 'new');
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const rows = db
    .prepare(
      `SELECT r.*, d.name AS range_name FROM discovery_results r
       LEFT JOIN discovery_ranges d ON d.id = r.range_id
       WHERE r.status = ? AND r.expires_at > ? ORDER BY r.discovered_at DESC LIMIT ? OFFSET ?`
    )
    .all(status, now, limit, offset);
  const total = db.prepare('SELECT COUNT(*) AS c FROM discovery_results WHERE status = ? AND expires_at > ?').get(status, now).c;
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      rangeId: r.range_id,
      rangeName: r.range_name || '',
      ip: r.ip,
      hostname: r.hostname || '',
      openPorts: (() => {
        try {
          const parsed = JSON.parse(r.open_ports || '[]');
          return Array.isArray(parsed) ? parsed.slice(0, 8) : [];
        } catch {
          return [];
        }
      })(),
      discoveredAt: r.discovered_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at,
      isNew: now - r.discovered_at < (Number(getSettings().discovery_retain_hours) || 24) * 3600 * 1000,
      importedDeviceId: r.imported_device_id,
    })),
    total,
    limit,
    offset,
    now,
  });
});

router.post('/results/:id/import', (req, res) => {
  try {
    const result = importDiscoveryResult(req.params.id, { name: req.body?.name, actor: req.user?.username || '' });
    return res.status(201).json(result);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
});

router.delete('/results/:id', (req, res) => {
  const n = dismissDiscoveryResult(req.params.id);
  if (!n) return res.status(404).json({ error: 'نتیجهٔ کشف یافت نشد' });
  return res.json({ deleted: n });
});

/** حذف دستی نتایج منقضی (تجهیزات ثبت‌شده هرگز لمس نمی‌شوند) */
router.post('/prune', (req, res) => {
  res.json({ removed: pruneExpired(Date.now()) });
});

export default router;
