/**
 * NetWatch — تاریخچهٔ ساختاریافتهٔ دیاگرام ارتباطات (مرحلهٔ ۴)
 * ----------------------------------------------------------------
 * هر تغییر معنادار دیاگرام یک «نسخه» می‌سازد:
 *   • ایجاد/تکثیر دیاگرام
 *   • ذخیرهٔ گراف (افزودن، حذف و ویرایش گره/لینک)
 *   • تغییر مسیرهای اصلی/پشتیبان
 *   • تغییر نام/توضیح/چیدمان/تنظیمات و قفل
 *   • بازگردانی به نسخهٔ قبلی (و ثبت وضعیت پیش از بازگردانی)
 *
 * نسخه‌ها Snapshot کامل و فشرده (gzip) هستند تا بازگردانی دقیق ممکن باشد؛
 * «فقط تغییرات» برای بازسازی یک وضعیت قدیمی کافی نیست. در کنار Snapshot،
 * اختلاف ساختاری با نسخهٔ قبلی هم ذخیره می‌شود تا مقایسه بدون محاسبهٔ سنگین
 * و با برچسب‌های فارسی در دسترس باشد.
 *
 * محدودیت نگهداری: ۲۰۰ نسخهٔ آخر هر دیاگرام. این محدودیت صریح است تا
 * پایگاه‌داده با ویرایش‌های مکرر بی‌نهایت رشد نکند.
 */
import { gzipSync, gunzipSync } from 'node:zlib';
import { db, transaction } from './db.js';

export const MAX_VERSIONS_PER_DIAGRAM = 200;
const MAX_CHANGE_ITEMS = 200;

export const VERSION_ACTION_LABEL = Object.freeze({
  create: 'ایجاد دیاگرام',
  graph: 'ویرایش ساختار',
  paths: 'تغییر مسیرها',
  metadata: 'ویرایش مشخصات',
  restore: 'بازگردانی نسخه',
  'pre-restore': 'وضعیت پیش از بازگردانی',
  baseline: 'نسخهٔ پایه',
});

const NODE_KINDS = new Set(['device', 'site', 'cloud', 'note', 'group']);
const LINK_KINDS = new Set(['ethernet', 'fiber', 'wireless', 'vpn', 'logical']);
const LINK_STYLES = new Set(['solid', 'dashed', 'dotted']);
const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

const FIELD_LABEL = Object.freeze({
  name: 'نام',
  description: 'توضیح',
  layout: 'چیدمان',
  locked: 'قفل',
  isTemplate: 'الگو',
  settings: 'تنظیمات',
  kind: 'نوع',
  deviceId: 'تجهیز متصل',
  siteId: 'مرکز تجمع',
  label: 'برچسب',
  notes: 'یادداشت',
  position: 'موقعیت',
  size: 'ابعاد',
  color: 'رنگ',
  z: 'ترتیب لایه',
  meta: 'فراداده',
  from: 'گرهٔ مبدأ',
  to: 'گرهٔ مقصد',
  style: 'سبک خط',
  capacityMbps: 'ظرفیت (Mbps)',
  monitorDeviceId: 'تجهیز مرجع سنجش',
  telemetry: 'سنجش ترافیک',
  role: 'نقش',
  nodeIds: 'گره‌های مسیر',
  linkIds: 'لینک‌های مسیر',
});

function parseJson(raw, fallback) {
  try {
    const value = JSON.parse(raw || '');
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

export function nodeDisplayLabel(node) {
  if (!node) return 'گره';
  if (node.label) return String(node.label).slice(0, 160);
  if (node.deviceName) return String(node.deviceName).slice(0, 160);
  if (node.siteName) return String(node.siteName).slice(0, 160);
  if (node.kind === 'cloud') return 'ابر / WAN';
  if (node.kind === 'site') return 'مرکز تجمع';
  if (node.kind === 'note') return 'یادداشت';
  if (node.kind === 'group') return 'گروه';
  return 'گره';
}

export function emptySnapshot() {
  return {
    name: '',
    description: '',
    layout: 'hierarchy-tb',
    locked: false,
    isTemplate: false,
    settings: {},
    nodes: [],
    links: [],
    paths: [],
  };
}

/** خواندن وضعیت کامل و ساختاریافتهٔ فعلی یک دیاگرام از پایگاه‌داده. */
export function readSnapshot(diagramId) {
  const diagram = db.prepare('SELECT * FROM topology_diagrams WHERE id = ?').get(Number(diagramId));
  if (!diagram) return null;
  const nodes = db
    .prepare(
      `SELECT n.*, d.name AS device_name, d.ip AS device_ip, s.name AS site_name
       FROM topology_nodes n
       LEFT JOIN devices d ON d.id = n.device_id
       LEFT JOIN topology_sites s ON s.id = n.site_id
       WHERE n.diagram_id = ? ORDER BY n.z ASC, n.id ASC`
    )
    .all(diagram.id)
    .map((row) => ({
      id: row.id,
      kind: NODE_KINDS.has(row.kind) ? row.kind : 'note',
      deviceId: row.device_id ?? null,
      siteId: row.site_id ?? null,
      label: row.label || '',
      notes: row.notes || '',
      x: finite(row.x),
      y: finite(row.y),
      width: finite(row.width, 190),
      height: finite(row.height, 72),
      color: row.color || '',
      z: Math.round(finite(row.z)),
      meta: parseJson(row.meta, {}),
      deviceName: row.device_name || '',
      deviceIp: row.device_ip || '',
      siteName: row.site_name || '',
    }));
  const links = db
    .prepare('SELECT * FROM topology_links WHERE diagram_id = ? ORDER BY created_at ASC, id ASC')
    .all(diagram.id)
    .map((row) => ({
      id: row.id,
      from: row.from_node_id,
      to: row.to_node_id,
      kind: LINK_KINDS.has(row.kind) ? row.kind : 'ethernet',
      label: row.label || '',
      notes: row.notes || '',
      color: row.color || '',
      style: LINK_STYLES.has(row.style) ? row.style : 'solid',
      meta: parseJson(row.meta, {}),
      capacityMbps: Number.isFinite(Number(row.capacity_mbps)) && Number(row.capacity_mbps) > 0
        ? Number(row.capacity_mbps)
        : null,
      monitorDeviceId: row.monitor_device_id ?? null,
      telemetry: {
        enabled: !!row.telemetry_enabled,
        agent: row.telemetry_agent || '',
        ifIndex: row.telemetry_if_index ?? null,
      },
    }));
  const paths = db
    .prepare('SELECT * FROM topology_paths WHERE diagram_id = ? ORDER BY name COLLATE NOCASE, role DESC, created_at ASC')
    .all(diagram.id)
    .map((row) => ({
      id: row.id,
      name: row.name || '',
      role: row.role === 'backup' ? 'backup' : 'primary',
      nodeIds: parseJson(row.node_ids, []),
      linkIds: parseJson(row.link_ids, []),
    }));
  return {
    name: diagram.name || '',
    description: diagram.description || '',
    layout: diagram.layout || 'hierarchy-tb',
    locked: !!diagram.locked,
    isTemplate: !!diagram.is_template,
    settings: parseJson(diagram.settings, {}),
    nodes,
    links,
    paths,
  };
}

export function snapshotSummary(snapshot) {
  return {
    nodes: snapshot?.nodes?.length || 0,
    links: snapshot?.links?.length || 0,
    paths: snapshot?.paths?.length || 0,
    devices: (snapshot?.nodes || []).filter((n) => n.kind === 'device').length,
    sites: (snapshot?.nodes || []).filter((n) => n.kind === 'site').length,
  };
}

function nodeLookup(snapshot) {
  return new Map((snapshot?.nodes || []).map((node) => [node.id, node]));
}

function linkDisplayLabel(link, nodes) {
  if (link.label) return String(link.label).slice(0, 160);
  const from = nodes.get(link.from);
  const to = nodes.get(link.to);
  return `${nodeDisplayLabel(from)} ↔ ${nodeDisplayLabel(to)}`;
}

function sameValue(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function nodeFields(before, after) {
  const checks = [
    ['kind', before.kind, after.kind],
    ['deviceId', before.deviceId ?? null, after.deviceId ?? null],
    ['siteId', before.siteId ?? null, after.siteId ?? null],
    ['label', before.label || '', after.label || ''],
    ['notes', before.notes || '', after.notes || ''],
    ['position', { x: before.x, y: before.y }, { x: after.x, y: after.y }],
    ['size', { width: before.width, height: before.height }, { width: after.width, height: after.height }],
    ['color', before.color || '', after.color || ''],
    ['z', before.z, after.z],
    ['meta', before.meta || {}, after.meta || {}],
  ];
  return checks
    .filter(([, a, b]) => !sameValue(a, b))
    .map(([field, a, b]) => ({ field, label: FIELD_LABEL[field] || field, before: a, after: b }));
}

function linkFields(before, after) {
  const checks = [
    ['from', before.from, after.from],
    ['to', before.to, after.to],
    ['kind', before.kind, after.kind],
    ['label', before.label || '', after.label || ''],
    ['notes', before.notes || '', after.notes || ''],
    ['color', before.color || '', after.color || ''],
    ['style', before.style || 'solid', after.style || 'solid'],
    ['capacityMbps', before.capacityMbps ?? null, after.capacityMbps ?? null],
    ['monitorDeviceId', before.monitorDeviceId ?? null, after.monitorDeviceId ?? null],
    ['telemetry', before.telemetry || {}, after.telemetry || {}],
    ['meta', before.meta || {}, after.meta || {}],
  ];
  return checks
    .filter(([, a, b]) => !sameValue(a, b))
    .map(([field, a, b]) => ({ field, label: FIELD_LABEL[field] || field, before: a, after: b }));
}

function pathFields(before, after) {
  const checks = [
    ['name', before.name || '', after.name || ''],
    ['role', before.role, after.role],
    ['nodeIds', before.nodeIds || [], after.nodeIds || []],
    ['linkIds', before.linkIds || [], after.linkIds || []],
  ];
  return checks
    .filter(([, a, b]) => !sameValue(a, b))
    .map(([field, a, b]) => ({ field, label: FIELD_LABEL[field] || field, before: a, after: b }));
}

function metaFields(before, after) {
  const checks = [
    ['name', before.name || '', after.name || ''],
    ['description', before.description || '', after.description || ''],
    ['layout', before.layout || '', after.layout || ''],
    ['locked', !!before.locked, !!after.locked],
    ['isTemplate', !!before.isTemplate, !!after.isTemplate],
    ['settings', before.settings || {}, after.settings || {}],
  ];
  return checks
    .filter(([, a, b]) => !sameValue(a, b))
    .map(([field, a, b]) => ({ field, label: FIELD_LABEL[field] || field, before: a, after: b }));
}

function capped(list) {
  return { items: list.slice(0, MAX_CHANGE_ITEMS), truncated: list.length > MAX_CHANGE_ITEMS, total: list.length };
}

/**
 * مقایسهٔ دو Snapshot.
 * خروجی ساختاریافته با شمارش کامل و فهرست محدود (۲۰۰ مورد در هر دسته) است؛
 * «truncated» صریح می‌گوید فهرست کامل نیست، اما شمارش‌ها همیشه کامل‌اند.
 */
export function diffSnapshots(base, target) {
  const a = base || emptySnapshot();
  const b = target || emptySnapshot();
  const aNodes = nodeLookup(a);
  const bNodes = nodeLookup(b);
  const aLinks = new Map((a.links || []).map((link) => [link.id, link]));
  const bLinks = new Map((b.links || []).map((link) => [link.id, link]));
  const aPaths = new Map((a.paths || []).map((path) => [path.id, path]));
  const bPaths = new Map((b.paths || []).map((path) => [path.id, path]));

  const nodesAdded = [];
  const nodesRemoved = [];
  const nodesUpdated = [];
  for (const [id, after] of bNodes) {
    const before = aNodes.get(id);
    if (!before) {
      nodesAdded.push({ id, label: nodeDisplayLabel(after), kind: after.kind });
      continue;
    }
    const fields = nodeFields(before, after);
    if (fields.length) nodesUpdated.push({ id, label: nodeDisplayLabel(after), kind: after.kind, fields });
  }
  for (const [id, before] of aNodes) {
    if (!bNodes.has(id)) nodesRemoved.push({ id, label: nodeDisplayLabel(before), kind: before.kind });
  }

  const linksAdded = [];
  const linksRemoved = [];
  const linksUpdated = [];
  for (const [id, after] of bLinks) {
    const before = aLinks.get(id);
    if (!before) {
      linksAdded.push({ id, label: linkDisplayLabel(after, bNodes), kind: after.kind });
      continue;
    }
    const fields = linkFields(before, after);
    if (fields.length) linksUpdated.push({ id, label: linkDisplayLabel(after, bNodes), kind: after.kind, fields });
  }
  for (const [id, before] of aLinks) {
    if (!bLinks.has(id)) linksRemoved.push({ id, label: linkDisplayLabel(before, aNodes), kind: before.kind });
  }

  const pathsAdded = [];
  const pathsRemoved = [];
  const pathsUpdated = [];
  for (const [id, after] of bPaths) {
    const before = aPaths.get(id);
    if (!before) {
      pathsAdded.push({ id, label: after.name || 'مسیر', role: after.role });
      continue;
    }
    const fields = pathFields(before, after);
    if (fields.length) pathsUpdated.push({ id, label: after.name || 'مسیر', role: after.role, fields });
  }
  for (const [id, before] of aPaths) {
    if (!bPaths.has(id)) pathsRemoved.push({ id, label: before.name || 'مسیر', role: before.role });
  }

  const meta = metaFields(a, b);
  const s = {
    nodesAdded: nodesAdded.length,
    nodesRemoved: nodesRemoved.length,
    nodesUpdated: nodesUpdated.length,
    linksAdded: linksAdded.length,
    linksRemoved: linksRemoved.length,
    linksUpdated: linksUpdated.length,
    pathsAdded: pathsAdded.length,
    pathsRemoved: pathsRemoved.length,
    pathsUpdated: pathsUpdated.length,
    metadataUpdated: meta.length,
  };
  s.total =
    s.nodesAdded + s.nodesRemoved + s.nodesUpdated +
    s.linksAdded + s.linksRemoved + s.linksUpdated +
    s.pathsAdded + s.pathsRemoved + s.pathsUpdated +
    s.metadataUpdated;

  return {
    summary: s,
    nodes: { added: capped(nodesAdded), removed: capped(nodesRemoved), updated: capped(nodesUpdated) },
    links: { added: capped(linksAdded), removed: capped(linksRemoved), updated: capped(linksUpdated) },
    paths: { added: capped(pathsAdded), removed: capped(pathsRemoved), updated: capped(pathsUpdated) },
    meta,
  };
}

function serializeVersionRow(row) {
  const summary = parseJson(row.summary, {});
  const changes = parseJson(row.changes, {});
  return {
    id: row.id,
    diagramId: row.diagram_id,
    revision: row.revision,
    action: row.action,
    actionLabel: VERSION_ACTION_LABEL[row.action] || row.action,
    label: row.label || '',
    author: row.author || '',
    summary,
    changeSummary: changes.summary || {},
    restoredFrom: row.restored_from ?? null,
    sizeBytes: row.size_bytes ?? null,
    createdAt: row.created_at,
  };
}

/** ایجاد یک نسخه از وضعیت فعلی (یا Snapshot داده‌شده). */
export function createVersion(diagramId, {
  action = 'graph',
  label = '',
  author = '',
  restoredFrom = null,
  snapshot = null,
  force = false,
} = {}) {
  const id = Number(diagramId);
  const current = snapshot || readSnapshot(id);
  if (!current) return null;
  const previousRow = db
    .prepare('SELECT * FROM topology_versions WHERE diagram_id = ? ORDER BY id DESC LIMIT 1')
    .get(id);
  const previous = previousRow ? parseJson(gunzipSync(previousRow.snapshot).toString('utf8'), emptySnapshot()) : emptySnapshot();
  const changes = diffSnapshots(previous, current);
  if (!force && previousRow && changes.summary.total === 0) {
    return { ...serializeVersionRow(previousRow), skipped: true };
  }
  const diagram = db.prepare('SELECT revision FROM topology_diagrams WHERE id = ?').get(id);
  if (!diagram) return null;
  const summary = snapshotSummary(current);
  const compressed = gzipSync(Buffer.from(JSON.stringify(current), 'utf8'), { level: 6 });
  const now = Date.now();
  const result = transaction(
    () => {
      const inserted = db
        .prepare(
          `INSERT INTO topology_versions(
             diagram_id, revision, action, label, author, summary, changes, snapshot, size_bytes, restored_from, created_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          id,
          diagram.revision,
          action,
          String(label || '').slice(0, 240),
          String(author || '').slice(0, 80),
          JSON.stringify(summary),
          JSON.stringify(changes),
          compressed,
          compressed.length,
          restoredFrom,
          now
        );
      db.prepare(
        `DELETE FROM topology_versions WHERE diagram_id = ? AND id NOT IN (
           SELECT id FROM topology_versions WHERE diagram_id = ? ORDER BY id DESC LIMIT ?
         )`
      ).run(id, id, MAX_VERSIONS_PER_DIAGRAM);
      return Number(inserted.lastInsertRowid);
    },
    { label: 'topology.version.create' }
  );
  const row = db.prepare('SELECT * FROM topology_versions WHERE id = ?').get(result);
  return serializeVersionRow(row);
}

export function listVersions(diagramId, { limit = 50, before = null } = {}) {
  // دیاگرام‌هایی که پیش از فعال‌شدن تاریخچه ساخته شده‌اند نسخه ندارند؛
  // نخستین مشاهدهٔ تاریخچه، وضعیت موجود را به‌عنوان «نسخهٔ پایه» ثبت می‌کند
  // تا کاربر بدون نیاز به ویرایش، نقطهٔ بازگشت داشته باشد.
  const existing = db.prepare('SELECT id FROM topology_versions WHERE diagram_id = ? LIMIT 1').get(Number(diagramId));
  if (!existing) {
    createVersion(diagramId, {
      action: 'baseline',
      label: 'نسخهٔ پایهٔ وضعیت موجود',
      force: true,
    });
  }
  const size = Math.max(1, Math.min(200, Math.round(Number(limit) || 50)));
  const cutoff = Number(before);
  const rows = Number.isInteger(cutoff) && cutoff > 0
    ? db
        .prepare('SELECT * FROM topology_versions WHERE diagram_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
        .all(Number(diagramId), cutoff, size)
    : db
        .prepare('SELECT * FROM topology_versions WHERE diagram_id = ? ORDER BY id DESC LIMIT ?')
        .all(Number(diagramId), size);
  return {
    items: rows.map(serializeVersionRow),
    limit: size,
    nextBefore: rows.length === size ? rows[rows.length - 1].id : null,
    retention: MAX_VERSIONS_PER_DIAGRAM,
  };
}

export function getVersion(diagramId, versionId) {
  const row = db
    .prepare('SELECT * FROM topology_versions WHERE id = ? AND diagram_id = ?')
    .get(Number(versionId), Number(diagramId));
  if (!row) return null;
  return {
    ...serializeVersionRow(row),
    snapshot: parseJson(gunzipSync(row.snapshot).toString('utf8'), emptySnapshot()),
    changes: parseJson(row.changes, diffSnapshots(emptySnapshot(), emptySnapshot())),
  };
}

/**
 * بازگردانی Snapshot به دیاگرام.
 * شناسه‌های تجهیز/مرکز که در این فاصله حذف شده‌اند null می‌شوند تا ارجاع
 * شکسته ساخته نشود؛ گره و ساختار حفظ می‌شود. لینک‌هایی که یک سرشان از
 * Snapshot معتبر نیستند حذف می‌شوند و در warnings گزارش می‌شوند.
 */
export function restoreSnapshot(diagramId, snapshot, { expectedRevision = null } = {}) {
  const id = Number(diagramId);
  const diagram = db.prepare('SELECT * FROM topology_diagrams WHERE id = ?').get(id);
  if (!diagram) return { error: 'not-found' };
  if (expectedRevision != null && Number(expectedRevision) !== Number(diagram.revision)) {
    return { error: 'revision-mismatch', revision: diagram.revision };
  }
  const source = snapshot || emptySnapshot();
  const warnings = [];
  const devices = new Set(db.prepare('SELECT id FROM devices').all().map((row) => row.id));
  const sites = new Set(db.prepare('SELECT id FROM topology_sites').all().map((row) => row.id));

  const nodes = [];
  const nodeIds = new Set();
  for (const raw of Array.isArray(source.nodes) ? source.nodes : []) {
    if (!raw || !ID_RE.test(String(raw.id || '')) || nodeIds.has(raw.id)) {
      warnings.push('یک گره با شناسهٔ نامعتبر در نسخه نادیده گرفته شد.');
      continue;
    }
    const kind = NODE_KINDS.has(raw.kind) ? raw.kind : 'note';
    const deviceId = raw.deviceId != null && devices.has(Number(raw.deviceId)) ? Number(raw.deviceId) : null;
    const siteId = raw.siteId != null && sites.has(Number(raw.siteId)) ? Number(raw.siteId) : null;
    if (raw.deviceId != null && deviceId == null) warnings.push(`تجهیز گره «${nodeDisplayLabel(raw)}» دیگر وجود ندارد و اتصال آن خالی شد.`);
    if (raw.siteId != null && siteId == null) warnings.push(`مرکز تجمع گره «${nodeDisplayLabel(raw)}» دیگر وجود ندارد و اتصال آن خالی شد.`);
    nodes.push({
      id: raw.id,
      kind,
      deviceId,
      siteId,
      label: text(raw.label).slice(0, 160),
      notes: text(raw.notes).slice(0, 4000),
      x: finite(raw.x),
      y: finite(raw.y),
      width: Math.min(800, Math.max(80, finite(raw.width, 190))),
      height: Math.min(600, Math.max(40, finite(raw.height, 72))),
      color: /^#[0-9a-fA-F]{6}$/.test(String(raw.color || '')) ? raw.color : '',
      z: Math.round(finite(raw.z)),
      meta: JSON.stringify(raw.meta && typeof raw.meta === 'object' ? raw.meta : {}).slice(0, 2000),
    });
    nodeIds.add(raw.id);
  }

  const links = [];
  const linkIds = new Set();
  const pairs = new Set();
  for (const raw of Array.isArray(source.links) ? source.links : []) {
    if (!raw || !ID_RE.test(String(raw.id || '')) || linkIds.has(raw.id)) continue;
    if (!nodeIds.has(raw.from) || !nodeIds.has(raw.to) || raw.from === raw.to) {
      warnings.push(`لینک «${raw.label || raw.id}» به گره‌ای خارج از نسخه اشاره می‌کرد و بازگردانی نشد.`);
      continue;
    }
    const pair = [raw.from, raw.to].sort().join('|');
    if (pairs.has(pair)) continue;
    pairs.add(pair);
    const capacity = Number(raw.capacityMbps);
    links.push({
      id: raw.id,
      from: raw.from,
      to: raw.to,
      kind: LINK_KINDS.has(raw.kind) ? raw.kind : 'ethernet',
      label: text(raw.label).slice(0, 160),
      notes: text(raw.notes).slice(0, 4000),
      color: /^#[0-9a-fA-F]{6}$/.test(String(raw.color || '')) ? raw.color : '',
      style: LINK_STYLES.has(raw.style) ? raw.style : 'solid',
      meta: JSON.stringify(raw.meta && typeof raw.meta === 'object' ? raw.meta : {}).slice(0, 2000),
      capacityMbps: Number.isFinite(capacity) && capacity > 0 ? capacity : null,
      monitorDeviceId: raw.monitorDeviceId != null && devices.has(Number(raw.monitorDeviceId)) ? Number(raw.monitorDeviceId) : null,
      telemetryEnabled: raw.telemetry?.enabled === true ? 1 : 0,
      telemetryAgent: raw.telemetry?.enabled === true ? text(raw.telemetry?.agent) : '',
      telemetryIfIndex: raw.telemetry?.enabled === true && Number.isInteger(Number(raw.telemetry?.ifIndex))
        ? Number(raw.telemetry?.ifIndex)
        : null,
    });
    linkIds.add(raw.id);
  }

  const paths = [];
  const pathIds = new Set();
  for (const raw of Array.isArray(source.paths) ? source.paths : []) {
    if (!raw || !ID_RE.test(String(raw.id || '')) || pathIds.has(raw.id)) continue;
    const ids = (Array.isArray(raw.nodeIds) ? raw.nodeIds : []).filter((value) => nodeIds.has(value));
    if (ids.length < 2) {
      warnings.push(`مسیر «${raw.name || raw.id}» گره‌های کافی نداشت و بازگردانی نشد.`);
      continue;
    }
    paths.push({
      id: raw.id,
      name: text(raw.name).slice(0, 120),
      role: raw.role === 'backup' ? 'backup' : 'primary',
      nodeIds: ids,
      linkIds: (Array.isArray(raw.linkIds) ? raw.linkIds : []).filter((value) => linkIds.has(value)),
    });
    pathIds.add(raw.id);
  }

  const ownership = new Map();
  const nodeIdList = [...nodeIds];
  const linkIdList = [...linkIds];
  for (const batch of chunkIds([...nodeIdList, ...linkIdList])) {
    const rows = db
      .prepare(
        `SELECT id, diagram_id FROM topology_nodes WHERE id IN (${batch.map(() => '?').join(',')})
         UNION ALL
         SELECT id, diagram_id FROM topology_links WHERE id IN (${batch.map(() => '?').join(',')})`
      )
      .all(...batch, ...batch);
    for (const row of rows) ownership.set(row.id, row.diagram_id);
  }
  for (const nodeId of nodeIdList) {
    const owner = ownership.get(nodeId);
    if (owner != null && Number(owner) !== id) return { error: 'id-conflict', id: nodeId };
  }
  for (const linkId of linkIdList) {
    const owner = ownership.get(linkId);
    if (owner != null && Number(owner) !== id) return { error: 'id-conflict', id: linkId };
  }

  const now = Date.now();
  transaction(
    () => {
      db.prepare('DELETE FROM topology_links WHERE diagram_id = ?').run(id);
      db.prepare('DELETE FROM topology_nodes WHERE diagram_id = ?').run(id);
      db.prepare('DELETE FROM topology_paths WHERE diagram_id = ?').run(id);
      db.prepare('DELETE FROM topology_link_telemetry WHERE diagram_id = ?').run(id);

      const insertNode = db.prepare(
        `INSERT INTO topology_nodes(
           id, diagram_id, kind, device_id, site_id, label, notes, x, y, width, height, color, z, meta, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (const node of nodes) {
        insertNode.run(
          node.id, id, node.kind, node.deviceId, node.siteId, node.label, node.notes,
          node.x, node.y, node.width, node.height, node.color, node.z, node.meta, now, now
        );
      }
      const insertLink = db.prepare(
        `INSERT INTO topology_links(
           id, diagram_id, from_node_id, to_node_id, kind, label, notes, color, style, meta,
           capacity_mbps, monitor_device_id, telemetry_enabled, telemetry_agent, telemetry_if_index,
           created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (const link of links) {
        insertLink.run(
          link.id, id, link.from, link.to, link.kind, link.label, link.notes, link.color, link.style, link.meta,
          link.capacityMbps, link.monitorDeviceId, link.telemetryEnabled, link.telemetryAgent,
          link.telemetryIfIndex, now, now
        );
      }
      const insertPath = db.prepare(
        `INSERT INTO topology_paths(id, diagram_id, name, role, node_ids, link_ids, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`
      );
      for (const path of paths) {
        insertPath.run(path.id, id, path.name, path.role, JSON.stringify(path.nodeIds), JSON.stringify(path.linkIds), now, now);
      }
      db.prepare(
        `UPDATE topology_diagrams
         SET name = ?, description = ?, layout = ?, locked = ?, settings = ?,
             revision = revision + 1, updated_at = ?
         WHERE id = ?`
      ).run(
        String(source.name || diagram.name || '').slice(0, 120),
        String(source.description || '').slice(0, 500),
        String(source.layout || diagram.layout || 'hierarchy-tb'),
        source.locked ? 1 : 0,
        JSON.stringify(source.settings && typeof source.settings === 'object' ? source.settings : {}).slice(0, 2000),
        now,
        id
      );
    },
    { label: 'topology.version.restore' }
  );

  return {
    ok: true,
    warnings,
    summary: { nodes: nodes.length, links: links.length, paths: paths.length },
  };
}

function chunkIds(list, size = 400) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

