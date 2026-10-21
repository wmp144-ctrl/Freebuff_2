/**
 * NetWatch — API دیاگرام ارتباطات شبکه (Topology)
 * ----------------------------------------------------------------
 * این ماژول مستقل از بقیهٔ سامانه نگهداری می‌شود، اما داده‌های تجهیزات و
 * وضعیت زندهٔ آن‌ها را از همان پایگاه‌داده/موتور می‌خواند. هیچ تصویر ثابتی
 * ذخیره نمی‌شود: گره‌ها و یال‌ها رکوردهای ساختاریافته با شناسهٔ یکتا هستند و
 * دیاگرام در مرورگر از همین داده‌ها ساخته می‌شود.
 *
 * قواعد مهم:
 *   • شناسهٔ گره/لینک یک UUID متنی است که کلاینت هم می‌تواند بسازد؛ در نتیجه
 *     ذخیرهٔ خودکار بدون نگاشت شناسهٔ موقت و بدون تکرار رکورد انجام می‌شود.
 *   • هر ذخیرهٔ گراف یک `revision` می‌فرستد. اگر نسخهٔ پایگاه‌داده جلوتر باشد،
 *     پاسخ ۴۰۹ است تا ویرایش دو تب، دادهٔ هم را بی‌صدا بازنویسی نکند.
 *   • دیاگرام قفل‌شده هیچ تغییری نمی‌پذیرد (۴۲۳) تا ویرایش ناخواسته رخ ندهد.
 *   • حذف تجهیز یا مرکز تجمع، گره را حذف نمی‌کند (ON DELETE SET NULL)؛ گره به
 *     «تجهیز/مرکز حذف‌شده» تبدیل می‌شود و ساختار دیاگرام حفظ می‌شود.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { db, transaction } from '../db.js';
import { routePermission } from '../permissions.js';

const router = express.Router();

// خواندن با topology:read و هر تغییر با topology:write (Viewer فقط می‌خواند).
router.use(routePermission({ read: 'topology:read', write: 'topology:write' }));

const HEX = /^#[0-9a-fA-F]{6}$/;
const NODE_ID = /^[a-zA-Z0-9_-]{8,64}$/;
const NODE_KINDS = new Set(['device', 'site', 'cloud', 'note', 'group']);
const LINK_KINDS = new Set(['ethernet', 'fiber', 'wireless', 'vpn', 'logical']);
const LINK_STYLES = new Set(['solid', 'dashed', 'dotted']);
const LAYOUTS = new Set(['hierarchy-tb', 'hierarchy-lr', 'grid', 'radial']);
const MAX_NODES = 4000;
const MAX_LINKS = 8000;
const MAX_NOTES = 4000;
const MAX_LABEL = 160;
const MAX_ID_BATCH = 400;

const text = (v, max) => String(v ?? '').trim().slice(0, max);
const num = (v, fallback, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};
const colorOf = (v) => (HEX.test(String(v ?? '')) ? String(v) : '');
const intOrNull = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function jsonText(value, maxChars = 2000) {
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

function chunks(list, size = MAX_ID_BATCH) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

class TopologyError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/* ------------------------------------------------------------------ */
/* مراکز تجمع                                                          */
/* ------------------------------------------------------------------ */

function serializeSite(row) {
  return {
    id: row.id,
    name: row.name,
    code: row.code || '',
    address: row.address || '',
    latitude: row.latitude,
    longitude: row.longitude,
    notes: row.notes || '',
    color: row.color || '#6366f1',
    deviceCount: row.device_count ?? 0,
    onlineCount: row.online_count ?? 0,
    offlineCount: row.offline_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listSites() {
  return db
    .prepare(
      `SELECT s.*,
        (SELECT COUNT(*) FROM topology_site_devices sd WHERE sd.site_id = s.id) AS device_count,
        (SELECT COUNT(*) FROM topology_site_devices sd JOIN devices dv ON dv.id = sd.device_id
          WHERE sd.site_id = s.id AND dv.status = 'online') AS online_count,
        (SELECT COUNT(*) FROM topology_site_devices sd JOIN devices dv ON dv.id = sd.device_id
          WHERE sd.site_id = s.id AND dv.status = 'offline') AS offline_count
       FROM topology_sites s ORDER BY s.name COLLATE NOCASE`
    )
    .all()
    .map(serializeSite);
}

function getSite(id) {
  // شمارش‌ها همیشه از همان مسیر فهرست می‌آیند تا پاسخ تک‌محیطی (GET/POST/PUT)
  // با فهرست یکی باشد و صفرِ نادرست برنگردد.
  return listSites().find((s) => s.id === Number(id)) || null;
}

function validateSiteBody(body = {}, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = text(body.name, 100);
    if (!name) throw new TopologyError(400, 'نام مرکز تجمع الزامی است');
    out.name = name;
  }
  if (body.code !== undefined) out.code = text(body.code, 40);
  if (body.address !== undefined) out.address = text(body.address, 240);
  if (body.notes !== undefined) out.notes = text(body.notes, MAX_NOTES);
  if (body.color !== undefined) out.color = colorOf(body.color) || '#6366f1';
  if (body.latitude !== undefined) {
    const v = Number(body.latitude);
    out.latitude = body.latitude === '' || body.latitude === null || !Number.isFinite(v) ? null : Math.min(90, Math.max(-90, v));
  }
  if (body.longitude !== undefined) {
    const v = Number(body.longitude);
    out.longitude = body.longitude === '' || body.longitude === null || !Number.isFinite(v) ? null : Math.min(180, Math.max(-180, v));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* دیاگرام‌ها                                                          */
/* ------------------------------------------------------------------ */

function serializeDiagram(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    layout: LAYOUTS.has(row.layout) ? row.layout : 'hierarchy-tb',
    locked: !!row.locked,
    isTemplate: !!row.is_template,
    revision: row.revision,
    viewport: parseJson(row.viewport, {}),
    settings: parseJson(row.settings, {}),
    createdBy: row.created_by || '',
    nodeCount: row.node_count ?? 0,
    linkCount: row.link_count ?? 0,
    deviceCount: row.device_count ?? 0,
    offlineCount: row.offline_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listDiagrams({ templates = false, search = '' } = {}) {
  const params = [templates ? 1 : 0];
  let clause = 'WHERE d.is_template = ?';
  if (search) {
    clause += ' AND (d.name LIKE ? OR d.description LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q);
  }
  return db
    .prepare(
      `SELECT d.*,
        (SELECT COUNT(*) FROM topology_nodes n WHERE n.diagram_id = d.id) AS node_count,
        (SELECT COUNT(*) FROM topology_links l WHERE l.diagram_id = d.id) AS link_count,
        (SELECT COUNT(*) FROM topology_nodes n WHERE n.diagram_id = d.id AND n.device_id IS NOT NULL) AS device_count,
        (SELECT COUNT(*) FROM topology_nodes n JOIN devices dv ON dv.id = n.device_id
          WHERE n.diagram_id = d.id AND dv.status = 'offline') AS offline_count
       FROM topology_diagrams d ${clause} ORDER BY d.updated_at DESC, d.id DESC`
    )
    .all(...params)
    .map(serializeDiagram);
}

function getDiagramRow(id) {
  return db.prepare('SELECT * FROM topology_diagrams WHERE id = ?').get(Number(id));
}

function requireDiagram(id) {
  const row = getDiagramRow(id);
  if (!row) throw new TopologyError(404, 'دیاگرام یافت نشد');
  return row;
}

function serializeNode(row) {
  const hasDevice = row.device_id != null && row.device_name != null;
  const hasSite = row.site_id != null && row.site_name != null;
  return {
    id: row.id,
    kind: NODE_KINDS.has(row.kind) ? row.kind : 'note',
    deviceId: row.device_id ?? null,
    siteId: row.site_id ?? null,
    label: row.label || '',
    notes: row.notes || '',
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    color: row.color || '',
    z: row.z,
    meta: parseJson(row.meta, {}),
    device: hasDevice
      ? {
          id: row.device_id,
          name: row.device_name,
          ip: row.device_ip || '',
          deviceType: row.device_type || '',
          status: row.device_status || 'unknown',
          lastRtt: row.last_rtt_ms,
          lossPct: row.loss_pct ?? 0,
          lastCheckAt: row.last_check_at,
          location: row.device_location || '',
          groupId: row.group_id ?? null,
          groupName: row.group_name || null,
          groupColor: row.group_color || null,
          priority: row.device_priority || 'normal',
        }
      : null,
    site: hasSite
      ? {
          id: row.site_id,
          name: row.site_name,
          code: row.site_code || '',
          color: row.site_color || '#6366f1',
          deviceCount: row.site_device_count ?? 0,
          onlineCount: row.site_online_count ?? 0,
        }
      : null,
  };
}

function serializeLink(row) {
  return {
    id: row.id,
    from: row.from_node_id,
    to: row.to_node_id,
    kind: LINK_KINDS.has(row.kind) ? row.kind : 'ethernet',
    label: row.label || '',
    notes: row.notes || '',
    color: row.color || '',
    style: LINK_STYLES.has(row.style) ? row.style : 'solid',
    meta: parseJson(row.meta, {}),
  };
}

function loadDiagram(id) {
  const row = getDiagramRow(id);
  if (!row) return null;
  const nodes = db
    .prepare(
      `SELECT n.*,
        dv.name AS device_name, dv.ip AS device_ip, dv.device_type, dv.status AS device_status,
        dv.last_rtt_ms, dv.loss_pct, dv.last_check_at, dv.location AS device_location,
        dv.group_id, dv.priority AS device_priority,
        g.name AS group_name, g.color AS group_color,
        s.name AS site_name, s.code AS site_code, s.color AS site_color,
        (SELECT COUNT(*) FROM topology_site_devices sd WHERE sd.site_id = n.site_id) AS site_device_count,
        (SELECT COUNT(*) FROM topology_site_devices sd JOIN devices d2 ON d2.id = sd.device_id
          WHERE sd.site_id = n.site_id AND d2.status = 'online') AS site_online_count
       FROM topology_nodes n
       LEFT JOIN devices dv ON dv.id = n.device_id
       LEFT JOIN groups g ON g.id = dv.group_id
       LEFT JOIN topology_sites s ON s.id = n.site_id
       WHERE n.diagram_id = ? ORDER BY n.z ASC, n.id ASC`
    )
    .all(row.id)
    .map(serializeNode);
  const links = db
    .prepare('SELECT * FROM topology_links WHERE diagram_id = ? ORDER BY created_at ASC, id ASC')
    .all(row.id)
    .map(serializeLink);
  const stats = { online: 0, offline: 0, warning: 0, unknown: 0, maintenance: 0, placeholders: 0 };
  for (const n of nodes) {
    if (n.device) {
      const key = n.device.status in stats ? n.device.status : 'unknown';
      stats[key] += 1;
    } else if ((n.kind === 'device' && !n.device) || (n.kind === 'site' && !n.site)) {
      // گره‌ای که مرجعش حذف شده اما ساختارش حفظ شده است
      stats.placeholders += 1;
    }
  }
  return { ...serializeDiagram(row), nodes, links, stats };
}

function validateNode(raw, index) {
  if (!raw || typeof raw !== 'object') throw new TopologyError(400, `گرهٔ ${index + 1} معتبر نیست`);
  const id = text(raw.id, 64) || randomUUID();
  if (!NODE_ID.test(id)) throw new TopologyError(400, `شناسهٔ گرهٔ ${index + 1} معتبر نیست`);
  const kind = NODE_KINDS.has(raw.kind) ? raw.kind : 'note';
  return {
    id,
    kind,
    deviceId: kind === 'device' || raw.deviceId ? intOrNull(raw.deviceId) : null,
    siteId: kind === 'site' || raw.siteId ? intOrNull(raw.siteId) : null,
    label: text(raw.label, MAX_LABEL),
    notes: text(raw.notes, MAX_NOTES),
    x: num(raw.x, 0, -100000, 100000),
    y: num(raw.y, 0, -100000, 100000),
    width: num(raw.width, 190, 80, 800),
    height: num(raw.height, 72, 40, 600),
    color: colorOf(raw.color),
    z: Math.round(num(raw.z, 0, -100000, 100000)),
    meta: jsonText(raw.meta),
  };
}

function validateLink(raw, index, nodeIds) {
  if (!raw || typeof raw !== 'object') throw new TopologyError(400, `لینک ${index + 1} معتبر نیست`);
  const id = text(raw.id, 64) || randomUUID();
  if (!NODE_ID.test(id)) throw new TopologyError(400, `شناسهٔ لینک ${index + 1} معتبر نیست`);
  const from = text(raw.from, 64);
  const to = text(raw.to, 64);
  if (!nodeIds.has(from) || !nodeIds.has(to)) throw new TopologyError(400, 'دو سر لینک باید از گره‌های همین دیاگرام باشند');
  if (from === to) throw new TopologyError(400, 'لینک نمی‌تواند یک گره را به خودش وصل کند');
  return {
    id,
    from,
    to,
    kind: LINK_KINDS.has(raw.kind) ? raw.kind : 'ethernet',
    label: text(raw.label, MAX_LABEL),
    notes: text(raw.notes, MAX_NOTES),
    color: colorOf(raw.color),
    style: LINK_STYLES.has(raw.style) ? raw.style : 'solid',
    meta: jsonText(raw.meta),
  };
}

/**
 * ذخیرهٔ کامل گراف در یک تراکنش.
 * کلاینت همیشه وضعیت کامل گره‌ها/لینک‌ها را می‌فرستد؛ سرور اختلاف را
 * (درج/به‌روزرسانی/حذف) اعمال می‌کند. این کار Undo/Redo و ویرایش گروهی را
 * بدون مجموعهٔ پیچیده‌ای از اندپوینت‌ها ممکن می‌کند.
 */
function saveGraph(diagramId, body = {}) {
  const diagram = requireDiagram(diagramId);
  if (diagram.locked) throw new TopologyError(423, 'این دیاگرام قفل است؛ برای ویرایش ابتدا آن را باز کنید');
  const revision = Math.floor(Number(body.revision));
  if (!Number.isFinite(revision)) throw new TopologyError(400, 'شمارهٔ نسخه (revision) الزامی است');
  if (revision !== diagram.revision) {
    throw new TopologyError(409, 'نسخهٔ جدیدتری از این دیاگرام ذخیره شده است؛ صفحه را بازخوانی کنید', {
      revision: diagram.revision,
    });
  }
  const rawNodes = Array.isArray(body.nodes) ? body.nodes : [];
  const rawLinks = Array.isArray(body.links) ? body.links : [];
  if (rawNodes.length > MAX_NODES) throw new TopologyError(413, `حداکثر ${MAX_NODES} گره در هر دیاگرام مجاز است`);
  if (rawLinks.length > MAX_LINKS) throw new TopologyError(413, `حداکثر ${MAX_LINKS} لینک در هر دیاگرام مجاز است`);

  const nodes = rawNodes.map(validateNode);
  const nodeIds = new Set(nodes.map((n) => n.id));
  if (nodeIds.size !== nodes.length) throw new TopologyError(400, 'شناسهٔ گره‌ها تکراری است');

  const deviceIds = nodes.map((n) => n.deviceId).filter((v) => v != null);
  if (new Set(deviceIds).size !== deviceIds.length) throw new TopologyError(400, 'یک تجهیز نمی‌تواند دو بار در یک دیاگرام باشد');

  const siteIds = [...new Set(nodes.map((n) => n.siteId).filter((v) => v != null))];
  if (deviceIds.length) {
    for (const batch of chunks([...new Set(deviceIds)])) {
      const rows = db
        .prepare(`SELECT id FROM devices WHERE id IN (${batch.map(() => '?').join(',')})`)
        .all(...batch);
      if (rows.length !== batch.length) throw new TopologyError(400, 'یکی از تجهیزات انتخاب‌شده وجود ندارد');
    }
  }
  if (siteIds.length) {
    for (const batch of chunks(siteIds)) {
      const rows = db
        .prepare(`SELECT id FROM topology_sites WHERE id IN (${batch.map(() => '?').join(',')})`)
        .all(...batch);
      if (rows.length !== batch.length) throw new TopologyError(400, 'یکی از مراکز تجمع انتخاب‌شده وجود ندارد');
    }
  }

  const links = rawLinks.map((l, i) => validateLink(l, i, nodeIds));
  if (new Set(links.map((l) => l.id)).size !== links.length) throw new TopologyError(400, 'شناسهٔ لینک‌ها تکراری است');
  const pairs = new Set();
  for (const l of links) {
    const key = [l.from, l.to].sort().join('|');
    if (pairs.has(key)) throw new TopologyError(400, 'بین دو گره بیش از یک لینک مجاز نیست');
    pairs.add(key);
  }

  // شناسه‌هایی که هم‌اکنون در دیاگرام‌های دیگر هستند نباید با ارسال دوباره دزدیده شوند.
  const allIds = [...nodeIds, ...links.map((l) => l.id)];
  for (const batch of chunks(allIds)) {
    const owners = db
      .prepare(
        `SELECT id, diagram_id FROM topology_nodes WHERE id IN (${batch.map(() => '?').join(',')})
         UNION ALL
         SELECT id, diagram_id FROM topology_links WHERE id IN (${batch.map(() => '?').join(',')})`
      )
      .all(...batch, ...batch);
    for (const row of owners) {
      if (row.diagram_id !== diagram.id) throw new TopologyError(400, 'شناسهٔ تکراری در دیاگرام دیگر');
    }
  }

  const now = Date.now();
  const insertNode = db.prepare(
    `INSERT INTO topology_nodes(
       id, diagram_id, kind, device_id, site_id, label, notes, x, y, width, height, color, z, meta, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       kind=excluded.kind, device_id=excluded.device_id, site_id=excluded.site_id, label=excluded.label,
       notes=excluded.notes, x=excluded.x, y=excluded.y, width=excluded.width, height=excluded.height,
       color=excluded.color, z=excluded.z, meta=excluded.meta, updated_at=excluded.updated_at
     WHERE topology_nodes.diagram_id = excluded.diagram_id`
  );
  const insertLink = db.prepare(
    `INSERT INTO topology_links(
       id, diagram_id, from_node_id, to_node_id, kind, label, notes, color, style, meta, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       from_node_id=excluded.from_node_id, to_node_id=excluded.to_node_id, kind=excluded.kind,
       label=excluded.label, notes=excluded.notes, color=excluded.color, style=excluded.style,
       meta=excluded.meta, updated_at=excluded.updated_at
     WHERE topology_links.diagram_id = excluded.diagram_id`
  );

  transaction(
    () => {
      // ۱) گره‌ها (درج یا به‌روزرسانی) — یال‌ها به آن‌ها ارجاع می‌دهند.
      for (const n of nodes) {
        insertNode.run(
          n.id, diagram.id, n.kind, n.deviceId, n.siteId, n.label, n.notes, n.x, n.y,
          n.width, n.height, n.color, n.z, n.meta, now, now
        );
      }
      // ۲) گره‌های حذف‌شده (یال‌های وابسته با CASCADE پاک می‌شوند)
      const existingNodeIds = db.prepare('SELECT id FROM topology_nodes WHERE diagram_id = ?').all(diagram.id);
      for (const row of existingNodeIds) {
        if (!nodeIds.has(row.id)) db.prepare('DELETE FROM topology_nodes WHERE id = ? AND diagram_id = ?').run(row.id, diagram.id);
      }
      // ۳) یال‌ها
      for (const l of links) {
        insertLink.run(
          l.id, diagram.id, l.from, l.to, l.kind, l.label, l.notes, l.color, l.style, l.meta, now, now
        );
      }
      const linkIds = new Set(links.map((l) => l.id));
      const existingLinkIds = db.prepare('SELECT id FROM topology_links WHERE diagram_id = ?').all(diagram.id);
      for (const row of existingLinkIds) {
        if (!linkIds.has(row.id)) db.prepare('DELETE FROM topology_links WHERE id = ? AND diagram_id = ?').run(row.id, diagram.id);
      }
      db.prepare('UPDATE topology_diagrams SET revision = revision + 1, updated_at = ? WHERE id = ?').run(now, diagram.id);
    },
    { label: 'topology.graph.save' }
  );
  return loadDiagram(diagram.id);
}

/** کلون کامل یک دیاگرام/الگو با شناسه‌های تازه */
function cloneDiagram(sourceId, { name, asTemplate = false, createdBy = '' } = {}) {
  const source = requireDiagram(sourceId);
  const nodes = db.prepare('SELECT * FROM topology_nodes WHERE diagram_id = ?').all(source.id);
  const links = db.prepare('SELECT * FROM topology_links WHERE diagram_id = ?').all(source.id);
  const deviceIds = new Set(db.prepare('SELECT id FROM devices').all().map((r) => r.id));
  const siteIds = new Set(db.prepare('SELECT id FROM topology_sites').all().map((r) => r.id));
  const now = Date.now();
  const newName = text(name, 120) || `${source.name}${asTemplate ? ' (الگو)' : ' (کپی)'}`;
  const idMap = new Map(nodes.map((n) => [n.id, randomUUID()]));

  const diagramId = transaction(
    () => {
      const res = db
        .prepare(
          `INSERT INTO topology_diagrams(name, description, layout, locked, is_template, revision, viewport, settings, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,1,?,?,?,?,?)`
        )
        .run(
          newName,
          source.description || '',
          source.layout || 'hierarchy-tb',
          0,
          asTemplate ? 1 : 0,
          source.viewport || '{}',
          source.settings || '{}',
          text(createdBy, 80),
          now,
          now
        );
      const id = Number(res.lastInsertRowid);
      const insertNode = db.prepare(
        `INSERT INTO topology_nodes(
           id, diagram_id, kind, device_id, site_id, label, notes, x, y, width, height, color, z, meta, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (const n of nodes) {
        insertNode.run(
          idMap.get(n.id),
          id,
          n.kind,
          n.device_id != null && deviceIds.has(n.device_id) ? n.device_id : null,
          n.site_id != null && siteIds.has(n.site_id) ? n.site_id : null,
          n.label || '',
          n.notes || '',
          n.x, n.y, n.width, n.height, n.color || '', n.z, n.meta || '{}', now, now
        );
      }
      const insertLink = db.prepare(
        `INSERT INTO topology_links(
           id, diagram_id, from_node_id, to_node_id, kind, label, notes, color, style, meta, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (const l of links) {
        if (!idMap.has(l.from_node_id) || !idMap.has(l.to_node_id)) continue;
        insertLink.run(
          randomUUID(), id, idMap.get(l.from_node_id), idMap.get(l.to_node_id),
          l.kind || 'ethernet', l.label || '', l.notes || '', l.color || '', l.style || 'solid', l.meta || '{}', now, now
        );
      }
      return id;
    },
    { label: 'topology.diagram.clone' }
  );
  return loadDiagram(diagramId);
}

/* ------------------------------------------------------------------ */
/* میان‌بر خطا                                                          */
/* ------------------------------------------------------------------ */

function handle(res, fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof TopologyError) return res.status(e.status).json({ error: e.message, ...e.extra });
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* مراکز تجمع — مسیرها                                                 */
/* ------------------------------------------------------------------ */

router.get('/topology/overview', (_req, res) => {
  const stats = {
    deviceTotal: db.prepare('SELECT COUNT(*) AS c FROM devices').get().c,
    siteTotal: db.prepare('SELECT COUNT(*) AS c FROM topology_sites').get().c,
    placedDevices: db.prepare('SELECT COUNT(DISTINCT device_id) AS c FROM topology_nodes WHERE device_id IS NOT NULL').get().c,
    unassignedSites: db.prepare('SELECT COUNT(*) AS c FROM devices d WHERE NOT EXISTS (SELECT 1 FROM topology_site_devices sd WHERE sd.device_id = d.id)').get().c,
    diagramTotal: db.prepare('SELECT COUNT(*) AS c FROM topology_diagrams WHERE is_template = 0').get().c,
    templateTotal: db.prepare('SELECT COUNT(*) AS c FROM topology_diagrams WHERE is_template = 1').get().c,
  };
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    diagrams: listDiagrams({ templates: false }),
    templates: listDiagrams({ templates: true }),
    sites: listSites(),
    stats,
    generatedAt: Date.now(),
  });
});

router.get('/topology/sites', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: listSites() });
});

router.post('/topology/sites', (req, res) =>
  handle(res, () => {
    const body = validateSiteBody(req.body || {});
    if (db.prepare('SELECT id FROM topology_sites WHERE name = ? COLLATE NOCASE').get(body.name)) {
      throw new TopologyError(400, 'مرکز تجمعی با این نام از قبل وجود دارد');
    }
    const now = Date.now();
    const r = db
      .prepare(
        `INSERT INTO topology_sites(name, code, address, latitude, longitude, notes, color, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        body.name, body.code || '', body.address || '', body.latitude ?? null, body.longitude ?? null,
        body.notes || '', body.color || '#6366f1', now, now
      );
    res.status(201).json(getSite(Number(r.lastInsertRowid)));
  })
);

router.put('/topology/sites/:id', (req, res) =>
  handle(res, () => {
    const site = getSite(req.params.id);
    if (!site) throw new TopologyError(404, 'مرکز تجمع یافت نشد');
    const body = validateSiteBody(req.body || {}, { partial: true });
    if (body.name && db.prepare('SELECT id FROM topology_sites WHERE name = ? COLLATE NOCASE AND id <> ?').get(body.name, site.id)) {
      throw new TopologyError(400, 'مرکز تجمعی با این نام از قبل وجود دارد');
    }
    const fields = [];
    const values = [];
    for (const key of ['name', 'code', 'address', 'latitude', 'longitude', 'notes', 'color']) {
      if (body[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(body[key]);
      }
    }
    if (!fields.length) return res.json(site);
    fields.push('updated_at = ?');
    values.push(Date.now(), site.id);
    db.prepare(`UPDATE topology_sites SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    res.json(getSite(site.id));
  })
);

router.delete('/topology/sites/:id', (req, res) =>
  handle(res, () => {
    const site = getSite(req.params.id);
    if (!site) throw new TopologyError(404, 'مرکز تجمع یافت نشد');
    db.prepare('DELETE FROM topology_sites WHERE id = ?').run(site.id);
    res.json({ deleted: 1, detachedDevices: site.deviceCount });
  })
);

/** جایگزینی/حذف عضویت تجهیزات در یک مرکز تجمع (هر تجهیز یک مرکز) */
router.post('/topology/sites/:id/devices', (req, res) =>
  handle(res, () => {
    const site = getSite(req.params.id);
    if (!site) throw new TopologyError(404, 'مرکز تجمع یافت نشد');
    const body = req.body || {};
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [];
    if (!ids.length) throw new TopologyError(400, 'فهرست تجهیزات خالی است');
    if (ids.length > 2000) throw new TopologyError(413, 'حداکثر ۲۰۰۰ تجهیز در هر درخواست مجاز است');
    const mode = body.mode === 'remove' ? 'remove' : 'assign';
    let affected = 0;
    transaction(
      () => {
        for (const batch of chunks(ids)) {
          const ph = batch.map(() => '?').join(',');
          const existing = db.prepare(`SELECT id FROM devices WHERE id IN (${ph})`).all(...batch);
          if (existing.length !== batch.length) throw new TopologyError(400, 'یکی از تجهیزات انتخاب‌شده وجود ندارد');
          db.prepare(`DELETE FROM topology_site_devices WHERE device_id IN (${ph})`).run(...batch);
          if (mode === 'assign') {
            const now = Date.now();
            const ins = db.prepare('INSERT INTO topology_site_devices(device_id, site_id, created_at) VALUES (?,?,?)');
            for (const id of batch) {
              ins.run(id, site.id, now);
              affected += 1;
            }
          } else {
            affected += batch.length;
          }
        }
      },
      { label: 'topology.site.devices' }
    );
    res.json({ ok: true, mode, affected, site: getSite(site.id) });
  })
);

/* ------------------------------------------------------------------ */
/* فهرست تجهیزات برای پالت/جست‌وجو                                      */
/* ------------------------------------------------------------------ */

router.get('/topology/device-catalog', (req, res) => {
  const search = text(req.query.search, 120);
  const deviceId = intOrNull(req.query.id);
  const groupId = intOrNull(req.query.groupId);
  const siteParam = String(req.query.siteId ?? '');
  const status = String(req.query.status ?? '');
  const diagramId = intOrNull(req.query.diagramId) || 0;
  const limit = Math.round(num(req.query.limit, 300, 1, 2000));

  const where = [];
  const params = [];
  if (deviceId) {
    where.push('d.id = ?');
    params.push(deviceId);
  }
  if (search) {
    where.push('(d.name LIKE ? OR d.ip LIKE ? OR d.hostname LIKE ? OR d.location LIKE ? OR d.building LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q, q, q);
  }
  if (groupId) {
    where.push('d.group_id = ?');
    params.push(groupId);
  }
  if (['online', 'offline', 'warning', 'unknown', 'maintenance'].includes(status)) {
    where.push('d.status = ?');
    params.push(status);
  }
  if (siteParam === 'unassigned') {
    where.push('NOT EXISTS (SELECT 1 FROM topology_site_devices sd WHERE sd.device_id = d.id)');
  } else if (intOrNull(siteParam)) {
    where.push('EXISTS (SELECT 1 FROM topology_site_devices sd WHERE sd.device_id = d.id AND sd.site_id = ?)');
    params.push(Number(siteParam));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM devices d ${clause}`).get(...params).c;
  const rows = db
    .prepare(
      `SELECT d.id, d.name, d.ip, d.hostname, d.device_type, d.status, d.location, d.building,
              d.group_id, g.name AS group_name, g.color AS group_color, d.priority,
              d.last_rtt_ms, d.loss_pct, d.last_check_at,
              (SELECT n.id FROM topology_nodes n WHERE n.diagram_id = ? AND n.device_id = d.id LIMIT 1) AS node_id,
              (SELECT sd.site_id FROM topology_site_devices sd WHERE sd.device_id = d.id) AS site_id,
              (SELECT s.name FROM topology_sites s JOIN topology_site_devices sd ON sd.site_id = s.id WHERE sd.device_id = d.id) AS site_name
       FROM devices d LEFT JOIN groups g ON g.id = d.group_id
       ${clause} ORDER BY d.name COLLATE NOCASE LIMIT ?`
    )
    .all(diagramId, ...params, limit);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      ip: r.ip,
      hostname: r.hostname || '',
      deviceType: r.device_type || '',
      status: r.status || 'unknown',
      location: r.location || '',
      building: r.building || '',
      groupId: r.group_id ?? null,
      groupName: r.group_name || null,
      groupColor: r.group_color || null,
      priority: r.priority || 'normal',
      lastRtt: r.last_rtt_ms,
      lossPct: r.loss_pct ?? 0,
      lastCheckAt: r.last_check_at,
      nodeId: r.node_id || null,
      siteId: r.site_id ?? null,
      siteName: r.site_name || null,
    })),
    total,
    returned: rows.length,
    hasMore: total > rows.length,
    generatedAt: Date.now(),
  });
});

/* ------------------------------------------------------------------ */
/* دیاگرام‌ها — مسیرها                                                 */
/* ------------------------------------------------------------------ */

router.get('/topology/diagrams', (req, res) => {
  const templates = String(req.query.templates ?? '') === '1';
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: listDiagrams({ templates, search: text(req.query.search, 120) }) });
});

router.post('/topology/diagrams', (req, res) =>
  handle(res, () => {
    const body = req.body || {};
    const name = text(body.name, 120);
    if (!name) throw new TopologyError(400, 'نام دیاگرام الزامی است');
    const fromTemplateId = intOrNull(body.fromTemplateId);
    if (fromTemplateId) {
      if (!getDiagramRow(fromTemplateId)) throw new TopologyError(404, 'الگوی انتخاب‌شده یافت نشد');
      const diagram = cloneDiagram(fromTemplateId, { name, createdBy: req.user?.username || '' });
      return res.status(201).json(diagram);
    }
    const layout = LAYOUTS.has(body.layout) ? body.layout : 'hierarchy-tb';
    const now = Date.now();
    const r = db
      .prepare(
        `INSERT INTO topology_diagrams(name, description, layout, locked, is_template, revision, viewport, settings, created_by, created_at, updated_at)
         VALUES (?,?,?,0,0,1,'{}','{}',?,?,?)`
      )
      .run(name, text(body.description, 500), layout, text(req.user?.username, 80), now, now);
    res.status(201).json(loadDiagram(Number(r.lastInsertRowid)));
  })
);

router.get('/topology/diagrams/:id', (req, res) =>
  handle(res, () => {
    const diagram = loadDiagram(req.params.id);
    if (!diagram) throw new TopologyError(404, 'دیاگرام یافت نشد');
    res.setHeader('Cache-Control', 'no-store');
    res.json(diagram);
  })
);

/** به‌روزرسانی فراداده (نام/توضیح/چیدمان/تنظیمات/نمای دوربین) */
router.put('/topology/diagrams/:id', (req, res) =>
  handle(res, () => {
    const diagram = requireDiagram(req.params.id);
    if (diagram.locked) throw new TopologyError(423, 'این دیاگرام قفل است؛ برای ویرایش ابتدا آن را باز کنید');
    const body = req.body || {};
    const fields = [];
    const values = [];
    if (body.name !== undefined) {
      const name = text(body.name, 120);
      if (!name) throw new TopologyError(400, 'نام دیاگرام الزامی است');
      fields.push('name = ?');
      values.push(name);
    }
    if (body.description !== undefined) {
      fields.push('description = ?');
      values.push(text(body.description, 500));
    }
    if (body.layout !== undefined) {
      if (!LAYOUTS.has(String(body.layout))) throw new TopologyError(400, 'نوع چیدمان معتبر نیست');
      fields.push('layout = ?');
      values.push(String(body.layout));
    }
    if (body.viewport !== undefined) {
      fields.push('viewport = ?');
      values.push(jsonText(body.viewport, 500));
    }
    if (body.settings !== undefined) {
      fields.push('settings = ?');
      values.push(jsonText(body.settings, 2000));
    }
    if (!fields.length) return res.json(loadDiagram(diagram.id));
    fields.push('updated_at = ?');
    values.push(Date.now(), diagram.id);
    db.prepare(`UPDATE topology_diagrams SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    res.json(loadDiagram(diagram.id));
  })
);

router.delete('/topology/diagrams/:id', (req, res) =>
  handle(res, () => {
    const diagram = requireDiagram(req.params.id);
    db.prepare('DELETE FROM topology_diagrams WHERE id = ?').run(diagram.id);
    res.json({ deleted: 1 });
  })
);

/** قفل/بازکردن دیاگرام — قفل مانع هر تغییر گراف و فراداده است */
router.post('/topology/diagrams/:id/lock', (req, res) =>
  handle(res, () => {
    const diagram = requireDiagram(req.params.id);
    const locked = req.body?.locked !== false;
    db.prepare('UPDATE topology_diagrams SET locked = ?, updated_at = ? WHERE id = ?').run(locked ? 1 : 0, Date.now(), diagram.id);
    res.json(serializeDiagram(getDiagramRow(diagram.id)));
  })
);

router.post('/topology/diagrams/:id/duplicate', (req, res) =>
  handle(res, () => {
    const diagram = requireDiagram(req.params.id);
    const copy = cloneDiagram(diagram.id, {
      name: text(req.body?.name, 120) || `${diagram.name} (کپی)`,
      asTemplate: req.body?.asTemplate === true,
      createdBy: req.user?.username || '',
    });
    res.status(201).json(copy);
  })
);

router.post('/topology/diagrams/:id/template', (req, res) =>
  handle(res, () => {
    const diagram = requireDiagram(req.params.id);
    const name = text(req.body?.name, 120) || `${diagram.name} (الگو)`;
    const template = cloneDiagram(diagram.id, { name, asTemplate: true, createdBy: req.user?.username || '' });
    res.status(201).json(template);
  })
);

router.put('/topology/diagrams/:id/graph', (req, res) =>
  handle(res, () => {
    const diagram = saveGraph(req.params.id, req.body || {});
    res.json(diagram);
  })
);

/** تازه‌سازی سبک وضعیت تجهیزات برای صفحهٔ باز (بدون ارسال کل گراف) */
router.get('/topology/diagrams/:id/status', (req, res) =>
  handle(res, () => {
    const diagram = requireDiagram(req.params.id);
    const nodes = db
      .prepare(
        `SELECT n.id, n.device_id, n.kind, dv.name, dv.ip, dv.status, dv.last_rtt_ms, dv.loss_pct, dv.last_check_at
         FROM topology_nodes n LEFT JOIN devices dv ON dv.id = n.device_id WHERE n.diagram_id = ?`
      )
      .all(diagram.id);
    const sites = db
      .prepare(
        `SELECT s.id, s.name,
           (SELECT COUNT(*) FROM topology_site_devices sd WHERE sd.site_id = s.id) AS device_count,
           (SELECT COUNT(*) FROM topology_site_devices sd JOIN devices dv ON dv.id = sd.device_id
             WHERE sd.site_id = s.id AND dv.status = 'online') AS online_count
         FROM topology_sites s`
      )
      .all();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      revision: diagram.revision,
      generatedAt: Date.now(),
      nodes: nodes.map((n) => ({
        id: n.id,
        deviceId: n.device_id ?? null,
        kind: n.kind,
        name: n.name ?? null,
        ip: n.ip ?? null,
        status: n.status || 'unknown',
        lastRtt: n.last_rtt_ms,
        lossPct: n.loss_pct ?? 0,
        lastCheckAt: n.last_check_at,
      })),
      sites: sites.map((s) => ({ id: s.id, name: s.name, deviceCount: s.device_count ?? 0, onlineCount: s.online_count ?? 0 })),
    });
  })
);

/** خروجی JSON ساختاریافته (بدون وضعیت زنده) برای پشتیبان/انتقال آفلاین */
router.get('/topology/diagrams/:id/export', (req, res) =>
  handle(res, () => {
    const diagram = loadDiagram(req.params.id);
    if (!diagram) throw new TopologyError(404, 'دیاگرام یافت نشد');
    const payload = {
      format: 'netwatch-topology',
      version: 1,
      exportedAt: Date.now(),
      diagram: {
        name: diagram.name,
        description: diagram.description,
        layout: diagram.layout,
        settings: diagram.settings,
      },
      nodes: diagram.nodes.map((n) => ({
        id: n.id, kind: n.kind, deviceId: n.deviceId, siteId: n.siteId, label: n.label,
        notes: n.notes, x: n.x, y: n.y, width: n.width, height: n.height, color: n.color, z: n.z, meta: n.meta,
      })),
      links: diagram.links.map((l) => ({
        id: l.id, from: l.from, to: l.to, kind: l.kind, label: l.label, notes: l.notes,
        color: l.color, style: l.style, meta: l.meta,
      })),
    };
    const safeName = diagram.name.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'topology';
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeName)}.json"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(payload, null, 2));
  })
);

export default router;
