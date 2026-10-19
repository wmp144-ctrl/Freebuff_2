/**
 * NetWatch — مدیریت استاندارد خطاهای پایگاه‌داده
 * ----------------------------------------------------------------
 * همهٔ خطاهای SQLite در یک نقطه دسته‌بندی و با جزئیات ساختاریافته ثبت
 * می‌شوند. هدف دو چیز است:
 *   ۱) کاربر/مسیر API پیام قابل‌فهم بگیرد (نه «Provided value cannot be bound…»).
 *   ۲) لاگ شامل کد، دستور و منشأ باشد تا عیب‌یابی بدون بازتولید ممکن شود.
 *
 * این ماژول عمداً به db.js وابسته نیست (db.js خودش از آن استفاده می‌کند)؛
 * ثبت فقط از طریق logger.mjs انجام می‌شود تا حلقهٔ بازگشتی ساخته نشود.
 */
import { logEvent } from './logger.mjs';

export const DB_ERROR_CODES = Object.freeze({
  BUSY: 'DB_BUSY',
  FULL: 'DB_DISK_FULL',
  CORRUPT: 'DB_CORRUPT',
  CONSTRAINT: 'DB_CONSTRAINT',
  BINDING: 'DB_BINDING',
  READONLY: 'DB_READONLY',
  IOERR: 'DB_IO',
  BACKUP_INVALID: 'DB_BACKUP_INVALID',
  MIGRATION_FAILED: 'DB_MIGRATION_FAILED',
  NOT_OPEN: 'DB_NOT_OPEN',
  UNKNOWN: 'DB_UNKNOWN',
});

/** جدول نگاشت پیام‌های SQLite به کد داخلی. پیام‌ها پایدارتر از شماره‌ها هستند. */
const MESSAGE_RULES = [
  [/(database is locked|database table is locked|SQLITE_BUSY)/i, DB_ERROR_CODES.BUSY],
  [/(database or disk is full|SQLITE_FULL|disk full)/i, DB_ERROR_CODES.FULL],
  [/(database disk image is malformed|SQLITE_CORRUPT|file is not a database|integrity check failed)/i, DB_ERROR_CODES.CORRUPT],
  [/(constraint failed|SQLITE_CONSTRAINT|UNIQUE constraint|FOREIGN KEY constraint|NOT NULL constraint|CHECK constraint)/i, DB_ERROR_CODES.CONSTRAINT],
  [/(cannot be bound|Invalid argument|binding|SQLITE_MISMATCH)/i, DB_ERROR_CODES.BINDING],
  [/(readonly database|attempt to write a readonly|SQLITE_READONLY)/i, DB_ERROR_CODES.READONLY],
  [/(disk I\/O error|SQLITE_IOERR|SQLITE_IO)/i, DB_ERROR_CODES.IOERR],
];

export class DbError extends Error {
  /**
   * @param {string} code کد داخلی (DB_ERROR_CODES)
   * @param {string} message پیام قابل‌نمایش
   * @param {{cause?: unknown, sql?: string, detail?: object, status?: number}} [meta]
   */
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'DbError';
    this.code = code;
    this.sql = meta.sql || null;
    this.detail = meta.detail || null;
    this.status = meta.status || 500;
    if (meta.cause) this.cause = meta.cause;
  }
}

/** خطای کمبود فضای دیسک؛ پیش از هر نوشتن سنگین بررسی می‌شود. */
export class DiskSpaceError extends DbError {
  constructor(message, meta = {}) {
    super(DB_ERROR_CODES.FULL, message, { ...meta, status: 507 });
    this.name = 'DiskSpaceError';
  }
}

export function isBusyError(err) {
  return classifyDbError(err) === DB_ERROR_CODES.BUSY;
}

export function isDiskFullError(err) {
  return classifyDbError(err) === DB_ERROR_CODES.FULL;
}

/** دسته‌بندی خطا بر اساس کد/پیام SQLite یا خطای دستی‌ساختهٔ خودمان */
export function classifyDbError(err) {
  if (!err) return DB_ERROR_CODES.UNKNOWN;
  if (err instanceof DbError) return err.code;
  const text = `${err.code || ''} ${err.errstr || ''} ${err.message || ''}`;
  for (const [re, code] of MESSAGE_RULES) if (re.test(text)) return code;
  if (err.errcode === 5 || err.errcode === 6) return DB_ERROR_CODES.BUSY;
  if (err.errcode === 13) return DB_ERROR_CODES.FULL;
  if (err.errcode === 11 || err.errcode === 26) return DB_ERROR_CODES.CORRUPT;
  if (typeof err.errcode === 'number' && (err.errcode & 0xff) === 19) return DB_ERROR_CODES.CONSTRAINT;
  return DB_ERROR_CODES.UNKNOWN;
}

/** پیام فارسی استاندارد برای هر دسته؛ پیام‌های Constraint عیناً برگردانده می‌شوند */
const PUBLIC_MESSAGES = {
  [DB_ERROR_CODES.BUSY]: 'پایگاه‌داده مشغول است؛ لطفاً چند لحظه بعد دوباره تلاش کنید.',
  [DB_ERROR_CODES.FULL]: 'فضای ذخیره‌سازی کافی نیست؛ عملیات انجام نشد و تغییری ثبت نگردید.',
  [DB_ERROR_CODES.CORRUPT]: 'فایل پایگاه‌داده آسیب دیده است؛ از نسخهٔ پشتیبان بازیابی کنید.',
  [DB_ERROR_CODES.BINDING]: 'دادهٔ نامعتبر برای ذخیره در پایگاه‌داده ارسال شده است.',
  [DB_ERROR_CODES.READONLY]: 'پایگاه‌داده در حالت فقط‌خواندنی است.',
  [DB_ERROR_CODES.MIGRATION_FAILED]: 'مهاجرت ساختار داده ناموفق بود؛ تغییرات برگشت داده شد.',
  [DB_ERROR_CODES.IOERR]: 'خطای خواندن/نوشتن دیسک رخ داد.',
  [DB_ERROR_CODES.NOT_OPEN]: 'اتصال پایگاه‌داده بسته است.',
  [DB_ERROR_CODES.UNKNOWN]: 'خطای داخلی پایگاه‌داده رخ داد.',
};

export function publicDbMessage(err) {
  const code = classifyDbError(err);
  if (err instanceof DbError && err.status && err.status < 500) return err.message;
  return PUBLIC_MESSAGES[code] || PUBLIC_MESSAGES[DB_ERROR_CODES.UNKNOWN];
}

/** پاک‌سازی SQL برای لاگ: مقدارهای متنی حذف می‌شوند تا دادهٔ کاربر در لاگ نیفتد */
function compactSql(sql) {
  if (!sql) return undefined;
  const s = String(sql).replace(/\s+/g, ' ').trim();
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/**
 * ثبت استاندارد خطای پایگاه‌داده.
 * @param {string} context محل رخداد (مثلاً 'engine.record' یا 'backup.create')
 * @param {unknown} err خطای اصلی
 * @param {{sql?: string, extra?: object}} [meta]
 * @returns {DbError} خطای استانداردشده برای پرتاب/پاسخ
 */
export function logDbError(context, err, meta = {}) {
  const code = classifyDbError(err);
  if (code === DB_ERROR_CODES.UNKNOWN && !meta.force) return err;
  const detail = {
    context,
    code,
    message: err?.message || String(err),
    errcode: err?.errcode ?? null,
    errstr: err?.errstr ?? null,
    sql: compactSql(meta.sql || err?.sql),
    ...(meta.extra || {}),
  };
  try {
    logEvent(code === DB_ERROR_CODES.CONSTRAINT || code === DB_ERROR_CODES.BINDING ? 'warn' : 'error', 'db_error', detail);
  } catch {
    /* ثبت لاگ هرگز نباید مسیر اصلی را بشکند */
  }
  if (err instanceof DbError) return err;
  if (code === DB_ERROR_CODES.UNKNOWN) {
    // خطای غیر-SQLite (مثلاً اعتبارسنجی کسب‌وکار) نباید به‌عنوان خطای پایگاه‌داده
    // برچسب بخورد؛ همان خطای اصلی برای تصمیم مسیر برگردانده می‌شود.
    return err;
  }
  const constraint = code === DB_ERROR_CODES.CONSTRAINT;
  const message = constraint ? `داده با قید پایگاه‌داده سازگار نیست: ${err?.message || ''}` : PUBLIC_MESSAGES[code];
  return new DbError(code, message, { cause: err, detail, sql: meta.sql, status: constraint ? 400 : 500 });
}
