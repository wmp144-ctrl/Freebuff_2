/**
 * NetWatch — محدودیت بارگذاری فایل
 * ----------------------------------------------------------------
 * ورود Excel/CSV و MBTiles منابع گران‌اند: فایل بزرگ در حافظه/دیسک، پارس
 * سنگین و ردیف‌های بی‌شمار. محدودیت‌ها یک‌جا و با متغیر محیطی قابل تنظیم‌اند:
 *   NETWATCH_MAX_IMPORT_BYTES  (پیش‌فرض ۱۰ مگابایت)
 *   NETWATCH_MAX_MBTILES_BYTES (پیش‌فرض ۱ گیگابایت)
 */
import multer from 'multer';
import path from 'node:path';

function envBytes(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return Math.floor(n);
}

export const MAX_IMPORT_BYTES = envBytes('NETWATCH_MAX_IMPORT_BYTES', 10 * 1024 * 1024, 64 * 1024, 100 * 1024 * 1024);
export const MAX_MBTILES_BYTES = envBytes('NETWATCH_MAX_MBTILES_BYTES', 1024 * 1024 * 1024, 1024 * 1024, 10 * 1024 * 1024 * 1024);

const SPREADSHEET_EXT = /\.(xlsx|xls|csv)$/i;

/** فیلتر پسوند برای ورود گروهی Excel/CSV؛ محتوا هم در impexp.js پارس و اعتبارسنجی می‌شود */
export function spreadsheetOnly(_req, file, cb) {
  if (!SPREADSHEET_EXT.test(path.basename(String(file.originalname || '')))) {
    const err = new Error('فقط فایل با پسوند .xlsx، .xls یا .csv پذیرفته می‌شود.');
    err.code = 'BAD_SPREADSHEET_EXTENSION';
    err.status = 400;
    return cb(err);
  }
  return cb(null, true);
}

/** بارگذاری صفحه‌گسترده در حافظه با سقف حجم/فیلد/فایل */
export const spreadsheetUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: spreadsheetOnly,
  limits: {
    fileSize: MAX_IMPORT_BYTES,
    files: 1,
    fields: 20,
    fieldSize: 1024 * 1024,
    parts: 25,
  },
});

/** فیلتر پسوند MBTiles پیش از نوشتن فایل روی دیسک */
export function mbtilesOnly(_req, file, cb) {
  if (!/\.mbtiles$/i.test(path.basename(String(file.originalname || '')))) {
    const err = new Error('فقط فایل با پسوند .mbtiles پذیرفته می‌شود.');
    err.code = 'BAD_EXTENSION';
    err.status = 400;
    return cb(err);
  }
  return cb(null, true);
}

/** محدودیت‌های مشترک MBTiles (مخزن دیسکی در inventory.js تعیین می‌شود) */
export const mbtilesLimits = {
  fileSize: MAX_MBTILES_BYTES,
  files: 1,
  fields: 20,
  fieldSize: 1024 * 1024,
  parts: 25,
};

export default {
  MAX_IMPORT_BYTES,
  MAX_MBTILES_BYTES,
  spreadsheetUpload,
  spreadsheetOnly,
  mbtilesOnly,
  mbtilesLimits,
};
