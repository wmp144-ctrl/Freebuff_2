/**
 * NetWatch — محدودکنندهٔ نرخ درخواست (in-memory، بدون وابستگی)
 * ----------------------------------------------------------------
 * سامانه روی شبکهٔ محلی اجرا می‌شود و احراز هویت ندارد؛ بدون سقف نرخ، یک کلاینت
 * می‌تواند با انبوه درخواست‌های گران (Ping دستی، بررسی زنده، ورود فایل) فرآیند
 * ping و حافظهٔ سرور را از پا درآورد. این ماژول یک پنجرهٔ زمانی ثابت ساده است:
 * برای هر IP در هر پنجره حداکثر `max` درخواست پذیرفته می‌شود.
 */
export function createRateLimiter({ windowMs = 60000, max = 600, name = 'api' } = {}) {
  const hits = new Map(); // ip -> { start, count }
  let sweeper = null;

  function sweep() {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now - entry.start >= windowMs) hits.delete(key);
    }
  }

  return function rateLimit(req, res, next) {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now - entry.start >= windowMs) {
      entry = { start: now, count: 0 };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: `تعداد درخواست‌های «${name}» بیش از حد مجاز است؛ ${retryAfter} ثانیه دیگر تلاش کنید.`,
      });
    }
    if (!sweeper) {
      sweeper = setInterval(sweep, windowMs);
      if (sweeper.unref) sweeper.unref();
    }
    return next();
  };
}

/** مسیرهایی که هر درخواست آن‌ها یک فرآیند/عملیات سنگین راه می‌اندازد */
export function isExpensiveRequest(req) {
  const path = req.path || '';
  return (
    /^\/devices\/[^/]+\/(ping|probe)$/.test(path) ||
    /^\/devices\/(import|template|export)/.test(path) ||
    /^\/engine\/check/.test(path) ||
    /^\/layers\/upload$/.test(path) ||
    /^\/mbtiles\/files/.test(path) ||
    /^\/settings\/reset-demo$/.test(path)
  );
}

export default { createRateLimiter, isExpensiveRequest };
