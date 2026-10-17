/**
 * NetWatch — لایه دسترسی مشترک به داده‌ها برای API
 */
import { db, STATUS, getSettings } from './db.js';
import { isValidIp } from './ping.js';

export const DEVICE_SORTS = {
  name: 'd.name',
  ip: 'd.ip',
  status: "CASE d.status WHEN 'offline' THEN 0 WHEN 'warning' THEN 1 WHEN 'maintenance' THEN 2 WHEN 'online' THEN 3 ELSE 4 END",
  group: 'g.name',
  latency: 'd.last_rtt_ms',
  avg_latency: 'd.avg_rtt_ms',
  loss: 'd.loss_pct',
  uptime: 'd.uptime_pct',
  last_check: 'd.last_check_at',
  outages: '(SELECT COUNT(*) FROM outages o WHERE o.device_id = d.id)',
  created: 'd.created_at',
};

export function parseListQuery(q = {}) {
  const page = Math.max(1, parseInt(q.page || '1', 10) || 1);
  const pageSize = Math.min(500, Math.max(1, parseInt(q.pageSize || '24', 10) || 24));
  return {
    page,
    pageSize,
    search: (q.search || '').trim(),
    group: q.group ? String(q.group) : '',
    tag: q.tag ? String(q.tag) : '',
    status: q.status ? String(q.status) : '',
    type: q.type ? String(q.type) : '',
    priority: q.priority ? String(q.priority) : '',
    location: q.location ? String(q.location) : '',
    enabled: q.enabled === undefined || q.enabled === '' ? '' : String(q.enabled),
    geo: q.geo || '',
    sort: DEVICE_SORTS[q.sort] ? q.sort : 'name',
    order: String(q.order || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC',
  };
}

export function buildDeviceWhere(f, { forceEnabled = null } = {}) {
  const where = [];
  const params = [];
  if (forceEnabled !== null) {
    where.push('d.enabled = ?');
    params.push(forceEnabled);
  } else if (f.enabled !== '') {
    where.push('d.enabled = ?');
    params.push(Number(f.enabled) ? 1 : 0);
  }
  if (f.search) {
    where.push('(d.name LIKE ? OR d.ip LIKE ? OR d.hostname LIKE ? OR d.location LIKE ? OR d.vendor LIKE ? OR d.model LIKE ? OR CAST(d.id AS TEXT) = ?)');
    const s = `%${f.search}%`;
    params.push(s, s, s, s, s, s, f.search);
  }
  if (f.group) {
    where.push('(d.group_id = ? OR g.name = ?)');
    params.push(Number(f.group) || -1, f.group);
  }
  if (f.status === 'high_latency') {
    // «پینگ بالا»: تأخیر آخرین بررسی از آستانهٔ همان تجهیز (یا آستانهٔ عمومی) بیشتر است
    where.push('d.last_rtt_ms IS NOT NULL AND d.last_rtt_ms > COALESCE(d.latency_threshold, ?)');
    params.push(getSettings().latency_threshold);
  } else if (f.status === 'online') {
    // تجهیزات دارای اختلال هم «وصل» هستند؛ فیلتر وصل باید همان چیزی را نشان دهد
    // که داشبورد در کارت «وصل» می‌شمارد (online + warning).
    where.push("d.status IN ('online','warning')");
  } else if (f.status) {
    where.push('d.status = ?');
    params.push(f.status);
  }
  if (f.type) {
    where.push('d.device_type = ?');
    params.push(f.type);
  }
  if (f.priority) {
    where.push('d.priority = ?');
    params.push(f.priority);
  }
  if (f.location) {
    where.push('d.location = ?');
    params.push(f.location);
  }
  if (f.tag) {
    where.push('EXISTS (SELECT 1 FROM device_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.device_id = d.id AND (t.id = ? OR t.name = ?))');
    params.push(Number(f.tag) || -1, f.tag);
  }
  if (f.geo === 'with') where.push('d.latitude IS NOT NULL AND d.longitude IS NOT NULL');
  if (f.geo === 'without') where.push('(d.latitude IS NULL OR d.longitude IS NULL)');
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function tagsFor(deviceIds) {
  if (!deviceIds.length) return new Map();
  const ph = deviceIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT dt.device_id, t.id, t.name, t.color, t.show_on_map FROM device_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.device_id IN (${ph})`)
    .all(...deviceIds);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.device_id)) map.set(r.device_id, []);
    map.get(r.device_id).push({ id: r.id, name: r.name, color: r.color, showOnMap: !!r.show_on_map });
  }
  return map;
}

export function serializeDevice(row, tags = [], groupName = null) {
  const total = (row.success_count || 0) + (row.fail_count || 0);
  return {
    id: row.id,
    name: row.name,
    ip: row.ip,
    hostname: row.hostname || '',
    deviceType: row.device_type,
    groupId: row.group_id,
    groupName: groupName ?? row.group_name ?? null,
    groupColor: row.group_color ?? null,
    location: row.location || '',
    building: row.building || '',
    rack: row.rack || '',
    latitude: row.latitude,
    longitude: row.longitude,
    mapLayerId: row.map_layer_id,
    vendor: row.vendor || '',
    model: row.model || '',
    serial: row.serial || '',
    firmware: row.firmware || '',
    owner: row.owner || '',
    notes: row.notes || '',
    priority: row.priority,
    enabled: !!row.enabled,
    monitoringEnabled: !!row.monitoring_enabled,
    pingInterval: row.ping_interval,
    timeoutMs: row.timeout_ms,
    packetCount: row.packet_count,
    retries: row.retries,
    latencyThreshold: row.latency_threshold,
    lossThreshold: row.loss_threshold,
    status: row.status,
    statusReason: row.status_reason || '',
    lastCheckAt: row.last_check_at,
    lastStatusChangeAt: row.last_status_change_at,
    lastRtt: row.last_rtt_ms,
    minRtt: row.min_rtt_ms,
    maxRtt: row.max_rtt_ms,
    avgRtt: row.avg_rtt_ms,
    lossPct: row.loss_pct ?? 0,
    successCount: row.success_count || 0,
    failCount: row.fail_count || 0,
    totalChecks: row.total_checks || 0,
    consecutiveFailures: row.consecutive_failures || 0,
    consecutiveSuccesses: row.consecutive_successes || 0,
    uptimePct: row.uptime_pct,
    lastOutageAt: row.last_outage_at,
    currentOutageId: row.current_outage_id,
    currentOutageStartedAt: row.current_outage_started_at,
    lastRecoveryAt: row.last_recovery_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    outageCount: row.outage_count ?? undefined,
    tags,
  };
}

export function listDevices(filters, { withCounts = true } = {}) {
  const { clause, params } = buildDeviceWhere(filters);
  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM devices d LEFT JOIN groups g ON g.id = d.group_id ${clause}`)
    .get(...params).c;
  const orderCol = DEVICE_SORTS[filters.sort] || 'd.name';
  const offset = (filters.page - 1) * filters.pageSize;
  const rows = db
    .prepare(
      `SELECT d.*, g.name AS group_name, g.color AS group_color,
              (SELECT COUNT(*) FROM outages o WHERE o.device_id = d.id) AS outage_count
       FROM devices d LEFT JOIN groups g ON g.id = d.group_id
       ${clause} ORDER BY ${orderCol} ${filters.order}, d.id ASC LIMIT ? OFFSET ?`
    )
    .all(...params, filters.pageSize, offset);
  const tagMap = tagsFor(rows.map((r) => r.id));
  return {
    items: rows.map((r) => serializeDevice(r, tagMap.get(r.id) || [])),
    total,
    page: filters.page,
    pageSize: filters.pageSize,
    pages: Math.max(1, Math.ceil(total / filters.pageSize)),
    withCounts,
  };
}

export function getDevice(id, { withTags = true } = {}) {
  const row = db
    .prepare(
      `SELECT d.*, g.name AS group_name, g.color AS group_color,
              (SELECT COUNT(*) FROM outages o WHERE o.device_id = d.id) AS outage_count
       FROM devices d LEFT JOIN groups g ON g.id = d.group_id WHERE d.id = ?`
    )
    .get(Number(id));
  if (!row) return null;
  const tags = withTags ? tagsFor([row.id]).get(row.id) || [] : [];
  return serializeDevice(row, tags);
}

export function groupByName(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  let row = db.prepare('SELECT * FROM groups WHERE name = ?').get(n);
  if (row) return row;
  const res = db.prepare('INSERT INTO groups(name, description, color, created_at) VALUES (?,?,?,?)').run(n, '', '#3b82f6', Date.now());
  return db.prepare('SELECT * FROM groups WHERE id = ?').get(Number(res.lastInsertRowid));
}

const TAG_COLORS = ['#2563eb', '#0ea5e9', '#f59e0b', '#16a34a', '#dc2626', '#7c3aed', '#0d9488', '#db2777'];
export function attachTags(deviceId, names = [], { replace = false } = {}) {
  if (replace) db.prepare('DELETE FROM device_tags WHERE device_id = ?').run(deviceId);
  for (const raw of names) {
    const name = String(raw || '').trim();
    if (!name) continue;
    let tag = db.prepare('SELECT * FROM tags WHERE name = ?').get(name);
    if (!tag) {
      const color = TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)];
      const res = db.prepare('INSERT INTO tags(name, color, show_on_map, icon, created_at) VALUES (?,?,?,?,?)').run(name, color, 1, 'tag', Date.now());
      tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(Number(res.lastInsertRowid));
    }
    db.prepare('INSERT OR IGNORE INTO device_tags(device_id, tag_id) VALUES (?,?)').run(deviceId, tag.id);
  }
}

export function setDeviceTags(deviceId, tagIds = []) {
  db.prepare('DELETE FROM device_tags WHERE device_id = ?').run(deviceId);
  for (const t of tagIds) {
    db.prepare('INSERT OR IGNORE INTO device_tags(device_id, tag_id) VALUES (?,?)').run(deviceId, Number(t));
  }
}

const INSERT_FIELDS = [
  'name', 'ip', 'hostname', 'device_type', 'group_id', 'location', 'building', 'rack', 'latitude', 'longitude',
  'map_layer_id', 'vendor', 'model', 'serial', 'firmware', 'owner', 'notes', 'priority', 'enabled',
  'monitoring_enabled', 'ping_interval', 'timeout_ms', 'packet_count', 'retries', 'latency_threshold', 'loss_threshold',
];

/* ------------------------------------------------------------------ */
/* اعتبارسنجی ورودی تجهیز                                              */
/* ------------------------------------------------------------------ */

/*
 * مقادیر پایشی از بدنهٔ درخواست می‌آیند و مستقیماً در زمان‌بندی/اجرای Ping اثر
 * می‌گذارند: بازهٔ صفر یا منفی موتور را به حلقهٔ بی‌وقفه می‌کشاند، تعداد بستهٔ
 * بزرگ فرمان ping را دقیقه‌ها زنده نگه می‌دارد و زمان انتظار نامحدود چرخه‌ها را
 * روی هم انباشته می‌کند. پس همان‌جا که داده نوشته می‌شود، مرزگذاری می‌شود.
 */
const STRING_LIMITS = {
  name: 120,
  ip: 45,
  hostname: 255,
  device_type: 60,
  group: 120,
  location: 120,
  building: 120,
  rack: 60,
  vendor: 80,
  model: 80,
  serial: 80,
  firmware: 60,
  owner: 80,
  notes: 2000,
};

const NUM_LIMITS = {
  ping_interval: { min: 5, max: 86400, label: 'بازه بررسی (ثانیه)' },
  timeout_ms: { min: 100, max: 30000, label: 'زمان انتظار (میلی‌ثانیه)' },
  packet_count: { min: 1, max: 10, label: 'تعداد بسته' },
  retries: { min: 0, max: 5, label: 'تعداد تلاش مجدد' },
  latency_threshold: { min: 0, max: 60000, label: 'آستانه تأخیر' },
  loss_threshold: { min: 0, max: 100, label: 'آستانه افت بسته' },
  latitude: { min: -90, max: 90, label: 'عرض جغرافیایی' },
  longitude: { min: -180, max: 180, label: 'طول جغرافیایی' },
};

const INT_FIELDS = new Set(['packet_count', 'retries']);
const PRIORITIES = ['low', 'normal', 'high', 'critical'];
const STATUSES = [STATUS.ONLINE, STATUS.OFFLINE, STATUS.WARNING, STATUS.UNKNOWN, STATUS.MAINTENANCE];
const PASSTHROUGH = new Set(['tags', 'tagNames', 'group']);
const ALLOWED_INPUT = new Set([...INSERT_FIELDS, ...PASSTHROUGH, 'status']);

/**
 * ورودی تجهیز را نرمال و مرزگذاری می‌کند.
 * @param {object} input بدنهٔ درخواست
 * @param {{partial?: boolean}} options در حالت partial فقط فیلدهای ارسالی بررسی می‌شوند
 * @returns {object} payload پاک‌شده
 */
export function sanitizeDeviceInput(input = {}, { partial = false } = {}) {
  const out = {};
  for (const [key, raw] of Object.entries(input ?? {})) {
    if (!ALLOWED_INPUT.has(key)) continue;
    if (key in STRING_LIMITS) {
      out[key] = raw == null ? '' : String(raw).trim().slice(0, STRING_LIMITS[key]);
      continue;
    }
    if (key in NUM_LIMITS) {
      const { min, max, label } = NUM_LIMITS[key];
      if (raw === null || raw === '') {
        out[key] = null; // خالی = استفاده از مقدار عمومی
        continue;
      }
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n) || n < min || n > max) {
        throw new Error(`مقدار «${label}» نامعتبر است (بازهٔ مجاز: ${min} تا ${max}).`);
      }
      out[key] = INT_FIELDS.has(key) ? Math.round(n) : n;
      continue;
    }
    if (key === 'group_id' || key === 'map_layer_id') {
      const n = Number(raw);
      out[key] = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
      continue;
    }
    if (key === 'priority') {
      out[key] = PRIORITIES.includes(String(raw)) ? String(raw) : 'normal';
      continue;
    }
    if (key === 'status') {
      out[key] = STATUSES.includes(String(raw)) ? String(raw) : STATUS.UNKNOWN;
      continue;
    }
    if (key === 'enabled' || key === 'monitoring_enabled') {
      out[key] = raw === true || raw === 1 || raw === '1' || raw === 'true' ? 1 : 0;
      continue;
    }
    out[key] = raw;
  }
  if (!partial) {
    if (!out.name) throw new Error('نام تجهیز الزامی است');
    if (!isValidIp(out.ip)) throw new Error(`آدرس IP نامعتبر است: ${out.ip ?? ''}`);
  }
  return out;
}

export function createDevice(input, { source = 'manual' } = {}) {
  const now = Date.now();
  const payload = sanitizeDeviceInput(input, { partial: false });
  const dup = db.prepare('SELECT id, name FROM devices WHERE ip = ?').get(payload.ip);
  if (dup) throw new Error(`آدرس IP تکراری است — در اختیار تجهیز «${dup.name}»`);

  if (payload.group && !payload.group_id) {
    const g = groupByName(payload.group);
    payload.group_id = g ? g.id : null;
  }
  const cols = [];
  const vals = [];
  for (const f of INSERT_FIELDS) {
    if (payload[f] !== undefined) {
      cols.push(f);
      vals.push(payload[f]);
    }
  }
  cols.push('created_at', 'updated_at', 'status');
  vals.push(now, now, payload.status || STATUS.UNKNOWN);
  // تجهیز تازه باید در اولین چرخهٔ موتور بررسی شود (۰ = سررسید در همان لحظه)
  cols.push('next_check_at');
  vals.push(0);
  const res = db.prepare(`INSERT INTO devices(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
  const id = Number(res.lastInsertRowid);
  if (Array.isArray(payload.tags)) attachTags(id, payload.tags, { replace: true });
  if (Array.isArray(payload.tagNames)) attachTags(id, payload.tagNames, { replace: true });
  db.prepare('INSERT INTO engine_log(ts, level, message) VALUES (?,?,?)').run(now, 'info', `تجهیز «${payload.name}» (${payload.ip}) افزوده شد — منبع: ${source}`);
  return getDevice(id);
}

const UPDATE_FIELDS = [...INSERT_FIELDS];

export function updateDevice(id, input) {
  const deviceId = Number(id);
  const existing = getDevice(deviceId, { withTags: false });
  if (!existing) return null;
  const patch = sanitizeDeviceInput(input, { partial: true });
  if (patch.name !== undefined && !patch.name) throw new Error('نام تجهیز الزامی است');
  if (patch.ip !== undefined) {
    if (!isValidIp(patch.ip)) throw new Error(`آدرس IP نامعتبر است: ${patch.ip}`);
    const dup = db.prepare('SELECT id, name FROM devices WHERE ip = ? AND id != ?').get(patch.ip, deviceId);
    if (dup) throw new Error(`آدرس IP تکراری است — در اختیار تجهیز «${dup.name}»`);
  }
  if (patch.group !== undefined && !patch.group_id) {
    const g = patch.group ? groupByName(patch.group) : null;
    patch.group_id = g ? g.id : null;
  }
  const sets = [];
  const vals = [];
  for (const f of UPDATE_FIELDS) {
    if (patch[f] !== undefined) {
      sets.push(`${f} = ?`);
      vals.push(patch[f]);
    }
  }
  if (sets.length) {
    sets.push('updated_at = ?');
    vals.push(Date.now(), deviceId);
    db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  if (Array.isArray(patch.tags)) setDeviceTags(deviceId, patch.tags.filter((t) => /^\d+$/.test(String(t))));
  if (Array.isArray(patch.tagNames)) attachTags(deviceId, patch.tagNames, { replace: true });
  return getDevice(deviceId);
}

export function deleteDevices(ids) {
  const stmt = db.prepare('DELETE FROM devices WHERE id = ?');
  let n = 0;
  for (const id of ids) n += stmt.run(Number(id)).changes;
  return n;
}

export function deviceStatsSnapshot() {
  const rows = db.prepare('SELECT status, COUNT(*) AS c FROM devices WHERE enabled = 1 GROUP BY status').all();
  const out = { total: 0, online: 0, offline: 0, warning: 0, unknown: 0, maintenance: 0, disabled: 0, monitoring: 0 };
  for (const r of rows) {
    out[r.status] = r.c;
    out.total += r.c;
  }
  out.disabled = db.prepare('SELECT COUNT(*) AS c FROM devices WHERE enabled = 0').get().c;
  out.monitoring = db.prepare('SELECT COUNT(*) AS c FROM devices WHERE enabled = 1 AND monitoring_enabled = 1').get().c;
  return out;
}

export function parseTagFilter(value) {
  return String(value || '').trim();
}
