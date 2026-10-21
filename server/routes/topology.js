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
import { buildLiveStatus, invalidateLiveCache } from '../topology-live.js';
import { pollLinkTelemetryOnce } from '../link-telemetry.js';
import { analyzeTopology, simulateTopologyImpact } from '../topology-analysis.js';
import { createVersion, diffSnapshots, getVersion, listVersions, readSnapshot, restoreSnapshot } from '../topology-history.js';
import { buildTopologyReport } from '../topology-report.js';
import { reportToPdf, reportToXlsx } from '../topology-report-export.js';

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
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const MAX_CAPACITY_MBPS = 1000000;
const MAX_PATHS = 80;
const MAX_PATH_NODES = 250;

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
          hostname: row.device_hostname || '',
          deviceType: row.device_type || '',
          status: row.device_status || 'unknown',
          statusReason: row.device_status_reason || '',
          lastRtt: row.last_rtt_ms,
          lossPct: row.loss_pct ?? 0,
          lastCheckAt: row.last_check_at,
          location: row.device_location || '',
          building: row.device_building || '',
          rack: row.device_rack || '',
          vendor: row.device_vendor || '',
          model: row.device_model || '',
          serial: row.device_serial || '',
          firmware: row.device_firmware || '',
          uptimePct: row.device_uptime_pct ?? null,
          monitoringEnabled: row.device_monitoring_enabled !== 0,
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
    // مرحلهٔ ۲: پهنای باند اسمی، تجهیز مرجع سنجش و پیکربندی سنجش ترافیک
    capacityMbps: Number.isFinite(Number(row.capacity_mbps)) && Number(row.capacity_mbps) > 0
      ? Number(row.capacity_mbps)
      : null,
    monitorDeviceId: row.monitor_device_id ?? null,
    telemetry: {
      enabled: !!row.telemetry_enabled,
      agent: row.telemetry_agent || '',
      ifIndex: row.telemetry_if_index ?? null,
    },
  };
}

function loadDiagram(id) {
  const row = getDiagramRow(id);
  if (!row) return null;
  const nodes = db
    .prepare(
      `SELECT n.*,
        dv.name AS device_name, dv.ip AS device_ip, dv.device_type, dv.status AS device_status,
        dv.status_reason AS device_status_reason,
        dv.last_rtt_ms, dv.loss_pct, dv.last_check_at, dv.location AS device_location,
        dv.hostname AS device_hostname, dv.building AS device_building, dv.rack AS device_rack,
        dv.vendor AS device_vendor, dv.model AS device_model, dv.serial AS device_serial,
        dv.firmware AS device_firmware, dv.uptime_pct AS device_uptime_pct,
        dv.monitoring_enabled AS device_monitoring_enabled,
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
  // وضعیت زندهٔ لینک‌ها از همان Snapshot مشترک با اندپوینت /status می‌آید؛
  // یعنی رنگ و متریک‌هایی که در بارگذاری دیده می‌شوند با به‌روزرسانی خودکار
  // یکی هستند و دو محاسبهٔ متفاوت نداریم.
  const live = buildLiveStatus(row.id, { useCache: false });
  const liveById = new Map((live?.links ?? []).map((item) => [item.id, item]));
  const links = db
    .prepare('SELECT * FROM topology_links WHERE diagram_id = ? ORDER BY created_at ASC, id ASC')
    .all(row.id)
    .map((link) => ({ ...serializeLink(link), live: liveById.get(link.id) ?? null }));
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
  return {
    ...serializeDiagram(row),
    nodes,
    links,
    stats,
    linkStats: live?.summary ?? { up: 0, down: 0, degraded: 0, unknown: 0, highLoad: 0, saturated: 0 },
    liveGeneratedAt: live?.generatedAt ?? null,
  };
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
    capacityMbps: (() => {
      if (raw.capacityMbps === null || raw.capacityMbps === '' || raw.capacityMbps === undefined) return null;
      const value = Number(raw.capacityMbps);
      if (!Number.isFinite(value) || value <= 0) return null;
      return Math.round(Math.min(MAX_CAPACITY_MBPS, Math.max(0.1, value)) * 1000) / 1000;
    })(),
    monitorDeviceId: intOrNull(raw.monitorDeviceId),
    telemetryEnabled: raw.telemetry?.enabled === true || raw.telemetryEnabled === true,
    telemetryAgent: IPV4.test(String(raw.telemetry?.agent ?? raw.telemetryAgent ?? '').trim())
      ? String(raw.telemetry?.agent ?? raw.telemetryAgent).trim()
      : '',
    telemetryIfIndex: (() => {
      const n = Number(raw.telemetry?.ifIndex ?? raw.telemetryIfIndex);
      return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
    })(),
  };
}

/**
 * ذخیرهٔ کامل گراف در یک تراکنش.
 * کلاینت همیشه وضعیت کامل گره‌ها/لینک‌ها را می‌فرستد؛ سرور اختلاف را
 * (درج/به‌روزرسانی/حذف) اعمال می‌کند. این کار Undo/Redo و ویرایش گروهی را
 * بدون مجموعهٔ پیچیده‌ای از اندپوینت‌ها ممکن می‌کند.
 */
function saveGraph(diagramId, body = {}, { author = '' } = {}) {
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
  const monitoredDeviceIds = [
    ...new Set(
      rawLinks
        .map((l) => Number(l?.monitorDeviceId))
        .filter((n) => Number.isInteger(n) && n > 0)
    ),
  ];

  const siteIds = [...new Set(nodes.map((n) => n.siteId).filter((v) => v != null))];
  if (deviceIds.length || monitoredDeviceIds.length) {
    for (const batch of chunks([...new Set([...deviceIds, ...monitoredDeviceIds])])) {
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
  for (let i = 0; i < links.length; i += 1) {
    if (!links[i].telemetryEnabled) continue;
    const rawAgent = String(rawLinks[i]?.telemetry?.agent ?? rawLinks[i]?.telemetryAgent ?? '').trim();
    if (rawAgent && !IPV4.test(rawAgent)) {
      throw new TopologyError(400, 'آدرس عامل SNMP باید یک IPv4 معتبر باشد');
    }
  }
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

  // پیکربندی قبلی برای تشخیص تغییر: اگر ظرفیت/منبع/اینترفیس عوض شود، آخرین
  // سنجش با پیکربندی قدیم دیگر معتبر نیست و باید از نو خوانده شود. جابه‌جایی
  // گره‌ها یا تغییر برچسب، این بازنشانی را Trigger نمی‌کند.
  const previousLinks = new Map(
    db
      .prepare(
        `SELECT id, capacity_mbps, monitor_device_id, telemetry_enabled, telemetry_agent, telemetry_if_index
         FROM topology_links WHERE diagram_id = ?`
      )
      .all(diagram.id)
      .map((row) => [row.id, row])
  );
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
       id, diagram_id, from_node_id, to_node_id, kind, label, notes, color, style, meta,
       capacity_mbps, monitor_device_id, telemetry_enabled, telemetry_agent, telemetry_if_index,
       created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       from_node_id=excluded.from_node_id, to_node_id=excluded.to_node_id, kind=excluded.kind,
       label=excluded.label, notes=excluded.notes, color=excluded.color, style=excluded.style,
       meta=excluded.meta, capacity_mbps=excluded.capacity_mbps,
       monitor_device_id=excluded.monitor_device_id, telemetry_enabled=excluded.telemetry_enabled,
       telemetry_agent=excluded.telemetry_agent, telemetry_if_index=excluded.telemetry_if_index,
       updated_at=excluded.updated_at
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
          l.id, diagram.id, l.from, l.to, l.kind, l.label, l.notes, l.color, l.style, l.meta,
          l.capacityMbps, l.monitorDeviceId, l.telemetryEnabled ? 1 : 0,
          l.telemetryEnabled ? l.telemetryAgent : '',
          l.telemetryEnabled ? l.telemetryIfIndex : null,
          now, now
        );
      }
      const linkIds = new Set(links.map((l) => l.id));
      const existingLinkIds = db.prepare('SELECT id FROM topology_links WHERE diagram_id = ?').all(diagram.id);
      for (const row of existingLinkIds) {
        if (!linkIds.has(row.id)) db.prepare('DELETE FROM topology_links WHERE id = ? AND diagram_id = ?').run(row.id, diagram.id);
      }
      for (const l of links) {
        const before = previousLinks.get(l.id);
        if (!before) continue;
        const changed =
          Number(before.capacity_mbps ?? 0) !== Number(l.capacityMbps ?? 0) ||
          Number(before.monitor_device_id ?? 0) !== Number(l.monitorDeviceId ?? 0) ||
          Number(before.telemetry_enabled ?? 0) !== (l.telemetryEnabled ? 1 : 0) ||
          String(before.telemetry_agent || '') !== String(l.telemetryEnabled ? l.telemetryAgent : '') ||
          Number(before.telemetry_if_index ?? 0) !== Number(l.telemetryEnabled ? l.telemetryIfIndex ?? 0 : 0);
        if (changed) {
          db.prepare('DELETE FROM topology_link_telemetry WHERE link_id = ?').run(l.id);
        }
      }
      db.prepare('UPDATE topology_diagrams SET revision = revision + 1, updated_at = ? WHERE id = ?').run(now, diagram.id);
    },
    { label: 'topology.graph.save' }
  );
  invalidateLiveCache(diagram.id);
  try {
    createVersion(diagram.id, { action: 'graph', author, label: 'ذخیرهٔ خودکار گراف' });
  } catch (error) {
    // ذخیرهٔ گراف قطعی است؛ خطای تاریخچه نباید ذخیرهٔ کاربر را «ناموفق» نشان دهد.
    console.error('topology version capture failed:', error?.message || error);
  }
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
           id, diagram_id, from_node_id, to_node_id, kind, label, notes, color, style, meta,
           capacity_mbps, monitor_device_id, telemetry_enabled, telemetry_agent, telemetry_if_index,
           created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (const l of links) {
        if (!idMap.has(l.from_node_id) || !idMap.has(l.to_node_id)) continue;
        insertLink.run(
          randomUUID(), id, idMap.get(l.from_node_id), idMap.get(l.to_node_id),
          l.kind || 'ethernet', l.label || '', l.notes || '', l.color || '', l.style || 'solid', l.meta || '{}',
          l.capacity_mbps ?? null,
          l.monitor_device_id != null && deviceIds.has(l.monitor_device_id) ? l.monitor_device_id : null,
          l.telemetry_enabled ? 1 : 0,
          l.telemetry_enabled ? l.telemetry_agent || '' : '',
          l.telemetry_enabled ? l.telemetry_if_index ?? null : null,
          now, now
        );
      }
      return id;
    },
    { label: 'topology.diagram.clone' }
  );
  try {
    createVersion(diagramId, {
      action: 'create',
      author: createdBy,
      label: asTemplate ? 'ایجاد از الگو (الگو)' : 'ایجاد از الگو',
      force: true,
    });
  } catch (error) {
    console.error('topology version capture failed:', error?.message || error);
  }
  return loadDiagram(diagramId);
}

/* ------------------------------------------------------------------ */
/* مسیرهای اصلی/پشتیبان (مرحلهٔ ۳)                                      */
/* ------------------------------------------------------------------ */

function parsePathList(raw, max = MAX_PATH_NODES) {
  try {
    const value = JSON.parse(raw || '[]');
    return Array.isArray(value)
      ? value.filter((item) => typeof item === 'string' && item).slice(0, max)
      : [];
  } catch {
    return [];
  }
}

function serializePath(row) {
  return {
    id: row.id,
    name: row.name || '',
    role: row.role === 'backup' ? 'backup' : 'primary',
    nodeIds: parsePathList(row.node_ids),
    linkIds: parsePathList(row.link_ids, 500),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listPaths(diagramId) {
  return db
    .prepare('SELECT * FROM topology_paths WHERE diagram_id = ? ORDER BY name COLLATE NOCASE, role DESC, created_at ASC')
    .all(Number(diagramId))
    .map(serializePath);
}

/**
 * اعتبارسنجی مسیرها. هر مسیر دنبالهٔ گره‌های موجود در همین دیاگرام است و هر
 * دو گرهٔ متوالی باید با یک لینک واقعی به هم وصل باشند. گروه اصلی/پشتیبان
 * باید دو سر یکسان داشته باشد وگرنه «جایگزین» معنایی ندارد.
 */
function validatePaths(rawPaths, nodes, links) {
  if (!Array.isArray(rawPaths)) throw new TopologyError(400, 'فهرست مسیرها معتبر نیست');
  if (rawPaths.length > MAX_PATHS) throw new TopologyError(413, `حداکثر ${MAX_PATHS} مسیر در هر دیاگرام مجاز است`);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edgeByPair = new Map();
  for (const link of links) {
    edgeByPair.set([link.from, link.to].sort().join('|'), link.id);
  }
  const usedIds = new Set();
  const groups = new Map();
  const paths = rawPaths.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new TopologyError(400, `مسیر ${index + 1} معتبر نیست`);
    const name = text(raw.name, 120);
    if (!name) throw new TopologyError(400, `نام مسیر ${index + 1} الزامی است`);
    const role = raw.role === 'backup' ? 'backup' : raw.role === 'primary' ? 'primary' : '';
    if (!role) throw new TopologyError(400, `نقش مسیر ${index + 1} باید اصلی یا پشتیبان باشد`);
    const ids = Array.isArray(raw.nodeIds)
      ? raw.nodeIds.map((value) => text(value, 64)).filter(Boolean)
      : [];
    if (ids.length < 2) throw new TopologyError(400, `مسیر «${name}» باید حداقل دو گره داشته باشد`);
    if (ids.length > MAX_PATH_NODES) throw new TopologyError(413, `هر مسیر حداکثر ${MAX_PATH_NODES} گره دارد`);
    if (ids.some((id) => !nodeIds.has(id))) {
      throw new TopologyError(400, `مسیر «${name}» به گره‌ای خارج از این دیاگرام اشاره می‌کند`);
    }
    if (new Set(ids).size !== ids.length) throw new TopologyError(400, `مسیر «${name}» نباید گره تکراری داشته باشد`);
    const linkIds = [];
    for (let i = 0; i < ids.length - 1; i += 1) {
      const edgeId = edgeByPair.get([ids[i], ids[i + 1]].sort().join('|'));
      if (!edgeId) {
        throw new TopologyError(400, `گره‌های مسیر «${name}» در گام ${i + 1} به هم متصل نیستند`);
      }
      linkIds.push(edgeId);
    }
    let id = text(raw.id, 64);
    if (id && !NODE_ID.test(id)) throw new TopologyError(400, `شناسهٔ مسیر ${index + 1} معتبر نیست`);
    if (id && usedIds.has(id)) throw new TopologyError(400, 'شناسهٔ مسیرها تکراری است');
    if (!id) id = randomUUID();
    usedIds.add(id);

    const groupKey = name.toLocaleLowerCase('fa');
    let group = groups.get(groupKey);
    if (!group) {
      group = { name, primary: null, backup: null };
      groups.set(groupKey, group);
    }
    if (group[role]) throw new TopologyError(400, `برای مسیر «${name}» بیش از یک نسخهٔ ${role === 'primary' ? 'اصلی' : 'پشتیبان'} ثبت شده است`);
    group[role] = { endpoints: [ids[0], ids[ids.length - 1]] };
    return { id, name, role, nodeIds: ids, linkIds };
  });
  for (const group of groups.values()) {
    if (!group.primary || !group.backup) continue;
    const a = group.primary.endpoints;
    const b = group.backup.endpoints;
    const same = (a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]);
    if (!same) {
      throw new TopologyError(400, `مسیر اصلی و پشتیبان «${group.name}» باید نقطهٔ شروع و پایان یکسان داشته باشند`);
    }
  }
  return paths;
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
      `SELECT d.id, d.name, d.ip, d.hostname, d.device_type, d.status, d.status_reason,
              d.location, d.building, d.rack, d.vendor, d.model, d.serial, d.firmware,
              d.uptime_pct, d.monitoring_enabled,
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
      statusReason: r.status_reason || '',
      location: r.location || '',
      building: r.building || '',
      rack: r.rack || '',
      vendor: r.vendor || '',
      model: r.model || '',
      serial: r.serial || '',
      firmware: r.firmware || '',
      uptimePct: r.uptime_pct ?? null,
      monitoringEnabled: r.monitoring_enabled !== 0,
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
    const diagramId = Number(r.lastInsertRowid);
    createVersion(diagramId, { action: 'create', author: req.user?.username || '', label: 'ایجاد دیاگرام', force: true });
    res.status(201).json(loadDiagram(diagramId));
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
    let metadataChanged = false;
    if (body.name !== undefined) {
      const name = text(body.name, 120);
      if (!name) throw new TopologyError(400, 'نام دیاگرام الزامی است');
      fields.push('name = ?');
      values.push(name);
      metadataChanged = metadataChanged || name !== (diagram.name || '');
    }
    if (body.description !== undefined) {
      const description = text(body.description, 500);
      fields.push('description = ?');
      values.push(description);
      metadataChanged = metadataChanged || description !== (diagram.description || '');
    }
    if (body.layout !== undefined) {
      if (!LAYOUTS.has(String(body.layout))) throw new TopologyError(400, 'نوع چیدمان معتبر نیست');
      fields.push('layout = ?');
      values.push(String(body.layout));
      metadataChanged = metadataChanged || String(body.layout) !== (diagram.layout || '');
    }
    if (body.viewport !== undefined) {
      fields.push('viewport = ?');
      values.push(jsonText(body.viewport, 500));
    }
    if (body.settings !== undefined) {
      const settings = jsonText(body.settings, 2000);
      fields.push('settings = ?');
      values.push(settings);
      metadataChanged = metadataChanged || settings !== (diagram.settings || '{}');
    }
    if (!fields.length) return res.json(loadDiagram(diagram.id));
    fields.push('updated_at = ?');
    values.push(Date.now(), diagram.id);
    db.prepare(`UPDATE topology_diagrams SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    if (metadataChanged) {
      createVersion(diagram.id, { action: 'metadata', author: req.user?.username || '', label: 'ویرایش مشخصات دیاگرام' });
    }
    res.json(loadDiagram(diagram.id));
  })
);

router.delete('/topology/diagrams/:id', (req, res) =>
  handle(res, () => {
    const diagram = requireDiagram(req.params.id);
    db.prepare('DELETE FROM topology_diagrams WHERE id = ?').run(diagram.id);
    invalidateLiveCache(diagram.id);
    res.json({ deleted: 1 });
  })
);

/** قفل/بازکردن دیاگرام — قفل مانع هر تغییر گراف و فراداده است */
router.post('/topology/diagrams/:id/lock', (req, res) =>
  handle(res, () => {
    const diagram = requireDiagram(req.params.id);
    const locked = req.body?.locked !== false;
    db.prepare('UPDATE topology_diagrams SET locked = ?, updated_at = ? WHERE id = ?').run(locked ? 1 : 0, Date.now(), diagram.id);
    if (Boolean(diagram.locked) !== locked) {
      createVersion(diagram.id, {
        action: 'metadata',
        author: req.user?.username || '',
        label: locked ? 'قفل دیاگرام' : 'بازکردن قفل دیاگرام',
      });
    }
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
    const diagram = saveGraph(req.params.id, req.body || {}, { author: req.user?.username || '' });
    res.json(diagram);
  })
);

/**
 * تحلیل وابستگی و تأثیر اختلال (مرحلهٔ ۳).
 *
 * برخلاف Snapshot زنده که فقط رنگ/متریک می‌دهد، این پاسخ یک تحلیل گرافی
 * از ساختار واقعی است: مراکز زیرساخت، پل‌ها (تنها مسیرها)، تجهیزات برشی،
 * شمارش تجهیزات وابسته، مسیر مشکل‌دار تا مرکز و وضعیت مسیرهای پشتیبان.
 * نتیجه هیچ‌گاه روی گراف ذخیره‌شده نوشته نمی‌شود و فقط خواندنی است.
 */
router.get('/topology/diagrams/:id/analysis', (req, res) =>
  handle(res, () => {
    const diagram = loadDiagram(req.params.id);
    if (!diagram) throw new TopologyError(404, 'دیاگرام یافت نشد');
    const paths = listPaths(diagram.id);
    const analysis = analyzeTopology({ nodes: diagram.nodes, links: diagram.links, paths });
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      revision: diagram.revision,
      paths,
      ...analysis,
    });
  })
);

/**
 * شبیه‌سازی تأثیر قطع یک لینک یا یک گره روی گراف واقعی.
 * برای هر لینک (حتی لینکی که پل نیست) یا هر تجهیز واسط قابل فراخوانی است.
 */
router.get('/topology/diagrams/:id/impact', (req, res) =>
  handle(res, () => {
    const diagram = loadDiagram(req.params.id);
    if (!diagram) throw new TopologyError(404, 'دیاگرام یافت نشد');
    const linkId = text(req.query.linkId, 64);
    const nodeId = text(req.query.nodeId, 64);
    if (Boolean(linkId) === Boolean(nodeId)) {
      throw new TopologyError(400, 'برای شبیه‌سازی، دقیقاً یکی از linkId یا nodeId لازم است');
    }
    const target = linkId ? { type: 'link', id: linkId } : { type: 'node', id: nodeId };
    const result = simulateTopologyImpact({
      nodes: diagram.nodes,
      links: diagram.links,
      paths: listPaths(diagram.id),
      target,
    });
    if (result.error) throw new TopologyError(result.error === 'لینک یافت نشد' || result.error === 'گره یافت نشد' ? 404 : 400, result.error);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ revision: diagram.revision, ...result });
  })
);

/* ------------------------------------------------------------------ */
/* تاریخچهٔ نسخه‌ها و گزارش‌ها (مرحلهٔ ۴)                                */
/* ------------------------------------------------------------------ */

router.get('/topology/diagrams/:id/versions', (req, res) =>
  handle(res, () => {
    requireDiagram(req.params.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json(listVersions(req.params.id, { limit: req.query.limit, before: req.query.before }));
  })
);

/** مقایسهٔ دو نسخه؛ `b=current` یعنی وضعیت ذخیره‌شدهٔ همین لحظه. */
router.get('/topology/diagrams/:id/versions/compare', (req, res) =>
  handle(res, () => {
    const diagram = requireDiagram(req.params.id);
    const aId = Number(req.query.a);
    if (!Number.isInteger(aId) || aId <= 0) throw new TopologyError(400, 'شناسهٔ نسخهٔ مبنا الزامی است');
    const base = getVersion(diagram.id, aId);
    if (!base) throw new TopologyError(404, 'نسخهٔ مبنا یافت نشد');
    const bParam = String(req.query.b ?? 'current');
    let target;
    if (bParam === 'current' || bParam === '') {
      const snapshot = readSnapshot(diagram.id);
      target = {
        id: null,
        label: 'وضعیت فعلی',
        revision: diagram.revision,
        action: 'current',
        actionLabel: 'وضعیت فعلی',
        createdAt: Date.now(),
        snapshot,
      };
    } else {
      const bId = Number(bParam);
      if (!Number.isInteger(bId) || bId <= 0) throw new TopologyError(400, 'شناسهٔ نسخهٔ مقصد معتبر نیست');
      target = getVersion(diagram.id, bId);
      if (!target) throw new TopologyError(404, 'نسخهٔ مقصد یافت نشد');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      base: {
        id: base.id, action: base.action, actionLabel: base.actionLabel, label: base.label,
        revision: base.revision, createdAt: base.createdAt, summary: base.summary,
      },
      target: {
        id: target.id, action: target.action, actionLabel: target.actionLabel, label: target.label,
        revision: target.revision, createdAt: target.createdAt, summary: snapshotSummaryOf(target.snapshot),
      },
      changes: diffSnapshots(base.snapshot, target.snapshot),
    });
  })
);

router.get('/topology/diagrams/:id/versions/:versionId', (req, res) =>
  handle(res, () => {
    requireDiagram(req.params.id);
    const version = getVersion(req.params.id, req.params.versionId);
    if (!version) throw new TopologyError(404, 'نسخه یافت نشد');
    res.setHeader('Cache-Control', 'no-store');
    res.json(version);
  })
);

router.post('/topology/diagrams/:id/versions/:versionId/restore', (req, res) =>
  handle(res, () => {
    const diagram = requireDiagram(req.params.id);
    if (diagram.locked) throw new TopologyError(423, 'این دیاگرام قفل است؛ برای بازگردانی ابتدا آن را باز کنید');
    const version = getVersion(diagram.id, req.params.versionId);
    if (!version) throw new TopologyError(404, 'نسخه یافت نشد');
    const expected = req.body?.revision;
    if (expected != null && Number(expected) !== Number(diagram.revision)) {
      throw new TopologyError(409, 'نسخهٔ جدیدتری از دیاگرام ذخیره شده است؛ صفحه را بازخوانی کنید', {
        revision: diagram.revision,
      });
    }
    // وضعیت فعلی پیش از جایگزینی ثبت می‌شود تا بازگردانی خودش هم قابل برگشت باشد.
    createVersion(diagram.id, {
      action: 'pre-restore',
      author: req.user?.username || '',
      label: `پیش از بازگردانی به نسخهٔ ${version.id}`,
      force: true,
    });
    const result = restoreSnapshot(diagram.id, version.snapshot, { expectedRevision: diagram.revision });
    if (result.error === 'revision-mismatch') {
      throw new TopologyError(409, 'نسخهٔ جدیدتری از دیاگرام ذخیره شده است؛ صفحه را بازخوانی کنید', { revision: result.revision });
    }
    if (result.error === 'id-conflict') throw new TopologyError(409, 'شناسه‌ای از این نسخه اکنون در دیاگرام دیگری استفاده می‌شود');
    if (result.error) throw new TopologyError(404, 'دیاگرام یافت نشد');
    createVersion(diagram.id, {
      action: 'restore',
      author: req.user?.username || '',
      label: `بازگردانی به نسخهٔ ${version.id} (${version.actionLabel})`,
      restoredFrom: version.id,
    });
    invalidateLiveCache(diagram.id);
    const loaded = loadDiagram(diagram.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...loaded, restoredFrom: version.id, restoreWarnings: result.warnings });
  })
);

/** گزارش ساختاریافته از دادهٔ واقعی همین دیاگرام (مرحلهٔ ۴). */
router.get('/topology/diagrams/:id/report', (req, res) =>
  handle(res, () => {
    const report = buildReportFor(req.params.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json(report);
  })
);

router.get('/topology/diagrams/:id/report/export', async (req, res, next) => {
  try {
    const report = buildReportFor(req.params.id);
    const format = String(req.query.format || 'xlsx').toLowerCase() === 'pdf' ? 'pdf' : 'xlsx';
    const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const filename = `netwatch-topology-${report.diagram.id}-${stamp}.${format}`;
    if (format === 'pdf') {
      const buffer = await reportToPdf(report);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', String(buffer.length));
      res.setHeader('Cache-Control', 'no-store');
      return res.send(buffer);
    }
    const buffer = reportToXlsx(report);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buffer);
  } catch (error) {
    if (error instanceof TopologyError) return res.status(error.status).json({ error: error.message, ...error.extra });
    return next(error);
  }
});

function buildReportFor(id) {
  const diagram = loadDiagram(id);
  if (!diagram) throw new TopologyError(404, 'دیاگرام یافت نشد');
  const paths = listPaths(diagram.id);
  const analysis = analyzeTopology({ nodes: diagram.nodes, links: diagram.links, paths });
  return buildTopologyReport({ diagram, paths, analysis, sites: listSites() });
}

function snapshotSummaryOf(snapshot) {
  return {
    nodes: snapshot?.nodes?.length || 0,
    links: snapshot?.links?.length || 0,
    paths: snapshot?.paths?.length || 0,
    devices: (snapshot?.nodes || []).filter((n) => n.kind === 'device').length,
    sites: (snapshot?.nodes || []).filter((n) => n.kind === 'site').length,
  };
}

/** فهرست مسیرهای اصلی/پشتیبان ثبت‌شدهٔ دیاگرام */
router.get('/topology/diagrams/:id/paths', (req, res) =>
  handle(res, () => {
    requireDiagram(req.params.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: listPaths(req.params.id) });
  })
);

/** جایگزینی کامل مسیرهای اصلی/پشتیبان (ویرایش گروهی، در یک تراکنش) */
router.put('/topology/diagrams/:id/paths', (req, res) =>
  handle(res, () => {
    const diagram = requireDiagram(req.params.id);
    if (diagram.locked) throw new TopologyError(423, 'این دیاگرام قفل است؛ برای ویرایش ابتدا آن را باز کنید');
    const nodes = db
      .prepare('SELECT id, kind FROM topology_nodes WHERE diagram_id = ?')
      .all(diagram.id);
    const links = db
      .prepare('SELECT id, from_node_id, to_node_id FROM topology_links WHERE diagram_id = ?')
      .all(diagram.id)
      .map((link) => ({ id: link.id, from: link.from_node_id, to: link.to_node_id }));
    const paths = validatePaths(req.body?.paths, nodes, links);
    // شناسهٔ مسیرِ دیاگرام دیگر نباید با ارسال دوباره به این دیاگرام منتقل شود.
    for (const path of paths) {
      const owner = db.prepare('SELECT diagram_id FROM topology_paths WHERE id = ?').get(path.id);
      if (owner && Number(owner.diagram_id) !== diagram.id) {
        throw new TopologyError(400, 'شناسهٔ مسیر متعلق به دیاگرام دیگری است');
      }
    }
    const now = Date.now();
    transaction(
      () => {
        db.prepare('DELETE FROM topology_paths WHERE diagram_id = ?').run(diagram.id);
        const insert = db.prepare(
          `INSERT INTO topology_paths(id, diagram_id, name, role, node_ids, link_ids, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?)`
        );
        for (const path of paths) {
          insert.run(
            path.id, diagram.id, path.name, path.role,
            JSON.stringify(path.nodeIds), JSON.stringify(path.linkIds), now, now
          );
        }
        db.prepare('UPDATE topology_diagrams SET updated_at = ? WHERE id = ?').run(now, diagram.id);
      },
      { label: 'topology.paths.save' }
    );
    try {
      createVersion(diagram.id, { action: 'paths', author: req.user?.username || '', label: 'ویرایش مسیرهای اصلی/پشتیبان' });
    } catch (error) {
      console.error('topology version capture failed:', error?.message || error);
    }
    res.json({ items: listPaths(diagram.id), revision: diagram.revision });
  })
);

/**
 * تازه‌سازی سبک وضعیت زنده (بدون ارسال کل گراف).
 *
 * این پاسخ همان چیزی است که بوم هر چند ثانیه می‌خواند: وضعیت رنگ گره‌ها،
 * تأخیر/افت/نوسان و متریک‌های لینک (پهنای باند، مصرف، درصد اشغال، تأخیر،
 * افت و نوسان). هیچ وضعیت لینکی از سمت کلاینت قابل تغییر نیست.
 */
router.get('/topology/diagrams/:id/status', (req, res) =>
  handle(res, () => {
    requireDiagram(req.params.id);
    // `?fresh=1` برای بازخوانی دستی است؛ نسخهٔ کش‌شده حداکثر یک ثانیه عمر دارد.
    const snapshot = buildLiveStatus(req.params.id, { useCache: String(req.query.fresh ?? '') !== '1' });
    if (!snapshot) throw new TopologyError(404, 'دیاگرام یافت نشد');
    res.setHeader('Cache-Control', 'no-store');
    res.json(snapshot);
  })
);

/**
 * سنجش فوری ترافیک لینک‌های همین دیاگرام (SNMP).
 * فقط لینک‌های دارای سنجش فعال خوانده می‌شوند؛ نتیجهٔ سنجش در پایگاه‌داده
 * ثبت و Snapshot تازه برگردانده می‌شود.
 */
router.post('/topology/diagrams/:id/telemetry/poll', async (req, res, next) => {
  try {
    requireDiagram(req.params.id);
    const summary = await pollLinkTelemetryOnce({ diagramId: Number(req.params.id) });
    invalidateLiveCache(req.params.id);
    const snapshot = buildLiveStatus(req.params.id, { useCache: false });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...summary, results: undefined, snapshot });
  } catch (error) {
    if (error instanceof TopologyError) {
      return res.status(error.status).json({ error: error.message, ...error.extra });
    }
    return next(error);
  }
});

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
        capacityMbps: l.capacityMbps, monitorDeviceId: l.monitorDeviceId, telemetry: l.telemetry,
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
