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

/** بررسی ظرفیت تعریف محدودهٔ جدید؛ فقط هنگام افزودن محدوده صدا زده می‌شود. */
export function assertRangeCapacity() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM discovery_ranges').get().c;
  if (count >= MAX_RANGES) {
    const error = new Error(`حداکثر ${MAX_RANGES} محدوده قابل تعریف است.`);
    error.status = 409;
    error.code = 'DISCOVERY_RANGE_LIMIT';
    throw error;
  }
  return count;
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
  // سقف تعداد محدوده‌ها عمداً این‌جا بررسی نمی‌شود: این تابع برای «ویرایش» یک
  // محدودهٔ موجود هم استفاده می‌شود و شمارش کلی باعث می‌شد در سقف ۳۲ محدوده،
  // ویرایش محدودهٔ موجود هم رد شود (BUG-15). سقف فقط در مسیر «افزودن» اعمال
  // می‌شود (مسیر POST و assertRangeCapacity).
  return {
    name,
    cidr: `${parsed.source.split('/')[0]}/${parsed.prefix}`,
    enabled: input.enabled === undefined ? 1 : Number(input.enabled) ? 1 : 0,
    interval_hours: clampInt(input.interval_hours ?? input.intervalHours, 1, 168, clampInt(settings.discovery_interval_hours, 1, 168, 24)),
    notes: String(input.notes ?? '').trim().slice(0, 500),
    hosts,
  };
}

function probePort(host, port, timeoutMs, signal = null) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const socket = new net.Socket();
    let done = false;
    let onAbort = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(ok);
    };
    if (signal) {
      onAbort = () => finish(false);
      signal.addEventListener('abort', onAbort, { once: true });
    }
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
export async function probeHost(host, { ports = [80, 443, 22, 445], timeoutMs = 600, signal = null } = {}) {
  const open = [];
  for (const port of ports.slice(0, MAX_PORTS)) {
    if (signal?.aborted) break;
    if (await probePort(host, port, timeoutMs, signal)) open.push(port);
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

const SCAN_STATE_KEY = 'discovery_scan';
// اگر ردیف running/runtime_state از یک فرآیند مرده مانده باشد، فقط پس از این
// مدت «رها‌شده» تلقی می‌شود؛ این‌طور اسکن زندهٔ نمونهٔ دیگر خراب نمی‌شود.
const STALE_SCAN_MS = 15 * 60 * 1000;

const scanState = {
  running: false,
  stopRequested: false,
  scanId: null,
  startedAt: null,
  finishedAt: null,
  ranges: 0,
  hosts: 0,
  found: 0,
  added: 0,
  skippedDisabled: 0,
  failedRanges: 0,
  stopped: false,
  interruptedAt: null,
  error: null,
};

let activeAbort = null;

function persistScanState() {
  try {
    db.prepare(
      `INSERT INTO runtime_state(key, value, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
    ).run(
      SCAN_STATE_KEY,
      JSON.stringify({
        scanId: scanState.scanId,
        startedAt: scanState.startedAt,
        trigger: scanState.trigger,
        ranges: scanState.ranges,
        hosts: scanState.hosts,
        found: scanState.found,
        added: scanState.added,
      }),
      Date.now()
    );
  } catch {
    // نبود قابلیت ذخیرهٔ وضعیت نباید خود اسکن را متوقف کند؛ فقط ترمیم پس از
    // Crash کمی ضعیف‌تر می‌شود.
  }
}

function clearScanState() {
  try {
    db.prepare('DELETE FROM runtime_state WHERE key = ?').run(SCAN_STATE_KEY);
  } catch {
    /* بی‌اثر */
  }
}

export function discoveryStatus() {
  return { ...scanState };
}

/**
 * توقف امن اسکن جاری (خاموشی سرور یا درخواست مدیر).
 * سوکت‌های در جریان Abort می‌شوند و حلقه بین محدوده‌ها متوقف می‌شود.
 */
export function requestDiscoveryStop() {
  if (!scanState.running) return false;
  scanState.stopRequested = true;
  try {
    activeAbort?.abort();
  } catch {
    /* بی‌اثر */
  }
  logEvent('warn', 'discovery_stop_requested', { scanId: scanState.scanId });
  return true;
}

/** انتظار محدود برای پایان اسکن جاری (هنگام خاموشی) */
export function waitForDiscoveryScan(timeoutMs = 3000) {
  if (!scanState.running) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (!scanState.running) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 50);
    timer.unref?.();
  });
}

/**
 * ترمیم وضعیت اسکن پس از Crash/Restart.
 *
 * اسکن در حافظه اجرا می‌شود، اما آغاز آن در `runtime_state` ثبت می‌شود و هر
 * محدوده پیش از اسکن `last_scan_status='running'` می‌گیرد. اگر فرآیند بمیرد،
 * در راه‌اندازی بعدی این تابع وضعیت را تعیین تکلیف می‌کند: محدوده‌های نیمه‌کاره
 * `interrupted` می‌شوند، رکورد وضعیت پاک می‌شود و رویداد در لاگ می‌آید. نتیجه
 * این است که هیچ محدوده/گزارشی برای همیشه در حالت «در حال اجرا» نمی‌ماند و
 * دادهٔ ناقص به‌عنوان موفق گزارش نمی‌شود.
 */
export function recoverDiscoveryState({ now = Date.now(), staleMs = STALE_SCAN_MS } = {}) {
  let saved = null;
  try {
    const row = db.prepare('SELECT value, updated_at FROM runtime_state WHERE key = ?').get(SCAN_STATE_KEY);
    if (row) {
      try {
        saved = JSON.parse(row.value);
      } catch {
        saved = { corrupted: true };
      }
      if (now - Number(row.updated_at || 0) < staleMs) {
        // ممکن است نمونهٔ دیگری واقعاً در حال اسکن باشد؛ دست نمی‌زنیم.
        return { recovered: false, active: true };
      }
    }
  } catch {
    return { recovered: false };
  }
  // هر محدوده‌ای که در لحظهٔ Crash در حال اسکن بوده، «نیمه‌کاره» اعلام می‌شود؛
  // نه «موفق» و نه بی‌پایان در حالت running.
  const total = db
    .prepare(
      `UPDATE discovery_ranges SET last_scan_status = 'interrupted',
         last_scan_message = 'اسکن پیش از پایان متوقف شد (خاموشی/بازیابی سرور) و نتیجهٔ کامل ثبت نشد.',
         updated_at = ?
       WHERE last_scan_status = 'running'`
    )
    .run(now).changes;
  clearScanState();
  if (saved || total) {
    scanState.interruptedAt = now;
    scanState.finishedAt = now;
    scanState.stopped = true;
    logEvent('warn', 'discovery_scan_interrupted', {
      scanId: saved?.scanId || null,
      startedAt: saved?.startedAt || null,
      ranges: total,
    });
  }
  return { recovered: Boolean(saved || total), scan: saved, ranges: total };
}

/**
 * اسکن محدوده‌ها. فقط یک اسکن هم‌زمان؛ خطای هر محدوده بقیه را متوقف نمی‌کند.
 * @param {{rangeIds?:number[], trigger?:string, actor?:string, now?:number}} options
 */
export async function runDiscoveryScan({ rangeIds = null, trigger = 'manual', actor = '', now = Date.now(), probeHostFn = probeHost } = {}) {
  if (scanState.running) {
    const err = new Error('یک اسکن کشف در حال اجراست؛ پس از پایان آن دوباره تلاش کنید.');
    err.status = 409;
    throw err;
  }
  const settings = getSettings();
  if (trigger !== 'manual' && !settings.discovery_enabled) return { skipped: true, reason: 'DISABLED' };

  // محدوده‌های درخواستی خوانده می‌شوند، اما فقط محدوده‌های **فعال** اسکن می‌شوند.
  // پیش‌تر انتخاب دستی چند محدوده، محدودهٔ غیرفعال را هم اسکن می‌کرد (BUG-16).
  const requested =
    Array.isArray(rangeIds) && rangeIds.length
      ? db
          .prepare(`SELECT * FROM discovery_ranges WHERE id IN (${rangeIds.map(() => '?').join(',')}) ORDER BY id`)
          .all(...rangeIds.map(Number))
      : db.prepare('SELECT * FROM discovery_ranges WHERE enabled = 1 ORDER BY id').all();
  const ranges = requested.filter((r) => Number(r.enabled) === 1).slice(0, MAX_RANGES);
  const skippedDisabled = requested.length - ranges.length;
  if (!ranges.length) {
    return {
      scanId: null,
      ranges: 0,
      hosts: 0,
      found: 0,
      added: 0,
      skippedDisabled,
      skipped: true,
      reason: skippedDisabled ? 'NO_ENABLED_RANGES' : 'NO_RANGES',
    };
  }

  scanState.running = true;
  scanState.stopRequested = false;
  scanState.stopped = false;
  scanState.scanId = crypto.randomUUID();
  scanState.startedAt = now;
  scanState.finishedAt = null;
  scanState.trigger = trigger;
  scanState.ranges = ranges.length;
  scanState.hosts = 0;
  scanState.found = 0;
  scanState.added = 0;
  scanState.skippedDisabled = skippedDisabled;
  scanState.failedRanges = 0;
  scanState.error = null;
  activeAbort = new AbortController();
  const signal = activeAbort.signal;
  persistScanState();

  const ports = Array.isArray(settings.discovery_ports) && settings.discovery_ports.length ? settings.discovery_ports : [80, 443, 22, 445];
  const timeoutMs = clampInt(settings.discovery_timeout_ms, 100, 5000, 600);
  const concurrency = clampInt(settings.discovery_concurrency, 1, 32, 16);
  const maxHosts = clampInt(settings.discovery_max_hosts, 1, HARD_MAX_HOSTS, 256);
  const retainHours = clampInt(settings.discovery_retain_hours, 1, 168, 24);
  const allowed = normalizeCidrList(resolveProbeCidrs(settings)) || [];

  const existingIps = new Set(db.prepare('SELECT ip FROM devices').all().map((r) => r.ip));
  const newAlerts = [];
  const failures = [];
  let totalHosts = 0;
  let totalFound = 0;
  let totalAdded = 0;

  try {
    for (const range of ranges) {
      if (signal.aborted || scanState.stopRequested) break;
      if (totalHosts >= SCAN_HOST_BUDGET) break;
      try {
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
        // وضعیت «در حال اجرا» پیش از سنجش ثبت می‌شود تا Crash در میانهٔ کار در
        // راه‌اندازی بعدی به «interrupted» تبدیل شود، نه اینکه کهنه بماند.
        db.prepare("UPDATE discovery_ranges SET last_scan_status='running', last_scan_message='', last_scan_at=?, updated_at=? WHERE id=?").run(
          now,
          now,
          range.id
        );
        const hosts = expandHosts(range.cidr, Math.min(maxHosts, SCAN_HOST_BUDGET - totalHosts));
        totalHosts += hosts.length;
        scanState.hosts = totalHosts;
        persistScanState();
        const results = await runPool(hosts, concurrency, (ip) => probeHostFn(ip, { ports, timeoutMs, signal }));
        if (signal.aborted) {
          db.prepare("UPDATE discovery_ranges SET last_scan_status='interrupted', last_scan_message=?, updated_at=? WHERE id=?").run(
            'اسکن به‌درخواست مدیر/خاموشی سرور متوقف شد.',
            Date.now(),
            range.id
          );
          break;
        }
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
        scanState.found = totalFound;
        scanState.added = totalAdded;
        persistScanState();
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
      } catch (e) {
        // خطای یک محدوده نباید بقیهٔ محدوده‌ها را متوقف کند (BUG-17)؛ وضعیت
        // همان محدوده ثبت می‌شود و اسکن با محدودهٔ بعدی ادامه می‌یابد.
        scanState.failedRanges += 1;
        const message = String(e?.message || e).slice(0, 300);
        failures.push({ rangeId: range.id, cidr: range.cidr, message });
        try {
          db.prepare("UPDATE discovery_ranges SET last_scan_status='error', last_scan_message=?, updated_at=? WHERE id=?").run(
            message,
            Date.now(),
            range.id
          );
        } catch {
          /* ثبت وضعیت خودش نباید حلقه را بشکند */
        }
        logEvent('error', 'discovery_range_failed', { rangeId: range.id, cidr: range.cidr, message, trigger });
      }
    }

    scanState.hosts = totalHosts;
    scanState.found = totalFound;
    scanState.added = totalAdded;
    scanState.stopped = signal.aborted || scanState.stopRequested;
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
      failedRanges: scanState.failedRanges,
      skippedDisabled,
      stopped: scanState.stopped,
    });
    return {
      scanId: scanState.scanId,
      ranges: ranges.length,
      hosts: totalHosts,
      found: totalFound,
      added: totalAdded,
      alerts: newAlerts.length,
      failedRanges: scanState.failedRanges,
      failures,
      skippedDisabled,
      stopped: scanState.stopped,
    };
  } finally {
    scanState.running = false;
    scanState.finishedAt = Date.now();
    activeAbort = null;
    clearScanState();
    try {
      pruneExpired();
    } catch {
      /* هرس نتایج منقضی نباید نتیجهٔ اسکن را زیر سؤال ببرد */
    }
  }
}

/**
 * یک ردیف کشف را به تجهیز ثبت‌شده تبدیل می‌کند (تکراری‌ها رد می‌شوند).
 *
 * همهٔ بررسی‌های تکرار **داخل همان تراکنش نوشتن** انجام می‌شوند. پیش‌تر بررسی
 * بیرون از تراکنش بود و دو درخواست هم‌زمان (دوبار کلیک/دو تب) می‌توانستند هر دو
 * عبور کنند و دو تجهیز با یک IP بسازند (BUG-21).
 */
export function importDiscoveryResult(id, { name = '', actor = '' } = {}) {
  const now = Date.now();
  return transaction(
    () => {
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
      const byIp = db.prepare('SELECT id, name FROM devices WHERE ip = ?').get(row.ip);
      if (byIp) {
        const duplicate = new Error('این IP از قبل در سامانه ثبت شده است و دوباره ثبت نمی‌شود.');
        duplicate.status = 409;
        duplicate.code = 'DUPLICATE_IP';
        throw duplicate;
      }
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
