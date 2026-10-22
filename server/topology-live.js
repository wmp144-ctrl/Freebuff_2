/**
 * NetWatch — وضعیت زندهٔ دیاگرام ارتباطات (مرحلهٔ ۲)
 * ----------------------------------------------------------------
 * این ماژول مستقل از مسیرهای HTTP است و فقط از داده‌های موجود مانیتورینگ
 * (devices + samples + engine status) می‌خواند. هیچ پروب شبکه‌ای در این‌جا
 * اجرا نمی‌شود؛ وضعیت لینک فقط بازتاب آخرین نتیجه‌های موتور است.
 *
 * قواعد وضعیت لینک (چهار رنگ مشخص):
 *   • سبز (up)       هر دو سر سالم و افت/تأخیر/نوسان زیر آستانه
 *   • قرمز (down)    یکی از تجهیزات دو سر قطع است
 *   • زرد (degraded) اختلال: افت بسته/تأخیر/نوسان بالاتر از آستانه
 *   • خاکستری (unknown) دادهٔ تازه/کافی وجود ندارد (تجهیز قدیمی، بدون منبع،
 *                     نگهداری یا لینک بدون تجهیز مرجع)
 *
 * سنجش ترافیک اینترفیس (که پیش‌تر با SNMP انجام می‌شد) از محصول حذف شده است؛
 * بنابراین مصرف/اشغال ظرفیت ساخته نمی‌شود و در پاسخ وجود ندارد. ظرفیت اسمی
 * (`capacityMbps`) فقط یک مشخصهٔ ثبت‌شده توسط کاربر است و برای تحلیل مسیرها
 * به کار می‌رود.
 */
import { db, getSettings } from './db.js';

export const LINK_STATUS = Object.freeze({
  UP: 'up',
  DOWN: 'down',
  DEGRADED: 'degraded',
  UNKNOWN: 'unknown',
});

/** آستانه‌های پیش‌فرض (قابل بازنویسی در تنظیمات/هر لینک در آینده) */
export const DEFAULT_JITTER_LIMIT_MS = 40;
// کش کوتاه: چند کاربر هم‌زمان نباید در هر ثانیه چندبار محاسبهٔ کل دیاگرام را
// تحمیل کنند؛ بازهٔ تازه‌سازی رابط ۱۰ ثانیه است، پس ۳ ثانیه تأخیر محسوس نیست.
const SNAPSHOT_TTL_MS = 3000;
const MAX_CACHE_ENTRIES = 64;
const JITTER_WINDOW_MS = 30 * 60 * 1000;
const JITTER_SAMPLES = 10;

const cache = new Map();

/** پاک‌کردن کش یک دیاگرام (پس از ذخیره/تغییر وضعیت/سنجش تازه) */
export function invalidateLiveCache(diagramId = null) {
  if (diagramId == null) {
    cache.clear();
    return;
  }
  const id = Number(diagramId);
  for (const key of cache.keys()) {
    if (key === id) cache.delete(key);
  }
}

function settingsSafe() {
  try {
    return getSettings();
  } catch {
    return {};
  }
}

function clampNumber(value, min, max, fallback = null) {
  // Number(null) === 0 است؛ برای پرهیز از تبدیل «ناموجود» به صفر واقعی،
  // تهی‌بودن را صریح بررسی می‌کنیم.
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * نوسان تأخیر: میانگین قدرمطلق اختلاف نمونه‌های متوالی (ms).
 * این معیار همان مفهومی است که در پایش کیفیت مسیر استفاده می‌شود و به
 * نمونه‌های کم‌حجم (۵ تا ۱۰ نمونه) حساس نیست.
 * @param {number[]} values نمونه‌ها به ترتیب زمانی (قدیمی → جدید)
 */
export function jitterFromRtts(values) {
  const clean = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (clean.length < 2) return null;
  let sum = 0;
  for (let i = 1; i < clean.length; i += 1) sum += Math.abs(clean[i] - clean[i - 1]);
  return Math.round((sum / (clean.length - 1)) * 100) / 100;
}

/**
 * آیا دادهٔ یک تجهیز تازه است؟
 * دادهٔ قدیمی‌تر از ۳ بازهٔ پایش (حداقل ۹۰ ثانیه) یا تجهیز غیرفعال/در حال
 * نگهداری، «نامشخص» شمرده می‌شود؛ نمایش «قطع» برای دادهٔ کهنه گمراه‌کننده است.
 */
export function deviceFreshness(device, { now = Date.now(), defaultIntervalSec = 30 } = {}) {
  const intervalSec = clampNumber(device?.ping_interval, 5, 86400, defaultIntervalSec) || defaultIntervalSec;
  const staleAfterMs = Math.max(intervalSec * 1000 * 3, 90000);
  const lastCheckAt = Number(device?.last_check_at) || null;
  const ageMs = lastCheckAt ? Math.max(0, now - lastCheckAt) : null;
  const monitoringEnabled = device?.monitoring_enabled !== 0;
  const stale = !lastCheckAt || ageMs > staleAfterMs || !monitoringEnabled;
  return { stale, ageMs, staleAfterMs, monitoringEnabled, lastCheckAt };
}

/** وضعیت مؤثر یک تجهیز برای نمایش در دیاگرام */
export function effectiveDeviceStatus(device, freshness) {
  if (!device) return 'unknown';
  if (!freshness || freshness.stale) return 'unknown';
  const status = String(device.status || 'unknown');
  return ['online', 'offline', 'warning', 'maintenance', 'unknown'].includes(status) ? status : 'unknown';
}

/**
 * محاسبهٔ وضعیت یک لینک از منابع سنجش.
 *
 * @param {object} link  ردیف لینک (با live fields)
 * @param {object[]} sources تجهیزات دو سر لینک/تجهیز مرجع (خروجی deviceLive)
 * @param {{settings?:object, now?:number}} context
 */
export function classifyLink(link, sources = [], { settings = {}, now = Date.now() } = {}) {
  const latencyLimit = clampNumber(settings.latency_threshold, 1, 60000, 150);
  const lossLimit = clampNumber(settings.loss_threshold, 0, 100, 10);
  const jitterLimit = clampNumber(settings.topology_jitter_threshold_ms, 1, 10000, DEFAULT_JITTER_LIMIT_MS);

  const freshSources = sources.filter((s) => s && !s.stale);
  const reporting = freshSources.filter((s) => s.status !== 'unknown');
  const rttValues = reporting.map((s) => finiteNumber(s.lastRtt)).filter((v) => v != null);
  const maxRtt = rttValues.length ? Math.max(...rttValues) : null;
  const maxLoss = reporting.length
    ? Math.max(...reporting.map((s) => finiteNumber(s.lossPct) ?? 0))
    : null;
  const jitterValues = reporting.map((s) => finiteNumber(s.jitterMs)).filter((v) => v != null);
  const maxJitter = jitterValues.length ? Math.max(...jitterValues) : null;
  const linkCapacity = finiteNumber(link?.capacity_mbps);
  const capacityMbps = linkCapacity != null && linkCapacity > 0 ? linkCapacity : null;

  let status;
  let reasonCode;
  let reason;

  if (!sources.length) {
    status = LINK_STATUS.UNKNOWN;
    reasonCode = 'no-source';
    reason = 'هیچ تجهیز مرجعی برای سنجش این لینک وجود ندارد.';
  } else if (!freshSources.length) {
    status = LINK_STATUS.UNKNOWN;
    reasonCode = 'stale';
    reason = 'دادهٔ آخرین بررسی تجهیزات این لینک کهنه است.';
  } else if (freshSources.some((s) => s.status === 'offline')) {
    status = LINK_STATUS.DOWN;
    reasonCode = 'endpoint-offline';
    reason = 'دست‌کم یکی از تجهیزات دو سر لینک قطع است.';
  } else if (freshSources.length < sources.length) {
    // اگر یکی از دو سر دادهٔ تازه نداشته باشد، سلامت لینک قابل تأیید نیست؛
    // «سبز» یا «زرد» نشان‌دادن آن، ادعای بی‌پشتوانه است.
    status = LINK_STATUS.UNKNOWN;
    reasonCode = 'partial-stale';
    reason = 'دادهٔ یکی از تجهیزات دو سر لینک کهنه است.';
  } else if (reporting.length === 0 || freshSources.some((s) => s.status === 'unknown' || s.status === 'maintenance')) {
    status = LINK_STATUS.UNKNOWN;
    reasonCode = 'endpoint-unknown';
    reason = 'وضعیت تجهیزات این لینک نامشخص یا در حال نگهداری است.';
  } else if (freshSources.some((s) => s.status === 'warning')) {
    status = LINK_STATUS.DEGRADED;
    reasonCode = 'endpoint-warning';
    reason = 'یکی از تجهیزات دو سر لینک در وضعیت هشدار است.';
  } else if (maxLoss != null && maxLoss > lossLimit) {
    status = LINK_STATUS.DEGRADED;
    reasonCode = 'loss';
    reason = `افت بسته (${maxLoss.toFixed(1)}٪) از آستانهٔ ${lossLimit}٪ بیشتر است.`;
  } else if (maxRtt != null && maxRtt > latencyLimit) {
    status = LINK_STATUS.DEGRADED;
    reasonCode = 'latency';
    reason = `تأخیر (${Math.round(maxRtt)}ms) از آستانهٔ ${latencyLimit}ms بیشتر است.`;
  } else if (maxJitter != null && maxJitter > jitterLimit) {
    status = LINK_STATUS.DEGRADED;
    reasonCode = 'jitter';
    reason = `نوسان تأخیر (${maxJitter}ms) از آستانهٔ ${jitterLimit}ms بیشتر است.`;
  } else {
    status = LINK_STATUS.UP;
    reasonCode = 'healthy';
    reason = 'ارتباط فعال و شاخص‌ها در محدودهٔ مجاز است.';
  }

  return {
    status,
    reasonCode,
    reason,
    latencyMs: maxRtt != null ? Math.round(maxRtt * 10) / 10 : null,
    lossPct: maxLoss != null ? Math.round(maxLoss * 10) / 10 : null,
    jitterMs: maxJitter,
    capacityMbps,
    sourceCount: sources.length,
    reportingCount: reporting.length,
    stale: status === LINK_STATUS.UNKNOWN && reasonCode === 'stale',
    updatedAt: now,
  };
}

/** خروجی سبک یک تجهیز برای وضعیت زنده (بدون مشخصات فنی) */
export function deviceLive(row, { now = Date.now(), settings = {} } = {}) {
  if (!row) return null;
  const freshness = deviceFreshness(row, { now, defaultIntervalSec: settings.ping_interval ?? 30 });
  return {
    id: row.id,
    name: row.name || '',
    ip: row.ip || '',
    status: effectiveDeviceStatus(row, freshness),
    reportedStatus: row.status || 'unknown',
    statusReason: row.status_reason || '',
    stale: freshness.stale,
    ageMs: freshness.ageMs,
    lastRtt: finiteNumber(row.last_rtt_ms),
    lossPct: finiteNumber(row.loss_pct) ?? 0,
    jitterMs: null,
    lastCheckAt: row.last_check_at ?? null,
    monitoringEnabled: freshness.monitoringEnabled,
  };
}

function chunks(list, size = 400) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** نوسان تأخیر هر تجهیز از آخرین نمونه‌های موفق (پنجرهٔ ۳۰ دقیقه) */
function loadJitter(deviceIds, now) {
  const out = new Map();
  const ids = [...new Set(deviceIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return out;
  const since = now - JITTER_WINDOW_MS;
  for (const batch of chunks(ids)) {
    const placeholders = batch.map(() => '?').join(',');
    let rows;
    try {
      rows = db
        .prepare(
          `SELECT device_id, rtt_ms, ts FROM (
             SELECT device_id, rtt_ms, ts,
                    ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY ts DESC) AS rn
             FROM samples
             WHERE device_id IN (${placeholders}) AND ts >= ? AND rtt_ms IS NOT NULL
           ) WHERE rn <= ?`
        )
        .all(...batch, since, JITTER_SAMPLES);
    } catch {
      // پایگاه‌دادهٔ قدیمی بدون نمونه/پنجره: نوسان نامشخص می‌ماند، خطا بالا نمی‌رود.
      rows = [];
    }
    const grouped = new Map();
    for (const row of rows) {
      if (!grouped.has(row.device_id)) grouped.set(row.device_id, []);
      grouped.get(row.device_id).push(row);
    }
    for (const [deviceId, list] of grouped) {
      list.sort((a, b) => a.ts - b.ts);
      out.set(deviceId, jitterFromRtts(list.map((r) => r.rtt_ms)));
    }
  }
  return out;
}

/**
 * Snapshot وضعیت زندهٔ یک دیاگرام.
 * @param {number|string} diagramId
 * @param {{now?:number, useCache?:boolean}} options
 */
export function buildLiveStatus(diagramId, { now = Date.now(), useCache = true } = {}) {
  const id = Number(diagramId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const cached = cache.get(id);
  if (useCache && cached && now - cached.at < SNAPSHOT_TTL_MS) {
    return { ...cached.payload, cached: true };
  }

  const diagram = db.prepare('SELECT id, revision FROM topology_diagrams WHERE id = ?').get(id);
  if (!diagram) return null;

  const nodeRows = db
    .prepare('SELECT id, kind, device_id, site_id FROM topology_nodes WHERE diagram_id = ? ORDER BY z ASC, id ASC')
    .all(id);
  const linkRows = db
    .prepare(
      `SELECT id, from_node_id, to_node_id, capacity_mbps, monitor_device_id
       FROM topology_links WHERE diagram_id = ? ORDER BY created_at ASC, id ASC`
    )
    .all(id);

  const nodeById = new Map(nodeRows.map((n) => [n.id, n]));
  const deviceIds = new Set();
  for (const n of nodeRows) if (n.device_id != null) deviceIds.add(n.device_id);
  for (const l of linkRows) if (l.monitor_device_id != null) deviceIds.add(l.monitor_device_id);

  const settings = settingsSafe();
  const jitterMap = loadJitter([...deviceIds], now);
  const deviceMap = new Map();
  for (const batch of chunks([...deviceIds])) {
    const placeholders = batch.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT id, name, ip, status, status_reason, last_check_at, last_rtt_ms, loss_pct,
                ping_interval, monitoring_enabled
         FROM devices WHERE id IN (${placeholders})`
      )
      .all(...batch);
    for (const row of rows) {
      const live = deviceLive(row, { now, settings });
      live.jitterMs = jitterMap.get(row.id) ?? null;
      deviceMap.set(row.id, live);
    }
  }

  // گره‌ها: وضعیت تجهیز + نوسان؛ گره مرکز تجمع شمارش تجهیزات همان مرکز.
  const nodes = nodeRows.map((node) => {
    const device = node.device_id != null ? deviceMap.get(node.device_id) || null : null;
    return {
      id: node.id,
      deviceId: node.device_id ?? null,
      kind: node.kind,
      name: device?.name ?? null,
      ip: device?.ip ?? null,
      status: device?.status || 'unknown',
      reportedStatus: device?.reportedStatus || 'unknown',
      statusReason: device?.statusReason || '',
      stale: device?.stale ?? true,
      lastRtt: device?.lastRtt ?? null,
      lossPct: device?.lossPct ?? 0,
      jitterMs: device?.jitterMs ?? null,
      lastCheckAt: device?.lastCheckAt ?? null,
    };
  });

  const links = linkRows.map((link) => {
    const endpointIds = new Set();
    for (const nodeId of [link.from_node_id, link.to_node_id]) {
      const node = nodeById.get(nodeId);
      if (node?.kind === 'device' && node.device_id != null) endpointIds.add(node.device_id);
    }
    if (link.monitor_device_id != null) endpointIds.add(link.monitor_device_id);
    const sources = [...endpointIds].map((deviceId) => deviceMap.get(deviceId)).filter(Boolean);
    // فهرست کامل منابع در پاسخ تکرار نمی‌شود؛ برای شبکه‌های بزرگ، حجم
    // Snapshot ده‌ها برابر می‌شد. شمارش و وضعیت نهایی برای نمایش کافی است و
    // جزئیات هر تجهیز از گرهٔ همان تجهیز/پروندهٔ تجهیز در دسترس است.
    return { id: link.id, ...classifyLink(link, sources, { settings, now }) };
  });

  const sites = db
    .prepare(
      `SELECT s.id, s.name,
         (SELECT COUNT(*) FROM topology_site_devices sd WHERE sd.site_id = s.id) AS device_count,
         (SELECT COUNT(*) FROM topology_site_devices sd JOIN devices dv ON dv.id = sd.device_id
           WHERE sd.site_id = s.id AND dv.status = 'online') AS online_count
       FROM topology_sites s`
    )
    .all()
    .map((s) => ({ id: s.id, name: s.name, deviceCount: s.device_count ?? 0, onlineCount: s.online_count ?? 0 }));

  const summary = { up: 0, down: 0, degraded: 0, unknown: 0 };
  for (const link of links) {
    summary[link.status] += 1;
  }

  const payload = {
    revision: diagram.revision,
    generatedAt: now,
    nodes,
    links,
    sites,
    summary,
  };
  cache.set(id, { at: now, payload });
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return payload;
}

/** وضعیت زنده فقط برای لینک‌های یک دیاگرام (برای سازگاری/آزمون) */
export function liveLinks(diagramId) {
  const snapshot = buildLiveStatus(diagramId);
  return snapshot?.links ?? [];
}
