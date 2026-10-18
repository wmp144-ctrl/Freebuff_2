/**
 * NetWatch — لاگ ساختاریافته
 * ----------------------------------------------------------------
 * گزارش‌ها به‌صورت JSON یک‌خطی روی stdout/stderr نوشته می‌شوند تا ابزارهای
 * پایش (systemd/journald، ELK، Loki و…) بتوانند سطح، رویداد و فیلدها را
 * مستقیم تجزیه کنند. لاگ دیتابیسی (جدول engine_log) برای نمایش در UI است و
 * مستقل از این ماژول کار می‌کند.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const MIN_LEVEL = LEVELS[String(process.env.NETWATCH_LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
// در ابزارهای خط فرمان که خروجی JSON آن‌ها مصرف ماشینی دارد، همهٔ لاگ‌ها به
// stderr می‌روند تا stdout فقط نتیجهٔ قابل‌تجزیه باشد.
const ALL_TO_STDERR = String(process.env.NETWATCH_LOG_STREAM || '').toLowerCase() === 'stderr';

/**
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} event نام رویداد (مثلاً http_request، shutdown، engine_error)
 * @param {object} fields فیلدهای ساختاریافته (نباید مقدار حساس داشته باشند)
 */
export function logEvent(level, event, fields = {}) {
  const lvl = LEVELS[level] ? level : 'info';
  if (LEVELS[lvl] < MIN_LEVEL) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level: lvl, event, ...fields });
  if (ALL_TO_STDERR || LEVELS[lvl] >= LEVELS.warn) process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export default { logEvent };
