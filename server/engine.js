/**
 * NetWatch — موتور مانیتورینگ
 * ----------------------------------------------------------------
 * موتور به‌صورت کامل مستقل از رابط کاربری کار می‌کند. می‌تواند داخل
 * همان فرآیند سرور اجرا شود یا به شکل یک سرویس جداگانه:
 *      node server/engine-cli.js
 */
import { EventEmitter } from 'node:events';
import { db, getSettings, log, STATUS } from './db.js';
import { probeIcmp, icmpStatus, icmpPing, tcpPing } from './ping.js';
import { LeaderLock } from './leader.js';
import { logEvent } from './logger.mjs';

export const bus = new EventEmitter();
bus.setMaxListeners(200);

// فاصله تجمیع آمار (daily_stats + بازمحاسبه ۲۴ ساعته) — قبلاً هر دقیقه اجرا می‌شد
const ROLLUP_EVERY_MS = 5 * 60 * 1000;
const PRUNE_CHUNK = 5000;
const PRUNE_MAX_PER_RUN = 200000;
const DAY_MS = 86400000;

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
      'INSERT INTO samples(device_id, ts, rtt_ms, packets_sent, packets_recv, loss_pct, status, ok, mode) VALUES (?,?,?,?,?,?,?,?,?)'
    ),
    openOutage: db.prepare(
      'INSERT INTO outages(device_id, started_at, ended_at, duration_sec, cause, detail, lat, lng, open) VALUES (?,?,?,?,?,?,?,?,1)'
    ),
    closeOutage: db.prepare('UPDATE outages SET ended_at=?, duration_sec=?, open=0 WHERE id=?'),
    updateDevice: db.prepare(`UPDATE devices SET
        status=?, status_reason=?, last_check_at=?, last_status_change_at=?, last_rtt_ms=?, loss_pct=?,
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
    // هرس تکه‌تکه: حذف یک‌بارهٔ صدها هزار رکورد، پایگاه‌داده را ثانیه‌ها قفل می‌کند
    pruneSamples: db.prepare('DELETE FROM samples WHERE rowid IN (SELECT rowid FROM samples WHERE ts < ? LIMIT ?)'),
    pruneOutages: db.prepare('DELETE FROM outages WHERE rowid IN (SELECT rowid FROM outages WHERE open = 0 AND started_at < ? LIMIT ?)'),
    pruneAlertsRow: db.prepare("DELETE FROM alerts WHERE rowid IN (SELECT rowid FROM alerts WHERE created_at < ? AND status IN ('resolved','suppressed') LIMIT ?)"),
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
    this.lastBacklogCheck = 0;
    this.lastBacklogWarn = 0;
    this.stats = { cycles: 0, checksRun: 0, lastRunAt: null, startedAt: null, errors: 0, skipped: 0, backlog: 0 };
    this.rulesCache = { at: 0, rows: [] };
    this.windowsCache = { at: 0, rows: [] };
    // قفل رهبری: فقط یک نمونه (سرور یا engine-cli) مجاز است بررسی کند.
    this.lock = options.lock || new LeaderLock();
    this.leader = false;
    this.lockRetryMs = Math.max(100, Number(options.lockRetryMs ?? process.env.NETWATCH_LOCK_RETRY_MS ?? 2000));
    this.lastLockAttempt = 0;
    this.lastRenew = 0;
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
    this.settingsCache = { at: 0, value: getSettings() };
    this.rulesCache = { at: 0, rows: [] };
    this.windowsCache = { at: 0, rows: [] };
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

  async start() {
    if (this.running) return this.getStatus();
    this.running = true;
    this.stats.startedAt = Date.now();
    this.leader = this.lock.tryAcquire();
    this.lastLockAttempt = Date.now();
    if (this.leader) this.lastRenew = Date.now();
    else {
      // نمونهٔ دیگری (مثلاً سرور، وقتی engine-cli جداگانه هم اجرا شده) رهبر است.
      // این نمونه بدون Ping در حالت آماده‌به‌کار می‌ماند و بعداً قفل را می‌گیرد.
      log('warn', 'یک موتور دیگر فعال است؛ این نمونه در حالت آماده‌به‌کار (standby) می‌ماند و Ping نمی‌زند.');
      logEvent('warn', 'engine_standby', { owner: this.lock.status().owner });
    }
    probeIcmp().then((ok) => {
      log('engine', ok ? 'ICMP در دسترس است؛ حالت واقعی آماده به کار است.' : 'ICMP در دسترس نیست؛ درخواست‌ها روی TCP انجام می‌شود.');
    });
    // روزهایی که موتور در آن‌ها خاموش بوده (یا تنها engine-cli اجرا شده) در
    // daily_stats رکورد ندارند؛ یک‌بار در شروع، روزهای جامانده تجمیع می‌شوند.
    if (this.leader) {
      try {
        this.backfillDays();
      } catch (e) {
        log('error', `تجمیع روزهای جامانده ناموفق بود: ${e.message}`);
      }
    }
    this.timer = setInterval(() => {
      this.tick().catch((e) => {
        this.stats.errors++;
        log('error', `خطای چرخه موتور: ${e.message}`);
      });
    }, this.interval);
    if (this.timer.unref) this.timer.unref();
    log('info', 'موتور مانیتورینگ راه‌اندازی شد.');
    if (this.emitToBus) bus.emit('engine', this.getStatus());
    return this.getStatus();
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // قفل فوراً آزاد می‌شود تا نمونهٔ بعدی (یا engine-cli) بدون انتظار TTL شروع کند
    try {
      this.lock.release();
    } catch {}
    this.leader = false;
    log('info', 'موتور مانیتورینگ متوقف شد.');
    if (this.emitToBus) bus.emit('engine', this.getStatus());
    return this.getStatus();
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

  getStatus() {
    const s = this.settings();
    return {
      running: this.running,
      mode: s.engine_mode,
      icmpAvailable: icmpStatus(),
      interval: s.ping_interval,
      maxWorkers: s.max_workers,
      inflight: this.inflight.size,
      leader: this.leader,
      lock: this.lock.status(),
      ...this.stats,
    };
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
        return true;
      }
      this.leader = false;
      this.lastLockAttempt = now;
      log('error', 'قفل رهبری موتور از دست رفت؛ این نمونه بررسی‌ها را متوقف کرد.');
      logEvent('warn', 'engine_leader_lost', { owner: this.lock.status().owner });
      if (this.emitToBus) bus.emit('engine', this.getStatus());
      return false;
    }
    if (now - this.lastLockAttempt < this.lockRetryMs) return false;
    this.lastLockAttempt = now;
    if (this.lock.tryAcquire(now)) {
      this.leader = true;
      this.lastRenew = now;
      log('info', 'قفل رهبری موتور گرفته شد؛ بررسی‌ها از این نمونه ادامه می‌یابد.');
      logEvent('info', 'engine_leader_acquired', { owner: this.lock.owner });
      if (this.emitToBus) bus.emit('engine', this.getStatus());
      return true;
    }
    return false;
  }

  /* ---------------- چرخه اصلی ---------------- */
  async tick() {
    if (!this.running) return;
    // بدون قفل رهبر (یا با قفل ازدست‌رفته) هیچ بررسی‌ای انجام نمی‌شود.
    if (!this.ensureLeader()) return;
    const s = this.settings();
    this.stats.cycles++;
    this.stats.lastRunAt = Date.now();

    if (Date.now() - this.lastCleanup > 10 * 60 * 1000) {
      this.lastCleanup = Date.now();
      this.cleanup(s);
    }
    if (Date.now() - this.lastRollup > ROLLUP_EVERY_MS) {
      this.lastRollup = Date.now();
      this.rollup();
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
    if (!capacity) return;
    // فقط تجهیزاتی که سررسیدشان رسیده شروع می‌شوند و هرگز بیش از ظرفیت موتور.
    const ready = S().due.all(now, Math.min(capacity * 2, 500)).filter((d) => !this.inflight.has(d.id));
    await Promise.all(ready.slice(0, capacity).map((d) => this.checkDevice(d).catch(() => {})));
  }

  /** بررسی یک تجهیز و ثبت کامل نتیجه */
  async checkDevice(device, options = {}) {
    // اگر همین تجهیز در حال بررسی است، همان نتیجه به فراخوانی دوم برگردانده می‌شود
    // (پیش‌تر null برمی‌گشت و درخواست دستی «Ping» بی‌پاسخ می‌ماند)
    const running = this.inflight.get(device.id);
    if (running) return running;
    const task = this.runCheck(device, options);
    this.inflight.set(device.id, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(device.id);
    }
  }

  async runCheck(device, { manual = false, source = 'engine' } = {}) {
    const s = this.settings();
    // مقادیر تجهیز ممکن است از نسخه‌های قدیمی/ورود داده خراب مانده باشند؛
    // همان مرزهای تنظیمات عمومی اینجا هم اعمال می‌شوند تا موتور در هیچ حالتی
    // بی‌وقفه Ping نکند یا فرمان ping را ساعت‌ها زنده نگه ندارد.
    const interval = bounded(device.ping_interval ?? s.ping_interval, 5, 86400, 30) * 1000;
    // زمان بررسی بعدی همین حالا رزرو می‌شود تا این تجهیز در چرخه‌های بعدی دوباره کاندید
    // نشود. مبنای محاسبه، سررسید قبلی است (نه لحظهٔ اجرا) تا بازهٔ واقعی بررسی‌ها دقیقاً
    // همان بازهٔ تنظیم‌شده بماند و با هر چرخه کمی کوتاه‌تر نشود.
    const dueBase = Math.max(Number(device.next_check_at) || 0, Date.now());
    S().scheduleNext.run(dueBase + interval, device.id);
    const inWindow = this.inMaintenanceWindow(device.id);
    if (inWindow && !manual) {
      this.stats.skipped++;
      const ts = Date.now();
      // در پنجرهٔ تعمیرات بررسی‌ای انجام نمی‌شود، پس قطعی باز و هشدارهای فعال
      // باید همان‌جا بسته/حل شوند؛ وگرنه مدت قطعی در زمان تعمیرات رشد می‌کند و
      // پس از پایان پنجره (اگر تجهیز هنوز قطع باشد) دومین قطعی باز ساخته می‌شود.
      S().closeStaleOpen.run(ts, ts, device.id);
      this.resolveDeviceAlerts(device.id, ts);
      S().markMaintenance.run(STATUS.MAINTENANCE, 'در پنجره تعمیرات — بررسی موقتاً متوقف است', device.id, STATUS.MAINTENANCE);
      return null;
    }

    const timeoutMs = bounded(device.timeout_ms ?? s.timeout_ms, 100, 30000, 1200);
    const count = Math.round(bounded(device.packet_count ?? s.packet_count, 1, 10, 3));
    const retries = Math.round(bounded(device.retries ?? s.retries, 0, 5, 1));
    const latencyThreshold = bounded(device.latency_threshold ?? s.latency_threshold, 0, 60000, 150);
    const lossThreshold = bounded(device.loss_threshold ?? s.loss_threshold, 0, 100, 10);

    const result = await this.probe(device, { timeoutMs, count, retries, mode: s.engine_mode, port: s.tcp_port });
    const ts = Date.now();

    // تجهیز ممکن است در فاصلهٔ اجرای پروب (که چند ثانیه طول می‌کشد) حذف شده باشد؛
    // در آن صورت هر نوشتن روی samples/alerts/outages خطای کلید خارجی می‌دهد و
    // نتیجه هم بی‌معناست. پس بدون ثبت چیزی از بررسی عبور می‌کنیم.
    if (!S().exists.get(device.id)) {
      this.stats.skipped++;
      return null;
    }

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

    const isUnreachable = !result.ok;
    let isDegraded = false;
    if (result.ok) {
      const effRtt = result.rtt ?? 0;
      if (effRtt > latencyThreshold) isDegraded = true;
      if (result.lossPct > lossThreshold) isDegraded = true;
    }

    // ---- گذارها ----
    if (isUnreachable && device.status !== STATUS.OFFLINE && failures >= s.failures_for_offline) {
      status = STATUS.OFFLINE;
      reason = result.error === 'TIMEOUT' || result.error === 'HARD_TIMEOUT' ? 'Ping Timeout' : `عدم پاسخ (${result.error || 'خطای شبکه'})`;
      const cause = this.guessCause(result, failures);
      const res = S().openOutage.run(device.id, ts, null, null, cause, '', device.latitude, device.longitude);
      outageId = Number(res.lastInsertRowid);
      outageStart = ts;
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
      // تجهیز قطع است اما رکورد قطعی بازی ندارد (مثلاً پس از بازنشانی داده‌ها)
      const started = device.current_outage_started_at || device.last_outage_at || ts;
      const res = S().openOutage.run(device.id, started, null, null, device.status_reason || 'Ping Timeout', '', device.latitude, device.longitude);
      outageId = Number(res.lastInsertRowid);
      outageStart = started;
    }

    const okInt = result.ok ? 1 : 0;
    S().insertSample.run(
      device.id,
      ts,
      result.rtt ?? null,
      result.packetsSent ?? count,
      result.packetsRecv ?? 0,
      result.lossPct ?? (okInt ? 0 : 100),
      status,
      okInt,
      result.mode
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
    const payload = {
      deviceId: device.id,
      ts,
      status,
      rtt: result.rtt,
      lossPct: result.lossPct,
      ok: result.ok,
      mode: result.mode,
      source,
      manual,
      interval,
    };
    this.stats.checksRun++;
    this.emit('sample', payload);
    if (this.emitToBus) bus.emit('sample', payload);
    if (statusChanged) {
      this.emit('status', payload);
      if (this.emitToBus) bus.emit('status', payload);
    }
    return payload;
  }

  async probe(device, { timeoutMs, count, retries, mode, port }) {
    const attempts = Math.max(1, (retries || 0) + 1);
    const tcpPort = Number(port) || 80; // پورت از تنظیمات می‌آید (پیش‌تر همیشه ۸۰ بود)
    let last = null;
    for (let i = 0; i < attempts; i++) {
      const effective = mode === 'auto' ? (icmpStatus() === false ? 'tcp' : 'icmp') : mode;
      last =
        effective === 'simulate'
          ? simulateCheck(device, count)
          : effective === 'tcp'
            ? await tcpPing(device.ip, { timeoutMs, count: Math.min(count, 3), port: tcpPort })
            : await icmpPing(device.ip, { timeoutMs, count });
      if (last.ok) return last;
      // اگر ICMP به دلیل مجوزها مسدود است، به TCP سقوط کن
      if (last.error === 'ICMP_BLOCKED') {
        last = await tcpPing(device.ip, { timeoutMs, count: Math.min(count, 3), port: tcpPort });
        if (last.ok) return last;
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 200));
    }
    return last;
  }

  guessCause(result, failures) {
    if (result.error === 'TIMEOUT' || result.error === 'HARD_TIMEOUT') return 'Ping Timeout';
    if (result.error === 'ECONNREFUSED') return 'مشکل شبکه';
    if (result.error === 'EHOSTUNREACH' || result.error === 'ENETUNREACH') return 'اختلال در زیرساخت فیبر نوری';
    if (failures >= 10) return 'هنگ کردن سوئیچ';
    return 'مشکل شبکه';
  }

  /* ---------------- هشدارها ---------------- */
  raiseAlert(kind, device, { severity, title, message, value, ts }) {
    const s = this.settings();
    if (!s.alerting_enabled) return null;
    const rules = this.rules();
    const mapped = { offline: 'offline', latency: 'latency', loss: 'loss', recovery: 'recovery' }[kind];
    const rule =
      rules.find((r) => r.metric === mapped && (!r.scope_group_id || r.scope_group_id === device.group_id)) ||
      rules.find((r) => r.metric === mapped) ||
      null;
    const key = `${kind}:${device.id}`;
    const cooldown = (rule?.cooldown_sec ?? s.alert_cooldown) * 1000;
    // ضد‌تکرار پیش از هر درج (حتی سرکوب‌شده) اعمال می‌شود؛ در غیر این صورت در
    // ساعات سکوت، هر بررسی یک ردیف هشدار سرکوب‌شده می‌ساخت و جدول alerts بدون
    // سقف رشد می‌کرد (۱۰۰۰ تجهیز ← صدها هزار ردیف در ساعت).
    if (cooldown > 0) {
      const prev = S().recentAlert.get(key);
      if (prev && ts - prev.created_at < cooldown) return null;
    }
    if (rule && rule.silent && this.inQuietHours(s)) {
      db.prepare(
        'INSERT INTO alerts(device_id, rule_id, severity, kind, title, message, value, created_at, status, notified, duplicate_key) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      ).run(device.id, rule.id, severity, kind, title, message, value ?? null, ts, 'suppressed', 1, key);
      return null;
    }
    const res = S().insertAlert.run(
      device.id,
      rule ? rule.id : null,
      severity,
      kind,
      title,
      message,
      value ?? null,
      ts,
      'active',
      1,
      key
    );
    const alert = { id: Number(res.lastInsertRowid), deviceId: device.id, deviceName: device.name, severity, kind, title, message, created_at: ts, status: 'active' };
    this.emit('alert', alert);
    if (this.emitToBus) bus.emit('alert', alert);
    return alert;
  }

  resolveDeviceAlerts(deviceId, ts) {
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
        this.stats.errors++;
        log('error', `خطا در تجمیع روزانه: ${e.message}`);
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
      this.stats.errors++;
      log('error', `خطا در بازمحاسبه شاخص‌ها: ${e.message}`);
    }
  }

  /** تجمیع آمار یک روز تقویمی محلی با چند پرس‌وجوی گروهی، در یک تراکنش قابل‌تودرتو */
  rollupDay(dayStart, offsetMin = 0) {
    const day = localDayLabel(dayStart, offsetMin);
    const agg = S().daySamples.all(dayStart, dayStart + DAY_MS);
    if (!agg.length) return;
    const outages = new Map(S().dayOutages.all(dayStart, dayStart + DAY_MS).map((o) => [o.device_id, o]));
    db.exec('SAVEPOINT rollup_day');
    try {
      for (const a of agg) {
        const o = outages.get(a.device_id);
        const uptime = a.checks ? Number((((a.checks - a.failed) / a.checks) * 100).toFixed(2)) : null;
        S().upsertDay.run(
          a.device_id,
          day,
          a.checks,
          a.failed,
          a.avg_rtt == null ? null : Number(a.avg_rtt),
          a.min_rtt == null ? null : Number(a.min_rtt),
          a.max_rtt == null ? null : Number(a.max_rtt),
          a.loss_pct == null ? null : Number(Number(a.loss_pct).toFixed(2)),
          o ? o.outages : 0,
          o ? o.downtime_sec : 0,
          uptime
        );
      }
      db.exec('RELEASE rollup_day');
    } catch (e) {
      db.exec('ROLLBACK TO rollup_day');
      db.exec('RELEASE rollup_day');
      throw e;
    }
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

  cleanup(s) {
    try {
      const cutoff = Date.now() - Math.max(1, s.retention_days) * 86400000;
      const removed =
        this.pruneBatch(S().pruneSamples, cutoff) +
        this.pruneBatch(S().pruneOutages, cutoff) +
        this.pruneBatch(S().pruneAlertsRow, cutoff) +
        this.pruneBatch(S().pruneLog, Date.now() - 14 * 86400000);
      log('engine', `پاک‌سازی رکوردهای قدیمی انجام شد${removed ? ` (${removed.toLocaleString('fa-IR')} رکورد)` : ''}.`);
    } catch (e) {
      log('error', `خطا در پاک‌سازی: ${e.message}`);
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
