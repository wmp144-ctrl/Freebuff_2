/**
 * NetWatch — لایه پایگاه‌داده
 * ----------------------------------------------------------------
 * کاملاً آفلاین و بدون وابستگی بومی؛ از ماژول داخلی «node:sqlite» استفاده می‌کند.
 * همه زمان‌ها به‌صورت epoch milliseconds (INTEGER) ذخیره می‌شوند.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { logEvent, sanitizeLogText } from './logger.mjs';
import { normalizeCidrList } from './net-policy.js';
import { config } from './config.js';
import { DbError, DB_ERROR_CODES, logDbError } from './db-errors.js';
import { normalizeBindParams, assertSqlIdentifier, assertDiskSpace, freeDiskBytes } from './db-safety.js';
import { performance } from 'node:perf_hooks';
import { recordQuery } from './metrics.js';

// مسیرها یک‌جا در config.js اعتبارسنجی و resolve می‌شوند؛ این‌جا فقط بازصادر
// می‌شوند تا مصرف‌کنندگان قبلی (اسکریپت‌ها/آزمون‌ها) بدون تغییر کار کنند.
export const DATA_DIR = config.dataDir;
export const MBTILES_DIR = config.mbtilesDir;
// دادهٔ عملیاتی (پایگاه‌داده، پشتیبان، نقشه) فقط برای مالک سرویس قابل دسترس
// باشد؛ پوشهٔ داده ۰۷۰۰ و فایل‌های حساس ۰۶۰۰.
for (const dir of [DATA_DIR, MBTILES_DIR]) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  } catch {
    /* سیستم فایل/پلتفرم ممکن است chmod را پشتیبانی نکند */
  }
}
export const DB_PATH = config.dbPath;

// آیا فایل پایگاه‌داده از قبل وجود داشته است؟ برای تصمیم «پشتیبان پیش از
// Migration» لازم است؛ نصب تازه نباید فایل پشتیبان خالی بسازد.
const DB_EXISTED = (() => {
  try {
    return !String(DB_PATH).startsWith(':') && fs.existsSync(DB_PATH) && fs.statSync(DB_PATH).size > 0;
  } catch {
    return false;
  }
})();

/** نسخهٔ ساختار داده؛ با هر Migration افزایش می‌یابد (PRAGMA user_version) */
export const SCHEMA_VERSION = 9;

/* ------------------------------------------------------------------ */
/* سیاست دوام و WAL                                                  */
/* ------------------------------------------------------------------ */

const VALID_SYNC = new Set(['OFF', 'NORMAL', 'FULL', 'EXTRA']);
/**
 * synchronous=FULL در حالت WAL یعنی هر COMMIT پیش از پاسخ، به دیسک می‌رود؛
 * با NORMAL آخرین تراکنش‌ها در قطع برق/کرنل‌پنیک از دست می‌روند. برای سامانه‌ای
 * که سابقهٔ قطعی و تعمیراتش سند عملیاتی است، دوام تأییدشده اولویت دارد.
 * با NETWATCH_SQLITE_SYNC=NORMAL می‌توان برای نصب‌های پرنوشت به حالت سریع‌تر
 * برگشت (به‌صورت آگاهانه).
 */
export const SYNC_MODE = (() => {
  const raw = String(process.env.NETWATCH_SQLITE_SYNC || 'FULL').toUpperCase();
  return VALID_SYNC.has(raw) ? raw : 'FULL';
})();
const BUSY_TIMEOUT_MS = (() => {
  const n = Number(process.env.NETWATCH_BUSY_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 100 && n <= 60000 ? Math.floor(n) : 5000;
})();
// هر ۱۰۰۰ صفحه (≈۴ مگابایت) یک checkpoint خودکار؛ با TRUNCATE دوره‌ای هم فایل
// WAL کوتاه می‌ماند و هم بازگشت پس از قطع ناگهانی سریع است.
const WAL_AUTOCHECKPOINT_PAGES = 1000;
const JOURNAL_SIZE_LIMIT = 64 * 1024 * 1024;

/**
 * اتصال امن به SQLite.
 *
 * چرا یک لایهٔ نازک روی DatabaseSync؟
 *   • همهٔ پارامترها پیش از بایند نرمال می‌شوند (Boolean→0/1، undefined→NULL،
 *     NaN→NULL، Date→ms) تا خطای «Provided value cannot be bound» و رکورد
 *     ناقص رخ ندهد.
 *   • خطاها یک‌جا دسته‌بندی و با SQL ثبت می‌شوند.
 *   • تراکنش/SAVEPOINT تودرتو با Rollback کامل در دسترس است.
 *   • اتصال پس از Restore قابل بازگشایی است؛ Prepared Statementهای ماژول‌های
 *     دیگر با SQL خود کش می‌شوند و پس از بازگشایی دوباره معتبرند.
 */
class DatabaseHandle {
  constructor(file) {
    this.file = file;
    this.raw = null;
    this.txDepth = 0;
    this.statements = new Map();
    this.closed = false;
    this._open();
  }

  _open() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.raw = new DatabaseSync(this.file);
    this.closed = false;
    this.statements.clear();
    this.txDepth = 0;
    this._applyPragmas();
  }

  _applyPragmas() {
    const raw = this.raw;
    const skipped = (name, err) => logEvent('warn', 'db_pragma_failed', { name, message: err?.message });
    try {
      raw.exec('PRAGMA journal_mode = WAL');
    } catch (e) {
      skipped('journal_mode', e);
    }
    try {
      raw.exec(`PRAGMA synchronous = ${SYNC_MODE}`);
    } catch (e) {
      skipped('synchronous', e);
    }
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    raw.exec(`PRAGMA wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
    raw.exec(`PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT}`);
    // شمارنده‌های داخلی SQLite برای افزایش امنیت در برابر حافظهٔ خراب
    try {
      raw.exec('PRAGMA trusted_schema = OFF');
    } catch (e) {
      skipped('trusted_schema', e);
    }
  }

  _assertOpen() {
    if (this.closed || !this.raw) {
      throw new DbError(DB_ERROR_CODES.NOT_OPEN, 'اتصال پایگاه‌داده بسته است.', { status: 503 });
    }
  }

  _statement(sql) {
    this._assertOpen();
    let stmt = this.statements.get(sql);
    if (!stmt) {
      try {
        stmt = this.raw.prepare(sql);
      } catch (e) {
        throw logDbError('db.prepare', e, { sql, force: true });
      }
      // سقف کش: پرس‌وجوهای داینامیک (IN با تعداد متغیر) نباید حافظه را بی‌نهایت رشد دهند
      if (this.statements.size >= 512) this.statements.clear();
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  _run(kind, sql, args) {
    const params = normalizeBindParams(args, sql);
    const isTx = this.txDepth > 0;
    let lastError = null;
    // سنجهٔ تأخیر Query: هزینهٔ performance.now ناچیز است و برای صفحهٔ Application
    // Health و شناسایی Queryهای کند در همین فرآیند لازم است.
    const started = performance.now();
    // داخل تراکنش تلاش دوباره انجام نمی‌شود؛ تراکنش باید یک‌جا Rollback شود.
    for (let attempt = 0; attempt < (isTx ? 1 : 2); attempt++) {
      try {
        const result = this._statement(sql)[kind](...params);
        recordQuery(sql, performance.now() - started);
        return result;
      } catch (e) {
        lastError = e;
        if (isTx || !/busy|locked/i.test(`${e?.message || ''} ${e?.code || ''}`)) break;
        sleepSync(50 * (attempt + 1));
      }
    }
    recordQuery(sql, performance.now() - started, true);
    throw logDbError(`db.${kind}`, lastError, { sql, force: true });
  }

  prepare(sql) {
    const text = String(sql ?? '');
    if (!text.trim()) throw new DbError(DB_ERROR_CODES.BINDING, 'دستور SQL خالی است.', { status: 400 });
    const handle = this;
    return {
      source: text,
      run: (...args) => handle._run('run', text, args),
      get: (...args) => handle._run('get', text, args),
      all: (...args) => handle._run('all', text, args),
      iterate: (...args) => handle._statement(text).iterate(...normalizeBindParams(args, text)),
    };
  }

  exec(sql) {
    this._assertOpen();
    try {
      return this.raw.exec(String(sql ?? ''));
    } catch (e) {
      throw logDbError('db.exec', e, { sql, force: true });
    }
  }

  /**
   * اجرای یک عملیات منطقی چندمرحله‌ای به‌صورت اتمیک.
   * فراخوانی تودرتو با SAVEPOINT پشتیبانی می‌شود؛ خطا در هر مرحله کل عملیات
   * (یا فقط بلوک داخلی) را به حالت قبل برمی‌گرداند.
   *
   * @template T
   * @param {() => T} fn عملیات همگام؛ Promise مجاز نیست (قفل نوشتن باز می‌ماند)
   * @param {{immediate?: boolean, label?: string}} [options]
   * @returns {T}
   */
  transaction(fn, { immediate = true, label = 'tx' } = {}) {
    this._assertOpen();
    if (typeof fn !== 'function') throw new TypeError('transaction(fn) نیازمند تابع است.');
    const outer = this.txDepth === 0;
    const savepoint = `nw_sp_${++txSeq}`;
    this.raw.exec(outer ? (immediate ? 'BEGIN IMMEDIATE' : 'BEGIN') : `SAVEPOINT ${savepoint}`);
    this.txDepth++;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        throw new DbError(DB_ERROR_CODES.BINDING, 'تراکنش باید همگام باشد؛ تابع async داده نشود.', { status: 500 });
      }
      this.txDepth--;
      this.raw.exec(outer ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      this.txDepth = Math.max(0, this.txDepth - 1);
      try {
        if (outer) this.raw.exec('ROLLBACK');
        else {
          this.raw.exec(`ROLLBACK TO ${savepoint}`);
          this.raw.exec(`RELEASE ${savepoint}`);
        }
      } catch (rollbackErr) {
        logEvent('error', 'db_rollback_failed', {
          label,
          message: rollbackErr?.message,
          cause: err?.message,
        });
      }
      if (err instanceof DbError) throw err;
      // خطاهای غیرپایگاه‌داده (اعتبارسنجی/کسب‌وکار) بدون تغییر و بدون لاگ
      // «db_error» عبور می‌کنند تا عیب‌یابی گمراه نشود.
      const normalized = logDbError(`transaction.${label}`, err);
      throw normalized === err ? err : normalized;
    }
  }

  /** Checkpoint امن: محتوای WAL به فایل اصلی منتقل و فایل WAL کوتاه می‌شود */
  checkpoint(mode = 'TRUNCATE') {
    this._assertOpen();
    const safe = ['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'].includes(String(mode).toUpperCase())
      ? String(mode).toUpperCase()
      : 'TRUNCATE';
    try {
      const row = this.raw.prepare(`PRAGMA wal_checkpoint(${safe})`).get();
      return {
        mode: safe,
        busy: Number(row?.busy ?? 0),
        logFrames: Number(row?.log ?? 0),
        checkpointedFrames: Number(row?.checkpointed ?? 0),
      };
    } catch (e) {
      throw logDbError('db.checkpoint', e);
    }
  }

  /** وضعیت فایل‌های WAL/SHM برای گزارش سلامت */
  walInfo() {
    const size = (p) => {
      try {
        return fs.statSync(p).size;
      } catch {
        return 0;
      }
    };
    return {
      journalMode: this.raw ? this.raw.prepare('PRAGMA journal_mode').get()?.journal_mode : null,
      synchronous: this.raw ? this.raw.prepare('PRAGMA synchronous').get()?.synchronous : null,
      walBytes: size(`${this.file}-wal`),
      shmBytes: size(`${this.file}-shm`),
      dbBytes: size(this.file),
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    try {
      this.raw?.close();
    } catch (e) {
      logEvent('warn', 'db_close_failed', { message: e?.message });
    }
    this.raw = null;
  }

  /** بازگشایی پس از Restore؛ Prepared Statementها با SQL از نو ساخته می‌شوند */
  reopen() {
    this.close();
    this._open();
    return this;
  }
}

let txSeq = 0;

/** خواب همگام کوچک برای تلاش دوبارهٔ SQLITE_BUSY (بدون async در مسیر تراکنش) */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* بی‌اثر */
  }
}

/* ------------------------------------------------------------------ */
/* بازیابی خودکار پس از Crash در میانهٔ Restore                         */
/* ------------------------------------------------------------------ */
/*
 * backup.js پیش از هر مرحلهٔ بازیابی، فایل `.restore-state.json` را durable
 * می‌نویسد. اگر فرآیند با SIGKILL/قطع برق از بین برود، این تابع پیش از بازکردن
 * اتصال اجرا می‌شود:
 *   • اگر فایل پایگاه‌داده موجود باشد (rename اتمیک یا کامل نشده)، همان فایل
 *     معتبر است و دست نمی‌خورد؛ فایل‌های موقت پاک می‌شوند.
 *   • اگر فایل اصلی غایب باشد (پنجرهٔ بسیار کوتاه پیش از rename)، نسخهٔ ایمنی
 *     بازگردانده می‌شود. بدون این کار، SQLite یک فایل خالی می‌ساخت و داده از
 *     دست می‌رفت.
 */
function recoverInterruptedRestoreBeforeOpen() {
  const stateFile = path.join(DATA_DIR, '.restore-state.json');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
  if (!state || state.status !== 'in_progress') return null;
  let recovered = false;
  const safety = state.safetyFile && fs.existsSync(state.safetyFile) ? state.safetyFile : null;
  const dbExists = (() => {
    try {
      return fs.existsSync(DB_PATH) && fs.statSync(DB_PATH).size > 0;
    } catch {
      return false;
    }
  })();
  try {
    if (!dbExists && safety) {
      const tmp = `${DB_PATH}.crash-recover-${process.pid}`;
      fs.copyFileSync(safety, tmp);
      const fd = fs.openSync(tmp, 'r+');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      for (const suffix of ['-wal', '-shm']) {
        try {
          fs.unlinkSync(`${DB_PATH}${suffix}`);
        } catch {
          /* بی‌اثر */
        }
      }
      fs.renameSync(tmp, DB_PATH);
      recovered = true;
    }
    // فایل‌های موقت باقی‌مانده هرگز بخشی از پایگاه‌داده نیستند.
    try {
      const dir = path.dirname(DB_PATH);
      const base = path.basename(DB_PATH);
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(`${base}.restore-stage-`) || name.startsWith(`${base}.rollback-`)) {
          fs.rmSync(path.join(dir, name), { force: true });
        }
      }
    } catch {
      /* بی‌اثر */
    }
    const next = {
      ...state,
      status: recovered ? 'recovered_interrupted' : 'interrupted',
      recoveredAt: Date.now(),
      updatedAt: Date.now(),
      note: recovered
        ? 'فایل اصلی در میانهٔ Restore غایب بود؛ نسخهٔ ایمنی بازگردانده شد.'
        : 'فایل اصلی موجود و معتبر بود؛ فایل‌های موقت پاک شدند.',
    };
    fs.writeFileSync(stateFile, JSON.stringify(next, null, 2));
    logEvent('warn', recovered ? 'restore_crash_recovered' : 'restore_crash_cleaned', {
      phase: state.phase,
      safety: Boolean(safety),
    });
    return next;
  } catch (e) {
    logEvent('error', 'restore_crash_recovery_failed', { message: e?.message, phase: state.phase });
    return null;
  }
}

recoverInterruptedRestoreBeforeOpen();

export const db = new DatabaseHandle(DB_PATH);
// فایل پایگاه‌داده شامل هش رمز و نشست‌هاست؛ مجوز فایل محدود می‌شود.
if (!String(DB_PATH).startsWith(':')) {
  try {
    fs.chmodSync(DB_PATH, 0o600);
  } catch {
    /* بی‌اثر */
  }
}

/** کمکی عمومی: اجرای اتمیک عملیات چندمرحله‌ای */
export function transaction(fn, options) {
  return db.transaction(fn, options);
}

/** بررسی فضای دیسک پیش از نوشتن سنگین (Import، Backup، Restore) */
export function requireDiskSpace(bytes, label) {
  return assertDiskSpace(DATA_DIR, bytes, label);
}

export function diskSpace() {
  const free = freeDiskBytes(DATA_DIR);
  return { freeBytes: free, dataDir: DATA_DIR, minFreeBytes: Number(process.env.NETWATCH_MIN_FREE_BYTES) || 64 * 1024 * 1024 };
}

export const STATUS = {
  ONLINE: 'online',
  OFFLINE: 'offline',
  WARNING: 'warning',
  UNKNOWN: 'unknown',
  MAINTENANCE: 'maintenance',
};

export const DEFAULT_SETTINGS = {
  site_name: 'مرکز پایش شبکه',
  engine_enabled: true,
  // پیش‌فرض عملیاتی: «خودکار» یعنی پایش واقعی (ICMP و در صورت نبود مجوز، TCP).
  // شبیه‌سازی هرگز به‌صورت خودکار و پنهان اجرا نمی‌شود؛ برای دمو/آموزش باید
  // صریحاً انتخاب شود (تنظیمات یا NETWATCH_ENGINE_MODE=simulate).
  engine_mode: 'auto', // auto | icmp | tcp | simulate
  ping_interval: 30, // ثانیه — بازه پیش‌فرض ارسال Ping
  timeout_ms: 1200,
  retries: 1, // تعداد تلاش مجدد
  packet_count: 3, // تعداد packet در هر بررسی
  max_workers: 128, // همزمانی موتور مانیتورینگ
  latency_threshold: 150, // آستانه مجاز تأخیر (ms)
  loss_threshold: 10, // آستانه مجاز packet loss (٪)
  failures_for_offline: 3, // شکست متوالی برای تشخیص Offline
  successes_for_online: 2, // پاسخ موفق متوالی برای Recovery
  // مدت نگهداری رکوردهای خام. کلید قدیمی برای سازگاری حفظ شده است؛ سیاست
  // رسمی Phase 2 در کلیدهای samples_retention_days و… نگهداری می‌شود و
  // Settings UI همان‌ها را ویرایش می‌کند.
  retention_days: 90,
  // ---- Data Retention Policy (Phase 2) ----
  // همهٔ مقادیر از UI/API قابل تغییرند و در جدول settings ذخیره می‌شوند.
  retention_enabled: true,
  retention_run_time: '03:00', // زمان اجرای روزانه به وقت محلی (timezone_offset_minutes)
  retention_interval_minutes: 1440, // حداقل فاصلهٔ دو اجرای خودکار
  retention_batch_size: 5000, // رکورد در هر تراکنش
  retention_max_rows_per_run: 100000, // سقف کل رکوردهای هر اجرا (اجرای کوتاه و قابل توقف)
  samples_retention_days: 90,
  daily_stats_retention_days: 365,
  outages_retention_days: 365,
  alerts_retention_days: 180,
  engine_log_retention_days: 30,
  // الزام قانونی/قراردادی: با فعال‌بودن این پرچم هیچ حذفی انجام نمی‌شود تا مدیر
  // سیاست را آگاهانه تغییر دهد. سیاست مدیر همیشه بر پیش‌فرض‌ها مقدم است.
  retention_legal_hold: false,
  // Retention هرگز به‌طور پیش‌فرض فایل پشتیبان را حذف نمی‌کند؛ هرس پشتیبان
  // وظیفهٔ زمان‌بند پشتیبان با سیاست مستقل است.
  retention_prune_backups: false,
  chart_default_range: '1h', // بازه پیش‌فرض نمودارها
  tcp_port: 80,
  calendar: 'jalali',
  timezone_offset_minutes: 210, // Asia/Tehran
  alerting_enabled: true,
  alert_cooldown: 600,
  alert_delay: 0,
  suppression_enabled: false,
  suppression_start: '23:00',
  suppression_end: '06:00',
  notify_browser: true,
  repair_causes: [
    'مشکلات زیرساخت فیبر نوری',
    'مشکلات شبکه',
    'قطعی برق',
    'هنگ کردن سوئیچ',
    'سوختن یا خرابی تجهیز',
    'اختلال نرم‌افزاری',
    'نگهداری پیشگیرانه',
    'سایر',
  ],
  repair_actions: [
    'تعویض تجهیز',
    'تعمیر تجهیز',
    'تعویض قطعه',
    'اصلاح زیرساخت',
    'رفع مشکل شبکه',
    'به‌روزرسانی نرم‌افزار',
    'سایر',
  ],
  map_default_center: [35.6892, 51.389],
  map_default_zoom: 6,
  map_show_labels: true,
  // چیدمان ویجت‌های صفحه جزئیات تجهیز و داشبورد (خالی = چیدمان پیش‌فرض)
  device_detail_widgets: [],
  dashboard_widgets: [],
  // Probe و اسکن فعال فقط روی این محدوده‌ها مجاز است (پیش‌فرض: شبکه‌های خصوصی)
  // Link-Local (169.254/16، fe80::/10) و Cloud Metadata عمداً در پیش‌فرض
  // نیستند؛ فعال‌سازی آن‌ها نیازمند پرچم صریح مدیر است (سیاست در net-policy.js).
  probe_allowed_cidrs: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '::1/128', 'fc00::/7'],
  probe_allow_link_local: false,
  probe_allow_metadata: false,
  probe_allow_transition: false,
  // نگهداری گزارش حسابرسی (روز) — حداقل ۳۶۵ روز طبق سیاست
  audit_retention_days: 365,
  // پشتیبان‌گیری خودکار و سیاست Checkpoint
  backup_enabled: true,
  backup_interval_hours: 24,
  backup_keep: 7, // سازگاری با نسخه‌های قبلی (سقف کل)
  backup_prune_enabled: true,
  backup_daily_keep: 7, // ۷ نسخهٔ روزانه
  backup_weekly_keep: 4, // ۴ نسخهٔ هفتگی (GFS)
  checkpoint_interval_minutes: 15,
};

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- قفل رهبری موتور: فقط یک فرآیند در هر لحظه Ping می‌زند
CREATE TABLE IF NOT EXISTS engine_lock (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  owner      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Fencing Token: با هر انتقال مالکیت یک واحد افزایش می‌یابد. نتیجهٔ عملیاتی
  -- که epoch قدیمی دارد، پس از تغییر رهبری ثبت نمی‌شود.
  epoch      INTEGER NOT NULL DEFAULT 0
);

-- شمارندهٔ پایدار دورهٔ رهبری (Fencing Token). جدا از ردیف قفل نگه داشته
-- می‌شود تا حتی پس از حذف ردیف در خاموشی تمیز، شمارنده تکرار نشود.
CREATE TABLE IF NOT EXISTS engine_meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO engine_meta(key, value) VALUES ('leader_epoch', 0);

-- احراز هویت: رمز فقط به‌صورت هش Argon2id (و scrypt قدیمی برای مهاجرت)؛ نقش admin | operator | viewer
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'viewer',
  display_name  TEXT DEFAULT '',
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_login_at INTEGER,
  -- Phase 3: قفل حساب پس از تلاش‌های ناموفق و زمان آخرین تغییر رمز
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until       INTEGER,
  password_changed_at INTEGER
);

-- نشست‌ها: توکن خام هرگز ذخیره نمی‌شود، فقط هش SHA-256 آن
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_hash    TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip           TEXT DEFAULT '',
  user_agent   TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen_at);

-- گزارش حسابرسی: هر عملیات تغییردهنده و رویداد امنیتی. مقادیر حساس هرگز ذخیره نمی‌شوند.
CREATE TABLE IF NOT EXISTS audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  actor_id       INTEGER,
  actor_username TEXT NOT NULL DEFAULT '',
  actor_role     TEXT NOT NULL DEFAULT '',
  action         TEXT NOT NULL,
  target_type    TEXT DEFAULT '',
  target_id      TEXT DEFAULT '',
  method         TEXT DEFAULT '',
  path           TEXT DEFAULT '',
  ip             TEXT DEFAULT '',
  user_agent     TEXT DEFAULT '',
  status         INTEGER,
  success        INTEGER NOT NULL DEFAULT 1,
  details        TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_username);

CREATE TABLE IF NOT EXISTS groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  color       TEXT DEFAULT '#3b82f6',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  color        TEXT DEFAULT '#f59e0b',
  show_on_map  INTEGER NOT NULL DEFAULT 1,
  icon         TEXT DEFAULT 'tag',
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS map_layers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  description   TEXT DEFAULT '',
  kind          TEXT NOT NULL DEFAULT 'builtin', -- builtin | mbtiles | empty
  file_name     TEXT,
  min_zoom      INTEGER DEFAULT 0,
  max_zoom      INTEGER DEFAULT 19,
  attribution   TEXT DEFAULT '',
  visible       INTEGER NOT NULL DEFAULT 1,
  is_default    INTEGER NOT NULL DEFAULT 0,
  tile_count    INTEGER DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  name                      TEXT NOT NULL,
  ip                        TEXT NOT NULL,
  hostname                  TEXT DEFAULT '',
  device_type               TEXT DEFAULT 'سوئیچ',
  group_id                  INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  location                  TEXT DEFAULT '',
  building                  TEXT DEFAULT '',
  rack                      TEXT DEFAULT '',
  latitude                  REAL,
  longitude                 REAL,
  map_layer_id              INTEGER REFERENCES map_layers(id) ON DELETE SET NULL,
  vendor                    TEXT DEFAULT '',
  model                     TEXT DEFAULT '',
  serial                    TEXT DEFAULT '',
  firmware                  TEXT DEFAULT '',
  owner                     TEXT DEFAULT '',
  notes                     TEXT DEFAULT '',
  priority                  TEXT NOT NULL DEFAULT 'normal', -- low | normal | high | critical
  enabled                   INTEGER NOT NULL DEFAULT 1,
  monitoring_enabled        INTEGER NOT NULL DEFAULT 1,
  ping_interval             INTEGER, -- خالی = استفاده از مقدار عمومی
  timeout_ms                INTEGER,
  packet_count              INTEGER,
  retries                   INTEGER,
  latency_threshold         REAL,
  loss_threshold            REAL,
  status                    TEXT NOT NULL DEFAULT 'unknown',
  status_reason             TEXT DEFAULT '',
  last_check_at             INTEGER,
  last_status_change_at     INTEGER,
  last_rtt_ms               REAL,
  min_rtt_ms                REAL,
  max_rtt_ms                REAL,
  avg_rtt_ms                REAL,
  loss_pct                  REAL DEFAULT 0,
  success_count             INTEGER NOT NULL DEFAULT 0,
  fail_count                INTEGER NOT NULL DEFAULT 0,
  consecutive_failures      INTEGER NOT NULL DEFAULT 0,
  consecutive_successes     INTEGER NOT NULL DEFAULT 0,
  uptime_pct                REAL DEFAULT 100,
  total_checks              INTEGER NOT NULL DEFAULT 0,
  last_outage_at            INTEGER,
  current_outage_id         INTEGER,
  current_outage_started_at INTEGER,
  last_recovery_at          INTEGER,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  next_check_at             INTEGER NOT NULL DEFAULT 0 -- زمان سررسید بررسی بعدی (0 = بی‌درنگ)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_ip ON devices(ip);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
CREATE INDEX IF NOT EXISTS idx_devices_group ON devices(group_id);

CREATE TABLE IF NOT EXISTS device_tags (
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (device_id, tag_id)
);

CREATE TABLE IF NOT EXISTS samples (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id     INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ts            INTEGER NOT NULL,
  rtt_ms        REAL,
  packets_sent  INTEGER NOT NULL DEFAULT 1,
  packets_recv  INTEGER NOT NULL DEFAULT 0,
  loss_pct      REAL NOT NULL DEFAULT 0,
  status        TEXT NOT NULL,
  ok            INTEGER NOT NULL DEFAULT 0,
  mode          TEXT DEFAULT 'simulate'
);
CREATE INDEX IF NOT EXISTS idx_samples_device_ts ON samples(device_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts DESC);

CREATE TABLE IF NOT EXISTS outages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  duration_sec INTEGER,
  cause       TEXT DEFAULT 'Ping Timeout',
  detail      TEXT DEFAULT '',
  lat         REAL,
  lng         REAL,
  open        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_outages_device ON outages(device_id, started_at DESC);

CREATE TABLE IF NOT EXISTS daily_stats (
  device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  day         TEXT NOT NULL, -- YYYY-MM-DD (UTC)
  checks      INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  avg_rtt     REAL,
  min_rtt     REAL,
  max_rtt     REAL,
  loss_pct    REAL,
  outages     INTEGER NOT NULL DEFAULT 0,
  downtime_sec INTEGER NOT NULL DEFAULT 0,
  uptime_pct  REAL,
  PRIMARY KEY (device_id, day)
);
CREATE INDEX IF NOT EXISTS idx_daily_day ON daily_stats(day);

CREATE TABLE IF NOT EXISTS alert_rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  metric          TEXT NOT NULL DEFAULT 'offline', -- offline | latency | loss | recovery
  comparator      TEXT NOT NULL DEFAULT 'gte',
  threshold       REAL DEFAULT 0,
  duration_sec    INTEGER DEFAULT 0, -- تأخیر قبل از ثبت هشدار
  severity        TEXT NOT NULL DEFAULT 'warning', -- info | warning | critical
  scope_group_id  INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  cooldown_sec    INTEGER DEFAULT 600,
  apply_to_unmon  INTEGER NOT NULL DEFAULT 0,
  silent          INTEGER NOT NULL DEFAULT 0, -- در بازه سکوت قرار بگیرد
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id     INTEGER REFERENCES devices(id) ON DELETE CASCADE,
  rule_id       INTEGER REFERENCES alert_rules(id) ON DELETE SET NULL,
  severity      TEXT NOT NULL DEFAULT 'warning',
  kind          TEXT NOT NULL DEFAULT 'offline', -- offline | latency | loss | recovery | maintenance
  title         TEXT NOT NULL,
  message       TEXT DEFAULT '',
  value         REAL,
  created_at    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active', -- active | acknowledged | resolved | suppressed
  acknowledged_at INTEGER,
  acknowledged_by TEXT,
  resolved_at   INTEGER,
  notified      INTEGER NOT NULL DEFAULT 0,
  duplicate_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);

CREATE TABLE IF NOT EXISTS maintenance_records (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id    INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  outage_id    INTEGER REFERENCES outages(id) ON DELETE SET NULL,
  title        TEXT DEFAULT '',
  cause        TEXT NOT NULL DEFAULT 'سایر', -- علت خرابی
  action       TEXT NOT NULL DEFAULT 'سایر', -- اقدام انجام‌شده
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  downtime_sec INTEGER DEFAULT 0,
  technician   TEXT DEFAULT '',
  cost         REAL DEFAULT 0,
  description  TEXT DEFAULT '',
  notes        TEXT DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'closed', -- open | closed
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_maint_device ON maintenance_records(device_id, started_at DESC);

CREATE TABLE IF NOT EXISTS maintenance_windows (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id    INTEGER REFERENCES devices(id) ON DELETE CASCADE, -- خالی = سراسری
  title        TEXT DEFAULT 'پنجره تعمیرات',
  days         TEXT DEFAULT '0,1,2,3,4,5,6',
  start_time   TEXT DEFAULT '01:00',
  end_time     TEXT DEFAULT '03:00',
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS engine_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  level      TEXT NOT NULL DEFAULT 'info',
  message    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_engine_log_ts ON engine_log(ts DESC);

-- انواع «علامت» روی نقشه (مثل «تجهیز در حال نصب») که کاربر تعریف می‌کند
CREATE TABLE IF NOT EXISTS marker_types (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  color       TEXT DEFAULT '#0ea5e9',
  icon        TEXT DEFAULT 'map-pin',
  description TEXT DEFAULT '',
  created_at  INTEGER NOT NULL
);

-- جانمایی علامت‌ها روی نقشه؛ هر علامت یک نام مشخص و مختصات جغرافیایی دارد
CREATE TABLE IF NOT EXISTS map_markers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id     INTEGER REFERENCES marker_types(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  latitude    REAL NOT NULL,
  longitude   REAL NOT NULL,
  notes       TEXT DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_map_markers_type ON map_markers(type_id);
`);

/* ------------------------------------------------------------------ */
/* Migrations — افزودن ستون‌های تازه به پایگاه‌داده‌های موجود               */
/* ------------------------------------------------------------------ */

/**
 * پشتیبان فایلی پیش از Migration. قبل از هر تغییر ساختار، یک کپی کامل و
 * قابل‌بازیابی از پایگاه‌داده ساخته می‌شود؛ اگر Migration نیمه‌کاره بماند،
 * اپراتور می‌تواند همین فایل را بازگرداند.
 * @returns {string|null} مسیر فایل پشتیبان
 */
function backupBeforeMigration(fromVersion) {
  if (!DB_EXISTED) return null;
  if (String(DB_PATH).startsWith(':')) return null;
  try {
    // WAL را به فایل اصلی منتقل می‌کنیم تا کپی، همهٔ تراکنش‌های تأییدشده را داشته باشد.
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* checkpoint اختیاری است؛ کپی فایل اصلی + WAL هنوز قابل استفاده است */
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = `${DB_PATH}.pre-migration-v${fromVersion}-${stamp}`;
    fs.copyFileSync(DB_PATH, dest, fs.constants.COPYFILE_EXCL);
    try {
      fs.chmodSync(dest, 0o600);
    } catch {
      /* مجوز فایل روی بعضی فایل‌سیستم‌ها قابل تغییر نیست */
    }
    logEvent('info', 'db_pre_migration_backup', { fromVersion, toVersion: SCHEMA_VERSION, file: path.basename(dest) });
    return dest;
  } catch (e) {
    // اگر پشتیبان ساخته نشود، Migration انجام نمی‌شود؛ ادامه روی دادهٔ بدون
    // نسخهٔ پشتیبان، ریسک غیرقابل‌بازگشت می‌سازد.
    throw new DbError(DB_ERROR_CODES.BACKUP_INVALID, `پشتیبان پیش از Migration ساخته نشد: ${e.message}`, { status: 500 });
  }
}

function currentSchemaVersion() {
  try {
    return Number(db.prepare('PRAGMA user_version').get()?.user_version) || 0;
  } catch {
    return 0;
  }
}

function hasColumn(table, column) {
  try {
    // نام جدول/ستون هرگز از ورودی کاربر نمی‌آید؛ با این حال اعتبارسنجی می‌شود
    // تا الگوی «درج رشته در SQL» در هیچ مسیری تکرار نشود.
    const t = assertSqlIdentifier(table, 'نام جدول');
    return db
      .prepare(`PRAGMA table_info(${t})`)
      .all()
      .some((c) => c.name === column);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Migrationهای نسخه‌بندی‌شده                                         */
/* ------------------------------------------------------------------ */
/*
 * هر تغییر ساختار یک گام شماره‌دار است و پس از اعمال، در جدول
 * `schema_migrations` ثبت می‌شود. `PRAGMA user_version` هم در همان تراکنش
 * به‌روزرسانی می‌شود تا حتی با قطع ناگهانی، «نیمه‌مهاجرت» رخ ندهد.
 * گام‌ها idempotent هستند (CREATE IF NOT EXISTS / بررسی ستون) تا اجرای دوباره
 * روی پایگاه‌داده‌ای که user_version ندارد ولی ساختارش کامل است، بی‌خطر باشد.
 */

/** گام ۲: ستون‌های تاب‌آوری، ایندکس‌ها و قیدهای یکتایی (Phase 1) */
function applyResilienceMigration() {
  // زمان‌بندی صریح بررسی بعدی هر تجهیز؛ به موتور اجازه می‌دهد در هر ثانیه به‌جای
  // پیمایش همه تجهیزات، فقط تجهیزات سررسیدشده را با ایندکس بخواند (مقیاس ۱۰۰۰+)
  if (!hasColumn('devices', 'next_check_at')) {
    db.exec('ALTER TABLE devices ADD COLUMN next_check_at INTEGER NOT NULL DEFAULT 0');
  }
  // اگر ستون در نسخهٔ میانی بدون مقدار پیش‌فرض ساخته شده باشد، NULL یعنی «هیچ‌وقت سررسید
  // نمی‌شود» و آن تجهیز هرگز بررسی نخواهد شد؛ پس همهٔ NULL‌ها به ۰ برگردانده می‌شوند.
  db.exec('UPDATE devices SET next_check_at = 0 WHERE next_check_at IS NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_devices_due ON devices(enabled, monitoring_enabled, next_check_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_outages_started ON outages(started_at DESC)');
  // نام کاربری بدون توجه به بزرگی/کوچکی یکتا باشد (admin ≠ Admin)
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE)');
  } catch {
    log('warn', 'ساخت ایندکس یکتای نام کاربری ناموفق بود (نام تکراری در دادهٔ موجود).');
  }
  // کمینه تأخیر روزانه برای گزارش‌های بلندمدتی که نمونهٔ خام‌شان هرس شده است
  if (!hasColumn('daily_stats', 'min_rtt')) {
    db.exec('ALTER TABLE daily_stats ADD COLUMN min_rtt REAL');
  }

  // زمان برنامه‌ریزی‌شده (سررسید) و زمان واقعی شروع هر بررسی. اختلاف این دو،
  // شاخص «تأخیر زمان‌بندی موتور» (Scheduling Lag) را می‌سازد؛ بدون ثبت آن،
  // عقب‌ماندگی موتور در بار بالا فقط به‌صورت غیرمستقیم دیده می‌شد.
  if (!hasColumn('samples', 'scheduled_at')) {
    db.exec('ALTER TABLE samples ADD COLUMN scheduled_at INTEGER');
  }
  if (!hasColumn('samples', 'started_at')) {
    db.exec('ALTER TABLE samples ADD COLUMN started_at INTEGER');
  }

  // Fencing Token: پایگاه‌داده‌های قدیمی ستون epoch ندارند. مقدار پیش‌فرض ۰
  // سازگار است؛ نخستین گرفتن قفل آن را به ۱ می‌رساند.
  if (!hasColumn('engine_lock', 'epoch')) {
    db.exec('ALTER TABLE engine_lock ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0');
  }
  db.exec('CREATE TABLE IF NOT EXISTS engine_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)');
  db.exec("INSERT OR IGNORE INTO engine_meta(key, value) VALUES ('leader_epoch', 0)");

  // «یک نتیجه برای هر عملیات»: unique روی (device_id, started_at) از ثبت
  // دوبارهٔ نتیجهٔ یک Probe توسط دو مسیر/فرآیند جلوگیری می‌کند. ردیف‌های قدیمی
  // که started_at ندارند مشمول قید جزئی نیستند. اگر دادهٔ قدیمی تکراری باشد،
  // ساخت ایندکس شکست می‌خورد؛ در آن حالت هشدار داده می‌شود و برنامه متوقف
  // نمی‌شود (Migration باید Backward Compatible باشد).
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_samples_operation ON samples(device_id, started_at) WHERE started_at IS NOT NULL');
  } catch (e) {
    log('warn', `ساخت قید یکتای نتیجهٔ عملیات ناموفق بود (دادهٔ تکراری قدیمی): ${e.message}`);
  }

  /* ایندکس‌های تکمیلی: هر یک بر اساس EXPLAIN QUERY PLAN پرس‌وجوهای واقعی
     برنامه اضافه شده‌اند (گزارش در docs/db-reliability-report.md). */
  db.exec(`
    -- ضدتکرار هشدار: recentAlert با duplicate_key جست‌وجو می‌کند
    CREATE INDEX IF NOT EXISTS idx_alerts_duplicate ON alerts(duplicate_key, created_at DESC);
    -- فهرست/حل هشدارهای یک تجهیز
    CREATE INDEX IF NOT EXISTS idx_alerts_device_status ON alerts(device_id, status, kind);
    -- قطعی باز هر تجهیز (و تضمین «حداکثر یک قطعی باز»)
    CREATE INDEX IF NOT EXISTS idx_outages_open ON outages(device_id) WHERE open = 1;
    -- هرس قطعی‌های بسته‌شده بر اساس زمان شروع
    CREATE INDEX IF NOT EXISTS idx_outages_closed_started ON outages(started_at) WHERE open = 0;
    -- نگهداری سابقهٔ تعمیرات متصل به قطعی (هرس نباید پیوند را قطع کند)
    CREATE INDEX IF NOT EXISTS idx_maint_outage ON maintenance_records(outage_id);
    -- پنجره‌های تعمیرات فعال هر تجهیز/سراسری
    CREATE INDEX IF NOT EXISTS idx_windows_device ON maintenance_windows(device_id, enabled);
    -- شمارش موفق/ناموفق هر تجهیز بدون پیمایش کل نمونه‌ها
    CREATE INDEX IF NOT EXISTS idx_samples_device_ok ON samples(device_id, ok, ts DESC);
    -- فهرست تجهیزات بر اساس نوع/اولویت (فیلترهای پرکاربرد فهرست)
    CREATE INDEX IF NOT EXISTS idx_devices_type ON devices(device_type);
    CREATE INDEX IF NOT EXISTS idx_devices_priority ON devices(priority);
    -- تجمیع هشدارها/قطعی‌ها به تفکیک بازه (گزارش‌ها بدون زیرپرس‌وجوی همبسته)
    CREATE INDEX IF NOT EXISTS idx_alerts_device_created ON alerts(device_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_outages_device_window ON outages(device_id, started_at, ended_at);
    -- فیلتر bbox نقشه: فقط تجهیزات دارای مختصات در ایندکس می‌آیند
    CREATE INDEX IF NOT EXISTS idx_devices_geo ON devices(latitude, longitude) WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
  `);
  // «حداکثر یک قطعی باز برای هر تجهیز» نه فقط یک قاعدهٔ کد، بلکه یک قید
  // پایگاه‌داده می‌شود. اگر موتور وسط ثبت قطعی از کار بیفتد یا نسخهٔ قدیمی
  // ردیف تکراری ساخته باشد، این قید جلوی ادامهٔ خرابی را می‌گیرد.
  try {
    const dupes = db.prepare('SELECT device_id, COUNT(*) AS c FROM outages WHERE open = 1 GROUP BY device_id HAVING c > 1').all();
    for (const d of dupes) {
      const rows = db.prepare('SELECT id, started_at FROM outages WHERE device_id = ? AND open = 1 ORDER BY started_at ASC, id ASC').all(d.device_id);
      for (const extra of rows.slice(1)) {
        db.prepare(
          `UPDATE outages SET open = 0, ended_at = COALESCE(ended_at, ?),
             duration_sec = COALESCE(duration_sec, MAX(1, CAST((? - started_at) / 1000 AS INTEGER)))
           WHERE id = ?`
        ).run(extra.started_at, extra.started_at, extra.id);
      }
      log('warn', `قطعی باز تکراری برای تجهیز #${d.device_id} تجمیع شد (${rows.length - 1} ردیف بسته شد).`);
    }
    // ایندکس قدیمی (غیریکتا) با همان نام باید پیش از ساخت نسخهٔ یکتا حذف شود.
    const existing = db.prepare("SELECT name, \"unique\" AS u FROM pragma_index_list('outages') WHERE name = 'idx_outages_open'").get();
    if (existing && !existing.u) db.exec('DROP INDEX idx_outages_open');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_outages_open ON outages(device_id) WHERE open = 1');
  } catch (e) {
    log('warn', `ساخت قید یکتای قطعی باز ناموفق بود: ${e.message}`);
  }

  // آمار بهینه‌ساز فقط وقتی جدول‌ها داده دارند معنا دارد؛ یک‌بار در هر راه‌اندازی
  // این کار ارزان است و برنامه‌ریز را از پیمایش کامل جدا می‌کند.
  try {
    db.exec('PRAGMA optimize');
  } catch {
    /* بی‌اثر */
  }
}

/** گام ۳: جداول و ایندکس‌های Data Retention و وضعیت زمان اجرا (Phase 2) */
function applyRetentionMigration() {
  db.exec(`
    -- هر اجرای Retention (خودکار/دستی/آزمایشی) یک ردیف durable دارد؛ وضعیت
    -- پس از Crash هم از همین‌جا خوانده می‌شود.
    CREATE TABLE IF NOT EXISTS retention_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at    INTEGER NOT NULL,
      finished_at   INTEGER,
      trigger       TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | manual | engine | cli
      actor         TEXT NOT NULL DEFAULT '',
      dry_run       INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'running', -- running | completed | stopped | failed | interrupted
      stage         TEXT NOT NULL DEFAULT '',
      deleted       TEXT NOT NULL DEFAULT '{}', -- JSON: {samples: n, outages: n, …}
      scanned       INTEGER NOT NULL DEFAULT 0,
      deleted_rows  INTEGER NOT NULL DEFAULT 0,
      freed_bytes   INTEGER NOT NULL DEFAULT 0,
      batches       INTEGER NOT NULL DEFAULT 0,
      duration_ms   INTEGER,
      error         TEXT NOT NULL DEFAULT '',
      policy        TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_retention_runs_started ON retention_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_retention_runs_status ON retention_runs(status, started_at DESC);

    -- قفل تک‌نمونه‌ای Retention: از اجرای هم‌زمان دو نسخه (سرور + CLI) جلوگیری
    -- می‌کند. قفل منقضی‌شده پس از Crash با lease تازه گرفته می‌شود.
    CREATE TABLE IF NOT EXISTS retention_state (
      id                INTEGER PRIMARY KEY CHECK (id = 1),
      lock_owner        TEXT,
      lock_expires_at   INTEGER NOT NULL DEFAULT 0,
      -- درخواست توقف از فرآیند دیگر (بین دو Batch خوانده می‌شود)
      stop_requested    INTEGER NOT NULL DEFAULT 0,
      last_run_id       INTEGER,
      last_started_at   INTEGER,
      last_finished_at  INTEGER,
      last_status       TEXT NOT NULL DEFAULT 'never',
      last_deleted_rows INTEGER NOT NULL DEFAULT 0,
      last_freed_bytes  INTEGER NOT NULL DEFAULT 0,
      next_run_at       INTEGER,
      updated_at        INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO retention_state(id, updated_at) VALUES (1, 0);

    -- وضعیت کوچک زمان اجرا (مثلاً آخرین مشاهدهٔ ساعت دیوار)؛ مقدارها JSON متنی‌اند
    CREATE TABLE IF NOT EXISTS runtime_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- ایندکس‌های کلید خارجی که SQLite خودکار نمی‌سازد؛ بدون آن‌ها حذف/به‌روزرسانی
    -- والد (گروه، لایه، قاعدهٔ هشدار) نیازمند پیمایش کامل جدول فرزند است.
    CREATE INDEX IF NOT EXISTS idx_devices_layer ON devices(map_layer_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_rule ON alerts(rule_id);
    CREATE INDEX IF NOT EXISTS idx_alert_rules_group ON alert_rules(scope_group_id);
    -- کمینه/بیشینهٔ قطعی‌ها بر اساس پایان؛ گزارش‌های بازه‌ای بدون اسکن کامل
    CREATE INDEX IF NOT EXISTS idx_outages_ended ON outages(ended_at) WHERE ended_at IS NOT NULL;
  `);
}

/** گام ۴: قفل حساب، Idle Timeout و ثبت تغییر رمز (Phase 3) */
function applyAuthSecurityMigration() {
  // شمارندهٔ تلاش ناموفق و زمان پایان قفل؛ پیش‌فرض ۰/NULL یعنی حساب باز است.
  if (!hasColumn('users', 'failed_login_count')) {
    db.exec('ALTER TABLE users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasColumn('users', 'locked_until')) {
    db.exec('ALTER TABLE users ADD COLUMN locked_until INTEGER');
  }
  if (!hasColumn('users', 'password_changed_at')) {
    db.exec('ALTER TABLE users ADD COLUMN password_changed_at INTEGER');
  }
  // آخرین بازدید برای Idle Timeout و پاک‌سازی نشست‌های بی‌فعالیت.
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen_at)');
  // ردیف‌های قدیمی که مقدار NULL دارند نباید باعث خطای مقایسه شوند.
  db.exec('UPDATE users SET failed_login_count = 0 WHERE failed_login_count IS NULL');
}

/** گام ۵: ایندکس‌های عملکردی (Phase 5) — بر پایهٔ EXPLAIN QUERY PLAN */
function applyPerformanceIndexesMigration() {
  db.exec(`
    -- فهرست هشدارهای فعال و شمارش آن‌ها: پیش‌تر status را از ایندکس می‌خواند و
    -- سپس با TEMP B-TREE مرتب می‌کرد؛ با هشدارهای زیاد این مرتب‌سازی گران بود.
    CREATE INDEX IF NOT EXISTS idx_alerts_status_created ON alerts(status, created_at DESC);
    -- شمارش قطعی‌های باز داشبورد (ended_at IS NULL) بدون اسکن جدول بزرگ outages
    CREATE INDEX IF NOT EXISTS idx_outages_ended_open ON outages(ended_at) WHERE ended_at IS NULL;
    -- سری روزانهٔ یک تجهیز در جزئیات تجهیز/گزارش (پوشش device_id + day)
    CREATE INDEX IF NOT EXISTS idx_daily_device_day ON daily_stats(device_id, day);
  `);
  try {
    db.exec('PRAGMA optimize');
  } catch {
    /* بی‌اثر */
  }
}

/**
 * گام ۶: ماژول دیاگرام ارتباطات شبکه (Topology)
 *
 * این ماژول کاملاً افزودنی است: هیچ جدول یا ستون موجودی تغییر نمی‌کند.
 * شناسهٔ گره‌ها/لینک‌ها متن یکتا (UUID) است تا ویرایشگر بتواند پیش از ذخیرهٔ
 * نخستین نسخه هم شناسهٔ پایدار بسازد (بدون نگاشت شناسهٔ موقت و بدون تکرار).
 * ارجاع به تجهیز/مرکز تجمع با ON DELETE SET NULL است؛ حذف یک تجهیز نباید
 * ساختار دیاگرام یا الگوهای ساخته‌شده از آن را نابود کند — گره به‌صورت
 * «تجهیز حذف‌شده» باقی می‌ماند و یکپارچگی در لایهٔ نمایش بررسی می‌شود.
 */
function applyTopologyMigration() {
  db.exec(`
    -- مراکز تجمع (ساختمان/سایت/دیتاسنتر) — مستقل از گروه‌های منطقی تجهیزات
    CREATE TABLE IF NOT EXISTS topology_sites (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      code       TEXT DEFAULT '',
      address    TEXT DEFAULT '',
      latitude   REAL,
      longitude  REAL,
      notes      TEXT DEFAULT '',
      color      TEXT DEFAULT '#6366f1',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_topology_sites_name ON topology_sites(name);

    -- هر تجهیز حداکثر در یک مرکز تجمع قرار می‌گیرد (انتقال = جایگزینی ردیف)
    CREATE TABLE IF NOT EXISTS topology_site_devices (
      device_id  INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
      site_id    INTEGER NOT NULL REFERENCES topology_sites(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_topology_site_devices_site ON topology_site_devices(site_id);

    CREATE TABLE IF NOT EXISTS topology_diagrams (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      description TEXT DEFAULT '',
      layout      TEXT NOT NULL DEFAULT 'hierarchy-tb',
      locked      INTEGER NOT NULL DEFAULT 0,
      is_template INTEGER NOT NULL DEFAULT 0,
      revision    INTEGER NOT NULL DEFAULT 1,
      viewport    TEXT NOT NULL DEFAULT '{}',
      settings    TEXT NOT NULL DEFAULT '{}',
      created_by  TEXT DEFAULT '',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_topology_diagrams_template ON topology_diagrams(is_template, updated_at DESC);

    -- گره‌های گرافیکی: تجهیز واقعی، مرکز تجمع، ابر/شبکه بیرونی یا یادداشت آزاد
    CREATE TABLE IF NOT EXISTS topology_nodes (
      id         TEXT PRIMARY KEY,
      diagram_id INTEGER NOT NULL REFERENCES topology_diagrams(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL DEFAULT 'device',
      device_id  INTEGER REFERENCES devices(id) ON DELETE SET NULL,
      site_id    INTEGER REFERENCES topology_sites(id) ON DELETE SET NULL,
      label      TEXT DEFAULT '',
      notes      TEXT DEFAULT '',
      x          REAL NOT NULL DEFAULT 0,
      y          REAL NOT NULL DEFAULT 0,
      width      REAL NOT NULL DEFAULT 190,
      height     REAL NOT NULL DEFAULT 72,
      color      TEXT DEFAULT '',
      z          INTEGER NOT NULL DEFAULT 0,
      meta       TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_topology_nodes_diagram ON topology_nodes(diagram_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_topology_nodes_device ON topology_nodes(diagram_id, device_id) WHERE device_id IS NOT NULL;

    -- یال‌های ارتباطی با شناسهٔ یکتا، نوع، برچسب و یادداشت
    CREATE TABLE IF NOT EXISTS topology_links (
      id           TEXT PRIMARY KEY,
      diagram_id   INTEGER NOT NULL REFERENCES topology_diagrams(id) ON DELETE CASCADE,
      from_node_id TEXT NOT NULL REFERENCES topology_nodes(id) ON DELETE CASCADE,
      to_node_id   TEXT NOT NULL REFERENCES topology_nodes(id) ON DELETE CASCADE,
      kind         TEXT NOT NULL DEFAULT 'ethernet',
      label        TEXT DEFAULT '',
      notes        TEXT DEFAULT '',
      color        TEXT DEFAULT '',
      style        TEXT NOT NULL DEFAULT 'solid',
      meta         TEXT NOT NULL DEFAULT '{}',
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      CHECK (from_node_id <> to_node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_topology_links_diagram ON topology_links(diagram_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_topology_links_pair ON topology_links(diagram_id, from_node_id, to_node_id);
  `);
}

/**
 * گام ۷: سنجش زندهٔ لینک‌های دیاگرام.
 *
 * مرحلهٔ ۲ توپولوژی به هر لینک اجازه می‌دهد منبع سنجش مستقل داشته باشد:
 *   • capacity_mbps      پهنای باند اسمی (ثبت‌شده توسط کاربر، نه حدس)
 *   • monitor_device_id  تجهیز مرجع سنجش تأخیر/افت/نوسان (اختیاری)
 *   • telemetry_*        پیکربندی خواندن شمارندهٔ اینترفیس از طریق SNMP
 *
 * وضعیت لحظه‌ای در `topology_link_telemetry` نگهداری می‌شود؛ فقط آخرین مقدار
 * هر لینک ذخیره می‌شود تا جدول با گذشت زمان رشد نکند. شمارنده‌های خام به‌صورت
 * TEXT ذخیره می‌شوند چون Counter64 می‌تواند از بازهٔ امن Number بزرگ‌تر باشد.
 */
function applyTopologyLiveMigration() {
  if (!hasColumn('topology_links', 'capacity_mbps')) {
    db.exec('ALTER TABLE topology_links ADD COLUMN capacity_mbps REAL');
  }
  if (!hasColumn('topology_links', 'monitor_device_id')) {
    db.exec('ALTER TABLE topology_links ADD COLUMN monitor_device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL');
  }
  if (!hasColumn('topology_links', 'telemetry_enabled')) {
    db.exec('ALTER TABLE topology_links ADD COLUMN telemetry_enabled INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasColumn('topology_links', 'telemetry_agent')) {
    db.exec("ALTER TABLE topology_links ADD COLUMN telemetry_agent TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn('topology_links', 'telemetry_if_index')) {
    db.exec('ALTER TABLE topology_links ADD COLUMN telemetry_if_index INTEGER');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS topology_link_telemetry (
      link_id        TEXT PRIMARY KEY REFERENCES topology_links(id) ON DELETE CASCADE,
      diagram_id     INTEGER NOT NULL,
      sampled_at     INTEGER NOT NULL,
      counters_at    INTEGER,
      in_octets      TEXT,
      out_octets     TEXT,
      rx_bps         REAL,
      tx_bps         REAL,
      util_pct       REAL,
      capacity_mbps  REAL,
      oper_status    TEXT NOT NULL DEFAULT 'unknown',
      source         TEXT NOT NULL DEFAULT 'snmp',
      error          TEXT NOT NULL DEFAULT '',
      updated_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_topology_link_telemetry_diagram ON topology_link_telemetry(diagram_id);
  `);
}

/**
 * گام ۸: مسیرهای اصلی/پشتیبان دیاگرام (مرحلهٔ ۳).
 *
 * مسیر به‌صورت دنبالهٔ گره‌ها ذخیره می‌شود؛ لینک‌های هر پاره از همان گراف
 * استخراج می‌شوند تا با ویرایش/حذف لینک، مسیر خودبه‌خود «شکسته» علامت بخورد
 * و هیچ مسیر ساختگی ساخته نشود. `name` گروه اصلی و پشتیبان را به هم پیوند
 * می‌دهد؛ در هر گروه حداکثر یک مسیر اصلی و یک مسیر پشتیبان وجود دارد.
 */
function applyTopologyAnalysisMigration() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS topology_paths (
      id          TEXT PRIMARY KEY,
      diagram_id  INTEGER NOT NULL REFERENCES topology_diagrams(id) ON DELETE CASCADE,
      name        TEXT NOT NULL DEFAULT '',
      role        TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary', 'backup')),
      node_ids    TEXT NOT NULL DEFAULT '[]',
      link_ids    TEXT NOT NULL DEFAULT '[]',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_topology_paths_diagram ON topology_paths(diagram_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_topology_paths_group
      ON topology_paths(diagram_id, name, role);
  `);
}

/**
 * گام ۹: تاریخچهٔ ساختاریافتهٔ دیاگرام (مرحلهٔ ۴).
 *
 * هر نسخه Snapshot کامل و gzip‌شده است تا بازگردانی دقیق بدون بازسازی
 * زنجیره‌ای تغییرات ممکن باشد. `changes` اختلاف ساختاری با نسخهٔ قبلی را
 * برای مقایسه و نمایش نگه می‌دارد. Snapshot در BLOB ذخیره می‌شود تا صدها
 * نسخهٔ گراف بزرگ، پایگاه‌داده را بی‌دلیل متورم نکند.
 */
function applyTopologyHistoryMigration() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS topology_versions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      diagram_id    INTEGER NOT NULL REFERENCES topology_diagrams(id) ON DELETE CASCADE,
      revision      INTEGER NOT NULL,
      action        TEXT NOT NULL DEFAULT 'graph',
      label         TEXT NOT NULL DEFAULT '',
      author        TEXT NOT NULL DEFAULT '',
      summary       TEXT NOT NULL DEFAULT '{}',
      changes       TEXT NOT NULL DEFAULT '{}',
      snapshot      BLOB NOT NULL,
      size_bytes    INTEGER NOT NULL DEFAULT 0,
      restored_from INTEGER,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_topology_versions_diagram
      ON topology_versions(diagram_id, id DESC);
  `);
}

const MIGRATIONS = [
  { version: 1, name: 'baseline', up: () => {} },
  { version: 2, name: 'resilience', up: applyResilienceMigration },
  { version: 3, name: 'retention-policy', up: applyRetentionMigration },
  { version: 4, name: 'auth-security', up: applyAuthSecurityMigration },
  { version: 5, name: 'performance-indexes', up: applyPerformanceIndexesMigration },
  { version: 6, name: 'network-topology', up: applyTopologyMigration },
  { version: 7, name: 'topology-live', up: applyTopologyLiveMigration },
  { version: 8, name: 'topology-analysis', up: applyTopologyAnalysisMigration },
  { version: 9, name: 'topology-history', up: applyTopologyHistoryMigration },
];

/**
 * اجرای گام‌های مهاجرت تا SCHEMA_VERSION.
 * پایگاه‌دادهٔ موجود پیش از هر تغییر یک نسخهٔ فایلی می‌گیرد (backupBeforeMigration).
 */
export function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0
    )
  `);
  const current = currentSchemaVersion();
  const record = db.prepare('INSERT OR IGNORE INTO schema_migrations(version, name, applied_at, duration_ms) VALUES (?,?,?,?)');
  // گام‌هایی که پیش‌تر (نسخه‌های قبلی برنامه) اعمال شده‌اند فقط ثبت می‌شوند.
  for (const m of MIGRATIONS) {
    if (m.version <= current) record.run(m.version, m.name, Date.now(), 0);
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const startedAt = Date.now();
    try {
      db.transaction(
        () => {
          m.up();
          record.run(m.version, m.name, startedAt, Date.now() - startedAt);
          // نسخه از فهرست ثابت MIGRATIONS می‌آید و عدد صحیح اعتبارسنجی‌شده است.
          db.exec('PRAGMA user_version = ' + Number(m.version));
        },
        { label: `migration.v${m.version}` }
      );
      logEvent('info', 'db_migration_applied', {
        version: m.version,
        name: m.name,
        durationMs: Date.now() - startedAt,
      });
    } catch (e) {
      throw new DbError(
        DB_ERROR_CODES.MIGRATION_FAILED,
        `مهاجرت ساختار داده به نسخهٔ ${m.version} (${m.name}) ناموفق بود و کل گام برگشت داده شد: ${e.message}`,
        { status: 500, detail: { version: m.version, name: m.name } }
      );
    }
  }
  // ترمیم idempotent: نسخه‌های میانی که گام ۳ را کامل‌تر ثبت کرده‌اند نباید
  // ستون تازهٔ توقف را کم داشته باشند.
  if (!hasColumn('retention_state', 'stop_requested')) {
    db.exec('ALTER TABLE retention_state ADD COLUMN stop_requested INTEGER NOT NULL DEFAULT 0');
  }
}

const __schemaBefore = currentSchemaVersion();
if (DB_EXISTED && __schemaBefore < SCHEMA_VERSION) {
  backupBeforeMigration(__schemaBefore);
}
runMigrations();
try {
  // اگر همهٔ گام‌ها از قبل ثبت شده باشند، فقط نسخهٔ نهایی همگام می‌شود.
  if (currentSchemaVersion() !== SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
} catch (e) {
  log('warn', `ثبت نسخهٔ ساختار داده ناموفق بود: ${e.message}`);
}

/**
 * به‌روزرسانی آمار برنامه‌ریز پرس‌وجو (ANALYZE تقریبی).
 *
 * بدون آمار، تجمیع بازهٔ گزارش‌ها روی `idx_samples_ts` می‌رود و برای گروه‌بندی
 * یک TEMP B-TREE از صدها هزار ردیف می‌سازد؛ با آمار، برنامه‌ریز
 * `idx_samples_device_ts` را انتخاب می‌کند که هم مرتب‌سازی نمی‌خواهد و هم
 * ۲۰ تا ۲۵ درصد سریع‌تر است (اندازه‌گیری: ۷۸۰ → ۵۴۵ms برای گزارش ۷ روزهٔ
 * ۵٬۰۰۰ تجهیز / ۷۲۰ هزار نمونه).
 *
 * `PRAGMA optimize` کافی نیست: تجربه نشان داد آن فقط جدول‌های بی‌آمار را
 * تحلیل می‌کند و آمار کهنه را تازه نمی‌کند. `analysis_limit` اما تحلیل را به
 * حداکثر ۴۰۰ ردیف به ازای هر ایندکس محدود می‌کند؛ روی جدول یک‌میلیون‌ردیفی
 * حدود ۱۵ms طول می‌کشد و شمار ردیف‌ها دقیق و آمار توزیع تقریبی می‌ماند.
 *
 * @returns {boolean} آیا آمار به‌روزرسانی شد
 */
export function refreshQueryStats() {
  try {
    db.exec('PRAGMA analysis_limit = 400');
    db.exec('ANALYZE');
    return true;
  } catch (e) {
    // اشغال‌بودن پایگاه‌داده توسط موتور مانع تحلیل نمی‌شود؛ در اجراهای بعدی دوباره تلاش می‌شود.
    log('warn', `به‌روزرسانی آمار برنامه‌ریز پرس‌وجو ناموفق بود: ${e.message}`);
    return false;
  }
}

refreshQueryStats();
// نمونه‌ها با هر چرخهٔ موتور زیاد می‌شوند و آمار کهنه، برنامه‌ریز را به
// پیمایش کامل برمی‌گرداند؛ هر ۶ ساعت دوباره تحلیل می‌شود. تایمر unref است
// تا تست‌ها و اسکریپت‌ها را زنده نگه ندارد.
const queryStatsTimer = setInterval(() => refreshQueryStats(), 6 * 3600 * 1000);
queryStatsTimer.unref?.();

/* ------------------------------------------------------------------ */
/* سلامت پایگاه‌داده                                                  */
/* ------------------------------------------------------------------ */

const REQUIRED_TABLES = [
  'settings',
  'devices',
  'samples',
  'outages',
  'daily_stats',
  'alerts',
  'alert_rules',
  'maintenance_records',
  'maintenance_windows',
  'users',
  'sessions',
  'audit_log',
  'engine_log',
  'map_layers',
  'map_markers',
  'topology_sites',
  'topology_site_devices',
  'topology_diagrams',
  'topology_nodes',
  'topology_links',
  'topology_link_telemetry',
  'topology_paths',
  'topology_versions',
];

/**
 * بررسی سلامت پایگاه‌داده در زمان راه‌اندازی (و از مسیر /api/system/db/health).
 *
 * • quick_check: بررسی ساختار بدون خواندن کامل ب-تری (سریع، پیش‌فرض راه‌اندازی)
 * • integrity_check: بررسی کامل (هنگام بازبینی دستی یا NETWATCH_DB_CHECK=full)
 * • foreign_key_check: ارجاع‌های شکسته
 * • وجود جدول‌های الزامی
 *
 * @param {{full?: boolean}} [options]
 */
export function checkDatabaseHealth({ full = false } = {}) {
  const startedAt = Date.now();
  const report = {
    ok: true,
    mode: full ? 'integrity_check' : 'quick_check',
    checkedAt: startedAt,
    durationMs: 0,
    errors: [],
    tables: null,
    foreignKeyViolations: 0,
    ...db.walInfo(),
  };
  try {
    const pragma = full ? 'integrity_check' : 'quick_check';
    const rows = db.prepare(`PRAGMA ${pragma}`).all();
    const messages = rows.map((r) => String(r[pragma] ?? Object.values(r)[0] ?? '')).filter(Boolean);
    const bad = messages.filter((m) => m.toLowerCase() !== 'ok');
    if (bad.length) {
      report.ok = false;
      report.errors.push(...bad.slice(0, 20));
    }
    report.tables = db.prepare("SELECT COUNT(*) AS c FROM sqlite_schema WHERE type='table'").get().c;
    const present = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((r) => r.name));
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
    if (missing.length) {
      report.ok = false;
      report.errors.push(`جدول‌های غایب: ${missing.join(', ')}`);
    }
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    report.foreignKeyViolations = fk.length;
    if (fk.length) {
      report.ok = false;
      report.errors.push(`نقض کلید خارجی در ${fk.length} ردیف`);
    }
  } catch (e) {
    report.ok = false;
    const err = logDbError('db.health', e);
    report.errors.push(err.message);
  }
  report.durationMs = Date.now() - startedAt;
  return report;
}

/**
 * بررسی سلامت در راه‌اندازی. پیش‌فرض: در صورت خرابی، برنامه با پیام روشن
 * متوقف می‌شود (ادامهٔ کار با فایل خراب، داده را بیشتر تخریب می‌کند).
 * با NETWATCH_DB_CHECK=warn فقط هشدار داده می‌شود و NETWATCH_DB_CHECK=full
 * بررسی کامل انجام می‌شود.
 */
export function verifyDatabaseAtStartup() {
  const setting = String(process.env.NETWATCH_DB_CHECK || 'quick').toLowerCase();
  if (setting === 'off' || setting === '0') return { ok: true, skipped: true };
  const report = checkDatabaseHealth({ full: setting === 'full' });
  const summary = {
    ok: report.ok,
    mode: report.mode,
    durationMs: report.durationMs,
    journalMode: report.journalMode,
    synchronous: report.synchronous,
    walBytes: report.walBytes,
  };
  if (report.ok) {
    logEvent('info', 'db_health_ok', summary);
    console.log(
      `[db] سلامت پایگاه‌داده تأیید شد (${report.mode}، ${report.durationMs}ms، journal=${report.journalMode}، synchronous=${report.synchronous}).`
    );
    return report;
  }
  logEvent('error', 'db_health_failed', { ...summary, errors: report.errors });
  const message = `پایگاه‌داده ناسالم است: ${report.errors.join(' | ')}`;
  if (setting === 'warn') {
    console.error(`[db] هشدار: ${message}`);
    return report;
  }
  throw new DbError(DB_ERROR_CODES.CORRUPT, message, { detail: report, status: 500 });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** درج تنظیمات پیش‌فرض غایب؛ پس از Restore هم فراخوانی می‌شود */
export function ensureDefaultSettings() {
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  transaction(() => {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, JSON.stringify(v));
  }, { label: 'settings.defaults' });
}

ensureDefaultSettings();

/**
 * خواندن تنظیمات با اولویت: متغیر محیطی > پایگاه‌داده > مقدار پیش‌فرض.
 * متغیرهای محیطی برای استقرار (systemd/docker) هستند و در پایگاه‌داده ذخیره
 * نمی‌شوند؛ پس تغییرشان با ویرایش UI اثر ندارد و نیاز به راه‌اندازی مجدد دارد.
 */
export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      out[r.key] = r.value;
    }
  }
  return { ...out, ...envSettings };
}

/* ------------------------------------------------------------------ */
/* اعتبارسنجی تنظیمات                                                  */
/* ------------------------------------------------------------------ */

// مقدارهای غیرمنطقی تنظیمات می‌توانند برنامه را از کار بیندازند: بازه منفی يا صفر
// باعث می‌شود موتور بدون وقفه Ping بزند، max_workers بزرگ تعداد هم‌زمانی را منفجر
// می‌کند و retention_days منفی همهٔ رکوردهای تاریخی را حذف می‌کند. پس همهٔ مقادیر
// ورودی در همین یک نقطه مرزگذاری می‌شوند.
const NUM_RANGES = {
  ping_interval: [5, 86400],
  timeout_ms: [100, 30000],
  retries: [0, 5],
  packet_count: [1, 10],
  max_workers: [1, 512],
  latency_threshold: [0, 60000],
  loss_threshold: [0, 100],
  failures_for_offline: [1, 50],
  successes_for_online: [1, 50],
  retention_days: [1, 3650],
  tcp_port: [1, 65535],
  timezone_offset_minutes: [-720, 840],
  alert_cooldown: [0, 604800],
  alert_delay: [0, 86400],
  map_default_zoom: [0, 22],
  // حدود پایین، الزامات سیاست را تضمین می‌کنند: حسابرسی و قطعی‌ها حداقل ۳۶۵ روز.
  audit_retention_days: [365, 36500],
  samples_retention_days: [1, 3650],
  daily_stats_retention_days: [365, 36500],
  outages_retention_days: [365, 36500],
  alerts_retention_days: [30, 3650],
  engine_log_retention_days: [7, 3650],
  retention_interval_minutes: [15, 10080],
  retention_batch_size: [100, 50000],
  retention_max_rows_per_run: [1000, 5000000],
  backup_interval_hours: [1, 168],
  backup_keep: [1, 60],
  backup_daily_keep: [1, 60],
  backup_weekly_keep: [0, 52],
  checkpoint_interval_minutes: [1, 1440],
};

const ENUMS = {
  engine_mode: ['auto', 'icmp', 'tcp', 'simulate'],
  chart_default_range: ['15m', '1h', '6h', '24h', '7d', '30d', '90d'],
  calendar: ['jalali', 'gregorian'],
};

const BOOLEAN_KEYS = [
  'engine_enabled',
  'alerting_enabled',
  'suppression_enabled',
  'notify_browser',
  'map_show_labels',
  'backup_enabled',
  'backup_prune_enabled',
  'retention_enabled',
  'retention_legal_hold',
  'retention_prune_backups',
  // دسترسی‌های حساس Probe فقط با تنظیم صریح مدیر (پیش‌فرض خاموش)
  'probe_allow_link_local',
  'probe_allow_metadata',
  'probe_allow_transition',
];

/* ------------------------------------------------------------------ */
/* پیکربندی از طریق متغیرهای محیطی                                     */
/* ------------------------------------------------------------------ */

const ENV_SETTINGS = {
  NETWATCH_PING_INTERVAL: 'ping_interval',
  NETWATCH_TIMEOUT_MS: 'timeout_ms',
  NETWATCH_MAX_WORKERS: 'max_workers',
  NETWATCH_RETRIES: 'retries',
  NETWATCH_PACKET_COUNT: 'packet_count',
  NETWATCH_RETENTION_DAYS: 'retention_days',
  NETWATCH_ENGINE_MODE: 'engine_mode',
  NETWATCH_TCP_PORT: 'tcp_port',
};

const envSettings = {};
for (const [envKey, setting] of Object.entries(ENV_SETTINGS)) {
  const raw = process.env[envKey];
  if (raw === undefined || raw === '') continue;
  if (setting in ENUMS) {
    if (ENUMS[setting].includes(String(raw))) envSettings[setting] = String(raw);
    else console.error(`[config] مقدار ${envKey}=${raw} نامعتبر است و نادیده گرفته شد.`);
    continue;
  }
  const value = Number(String(raw).trim());
  const range = NUM_RANGES[setting];
  if (!Number.isFinite(value) || !range || value < range[0] || value > range[1]) {
    console.error(`[config] مقدار ${envKey}=${raw} نامعتبر است و نادیده گرفته شد.`);
    continue;
  }
  envSettings[setting] = value;
}
if (Object.keys(envSettings).length) {
  console.log(`[config] مقادیر ناشی از متغیر محیطی: ${Object.keys(envSettings).join(', ')}`);
}
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const WIDGET_KEYS = ['device_detail_widgets', 'dashboard_widgets'];
const WIDGET_SIZES = ['sm', 'md', 'lg', 'full'];

/** چیدمان ویجت‌ها را به شکل امن نرمال می‌کند: حداکثر ۴۰ ویجت، اندازهٔ مجاز و ترتیب عددی */
function cleanWidgets(value) {
  if (!Array.isArray(value)) return null;
  const out = value
    .slice(0, 40)
    .map((item, i) => ({
      id: String(item?.id ?? '').trim().slice(0, 48),
      visible: item?.visible === false || item?.visible === 0 || item?.visible === '0' ? 0 : 1,
      size: WIDGET_SIZES.includes(item?.size) ? item.size : 'md',
      order: Number.isFinite(Number(item?.order)) ? Math.max(0, Math.min(999, Number(item.order))) : i,
    }))
    .filter((w) => w.id);
  return out.length || value.length === 0 ? out : null;
}

function cleanStringList(value, maxItems = 30, maxLen = 60) {
  if (!Array.isArray(value)) return null;
  const out = value
    .map((v) => String(v ?? '').trim().slice(0, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
  return out.length ? out : null;
}

function coerceNumber(value, [min, max]) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/**
 * تنظیمات رسیده از کلاینت را اعتبارسنجی و مرزگذاری می‌کند.
 * @returns {{ clean: object, rejected: string[] }}
 */
export function sanitizeSettings(patch = {}) {
  const clean = {};
  const rejected = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    if (k in NUM_RANGES) {
      const n = coerceNumber(v, NUM_RANGES[k]);
      if (n == null) rejected.push(k);
      else clean[k] = n;
      continue;
    }
    if (k in ENUMS) {
      const s = String(v);
      if (ENUMS[k].includes(s)) clean[k] = s;
      else rejected.push(k);
      continue;
    }
    if (BOOLEAN_KEYS.includes(k)) {
      clean[k] = v === true || v === 1 || v === '1' || v === 'true';
      continue;
    }
    if (k === 'suppression_start' || k === 'suppression_end' || k === 'retention_run_time') {
      const s = String(v).trim();
      if (TIME_RE.test(s)) clean[k] = s;
      else rejected.push(k);
      continue;
    }
    if (k === 'probe_allowed_cidrs') {
      const list = normalizeCidrList(v);
      if (list && list.length) clean[k] = list;
      else rejected.push(k);
      continue;
    }
    if (k === 'site_name') {
      const s = String(v ?? '').trim().slice(0, 80);
      if (s) clean[k] = s;
      else rejected.push(k);
      continue;
    }
    if (k === 'repair_causes' || k === 'repair_actions') {
      const list = cleanStringList(v);
      if (list) clean[k] = list;
      else rejected.push(k);
      continue;
    }
    if (WIDGET_KEYS.includes(k)) {
      const widgets = cleanWidgets(v);
      if (widgets) clean[k] = widgets;
      else rejected.push(k);
      continue;
    }
    if (k === 'map_default_center') {
      const lat = Number(Array.isArray(v) ? v[0] : NaN);
      const lng = Number(Array.isArray(v) ? v[1] : NaN);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        clean[k] = [Number(lat.toFixed(5)), Number(lng.toFixed(5))];
      } else rejected.push(k);
      continue;
    }
    clean[k] = v;
  }
  return { clean, rejected };
}

export function setSettings(patch = {}) {
  const { clean, rejected } = sanitizeSettings(patch);
  if (rejected.length) log('warn', `مقدار نامعتبر برای تنظیمات نادیده گرفته شد: ${rejected.join(', ')}`);
  const stmt = db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  // همهٔ کلیدها با هم یا هیچ‌کدام؛ تنظیم نیمه‌اعمال‌شده می‌تواند موتور را در
  // وضعیت ناسازگار (مثلاً بازهٔ صفر + آستانهٔ جدید) رها کند.
  transaction(() => {
    for (const [k, v] of Object.entries(clean)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      stmt.run(k, JSON.stringify(v));
    }
  }, { label: 'settings.save' });
  return getSettings();
}

export function log(level, message, ts = Date.now()) {
  // پیام ممکن است نام تجهیز/فایل کاربر را داشته باشد؛ نویسه‌های کنترلی پیش از
  // ذخیره و لاگ حذف می‌شوند تا Log Injection رخ ندهد.
  const safeMessage = sanitizeLogText(String(message ?? ''), 2000);
  db.prepare('INSERT INTO engine_log(ts, level, message) VALUES (?, ?, ?)').run(ts, level, safeMessage);
  message = safeMessage;
  // خطاها و هشدارها علاوه بر جدول، به‌صورت ساختاریافته روی خروجی سرور هم می‌روند
  // تا سرویس‌های پایش بیرونی بتوانند بدون خواندن پایگاه‌داده آن‌ها را ببینند.
  if (level === 'error' || level === 'warn') logEvent(level, 'db_log', { message, ts });
}

/* ------------------------------------------------------------------ */
/* Demo seed                                                           */
/* ------------------------------------------------------------------ */

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED_GROUPS = [
  ['هسته شبکه', 'روترها و سوئیچ‌های مرکزی', '#2563eb'],
  ['سوئیچ‌های دسترسی', 'سوئیچ‌های لایه دسترسی ساختمان‌ها', '#0ea5e9'],
  ['فایروال و امنیت', 'تجهیزات امنیتی و VPN', '#7c3aed'],
  ['سرورها', 'سرورهای داخلی و مجازی', '#0d9488'],
  ['دوربین‌های نظارتی', 'NVR و دوربین‌های IP', '#db2777'],
  ['بی‌سیم و آنتن', 'اکسس‌پوینت‌ها و لینک‌های بی‌سیم', '#f59e0b'],
  ['زیرساخت برق', 'UPS و تجهیزات برق شبکه', '#64748b'],
];

const SEED_TAGS = [
  ['حیاتی', '#dc2626', 1, 'shield-alert'],
  ['ستون فقرات', '#2563eb', 1, 'network'],
  ['نقطه لبه', '#f59e0b', 1, 'radio'],
  ['پشت UPS', '#64748b', 0, 'battery-charging'],
  ['دارای پشتیبان', '#16a34a', 0, 'git-branch'],
  ['لینک اینترنت', '#0891b2', 1, 'globe'],
  ['در حال تعویض', '#a855f7', 1, 'wrench'],
];

const TYPE_BY_GROUP = {
  'هسته شبکه': ['روتر', 'سوئیچ'],
  'سوئیچ‌های دسترسی': ['سوئیچ'],
  'فایروال و امنیت': ['فایروال'],
  سرورها: ['سرور'],
  'دوربین‌های نظارتی': ['دوربین IP'],
  'بی‌سیم و آنتن': ['اکسس‌پوینت'],
  'زیرساخت برق': ['UPS شبکه'],
};

const PLACES = [
  ['تهران — مرکز داده اصلی', 'ساختمان A — طبقه ۱', 35.7005, 51.338],
  ['تهران — ساختمان اداری', 'ساختمان B — طبقه ۳', 35.7289, 51.3896],
  ['تهران — انبار مرکزی', 'ساختمان C', 35.662, 51.31],
  ['کرج — شعبه غرب', 'طبقه ۲', 35.8355, 50.9915],
  ['اصفهان — شعبه مرکزی', 'طبقه ۱', 32.6546, 51.668],
  ['مشهد — شعبه شرق', 'طبقه ۴', 36.2972, 59.6067],
  ['شیراز — دیتاسنتر پشتیبان', 'سالن B', 29.5918, 52.5837],
  ['تبریز — شعبه شمال‌غرب', 'طبقه ۲', 38.0805, 46.2919],
  ['اهواز — مرکز عملیات', 'طبقه ۱', 31.3183, 48.6706],
  ['قم — سایت مخابراتی', 'سایت', 34.6399, 50.8759],
  ['رشت — شعبه شمال', 'طبقه ۳', 37.2808, 49.5832],
  ['بندرعباس — پست فنی', 'پست', 27.1832, 56.2666],
];

const CAUSES = [
  'قطعی برق',
  'هنگ کردن سوئیچ',
  'اختلال در زیرساخت فیبر نوری',
  'مشکل شبکه',
  'سوختن یا خرابی تجهیز',
  'بازیابی خودکار پس از قطعی',
  'به‌روزرسانی نرم‌افزار',
];
// فهرست اقدام‌های پیش‌فرض تعمیرات در DEFAULT_SETTINGS (repair_actions) نگهداری می‌شود.

export function seedIfEmpty({ force = false } = {}) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM devices').get().c;
  if (count > 0 && !force) return false;

  const now = Date.now();
  const rnd = mulberry32(20261016);

  // اگر سرور و engine-cli هم‌زمان روی پایگاه‌دادهٔ تازه اجرا شوند، هر دو ممکن
  // است جدول را خالی ببینند و دادهٔ نمایشی را دوبار درج کنند (خطای UNIQUE روی
  // نام گروه). BEGIN IMMEDIATE نوشتن را از همان ابتدا قفل می‌کند و بررسی
  // دوبارهٔ داخل تراکنش، درج تکراری را ناممکن می‌کند.
  try {
    return transaction(
      () => {
    if (!force && db.prepare('SELECT COUNT(*) AS c FROM devices').get().c > 0) {
      return false;
    }
    if (force) {
      for (const t of [
        'alert_rules',
        'alerts',
        'maintenance_records',
        'maintenance_windows',
        'device_tags',
        'outages',
        'samples',
        'daily_stats',
        'devices',
        'groups',
        'tags',
        'map_markers',
        'marker_types',
        'map_layers',
        'engine_log',
      ]) {
        db.exec(`DELETE FROM ${assertSqlIdentifier(t, 'نام جدول')}`);
      }
    }

    // لایه‌های نقشه
    const layerStmt = db.prepare(
      'INSERT INTO map_layers(name, description, kind, file_name, min_zoom, max_zoom, attribution, visible, is_default, tile_count, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    );
    // شناسهٔ لایه به‌صورت پویا خوانده می‌شود؛ در بازنشانی داده‌ها (AUTOINCREMENT)
    // شناسه‌ها ادامه پیدا می‌کنند و یک مقدار ثابت به کلید بیرونی نامعتبر اشاره می‌کرد.
    const builtinLayerId = Number(
      layerStmt.run(
        'نقشه برداری پایه (آفلاین)',
        'لایه وکتور داخلی بدون نیاز به اینترنت',
        'builtin',
        null,
        3,
        18,
        'NetWatch',
        1,
        1,
        0,
        now
      ).lastInsertRowid
    );
    layerStmt.run('لایه شبکه — نقشه شهری', 'لایه نمونه؛ فایل .mbtiles خود را بارگذاری کنید', 'empty', null, 3, 18, '', 1, 0, 0, now);
    layerStmt.run('لایه زیرساخت ساختمان‌ها', 'لایه داخلی برای تجهیزات داخل ساختمان', 'empty', null, 5, 20, '', 0, 0, 0, now);

    const groups = new Map();
    const gStmt = db.prepare('INSERT INTO groups(name, description, color, created_at) VALUES (?,?,?,?)');
    for (const [name, desc, color] of SEED_GROUPS) {
      const res = gStmt.run(name, desc, color, now);
      groups.set(name, Number(res.lastInsertRowid));
    }

    const tags = new Map();
    const tStmt = db.prepare('INSERT INTO tags(name, color, show_on_map, icon, created_at) VALUES (?,?,?,?,?)');
    for (const [name, color, onMap, icon] of SEED_TAGS) {
      const res = tStmt.run(name, color, onMap, icon, now);
      tags.set(name, Number(res.lastInsertRowid));
    }

    // تولید تجهیزات
    const deviceStmt = db.prepare(`INSERT INTO devices
      (name, ip, hostname, device_type, group_id, location, building, rack, latitude, longitude, map_layer_id,
       vendor, model, serial, firmware, owner, notes, priority, enabled, monitoring_enabled, ping_interval,
       timeout_ms, packet_count, retries, latency_threshold, loss_threshold, status, uptime_pct, total_checks,
       created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    const vendors = ['Cisco', 'HPE Aruba', 'MikroTik', 'Huawei', 'Ubiquiti', 'TP-Link', 'Fortinet', 'Juniper'];
    const inserted = [];
    let seq = 0;

    for (const [groupName, groupId] of groups) {
      const types = TYPE_BY_GROUP[groupName];
      const howMany = groupName === 'سوئیچ‌های دسترسی' ? 14 : groupName === 'دوربین‌های نظارتی' ? 8 : 5;
      for (let i = 0; i < howMany; i++) {
        seq++;
        const place = PLACES[Math.floor(rnd() * PLACES.length)];
        const type = types[Math.floor(rnd() * types.length)];
        const vendor = vendors[Math.floor(rnd() * vendors.length)];
        const ip = `10.${10 + (seq % 4)}.${Math.floor(seq / 60) + 1}.${(seq % 250) + 2}`;
        const hasGeo = rnd() > 0.16;
        const lat = hasGeo ? place[2] + (rnd() - 0.5) * 0.035 : null;
        const lng = hasGeo ? place[3] + (rnd() - 0.5) * 0.05 : null;
        const disabled = rnd() > 0.94 ? 1 : 0;
        const priority = rnd() > 0.86 ? 'critical' : rnd() > 0.6 ? 'high' : rnd() > 0.25 ? 'normal' : 'low';
        const name = `${groupName.split(' ')[0]}-${String(seq).padStart(3, '0')} (${place[0].split('—')[0].trim()})`;

        const res = deviceStmt.run(
          name,
          ip,
          `${groupName.replace(/\s/g, '').toLowerCase()}-${seq}.local`,
          type,
          groupId,
          place[0],
          place[1],
          `R${Math.ceil(rnd() * 24)}-U${Math.ceil(rnd() * 40)}`,
          lat,
          lng,
          hasGeo ? builtinLayerId : null,
          vendor,
          `${vendor.split(' ')[0]}-${1000 + Math.ceil(rnd() * 8000)}`,
          `SN${Math.floor(rnd() * 1e9).toString(16).toUpperCase()}`,
          `${Math.ceil(rnd() * 9)}.${Math.ceil(rnd() * 9)}.${Math.ceil(rnd() * 9)}`,
          ['تیم شبکه', 'تیم زیرساخت', 'تیم امنیت'][Math.floor(rnd() * 3)],
          '',
          priority,
          disabled ? 0 : 1,
          disabled ? 0 : 1,
          rnd() > 0.7 ? [15, 30, 60, 120, 300][Math.floor(rnd() * 5)] : null,
          rnd() > 0.8 ? [800, 1000, 1500, 2000][Math.floor(rnd() * 4)] : null,
          rnd() > 0.8 ? [1, 3, 5][Math.floor(rnd() * 3)] : null,
          rnd() > 0.85 ? [0, 1, 2][Math.floor(rnd() * 3)] : null,
          rnd() > 0.85 ? [80, 120, 200][Math.floor(rnd() * 3)] : null,
          rnd() > 0.9 ? [5, 15, 25][Math.floor(rnd() * 3)] : null,
          disabled ? STATUS.UNKNOWN : STATUS.ONLINE,
          disabled ? 0 : 98 + rnd() * 2,
          0,
          now - Math.floor(rnd() * 200 * 86400000),
          now
        );
        const id = Number(res.lastInsertRowid);
        inserted.push({ id, group: groupName, type, ip, lat, lng, disabled, place });
      }
    }

    // تگ‌گذاری
    const attach = db.prepare('INSERT OR IGNORE INTO device_tags(device_id, tag_id) VALUES (?,?)');
    const tagNames = [...tags.keys()];
    for (const d of inserted) {
      const n = 1 + Math.floor(rnd() * 2);
      for (let i = 0; i < n; i++) {
        const t = tagNames[Math.floor(rnd() * tagNames.length)];
        attach.run(d.id, tags.get(t));
      }
      if (d.group === 'هسته شبکه') attach.run(d.id, tags.get('ستون فقرات'));
      if (d.type === 'فایروال') attach.run(d.id, tags.get('حیاتی'));
      if (d.group === 'بی‌سیم و آنتن') attach.run(d.id, tags.get('نقطه لبه'));
    }

    // پنجره تعمیرات پیش‌فرض (سراسری)
    db.prepare(
      'INSERT INTO maintenance_windows(device_id, title, days, start_time, end_time, enabled, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(null, 'پنجره تعمیرات شبانه', '0,1,2,3,4,5,6', '01:00', '03:00', 0, now);

    // انواع «علامت» روی نقشه و چند جانمایی نمونه
    const mtypeStmt = db.prepare('INSERT INTO marker_types(name, color, icon, description, created_at) VALUES (?,?,?,?,?)');
    const mtypeIds = {};
    for (const [mtName, mtColor, mtIcon, mtDesc] of [
      ['تجهیز در حال نصب', '#0ea5e9', 'hammer', 'تجهیزاتی که در حال نصب یا راه‌اندازی هستند'],
      ['نقطه بازدید دوره‌ای', '#16a34a', 'eye', 'نقاطی که نیاز به بازدید دوره‌ای دارند'],
      ['محل حادثه و خرابی', '#dc2626', 'triangle-alert', 'محل وقوع خرابی یا حادثه'],
      ['نقطه توسعه آینده', '#7c3aed', 'circle-plus', 'مکان‌های پیش‌بینی‌شده برای توسعه'],
    ]) {
      mtypeIds[mtName] = Number(mtypeStmt.run(mtName, mtColor, mtIcon, mtDesc, now).lastInsertRowid);
    }
    const markerStmt = db.prepare(
      'INSERT INTO map_markers(type_id, name, latitude, longitude, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
    );
    for (const [mkType, mkName, mkLat, mkLng] of [
      ['تجهیز در حال نصب', 'نصب سوئیچ — ساختمان اداری', 35.7289, 51.3896],
      ['تجهیز در حال نصب', 'نصب اکسس‌پوینت — طبقه ۳', 35.7312, 51.4021],
      ['تجهیز در حال نصب', 'نصب دوربین — ورودی شرقی', 35.7021, 51.4243],
      ['تجهیز در حال نصب', 'نصب UPS — اتاق سرور', 35.7108, 51.3588],
      ['تجهیز در حال نصب', 'نصب لینک بی‌سیم — پشت‌بام', 35.6962, 51.4015],
      ['محل حادثه و خرابی', 'خرابی فیبر — مسیر شمالی', 35.7402, 51.3711],
      ['نقطه بازدید دوره‌ای', 'بازدید ماهانه — شعبه غرب', 35.8355, 50.9915],
    ]) {
      markerStmt.run(mtypeIds[mkType], mkName, mkLat, mkLng, '', now, now);
    }

    // قوانین هشدار پیش‌فرض
    const ruleStmt = db.prepare(
      'INSERT INTO alert_rules(name, enabled, metric, comparator, threshold, duration_sec, severity, scope_group_id, cooldown_sec, apply_to_unmon, silent, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    ruleStmt.run('قطع دسترسی تجهیز', 1, 'offline', 'gte', 1, 0, 'critical', null, 600, 1, 0, now);
    ruleStmt.run('تأخیر بیش از حد مجاز', 1, 'latency', 'gte', 150, 60, 'warning', null, 900, 0, 0, now);
    ruleStmt.run('افت شدید بسته (Packet Loss)', 1, 'loss', 'gte', 10, 0, 'warning', null, 600, 0, 0, now);
    ruleStmt.run('بازگشت تجهیز به وضعیت عادی', 1, 'recovery', 'lte', 1, 0, 'info', null, 0, 0, 0, now);
    ruleStmt.run('تأخیر بحرانی ستون فقرات', 1, 'latency', 'gte', 90, 120, 'critical', groups.get('هسته شبکه'), 1200, 0, 1, now);

    // ---------------- تولید تاریخچه ۷ روزه ----------------
    const HOURS = 24 * 7;
    const stepMs = 5 * 60 * 1000; // نمونه هر ۵ دقیقه
    const totalSlots = HOURS * 12;
    const startTs = Math.floor((now - HOURS * 3600000) / stepMs) * stepMs;

    const sampleStmt = db.prepare(
      'INSERT INTO samples(device_id, ts, rtt_ms, packets_sent, packets_recv, loss_pct, status, ok, mode) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    const outageStmt = db.prepare(
      'INSERT INTO outages(device_id, started_at, ended_at, duration_sec, cause, detail, lat, lng, open) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    const daily = new Map(); // key deviceId|day
    const bump = (deviceId, ts, ok, rtt, loss) => {
      const day = new Date(ts).toISOString().slice(0, 10);
      const key = `${deviceId}|${day}`;
      let row = daily.get(key);
      if (!row) {
        row = { deviceId, day, checks: 0, failed: 0, sum: 0, n: 0, max: 0, loss: 0, outages: 0, downtime: 0 };
        daily.set(key, row);
      }
      row.checks++;
      if (!ok) row.failed++;
      if (rtt != null) {
        row.sum += rtt;
        row.n++;
        row.max = Math.max(row.max, rtt);
      }
      row.loss += ok ? 0 : 100;
      return row;
    };

    const offlineNow = new Set();
    const warningNow = new Set();
    const outageCounters = new Map();

    const active = inserted.filter((d) => !d.disabled);
    // انتخاب تعدادی تجهیز برای وضعیت فعلی
    const shuffled = [...active].sort(() => rnd() - 0.5);
    const currentOffline = new Set(shuffled.slice(0, 4).map((d) => d.id));
    const currentWarning = new Set(shuffled.slice(4, 13).map((d) => d.id));

    for (const d of inserted) {
      if (d.disabled) continue;
      const baseLat = 3 + rnd() * 45;
      const jitter = 2 + rnd() * 18;
      const lossiness = rnd() > 0.78 ? 0.25 + rnd() * 0.5 : 0.02;
      const flapProne = rnd() > 0.7;

      // ساخت پنجره‌های قطعی تصادفی
      const windows = [];
      const nOut = flapProne ? 3 + Math.floor(rnd() * 4) : Math.floor(rnd() * 3);
      for (let i = 0; i < nOut; i++) {
        const startSlot = Math.floor(rnd() * (totalSlots - 20));
        const len = 1 + Math.floor(rnd() * (flapProne ? 9 : 4));
        windows.push([startSlot, startSlot + len]);
      }
      // قطعی جاری برای تجهیزات آفلاین
      if (currentOffline.has(d.id)) windows.push([totalSlots - 3, totalSlots + 1]);

      let prevStatus = STATUS.ONLINE;
      let openOutageId = null;

      for (let s = 0; s < totalSlots; s++) {
        const ts = startTs + s * stepMs;
        const inWindow = windows.find(([a, b]) => s >= a && s < b);
        let ok = true;
        let loss = 0;

        if (inWindow) {
          ok = false;
          loss = 100;
        } else if (rnd() < lossiness * 0.25) {
          loss = 30 + rnd() * 70;
          ok = rnd() > 0.5;
        }

        const rtt = ok ? Math.max(0.4, baseLat + (rnd() - 0.5) * jitter * 2 + (s % 288) * 0.004) : null;
        const status = ok ? (rtt > 150 ? STATUS.WARNING : STATUS.ONLINE) : STATUS.OFFLINE;
        // تاریخچهٔ دادهٔ نمایشی هم «شبیه‌سازی‌شده» است؛ با همین برچسب ثبت می‌شود
        // تا در UI/API از نمونه‌های واقعی (icmp/tcp) قابل تشخیص باشد.
        sampleStmt.run(d.id, ts, rtt == null ? null : Number(rtt.toFixed(2)), 3, ok ? (loss ? 2 : 3) : 0, Number(loss.toFixed(1)), status, ok ? 1 : 0, 'simulate');
        const row = bump(d.id, ts, ok, rtt, loss);

        if (status === STATUS.OFFLINE && prevStatus !== STATUS.OFFLINE) {
          const cause = CAUSES[Math.floor(rnd() * CAUSES.length)];
          const res = outageStmt.run(d.id, ts, null, null, cause, '', d.lat, d.lng, 1);
          openOutageId = Number(res.lastInsertRowid);
          row.outages++;
          outageCounters.set(d.id, (outageCounters.get(d.id) || 0) + 1);
        } else if (status !== STATUS.OFFLINE && prevStatus === STATUS.OFFLINE && openOutageId) {
          const dur = Math.max(60, Math.round((ts - (startTs + (inWindow ? inWindow[0] : s) * stepMs)) / 1000));
          db.prepare('UPDATE outages SET ended_at=?, duration_sec=?, open=0 WHERE id=?').run(ts, dur, openOutageId);
          const key = `${d.id}|${new Date(ts).toISOString().slice(0, 10)}`;
          const r2 = daily.get(key);
          if (r2) r2.downtime += dur;
          openOutageId = null;
        } else if (status === STATUS.OFFLINE && openOutageId) {
          const key = `${d.id}|${new Date(ts).toISOString().slice(0, 10)}`;
          const r2 = daily.get(key);
          if (r2) r2.downtime += stepMs / 1000;
        }
        prevStatus = status;
      }
      if (currentOffline.has(d.id)) offlineNow.add(d.id);
      else if (currentWarning.has(d.id) || baseLat > 90) warningNow.add(d.id);
    }

    // آمار روزانه
    const dailyStmt = db.prepare(
      'INSERT INTO daily_stats(device_id, day, checks, failed, avg_rtt, max_rtt, loss_pct, outages, downtime_sec, uptime_pct) VALUES (?,?,?,?,?,?,?,?,?,?) ' +
        'ON CONFLICT(device_id, day) DO UPDATE SET checks=excluded.checks, failed=excluded.failed, avg_rtt=excluded.avg_rtt, max_rtt=excluded.max_rtt, loss_pct=excluded.loss_pct, outages=excluded.outages, downtime_sec=excluded.downtime_sec, uptime_pct=excluded.uptime_pct'
    );
    for (const row of daily.values()) {
      const avg = row.n ? row.sum / row.n : null;
      const uptime = row.checks ? ((row.checks - row.failed) / row.checks) * 100 : null;
      dailyStmt.run(
        row.deviceId,
        row.day,
        row.checks,
        row.failed,
        avg == null ? null : Number(avg.toFixed(2)),
        Number(row.max.toFixed(2)),
        Number((row.loss / row.checks).toFixed(2)),
        row.outages,
        Math.round(row.downtime),
        uptime == null ? null : Number(uptime.toFixed(2))
      );
    }

    // یکسان‌سازی: تنها تجهیزات در حال قطعی حق دارند قطعی «باز» داشته باشند و حداکثر یکی
    const offlineIds = [...currentOffline];
    db.prepare(
      `UPDATE outages SET ended_at = started_at + 60000, duration_sec = 60, open = 0
       WHERE open = 1 AND device_id NOT IN (${offlineIds.length ? offlineIds.map(() => '?').join(',') : 'NULL'})`
    ).run(...offlineIds);
    for (const id of offlineIds) {
      db.prepare(
        `UPDATE outages SET ended_at = started_at + 60000, duration_sec = 60, open = 0
         WHERE device_id = ? AND open = 1 AND id != (SELECT id FROM outages WHERE device_id = ? AND open = 1 ORDER BY started_at DESC LIMIT 1)`
      ).run(id, id);
    }

    // وضعیت فعلی و شاخص‌های تجمیعی
    const aggStmt = db.prepare(`SELECT
        COUNT(*) AS checks,
        SUM(ok) AS ok_count,
        MIN(rtt_ms) AS min_rtt,
        MAX(rtt_ms) AS max_rtt,
        AVG(rtt_ms) AS avg_rtt,
        AVG(loss_pct) AS avg_loss,
        MAX(ts) AS last_ts
      FROM samples WHERE device_id = ?`);
    const lastSample = db.prepare(
      'SELECT rtt_ms, loss_pct, status, ts FROM samples WHERE device_id = ? ORDER BY ts DESC LIMIT 1'
    );
    const lastOutage = db.prepare('SELECT started_at FROM outages WHERE device_id = ? ORDER BY started_at DESC LIMIT 1');
    const openOutage = db.prepare('SELECT id, started_at FROM outages WHERE device_id = ? AND open = 1 ORDER BY started_at DESC LIMIT 1');
    const successCount = db.prepare('SELECT COUNT(*) AS c FROM samples WHERE device_id=? AND ok=1');
    const failCount = db.prepare('SELECT COUNT(*) AS c FROM samples WHERE device_id=? AND ok=0');

    for (const d of inserted) {
      if (d.disabled) continue;
      const a = aggStmt.get(d.id);
      const last = lastSample.get(d.id);
      const isOffline = currentOffline.has(d.id) || (last && last.status === STATUS.OFFLINE);
      const isWarning = !isOffline && (warningNow.has(d.id) || (last && last.status === STATUS.WARNING));
      const status = isOffline ? STATUS.OFFLINE : isWarning ? STATUS.WARNING : STATUS.ONLINE;
      const uptime = a.checks ? ((a.ok_count || 0) / a.checks) * 100 : 100;
      const oo = isOffline ? openOutage.get(d.id) : null;
      const lo = lastOutage.get(d.id);

      db.prepare(`UPDATE devices SET
          status=?, status_reason=?, last_check_at=?, last_status_change_at=?,
          last_rtt_ms=?, min_rtt_ms=?, max_rtt_ms=?, avg_rtt_ms=?, loss_pct=?,
          success_count=?, fail_count=?, total_checks=?,
          consecutive_failures=?, consecutive_successes=?,
          uptime_pct=?, last_outage_at=?, current_outage_id=?, current_outage_started_at=?
        WHERE id=?`).run(
        status,
        isOffline ? 'عدم پاسخ به Ping' : isWarning ? 'تأخیر یا افت بسته بیش از حد مجاز' : '',
        last ? last.ts : null,
        now - Math.floor(rnd() * 4 * 3600000),
        last ? last.rtt_ms : null,
        a.min_rtt ?? null,
        a.max_rtt ?? null,
        a.avg_rtt == null ? null : Number(a.avg_rtt.toFixed(2)),
        last ? last.loss_pct : 0,
        successCount.get(d.id).c,
        failCount.get(d.id).c,
        a.checks,
        isOffline ? 3 + Math.floor(rnd() * 12) : 0,
        isOffline ? 0 : 5 + Math.floor(rnd() * 60),
        Number(uptime.toFixed(2)),
        lo ? lo.started_at : null,
        oo ? oo.id : null,
        oo ? oo.started_at : null,
        d.id
      );
    }

    // سوابق تعمیرات به‌صورت خودکار ساخته نمی‌شوند؛ این بخش فقط شامل رکوردهایی است
    // که کاربر خودش ثبت می‌کند. بنابراین داده‌های نمونه هیچ سابقهٔ تعمیراتی ندارند.

    // هشدارهای نمونه
    const alertStmt = db.prepare(
      'INSERT INTO alerts(device_id, rule_id, severity, kind, title, message, value, created_at, status, acknowledged_at, acknowledged_by, resolved_at, notified, duplicate_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    const recentOutages = db.prepare(
      'SELECT o.id, o.device_id, o.started_at, o.ended_at, o.cause, d.name, d.ip FROM outages o JOIN devices d ON d.id=o.device_id ORDER BY o.started_at DESC LIMIT 40'
    ).all();
    recentOutages.forEach((o, idx) => {
      const sev = o.cause.includes('خرابی') || o.cause.includes('برق') ? 'critical' : 'warning';
      const status = idx < 3 ? 'active' : idx % 5 === 0 ? 'acknowledged' : 'resolved';
      alertStmt.run(
        o.device_id,
        null,
        sev,
        'offline',
        `قطع ارتباط — ${o.name}`,
        `تجهیز ${o.name} (${o.ip}) در ساعت ${new Date(o.started_at).toLocaleString('fa-IR')} پاسخ نداد. علت ثبت‌شده: ${o.cause}`,
        null,
        o.started_at,
        status,
        status !== 'active' ? o.started_at + 300000 : null,
        status !== 'active' ? 'مدیر شبکه' : null,
        o.ended_at || (status === 'resolved' ? o.started_at + 600000 : null),
        1,
        `offline:${o.device_id}:${o.started_at}`
      );
      if (o.ended_at) {
        alertStmt.run(
          o.device_id,
          null,
          'info',
          'recovery',
          `بازگشت به حالت عادی — ${o.name}`,
          `تجهیز ${o.name} مجدداً در دسترس قرار گرفت.`,
          null,
          o.ended_at,
          'resolved',
          null,
          null,
          o.ended_at,
          1,
          `recovery:${o.device_id}:${o.ended_at}`
        );
      }
    });

    db.prepare('INSERT INTO engine_log(ts, level, message) VALUES (?,?,?)').run(
      now,
      'info',
      'داده‌های نمونه اولیه بارگذاری شد (۷ روز تاریخچه).'
    );
        return true;
      },
      { immediate: true, label: 'seed' }
    );
  } catch (e) {
    // رقابت دو فرآیند روی پایگاه‌دادهٔ تازه: نمونهٔ دیگر زودتر نوشته است.
    if (/busy|locked/i.test(String(e.message))) return false;
    throw e;
  }
}

if (process.argv[1] && process.argv[1].endsWith('db.js')) {
  const created = seedIfEmpty({ force: process.argv.includes('--force') });
  console.log(created ? 'seed: done' : 'seed: skipped (already has devices)');
  console.log('db:', DB_PATH);
}
