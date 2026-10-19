/**
 * NetWatch — بررسی محتوای واقعی فایل‌های ورودی (Phase 3)
 * ----------------------------------------------------------------
 * پسوند و MIME Type به‌تنهایی قابل اعتماد نیستند: یک فایل اجرایی می‌تواند با
 * نام `devices.xlsx` آپلود شود. این ماژول پیش از تحویل بافر به SheetJS:
 *   • امضای واقعی فایل (ZIP/OLE) را بررسی می‌کند،
 *   • ساختار ZIP (XLSX) را می‌خواند و از ZIP Bomb / نسبت فشرده‌سازی غیرعادی
 *     جلوگیری می‌کند،
 *   • نام‌های مسیر پیمایشی داخل آرشیو را رد می‌کند،
 *   • CSV را به‌عنوان UTF-8 معتبر و متن (بدون NUL/نویسهٔ کنترلی انبوه) می‌پذیرد.
 *
 * همهٔ خطاها status=400 دارند تا فایل خراب، خطای داخلی/۵۰۰ تولید نکند.
 */
import path from 'node:path';

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_EOCD = 0x06054b50;
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function intEnv(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return Math.floor(n);
}

/** سقف حجم بازشدهٔ یک XLSX (پیش‌فرض ۶۴ مگابایت) و نسبت فشرده‌سازی مجاز */
export const SPREADSHEET_LIMITS = Object.freeze({
  maxEntries: intEnv('NETWATCH_MAX_XLSX_ENTRIES', 5000, 10, 100000),
  maxUncompressedBytes: intEnv('NETWATCH_MAX_XLSX_UNCOMPRESSED_BYTES', 64 * 1024 * 1024, 1024 * 1024, 512 * 1024 * 1024),
  maxCompressionRatio: intEnv('NETWATCH_MAX_XLSX_RATIO', 200, 10, 10000),
});

function bad(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'BAD_FILE_CONTENT';
  return error;
}

export function isZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer.readUInt32LE(0) === ZIP_LOCAL;
}

export function isOle(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.subarray(0, 8).equals(OLE_MAGIC);
}

/** پیدا کردن End of Central Directory از انتهای فایل (کامنت حداکثر ۶۴KB) */
function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === ZIP_EOCD) return i;
  }
  return -1;
}

function isSuspiciousEntryName(name) {
  const value = String(name || '');
  if (!value || value.includes('\u0000')) return true;
  if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) return true;
  if (value.includes('\\')) return true;
  return value.split('/').some((part) => part === '..');
}

/**
 * بازرسی مرکزی دایرکتوری ZIP و محدودیت‌های ضد ZIP Bomb.
 * @returns {{entries:number, uncompressedBytes:number, names:string[]}}
 */
export function inspectZip(buffer, { limits = SPREADSHEET_LIMITS } = {}) {
  if (!isZip(buffer)) throw bad('محتوای فایل با پسوند .xlsx هم‌خوان نیست (امضای ZIP یافت نشد).');
  // یک فایل چندبایتی با امضای ZIP نباید باعث RangeError شود.
  if (buffer.length < 22) throw bad('ساختار فایل XLSX ناقص است.');
  const eocd = findEocd(buffer);
  if (eocd < 0) throw bad('ساختار فایل XLSX ناقص است (دایرکتوری مرکزی یافت نشد).');
  const disk = buffer.readUInt16LE(eocd + 4);
  const cdDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw bad('آرشیو چندبخشی/چنددیسکی برای XLSX پذیرفته نمی‌شود.');
  }
  if (totalEntries < 1 || totalEntries > limits.maxEntries) {
    throw bad(`تعداد اعضای فایل XLSX بیش از حد مجاز است (حداکثر ${limits.maxEntries}).`);
  }
  if (centralOffset + centralSize > buffer.length || centralOffset < 0) {
    throw bad('ساختار فایل XLSX نامعتبر است.');
  }
  let cursor = centralOffset;
  let uncompressed = 0;
  let compressedTotal = 0;
  const names = [];
  for (let i = 0; i < totalEntries; i++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL) {
      throw bad('دایرکتوری مرکزی XLSX خراب است.');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const nameStart = cursor + 46;
    if (nameStart + nameLen > buffer.length) throw bad('نام عضو XLSX از محدودهٔ فایل بیرون است.');
    const name = buffer.subarray(nameStart, nameStart + nameLen).toString('utf8');
    if (isSuspiciousEntryName(name)) throw bad('فایل XLSX شامل مسیر غیرمجاز است.');
    // پرچم رمزنگاری و روش فشرده‌سازی پشتیبانی‌نشده
    if (flags & 0x1) throw bad('فایل XLSX رمزنگاری‌شده پذیرفته نمی‌شود.');
    if (![0, 8].includes(method)) throw bad('روش فشرده‌سازی فایل XLSX پشتیبانی نمی‌شود.');
    // ZIP64 برای فایل‌های کوچک لازم نیست و می‌تواند سقف حجم را دور بزند.
    if (compressed === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw bad('فایل XLSX از قالب ZIP64 استفاده می‌کند که برای این حجم مجاز نیست.');
    }
    if (Number.isSafeInteger(compressed) && Number.isSafeInteger(uncompressedSize)) {
      compressedTotal += compressed;
      uncompressed += uncompressedSize;
    }
    if (uncompressed > limits.maxUncompressedBytes) {
      throw bad(`حجم بازشدهٔ فایل XLSX بیش از حد مجاز است (حداکثر ${Math.round(limits.maxUncompressedBytes / 1024 / 1024)} مگابایت).`);
    }
    names.push(name);
    cursor = nameStart + nameLen + extraLen + commentLen;
  }
  // نسبت فشرده‌سازی: فایل متنی XLSX به‌طور طبیعی فشرده می‌شود، اما نسبت چند صد
  // برابری با حجم کوچک، نشانهٔ ZIP Bomb است.
  if (
    uncompressed > 2 * 1024 * 1024 &&
    compressedTotal > 0 &&
    uncompressed / Math.max(1, compressedTotal) > limits.maxCompressionRatio
  ) {
    throw bad('نسبت فشرده‌سازی فایل XLSX غیرعادی است؛ فایل مشکوک به ZIP Bomb رد شد.');
  }
  if (!names.some((n) => n.toLowerCase() === '[content_types].xml') || !names.some((n) => n.toLowerCase().startsWith('xl/'))) {
    throw bad('آرشیو ZIP ساختار یک کتاب کار Excel را ندارد.');
  }
  return { entries: names.length, uncompressedBytes: uncompressed, names };
}

/** CSV باید UTF-8 معتبر و متن باشد؛ فایل باینریِ تغییرنام‌داده رد می‌شود. */
export function inspectCsv(buffer, { maxRows = 50000, maxColumns = 200 } = {}) {
  if (!buffer.length) throw bad('فایل خالی است.');
  if (buffer.includes(0)) throw bad('فایل CSV نباید دادهٔ باینری/NUL داشته باشد.');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw bad('فایل CSV باید با کدگذاری UTF-8 ذخیره شده باشد.');
  }
  if (!text.trim()) throw bad('فایل CSV خالی است.');
  // نسبت نویسه‌های کنترلی (به‌جز tab/CR/LF) باید ناچیز باشد.
  let controls = 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a) lines += 1;
    else if (code < 0x20 && code !== 0x09 && code !== 0x0d) controls += 1;
  }
  // خط پایانی نباید یک ردیف خالی اضافه حساب شود.
  if (text.endsWith('\n')) lines -= 1;
  if (controls > Math.max(8, text.length * 0.01)) {
    throw bad('فایل CSV حاوی نویسه‌های کنترلی غیرعادی است.');
  }
  if (lines - 1 > maxRows) {
    throw bad(`تعداد ردیف‌های فایل (${lines - 1}) بیش از حد مجاز است؛ حداکثر ${maxRows} ردیف در هر بار ورود پشتیبانی می‌شود.`);
  }
  // پیش از پارس، عرض سرستون را می‌سنجیم تا یک خط با میلیون‌ها ویرگول آرایهٔ
  // عظیم نسازد.
  const firstLine = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'));
  const columns = (firstLine.match(/,/g) || []).length + 1;
  if (columns > maxColumns) {
    throw bad(`تعداد ستون‌های فایل (${columns}) بیش از حد مجاز است؛ حداکثر ${maxColumns} ستون پشتیبانی می‌شود.`);
  }
  return { characters: text.length, lines };
}

/**
 * بررسی محتوای فایل صفحه‌گسترده بر اساس پسوند.
 * @param {Buffer} buffer
 * @param {string} filename
 * @throws {Error} خطای ۴۰۰ با پیام فارسی
 */
export function assertSpreadsheetContent(buffer, filename = '', limits = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw bad('فایل ورودی خالی است.');
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.xlsx' || ext === '.xlsm') {
    return { kind: 'xlsx', ...inspectZip(buffer) };
  }
  if (ext === '.xls') {
    if (!isOle(buffer)) throw bad('محتوای فایل با پسوند .xls هم‌خوان نیست (فرمت قدیمی OLE یافت نشد).');
    return { kind: 'xls' };
  }
  if (ext === '.csv') {
    // فایل ZIP/OLE با پسوند CSV یعنی تلاش برای دورزدن بررسی محتوا.
    if (isZip(buffer) || isOle(buffer)) throw bad('محتوای باینری با پسوند .csv پذیرفته نمی‌شود.');
    return { kind: 'csv', ...inspectCsv(buffer, limits) };
  }
  throw bad('فقط فایل با پسوند .xlsx، .xls یا .csv پذیرفته می‌شود.');
}

/** پاک‌سازی پیام خطا برای نمایش به کاربر (بدون مسیر/Stack داخلی) */
export function fileGuardMessage(error) {
  return error?.code === 'BAD_FILE_CONTENT' ? error.message : 'محتوای فایل ورودی معتبر نیست.';
}

export default {
  SPREADSHEET_LIMITS,
  isZip,
  isOle,
  inspectZip,
  inspectCsv,
  assertSpreadsheetContent,
  fileGuardMessage,
};
