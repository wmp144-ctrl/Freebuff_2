/**
 * NetWatch — ایمنی داده و SQL برای لایهٔ پایگاه‌داده
 * ----------------------------------------------------------------
 * • نرمال‌سازی مقادیر Bind: Boolean → 0/1، undefined → NULL، NaN/Infinity → NULL،
 *   Date → epoch ms. SQLite این مقادیر را یا نمی‌پذیرد (undefined) یا بی‌صدا به
 *   NULL تبدیل می‌کند (NaN) که همان «رکورد ناقص» است.
 * • بررسی فضای دیسک پیش از نوشتن سنگین تا عملیات نیمه‌کاره ساخته نشود.
 * • اعتبارسنجی شناسه‌های SQL که ناچاراً در متن دستور قرار می‌گیرند (مثل نام جدول
 *   در مهاجرت‌ها) تا هرگز از ورودی کاربر ساخته نشوند.
 */
import fs from 'node:fs';
import { DbError, DiskSpaceError, DB_ERROR_CODES } from './db-errors.js';

/** حداقل فضای آزاد لازم برای ادامهٔ کار (پیش‌فرض ۶۴ مگابایت) */
export const MIN_FREE_BYTES = (() => {
  const n = Number(process.env.NETWATCH_MIN_FREE_BYTES);
  return Number.isFinite(n) && n >= 0 ? n : 64 * 1024 * 1024;
})();

function bindError(sql, value) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  return new DbError(DB_ERROR_CODES.BINDING, `مقدار ${type} را نمی‌توان به SQLite بایند کرد.`, {
    sql,
    status: 400,
    detail: { type },
  });
}

/**
 * یک مقدار را به شکل قابل‌بایند در SQLite تبدیل می‌کند.
 * مقادیر پشتیبانی‌شده: null، string، number متناهی، bigint، boolean، Date، Buffer.
 * هر چیز دیگری (شیء/آرایه/تابع) خطای واضح Binding می‌دهد تا بی‌صدا خراب ذخیره نشود.
 *
 * @param {unknown} value
 * @param {string} [sql] برای پیام خطا
 * @param {number} [index] شمارهٔ پارامتر برای پیام خطا
 */
export function normalizeBindValue(value, sql = '', index = 0) {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
      return value;
    case 'boolean':
      // SQLite نوع BOOLEAN ندارد؛ ذخیرهٔ 0/1 تنها شکل سازگار است.
      return value ? 1 : 0;
    case 'number':
      // NaN و ±Infinity در SQLite به NULL تبدیل می‌شوند و قیدهای NOT NULL را
      // نقض می‌کنند (یا بدتر، مقدارِ معنادار را پاک می‌کنند). صریحاً NULL می‌شود
      // تا قید پایگاه‌داده جلوی ثبت رکورد ناقص را بگیرد.
      return Number.isFinite(value) ? value : null;
    case 'bigint':
      // INTEGERهای SQLite می‌توانند ۶۴بیتی باشند، اما درایور node:sqlite نتیجه را
      // به number تبدیل می‌کند و برای مقادیر بیرون از محدودهٔ امن خطای خواندن
      // می‌دهد. پس همان‌جا مقدار امن را به number و مقدار بزرگ را به خطای روشن
      // تبدیل می‌کنیم تا در زمان نوشتن معلوم باشد، نه در زمان خواندن.
      if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
      throw new DbError(DB_ERROR_CODES.BINDING, 'عدد صحیح بزرگ‌تر از محدودهٔ امن JavaScript را نمی‌توان در پایگاه‌داده ذخیره کرد.', {
        sql,
        status: 400,
        detail: { type: 'bigint' },
      });
    case 'undefined':
      return null;
    case 'object':
      if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
      if (Buffer.isBuffer(value)) return value;
      if (value instanceof Uint8Array) return value;
      throw bindError(sql, value);
    default:
      throw bindError(sql, value);
  }
}

/**
 * نرمال‌سازی همهٔ پارامترهای یک دستور. پارامترهای نام‌دار در این پروژه استفاده
 * نمی‌شوند؛ اگر شیء تکی داده شود خطای روشن می‌دهد تا به‌جای «binding failed»
 * معلوم باشد چه چیزی اشتباه است.
 */
export function normalizeBindParams(args, sql = '') {
  const list = Array.isArray(args) ? args : [args];
  if (list.length === 1 && list[0] && typeof list[0] === 'object' && !Array.isArray(list[0]) && !Buffer.isBuffer(list[0]) && !(list[0] instanceof Uint8Array) && !(list[0] instanceof Date)) {
    throw new DbError(DB_ERROR_CODES.BINDING, 'پارامترهای نام‌دار پشتیبانی نمی‌شوند؛ از پارامترهای مکانی (?) استفاده کنید.', { sql, status: 400 });
  }
  return list.map((v, i) => normalizeBindValue(v, sql, i));
}

/** فقط شناسه‌های سادهٔ SQL (نام جدول/ستون)؛ برای دستورهایی که پارامتربردار نیستند */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function assertSqlIdentifier(name, label = 'شناسه') {
  if (!IDENT_RE.test(String(name ?? ''))) {
    throw new DbError(DB_ERROR_CODES.BINDING, `${label} نامعتبر است: ${String(name).slice(0, 40)}`, { status: 400 });
  }
  return String(name);
}

/** جلوگیری از قرارگرفتن مقدار متنی خام در SQL (فقط برای بازبینی در تست‌ها) */
export function looksLikeInjection(sql) {
  return /(?:'\s*(?:OR|AND)\s+'?\d|;\s*(?:DROP|DELETE|UPDATE|INSERT)\b|--|\/\*)/i.test(String(sql || ''));
}

/** فضای آزاد مسیر داده (بایت) یا null اگر قابل خواندن نباشد */
export function freeDiskBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

/** حجم فایل به بایت (۰ اگر نباشد) */
export function fileSizeBytes(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * اطمینان از وجود حداقل `requiredBytes` فضای آزاد.
 * @throws {DiskSpaceError}
 */
export function assertDiskSpace(dir, requiredBytes, label = 'عملیات') {
  const free = freeDiskBytes(dir);
  if (free == null) return free; // سکوهای بدون statfs: بررسی ممکن نیست
  const needed = Math.max(0, Number(requiredBytes) || 0) + MIN_FREE_BYTES;
  if (free < needed) {
    throw new DiskSpaceError(
      `فضای دیسک برای ${label} کافی نیست: ${Math.round(free / 1048576)} مگابایت آزاد، حداقل ${Math.round(needed / 1048576)} مگابایت لازم است.`,
      { detail: { free, needed, dir } }
    );
  }
  return free;
}

export default {
  normalizeBindValue,
  normalizeBindParams,
  assertSqlIdentifier,
  looksLikeInjection,
  freeDiskBytes,
  fileSizeBytes,
  assertDiskSpace,
  MIN_FREE_BYTES,
};
