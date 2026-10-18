/**
 * NetWatch — اعتبارسنجی ورودی درخواست‌ها
 * ----------------------------------------------------------------
 * اعتبارسنجی دامنه‌ای در ماژول‌های خودشان (تجهیز، تنظیمات، علامت…) انجام
 * می‌شود؛ این لایه قواعد عمومی و مشترک را اعمال می‌کند:
 *   • بدنهٔ JSON باید یک شیء ساده باشد (نه آرایه/عدد/رشته)
 *   • کلیدهای خطرناک نمونه‌سازی (__proto__/prototype/constructor) رد می‌شوند
 *   • درخواست دارای بدنه باید Content-Type صحیح داشته باشد (۴۱۵)
 *   • آدرس‌های بسیار بلند رد می‌شوند
 */

const MAX_URL_LENGTH = 8192;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_DEPTH = 8;

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** بررسی بازگشتی کلیدهای خطرناک؛ عمق و تعداد گره‌ها محدود است */
export function hasDangerousKeys(value, depth = 0, budget = { n: 0 }) {
  if (depth > MAX_DEPTH || budget.n > 5000) return true;
  budget.n += 1;
  if (Array.isArray(value)) return value.some((v) => hasDangerousKeys(v, depth + 1, budget));
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) return true;
    if (hasDangerousKeys(value[key], depth + 1, budget)) return true;
  }
  return false;
}

function reject(res, status, message) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json({ error: message });
}

export function validateRequestUrl(req, res, next) {
  if (String(req.originalUrl || '').length > MAX_URL_LENGTH) {
    return reject(res, 414, 'آدرس درخواست بیش از حد مجاز است.');
  }
  return next();
}

/**
 * پس از express.json نصب می‌شود. مسیرهای multipart (بارگذاری فایل) از این
 * بررسی مستثنا هستند و محدودیت خودشان را در ماژول بارگذاری دارند.
 */
export function validateJsonBody(req, res, next) {
  const method = String(req.method || '').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  const contentType = String(req.get('content-type') || '').toLowerCase();
  if (contentType.includes('multipart/form-data')) return next();
  const declared = Number(req.get('content-length') || 0);
  const hasBody = declared > 0 || Boolean(req.get('transfer-encoding'));
  if (!hasBody) return next();
  if (!contentType.includes('application/json')) {
    return reject(res, 415, 'بدنهٔ درخواست باید با Content-Type: application/json ارسال شود.');
  }
  if (!isPlainObject(req.body)) {
    return reject(res, 400, 'بدنهٔ درخواست باید یک شیء JSON باشد.');
  }
  if (hasDangerousKeys(req.body)) {
    return reject(res, 400, 'بدنهٔ درخواست شامل کلید غیرمجاز است.');
  }
  return next();
}

/** شناسهٔ مثبت از مسیر/پرس‌وجو؛ NaN برای ورودی نامعتبر */
export function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export default { isPlainObject, hasDangerousKeys, validateRequestUrl, validateJsonBody, positiveInt };
