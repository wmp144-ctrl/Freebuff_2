/**
 * NetWatch — لاگ ساختاریافته
 * ----------------------------------------------------------------
 * گزارش‌ها به‌صورت JSON یک‌خطی روی stdout/stderr نوشته می‌شوند تا ابزارهای
 * پایش (systemd/journald، ELK، Loki و…) بتوانند سطح، رویداد و فیلدها را
 * مستقیم تجزیه کنند. لاگ دیتابیسی (جدول engine_log) برای نمایش در UI است و
 * مستقل از این ماژول کار می‌کند.
 *
 * سخت‌سازی Phase 3:
 *   • هر مقدار رشته‌ای از نویسه‌های کنترلی پاک می‌شود تا Log Injection
 *     (ورود \n/\r یا ESC به یک رکورد JSON) ممکن نباشد.
 *   • کلیدهای حساس (رمز، توکن، کوکی، CSRF، Secret، Authorization) هرگز مقدارشان
 *     نوشته نمی‌شود؛ حتی اگر یک ماژول به‌اشتباه آن را پاس بدهد.
 *   • عمق/تعداد/طول فیلدها مرزگذاری می‌شود تا یک ورودی مخرب لاگ را بی‌نهایت
 *     بزرگ نکند.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const MIN_LEVEL = LEVELS[String(process.env.NETWATCH_LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
// در ابزارهای خط فرمان که خروجی JSON آن‌ها مصرف ماشینی دارد، همهٔ لاگ‌ها به
// stderr می‌روند تا stdout فقط نتیجهٔ قابل‌تجزیه باشد.
const ALL_TO_STDERR = String(process.env.NETWATCH_LOG_STREAM || '').toLowerCase() === 'stderr';

const SENSITIVE_KEY = /pass(word)?|secret|token|csrf|cookie|authorization|api[_-]?key|private[_-]?key|session[_-]?id/i;
const MAX_TEXT = 500;
const MAX_DEPTH = 3;
const MAX_KEYS = 40;
const MAX_ARRAY = 20;

/**
 * پاک‌سازی متن قابل‌نمایش در لاگ: حذف نویسه‌های کنترلی، فشرده‌کردن فاصله‌ها و
 * سقف طول. مقدار غیررشته‌ای دست‌نخورده برمی‌گردد (عدد/بولین).
 */
export function sanitizeLogText(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return value;
  const cleaned = value
    // C0/C1 controls و line/paragraph separators به فاصله تبدیل می‌شوند.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

function sanitizeValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeLogText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = '[redacted]';
        continue;
      }
      out[key] = sanitizeValue(item, depth + 1);
    }
    return out;
  }
  return undefined;
}

/** پاک‌سازی فیلدهای یک رکورد لاگ (بدون تغییر شیء ورودی) */
export function sanitizeLogFields(fields = {}) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {};
  return sanitizeValue(fields, 0);
}

/**
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} event نام رویداد (مثلاً http_request، shutdown، engine_error)
 * @param {object} fields فیلدهای ساختاریافته (نباید مقدار حساس داشته باشند)
 */
export function logEvent(level, event, fields = {}) {
  const lvl = LEVELS[level] ? level : 'info';
  if (LEVELS[lvl] < MIN_LEVEL) return;
  const safeFields = sanitizeLogFields(fields);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: lvl,
    event: sanitizeLogText(String(event), 120),
    ...safeFields,
  });
  if (ALL_TO_STDERR || LEVELS[lvl] >= LEVELS.warn) process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export default { logEvent, sanitizeLogText, sanitizeLogFields };
