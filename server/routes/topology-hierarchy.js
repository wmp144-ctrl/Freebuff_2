/**
 * NetWatch — API سلسله‌مراتب پایدار توپولوژی
 * ----------------------------------------------------------------
 * موجودیت‌ها در سه سطح نگهداری می‌شوند:
 *
 *   شهر ─┬─ مرکز تجمع ─┬─ تجهیز
 *        └─ ایستگاه    └─ تجهیز
 *
 * قاعده‌های اصلی:
 *   • والد هر گره از نوعش تعیین می‌شود: شهر بدون والد، مرکز/ایستگاه زیر شهر،
 *     تجهیز زیر مرکز یا ایستگاه. جابه‌جایی والد مجاز است اما نوع گره پس از
 *     ایجاد تغییر نمی‌کند تا سلسله‌مراتب بی‌معنا نشود.
 *   • مالکیت سازمانی روی گره است (owner_group_id → groups)؛ لینک‌ها فقط
 *     ویژگی‌های فیزیکی/منطقی ارتباط را نگه می‌دارند و از مالکیت جدا هستند.
 *   • اتصال شهر↔شهر (بین‌شهری)، شهر↔مرکز/ایستگاه (دسترسی) و اتصال درون یک
 *     شهر (مرکز/ایستگاه/تجهیز) مجاز است؛ اتصال مستقیم شهر به تجهیز و اتصال
 *     دو گره از شهرهای مختلف (غیر از خود شهرها) رد می‌شود.
 *   • به‌روزرسانی جزئی است: فقط فیلدهای ارسال‌شده تغییر می‌کنند و موقعیت،
 *     فراداده و فیلدهای محافظت‌شده (شناسه/نوع/مالکیت داده) دست‌نخورده می‌مانند.
 *   • دادهٔ نمونه فقط با پرچم صریح توسعه و روی پایگاه‌دادهٔ خالی بارگذاری
 *     می‌شود؛ ردیف‌ها `origin='demo'` می‌گیرند و هیچ‌گاه با دادهٔ واقعی
 *     مخلوط نمی‌شوند.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { db, transaction } from '../db.js';
import { routePermission } from '../permissions.js';
import { isValidHost, isValidIp } from '../ping.js';
import { config } from '../config.js';

const router = express.Router();

// خواندن با topology:read و هر تغییر با topology:write (Viewer فقط می‌خواند).
router.use(routePermission({ read: 'topology:read', write: 'topology:write' }));

const NODE_KINDS = new Set([
  'city',
  'aggregation',
  'station',
  'router',
  'switch',
  'firewall',
  'access-point',
  'server',
  'other',
]);
const SITE_KINDS = new Set(['aggregation', 'station']);
const STATUSES = new Set(['online', 'offline', 'warning', 'unknown', 'maintenance']);
const MEDIA = new Set(['fiber', 'wireless', 'ethernet', 'vpn']);
const ROLES = new Set(['primary', 'backup']);
const STATES = new Set(['up', 'down', 'degraded', 'unknown']);
const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const MAX_NODES = 4000;
const MAX_CONNECTIONS = 8000;
const MAX_COORD = 100000;
const MAX_CAPACITY_MBPS = 1000000;

// دادهٔ نمونه فقط در سرور توسعه یا با پرچم صریح آزمون/نمایش فعال است.
const DEMO_ENABLED = config.dev || process.env.NETWATCH_DEMO_SEED === '1';

/* ------------------------------------------------------------------ */
/* کمک‌تابع‌ها                                                          */
/* ------------------------------------------------------------------ */

class HierarchyError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function handle(res, fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HierarchyError) return res.status(e.status).json({ error: e.message, ...e.extra });
    throw e;
  }
}

const text = (v, max) => String(v ?? '').trim().slice(0, max);
const intOrNull = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function coord(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_COORD, Math.max(-MAX_COORD, Math.round(n * 100) / 100));
}

function jsonText(value, maxChars = 4000) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '{}';
  try {
    const raw = JSON.stringify(value);
    return raw.length <= maxChars ? raw : '{}';
  } catch {
    return '{}';
  }
}

function parseJson(raw, fallback) {
  try {
    const value = JSON.parse(raw || '');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

const kindRank = (kind) => (kind === 'city' ? 0 : SITE_KINDS.has(kind) ? 1 : 2);

/* ------------------------------------------------------------------ */
/* سریال‌سازی                                                          */
/* ------------------------------------------------------------------ */

function serializeNode(row) {
  return {
    id: row.id,
    kind: row.kind,
    parentId: row.parent_id ?? null,
    cityId: row.city_id ?? null,
    name: row.name,
    description: row.description || '',
    notes: row.notes || '',
    location: row.location || '',
    ownerGroupId: row.owner_group_id ?? null,
    ownerGroupName: row.owner_group_name ?? null,
    ownerGroupColor: row.owner_group_color ?? null,
    ip: row.ip || '',
    deviceType: row.device_type || '',
    vendor: row.vendor || '',
    model: row.model || '',
    ports: row.ports ?? null,
    status: row.status || 'unknown',
    x: Number(row.x) || 0,
    y: Number(row.y) || 0,
    meta: parseJson(row.meta, {}),
    origin: row.origin === 'demo' ? 'demo' : 'user',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeConnection(row) {
  return {
    id: row.id,
    source: row.source_id,
    target: row.target_id,
    medium: row.medium,
    capacityMbps: row.capacity_mbps == null ? null : Number(row.capacity_mbps),
    latencyMs: row.latency_ms == null ? null : Number(row.latency_ms),
    sourcePort: row.source_port || '',
    targetPort: row.target_port || '',
    role: row.role === 'backup' ? 'backup' : 'primary',
    label: row.label || '',
    description: row.description || '',
    notes: row.notes || '',
    state: row.state || 'up',
    meta: parseJson(row.meta, {}),
    origin: row.origin === 'demo' ? 'demo' : 'user',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const NODE_SELECT = `SELECT n.*, g.name AS owner_group_name, g.color AS owner_group_color
  FROM topology_hierarchy_nodes n
  LEFT JOIN groups g ON g.id = n.owner_group_id`;

function listNodes() {
  return db
    .prepare(`${NODE_SELECT} ORDER BY CASE n.kind
        WHEN 'city' THEN 0 WHEN 'aggregation' THEN 1 WHEN 'station' THEN 2 ELSE 3 END,
        n.name COLLATE NOCASE`)
    .all()
    .map(serializeNode);
}

function getNode(id) {
  const row = db.prepare(`${NODE_SELECT} WHERE n.id = ?`).get(String(id));
  return row ? serializeNode(row) : null;
}

function requireNodeRow(id, label = 'گره') {
  const row = db.prepare('SELECT * FROM topology_hierarchy_nodes WHERE id = ?').get(String(id));
  if (!row) throw new HierarchyError(400, `${label} انتخاب‌شده وجود ندارد`);
  return row;
}

/** گره هدف عملیات (ویرایش/حذف) — نبودنش 404 است، نه خطای اعتبارسنجی. */
function requireExistingNode(id) {
  const row = db.prepare('SELECT * FROM topology_hierarchy_nodes WHERE id = ?').get(String(id));
  if (!row) throw new HierarchyError(404, 'گره یافت نشد');
  return row;
}

/**
 * اعداد نقطه‌ای مانند «999.1.1.1» از نظر فنی نام میزبان معتبرند، اما در این
 * فرم به‌معنای IP اشتباه تایپ‌شده‌اند و باید رد شوند.
 */
function isValidNodeHost(value) {
  if (!value) return true;
  if (/^\d+(\.\d+){3}$/.test(value) && !isValidIp(value)) return false;
  return isValidHost(value);
}

function listConnections() {
  return db
    .prepare('SELECT * FROM topology_hierarchy_connections ORDER BY created_at, id')
    .all()
    .map(serializeConnection);
}

function pairKeyOf(a, b, role) {
  return `${[String(a), String(b)].sort().join('|')}|${role}`;
}

/* ------------------------------------------------------------------ */
/* اعتبارسنجی گره                                                      */
/* ------------------------------------------------------------------ */

/**
 * فقط فیلدهای ارسالی خوانده می‌شوند. موقعیت (x/y) و فراداده (meta) از مسیر
 * جداگانه ذخیره می‌شوند تا ویرایش نام، چیدمان را بازنویسی نکند.
 */
function readNodeFields(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = text(body.name, 120);
    if (!name) throw new HierarchyError(400, 'نام گره الزامی است');
    out.name = name;
  }
  const strings = [
    ['description', 2000],
    ['notes', 4000],
    ['location', 160],
    ['deviceType', 60],
    ['vendor', 120],
    ['model', 120],
  ];
  for (const [key, max] of strings) {
    if (body[key] !== undefined) out[key] = text(body[key], max);
  }

  if (body.ip !== undefined) {
    const ip = text(body.ip, 45);
    if (!isValidNodeHost(ip)) throw new HierarchyError(400, 'آدرس IP یا نام میزبان معتبر نیست');
    out.ip = ip;
  }

  if (body.ownerGroupId !== undefined) {
    if (body.ownerGroupId === null || body.ownerGroupId === '') {
      out.ownerGroupId = null;
    } else {
      const groupId = intOrNull(body.ownerGroupId);
      if (!groupId) throw new HierarchyError(400, 'گروه مالک معتبر نیست');
      if (!db.prepare('SELECT id FROM groups WHERE id = ?').get(groupId)) {
        throw new HierarchyError(400, 'گروه مالک انتخاب‌شده وجود ندارد');
      }
      out.ownerGroupId = groupId;
    }
  }

  if (body.ports !== undefined) {
    if (body.ports === null || body.ports === '') {
      out.ports = null;
    } else {
      const ports = Number(body.ports);
      if (!Number.isInteger(ports) || ports < 0 || ports > 4096) {
        throw new HierarchyError(400, 'تعداد پورت باید عددی بین ۰ و ۴۰۹۶ باشد');
      }
      out.ports = ports;
    }
  }

  if (body.status !== undefined) {
    if (!STATUSES.has(String(body.status))) throw new HierarchyError(400, 'وضعیت گره معتبر نیست');
    out.status = String(body.status);
  }

  if (body.meta !== undefined) out.meta = jsonText(body.meta);

  return out;
}

/**
 * کنترل نسخهٔ خوش‌بینانه: اگر کلاینت `expectedUpdatedAt` بفرستد و رکورد در
 * این فاصله در جای دیگری تغییر کرده باشد، به‌جای بازنویسی خاموش، 409 برمی‌گردد
 * و نسخهٔ فعلی هم در پاسخ می‌آید تا کاربر بتواند تصمیم بگیرد.
 */
function assertNoConflict(row, expected, current) {
  if (expected === undefined || expected === null || expected === '') return;
  const value = Number(expected);
  if (!Number.isFinite(value) || value <= 0) {
    throw new HierarchyError(400, 'زمان ویرایش پایه معتبر نیست');
  }
  if (Number(row.updated_at) !== value) {
    throw new HierarchyError(
      409,
      'این رکورد در جای دیگری تغییر کرده است؛ نسخهٔ تازه بارگذاری شد، تغییرات خود را دوباره بررسی کنید.',
      { code: 'stale', current }
    );
  }
}

/** `parentId`/`cityId` را از روی نوع گره و والد واقعی تعیین می‌کند. */
function resolveParent(kind, parentId) {
  if (kind === 'city') {
    if (parentId !== undefined && parentId !== null && String(parentId).trim() !== '') {
      throw new HierarchyError(400, 'شهر نمی‌تواند والد داشته باشد');
    }
    return { parentId: null, cityId: null };
  }
  const id = text(parentId, 64);
  if (!id) throw new HierarchyError(400, 'والد گره الزامی است');
  const parent = requireNodeRow(id, 'والد');
  if (SITE_KINDS.has(kind)) {
    if (parent.kind !== 'city') throw new HierarchyError(400, 'مرکز تجمع یا ایستگاه فقط زیر یک شهر قرار می‌گیرد');
    return { parentId: parent.id, cityId: parent.id };
  }
  if (!SITE_KINDS.has(parent.kind)) {
    throw new HierarchyError(400, 'تجهیز فقط زیر مرکز تجمع یا ایستگاه قرار می‌گیرد');
  }
  return { parentId: parent.id, cityId: parent.city_id || parent.id };
}

function assertUniqueNodeName(name, parentId, excludeId = '') {
  const row = db
    .prepare(
      `SELECT id FROM topology_hierarchy_nodes
       WHERE name = ? COLLATE NOCASE AND IFNULL(parent_id, '') = ? AND id <> ?`
    )
    .get(name, parentId ?? '', excludeId);
  if (row) throw new HierarchyError(409, 'گره‌ای با این نام در همین شاخه وجود دارد');
}

const NODE_COLUMNS = [
  'id',
  'kind',
  'parent_id',
  'city_id',
  'name',
  'description',
  'notes',
  'location',
  'owner_group_id',
  'ip',
  'device_type',
  'vendor',
  'model',
  'ports',
  'status',
  'x',
  'y',
  'meta',
  'origin',
  'created_at',
  'updated_at',
];

/** درج گره با اعتبارسنجی کامل؛ برای CRUD و بارگذاری دادهٔ نمونه مشترک است. */
function insertNode(body, { origin = 'user' } = {}) {
  const kind = String(body.kind || '');
  if (!NODE_KINDS.has(kind)) throw new HierarchyError(400, 'نوع گره معتبر نیست');
  const id = text(body.id, 64) || randomUUID();
  if (!ID_RE.test(id)) throw new HierarchyError(400, 'شناسهٔ گره معتبر نیست');
  if (db.prepare('SELECT id FROM topology_hierarchy_nodes WHERE id = ?').get(id)) {
    throw new HierarchyError(409, 'گره‌ای با این شناسه از قبل ثبت شده است', { id });
  }
  if (db.prepare('SELECT COUNT(*) AS c FROM topology_hierarchy_nodes').get().c >= MAX_NODES) {
    throw new HierarchyError(413, `حداکثر ${MAX_NODES} گره مجاز است`);
  }

  const fields = readNodeFields(body);
  const { parentId, cityId } = resolveParent(kind, body.parentId);
  assertUniqueNodeName(fields.name, parentId);

  const now = Date.now();
  db.prepare(
    `INSERT INTO topology_hierarchy_nodes (${NODE_COLUMNS.join(',')})
     VALUES (${NODE_COLUMNS.map(() => '?').join(',')})`
  ).run(
    id,
    kind,
    parentId,
    kind === 'city' ? id : cityId,
    fields.name,
    fields.description ?? '',
    fields.notes ?? '',
    fields.location ?? '',
    fields.ownerGroupId ?? null,
    fields.ip ?? '',
    fields.deviceType ?? '',
    fields.vendor ?? '',
    fields.model ?? '',
    fields.ports ?? null,
    fields.status ?? 'unknown',
    coord(body.x, 0),
    coord(body.y, 0),
    fields.meta ?? '{}',
    origin === 'demo' ? 'demo' : 'user',
    now,
    now
  );
  return getNode(id);
}

function updateNode(id, body) {
  const node = requireExistingNode(id);
  assertNoConflict(node, body.expectedUpdatedAt, serializeNode(node));
  if (body.kind !== undefined && body.kind !== node.kind) {
    throw new HierarchyError(400, 'نوع گره پس از ایجاد تغییر نمی‌کند');
  }
  const fields = readNodeFields(body, { partial: true });

  let nextParent = node.parent_id;
  let nextCity = node.city_id;
  if (body.parentId !== undefined) {
    if (node.kind === 'city') throw new HierarchyError(400, 'شهر جابه‌جا نمی‌شود');
    const resolved = resolveParent(node.kind, body.parentId);
    nextParent = resolved.parentId;
    nextCity = resolved.cityId;
  }
  if (fields.name !== undefined) assertUniqueNodeName(fields.name, nextParent, node.id);

  const now = Date.now();
  const assignments = [];
  const values = [];
  const columns = {
    name: 'name',
    description: 'description',
    notes: 'notes',
    location: 'location',
    ownerGroupId: 'owner_group_id',
    ip: 'ip',
    deviceType: 'device_type',
    vendor: 'vendor',
    model: 'model',
    ports: 'ports',
    status: 'status',
    meta: 'meta',
  };
  for (const [key, column] of Object.entries(columns)) {
    if (fields[key] !== undefined) {
      assignments.push(`${column} = ?`);
      values.push(fields[key]);
    }
  }
  if (body.parentId !== undefined) {
    assignments.push('parent_id = ?', 'city_id = ?');
    values.push(nextParent, nextCity);
  }

  transaction(
    () => {
      if (assignments.length) {
        db.prepare(
          `UPDATE topology_hierarchy_nodes SET ${assignments.join(', ')}, updated_at = ? WHERE id = ?`
        ).run(...values, now, node.id);
      } else {
        // درخواست بدون تغییر: زمان ویرایش هم دست نمی‌خورد
        db.prepare('UPDATE topology_hierarchy_nodes SET updated_at = updated_at WHERE id = ?').run(node.id);
      }
      if (body.parentId !== undefined && nextCity !== node.city_id) {
        // همهٔ زیرمجموعه‌ها باید شهر تازه را بگیرند تا فیلتر/اتصال درست بماند
        db.prepare(
          `WITH RECURSIVE sub(id) AS (
             SELECT id FROM topology_hierarchy_nodes WHERE parent_id = ?
             UNION ALL
             SELECT n.id FROM topology_hierarchy_nodes n JOIN sub ON n.parent_id = sub.id
           )
           UPDATE topology_hierarchy_nodes SET city_id = ?, updated_at = ?
           WHERE id IN (SELECT id FROM sub)`
        ).run(node.id, nextCity, now);
      }
    },
    { label: 'topology.hierarchy.node.update' }
  );

  return getNode(node.id);
}

/* ------------------------------------------------------------------ */
/* اعتبارسنجی اتصال                                                    */
/* ------------------------------------------------------------------ */

function readConnectionFields(body, { partial = false } = {}) {
  const out = {};
  if (body.sourceId !== undefined) out.sourceId = text(body.sourceId, 64);
  if (body.targetId !== undefined) out.targetId = text(body.targetId, 64);
  if (!partial || body.medium !== undefined) {
    const medium = String(body.medium || '');
    if (!MEDIA.has(medium)) throw new HierarchyError(400, 'رسانهٔ انتقال معتبر نیست');
    out.medium = medium;
  }
  if (body.capacityMbps !== undefined) {
    if (body.capacityMbps === null || body.capacityMbps === '') {
      out.capacityMbps = null;
    } else {
      const value = Number(body.capacityMbps);
      if (!Number.isFinite(value) || value <= 0 || value > MAX_CAPACITY_MBPS) {
        throw new HierarchyError(400, 'ظرفیت لینک باید عددی مثبت و کمتر از ۱٬۰۰۰٬۰۰۰ مگابیت باشد');
      }
      out.capacityMbps = Math.round(value * 1000) / 1000;
    }
  }
  if (body.latencyMs !== undefined) {
    if (body.latencyMs === null || body.latencyMs === '') {
      out.latencyMs = null;
    } else {
      const value = Number(body.latencyMs);
      if (!Number.isFinite(value) || value < 0 || value > 100000) {
        throw new HierarchyError(400, 'تأخیر لینک معتبر نیست');
      }
      out.latencyMs = Math.round(value * 100) / 100;
    }
  }
  if (body.sourcePort !== undefined) out.sourcePort = text(body.sourcePort, 48);
  if (body.targetPort !== undefined) out.targetPort = text(body.targetPort, 48);
  if (body.role !== undefined) {
    if (!ROLES.has(String(body.role))) throw new HierarchyError(400, 'نقش لینک معتبر نیست');
    out.role = String(body.role);
  }
  if (body.label !== undefined) out.label = text(body.label, 160);
  if (body.description !== undefined) out.description = text(body.description, 2000);
  if (body.notes !== undefined) out.notes = text(body.notes, 4000);
  if (body.state !== undefined) {
    if (!STATES.has(String(body.state))) throw new HierarchyError(400, 'وضعیت لینک معتبر نیست');
    out.state = String(body.state);
  }
  if (body.meta !== undefined) out.meta = jsonText(body.meta);
  return out;
}

/** دو سر لینک باید وجود داشته باشند و از نظر سطح شبکه با هم بخوانند. */
function assertConnectable(a, b) {
  const aCity = a.kind === 'city';
  const bCity = b.kind === 'city';
  if (aCity && bCity) return;
  if (aCity || bCity) {
    const other = aCity ? b : a;
    if (!SITE_KINDS.has(other.kind)) {
      throw new HierarchyError(400, 'اتصال مستقیم شهر به تجهیز مجاز نیست؛ تجهیز را به مرکز یا ایستگاه وصل کنید');
    }
    return;
  }
  if ((a.city_id || a.id) !== (b.city_id || b.id)) {
    throw new HierarchyError(400, 'اتصال بین دو گره از شهرهای مختلف مجاز نیست');
  }
}

function resolveConnection(body, { existing = null } = {}) {
  const fields = readConnectionFields(body, { partial: Boolean(existing) });
  const sourceId = fields.sourceId ?? existing?.source_id;
  const targetId = fields.targetId ?? existing?.target_id;
  const fail = (message) => {
    throw new HierarchyError(400, message);
  };
  if (!sourceId || !targetId) fail('دو سر لینک الزامی است');
  if (sourceId === targetId) fail('لینک نمی‌تواند یک گره را به خودش وصل کند');
  const sourceNode = db.prepare('SELECT * FROM topology_hierarchy_nodes WHERE id = ?').get(String(sourceId));
  if (!sourceNode) fail('گره مبدأ وجود ندارد');
  const targetNode = db.prepare('SELECT * FROM topology_hierarchy_nodes WHERE id = ?').get(String(targetId));
  if (!targetNode) fail('گره مقصد وجود ندارد');
  assertConnectable(sourceNode, targetNode);

  const role = fields.role ?? existing?.role ?? 'primary';
  const pairKey = pairKeyOf(sourceId, targetId, role);
  const duplicate = db.prepare('SELECT id FROM topology_hierarchy_connections WHERE pair_key = ?').get(pairKey);
  if (duplicate && duplicate.id !== existing?.id) {
    throw new HierarchyError(409, 'بین این دو گره لینکی با همین نقش از قبل وجود دارد', { id: duplicate.id });
  }
  delete fields.sourceId;
  delete fields.targetId;
  delete fields.role;
  return { sourceId, targetId, role, pairKey, ...fields };
}

function insertConnection(body, { origin = 'user' } = {}) {
  const id = text(body.id, 64) || randomUUID();
  if (!ID_RE.test(id)) throw new HierarchyError(400, 'شناسهٔ لینک معتبر نیست');
  if (db.prepare('SELECT id FROM topology_hierarchy_connections WHERE id = ?').get(id)) {
    throw new HierarchyError(409, 'لینکی با این شناسه از قبل ثبت شده است', { id });
  }
  if (db.prepare('SELECT COUNT(*) AS c FROM topology_hierarchy_connections').get().c >= MAX_CONNECTIONS) {
    throw new HierarchyError(413, `حداکثر ${MAX_CONNECTIONS} لینک مجاز است`);
  }
  const record = resolveConnection(body);
  const now = Date.now();
  db.prepare(
    `INSERT INTO topology_hierarchy_connections (
       id, source_id, target_id, pair_key, medium, capacity_mbps, latency_ms,
       source_port, target_port, role, label, description, notes, state, meta,
       origin, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    record.sourceId,
    record.targetId,
    record.pairKey,
    record.medium,
    record.capacityMbps ?? null,
    record.latencyMs ?? null,
    record.sourcePort ?? '',
    record.targetPort ?? '',
    record.role,
    record.label ?? '',
    record.description ?? '',
    record.notes ?? '',
    record.state ?? 'up',
    record.meta ?? '{}',
    origin === 'demo' ? 'demo' : 'user',
    now,
    now
  );
  const row = db.prepare('SELECT * FROM topology_hierarchy_connections WHERE id = ?').get(id);
  return serializeConnection(row);
}

function updateConnection(id, body) {
  const existing = db.prepare('SELECT * FROM topology_hierarchy_connections WHERE id = ?').get(String(id));
  if (!existing) throw new HierarchyError(404, 'لینک یافت نشد');
  assertNoConflict(existing, body.expectedUpdatedAt, serializeConnection(existing));
  const record = resolveConnection(body, { existing });
  const now = Date.now();
  const assignments = ['source_id = ?', 'target_id = ?', 'pair_key = ?', 'role = ?'];
  const values = [record.sourceId, record.targetId, record.pairKey, record.role];
  const columns = {
    medium: 'medium',
    capacityMbps: 'capacity_mbps',
    latencyMs: 'latency_ms',
    sourcePort: 'source_port',
    targetPort: 'target_port',
    label: 'label',
    description: 'description',
    notes: 'notes',
    state: 'state',
    meta: 'meta',
  };
  for (const [key, column] of Object.entries(columns)) {
    if (record[key] !== undefined) {
      assignments.push(`${column} = ?`);
      values.push(record[key]);
    }
  }
  db.prepare(
    `UPDATE topology_hierarchy_connections SET ${assignments.join(', ')}, updated_at = ? WHERE id = ?`
  ).run(...values, now, existing.id);
  const row = db.prepare('SELECT * FROM topology_hierarchy_connections WHERE id = ?').get(existing.id);
  return serializeConnection(row);
}

/* ------------------------------------------------------------------ */
/* مسیرها                                                              */
/* ------------------------------------------------------------------ */

router.get('/', (_req, res) => {
  const nodes = listNodes();
  const connections = listConnections();
  const byKind = { city: 0, aggregation: 0, station: 0, device: 0 };
  const byStatus = { online: 0, offline: 0, warning: 0, unknown: 0, maintenance: 0 };
  const byMedium = { fiber: 0, wireless: 0, ethernet: 0, vpn: 0 };
  for (const node of nodes) {
    if (node.kind === 'city') byKind.city += 1;
    else if (SITE_KINDS.has(node.kind)) byKind[node.kind] += 1;
    else byKind.device += 1;
    byStatus[node.status in byStatus ? node.status : 'unknown'] += 1;
  }
  for (const connection of connections) {
    if (connection.medium in byMedium) byMedium[connection.medium] += 1;
  }
  const demo = nodes.some((n) => n.origin === 'demo') || connections.some((c) => c.origin === 'demo');

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    nodes,
    connections,
    groups: db.prepare('SELECT id, name, color FROM groups ORDER BY name COLLATE NOCASE').all(),
    stats: {
      nodes: nodes.length,
      connections: connections.length,
      ...byKind,
      byStatus,
      byMedium,
      demo,
    },
    demo,
    limits: { nodes: MAX_NODES, connections: MAX_CONNECTIONS },
    demoAvailable: DEMO_ENABLED,
    generatedAt: Date.now(),
  });
});

router.post('/nodes', (req, res) =>
  handle(res, () => {
    const node = insertNode(req.body || {});
    res.status(201).json(node);
  })
);

router.put('/nodes/:id', (req, res) =>
  handle(res, () => {
    const node = updateNode(req.params.id, req.body || {});
    res.json(node);
  })
);

router.delete('/nodes/:id', (req, res) =>
  handle(res, () => {
    const node = requireExistingNode(req.params.id);
    assertNoConflict(node, req.body?.expectedUpdatedAt, serializeNode(node));
    const subtree = db
      .prepare(
        `WITH RECURSIVE sub(id) AS (
           SELECT id FROM topology_hierarchy_nodes WHERE id = ?
           UNION ALL
           SELECT n.id FROM topology_hierarchy_nodes n JOIN sub ON n.parent_id = sub.id
         ) SELECT id FROM sub`
      )
      .all(node.id)
      .map((row) => row.id);
    const placeholders = subtree.map(() => '?').join(',');
    const connections = db
      .prepare(
        `SELECT COUNT(*) AS c FROM topology_hierarchy_connections
         WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`
      )
      .get(...subtree, ...subtree).c;

    db.prepare('DELETE FROM topology_hierarchy_nodes WHERE id = ?').run(node.id);
    res.json({ deleted: 1, nodes: subtree.length, connections });
  })
);

router.post('/connections', (req, res) =>
  handle(res, () => {
    const connection = insertConnection(req.body || {});
    res.status(201).json(connection);
  })
);

router.put('/connections/:id', (req, res) =>
  handle(res, () => {
    res.json(updateConnection(req.params.id, req.body || {}));
  })
);

router.delete('/connections/:id', (req, res) =>
  handle(res, () => {
    const existing = db
      .prepare('SELECT * FROM topology_hierarchy_connections WHERE id = ?')
      .get(String(req.params.id));
    if (!existing) throw new HierarchyError(404, 'لینک یافت نشد');
    assertNoConflict(existing, req.body?.expectedUpdatedAt, serializeConnection(existing));
    const result = db.prepare('DELETE FROM topology_hierarchy_connections WHERE id = ?').run(String(req.params.id));
    if (!result.changes) throw new HierarchyError(404, 'لینک یافت نشد');
    res.json({ deleted: result.changes });
  })
);

/** ذخیرهٔ گروهی موقعیت گره‌ها (کشیدن گره یا چیدمان مجدد) */
router.put('/layout', (req, res) =>
  handle(res, () => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) throw new HierarchyError(400, 'فهرست موقعیت‌ها خالی است');
    if (items.length > MAX_NODES) throw new HierarchyError(413, `حداکثر ${MAX_NODES} موقعیت در هر درخواست مجاز است`);

    const seen = new Set();
    const normalized = items.map((item) => {
      const id = text(item?.id, 64);
      if (!ID_RE.test(id)) throw new HierarchyError(400, 'شناسهٔ گره در موقعیت‌ها معتبر نیست');
      if (seen.has(id)) throw new HierarchyError(400, 'شناسهٔ تکراری در فهرست موقعیت‌ها');
      seen.add(id);
      const expected = item?.expectedUpdatedAt;
      return {
        id,
        x: coord(item?.x, 0),
        y: coord(item?.y, 0),
        expectedUpdatedAt:
          expected === undefined || expected === null || expected === '' ? null : Number(expected),
      };
    });

    const now = Date.now();
    const update = db.prepare('UPDATE topology_hierarchy_nodes SET x = ?, y = ?, updated_at = ? WHERE id = ?');
    transaction(
      () => {
        const conflicts = [];
        for (const item of normalized) {
          const row = db.prepare('SELECT * FROM topology_hierarchy_nodes WHERE id = ?').get(item.id);
          if (!row) throw new HierarchyError(400, 'یکی از گره‌های موقعیت‌دهی وجود ندارد', { id: item.id });
          // موقعیت گره اگر در جای دیگری تغییر کرده باشد، بی‌صدا بازنویسی نمی‌شود.
          if (item.expectedUpdatedAt !== null && Number(row.updated_at) !== item.expectedUpdatedAt) {
            conflicts.push({ id: item.id, current: serializeNode(row) });
          }
        }
        if (conflicts.length) {
          throw new HierarchyError(
            409,
            'موقعیت برخی گره‌ها در جای دیگری تغییر کرده است؛ برای جلوگیری از بازنویسی، ذخیره انجام نشد.',
            { code: 'stale', conflicts }
          );
        }
        for (const item of normalized) {
          if (!update.run(item.x, item.y, now, item.id).changes) {
            throw new HierarchyError(400, 'یکی از گره‌های موقعیت‌دهی وجود ندارد', { id: item.id });
          }
        }
      },
      { label: 'topology.hierarchy.layout' }
    );
    res.json({ updated: normalized.length });
  })
);

/**
 * بارگذاری دادهٔ نمونه — فقط توسعه و فقط روی پایگاه‌دادهٔ خالی.
 * `origin='demo'` روی همهٔ ردیف‌ها ثبت می‌شود تا در فهرست و رابط، دادهٔ
 * نمونه از دادهٔ واقعی جدا بماند.
 */
router.post('/demo-seed', (req, res) =>
  handle(res, () => {
    if (!DEMO_ENABLED) {
      throw new HierarchyError(403, 'بارگذاری دادهٔ نمونه فقط در حالت توسعه مجاز است');
    }
    if (db.prepare('SELECT COUNT(*) AS c FROM topology_hierarchy_nodes').get().c > 0) {
      throw new HierarchyError(409, 'دادهٔ توپولوژی از قبل وجود دارد؛ بارگذاری نمونه انجام نشد');
    }
    const rawNodes = Array.isArray(req.body?.nodes) ? req.body.nodes : [];
    const rawConnections = Array.isArray(req.body?.connections) ? req.body.connections : [];
    if (!rawNodes.length) throw new HierarchyError(400, 'فهرست گره‌های نمونه خالی است');
    if (rawNodes.length > MAX_NODES || rawConnections.length > MAX_CONNECTIONS) {
      throw new HierarchyError(413, 'حجم دادهٔ نمونه بیش از حد مجاز است');
    }

    const inserted = transaction(
      () => {
        const ordered = [...rawNodes].sort((a, b) => kindRank(a?.kind) - kindRank(b?.kind));
        let nodes = 0;
        for (const raw of ordered) {
          insertNode(raw || {}, { origin: 'demo' });
          nodes += 1;
        }
        let connections = 0;
        for (const raw of rawConnections) {
          insertConnection(raw || {}, { origin: 'demo' });
          connections += 1;
        }
        return { nodes, connections };
      },
      { label: 'topology.hierarchy.demo_seed' }
    );

    res.status(201).json({ inserted });
  })
);

export default router;
