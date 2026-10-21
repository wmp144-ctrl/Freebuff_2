/**
 * NetWatch — کشف شبکه (Network Discovery)
 * ----------------------------------------------------------------
 * محدوده‌های ذخیره‌شده فقط وقتی قابل اسکن‌اند که کاملاً زیرمجموعهٔ
 * `probe_allowed_cidrs` باشند (همان سیاست Probe؛ پیش‌فرض: شبکه‌های خصوصی).
 * هیچ ارسال ICMP/RAW لازم نیست: کشف با اتصال TCP کوتاه به چند پورت رایج
 * انجام می‌شود که بدون دسترسی root هم کار می‌کند.
 *
 * مرزهای منابع:
 *   • حداکثر ۳۲ محدوده و هر محدوده حداکثر `discovery_max_hosts` (پیش‌فرض ۲۵۶)
 *   • هم‌زمانی `discovery_concurrency` (پیش‌فرض ۱۶) و مهلت هر اتصال ۶۰۰ms
 *   • فقط یک اسکن هم‌زمان در هر فرآیند؛ اسکن بعدی ۴۰۹ می‌گیرد
 *   • هر میزبان حداکثر ۴ پورت، پورت‌های باز در یک فهرست کوتاه
 *
 * شناسایی تکراری: IP هر تجهیز ثبت‌شده و هر نتیجهٔ موجود مقایسه می‌شود؛
 * میزبان تکراری هرگز دوباره در فهرست کشف‌شده‌ها ثبت نمی‌شود. نتایج کشف‌شده
 * پس از `discovery_retain_hours` (پیش‌فرض ۲۴ ساعت) فقط از همین فهرست حذف
 * می‌شوند و تجهیز ثبت‌شده در سامانه دست‌نخورده می‌ماند.
 */
import net from 'node:net';
import crypto from 'node:crypto';
import { db, getSettings, transaction } from './db.js';
import { logEvent } from './logger.mjs';
import { normalizeCidrList, parseCidr, resolveProbeCidrs, isProbeTargetAllowed } from './net-policy.js';

export const MAX_RANGES = 32;
export const HARD_MAX_HOSTS = 2048;
export const MAX_PORTS = 4;
// سقف کل آدرس‌های یک اسکن (همهٔ محدوده‌ها با هم)؛ مانع مصرف بی‌رویهٔ CPU/شبکه.
export const SCAN_HOST_BUDGET = 2048;

let notifier = null;
/** اعلان هشدارها (از index.js به bus/SSE وصل می‌شود)؛ در آزمون‌ها بی‌اثر است. */
export function setDiscoveryNotifier(fn) {
  notifier = typeof fn === 'function' ? fn : null;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function bigIntToIpv4(bits) {
  return [24n, 16n, 8n, 0n].map((shift) => String((bits >> shift) & 255n)).join('.');
}

function bigIntToIpv6(bits) {
  const groups = [];
  for (let i = 7; i >= 0; i--) groups.push(((bits >> BigInt(i * 16)) & 0xffffn).toString(16));
  // ساده‌سازی صفرهای پیوسته فقط برای خوانایی؛ آدرس همچنان معتبر است.
  return groups.join(':').replace(/(^|:)(0:){2,}/, (m) => (m.startsWith(':') ? '::' : ':')).replace(/:{3,}/, '::');
}

/** تعداد میزبان‌های یک CIDR (بدون سرریز) */
export function hostCount(cidr) {
  const parsed = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  if (!parsed) return 0;
  const bits = parsed.version === 4 ? 32 : 128;
  const hostBits = BigInt(bits - parsed.prefix);
  if (hostBits > 40n) return Number.MAX_SAFE_INTEGER;
  return 2 ** Number(hostBits);
}

/**
 * فهرست آدرس‌های قابل اسکن یک CIDR.
 * برای IPv4 با prefix ≤ ۳۰ آدرس شبکه و broadcast حذف می‌شوند (هرگز میزبان
 * واقعی نیستند)؛ سقف سخت از قبل اعمال شده است.
 */
export function expandHosts(cidr, maxHosts = 256) {
  const parsed = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  if (!parsed) return [];
  const total = hostCount(parsed);
  if (total > HARD_MAX_HOSTS) return [];
  let start = parsed.network;
  let end = parsed.network + BigInt(total) - 1n;
  if (parsed.version === 4 && parsed.prefix <= 30) {
    start += 1n;
    end -= 1n;
  }
  const out = [];
  const limit = Math.min(maxHosts, HARD_MAX_HOSTS);
  for (let v = start; v <= end && out.length < limit; v += 1n) {
    out.push(parsed.version === 4 ? bigIntToIpv4(v) : bigIntToIpv6(v));
  }
  return out;
}

/** آیا CIDR کاملاً داخل یکی از CIDRهای مجاز است؟ */
export function isRangeAllowed(cidr, allowedCidrs) {
  const range = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  if (!range || typeof range.network !== 'bigint' || typeof range.mask !== 'bigint') return false;
  const allowed = (allowedCidrs || []).map(parseCidr).filter(Boolean);
  for (const a of allowed) {
    if (a.version !== range.version) continue;
    if (range.prefix < a.prefix) continue;
    if ((range.network & a.mask) !== a.network) continue;
    // لبهٔ بالای محدوده هم باید داخل شبکهٔ مجاز بیفتد
    const bits = range.version === 4 ? 32 : 128;
    const last = range.network + (1n << BigInt(bits - range.prefix)) - 1n;
    if ((last & a.mask) !== a.network) continue;
    return true;
  }
  return false;
}

/**
 * اعتبارسنجی ورودی محدوده؛ خطای فارسی و قابل‌نمایش پرتاب می‌کند.
 * @returns {{name:string,cidr:string,enabled:number,interval_hours:number,notes:string,hosts:number}}
 */
export function validateRangeInput(input = {}, { settings = getSettings() } = {}) {
  const name = String(input.name ?? '').trim().slice(0, 120);
  if (!name) throw new Error('نام محدوده الزامی است.');
  const cidr = String(input.cidr ?? '').trim();
  const parsed = parseCidr(cidr);
  if (!parsed) throw new Error('محدودهٔ CIDR معتبر نیست (نمونه: 192.168.10.0/24).');
  const hosts = hostCount(parsed);
  const maxHosts = clampInt(settings.discovery_max_hosts, 1, HARD_MAX_HOSTS, 256);
  if (hosts > maxHosts) {
    throw new Error(`محدوده بیش از سقف مجاز ${maxHosts} میزبان دارد (${hosts}). یک زیرشبکهٔ کوچک‌تر تعریف کنید.`);
  }
  if (hosts <= 0) throw new Error('محدوده هیچ میزبان قابل اسکنی ندارد.');
  const allowed = normalizeCidrList(resolveProbeCidrs(settings)) || [];
  if (!isRangeAllowed(parsed, allowed)) {
    throw new Error('این محدوده داخل شبکه‌های مجاز Probe نیست؛ ابتدا محدوده‌های مجاز را در تنظیمات گسترش دهید.');
  }
  // آدرس‌های ابتدا/انتها باید از سیاست امنیتی هم عبور کنند (Link-Local و Metadata).
  const sample = expandHosts(parsed, 2);
  for (const ip of sample) {
    if (!isProbeTargetAllowed(ip, settings).allowed) {
      throw new Error('محدوده شامل آدرس‌های مسدود (Link-Local/Metadata) است و مجاز نیست.');
    }
  }
  const count = db.prepare('SELECT COUNT(*) AS c FROM discovery_ranges').get().c;
  if (count >= MAX_RANGES) throw new Error(`حداکثر ${MAX_RANGES} محدوده قابل تعریف است.`);
  return {
    name,
    cidr: `${parsed.source.split('/')[0]}/${parsed.prefix}`,
    enabled: input.enabled === undefined ? 1 : Number(input.enabled) ? 1 : 0,
    interval_hours: clampInt(input.interval_hours ?? input.intervalHours, 1, 168, clampInt(settings.discovery_interval_hours, 1, 168, 24)),
    notes: String(input.notes ?? '').trim().slice(0, 500),
    hosts,
  };
}

function probePort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

/** بررسی یک میزبان؛ پورت‌های باز را برمی‌گرداند (حداکثر MAX_PORTS) */
export async function probeHost(host, { ports = [80, 443, 22, 445], timeoutMs = 600 } = {}) {
  const open = [];
  for (const port of ports.slice(0, MAX_PORTS)) {
    if (await probePort(host, port, timeoutMs)) open.push(port);
  }
  return { up: open.length > 0, ports: open };
}

/** اجرای وظیفه‌ها با هم‌زمانی محدود (بدون وابستگی خارجی) */
async function runPool(items, concurrency, worker) {
  let index = 0;
  const results = new Array(items.length);
  const runners = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    for (;;) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/** حذف نتایج منقضی از فهرست کشف — تجهیز ثبت‌شده حذف نمی‌شود */
export function pruneExpired(now = Date.now()) {
  const removed = db
    .prepare("DELETE FROM discovery_results WHERE expires_at <= ? AND imported_device_id IS NULL AND status IN ('new','dismissed')")
    .run(now).changes;
  if (removed) logEvent('info', 'discovery_pruned', { removed });
  return removed;
}

const scanState = {
  running: false,
  scanId: null,
  startedAt: null,
  finishedAt: null,
  ranges: 0,
  hosts: 0,
  found: 0,
  added: 0,
  error: null,
};

export function discoveryStatus() {
  return { ...scanState };
}

/**
 * اسکن محدوده‌ها. فقط یک اسکن هم‌زمان؛ خطای هر محدوده بقیه را متوقف نمی‌کند.
 * @param {{rangeIds?:number[], trigger?:string, actor?:string, now?:number}} options
 */
export async function runDiscoveryScan({ rangeIds = null, trigger = 'manual', actor = '', now = Date.now() } = {}) {
  if (scanState.running) {
    const err = new Error('یک اسکن کشف در حال اجراست؛ پس از پایان آن دوباره تلاش کنید.');
    err.status = 409;
    throw err;
  }
  const settings = getSettings();
  if (trigger !== 'manual' && !settings.discovery_enabled) return { skipped: true, reason: 'DISABLED' };
  const ranges = (
    Array.isArray(rangeIds) && rangeIds.length
      ? db.prepare(`SELECT * FROM discovery_ranges WHERE id IN (${rangeIds.map(() => '?').join(',')})`).all(...rangeIds.map(Number))
      : db.prepare('SELECT * FROM discovery_ranges WHERE enabled = 1 ORDER BY id').all()
  ).slice(0, MAX_RANGES);
  if (!ranges.length) return { scanId: null, ranges: 0, hosts: 0, found: 0, added: 0, skipped: true };

  scanState.running = true;
  scanState.scanId = crypto.randomUUID();
  scanState.startedAt = now;
  scanState.finishedAt = null;
  scanState.ranges = ranges.length;
  scanState.hosts = 0;
  scanState.found = 0;
  scanState.added = 0;
  scanState.error = null;

  const ports = Array.isArray(settings.discovery_ports) && settings.discovery_ports.length ? settings.discovery_ports : [80, 443, 22, 445];
  const timeoutMs = clampInt(settings.discovery_timeout_ms, 100, 5000, 600);
  const concurrency = clampInt(settings.discovery_concurrency, 1, 32, 16);
  const maxHosts = clampInt(settings.discovery_max_hosts, 1, HARD_MAX_HOSTS, 256);
  const retainHours = clampInt(settings.discovery_retain_hours, 1, 168, 24);
  const allowed = normalizeCidrList(resolveProbeCidrs(settings)) || [];

  const existingIps = new Set(db.prepare('SELECT ip FROM devices').all().map((r) => r.ip));
  const newAlerts = [];
  let totalHosts = 0;
  let totalFound = 0;
  let totalAdded = 0;

  try {
    for (const range of ranges) {
      if (totalHosts >= SCAN_HOST_BUDGET) break;
      pruneExpired(now);
      if (!isRangeAllowed(range.cidr, allowed)) {
        db.prepare("UPDATE discovery_ranges SET last_scan_at=?, last_scan_status='rejected', last_scan_message=?, updated_at=? WHERE id=?").run(
          now,
          'محدوده خارج از شبکه‌های مجاز است و اسکن نشد.',
          now,
          range.id
        );
        continue;
      }
      const hosts = expandHosts(range.cidr, Math.min(maxHosts, SCAN_HOST_BUDGET - totalHosts));
      totalHosts += hosts.length;
      const results = await runPool(hosts, concurrency, (ip) => probeHost(ip, { ports, timeoutMs }));
      const found = [];
      results.forEach((r, i) => {
        if (r?.up && !existingIps.has(hosts[i])) found.push({ ip: hosts[i], ports: r.ports });
      });
      totalFound += found.length;

      const addedRows = transaction(
        () => {
          const upsert = db.prepare(
            `INSERT INTO discovery_results(range_id, ip, hostname, open_ports, vendor, first_seen_at, last_seen_at, discovered_at, expires_at, notified, status)
             VALUES (?,?,?,?,?,?,?,?,?,0,'new')
             ON CONFLICT(ip) DO UPDATE SET last_seen_at=excluded.last_seen_at, open_ports=excluded.open_ports,
               range_id=excluded.range_id
             WHERE discovery_results.imported_device_id IS NULL AND discovery_results.status = 'new'`
          );
          const getRow = db.prepare('SELECT * FROM discovery_results WHERE ip = ?');
          const inserted = [];
          for (const f of found) {
            const before = getRow.get(f.ip);
            upsert.run(
              range.id,
              f.ip,
              '',
              JSON.stringify(f.ports),
              '',
              now,
              now,
              now,
              now + retainHours * 3600 * 1000
            );
            const after = getRow.get(f.ip);
            if (!before && after) inserted.push(after);
          }
          db.prepare('UPDATE discovery_ranges SET last_scan_at=?, last_scan_status=?, last_scan_message=?, last_found_count=?, updated_at=? WHERE id=?').run(
            now,
            'ok',
            `${found.length} میزبان پاسخ‌ده در ${hosts.length} آدرس`,
            found.length,
            now,
            range.id
          );
          return inserted;
        },
        { label: 'discovery.range' }
      );

      totalAdded += addedRows.length;
      for (const row of addedRows) {
        const alert = {
          id: null,
          deviceId: null,
          severity: 'info',
          kind: 'discovery',
          title: `تجهیز جدید کشف شد: ${row.ip}`,
          message: `میزبان ${row.ip} در محدودهٔ «${range.name}» شناسایی شد. برای ثبت، آن را از فهرست کشف‌شده‌ها وارد کنید.`,
          createdAt: now,
          status: 'active',
        };
        const r = db
          .prepare(
            `INSERT INTO alerts(device_id, rule_id, severity, kind, title, message, created_at, status, notified)
             VALUES (NULL, NULL, 'info', 'discovery', ?, ?, ?, 'active', 1)`
          )
          .run(alert.title, alert.message, now);
        newAlerts.push({ ...alert, id: Number(r.lastInsertRowid) });
      }
      if (addedRows.length) {
        db.prepare('UPDATE discovery_results SET notified = 1 WHERE ip IN (' + addedRows.map(() => '?').join(',') + ')').run(...addedRows.map((r) => r.ip));
      }
      logEvent('info', 'discovery_range_scanned', {
        rangeId: range.id,
        cidr: range.cidr,
        hosts: hosts.length,
        found: found.length,
        added: addedRows.length,
        trigger,
      });
    }

    scanState.hosts = totalHosts;
    scanState.found = totalFound;
    scanState.added = totalAdded;
    if (newAlerts.length && notifier) {
      try {
        notifier(newAlerts);
      } catch {
        /* اعلان نباید اسکن را خراب کند */
      }
    }
    logEvent('info', 'discovery_scan_finished', {
      scanId: scanState.scanId,
      trigger,
      actor,
      ranges: ranges.length,
      hosts: totalHosts,
      found: totalFound,
      added: totalAdded,
    });
    return { scanId: scanState.scanId, ranges: ranges.length, hosts: totalHosts, found: totalFound, added: totalAdded, alerts: newAlerts.length };
  } catch (e) {
    scanState.error = e?.message || String(e);
    logEvent('error', 'discovery_scan_failed', { message: scanState.error, trigger });
    throw e;
  } finally {
    scanState.running = false;
    scanState.finishedAt = Date.now();
    pruneExpired();
  }
}

/** یک ردیف کشف را به تجهیز ثبت‌شده تبدیل می‌کند (تکراری‌ها رد می‌شوند) */
export function importDiscoveryResult(id, { name = '', actor = '' } = {}) {
  const row = db.prepare('SELECT * FROM discovery_results WHERE id = ?').get(Number(id));
  if (!row) {
    const err = new Error('نتیجهٔ کشف یافت نشد.');
    err.status = 404;
    throw err;
  }
  if (row.imported_device_id) {
    const existing = db.prepare('SELECT id, name FROM devices WHERE id = ?').get(row.imported_device_id);
    if (existing) return { imported: false, duplicate: true, device: existing };
  }
  if (db.prepare('SELECT id, name FROM devices WHERE ip = ?').get(row.ip)) {
    const duplicate = new Error('این IP از قبل در سامانه ثبت شده است و دوباره ثبت نمی‌شود.');
    duplicate.status = 409;
    throw duplicate;
  }
  const now = Date.now();
  return transaction(
    () => {
      const deviceName = String(name || '').trim().slice(0, 120) || `تجهیز کشف‌شده ${row.ip}`;
      const res = db
        .prepare(
          `INSERT INTO devices(name, ip, device_type, notes, status, enabled, monitoring_enabled, created_at, updated_at, next_check_at)
           VALUES (?,?,?,?,?,1,1,?,?,0)`
        )
        .run(
          deviceName,
          row.ip,
          'سایر',
          `کشف خودکار از محدودهٔ #${row.range_id ?? '-'} در ${new Date(now).toISOString()}`,
          'unknown',
          now,
          now
        );
      const deviceId = Number(res.lastInsertRowid);
      db.prepare("UPDATE discovery_results SET imported_device_id = ?, status = 'imported', notified = 1 WHERE id = ?").run(deviceId, row.id);
      // نتیجهٔ واردشده از فهرست کشف حذف نمی‌شود تا ردگیری ممکن باشد؛ API فقط
      // ردیف‌های new را برمی‌گرداند و انقضا هم آن را هرس نمی‌کند.
      db.prepare('INSERT INTO engine_log(ts, level, message) VALUES (?,?,?)').run(
        now,
        'info',
        `تجهیز کشف‌شده «${deviceName}» (${row.ip}) توسط ${actor || 'سیستم'} ثبت شد.`
      );
      return { imported: true, deviceId, ip: row.ip, name: deviceName };
    },
    { label: 'discovery.import' }
  );
}

/** حذف/رد کردن یک نتیجهٔ کشف — هیچ تجهیز ثبت‌شده‌ای حذف نمی‌شود */
export function dismissDiscoveryResult(id) {
  const row = db.prepare('SELECT * FROM discovery_results WHERE id = ?').get(Number(id));
  if (!row) return 0;
  return db.prepare("UPDATE discovery_results SET status = 'dismissed', expires_at = ? WHERE id = ?").run(Date.now(), Number(id)).changes;
}

/* ------------------------------------------------------------------ */
/* زمان‌بند روزانه                                                    */
/* ------------------------------------------------------------------ */

let schedulerTimer = null;

export function startDiscoveryScheduler({ isLeader = () => true, intervalMs = 5 * 60 * 1000, onNew = null } = {}) {
  stopDiscoveryScheduler();
  if (onNew) setDiscoveryNotifier(onNew);
  const tick = async () => {
    if (scanState.running) return;
    try {
      if (!isLeader()) return;
      const settings = getSettings();
      if (!settings.discovery_enabled) return;
      const now = Date.now();
      // حتی وقتی اسکنی سررسید نیست، نتایج ۲۴ ساعته باید از فهرست کشف حذف شوند؛
      // این حذف فقط ردیف کشف است و تجهیز ثبت‌شده را لمس نمی‌کند.
      pruneExpired(now);
      // بازهٔ مقایسه در SQL با interval_hours هر محدوده ساده‌تر در کد است:
      const ids = [];
      for (const r of db.prepare('SELECT id, interval_hours, last_scan_at FROM discovery_ranges WHERE enabled = 1').all()) {
        const interval = clampInt(r.interval_hours, 1, 168, 24) * 3600 * 1000;
        if (!r.last_scan_at || now - r.last_scan_at >= interval) ids.push(r.id);
      }
      if (!ids.length) return;
      await runDiscoveryScan({ rangeIds: ids, trigger: 'schedule' });
    } catch (e) {
      logEvent('error', 'discovery_scheduler_failed', { message: e?.message || String(e) });
    }
  };
  schedulerTimer = setInterval(() => void tick(), intervalMs);
  schedulerTimer.unref?.();
  // اولین اجرا کوتاه پس از بالا آمدن سرور (نه بلافاصله وسط مسیر boot).
  const delay = setTimeout(() => void tick(), 20 * 1000);
  delay.unref?.();
  return { stop: stopDiscoveryScheduler, tick };
}

export function stopDiscoveryScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
}

export default {
  MAX_RANGES,
  HARD_MAX_HOSTS,
  hostCount,
  expandHosts,
  isRangeAllowed,
  validateRangeInput,
  probeHost,
  pruneExpired,
  runDiscoveryScan,
  importDiscoveryResult,
  dismissDiscoveryResult,
  discoveryStatus,
  setDiscoveryNotifier,
  startDiscoveryScheduler,
  stopDiscoveryScheduler,
};
