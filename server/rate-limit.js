/**
 * NetWatch — محدودکنندهٔ نرخ درخواست (in-memory، بدون وابستگی)
 * ----------------------------------------------------------------
 * سامانه روی شبکهٔ محلی اجرا می‌شود، اما بدون سقف نرخ یک کلاینت می‌تواند با
 * انبوه درخواست‌های گران (Ping دستی، بررسی زنده، ورود فایل) فرآیند ping و
 * حافظهٔ سرور را از پا درآورد و رمز ورود را آنلاین حدس بزند.
 *
 * سخت‌سازی‌های این نسخه:
 *   • سقف مستقل برای هر حوزه (Login، مدیریتی، Import/Export، Probe) علاوه بر
 *     سقف عمومی.
 *   • شمارش هم‌زمان بر اساس IP و حساب کاربری (اگر کاربر وارد شده باشد)؛
 *     Login با نام کاربری هم شمارش می‌شود تا حملهٔ توزیع‌شده روی یک حساب
 *     بی‌سقف نماند.
 *   • تعداد کلیدها سقف دارد: کلیدهای منقضی پاک و در صورت لزوم قدیمی‌ترین‌ها
 *     حذف می‌شوند تا حافظه با انبوه IP جعلی رشد بی‌مرز نکند.
 *   • IP از طریق Express `req.ip` خوانده می‌شود که فقط وقتی trust proxy تنظیم
 *     شده باشد به X-Forwarded-For اعتماد می‌کند؛ آدرس‌های IPv4-mapped
 *     (`::ffff:1.2.3.4`) نرمال می‌شوند تا با تغییر شکل آدرس، سقف دور زده نشود.
 *   • آمار حافظه برای /health در دسترس است و close() تایمر پاک‌سازی را آزاد
 *     می‌کند (چرخهٔ حیات منابع).
 */

const DEFAULT_MAX_KEYS = 10000;
const MAX_WINDOW_MS = 60 * 60 * 1000;

/** نرمال‌سازی آدرس کلاینت: mapped IPv4 و zone حذف می‌شوند */
export function normalizeClientIp(value) {
  let ip = String(value || '').trim();
  if (!ip) return 'unknown';
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1];
  return ip.slice(0, 64) || 'unknown';
}

/** IP کلاینت با اعتماد به proxy فقط در همان حدی که Express پیکربندی شده است */
export function clientIp(req) {
  return normalizeClientIp(req?.ip || req?.socket?.remoteAddress || 'unknown');
}

function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * @param {{windowMs?:number,max?:number,userMax?:number,name?:string,maxKeys?:number,
 *   accountKey?:(req:any)=>string|null|undefined,keyGenerator?:(req:any)=>string,
 *   now?:()=>number,sweepIntervalMs?:number}} options
 */
export function createRateLimiter({
  windowMs = 60000,
  max = 600,
  userMax = null,
  name = 'api',
  maxKeys = DEFAULT_MAX_KEYS,
  accountKey = null,
  keyGenerator = null,
  now = () => Date.now(),
  sweepIntervalMs = null,
} = {}) {
  const window = boundedInt(windowMs, 60000, 100, MAX_WINDOW_MS);
  const limit = boundedInt(max, 600, 1, 10_000_000);
  const accountLimit = boundedInt(userMax ?? max, limit, 1, 10_000_000);
  const keyCap = boundedInt(maxKeys, DEFAULT_MAX_KEYS, 100, 1_000_000);
  const ips = new Map(); // ip -> { start, count }
  const users = new Map(); // user key -> { start, count }
  const stats = { hits: 0, blocked: 0, evictions: 0, sweeps: 0 };
  let sweeper = null;

  function sweepStore(store, at) {
    for (const [key, entry] of store) {
      if (at - entry.start >= window) store.delete(key);
    }
  }

  function sweep() {
    const at = now();
    sweepStore(ips, at);
    sweepStore(users, at);
    stats.sweeps += 1;
  }

  /** نگه‌داشتن سقف حافظه: ابتدا منقضی‌ها، سپس قدیمی‌ترین‌ها */
  function trim(store) {
    if (store.size <= keyCap) return;
    sweepStore(store, now());
    while (store.size > keyCap) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
      stats.evictions += 1;
    }
  }

  function hit(store, key, cap) {
    const at = now();
    let entry = store.get(key);
    if (!entry || at - entry.start >= window) {
      entry = { start: at, count: 0 };
    } else {
      // تازه‌سازی ترتیب LRU: کلید فعال دیرتر حذف می‌شود.
      store.delete(key);
    }
    entry.count += 1;
    store.set(key, entry);
    trim(store);
    const resetSec = Math.max(1, Math.ceil((entry.start + window - at) / 1000));
    return { allowed: entry.count <= cap, remaining: Math.max(0, cap - entry.count), resetSec, limit: cap, count: entry.count };
  }

  function applyHeaders(res, result) {
    res.setHeader('X-RateLimit-Limit', String(result.limit));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    res.setHeader('X-RateLimit-Reset', String(result.resetSec));
  }

  function deny(res, result, scopeLabel) {
    res.setHeader('Retry-After', String(result.resetSec));
    applyHeaders(res, result);
    res.setHeader('X-RateLimit-Scope', scopeLabel);
    return res.status(429).json({
      error: `تعداد درخواست‌های «${name}» بیش از حد مجاز است؛ ${result.resetSec} ثانیه دیگر تلاش کنید.`,
    });
  }

  function middleware(req, res, next) {
    stats.hits += 1;
    if (!sweeper) {
      sweeper = setInterval(sweep, boundedInt(sweepIntervalMs, Math.min(window, 60000), 100, MAX_WINDOW_MS));
      if (sweeper.unref) sweeper.unref();
    }
    const ipKey = normalizeClientIp(keyGenerator ? keyGenerator(req) : clientIp(req));
    const byIp = hit(ips, ipKey, limit);
    if (!byIp.allowed) {
      stats.blocked += 1;
      return deny(res, byIp, 'ip');
    }
    // محدودیت حساب فقط برای درخواست‌های احراز‌شده (یا Login که نام کاربری دارد)
    if (accountKey) {
      let account;
      try {
        account = accountKey(req);
      } catch {
        account = null;
      }
      if (account) {
        const byUser = hit(users, `u:${String(account).slice(0, 128)}`, accountLimit);
        if (!byUser.allowed) {
          stats.blocked += 1;
          return deny(res, byUser, 'account');
        }
        applyHeaders(res, byUser);
        return next();
      }
    }
    applyHeaders(res, byIp);
    return next();
  }

  /** آمار قابل اندازه‌گیری مصرف حافظه (تقریبی و بدون افشای کلیدها) */
  middleware.stats = () => {
    const keys = ips.size + users.size;
    // تخمین محافظه‌کارانه: کلید + شیء ورودی + سربار Map
    const estimatedBytes = keys * 160;
    return {
      name,
      windowMs: window,
      limit,
      accountLimit,
      maxKeys: keyCap,
      keys,
      ipKeys: ips.size,
      userKeys: users.size,
      estimatedBytes,
      ...stats,
    };
  };

  /** آزادسازی تایمر پاک‌سازی هنگام خاموشی سرور */
  middleware.close = () => {
    if (sweeper) clearInterval(sweeper);
    sweeper = null;
    ips.clear();
    users.clear();
  };

  return middleware;
}

/**
 * مسیرهایی که هر درخواست آن‌ها یک یا چند Probe/عملیات اسکن راه می‌اندازد.
 *
 * `POST /devices/bulk` فقط وقتی Probe است که action=ping باشد؛ سایر عملیات
 * گروهی (فعال/غیرفعال/حذف) نباید سهمیهٔ Probe را مصرف کنند.
 */
export function isProbeRequest(req) {
  const path = req.path || '';
  if (/^\/devices\/[^/]+\/(ping|probe)$/.test(path)) return true;
  if (/^\/devices\/bulk$/.test(path) && String(req.body?.action || '') === 'ping') return true;
  // check-all (بررسی همهٔ تجهیزات) نیز عملیات Probe است و باید سهمیهٔ مستقل
  // خودش را داشته باشد؛ پیش‌تر این مسیر از سقف Probe عبور نمی‌کرد.
  if (/^\/engine\/check(-all)?(\/|$)/.test(path)) return true;
  return false;
}

/** ورود/خروجی فایل و بازنشانی داده */
export function isImportRequest(req) {
  const path = req.path || '';
  return (
    /^\/devices\/(import|template|export)/.test(path) ||
    /^\/markers\/(import|export)/.test(path) ||
    /^\/layers\/upload$/.test(path) ||
    /^\/mbtiles\/files/.test(path) ||
    /^\/settings\/reset-demo$/.test(path)
  );
}

/** APIهای مدیریتی: تنظیمات، کاربران، سیستم، حسابرسی و کنترل موتور */
export function isAdminRequest(req) {
  const path = req.path || '';
  return (
    /^\/settings(\/|$)/.test(path) ||
    /^\/auth\/users(\/|$)/.test(path) ||
    /^\/system(\/|$)/.test(path) ||
    /^\/audit(\/|$)/.test(path) ||
    /^\/engine\/control(\/|$)/.test(path)
  );
}

/** سازگاری با نسخهٔ قبلی */
export function isExpensiveRequest(req) {
  return isProbeRequest(req) || isImportRequest(req);
}

export default {
  createRateLimiter,
  clientIp,
  normalizeClientIp,
  isProbeRequest,
  isImportRequest,
  isAdminRequest,
  isExpensiveRequest,
};
