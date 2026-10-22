/**
 * NetWatch — موتور مانیتورینگ
 * ----------------------------------------------------------------
 * موتور به‌صورت کامل مستقل از رابط کاربری کار می‌کند. می‌تواند داخل
 * همان فرآیند سرور اجرا شود یا به شکل یک سرویس جداگانه:
 *      node server/engine-cli.js
 */
import { EventEmitter } from 'node:events';
import { db, getSettings, log, STATUS, transaction } from './db.js';
import { probeIcmp, icmpStatus, icmpPing, tcpPing } from './ping.js';
import { LeaderLock } from './leader.js';
import { logEvent } from './logger.mjs';
import { config } from './config.js';
import { isProbeTargetAllowed } from './net-policy.js';
import { rollupDay as sharedRollupDay } from './rollup.js';
import { monotonicNow, observeClock } from './clock.js';
import { runRetention } from './retention.js';

/** خطای «این نمونه رهبر نیست» — نوشتن نتیجه ممنوع است */
export class EngineNotLeaderError extends Error {
  constructor(message = 'این نمونهٔ موتور رهبر نیست؛ نتیجهٔ بررسی ثبت نشد.') {
    super(message);
    this.name = 'EngineNotLeaderError';
    this.code = 'ENGINE_NOT_LEADER';
    this.status = 409;
  }
}

/** خطای «fencing»: رهبری در میانهٔ عملیات عوض شده و نتیجه باطل است */
export class EngineFencedError extends Error {
  constructor(message = 'رهبری موتور تغییر کرده است؛ نتیجهٔ این عملیات باطل شد.') {
    super(message);
    this.name = 'EngineFencedError';
    this.code = 'ENGINE_FENCED';
    this.status = 409;
  }
}

export const bus = new EventEmitter();
bus.setMaxListeners(200);

// فاصله تجمیع آمار (daily_stats + بازمحاسبه ۲۴ ساعته) — قبلاً هر دقیقه اجرا می‌شد
const ROLLUP_EVERY_MS = 5 * 60 * 1000;
const PRUNE_CHUNK = 5000;
// سقف هر اجرا داخل یک تراکنش اجرا می‌شود؛ عدد بزرگ یعنی قفل نوشتن طولانی.
const PRUNE_MAX_PER_RUN = 50000;
const DAY_MS = 86400000;
// آستانهٔ تشخیص «گیرکردن» حلقهٔ چرخه: اگر چرخهٔ ۲۵۰ میلی‌ثانیه‌ای بیش از این
// مدت اجرا نشود، یعنی کار همگام/بلوکه‌کننده‌ای حلقهٔ رویداد را قفل کرده است.
const TICK_STALL_MS = 30000;
// فاصلهٔ حداقل بین دو هشدار مستقل «اختلال موتور» برای یک کد
const ENGINE_INCIDENT_COOLDOWN_MS = 5 * 60 * 1000;
// پس از پایان هر بررسی، چرخهٔ بعدی در این فاصله اجرا می‌شود تا ظرفیت آزادشده
// بلافاصله پر شود. مقدار ۵ms تعادل بین سربار پرس‌وجوی صف و تأخیر شروع است.
const REFILL_DELAY_MS = 5;
// نوشتن نتایج به‌صورت گروهی: چند بررسی در یک تراکنش COMMIT می‌شوند و یک fsync
// می‌خورند. هر بررسی همچنان SAVEPOINT مستقل دارد، پس شکست یک تجهیز بقیه را
// باطل نمی‌کند و هیچ نتیجهٔ نیمه‌کاره‌ای ثبت نمی‌شود.
const RECORD_BATCH_MAX = 128;
const RECORD_FLUSH_MS = 4;
// پس از این مدت بی‌خطایی، هشدارهای مستقل موتور بسته می‌شوند (خطای پراکنده هشدار
// دائمی نمی‌سازد، اما خطای پیوسته باز می‌ماند).
const ENGINE_HEALTH_GRACE_MS = 5 * 60 * 1000;

/** شروع روز تقویمی محلی (بر پایهٔ اختلاف زمانی تنظیمات)، نه نیمه‌شب UTC */
function localDayStart(ts, offsetMin = 0) {
  const off = (Number(offsetMin) || 0) * 60000;
  return Math.floor((ts + off) / DAY_MS) * DAY_MS - off;
}

function localDayLabel(dayStart, offsetMin = 0) {
  return new Date(dayStart + (Number(offsetMin) || 0) * 60000).toISOString().slice(0, 10);
}

/** مرزگذاری عددی: مقدار خراب در پایگاه‌داده نباید به فرمان Ping یا زمان‌بندی برسد */
function bounded(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/* ------------------------------------------------------------------ */
/* قالب پرس‌وجوهای آماده                                               */
/* ------------------------------------------------------------------ */
let stmt = null;
function S() {
  if (stmt) return stmt;
  stmt = {
    // فقط تجهیزات سررسیدشده تا ثانیه جاری، به ترتیب اولویت و با ایندکس idx_devices_due
    // (به‌جای خواندن کل جدول تجهیزات در هر چرخه)
    due: db.prepare(`SELECT * FROM devices
       WHERE enabled = 1 AND monitoring_enabled = 1 AND next_check_at <= ?
       ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END
       LIMIT ?`),
    scheduleNext: db.prepare('UPDATE devices SET next_check_at = ? WHERE id = ?'),
    exists: db.prepare('SELECT id FROM devices WHERE id = ?'),
    overdue: db.prepare('SELECT COUNT(*) c FROM devices WHERE enabled = 1 AND monitoring_enabled = 1 AND next_check_at <= ?'),
    insertSample: db.prepare(
      `INSERT INTO samples(device_id, ts, rtt_ms, packets_sent, packets_recv, loss_pct, status, ok, mode, scheduled_at, started_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ),
    openOutage: db.prepare(
      'INSERT INTO outages(device_id, started_at, ended_at, duration_sec, cause, detail, lat, lng, open) VALUES (?,?,?,?,?,?,?,?,1)'
    ),
    // قطعی باز موجود هر تجهیز (قید یکتای پایگاه‌داده تضمین می‌کند حداکثر یکی باشد).
    // موتور پیش از ساخت قطعی تازه آن را «به فرزندی می‌گیرد»، پس هیچ‌گاه دو قطعی باز
    // برای یک تجهیز ساخته نمی‌شود — حتی پس از Crash و بازگشت.
    openOutageFor: db.prepare('SELECT id, started_at FROM outages WHERE device_id = ? AND open = 1 ORDER BY started_at ASC, id ASC LIMIT 1'),
    closeOpenOutages: db.prepare(
      'UPDATE outages SET ended_at = ?, duration_sec = MAX(1, CAST((? - started_at) / 1000 AS INTEGER)), open = 0 WHERE device_id = ? AND open = 1 AND id != ?'
    ),
    closeOutage: db.prepare('UPDATE outages SET ended_at=?, duration_sec=?, open=0 WHERE id=?'),
    updateDevice: db.prepare(`UPDATE devices SET
        status=?, status_reason=?, service_status=?, service_port=?, service_checked_at=?,
        last_check_at=?, last_status_change_at=?, last_rtt_ms=?, loss_pct=?,
        success_count=?, fail_count=?, total_checks=?, consecutive_failures=?, consecutive_successes=?,
        last_outage_at=?, current_outage_id=?, current_outage_started_at=?, last_recovery_at=?, min_rtt_ms=?, max_rtt_ms=?, avg_rtt_ms=?
      WHERE id=?`),
    recentAlert: db.prepare('SELECT id, created_at FROM alerts WHERE duplicate_key = ? ORDER BY created_at DESC LIMIT 1'),
    insertAlert: db.prepare(
      'INSERT INTO alerts(device_id, rule_id, severity, kind, title, message, value, created_at, status, notified, duplicate_key) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ),
    resolveAlerts: db.prepare(
      "UPDATE alerts SET status='resolved', resolved_at=? WHERE device_id=? AND status IN ('active','acknowledged') AND kind IN ('offline','latency','loss')"
    ),
    // یک قطعی «باز» تنها می‌تواند متعلق به تجهیزی باشد که در وضعیت Offline است
    closeStaleOpen: db.prepare(
      'UPDATE outages SET ended_at=?, duration_sec=MAX(1, CAST((?-started_at)/1000 AS INTEGER)), open=0 WHERE device_id=? AND open=1'
    ),
    markMaintenance: db.prepare(
      'UPDATE devices SET status=?, status_reason=?, current_outage_id=NULL, current_outage_started_at=NULL WHERE id=? AND (status != ? OR current_outage_id IS NOT NULL)'
    ),
    rules: db.prepare('SELECT * FROM alert_rules WHERE enabled = 1'),
    windows: db.prepare('SELECT * FROM maintenance_windows WHERE enabled = 1'),
    deviceTags: db.prepare('SELECT t.name FROM device_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.device_id = ?'),
    // هرس تکه‌تکه: حذف یک‌بارهٔ صدها هزار رکورد، پایگاه‌داده را ثانیه‌ها قفل می‌کند.
    //
    // سیاست حفظ سوابق ضروری:
    //   • قطعی‌های «باز» هرگز حذف نمی‌شوند (حتی اگر از بازهٔ نگهداری قدیمی‌تر باشند)؛
    //     وگرنه یک حادثهٔ طولانی بی‌سند می‌ماند.
    //   • قطعی‌ای که سابقهٔ تعمیرات به آن ارجاع دارد حذف نمی‌شود تا پیوند سند
    //     عملیاتی (outage_id) قطع نشود.
    //   • فقط هشدارهای حل‌شده/سرکوب‌شده حذف می‌شوند؛ هشدار فعال یا تأییدشده
    //     هرگز هرس نمی‌شود. هشدارهای تجهیز دارای قطعی باز هم می‌مانند.
    pruneSamples: db.prepare('DELETE FROM samples WHERE rowid IN (SELECT rowid FROM samples WHERE ts < ? LIMIT ?)'),
    pruneOutages: db.prepare(
      `DELETE FROM outages WHERE rowid IN (
         SELECT o.rowid FROM outages o
         WHERE o.open = 0 AND o.started_at < ?
           AND NOT EXISTS (SELECT 1 FROM maintenance_records m WHERE m.outage_id = o.id)
         LIMIT ?)`
    ),
    pruneAlertsRow: db.prepare(
      `DELETE FROM alerts WHERE rowid IN (
         SELECT a.rowid FROM alerts a
         WHERE a.created_at < ? AND a.status IN ('resolved','suppressed')
           AND NOT EXISTS (SELECT 1 FROM outages o WHERE o.device_id = a.device_id AND o.open = 1)
         LIMIT ?)`
    ),
    pruneLog: db.prepare('DELETE FROM engine_log WHERE rowid IN (SELECT rowid FROM engine_log WHERE ts < ? LIMIT ?)'),

    // تجمیع روزانه به‌صورت چند پرس‌وجوی گروهی (به‌جای یک پرس‌وجوی همبسته برای هر تجهیز)
    daySamples: db.prepare(
      `SELECT device_id, COUNT(*) AS checks,
              SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS failed,
              AVG(CASE WHEN ok=1 THEN rtt_ms END) AS avg_rtt,
              MIN(CASE WHEN ok=1 THEN rtt_ms END) AS min_rtt,
              MAX(CASE WHEN ok=1 THEN rtt_ms END) AS max_rtt,
              AVG(CASE WHEN ok=0 THEN 100 ELSE 0 END) AS loss_pct
       FROM samples WHERE ts >= ? AND ts < ? GROUP BY device_id`
    ),
    dayOutages: db.prepare(
      `SELECT device_id, COUNT(*) AS outages, COALESCE(SUM(duration_sec),0) AS downtime_sec
       FROM outages WHERE started_at >= ? AND started_at < ? GROUP BY device_id`
    ),
    upsertDay: db.prepare(
      `INSERT INTO daily_stats(device_id, day, checks, failed, avg_rtt, min_rtt, max_rtt, loss_pct, outages, downtime_sec, uptime_pct)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(device_id, day) DO UPDATE SET checks=excluded.checks, failed=excluded.failed,
         avg_rtt=excluded.avg_rtt, min_rtt=excluded.min_rtt, max_rtt=excluded.max_rtt, loss_pct=excluded.loss_pct,
         outages=excluded.outages, downtime_sec=excluded.downtime_sec, uptime_pct=excluded.uptime_pct`
    ),
    recompute: db.prepare(
      `SELECT device_id,
              COUNT(*) AS checks,
              SUM(ok) AS ok_count,
              MIN(CASE WHEN ok=1 THEN rtt_ms END) AS min_rtt,
              MAX(CASE WHEN ok=1 THEN rtt_ms END) AS max_rtt,
              AVG(CASE WHEN ok=1 THEN rtt_ms END) AS avg_rtt
       FROM samples WHERE ts >= ? GROUP BY device_id`
    ),
    setUptime: db.prepare('UPDATE devices SET uptime_pct=? WHERE id=?'),
    // بازیابی وضعیت پس از راه‌اندازی/بازگشت:
    // • قطعی بازِ یتیم (تجهیزش به آن ارجاع ندارد) به تجهیز وصل می‌شود.
    // • ارجاعی که به قطعی بسته/ناموجود اشاره می‌کند پاک می‌شود.
    // • برای تجهیز قطع‌شده‌ای که هیچ قطعی بازی ندارد، وضعیت متناقض اصلاح می‌شود.
    orphans: db.prepare(
      `SELECT o.device_id, o.id, o.started_at FROM outages o
       JOIN devices d ON d.id = o.device_id
       WHERE o.open = 1 AND (d.current_outage_id IS NULL OR d.current_outage_id != o.id)`
    ),
    adoptOutage: db.prepare('UPDATE devices SET current_outage_id = ?, current_outage_started_at = ? WHERE id = ?'),
    clearDanglingOutage: db.prepare(
      `UPDATE devices SET current_outage_id = NULL, current_outage_started_at = NULL
       WHERE current_outage_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM outages o WHERE o.id = devices.current_outage_id AND o.open = 1)`
    ),
    danglingRefs: db.prepare(
      `SELECT d.id FROM devices d
       WHERE d.current_outage_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM outages o WHERE o.id = d.current_outage_id AND o.open = 1)`
    ),
    openForDevice: db.prepare('SELECT id FROM outages WHERE device_id = ? AND open = 1 LIMIT 1'),
    offlineWithoutOutage: db.prepare(
      `SELECT d.id, d.status_reason FROM devices d
       WHERE d.status = 'offline' AND NOT EXISTS (SELECT 1 FROM outages o WHERE o.device_id = d.id AND o.open = 1)`
    ),
  };
  return stmt;
}

/* ------------------------------------------------------------------ */
/* شبیه‌سازی (برای دمو و آموزش)                                        */
/* ------------------------------------------------------------------ */
const simState = new Map();
function simProfile(device) {
  let s = simState.get(device.id);
  if (!s) {
    const r1 = hash(`${device.ip}:a`);
    const r2 = hash(`${device.ip}:b`);
    const r3 = hash(`${device.ip}:c`);
    const base = r1 > 0.93 ? 120 + r1 * 160 : 2 + r1 * 55;
    // «chronic»: تجهیزات دارای خرابی پایدار (بازتاب واقعی شبکه‌هایی که تجهیز معیوب در انتظار تعمیر دارند)
    const chronic = r3 > 0.93;
    s = {
      base,
      drift: 0,
      jitter: 1 + r2 * 14,
      lossProb: chronic ? 0.35 : r3 > 0.82 ? 0.16 + r3 * 0.25 : r3 * 0.03,
      outageChance: chronic ? 0.22 : r3 > 0.6 ? 0.01 : 0.0025,
      chronic,
      downTicks: chronic ? 45 + Math.floor(r1 * 120) : 0,
    };
    simState.set(device.id, s);
  }
  return s;
}

const DOWN_RESULT = (count) => ({
  ok: false,
  reachable: false,
  service: 'unknown',
  servicePort: null,
  rtt: null,
  packetsSent: count,
  packetsRecv: 0,
  lossPct: 100,
  mode: 'simulate',
  error: 'TIMEOUT',
});

function simulateCheck(device, count) {
  const s = simProfile(device);
  if (s.downTicks > 0) {
    s.downTicks--;
    return DOWN_RESULT(count);
  }
  if (Math.random() < s.outageChance) {
    s.downTicks = s.chronic ? 40 + Math.floor(Math.random() * 90) : 1 + Math.floor(Math.random() * 8);
    return DOWN_RESULT(count);
  }

  s.drift = s.drift * 0.9 + (Math.random() - 0.5) * s.jitter * 0.6;
  const rtt = Math.max(0.3, s.base + s.drift + (Math.random() - 0.5) * s.jitter);
  let recv = count;
  if (Math.random() < s.lossProb) recv = Math.max(0, count - (1 + Math.floor(Math.random() * (count - 1 || 1))));
  const lossPct = Math.round(((count - recv) / count) * 1000) / 10;
  return {
    ok: recv > 0,
    reachable: recv > 0,
    // دادهٔ شبیه‌سازی‌شده هرگز ادعای «سرویس سالم» نمی‌کند؛ فقط دسترسی شبکه.
    service: 'unknown',
    servicePort: null,
    rtt: Math.round(rtt * 100) / 100,
    packetsSent: count,
    packetsRecv: recv,
    lossPct,
    mode: 'simulate',
    error: recv > 0 ? undefined : 'TIMEOUT',
  };
}

/* ------------------------------------------------------------------ */
/* موتور                                                               */
/* ------------------------------------------------------------------ */
export class MonitoringEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.emitToBus = options.emitToBus !== false;
    this.running = false;
    this.timer = null;
    // چرخهٔ فراخوانی هر ۲۵۰ میلی‌ثانیه اجرا می‌شود تا بررسی‌ها سر وقت شروع شوند؛
    // سقف هم‌زمانی (max_workers) در هر چرخه اعمال می‌شود، پس این کار بار اضافه نمی‌سازد.
    this.interval = 250;
    this.inflight = new Map();
    this.settingsCache = { at: 0, value: getSettings() };
    this.lastMaintenanceSweep = 0;
    this.lastRollup = 0;
    this.lastCleanup = 0;
    this.lastClockCheck = 0;
    this.lastBacklogCheck = 0;
    this.lastBacklogWarn = 0;
    // شمارنده‌ها عمداً تفکیک شده‌اند: «خطای داخلی موتور» (باگ/پایگاه‌داده) با
    // «بی‌پاسخی شبکه» یکی نیست و نباید قطعی شبکه شمرده شود.
    this.stats = {
      cycles: 0,
      checksRun: 0,
      fenced: 0,
      lastRunAt: null,
      lastTickAt: null,
      startedAt: null,
      errors: 0,
      internalErrors: 0,
      networkFailures: 0,
      serviceUnavailable: 0,
      skipped: 0,
      backlog: 0,
      // شمارنده‌های چرخهٔ جاری برای صفحهٔ Application Health:
      lastTickLaunched: 0,
      lastTickCapacity: 0,
      lastTickReady: 0,
      lastTickMs: 0,
      lastCycleMs: 0,
      queueDepth: 0,
      scheduling: { lastLagMs: 0, avgLagMs: 0, maxLagMs: 0, samples: 0, tickLagMs: 0 },
    };
    // چرخهٔ خودزمان‌بند: پس از هر بررسی، tick بعدی زمان‌بندی می‌شود (نه با
    // setInterval ثابت). setInterval هر ۲۵۰ms فقط max_workers بررسی شروع می‌کرد،
    // پس گذردهی به «max_workers × ۴» سقف می‌خورد؛ اکنون ظرفیت آزادشده بلافاصله
    // پر می‌شود و نرخ واقعی به CPU/دیسک می‌رسد.
    this._loopActive = false;
    this._loopBusy = false;
    this._lastRefillAt = 0;
    this._saturated = false;
    this._recordQueue = [];
    this._recordFlushTimer = null;
    this.rulesCache = { at: 0, rows: [] };
    this.windowsCache = { at: 0, rows: [] };
    // قفل رهبری: فقط یک نمونه (سرور یا engine-cli) مجاز است بررسی کند.
    this.lock = options.lock || new LeaderLock();
    this.leader = false;
    // Fencing Token: epoch قفل در اختیار این نمونه. هر عملیات، epoch و نسل
    // چرخهٔ حیات خودش را نگه می‌دارد و پیش از ثبت دوباره بررسی می‌شود.
    this.epoch = 0;
    this.lifecycle = 0;
    this.accepting = false;
    this.activeOps = 0;
    this.transientOps = 0;
    this.leaseTimer = null;
    this._stopping = null;
    this._startPromise = null;
    this._restartPromise = null;
    this._stopFinalized = false;
    this.stopDrainMs = Math.max(0, Number(options.stopDrainMs ?? config.stopDrainMs ?? 5000));
    this.lockRetryMs = Math.max(100, Number(options.lockRetryMs ?? config.engine.lockRetryMs ?? 2000));
    this.lastLockAttempt = 0;
    this.lastRenew = 0;
    // برای جلوگیری از لاگ تکراری «مقصد غیرمجاز» در هر چرخه
    this.blockedNotices = new Map();
    // هشدارهای معوق (alert_delay / rule.duration_sec): کلید → { dueAt, timer, payload }
    this.pending = new Map();
    // مهلت سخت کل یک بررسی (شامل تلاش‌های مجدد و پاییندستی‌ها). اگر لایهٔ پروب
    // به هر دلیلی برنگردد، این مهلت جای ظرفیت موتور را با یک بررسی آویزان اشغال
    // نمی‌کند. مقدار عددی را می‌توان برای آزمون با گزینهٔ probeDeadlineMs جایگزین کرد.
    this.probeDeadlineMs = options.probeDeadlineMs ? Number(options.probeDeadlineMs) : null;
    // آستانه‌های پایش سلامت موتور (قابل تنظیم برای آزمون)
    this.stallMs = Math.max(1000, Number(options.stallMs) || TICK_STALL_MS);
    this.incidentGraceMs = Math.max(0, Number(options.incidentGraceMs ?? ENGINE_HEALTH_GRACE_MS));
    this.lastIncidentAt = new Map();
    this.incidentActive = new Map();
  }

  settings() {
    if (Date.now() - this.settingsCache.at > 5000) {
      this.settingsCache = { at: Date.now(), value: getSettings() };
    }
    return this.settingsCache.value;
  }

  /**
   * کش تنظیمات/قوانین/پنجره‌های تعمیرات را باطل می‌کند تا تغییرهای کاربر
   * بلافاصله روی چرخهٔ بعدی موتور اثر بگذارد (بدون انتظار برای انقضای کش).
   */
  invalidate() {
    const before = this.settingsCache.value;
    const after = getSettings();
    this.settingsCache = { at: 0, value: after };
    this.rulesCache = { at: 0, rows: [] };
    this.windowsCache = { at: 0, rows: [] };
    // تغییر تنظیمات در زمان اجرا «کنترل‌شده» اعمال می‌شود: مقدارهای اثرگذار
    // (حالت، هم‌زمانی، بازه، آستانه‌ها) با لاگ ساختاریافته ثبت می‌شوند تا در
    // بررسی رخداد‌ها معلوم باشد کدام تغییر چه زمانی فعال شده است.
    const watched = ['engine_mode', 'engine_enabled', 'max_workers', 'ping_interval', 'timeout_ms', 'retries', 'packet_count', 'failures_for_offline', 'successes_for_online'];
    const changed = watched.filter((k) => before && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    if (changed.length) {
      logEvent('info', 'engine_settings_applied', {
        changed: changed.join(','),
        mode: after.engine_mode,
        maxWorkers: after.max_workers,
        intervalSec: after.ping_interval,
        engineEnabled: !!after.engine_enabled,
      });
    }
    if (after.engine_mode === 'simulate' && (!before || before.engine_mode !== 'simulate')) {
      log('warn', 'حالت شبیه‌سازی فعال است؛ نمونه‌های ثبت‌شده دادهٔ واقعی نیستند و با mode=simulate برچسب می‌خورند.');
      logEvent('warn', 'engine_simulation_enabled', { source: 'settings' });
    }
    // با خروج از حالت شبیه‌سازی، حالت داخلی شبیه‌ساز پاک می‌شود تا بازگشت دوباره
    // به آن، ادامهٔ «قطعبی‌های ساختگی» قبلی نباشد.
    if (after.engine_mode !== 'simulate') simState.clear();
    if (this.emitToBus) bus.emit('engine', this.getStatus());
    return this.getStatus();
  }

  rules() {
    if (Date.now() - this.rulesCache.at > 10000) {
      this.rulesCache = { at: Date.now(), rows: S().rules.all() };
    }
    return this.rulesCache.rows;
  }

  windows() {
    if (Date.now() - this.windowsCache.at > 30000) {
      this.windowsCache = { at: Date.now(), rows: S().windows.all() };
    }
    return this.windowsCache.rows;
  }

  /**
   * شروع موتور. اگر خاموش‌سازی در جریان باشد، تا پایان آن صبر می‌کند؛ پس
   * هرگز موتور قدیمی و جدید هم‌زمان بررسی نمی‌کنند.
   */
  async start() {
    if (this._startPromise) return this._startPromise;
    this._startPromise = (async () => {
      if (this._stopping) {
        try {
          await this._stopping;
        } catch {
          /* خطای تخلیهٔ قبلی مانع شروع تازه نمی‌شود */
        }
      }
      return this._startNow();
    })();
    try {
      return await this._startPromise;
    } finally {
      this._startPromise = null;
    }
  }

  async _startNow() {
    if (this.running) return this.getStatus();
    this.running = true;
    this.accepting = true;
    this.lifecycle += 1;
    this._stopFinalized = false;
    this.stats.startedAt = Date.now();
    this.leader = this.lock.tryAcquire();
    this.epoch = this.leader ? this.lock.epoch : 0;
    this.lastLockAttempt = Date.now();
    if (this.leader) {
      this.lastRenew = Date.now();
      this.startLeaseRenewal();
    } else {
      // نمونهٔ دیگری (مثلاً سرور، وقتی engine-cli جداگانه هم اجرا شده) رهبر است.
      // این نمونه بدون Ping در حالت آماده‌به‌کار می‌ماند و بعداً قفل را می‌گیرد.
      log('warn', 'یک موتور دیگر فعال است؛ این نمونه در حالت آماده‌به‌کار (standby) می‌ماند و Ping نمی‌زند.');
      logEvent('warn', 'engine_standby', { owner: this.lock.status().owner });
    }
    probeIcmp()
      .then((ok) => {
        log('engine', ok ? 'ICMP در دسترس است؛ حالت واقعی آماده به کار است.' : 'ICMP در دسترس نیست؛ درخواست‌ها روی TCP انجام می‌شود.');
      })
      .catch((e) => logEvent('warn', 'icmp_probe_failed', { message: String(e?.message || e) }));
    // وضعیت تجهیزات و قطعی‌های باز از پایگاه‌داده بازیابی می‌شوند: هیچ وضعیتی
    // بازنشانی نمی‌شود و هیچ قطعی بازی بسته نمی‌شود؛ فقط ارجاع‌های شکسته اصلاح و
    // قطعی‌های باز تکراری تجمیع می‌شوند.
    if (this.leader) {
      try {
        this.recoverState();
      } catch (e) {
        this.noteInternalError(e, { phase: 'recover' });
      }
      // روزهایی که موتور در آن‌ها خاموش بوده (یا تنها engine-cli اجرا شده) در
      // daily_stats رکورد ندارند؛ یک‌بار در شروع، روزهای جامانده تجمیع می‌شوند.
      try {
        this.backfillDays();
      } catch (e) {
        this.noteInternalError(e, { phase: 'backfill' });
      }
    }
    const s = this.settings();
    if (s.engine_mode === 'simulate') {
      log('warn', 'موتور در حالت شبیه‌سازی اجرا می‌شود؛ برای پایش واقعی، حالت را به «خودکار» تغییر دهید.');
      logEvent('warn', 'engine_simulation_enabled', { source: 'start' });
    }
    this.startLoop();
    this.stats.lastTickAt = Date.now();
    log('info', 'موتور مانیتورینگ راه‌اندازی شد.');
    logEvent('info', 'engine_started', {
      mode: s.engine_mode,
      intervalSec: s.ping_interval,
      maxWorkers: s.max_workers,
      leader: this.leader,
      epoch: this.epoch,
      owner: this.lock.owner,
      pid: process.pid,
    });
    if (this.emitToBus) bus.emit('engine', this.getStatus());
    return this.getStatus();
  }

  /**
   * چرخهٔ حیات استاندارد: Stop سپس Start (با تخلیهٔ بررسی‌های در جریان).
   * تنظیمات، وضعیت تجهیزات و قطعی‌های باز بین این دو دست‌نخورده می‌مانند.
   *
   * Restart سریالی است: تا زمانی که عملیات قبلی تخلیه/باطل نشده، موتور تازه
   * شروع نمی‌شود؛ بنابراین دو موتور (قدیمی و جدید) هم‌زمان Probe نمی‌زنند.
   */
  restart(options = {}) {
    if (this._restartPromise) return this._restartPromise;
    const drainMs = Math.max(0, Number(options.drainMs ?? config.shutdownTimeoutMs) || 0);
    this._restartPromise = (async () => {
      logEvent('info', 'engine_restart_begin', { inflight: this.inflight.size, epoch: this.epoch });
      await this.stop({ drainMs });
      const status = await this.start();
      logEvent('info', 'engine_restart_done', { mode: status.mode, leader: status.leader, epoch: status.epoch });
      return status;
    })().finally(() => {
      this._restartPromise = null;
    });
    return this._restartPromise;
  }

  /**
   * توقف کنترل‌شده:
   *   1) پذیرش چرخه/عملیات تازه متوقف می‌شود (accepting=false).
   *   2) تایمر چرخه و تایمر تمدید Lease آزاد می‌شوند.
   *   3) عملیات در جریان تا مهلت تخلیه می‌شوند؛ در این فاصله هنوز رهبر است،
   *      پس نتایجشان معتبر و قابل ثبت است.
   *   4) سپس نسل چرخهٔ حیات جلو می‌رود (عملیات باقی‌مانده fencing می‌شوند) و
   *      تنها پس از آن قفل رهبری آزاد می‌شود.
   * تابع برای سازگاری با فراخوانی‌های قبلی، در نبود عملیات در جریان هم‌زمان
   * (synchronously) قفل را آزاد می‌کند و یک Promise resolve‌شده برمی‌گرداند.
   */
  stop(options = {}) {
    const drainMs = Math.max(0, Number(options.drainMs ?? this.stopDrainMs) || 0);
    this.accepting = false;
    this.running = false;
    this._loopActive = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopLeaseRenewal();
    // هشدارهای معوق در خاموش‌سازی لغو می‌شوند؛ پس از توقف موتور نباید تایمری
    // در پس‌زمینه هشدار ثبت کند.
    this.clearPending();

    const finalize = () => {
      if (this._stopFinalized) return;
      this._stopFinalized = true;
      // نسل جدید: هر عملیاتی که هنوز تمام نشده و lease قدیمی دارد، دیگر
      // نمی‌تواند بنویسد (حتی اگر پس از این لحظه برگردد).
      this.lifecycle += 1;
      // هر نتیجهٔ صف‌شده پس از افزایش نسل حیات دیگر معتبر نیست و همین‌جا رد
      // می‌شود؛ هیچ نوشتنی پس از توقف/ری‌استارت ثبت نمی‌شود.
      this._flushRecords();
      this.transientOps = 0;
      try {
        this.lock.release();
      } catch {
        /* قفل ممکن است پیش‌تر از دست رفته باشد */
      }
      this.leader = false;
      this.epoch = 0;
      log('info', 'موتور مانیتورینگ متوقف شد.');
      logEvent('info', 'engine_stopped', {
        cycles: this.stats.cycles,
        checksRun: this.stats.checksRun,
        fenced: this.stats.fenced,
        pid: process.pid,
      });
      if (this.emitToBus) bus.emit('engine', this.getStatus());
    };

    if (this._stopping) return this._stopping;
    // توقف فوری (drainMs=0): وضعیت عملیات در جریان «لغو/fenced» تعیین می‌شود و
    // قفل هم‌زمان آزاد می‌گردد؛ بدون این حالت، فراخوان بعدی در همان فرآیند ممکن
    // بود پیش از آزادشدن قفل اجرا شود.
    if (!this.inflight.size || drainMs <= 0) {
      if (this.inflight.size) {
        log('warn', `توقف موتور با ${this.inflight.size} بررسی در جریان؛ نتایج آن‌ها باطل (fenced) می‌شوند.`);
        logEvent('warn', 'engine_immediate_stop_fenced', { inflight: this.inflight.size });
      }
      finalize();
      return Promise.resolve(this.getStatus());
    }
    this._stopping = this.drain(drainMs)
      .then((drained) => {
        if (!drained) {
          log('warn', `مهلت تخلیهٔ بررسی‌های در جریان تمام شد؛ ${this.inflight.size} بررسی باطل (fenced) شد.`);
          logEvent('warn', 'engine_drain_timeout', { inflight: this.inflight.size, drainMs });
        }
        finalize();
        return this.getStatus();
      })
      .finally(() => {
        this._stopping = null;
      });
    return this._stopping;
  }

  /**
   * تا پایان بررسی‌های در جریان صبر می‌کند تا خاموش‌سازی، نمونه‌های نیمه‌کاره را
   * از دست ندهد و پس از بستن پایگاه‌داده نوشتنی انجام نشود.
   * @returns {Promise<boolean>} true اگر همهٔ بررسی‌ها در مهلت تمام شدند
   */
  async drain(timeoutMs = 5000) {
    const tasks = [...this.inflight.values()];
    if (!tasks.length) return true;
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, Number(timeoutMs) || 0));
      if (timer.unref) timer.unref();
    });
    const done = Promise.allSettled(tasks).then(() => true);
    const result = await Promise.race([done, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }

  /**
   * ثبت نتیجهٔ یک بررسی. در حالت چرخه، نوشتن در صف کوتاه گروهی قرار می‌گیرد تا
   * چند بررسی با یک COMMIT/fsync ثبت شوند؛ هر مورد داخل تراکنش بیرونی با
   * SAVEPOINT مستقل اجرا می‌شود (اتمی بودن هر تجهیز حفظ می‌شود). بررسی دستی و
   * مسیرهای بدون حلقه، همان تراکنش فوری قبلی را دارند.
   */
  _record(fn, label = 'engine.record', immediate = false) {
    if (!this._loopActive || immediate) return transaction(fn, { label });
    return new Promise((resolve, reject) => {
      this._recordQueue.push({ fn, label, resolve, reject });
      if (this._recordQueue.length >= RECORD_BATCH_MAX) {
        this._flushRecords();
        return;
      }
      if (!this._recordFlushTimer) {
        this._recordFlushTimer = setTimeout(() => {
          this._recordFlushTimer = null;
          this._flushRecords();
        }, RECORD_FLUSH_MS);
        // این تایمر نباید unref شود: تا زمانی که نتایج در صف نوشتن است، کار واقعی
        // در جریان است. با unref، فرآیندی که فقط همین انتظار را دارد (مثلاً
        // `engine-cli --once` که موتور را start کرده و منتظر tick می‌ماند) با حلقهٔ
        // رویداد خالی می‌شود و Node با کد ۱۳ (unsettled top-level await) خارج می‌شود
        // بی‌آنکه نمونه‌ها ثبت شده باشند — هم خروجی تست‌ها خراب می‌شد و هم داده گم می‌شد.
      }
    });
  }

  /** اجرای اتمیک صف نوشتن؛ همهٔ نتایج پس از COMMIT موفق resolve می‌شوند. */
  _flushRecords() {
    if (this._recordFlushTimer) {
      clearTimeout(this._recordFlushTimer);
      this._recordFlushTimer = null;
    }
    if (!this._recordQueue.length) return;
    const batch = this._recordQueue.splice(0, this._recordQueue.length);
    const outcomes = [];
    try {
      transaction(
        () => {
          for (const item of batch) {
            try {
              outcomes.push({ ok: true, value: transaction(item.fn, { label: item.label }) });
            } catch (e) {
              outcomes.push({ ok: false, error: e });
            }
          }
        },
        { label: 'engine.record.batch' }
      );
    } catch (e) {
      // شکست خود تراکنش بیرونی (مانند قطع اتصال یا کمبود دیسک): هیچ نوشتنی
      // ثبت نشده است، پس همهٔ موارد صف با همان خطا رد می‌شوند.
      for (const item of batch) item.reject(e);
      return;
    }
    for (let i = 0; i < batch.length; i++) {
      const outcome = outcomes[i];
      if (outcome?.ok) batch[i].resolve(outcome.value);
      else batch[i].reject(outcome?.error || new Error('ثبت نتیجهٔ بررسی انجام نشد.'));
    }
  }

  /* ---------------- حلقهٔ خودزمان‌بند ---------------- */

  /**
   * حلقهٔ چرخه را آغاز می‌کند. یک watchdog با فاصلهٔ `interval` برای دستگاه‌هایی
   * که سررسیدشان در آینده است و refill کوتاه پس از آزادشدن ظرفیت اجرا می‌شود.
   */
  startLoop() {
    this._loopActive = true;
    this._scheduleLoop(0);
  }

  /**
   * زمان‌بندی چرخهٔ بعدی. اگر تایمری از قبل در انتظار است، دوباره ساخته نمی‌شود
   * (جلوگیری از انبوه تایمر در پایان هم‌زمان چند بررسی).
   */
  _scheduleLoop(delayMs) {
    if (!this.running || !this._loopActive || this.timer || this._loopBusy) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this._runLoopStep();
    }, Math.max(0, delayMs));
    if (this.timer.unref) this.timer.unref();
  }

  /** یک گام حلقه: tick را شروع می‌کند و بدون انتظار برای پایان پروب‌ها، گام بعدی
   * را زمان‌بندی می‌کند. ظرفیت هم‌زمانی در خود tick اعمال می‌شود. */
  _runLoopStep() {
    if (!this.running || !this._loopActive) return;
    this._loopBusy = true;
    // tick تا نخستین await به‌صورت همگام اجرا می‌شود، پس مقدار «تعداد شروع‌شده»
    // بلافاصله در دسترس است.
    const task = this.tick();
    const launched = Number(this.stats.lastTickLaunched) || 0;
    const capacity = Number(this.stats.lastTickCapacity) || 0;
    this._saturated = capacity > 0 && launched >= capacity;
    this._loopBusy = false;
    task.catch((e) => this.noteInternalError(e, { phase: 'tick' }));
    this._scheduleLoop(this._saturated ? REFILL_DELAY_MS : this.interval);
  }

  /**
   * آزادشدن یک جایگاه ظرفیت: اگر موتور اشباع بود، چرخهٔ بعدی را تقریباً فوری
   * زمان‌بندی می‌کند. در حالت بی‌کار این فراخوانی اثری ندارد و watchdog کار را
   * انجام می‌دهد؛ بنابراین حلقه هرگز بیکار نمی‌چرخد.
   */
  _notifyCapacityFreed() {
    if (!this.running || !this._loopActive || !this._saturated) return;
    const now = Date.now();
    if (now - this._lastRefillAt < REFILL_DELAY_MS) {
      this._scheduleLoop(REFILL_DELAY_MS);
      return;
    }
    this._lastRefillAt = now;
    this._scheduleLoop(REFILL_DELAY_MS);
  }

  /**
   * وضعیت سلامت موتور — مستقل از سلامت تجهیزات.
   * «سالم» بودن یک تجهیز هیچ چیزی دربارهٔ موتور نمی‌گوید و برعکس: موتور می‌تواند
   * زنده باشد در حالی که همهٔ تجهیزات قطع‌اند، یا تجهیزات وصل باشند در حالی که
   * موتور متوقف/گیرکرده است.
   */
  getStatus() {
    const s = this.settings();
    const now = Date.now();
    const tickLagMs = this.stats.lastTickAt ? Math.max(0, now - this.stats.lastTickAt - this.interval) : 0;
    const stalled = this.running && this.leader && tickLagMs > this.stallMs;
    const expectMs = Math.max(5000, Number(s.ping_interval || 30) * 1000 * 3);
    const staleMs = this.stats.lastRunAt ? now - this.stats.lastRunAt : null;
    return {
      running: this.running,
      mode: s.engine_mode,
      // دادهٔ شبیه‌سازی‌شده باید همیشه از دادهٔ واقعی قابل تشخیص باشد.
      simulation: s.engine_mode === 'simulate',
      engineEnabled: !!s.engine_enabled,
      icmpAvailable: icmpStatus(),
      interval: s.ping_interval,
      maxWorkers: s.max_workers,
      inflight: this.inflight.size,
      activeOps: this.activeOps,
      pendingAlerts: this.pending.size,
      accepting: this.accepting,
      leader: this.leader,
      // Fencing Token جاری این نمونه (۰ = رهبر نیست)
      epoch: this.epoch,
      lifecycle: this.lifecycle,
      lock: this.lock.status(),
      healthy: !this.running ? false : !(stalled || (staleMs != null && staleMs > expectMs)),
      tickLagMs,
      stalled,
      lastTickAt: this.stats.lastTickAt,
      ...this.stats,
    };
  }

  /* ---------------- خطاها، هشدار مستقل و بازیابی ---------------- */

  /** کد خطای داخلی را از خطای شبکه تفکیک می‌کند. */
  internalErrorCode(err, phase) {
    const text = `${err?.code || ''} ${err?.message || ''}`;
    if (/DB_|SQLITE|constraint|database|no such table|closed/i.test(text)) return 'ENGINE_DB';
    if (/PROBE_DEADLINE/i.test(text)) return 'ENGINE_PROBE';
    // کد صریح خطا (مثلاً از لایهٔ پروب) گویاتر از دسته‌بندی عمومی است؛ فقط کدهای
    // استاندارد Node (ERR_*) نادیده گرفته می‌شوند تا لاگ پرنویز نشود.
    if (err?.code && typeof err.code === 'string' && !/^ERR_/.test(err.code)) return err.code;
    if (phase === 'probe') return 'ENGINE_PROBE';
    return 'ENGINE_INTERNAL';
  }

  /**
   * ثبت استاندارد خطای داخلی موتور. چنین خطایی هرگز «قطع تجهیز» نیست و نباید به
   * عنوان شکست شبکه در شاخص‌ها بیاید؛ پس فقط لاگ/شمارنده/هشدار مستقل موتور می‌سازد.
   */
  noteInternalError(err, { phase = 'unknown', deviceId = null } = {}) {
    const code = this.internalErrorCode(err, phase);
    const ts = Date.now();
    // Fencing/از دست دادن رهبری خطای داخلی نیست؛ هشدار «اختلال موتور» نمی‌سازد
    // (انتقال رهبری رفتار مورد انتظار است) اما برای ردیابی ثبت می‌شود.
    if (code === 'ENGINE_FENCED' || code === 'ENGINE_NOT_LEADER') {
      this.stats.lastErrorCode = code;
      logEvent('warn', 'engine_write_rejected', { code, phase, deviceId, leader: this.leader, epoch: this.epoch });
      return code;
    }
    this.stats.errors++;
    this.stats.internalErrors++;
    this.stats.lastErrorAt = ts;
    this.stats.lastErrorCode = code;
    log('error', `خطای داخلی موتور (${phase}${deviceId ? ` — تجهیز #${deviceId}` : ''}): ${err?.message || err}`);
    logEvent('error', 'engine_internal_error', {
      code,
      phase,
      deviceId,
      message: String(err?.message || err),
      mode: this.settings().engine_mode,
      leader: this.leader,
    });
    // اختلال موتور هشدار مستقل خودش را دارد (kind='engine' و بدون تجهیز)
    if (phase !== 'recover') this.raiseIncident(code, `اختلال موتور در مرحله ${phase}: ${err?.message || err}`, ts);
    return code;
  }

  /**
   * هشدار مستقل اختلال موتور. در جدول هشدارها با kind='engine' و بدون تجهیز
   * ثبت می‌شود تا در مرکز هشدارها دیده شود، اما هرگز با هشدارهای تجهیز قاطی نشود.
   */
  raiseIncident(code, message, ts = Date.now()) {
    // نمونهٔ standby/running بدون رهبری نباید در جدول هشدار بنویسد.
    if (this.running && !this.leader) return null;
    const key = `engine:${code}`;
    const last = this.lastIncidentAt.get(key) || 0;
    if (this.incidentActive.get(key)) return null;
    if (ts - last < ENGINE_INCIDENT_COOLDOWN_MS) return null;
    this.lastIncidentAt.set(key, ts);
    const title = 'اختلال موتور مانیتورینگ';
    try {
      const res = S().insertAlert.run(null, null, 'critical', 'engine', title, message, null, ts, 'active', 1, key);
      this.incidentActive.set(key, Number(res.lastInsertRowid));
      logEvent('error', 'engine_incident', { code, message });
      const saved = { id: Number(res.lastInsertRowid), deviceId: null, severity: 'critical', kind: 'engine', title, message, created_at: ts, status: 'active' };
      this.emit('alert', saved);
      if (this.emitToBus) bus.emit('alert', saved);
      return saved;
    } catch (e) {
      // ثبت هشدار موتور نباید خودش موتور را متوقف کند
      logEvent('error', 'engine_incident_failed', { code, message: String(e?.message || e) });
      return null;
    }
  }

  /** بستن هشدارهای مستقل موتور پس از بازگشت به وضعیت پایدار */
  resolveIncidents(ts = Date.now(), reason = '') {
    let changes = 0;
    try {
      changes = Number(db.prepare("UPDATE alerts SET status='resolved', resolved_at=? WHERE device_id IS NULL AND kind='engine' AND status IN ('active','acknowledged')").run(ts).changes) || 0;
    } catch (e) {
      logEvent('error', 'engine_incident_resolve_failed', { message: String(e?.message || e) });
    }
    if (changes) {
      this.incidentActive.clear();
      logEvent('info', 'engine_incident_resolved', { reason, resolved: changes });
      if (this.emitToBus) bus.emit('alerts-changed', { engine: true });
    }
    return changes;
  }

  /**
   * پایش سلامت خود موتور در هر چرخه (مستقل از تجهیزات).
   * • اگر حلقهٔ چرخه گیر کرده باشد (کار همگام طولانی/قفل پایگاه‌داده) هشدار می‌دهد.
   * • اگر عقب‌ماندگی زمان‌بندی از حد بگذرد، هشدار می‌دهد.
   * • پس از پایدارشدن، هشدارهای موتور بسته می‌شوند.
   */
  checkEngineHealth(now = Date.now()) {
    if (!this.running || !this.leader) return;
    const { stalled, tickLagMs } = this.getStatus();
    if (stalled) {
      this.raiseIncident('ENGINE_STALLED', `حلقهٔ موتور ${Math.round(tickLagMs / 1000)} ثانیه عقب افتاده است (کار همگام یا قفل پایگاه‌داده).`, now);
      return;
    }
    // عقب‌ماندگی زمان‌بندی: تأخیر شروع بررسی‌ها از سررسیدشان
    const lag = this.stats.scheduling.lastLagMs;
    const intervalMs = Math.max(5000, Number(this.settings().ping_interval || 30) * 1000);
    if (lag > intervalMs * 2) {
      this.raiseIncident('ENGINE_LAG', `تأخیر زمان‌بندی بررسی‌ها ${Math.round(lag / 1000)} ثانیه است (بازهٔ تنظیم‌شده: ${Math.round(intervalMs / 1000)} ثانیه).`, now);
      return;
    }
    // بازگشت به وضعیت پایدار: تنها وقتی بی‌خطایی ادامه داشته باشد، هشدارهای
    // مستقل موتور بسته می‌شوند؛ یک خطای پراکنده نباید هشدار را تا ابد باز نگه دارد
    // و یک خطای پیوسته هم نباید آن را فوراً ببندد.
    if (this.incidentActive.size) {
      const quietFor = this.stats.lastErrorAt ? now - this.stats.lastErrorAt : Infinity;
      if (quietFor >= this.incidentGraceMs) this.resolveIncidents(now, 'بازگشت به وضعیت پایدار');
    }
  }

  /**
   * بازیابی وضعیت از پایگاه‌داده در راه‌اندازی/بازگشت (Start / Restart / Recovery):
   * • قطعی بازِ یتیم به تجهیز وصل می‌شود (وگرنه یک حادثهٔ در جریان بی‌سند می‌ماند).
   * • ارجاع به قطعی بسته/ناموجود پاک می‌شود.
   * • قطعی‌های باز تکراری یک تجهیز تجمیع می‌شوند (قید یکتا هم پشتیبان آن است).
   * • وضعیت «قطع» بدون هیچ قطعی باز اصلاح می‌شود تا بررسی بعدی، قطعیِ دوم نسازد.
   * هیچ تجهیز در این مرحله Offline/Online نمی‌شود؛ فقط سازگاری داده اصلاح می‌گردد.
   */
  recoverState() {
    const ts = Date.now();
    return transaction(
      () => {
        const report = { adopted: 0, dangling: 0, duplicates: 0, reopened: 0 };
        for (const row of S().orphans.all()) {
          // سایر قطعی‌های باز همین تجهیز بسته می‌شوند و تنها همین یک ردیف می‌ماند
          S().closeOpenOutages.run(ts, ts, row.device_id, row.id);
          S().adoptOutage.run(row.id, row.started_at, row.device_id);
          report.adopted++;
        }
        report.dangling = Number(S().danglingRefs.all().length) || 0;
        S().clearDanglingOutage.run();
        for (const d of S().offlineWithoutOutage.all()) {
          const res = S().openOutage.run(d.id, ts, null, null, d.status_reason || 'Ping Timeout', '', null, null);
          db.prepare('UPDATE devices SET current_outage_id = ?, current_outage_started_at = ? WHERE id = ?').run(
            Number(res.lastInsertRowid), ts, d.id
          );
          report.reopened++;
        }
        return report;
      },
      { label: 'engine.recover' }
    );
  }

  /**
   * اطمینان از رهبری پیش از هر چرخه. رهبری با TTL تمدید می‌شود؛ اگر تمدید
   * شکست بخورد (نمونهٔ دیگری قفل را گرفته) بررسی‌ها متوقف می‌شوند تا دو نمونه
   * هرگز هم‌زمان Ping نزنند.
   */
  ensureLeader(now = Date.now()) {
    if (this.leader) {
      if (now - this.lastRenew < this.lock.ttlMs / 3) return true;
      if (this.lock.renew(now)) {
        this.lastRenew = now;
        this.epoch = this.lock.epoch;
        return true;
      }
      this.clearLeadership('renew_failed');
      this.lastLockAttempt = now;
      return false;
    }
    if (now - this.lastLockAttempt < this.lockRetryMs) return false;
    this.lastLockAttempt = now;
    if (this.lock.tryAcquire(now)) {
      this.leader = true;
      this.epoch = this.lock.epoch;
      this.lastRenew = now;
      this.startLeaseRenewal();
      log('info', 'قفل رهبری موتور گرفته شد؛ بررسی‌ها از این نمونه ادامه می‌یابد.');
      logEvent('info', 'engine_leader_acquired', { owner: this.lock.owner, epoch: this.epoch });
      if (this.emitToBus) bus.emit('engine', this.getStatus());
      return true;
    }
    return false;
  }

  /* ---------------- Fencing و چرخهٔ حیات عملیات ---------------- */

  /** تمدید دوره‌ای Lease مستقل از چرخهٔ اصلی؛ Probe طولانی TTL را منقضی نمی‌کند */
  startLeaseRenewal() {
    if (this.leaseTimer) return;
    const every = Math.max(500, Math.floor(this.lock.ttlMs / 3));
    this.leaseTimer = setInterval(() => this.renewLease(), every);
    if (this.leaseTimer.unref) this.leaseTimer.unref();
  }

  stopLeaseRenewal() {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = null;
  }

  renewLease() {
    if (!this.leader || !this.lock.held) return false;
    if (this.lock.renew()) {
      this.lastRenew = Date.now();
      return true;
    }
    this.clearLeadership('renew_failed');
    return false;
  }

  /**
   * از دست دادن رهبری: تایمر تمدید متوقف، وضعیت محلی پاک و در صورت درخواست
   * قفل آزاد می‌شود. عملیات در جریان با بررسی epoch در زمان ثبت، باطل می‌شوند.
   */
  clearLeadership(reason = 'lost', { release = false } = {}) {
    this.stopLeaseRenewal();
    if (release) {
      try {
        this.lock.release();
      } catch {
        /* بی‌اثر */
      }
    } else {
      this.lock.held = false;
    }
    const hadEpoch = this.epoch;
    this.leader = false;
    this.epoch = 0;
    if (reason === 'manual_operation_complete') {
      log('engine', 'بررسی دستی تمام شد؛ قفل رهبری موقت آزاد شد.');
    } else {
      log('error', 'قفل رهبری موتور از دست رفت؛ این نمونه بررسی‌ها را متوقف کرد.');
    }
    logEvent('warn', 'engine_leader_lost', { reason, owner: this.lock.status().owner, epoch: hadEpoch });
    if (this.emitToBus) bus.emit('engine', this.getStatus());
  }

  /**
   * شروع یک عملیات با Lease معتبر. برای بررسی‌های زمان‌بندی‌شده، tick از قبل
   * رهبر است؛ برای بررسی دستی (وقتی موتور خاموش/standby است) یک Lease کوتاه
   * گرفته می‌شود تا نوشتن نتیجه بدون رهبری ممکن نباشد.
   * @throws {EngineNotLeaderError} اگر نمونهٔ دیگری رهبر باشد
   */
  beginOperation(now = Date.now()) {
    if (this.leader && this.lock.held && this.lock.verify(this.epoch, now)) {
      this.activeOps += 1;
      return { epoch: this.epoch, lifecycle: this.lifecycle, startedAt: now, transient: false };
    }
    if (this.leader) this.clearLeadership('lease_invalid');
    if (!this.lock.tryAcquire(now)) throw new EngineNotLeaderError();
    this.leader = true;
    this.epoch = this.lock.epoch;
    this.lastRenew = now;
    this.startLeaseRenewal();
    const transient = !this.running;
    if (transient) this.transientOps += 1;
    this.activeOps += 1;
    logEvent('info', 'engine_leader_acquired', { owner: this.lock.owner, epoch: this.epoch, transient });
    return { epoch: this.epoch, lifecycle: this.lifecycle, startedAt: now, transient };
  }

  /** پایان عملیات؛ Lease موقتِ بررسی دستی بی‌درنگ آزاد می‌شود */
  endOperation(lease) {
    this.activeOps = Math.max(0, this.activeOps - 1);
    if (lease?.transient && !this.running && this.activeOps === 0 && this.transientOps > 0) {
      this.transientOps = 0;
      this.clearLeadership('manual_operation_complete', { release: true });
    }
  }

  /** عکس فوری Lease برای عملیات‌هایی که در چرخهٔ tick شروع می‌شوند */
  leaseSnapshot() {
    return { epoch: this.epoch, lifecycle: this.lifecycle, startedAt: Date.now(), transient: false };
  }

  /**
   * اعتبار Fencing: نسل چرخهٔ حیات باید ثابت مانده باشد و ردیف قفل در
   * پایگاه‌داده همان owner/epoch و TTL معتبر را نشان دهد.
   */
  isLeaseValid(lease, now = Date.now()) {
    if (!lease || lease.lifecycle !== this.lifecycle) return false;
    if (!this.leader || !this.lock.held) return false;
    return this.lock.verify(lease.epoch, now);
  }

  assertLeaseValid(lease) {
    if (!this.isLeaseValid(lease)) throw new EngineFencedError();
  }

  /** علامت‌گذاری نتیجهٔ باطل‌شده و ثبت ساختاریافته */
  noteFenced(lease, deviceId, phase) {
    this.stats.fenced += 1;
    logEvent('warn', 'engine_write_fenced', {
      deviceId,
      phase,
      epoch: lease?.epoch ?? null,
      currentEpoch: this.epoch,
      lifecycle: lease?.lifecycle ?? null,
      currentLifecycle: this.lifecycle,
      leader: this.leader,
    });
  }

  /* ---------------- چرخه اصلی ---------------- */
  async tick() {
    if (!this.running) return;
    const tickStarted = Date.now();
    // بدون قفل رهبر (یا با قفل ازدست‌رفته) هیچ بررسی‌ای انجام نمی‌شود.
    if (!this.ensureLeader()) {
      this.stats.lastTickLaunched = 0;
      this.stats.lastTickCapacity = 0;
      this.stats.lastTickReady = 0;
      this.stats.lastTickMs = Date.now() - tickStarted;
      return;
    }
    // مقدار چرخهٔ قبل پاک می‌شود تا حلقه هیچ‌گاه بر پایهٔ وضعیت کهنه تصمیم نگیرد.
    this.stats.lastTickLaunched = 0;
    this.stats.lastTickCapacity = 0;
    this.stats.lastTickReady = 0;
    // Lease این چرخه برای همهٔ بررسی‌های همین tick؛ اگر در میانهٔ کار رهبری
    // عوض شود، نتایج با epoch قدیمی باطل می‌شوند.
    const lease = this.leaseSnapshot();
    const s = this.settings();
    // عقب‌ماندگی حلقه پیش از به‌روزرسانی زمان چرخه سنجیده می‌شود؛ همین مقدار
    // شاخص «گیرکردن موتور» را می‌سازد و مستقل از تجهیزات هشدار می‌دهد.
    this.checkEngineHealth(Date.now());
    this.stats.lastTickAt = Date.now();
    this.stats.cycles++;
    this.stats.lastRunAt = Date.now();

    // ترتیب مهم است: نخست تجمیع (تا نمونه‌های دیروز در daily_stats ثبت شوند) و
    // سپس هرس؛ وگرنه با retention_days=1 ممکن بود نمونه‌ها پیش از تجمیع حذف شوند
    // و آمار روزانه برای همیشه سوراخ بماند.
    if (Date.now() - this.lastRollup > ROLLUP_EVERY_MS) {
      this.lastRollup = Date.now();
      this.rollup();
    }
    // هرس داده اکنون در «Retention Engine» مستقل انجام می‌شود (زمان‌بند، قفل،
    // Dry-Run و گزارش). موتور فقط تجمیع روزانه را انجام می‌دهد تا دو مسیر حذف
    // هم‌زمان روی یک پایگاه‌داده نداشته باشیم.
    if (Date.now() - this.lastClockCheck > 60000) {
      this.lastClockCheck = Date.now();
      observeClock();
    }

    if (!s.engine_enabled) return;

    const now = Date.now();
    // tick ها هر ۲۵۰ms اجرا می‌شوند و پروب‌ها چند ثانیه طول می‌کشند، پس چند tick
    // می‌توانند روی هم بیفتند. سقف هم‌زمانی باید دقیقاً رعایت شود: با Math.max(1,…)
    // وقتی موتور پر بود یک بررسی اضافه شروع می‌شد.
    const capacity = Math.max(0, Math.floor(s.max_workers) - this.inflight.size);
    // شاخص عقب‌ماندگی: با ۱۰۰۰ تجهیز، اگر بررسی‌ها بیش از بازهٔ تنظیم‌شده طول
    // بکشند (مثلاً هنگام قطعی گستردهٔ شبکه)، صف بررسی‌ها هرگز خالی نمی‌شود.
    // این شاخص بدون پرس‌وجوی سنگین، وضعیت را برای /health و لاگ قابل‌دیدن می‌کند.
    if (Date.now() - this.lastBacklogCheck > 30000) {
      this.lastBacklogCheck = Date.now();
      const overdue = S().overdue.get(now - Math.max(10000, Number(s.ping_interval || 30) * 2000)).c;
      this.stats.backlog = overdue;
      if (overdue > 0 && Date.now() - this.lastBacklogWarn > 5 * 60 * 1000) {
        this.lastBacklogWarn = Date.now();
        log('warn', `چرخهٔ بررسی از بازهٔ تنظیم‌شده عقب است: ${overdue.toLocaleString('fa-IR')} تجهیز معوق.`);
        logEvent('warn', 'engine_backlog', { overdue, maxWorkers: s.max_workers, inflight: this.inflight.size, intervalSec: s.ping_interval });
      }
    }
    this.stats.lastTickCapacity = capacity;
    if (!capacity) {
      this.stats.lastTickLaunched = 0;
      this.stats.lastTickReady = 0;
      this.stats.lastTickMs = Date.now() - tickStarted;
      return;
    }
    // فقط تجهیزاتی که سررسیدشان رسیده شروع می‌شوند و هرگز بیش از ظرفیت موتور.
    // ورودی هر چرخه محدود است و تجهیزات بدون آنکه در یک صف درون‌حافظه‌ای جا شوند،
    // در همان جدول تجهیزات معوق می‌مانند؛ پس بار زیاد صف نامحدود نمی‌سازد.
    const ready = S().due.all(now, Math.min(capacity * 2, 500)).filter((d) => !this.inflight.has(d.id));
    this.stats.lastTickReady = ready.length;
    const batch = ready.slice(0, capacity);
    this.stats.lastTickLaunched = batch.length;
    // رزرو زمان بررسی بعدی برای کل دسته در یک تراکنش: پیش‌تر هر بررسی یک
    // COMMIT جدا (fsync) برای همین یک UPDATE می‌گرفت.
    if (batch.length) {
      transaction(
        () => {
          this.assertLeaseValid(lease);
          for (const d of batch) {
            const interval = bounded(d.ping_interval ?? s.ping_interval, 5, 86400, 30) * 1000;
            S().scheduleNext.run(Math.max(Number(d.next_check_at) || 0, now) + interval, d.id);
          }
        },
        { label: 'engine.reserve' }
      );
    }
    // عمق واقعی صف = بررسی‌های در جریان + دستگاه‌های معوقِ دیده‌شده. صف در حافظه
    // نگه داشته نمی‌شود؛ خود جدول devices صف است (next_check_at).
    this.stats.queueDepth = this.inflight.size + Math.max(0, ready.length - batch.length);
    this.stats.lastTickMs = Date.now() - tickStarted;
    await Promise.all(
      batch.map((d) =>
        this.checkDevice(d, { lease, preReserved: true }).catch((e) => {
          // پیش‌تر این خطاها بی‌صدا رها می‌شدند و فقط در شمارندهٔ کل «errors»
          // دیده می‌شدند؛ اکنون با کد، مرحله و تجهیز به‌صورت ساختاریافته ثبت
          // و به‌عنوان اختلال موتور هشدار داده می‌شوند.
          this.noteInternalError(e, { phase: 'check', deviceId: d.id });
          return null;
        })
      )
    );
    this.stats.lastCycleMs = Date.now() - tickStarted;
  }

  /** بررسی یک تجهیز و ثبت کامل نتیجه */
  async checkDevice(device, options = {}) {
    // اگر همین تجهیز در حال بررسی است، همان نتیجه به فراخوانی دوم برگردانده می‌شود
    // (پیش‌تر null برمی‌گشت و درخواست دستی «Ping» بی‌پاسخ می‌ماند)
    const running = this.inflight.get(device.id);
    // بررسیِ نسل قبل (پس از Stop/Start) دیگر هرگز نتیجه ثبت نمی‌کند؛ نباید یک
    // بررسی دستی تازه را به همان Promise باطل‌شده گره بزند.
    if (running && running.lifecycle === this.lifecycle) return running;
    const task = this.runCheck(device, options);
    task.lifecycle = this.lifecycle;
    this.inflight.set(device.id, task);
    try {
      return await task;
    } finally {
      // فقط اگر همین عملیات هنوز صاحب جایگاه است حذف می‌شود؛ بررسی باقی‌مانده از
      // نسل قبل (پس از Stop/Start) نباید ورودیِ یک بررسی تازه را پاک کند.
      if (this.inflight.get(device.id) === task) this.inflight.delete(device.id);
      // یک جایگاه ظرفیت آزاد شد؛ اگر موتور اشباع بود چرخهٔ بعدی فوراً اجرا شود.
      this._notifyCapacityFreed();
    }
  }

  /**
   * پوشش خطا دور بررسی یک تجهیز: هر خطای پرتاب‌شده در این مسیر «خطای داخلی
   * موتور» است (خطای شبکه هرگز پرتاب نمی‌شود). نتیجه: تراکنش رول‌بک می‌شود،
   * وضعیت تجهیز تغییر نمی‌کند، نمونه‌ای ثبت نمی‌شود و خطا با جزئیات گزارش
   * می‌گردد — پیش‌تر این خطاها در tick بی‌صدا بلعیده می‌شدند.
   */
  async runCheck(device, options = {}) {
    try {
      return await this.performCheck(device, options);
    } catch (e) {
      // «رهبر نیست» یک خطای عملیاتی قابل‌انتظار است (نمونهٔ standby)؛ به لایهٔ
      // API می‌رسد تا ۴۰۹ روشن برگرداند و به‌عنوان اختلال موتور ثبت نمی‌شود.
      if (e?.code === 'ENGINE_NOT_LEADER') throw e;
      if (e?.code === 'ENGINE_FENCED') {
        this.stats.skipped++;
        this.noteFenced(options.lease, device?.id ?? null, 'record');
        return { deviceId: device?.id ?? null, ts: Date.now(), ok: false, fenced: true, error: 'ENGINE_FENCED', source: options.source || 'engine' };
      }
      this.stats.skipped++;
      this.noteInternalError(e, { phase: 'check', deviceId: device?.id ?? null });
      return null;
    }
  }

  async performCheck(device, options = {}) {
    const lease = options.lease || this.beginOperation();
    const ownsLease = !options.lease;
    try {
      return await this._performCheck(device, options, lease);
    } finally {
      if (ownsLease) this.endOperation(lease);
    }
  }

  /** بررسی مقصد با سیاست متمرکز؛ لاگ تکراری برای یک تجهیز در هر ۵ دقیقه */
  targetAllowed(device, settings) {
    const policy = isProbeTargetAllowed(device.ip, settings);
    if (policy.allowed) return true;
    this.stats.skipped += 1;
    const now = Date.now();
    const last = this.blockedNotices.get(device.id) || 0;
    if (now - last > 5 * 60 * 1000) {
      this.blockedNotices.set(device.id, now);
      log('warn', `بررسی تجهیز #${device.id} (${device.ip}) انجام نشد: مقصد در سیاست شبکه مجاز نیست (${policy.reason}).`);
      logEvent('warn', 'engine_target_blocked', { deviceId: device.id, reason: policy.reason });
    }
    return false;
  }

  async _performCheck(device, { manual = false, source = 'engine', preReserved = false, signal = null } = {}, lease) {
    const s = this.settings();
    // مقادیر تجهیز ممکن است از نسخه‌های قدیمی/ورود داده خراب مانده باشند؛
    // همان مرزهای تنظیمات عمومی اینجا هم اعمال می‌شوند تا موتور در هیچ حالتی
    // بی‌وقفه Ping نکند یا فرمان ping را ساعت‌ها زنده نگه ندارد.
    const interval = bounded(device.ping_interval ?? s.ping_interval, 5, 86400, 30) * 1000;
    // زمان بررسی بعدی همین حالا رزرو می‌شود تا این تجهیز در چرخه‌های بعدی دوباره کاندید
    // نشود. مبنای محاسبه، سررسید قبلی است (نه لحظهٔ اجرا) تا بازهٔ واقعی بررسی‌ها دقیقاً
    // همان بازهٔ تنظیم‌شده بماند و با هر چرخه کمی کوتاه‌تر نشود.
    //
    // همین رزرو، «ثبت دوبارهٔ یک نمونه در یک چرخه» را هم ناممکن می‌کند: هر بررسی
    // پیش از اجرای پروب، سررسید را جلو می‌برد و نمونهٔ دوم برای همان چرخه ساخته نمی‌شود.
    // پیش از هر نوشتن (حتی رزرو زمان بررسی بعدی) اعتبار Fencing بررسی می‌شود؛
    // موتورِ رهبری‌ازدست‌داده نباید حتی زمان‌بندی تجهیز را تغییر دهد.
    this.assertLeaseValid(lease);
    const startedAt = monotonicNow();
    const scheduledAt = Number(device.next_check_at) || 0;
    const dueBase = Math.max(scheduledAt, startedAt);
    // در حالت گروهی، رزرو پیش از شروع پروب و در یک تراکنش انجام شده است.
    if (!preReserved) S().scheduleNext.run(dueBase + interval, device.id);
    // شاخص تأخیر زمان‌بندی: فاصلهٔ زمانی میان زمان برنامه‌ریزی‌شده و شروع واقعی
    if (!manual && scheduledAt > 0) this.recordSchedulingLag(Math.max(0, startedAt - scheduledAt));
    // سیاست شبکه پیش از هر Probe (و حتی در حالت شبیه‌سازی، برای یکدستی)
    if (!this.targetAllowed(device, s)) return null;
    const inWindow = this.inMaintenanceWindow(device.id);
    if (inWindow && !manual) {
      this.stats.skipped++;
      const ts = monotonicNow();
      // در پنجرهٔ تعمیرات بررسی‌ای انجام نمی‌شود، پس قطعی باز و هشدارهای فعال
      // باید همان‌جا بسته/حل شوند؛ وگرنه مدت قطعی در زمان تعمیرات رشد می‌کند و
      // پس از پایان پنجره (اگر تجهیز هنوز قطع باشد) دومین قطعی باز ساخته می‌شود.
      // بستن قطعی باز + حل هشدارها + تغییر وضعیت باید یک‌جا اعمال شوند؛ در غیر این
      // صورت خطا در یکی، تجهیز را در وضعیت متناقض (مثلاً بدون قطعی باز ولی Offline)
      // رها می‌کرد.
      transaction(
        () => {
          this.assertLeaseValid(lease);
          S().closeStaleOpen.run(ts, ts, device.id);
          this.resolveDeviceAlerts(device.id, ts);
          S().markMaintenance.run(STATUS.MAINTENANCE, 'در پنجره تعمیرات — بررسی موقتاً متوقف است', device.id, STATUS.MAINTENANCE);
        },
        { label: 'engine.maintenance' }
      );
      return null;
    }

    const timeoutMs = bounded(device.timeout_ms ?? s.timeout_ms, 100, 30000, 1200);
    const count = Math.round(bounded(device.packet_count ?? s.packet_count, 1, 10, 3));
    const retries = Math.round(bounded(device.retries ?? s.retries, 0, 5, 1));
    const latencyThreshold = bounded(device.latency_threshold ?? s.latency_threshold, 0, 60000, 150);
    const lossThreshold = bounded(device.loss_threshold ?? s.loss_threshold, 0, 100, 10);

    let result;
    try {
      result = await this.probeWithDeadline(device, { timeoutMs, count, retries, mode: s.engine_mode, port: s.tcp_port, signal });
    } catch (e) {
      // مهلت سخت یا خطای خود لایهٔ پروب: این «بی‌پاسخی تجهیز» نیست، پس نه
      // نمونه‌ای ثبت می‌شود و نه شمارندهٔ شکست تجهیز بالا می‌رود.
      this.stats.skipped++;
      this.noteInternalError(e, { phase: 'probe', deviceId: device.id });
      return null;
    }
    const ts = monotonicNow();

    // Fencing پس از Probe: اگر در این فاصله رهبری به فرآیند دیگری منتقل شده یا
    // این نمونه متوقف شده باشد، نتیجه باطل است و هیچ رکوردی نوشته نمی‌شود.
    if (!this.isLeaseValid(lease)) {
      this.noteFenced(lease, device.id, 'after-probe');
      // رهبری واقعاً از دست رفته است؛ وضعیت محلی هم باید پاک شود تا تایمر تمدید
      // بی‌هدف ادامه پیدا نکند. قفل را آزاد نمی‌کنیم (مالک جدید دارد).
      //
      // مهم: فقط عملیاتی که به «همین نسل حیات» تعلق دارد می‌تواند رهبری را پاک
      // کند. یک بررسی باقی‌ماندهٔ نسل قبل (پس از Stop/Start) نباید رهبری تازهٔ
      // نمونه را از بین ببرد؛ پیش‌تر همین حالت، بررسی دستی بعد از ری‌استارت را
      // بی‌دلیل «fenced» می‌کرد.
      if (this.leader && lease.lifecycle === this.lifecycle) this.clearLeadership('fenced_after_probe');
      return null;
    }

    // تجهیز ممکن است در فاصلهٔ اجرای پروب (که چند ثانیه طول می‌کشد) حذف شده باشد؛
    // در آن صورت هر نوشتن روی samples/alerts/outages خطای کلید خارجی می‌دهد و
    // نتیجه هم بی‌معناست. پس بدون ثبت چیزی از بررسی عبور می‌کنیم.
    if (!S().exists.get(device.id)) {
      this.stats.skipped++;
      return null;
    }

    // همهٔ پروب‌های یک موج تقریباً هم‌زمان برمی‌گردند. اگر ثبتِ آن‌ها پشت‌سرهم و
    // بدون Yield انجام شود، حلقهٔ رویداد برای ده‌ها میلی‌ثانیه قفل می‌شود و
    // درخواست‌های HTTP/SSE دیر پاسخ می‌گیرند. یک چرخش setImmediate بین نتایج،
    // نوشتن‌ها را روی چند turn پخش می‌کند؛ گذردهی عملاً تغییر نمی‌کند.
    if (this._loopActive && !manual) await new Promise((resolve) => setImmediate(resolve));

    const failures = result.ok ? 0 : (device.consecutive_failures || 0) + 1;
    const successes = result.ok ? (device.consecutive_successes || 0) + 1 : 0;
    const prevStatus = device.status;

    let status = device.status;
    let reason = device.status_reason || '';
    let outageId = device.current_outage_id || null;
    let outageStart = device.current_outage_started_at || null;
    let lastOutageAt = device.last_outage_at || null;
    let lastRecoveryAt = device.last_recovery_at || null;
    let statusChanged = false;

    // Online/Offline همان تعریف قبلی را دارد (پاسخ هدف پایش)، اما دو مفهوم
    // جدا گزارش می‌شود: دسترسی شبکه (reachable) و سلامت سرویس (service).
    // پورت بسته روی میزبان زنده → reachable=true و service=unavailable؛
    // چنین حالتی با پیام صریح ثبت می‌شود، نه با «عدم پاسخ شبکه».
    const reachable = result.reachable ?? result.ok;
    const isUnreachable = !result.ok;
    const serviceStatus =
      result.service === 'available' || result.service === 'unavailable' ? result.service : 'unknown';
    const servicePort = serviceStatus === 'unknown' ? null : result.servicePort ?? bounded(s.tcp_port, 1, 65535, 80);
    if (serviceStatus === 'unavailable') this.stats.serviceUnavailable += 1;
    // کل ثبت نتیجه (گذار وضعیت، قطعی، هشدار، نمونه و شاخص‌های تجهیز) یک عملیات
    // منطقی است: شکست در هر مرحله، همهٔ تغییرات این بررسی را برمی‌گرداند تا
    // نمونه‌ای بدون تجهیز به‌روزشده یا قطعیِ باز بدون هشدار باقی نماند.
    const payload = await this._record(
      () => {
    // آخرین خط دفاع: بررسی epoch در همان تراکنش ثبت. اگر رهبری عوض شده باشد،
    // تراکنش پیش از هر نوشتنی rollback می‌شود.
    this.assertLeaseValid(lease);
    let isDegraded = false;
    if (result.ok) {
      const effRtt = result.rtt ?? 0;
      if (effRtt > latencyThreshold) isDegraded = true;
      if (result.lossPct > lossThreshold) isDegraded = true;
    }

    // ---- گذارها ----
    if (isUnreachable && device.status !== STATUS.OFFLINE && failures >= s.failures_for_offline) {
      status = STATUS.OFFLINE;
      reason =
        reachable && serviceStatus === 'unavailable'
          ? `میزبان پاسخ می‌دهد اما سرویس پورت ${servicePort} در دسترس نیست.`
          : result.error === 'TIMEOUT' || result.error === 'HARD_TIMEOUT'
            ? 'Ping Timeout'
            : `عدم پاسخ (${result.error || 'خطای شبکه'})`;
      const cause = this.guessCause(result, failures);
      const openedOutage = this.openOutageFor(device, ts, ts, cause);
      outageId = openedOutage.id;
      outageStart = openedOutage.startedAt;
      lastOutageAt = ts;
      statusChanged = true;
      this.raiseAlert('offline', device, {
        severity: 'critical',
        title: `قطع ارتباط — ${device.name}`,
        message: `تجهیز ${device.name} (${device.ip}) پس از ${failures} بررسی ناموفق متوالی از دسترس خارج شد. علت تخمینی: ${cause}`,
        value: failures,
        ts,
      });
    } else if (isUnreachable && device.status === STATUS.OFFLINE) {
      status = STATUS.OFFLINE;
    } else if (result.ok && device.status === STATUS.OFFLINE && successes >= s.successes_for_online) {
      status = isDegraded ? STATUS.WARNING : STATUS.ONLINE;
      if (prevStatus === STATUS.OFFLINE) {
        const dur = outageId ? Math.max(1, Math.round((ts - (outageStart || ts)) / 1000)) : null;
        if (outageId) S().closeOutage.run(ts, dur, outageId);
        // سوابق تعمیرات فقط با ثبت کاربر ساخته می‌شوند؛ موتور به‌صورت خودکار
        // برای هر قطعی رکورد نگهداری نمی‌سازد.
        outageId = null;
        outageStart = null;
        this.resolveDeviceAlerts(device.id, ts);
        this.raiseAlert('recovery', device, {
          severity: 'info',
          title: `بازگشت به حالت عادی — ${device.name}`,
          message: `تجهیز ${device.name} (${device.ip}) مجدداً در دسترس است.${dur ? ` مدت قطعی: ${dur} ثانیه.` : ''}`,
          value: successes,
          ts,
        });
      }
      lastRecoveryAt = ts;
      reason = isDegraded ? 'تأخیر یا افت بسته بیش از حد مجاز' : '';
      statusChanged = true;
    } else if (result.ok && device.status !== STATUS.OFFLINE) {
      // تجهیز Offline با یک پاسخ موفق برنمی‌گردد: تا رسیدن به تعداد موفقیت لازم
      // (successes_for_online) در همین وضعیت می‌ماند؛ پیش‌تر این شرط نبود و یک پاسخ
      // موفق کافی بود، یعنی تنظیم «تعداد موفقیت برای بازگشت» عملاً نادیده می‌ماند و
      // تجهیزات ناپایدار می‌توانستند با هر نوسان، قطعیِ تازه بسازند.
      const next = isDegraded ? STATUS.WARNING : STATUS.ONLINE;
      if (next !== device.status && prevStatus !== STATUS.OFFLINE) statusChanged = true;
      status = next;
      reason = isDegraded
        ? result.rtt > latencyThreshold
          ? `تأخیر بالا (${Math.round(result.rtt)} میلی‌ثانیه)`
          : `افت بسته (${result.lossPct}٪)`
        : '';
      if (isDegraded) {
        if (result.rtt > latencyThreshold)
          this.raiseAlert('latency', device, {
            severity: Math.round(result.rtt) > latencyThreshold * 2 ? 'critical' : 'warning',
            title: `تأخیر بالا — ${device.name}`,
            message: `تأخیر تجهیز ${device.name} (${device.ip}) ${Math.round(result.rtt)} میلی‌ثانیه است (آستانه: ${latencyThreshold}).`,
            value: result.rtt,
            ts,
          });
        if (result.lossPct > lossThreshold)
          this.raiseAlert('loss', device, {
            severity: 'warning',
            title: `افت بسته — ${device.name}`,
            message: `افت بسته تجهیز ${device.name} (${device.ip}) ${result.lossPct}٪ است (آستانه: ${lossThreshold}٪).`,
            value: result.lossPct,
            ts,
          });
      } else {
        this.resolveDeviceAlerts(device.id, ts);
      }
    }

    // اصلاح ناسازگاری احتمالی: تجهیز در دسترس نباید قطعیِ باز داشته باشد
    if (status !== STATUS.OFFLINE) {
      const closed = S().closeStaleOpen.run(ts, ts, device.id);
      if (closed.changes > 0 && outageId) {
        outageId = null;
        outageStart = null;
      }
    } else if (!outageId) {
      // تجهیز قطع است اما رکورد قطعی بازی ندارد (مثلاً پس از بازنشانی داده‌ها یا
      // ناسازگاری پس از بازیابی). اگر قطعی باز موجود باشد همان «به فرزندی گرفته»
      // می‌شود تا هرگز قطعی دوم ساخته نشود.
      const started = device.current_outage_started_at || device.last_outage_at || ts;
      const openedOutage = this.openOutageFor(device, started, ts, device.status_reason || 'Ping Timeout');
      outageId = openedOutage.id;
      outageStart = openedOutage.startedAt;
    }

    // نمونه‌ها مبنای Uptime هستند؛ `ok` دقیقاً همان نتیجهٔ هدف پایش است تا
    // تاریخچه و درصد دسترس‌پذیری با نسخهٔ قبل سازگار بماند. شکست سرویس روی
    // میزبان زنده جداگانه در stats.serviceUnavailable شمرده می‌شود.
    const okInt = result.ok ? 1 : 0;
    if (!reachable) this.stats.networkFailures++;
    S().insertSample.run(
      device.id,
      ts,
      result.rtt ?? null,
      result.packetsSent ?? count,
      result.packetsRecv ?? 0,
      result.lossPct ?? (okInt ? 0 : 100),
      status,
      okInt,
      result.mode,
      scheduledAt || null,
      startedAt
    );

    const hasRtt = result.ok && result.rtt != null;
    const nextMin = hasRtt ? Math.min(device.min_rtt_ms ?? result.rtt, result.rtt) : device.min_rtt_ms ?? null;
    const nextMax = hasRtt ? Math.max(device.max_rtt_ms ?? result.rtt, result.rtt) : device.max_rtt_ms ?? null;
    const nextAvg = hasRtt
      ? device.avg_rtt_ms == null
        ? result.rtt
        : Math.round((device.avg_rtt_ms * 0.98 + result.rtt * 0.02) * 100) / 100
      : device.avg_rtt_ms ?? null;

    S().updateDevice.run(
      status,
      reason,
      serviceStatus,
      servicePort,
      ts,
      ts,
      statusChanged ? ts : device.last_status_change_at ?? ts,
      result.rtt ?? null,
      result.lossPct ?? (okInt ? 0 : 100),
      (device.success_count || 0) + okInt,
      (device.fail_count || 0) + (okInt ? 0 : 1),
      (device.total_checks || 0) + 1,
      failures,
      successes,
      lastOutageAt,
      outageId,
      outageStart,
      lastRecoveryAt,
      nextMin,
      nextMax,
      nextAvg,
      device.id
    );

    // مقدار واقعی برای نمایش فوری در UI
    return {
      deviceId: device.id,
      ts,
      status,
      rtt: result.rtt,
      lossPct: result.lossPct,
      ok: result.ok,
      reachable,
      serviceStatus,
      servicePort,
      mode: result.mode,
      source,
      manual,
      interval,
      epoch: lease.epoch,
    };
      },
      'engine.record',
      manual
    );
    this.stats.checksRun++;
    this.emit('sample', payload);
    if (this.emitToBus) bus.emit('sample', payload);
    if (statusChanged) {
      this.emit('status', payload);
      if (this.emitToBus) bus.emit('status', payload);
    }
    return payload;
  }

  /** ثبت آماری تأخیر زمان‌بندی (میانگین متحرک + بیشینه) برای /health و هشدار موتور */
  recordSchedulingLag(lagMs) {
    const s = this.stats.scheduling;
    const lag = Math.max(0, Math.round(lagMs));
    s.lastLagMs = lag;
    s.maxLagMs = Math.max(s.maxLagMs, lag);
    s.samples++;
    s.avgLagMs = s.samples === 1 ? lag : Math.round(s.avgLagMs * 0.9 + lag * 0.1);
    return s;
  }

  /**
   * اجرای پروب با «مهلت سخت» مستقل از لایهٔ پروب. هر لایهٔ پایین محدودیت خودش را
   * دارد (ICMP تایمر سخت، TCP socket timeout)، اما یک باگ یا توقف غیرمنتظره در
   * آن لایه نباید یک بررسی را برای همیشه در inflight نگه دارد؛ آن‌گاه ظرفیت موتور
   * با بررسی‌های آویزان پر می‌شد و بار زیاد به صف نامحدود تبدیل می‌شد.
   */
  async probeWithDeadline(device, options) {
    const attempts = Math.max(1, (options.retries || 0) + 1);
    const perAttempt = Math.max(500, options.timeoutMs * options.count + 2500);
    const deadlineMs = bounded(this.probeDeadlineMs ?? attempts * perAttempt + 2000, 50, 5 * 60 * 1000, 30000);
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`پروب از مهلت سخت ${deadlineMs} میلی‌ثانیه‌ای گذشت`);
        err.code = 'PROBE_DEADLINE';
        reject(err);
      }, deadlineMs);
      if (timer.unref) timer.unref();
    });
    try {
      return await Promise.race([this.probe(device, options), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * ساخت قطعی باز — یا «به فرزندی گرفتن» قطعیِ باز موجود.
   * قید یکتای پایگاه‌داده (open = 1 برای هر تجهیز) تضمین می‌کند هرگز دو قطعی باز
   * برای یک تجهیز ساخته نشود؛ اگر ردیفی از قبل باز باشد همان بازگردانده می‌شود و
   * زمان شروع اصلی‌اش حفظ می‌گردد (پس Crash مدت قطعی را خراب نمی‌کند).
   * @returns {{id:number, startedAt:number, adopted:boolean}}
   */
  openOutageFor(device, startTs, ts, cause = 'Ping Timeout') {
    const existing = S().openOutageFor.get(device.id);
    if (existing) {
      // اگر نسخهٔ قدیمی/بازیابی ناسازگار بیش از یک ردیف باز ساخته باشد، تنها
      // همین ردیف می‌ماند و بقیه با همان زمان پایان بسته می‌شوند.
      S().closeOpenOutages.run(ts, ts, device.id, existing.id);
      if (!device.current_outage_id || Number(device.current_outage_id) !== Number(existing.id)) {
        S().adoptOutage.run(existing.id, existing.started_at, device.id);
      }
      return { id: Number(existing.id), startedAt: Number(existing.started_at), adopted: true };
    }
    try {
      const res = S().openOutage.run(device.id, startTs, null, null, cause, '', device.latitude, device.longitude);
      return { id: Number(res.lastInsertRowid), startedAt: startTs, adopted: false };
    } catch (e) {
      // رقابت با نمونهٔ دیگر روی همان تجهیز: قید یکتا فعال شده؛ ردیف موجود را برمی‌داریم.
      const row = S().openOutageFor.get(device.id);
      if (row) return { id: Number(row.id), startedAt: Number(row.started_at), adopted: true };
      throw e;
    }
  }

  async probe(device, { timeoutMs, count, retries, mode, port, signal = null }) {
    const attempts = Math.max(1, (retries || 0) + 1);
    const tcpPort = Number(port) || 80; // پورت از تنظیمات می‌آید (پیش‌تر همیشه ۸۰ بود)
    let last = null;
    for (let i = 0; i < attempts; i++) {
      if (signal?.aborted) return { ok: false, reachable: false, rtt: null, packetsSent: 0, packetsRecv: 0, lossPct: 100, mode: 'cancelled', error: 'CANCELLED', service: 'unknown', servicePort: null };
      const effective = mode === 'auto' ? (icmpStatus() === false ? 'tcp' : 'icmp') : mode;
      last =
        effective === 'simulate'
          ? simulateCheck(device, count)
          : effective === 'tcp'
            ? await tcpPing(device.ip, { timeoutMs, count: Math.min(count, 3), port: tcpPort, signal })
            : await icmpPing(device.ip, { timeoutMs, count, signal });
      if (last.ok) return last;
      // اگر ICMP به دلیل مجوزها مسدود است، به TCP سقوط کن
      if (last.error === 'ICMP_BLOCKED') {
        last = await tcpPing(device.ip, { timeoutMs, count: Math.min(count, 3), port: tcpPort, signal });
        if (last.ok) return last;
      }
      if (signal?.aborted) break;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 200));
    }
    return last;
  }

  guessCause(result, failures) {
    if (result.error === 'TIMEOUT' || result.error === 'HARD_TIMEOUT') return 'Ping Timeout';
    if (result.error === 'SERVICE_UNAVAILABLE') return 'سرویس روی پورت مورد پایش پاسخ نمی‌دهد';
    if (result.error === 'ECONNREFUSED') return 'مشکل شبکه';
    if (result.error === 'EHOSTUNREACH' || result.error === 'ENETUNREACH') return 'اختلال در زیرساخت فیبر نوری';
    if (failures >= 10) return 'هنگ کردن سوئیچ';
    return 'مشکل شبکه';
  }

  /* ---------------- هشدارها ---------------- */

  /**
   * ایجاد هشدار با احترام به «مدت پایداری شرط» (`rule.duration_sec`) و «تأخیر
   * عمومی» (`settings.alert_delay`). طرح ساده و قابل‌پیش‌بینی است: هر دو یک
   * معنای واحد دارند («چند ثانیه صبر کن تا وضعیت پایدار بماند»)؛ اگر هر دو
   * تنظیم شده باشند، بزرگ‌ترشان اعمال می‌شود تا تأخیر دوباره‌شماری نشود.
   * در این فاصله اگر تجهیز به وضعیت عادی برگردد، هشدار لغو می‌شود
   * (resolveDeviceAlerts → cancelPending) و اعلان اشتباه ساخته نمی‌شود.
   */
  raiseAlert(kind, device, { severity, title, message, value, ts }) {
    const s = this.settings();
    const key = `${kind}:${device.id}`;
    if (!s.alerting_enabled) {
      this.cancelPending(key);
      return null;
    }
    const rules = this.rules();
    const mapped = { offline: 'offline', latency: 'latency', loss: 'loss', recovery: 'recovery' }[kind];
    const rule =
      rules.find((r) => r.metric === mapped && (!r.scope_group_id || r.scope_group_id === device.group_id)) ||
      rules.find((r) => r.metric === mapped) ||
      null;
    const cooldown = (rule?.cooldown_sec ?? s.alert_cooldown) * 1000;
    // ضد‌تکرار پیش از هر درج (حتی سرکوب‌شده) اعمال می‌شود؛ در غیر این صورت در
    // ساعات سکوت، هر بررسی یک ردیف هشدار سرکوب‌شده می‌ساخت و جدول alerts بدون
    // سقف رشد می‌کرد (۱۰۰۰ تجهیز ← صدها هزار ردیف در ساعت).
    if (cooldown > 0) {
      const prev = S().recentAlert.get(key);
      if (prev && ts - prev.created_at < cooldown) {
        this.cancelPending(key);
        return null;
      }
    }
    const alert = { kind, deviceId: device.id, deviceName: device.name, ruleId: rule ? rule.id : null, silent: Boolean(rule && rule.silent), severity, title, message, value, ts };
    const delaySec = Math.max(0, Number(rule?.duration_sec) || 0, Number(s.alert_delay) || 0);
    if (delaySec > 0) {
      const existing = this.pending.get(key);
      if (existing) return { pending: true, dueAt: existing.dueAt };
      const dueAt = ts + delaySec * 1000;
      const timer = setTimeout(() => {
        this.pending.delete(key);
        try {
          this.deliverPending(alert);
        } catch (e) {
          this.stats.errors++;
          log('error', `ثبت هشدار معوق ناموفق بود: ${e.message}`);
        }
      }, delaySec * 1000);
      if (timer.unref) timer.unref();
      this.pending.set(key, { dueAt, timer, alert });
      log('engine', `هشدار «${kind}» برای تجهیز #${device.id} تا ${delaySec} ثانیه معوق شد.`);
      return { pending: true, dueAt };
    }
    return this.commitAlert(alert);
  }

  /** ثبت نهایی هشدار (پس از پایان تأخیر) با بررسی دوبارهٔ وضعیت و شرط‌ها */
  deliverPending(alert) {
    const s = this.settings();
    if (!s.alerting_enabled) return null;
    const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(alert.deviceId);
    if (!row) return null;
    if (!this.pendingStillValid(alert.kind, row)) {
      log('engine', `هشدار معوق «${alert.kind}» برای تجهیز #${row.id} لغو شد؛ وضعیت دیگر برقرار نیست.`);
      return null;
    }
    return this.commitAlert({ ...alert, deviceName: row.name, ts: Date.now() });
  }

  /** آیا وضعیت فعلی تجهیز هنوز همان شرطی است که هشدار برایش ساخته شده بود؟ */
  pendingStillValid(kind, row) {
    if (!row) return false;
    if (kind === 'offline') return row.status === STATUS.OFFLINE;
    if (kind === 'latency' || kind === 'loss') return row.status === STATUS.WARNING;
    if (kind === 'recovery') return row.status !== STATUS.OFFLINE;
    return true;
  }

  /** درج هشدار با رعایت cooldown و ساعات سکوت، سپس اعلان به UI */
  commitAlert(alert) {
    const s = this.settings();
    const key = `${alert.kind}:${alert.deviceId}`;
    const rule = alert.ruleId ? db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(alert.ruleId) : null;
    const cooldown = (rule?.cooldown_sec ?? s.alert_cooldown) * 1000;
    if (cooldown > 0) {
      const prev = S().recentAlert.get(key);
      if (prev && alert.ts - prev.created_at < cooldown) return null;
    }
    if (alert.silent && this.inQuietHours(s)) {
      db.prepare(
        'INSERT INTO alerts(device_id, rule_id, severity, kind, title, message, value, created_at, status, notified, duplicate_key) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      ).run(alert.deviceId, alert.ruleId, alert.severity, alert.kind, alert.title, alert.message, alert.value ?? null, alert.ts, 'suppressed', 1, key);
      return null;
    }
    const res = S().insertAlert.run(
      alert.deviceId,
      alert.ruleId,
      alert.severity,
      alert.kind,
      alert.title,
      alert.message,
      alert.value ?? null,
      alert.ts,
      'active',
      1,
      key
    );
    const saved = {
      id: Number(res.lastInsertRowid),
      deviceId: alert.deviceId,
      deviceName: alert.deviceName,
      severity: alert.severity,
      kind: alert.kind,
      title: alert.title,
      message: alert.message,
      created_at: alert.ts,
      status: 'active',
    };
    this.emit('alert', saved);
    if (this.emitToBus) bus.emit('alert', saved);
    return saved;
  }

  cancelPending(key) {
    const entry = this.pending.get(key);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(key);
    return true;
  }

  /** لغو همهٔ هشدارهای معوق یک تجهیز (پس از بازگشت به وضعیت عادی) */
  cancelDevicePending(deviceId) {
    for (const key of [...this.pending.keys()]) {
      if (key.endsWith(`:${deviceId}`)) this.cancelPending(key);
    }
  }

  clearPending() {
    for (const key of [...this.pending.keys()]) this.cancelPending(key);
  }

  resolveDeviceAlerts(deviceId, ts) {
    // تجهیزی که وضعیتش عادی شده، نباید بعداً هشدار معوق بفرستد
    this.cancelDevicePending(deviceId);
    const r = S().resolveAlerts.run(ts, deviceId);
    if (r.changes > 0) {
      this.emit('alert-resolved', { deviceId, ts });
      if (this.emitToBus) bus.emit('alert-resolved', { deviceId, ts });
    }
  }

  /* ---------------- پنجره تعمیرات و سکوت ---------------- */
  inMaintenanceWindow(deviceId) {
    const rows = this.windows();
    if (!rows.length) return false;
    const now = new Date();
    const day = now.getDay();
    const minutes = now.getHours() * 60 + now.getMinutes();
    for (const w of rows) {
      if (w.device_id && w.device_id !== deviceId) continue;
      const days = String(w.days || '').split(',').map((x) => Number(x.trim()));
      if (!days.includes(day)) continue;
      const [sh, sm] = String(w.start_time || '00:00').split(':').map(Number);
      const [eh, em] = String(w.end_time || '00:00').split(':').map(Number);
      const start = sh * 60 + (sm || 0);
      const end = eh * 60 + (em || 0);
      if (start <= end ? minutes >= start && minutes <= end : minutes >= start || minutes <= end) return true;
    }
    return false;
  }

  inQuietHours(s) {
    if (!s.suppression_enabled) return false;
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = String(s.suppression_start).split(':').map(Number);
    const [eh, em] = String(s.suppression_end).split(':').map(Number);
    const start = sh * 60 + (sm || 0);
    const end = eh * 60 + (em || 0);
    return start <= end ? minutes >= start && minutes <= end : minutes >= start || minutes <= end;
  }

  /* ---------------- نگهداری دوره‌ای ---------------- */
  rollup() {
    // روز جاری و روز قبل تجمیع می‌شوند؛ تجمیع روز قبل، وقفه‌های گذر از نیمه‌شب و دوره‌هایی
    // که موتور مستقل (engine-cli) به‌جای سرور اجرا می‌شده را جبران می‌کند.
    const offset = Number(this.settings().timezone_offset_minutes) || 0;
    const dayStart = localDayStart(Date.now(), offset);
    for (const start of [dayStart - DAY_MS, dayStart]) {
      try {
        this.rollupDay(start, offset);
      } catch (e) {
        this.noteInternalError(e, { phase: 'rollup' });
      }
    }
    try {
      const since = Date.now() - 24 * 3600 * 1000;
      const rows = S().recompute.all(since);
      for (const r of rows) {
        const uptime = r.checks ? ((r.ok_count || 0) / r.checks) * 100 : 100;
        db.prepare('UPDATE devices SET uptime_pct=?, min_rtt_ms=?, max_rtt_ms=?, avg_rtt_ms=? WHERE id=?').run(
          Number(uptime.toFixed(2)),
          r.min_rtt == null ? null : Number(r.min_rtt),
          r.max_rtt == null ? null : Number(r.max_rtt),
          r.avg_rtt == null ? null : Number(Number(r.avg_rtt).toFixed(2)),
          r.device_id
        );
      }
    } catch (e) {
      this.noteInternalError(e, { phase: 'rollup-metrics' });
    }
  }

  /** تجمیع آمار یک روز تقویمی محلی (پیاده‌سازی مشترک با Retention) */
  rollupDay(dayStart, offsetMin = 0) {
    return sharedRollupDay(dayStart, offsetMin);
  }

  /**
   * تجمیع روزهای گذشته‌ای که در daily_stats رکورد ندارند (حداکثر `limit` روز در هر شروع).
   * بدون این کار، بازه‌هایی که موتور خاموش بوده در جدول تجمیعی سوراخ می‌مانند و
   * گزارش‌های بلندمدت (که پس از حذف نمونه‌های خام به همین جدول تکیه دارند) بی‌داده می‌شوند.
   */
  backfillDays(limit = 7) {
    const offset = Number(this.settings().timezone_offset_minutes) || 0;
    const today = localDayStart(Date.now(), offset);
    let done = 0;
    // سه روز گذشته دوباره تجمیع می‌شوند: علاوه بر جاماندن در زمان خاموشی،
    // نسخه‌های قبلی آمار روزانه را با مرز نیمه‌شب UTC می‌ساختند.
    for (const t of [today - 3 * DAY_MS, today - 2 * DAY_MS, today - DAY_MS]) {
      this.rollupDay(t, offset);
      done++;
    }
    const oldest = db.prepare('SELECT MIN(ts) AS ts FROM samples').get()?.ts;
    if (!oldest) return done;
    const have = new Set(db.prepare('SELECT DISTINCT day FROM daily_stats').all().map((r) => r.day));
    let filled = 0;
    for (let t = localDayStart(oldest, offset); t < today - 3 * DAY_MS && filled < limit; t += DAY_MS) {
      if (have.has(localDayLabel(t, offset))) continue;
      this.rollupDay(t, offset);
      filled++;
    }
    if (filled) log('engine', `تجمیع روزهای جامانده انجام شد (${filled} روز).`);
    return done + filled;
  }

  /**
   * سازگاری با نسخه‌های قبلی/آزمون‌ها: هرس اکنون از مسیر Retention Engine
   * انجام می‌شود. سیاست صریح ورودی (s) برای آزمون‌های قدیمی به سیاست موقت
   * تبدیل می‌شود؛ هیچ مسیر دومی برای حذف وجود ندارد.
   */
  cleanup(s = {}) {
    try {
      const days = Number(s.retention_days);
      const override = Number.isFinite(days) && days > 0
        ? {
            samplesDays: days,
            outagesDays: days,
            alertsDays: days,
            dailyStatsDays: Math.max(365, days),
            auditDays: 365,
            engineLogDays: 14,
          }
        : {};
      return runRetention({ trigger: 'engine', actor: 'engine', policyOverride: override });
    } catch (e) {
      this.noteInternalError(e, { phase: 'cleanup' });
      return null;
    }
  }

  /** حذف تکه‌تکه (پیش‌فرض ۵٬۰۰۰ رکورد در هر گام) تا یک حذف بزرگ، قفل نوشتن پایگاه‌داده را طولانی نکند */
  pruneBatch(statement, cutoff, limit = PRUNE_MAX_PER_RUN) {
    let total = 0;
    while (total < limit) {
      const n = Number(statement.run(cutoff, PRUNE_CHUNK).changes || 0);
      total += n;
      if (n < PRUNE_CHUNK) break;
    }
    return total;
  }
}

export const engine = new MonitoringEngine();
export default engine;
