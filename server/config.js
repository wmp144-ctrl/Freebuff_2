/**
 * NetWatch — منبع مرکزی پیکربندی
 * ----------------------------------------------------------------
 * پیش از این هر ماژول متغیرهای محیطی خودش را می‌خواند؛ نتیجه آن بود که
 * پیش‌فرض‌ها (به‌ویژه HOST) در README، systemd و کد یکسان نبودند و مقدار
 * نامعتبر در یک ماژول بی‌صدا نادیده گرفته می‌شد.
 *
 * این ماژول:
 *   • همهٔ تنظیمات زمان اجرا را یک‌جا می‌خواند، نوع و بازه را بررسی می‌کند.
 *   • خطاهای «حیاتی» (HOST/PORT نامعتبر، CIDR نامعتبر، TLS ناقص، proxy
 *     نامعتبر، محدودیت نرخ نامعتبر) را به‌صورت ConfigError برمی‌گرداند تا
 *     برنامه پیش از هر کار ناامن متوقف شود.
 *   • پیکربندی حساس (رمز مدیر، مسیر کلید TLS) را هرگز در خلاصهٔ لاگ نمی‌آورد.
 *
 * قواعد خواندن مقدار:
 *   • کلیدهای امنیتی/حیاتی: مقدار نامعتبر ⇒ خطا (توقف راه‌اندازی).
 *   • کلیدهای عددی تنظیمات پایش (NETWATCH_PING_INTERVAL و…) در لایهٔ
 *     تنظیمات پایگاه‌داده (db.js) با بازهٔ امن نرمال می‌شوند؛ رفتار قبلی حفظ
 *     شده است.
 */
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCidrList } from './net-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export class ConfigError extends Error {
  constructor(errors) {
    super(`پیکربندی نامعتبر است:\n- ${errors.join('\n- ')}`);
    this.name = 'ConfigError';
    this.code = 'CONFIG_INVALID';
    this.errors = errors;
  }
}

function bool(raw, fallback = false) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

/**
 * خواندن عدد صحیح در بازه. اگر مقدار داده شده باشد ولی نامعتبر/خارج از بازه
 * باشد، خطا برمی‌گرداند (نه سقوط بی‌صدا به پیش‌فرض).
 */
function intSetting(env, key, fallback, { min, max, errors }) {
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${key} باید عدد صحیحی بین ${min} و ${max} باشد (مقدار دریافت‌شده: ${String(raw).slice(0, 40)}).`);
    return fallback;
  }
  return n;
}

function isHostname(value) {
  const v = String(value || '').trim();
  if (!v || v.length > 253) return false;
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(v);
}

/**
 * اعتبارسنجی مقدار NETWATCH_TRUST_PROXY. فقط مقادیر شناخته‌شدهٔ Express یا
 * فهرست IP/CIDR صریح پذیرفته می‌شود؛ هر چیز دیگر می‌تواند باور به هدر
 * X-Forwarded-For جعلی را ممکن کند.
 */
export function parseTrustProxy(raw, errors = []) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const value = String(raw).trim();
  const lower = value.toLowerCase();
  if (lower === '0' || lower === 'false' || lower === 'off') return null;
  if (lower === '1' || lower === 'true' || lower === 'on') return 1;
  if (['loopback', 'linklocal', 'uniquelocal'].includes(lower)) return lower;
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    if (n >= 1 && n <= 10) return n;
    errors.push(`NETWATCH_TRUST_PROXY: عدد پرش باید بین 1 و 10 باشد (${value}).`);
    return null;
  }
  const items = value.split(',').map((s) => s.trim()).filter(Boolean);
  if (!items.length || items.length > 32) {
    errors.push('NETWATCH_TRUST_PROXY: فهرست خالی یا بیش از ۳۲ عضو است.');
    return null;
  }
  for (const item of items) {
    const host = item.includes('/') ? item.slice(0, item.indexOf('/')) : item;
    if (!net.isIP(host)) {
      errors.push(`NETWATCH_TRUST_PROXY: «${item}» IP یا CIDR معتبر نیست.`);
      return null;
    }
  }
  return items.join(',');
}

function resolvePath(value, fallback) {
  const raw = value === undefined || value === null || String(value).trim() === '' ? fallback : String(value).trim();
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(ROOT, raw);
}

/**
 * ساخت پیکربندی از محیط. برای آزمون می‌توان محیط ساختگی داد.
 * @returns {{host:string,port:number,dev:boolean,dataDir:string,dbPath:string,backupDir:string,
 *   tls:object,trustProxy:string|number|null,shutdownTimeoutMs:number,stopDrainMs:number,
 *   engine:object,rateLimit:object,probe:object,sse:object,errors:string[],warnings:string[]}}
 */
export function createConfig(env = process.env, { dev = false } = {}) {
  const errors = [];
  const warnings = [];

  const isDev = Boolean(dev);
  const port = intSetting(env, 'PORT', isDev ? 3000 : 8787, { min: 1, max: 65535, errors });
  const host = String(env.HOST || '127.0.0.1').trim();
  if (!net.isIP(host) && !isHostname(host)) {
    errors.push(`HOST باید IP یا نام میزبان معتبر باشد (مقدار دریافت‌شده: ${host.slice(0, 60)}).`);
  }

  const dataDir = resolvePath(env.NETWATCH_DATA_DIR, path.join(ROOT, 'data'));
  const dbPath = resolvePath(env.NETWATCH_DB, path.join(dataDir, 'netwatch.db'));
  const backupDir = resolvePath(env.NETWATCH_BACKUP_DIR, path.join(dataDir, 'backups'));

  // TLS: یا هر دو مسیر، یا هیچ‌کدام. تنظیم ناقص یعنی سرویس ممکن است ناخواسته
  // روی HTTP ساده بالا بیاید؛ پس خطای حیاتی است.
  const tlsDir = env.NETWATCH_TLS_DIR ? resolvePath(env.NETWATCH_TLS_DIR, '') : null;
  const tlsCert = env.NETWATCH_TLS_CERT ? resolvePath(env.NETWATCH_TLS_CERT, '') : tlsDir ? path.join(tlsDir, 'server.crt') : null;
  const tlsKey = env.NETWATCH_TLS_KEY ? resolvePath(env.NETWATCH_TLS_KEY, '') : tlsDir ? path.join(tlsDir, 'server.key') : null;
  const tlsCa = env.NETWATCH_TLS_CA ? resolvePath(env.NETWATCH_TLS_CA, '') : tlsDir ? path.join(tlsDir, 'ca.crt') : null;
  if (Boolean(tlsCert) !== Boolean(tlsKey)) {
    errors.push('برای HTTPS باید هم NETWATCH_TLS_CERT و هم NETWATCH_TLS_KEY تنظیم شود (یا فقط NETWATCH_TLS_DIR).');
  }
  const tlsEnabled = Boolean(tlsCert && tlsKey);
  const hsts = bool(env.NETWATCH_HSTS, true);
  const httpPort = intSetting(env, 'NETWATCH_HTTP_PORT', 0, { min: 0, max: 65535, errors });

  const trustProxy = parseTrustProxy(env.NETWATCH_TRUST_PROXY, errors);

  const shutdownTimeoutMs = intSetting(env, 'NETWATCH_SHUTDOWN_TIMEOUT_MS', 5000, { min: 100, max: 120000, errors });
  // توقف عادی به‌طور پیش‌فرض فوری است (عملیات در جریان باطل/fenced می‌شوند).
  // مسیرهای خاموشی کنترل‌شده (SIGTERM/SIGINT/restart) صریحاً از
  // shutdownTimeoutMs استفاده می‌کنند تا نتایج در جریان فرصت ثبت داشته باشند.
  const stopDrainMs = intSetting(env, 'NETWATCH_STOP_DRAIN_MS', 0, { min: 0, max: 120000, errors });

  const engineEnabled = String(env.NETWATCH_ENGINE ?? '1') !== '0';
  const engineModeRaw = env.NETWATCH_ENGINE_MODE === undefined ? null : String(env.NETWATCH_ENGINE_MODE).trim();
  if (engineModeRaw !== null && !['auto', 'icmp', 'tcp', 'simulate'].includes(engineModeRaw)) {
    errors.push(`NETWATCH_ENGINE_MODE باید یکی از auto|icmp|tcp|simulate باشد (${engineModeRaw.slice(0, 30)}).`);
  }
  const engine = {
    enabled: engineEnabled,
    mode: engineModeRaw,
    lockTtlMs: intSetting(env, 'NETWATCH_ENGINE_LOCK_TTL_MS', 15000, { min: 1000, max: 600000, errors }),
    lockRetryMs: intSetting(env, 'NETWATCH_LOCK_RETRY_MS', 2000, { min: 100, max: 60000, errors }),
  };

  const rateLimit = {
    windowMs: intSetting(env, 'NETWATCH_RATE_LIMIT_WINDOW_MS', 60000, { min: 1000, max: 3600000, errors }),
    general: intSetting(env, 'NETWATCH_RATE_LIMIT_MAX', 600, { min: 1, max: 1000000, errors }),
    expensive: intSetting(env, 'NETWATCH_EXPENSIVE_RATE_LIMIT_MAX', 60, { min: 1, max: 1000000, errors }),
    login: intSetting(env, 'NETWATCH_LOGIN_RATE_LIMIT_MAX', 10, { min: 1, max: 100000, errors }),
    admin: intSetting(env, 'NETWATCH_ADMIN_RATE_LIMIT_MAX', 120, { min: 1, max: 1000000, errors }),
    import: intSetting(env, 'NETWATCH_IMPORT_RATE_LIMIT_MAX', 20, { min: 1, max: 1000000, errors }),
    // برای سازگاری با نسخهٔ قبلی، اگر سقف مستقل Probe تنظیم نشده باشد از
    // همان NETWATCH_EXPENSIVE_RATE_LIMIT_MAX استفاده می‌شود.
    probe: intSetting(env, 'NETWATCH_PROBE_RATE_LIMIT_MAX', Number(env.NETWATCH_EXPENSIVE_RATE_LIMIT_MAX) || 60, {
      min: 1,
      max: 1000000,
      errors,
    }),
    maxKeys: intSetting(env, 'NETWATCH_RATE_LIMIT_MAX_KEYS', 10000, { min: 100, max: 1000000, errors }),
  };

  // محدودهٔ Probe: پیش‌فرض فقط شبکه‌های خصوصی و loopback. Link-Local و
  // Metadata عمداً در پیش‌فرض نیستند و بدون پرچم صریح هم مسدود می‌مانند.
  let probeCidrs = null;
  const cidrRaw = env.NETWATCH_PROBE_ALLOWED_CIDRS;
  if (cidrRaw !== undefined && String(cidrRaw).trim() !== '') {
    probeCidrs = normalizeCidrList(String(cidrRaw));
    if (!probeCidrs || !probeCidrs.length) {
      errors.push('NETWATCH_PROBE_ALLOWED_CIDRS نامعتبر است؛ فهرست CIDR جداشده با ویرگول بدهید (مثال: 10.0.0.0/8,192.168.0.0/16).');
    }
  }
  const probe = {
    cidrs: probeCidrs,
    allowLinkLocal: bool(env.NETWATCH_PROBE_ALLOW_LINK_LOCAL, false),
    allowMetadata: bool(env.NETWATCH_PROBE_ALLOW_METADATA, false),
    // مکانیزم‌های انتقال IPv4→IPv6 (6to4/Teredo) به‌طور پیش‌فرض مسدودند؛
    // فعال‌کردن آن‌ها باید آگاهانه و صریح باشد.
    allowTransition: bool(env.NETWATCH_PROBE_ALLOW_TRANSITION, false),
  };

  // ---- احراز هویت و نشست (Phase 3) ----
  // سیاست رمز قابل تنظیم است؛ پیش‌فرض: حداقل ۱۲ نویسه و حداقل سه دسته از
  // چهار دسته (کوچک/بزرگ/رقم/نماد) یا یک عبارت ≥۲۰ نویسه. با
  // NETWATCH_PASSWORD_REQUIRE_COMPLEXITY=0 می‌توان الزام ترکیب را خاموش کرد
  // (طول حداقل همچنان اعمال می‌شود).
  const passwordMinLength = intSetting(env, 'NETWATCH_PASSWORD_MIN_LENGTH', 12, { min: 8, max: 128, errors });
  const passwordRequireComplexity = bool(env.NETWATCH_PASSWORD_REQUIRE_COMPLEXITY, true);
  const loginMaxFailures = intSetting(env, 'NETWATCH_LOGIN_MAX_FAILURES', 5, { min: 3, max: 100, errors });
  const loginLockoutMinutes = intSetting(env, 'NETWATCH_LOGIN_LOCKOUT_MINUTES', 15, { min: 1, max: 1440, errors });
  const sessionHours = intSetting(env, 'NETWATCH_SESSION_HOURS', 12, { min: 1, max: 720, errors });
  const sessionIdleMinutes = intSetting(env, 'NETWATCH_SESSION_IDLE_MINUTES', 60, { min: 1, max: 720, errors });
  const sessionTtlMs = sessionHours * 3600 * 1000;
  // Idle timeout هرگز از عمر مطلق نشست بیشتر نمی‌شود؛ وگرنه تنظیم متناقض،
  // نشست را عملاً بی‌پایان می‌کند.
  const sessionIdleMs = Math.min(sessionIdleMinutes * 60 * 1000, sessionTtlMs);
  if (sessionIdleMinutes * 60 * 1000 > sessionTtlMs) {
    warnings.push('NETWATCH_SESSION_IDLE_MINUTES از NETWATCH_SESSION_HOURS بیشتر است؛ Idle Timeout به عمر مطلق نشست محدود شد.');
  }

  // شبکه‌های مجاز برای APIهای مدیریتی (اختیاری). خالی = بدون محدودیت شبکه‌ای
  // (کنترل نقش همچنان برقرار است). مقدار نامعتبر حیاتی است تا مدیر به‌اشتباه
  // گمان نکند محدودیت اعمال شده است.
  let adminCidrs = null;
  const adminCidrRaw = env.NETWATCH_ADMIN_ALLOWED_CIDRS;
  if (adminCidrRaw !== undefined && String(adminCidrRaw).trim() !== '') {
    adminCidrs = normalizeCidrList(String(adminCidrRaw));
    if (!adminCidrs || !adminCidrs.length) {
      errors.push('NETWATCH_ADMIN_ALLOWED_CIDRS نامعتبر است؛ فهرست CIDR جداشده با ویرگول بدهید (مثال: 10.0.0.0/8,192.168.10.0/24).');
    }
  }

  // ---- محدودیت‌های HTTP (ضد Slowloris و درخواست‌های طولانی) ----
  const requestTimeoutMs = intSetting(env, 'NETWATCH_REQUEST_TIMEOUT_MS', 120000, { min: 5000, max: 600000, errors });
  const headersTimeoutMs = intSetting(env, 'NETWATCH_HEADERS_TIMEOUT_MS', 30000, { min: 1000, max: 120000, errors });
  const keepAliveTimeoutMs = intSetting(env, 'NETWATCH_KEEPALIVE_TIMEOUT_MS', 5000, { min: 500, max: 120000, errors });
  if (headersTimeoutMs >= requestTimeoutMs) {
    errors.push('NETWATCH_HEADERS_TIMEOUT_MS باید کمتر از NETWATCH_REQUEST_TIMEOUT_MS باشد.');
  }

  const sse = {
    max: intSetting(env, 'NETWATCH_SSE_MAX', 32, { min: 0, max: 10000, errors }),
    // حداقل ۱ بایت مجاز است تا آزمون فشار برگشتی بتواند سقف بسیار کوچک بدهد؛
    // مقدار ۰ یا منفی نامعتبر است.
    maxBuffer: intSetting(env, 'NETWATCH_SSE_MAX_BUFFER', 1048576, { min: 1, max: 256 * 1024 * 1024, errors }),
    heartbeatMs: intSetting(env, 'NETWATCH_SSE_HEARTBEAT_MS', 25000, { min: 1000, max: 600000, errors }),
  };

  if (!errors.length && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    warnings.push(`سرویس روی ${host} منتشر می‌شود؛ ورود و مجوزها فعال‌اند، اما TLS/فایروال را بررسی کنید.`);
  }
  if (tlsEnabled && hsts === false) warnings.push('HSTS خاموش است؛ فقط برای گواهی خودامضا/آزمون مناسب است.');
  if (!adminCidrs && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    warnings.push('سرویس روی شبکه منتشر شده و NETWATCH_ADMIN_ALLOWED_CIDRS تنظیم نشده است؛ APIهای مدیریتی برای هر شبکهٔ قابل‌دسترسی باز هستند.');
  }

  return {
    dev: isDev,
    host,
    port,
    dataDir,
    dbPath,
    backupDir,
    mbtilesDir: path.join(dataDir, 'mbtiles'),
    tls: { enabled: tlsEnabled, dir: tlsDir, certPath: tlsCert, keyPath: tlsKey, caPath: tlsCa, hsts, httpPort },
    trustProxy,
    shutdownTimeoutMs,
    stopDrainMs,
    auth: {
      passwordMinLength,
      passwordRequireComplexity,
      loginMaxFailures,
      loginLockoutMs: loginLockoutMinutes * 60 * 1000,
      sessionTtlMs,
      sessionIdleMs,
      adminCidrs,
    },
    http: { requestTimeoutMs, headersTimeoutMs, keepAliveTimeoutMs, maxHeadersCount: 100 },
    engine,
    rateLimit,
    probe,
    sse,
    errors,
    warnings,
  };
}

/**
 * خلاصهٔ ایمن برای لاگ: هیچ رمز، کلید یا محتوای حساسی در آن نیست.
 */
export function configSummary(cfg) {
  return {
    host: cfg.host,
    port: cfg.port,
    mode: cfg.dev ? 'development' : 'production',
    dataDir: cfg.dataDir,
    dbPath: cfg.dbPath,
    backupDir: cfg.backupDir,
    tls: cfg.tls.enabled,
    trustProxy: cfg.trustProxy ? 'configured' : 'off',
    auth: {
      passwordMinLength: cfg.auth.passwordMinLength,
      passwordRequireComplexity: cfg.auth.passwordRequireComplexity,
      loginMaxFailures: cfg.auth.loginMaxFailures,
      loginLockoutMinutes: Math.round(cfg.auth.loginLockoutMs / 60000),
      sessionTtlHours: Math.round(cfg.auth.sessionTtlMs / 3600000),
      sessionIdleMinutes: Math.round(cfg.auth.sessionIdleMs / 60000),
      adminNetwork: cfg.auth.adminCidrs ? 'restricted' : 'open',
    },
    http: cfg.http,
    engineEnabled: cfg.engine.enabled,
    lockTtlMs: cfg.engine.lockTtlMs,
    shutdownTimeoutMs: cfg.shutdownTimeoutMs,
    rateLimit: {
      general: cfg.rateLimit.general,
      probe: cfg.rateLimit.probe,
      login: cfg.rateLimit.login,
      admin: cfg.rateLimit.admin,
      import: cfg.rateLimit.import,
      maxKeys: cfg.rateLimit.maxKeys,
    },
  };
}

const singleton = createConfig(process.env, {
  dev: process.argv.includes('--dev') || process.env.NODE_ENV === 'development',
});

// پیکربندی نامعتبر حیاتی: توقف پیش از هر اتصال/نوشتن. پیام خطا بدون افشای
// مقادیر حساس است (فقط نام کلید و بازهٔ مجاز).
if (singleton.errors.length) throw new ConfigError(singleton.errors);

export const config = singleton;
export default config;
