/**
 * NetWatch — سرور اصلی
 * ----------------------------------------------------------------
 * یک فرآیند واحد:
 *   • API  →  /api/*
 *   • رویدادهای زنده (SSE) → /api/events
 *   • رابط کاربری (Vite در حالت توسعه، فایل‌های ساخته‌شده در اجرای معمولی)
 *   • موتور مانیتورینگ (قابل خاموش‌کردن با NETWATCH_ENGINE=0)
 */
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { db, getSettings, seedIfEmpty, log, DB_PATH, verifyDatabaseAtStartup, checkDatabaseHealth, diskSpace } from './db.js';
import { startBackupScheduler, stopBackupScheduler, backupStatus, runCheckpoint } from './backup.js';
import { engine, bus } from './engine.js';
import { logEvent } from './logger.mjs';
import { config, configSummary } from './config.js';
import { createRateLimiter, isProbeRequest, isTopologyPollRequest, isImportRequest, isAdminRequest } from './rate-limit.js';
import { createSseHub } from './sse.js';
import { jobStats, shutdownJobs } from './jobs.js';
import { probeQueue, probeJobStats } from './probe-queue.js';
import {
  authRouter,
  attachUser,
  requireAuth,
  csrfGuard,
  initialSetupRequired,
  startSessionSweeper,
  stopSessionSweeper,
  closeAuthLimiters,
} from './auth.js';
import { requirePermission } from './permissions.js';
import { createAdminNetworkGuard } from './network-access.js';
import { auditMutations, stopAuditSweeper } from './audit.js';
import {
  markInterruptedRetentionRuns,
  retentionStatus,
  startRetentionScheduler,
  stopRetentionScheduler,
  requestRetentionStop,
} from './retention.js';
import {
  apiStats,
  historySnapshot,
  metricsSnapshot,
  queryStats,
  recordApi,
  startSampling,
  stopSampling,
} from './metrics.js';
import { validateRequestUrl, validateJsonBody } from './validation.js';
import { cleanupStaleUploads } from './upload.js';
import { sweepAttachmentOrphans } from './attachments.js';
import { sweepOrphanFiles as sweepMbtilesOrphans } from './mbtiles.js';
import devicesRouter from './routes/devices.js';
import attachmentsRouter from './routes/attachments.js';
import discoveryRouter from './routes/discovery.js';
import templatesRouter from './routes/templates.js';
import conflictsRouter from './routes/conflicts.js';
import {
  startDiscoveryScheduler,
  stopDiscoveryScheduler,
  recoverDiscoveryState,
  requestDiscoveryStop,
  waitForDiscoveryScan,
} from './discovery.js';
import dashboardRouter from './routes/dashboard.js';
import reportsRouter from './routes/reports.js';
import opsRouter from './routes/ops.js';
import inventoryRouter from './routes/inventory.js';
import markersRouter from './routes/markers.js';
import topologyRouter from './routes/topology.js';
import topologyHierarchyRouter from './routes/topology-hierarchy.js';
import auditRouter from './routes/audit.js';
import systemRouter from './routes/system.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
// نسخهٔ برنامه از package.json خوانده می‌شود. اتکا به npm_package_version
// فقط وقتی درست است که سرویس با `npm start` اجرا شود؛ systemd مستقیم
// `node server/index.js` را اجرا می‌کند و در آن حالت مقدار متغیر خالی است
// (و پیش‌تر نسخهٔ نادرست 1.0.0 گزارش می‌شد).
const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
})();
// همهٔ knobهای محیطی از منبع مرکزی و اعتبارسنجی‌شده می‌آیند (config.js).
// پیش‌فرض امن: سرویس فقط روی loopback گوش می‌دهد.
const DEV = config.dev;
const PORT = config.port;
const HOST = config.host;

// نخست سلامت فایل پایگاه‌داده (quick_check + کلید خارجی + جدول‌های الزامی).
// در صورت خرابی، برنامه با پیام روشن متوقف می‌شود؛ ادامهٔ کار روی فایل خراب،
// داده را بیشتر نابود می‌کند. با NETWATCH_DB_CHECK=warn فقط هشدار داده می‌شود.
verifyDatabaseAtStartup();
markInterruptedRetentionRuns();
// در نصب تازه، دادهٔ نمایشی فقط اگر صریحاً غیرفعال نشده باشد بارگذاری می‌شود
// (NETWATCH_SEED_DEMO=0 برای نصب Production خالی).
if (config.seedDemo) seedIfEmpty();
else logEvent('info', 'demo_seed_skipped', { reason: 'NETWATCH_SEED_DEMO=0' });
// نخستین مدیر دیگر خودکار ساخته نمی‌شود؛ صفحهٔ ورود در نخستین بازدید فرم
// راه‌اندازی اولیه (نام کاربری + رمز دو بار) را نشان می‌دهد. این پیام فقط
// اپراتور را در لاگ راهنمایی می‌کند.
if (initialSetupRequired()) {
  console.log('\n  راه‌اندازی اولیه: هنوز حسابی وجود ندارد؛ در نخستین بازدید از رابط کاربری، حساب مدیر را بسازید.\n');
}
// فایل‌های نیمه‌کارهٔ بارگذاری که پس از Crash/قطع برق مانده‌اند پاک می‌شوند.
cleanupStaleUploads();
// جبران خطا برای فایل/رکوردهای نیمه‌کاره (BUG-19): فایل یتیم پیوست و MBTiles
// پاک می‌شود، اما رکوردی که فایلش گم شده حذف نمی‌شود؛ فقط هشدار ثبت می‌شود.
try {
  const referencedAttachments = db.prepare('SELECT stored_name FROM device_attachments').all().map((r) => r.stored_name);
  const swept = sweepAttachmentOrphans({ referenced: referencedAttachments });
  if (swept.removedFiles || swept.trashed || swept.missingFiles) {
    logEvent('warn', 'attachment_orphan_sweep', swept);
  }
} catch (e) {
  log('warn', `پاک‌سازی فایل‌های یتیم پیوست ناموفق بود: ${e?.message || e}`);
}
try {
  const referencedMaps = db
    .prepare("SELECT file_name FROM map_layers WHERE file_name IS NOT NULL AND file_name <> ''")
    .all()
    .map((r) => r.file_name);
  const swept = sweepMbtilesOrphans({ referenced: referencedMaps });
  if (swept.removed || swept.missing) {
    logEvent('warn', 'mbtiles_orphan_sweep', swept);
  }
} catch (e) {
  log('warn', `پاک‌سازی فایل‌های یتیم نقشه ناموفق بود: ${e?.message || e}`);
}
// اسکن کشف نیمه‌کارهٔ فرآیند قبلی تعیین تکلیف می‌شود تا هیچ محدوده‌ای برای همیشه
// در وضعیت «در حال اجرا» نماند و نتایج ناقص «موفق» گزارش نشوند (BUG-22).
try {
  recoverDiscoveryState();
} catch (e) {
  log('warn', `ترمیم وضعیت اسکن کشف ناموفق بود: ${e?.message || e}`);
}

const app = express();
app.locals.seedIfEmpty = seedIfEmpty;
app.disable('x-powered-by');
// Escape کاراکترهای HTML در JSON (<، >، &) برای دفاع عمقی در برابر XSS وقتی
// پاسخ در یک زمینهٔ HTML تفسیر شود؛ JSON.parse مرورگر مقدار اصلی را برمی‌گرداند.
app.set('json escape', true);
// بدنهٔ JSON در این برنامه کوچک است (فهرست شناسه‌ها، تنظیمات، موقعیت نقشه) و فایل‌های
// حجیم از طریق multipart و با محدودیت حجم جداگانه بارگذاری می‌شوند.
app.use(express.json({ limit: '2mb', strict: true }));
// فقط وقتی صریحاً پشت پروکسی معکوس هستید فعال کنید؛ در غیر این صورت هدر
// X-Forwarded-For قابل جعل است و سقف نرخ/حسابرسی را دور می‌زند.
// فقط وقتی صریحاً پشت پروکسی معکوس هستید فعال کنید؛ در غیر این صورت هدر
// X-Forwarded-For قابل جعل است و سقف نرخ/حسابرسی را دور می‌زند. مقدار در
// config.js اعتبارسنجی شده است.
if (config.trustProxy !== null) app.set('trust proxy', config.trustProxy);
app.use('/api', validateRequestUrl);
app.use('/api', validateJsonBody);

/**
 * سنجش تأخیر API در همان نقطه‌ای که پاسخ بسته می‌شود. مسیر SSE درخواست دائمی
 * است و در تأخیر API شمرده نمی‌شود؛ بدنه/هدرها هرگز ثبت نمی‌شوند.
 */
app.use('/api', (req, res, next) => {
  if (req.path === '/events') return next();
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    recordApi(req.method, req.originalUrl || req.url, res.statusCode, ms);
  });
  return next();
});

/* --------------------- سخت‌سازی پایه HTTP ---------------------- */

// درخواست‌های تغییردهنده داده فقط از همان مبدأ پذیرفته می‌شوند؛ این گارد جلوی
// سوءاستفاده از سرویس روی شبکه محلی (CSRF) را می‌گیرد. کلاینت‌های غیرمرورگری
// (curl، موتور مستقل، اسکریپت‌ها) هدر Origin نمی‌فرستند و مسدود نمی‌شوند.
function sameOriginOnly(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.get('origin');
  if (!origin) return next();
  let originHost = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    /* Origin نامعتبر */
  }
  // میزبان‌های معتبر این درخواست: هدر Host و (در صورت وجود پروکسی معکوس) X-Forwarded-Host.
  // مرورگر برای درخواست‌های تغییردهنده همیشه Origin می‌فرستد و مقدارش همان میزبانی است که
  // کاربر صفحه را از آن باز کرده؛ هدر X-Forwarded-Host را هم فقط سرورِ پروکسی می‌گذارد
  // (مرورگر اجازهٔ ارسال آن را در درخواست میان‌مبدأ ندارد).
  const allowed = [req.get('host'), `localhost:${PORT}`, `127.0.0.1:${PORT}`].filter(Boolean);
  // X-Forwarded-Host فقط وقتی معتبر است که مدیر صریحاً Trusted Proxy را تنظیم
  // کرده باشد؛ در غیر این صورت یک کلاینت غیرمرورگری می‌توانست با جعل آن، بررسی
  // Origin را دور بزند. مرورگر اجازهٔ ارسال این هدر در درخواست میان‌مبدأ را ندارد.
  if (config.trustProxy !== null) {
    const forwardedHost = (req.get('x-forwarded-host') || '').split(',')[0].trim();
    if (forwardedHost) allowed.push(forwardedHost);
  }
  if (!originHost || !allowed.includes(originHost)) {
    log('warn', `درخواست تغییردهنده از مبدأ غیرمجاز رد شد: ${origin} → ${req.method} ${req.originalUrl} (Host=${req.get('host')}, X-Forwarded-Host=${req.get('x-forwarded-host') || '—'})`);
    return res.status(403).json({ error: 'درخواست از یک مبدأ نامعتبر ارسال شده است.' });
  }
  return next();
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  // وقتی سرویس با HTTPS اجرا می‌شود، مرورگر به نسخهٔ ناامن برنمی‌گردد.
  // با NETWATCH_HSTS=0 می‌توان این هدر را خاموش کرد (مثلاً استفادهٔ موقت از گواهی خودامضا).
  if (config.tls.enabled && config.tls.hsts) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
  // CSP فقط در اجرای تولیدی اعمال می‌شود؛ Vite در حالت توسعه برای HMR به
  // اسکریپت درون‌خطی و اتصال وب‌سوکت نیاز دارد.
  if (!DEV) {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self'",
        // کتابخانهٔ نقشهٔ برداری (MapLibre) کارگر خود را از یک blob می‌سازد
        "worker-src 'self' blob:",
        "child-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
      ].join('; ')
    );
  }
  next();
});

// لاگ درخواست‌های پرخطا/کند به‌صورت JSON؛ ثبت همهٔ درخواست‌ها در نصب ۱۰۰۰
// تجهیز فقط نویز و بار اضافه می‌سازد، پس فقط رخدادهای مهم ثبت می‌شوند.
app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
    if (res.statusCode >= 500 || ms >= 2000 || res.statusCode === 429) {
      logEvent(res.statusCode >= 500 ? 'error' : 'warn', 'http_request', {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        ms,
        ip: req.ip,
      });
    }
  });
  next();
});

app.use('/api', sameOriginOnly);

// سقف نرخ: یک سقف عمومی برای همهٔ API و سقف‌های مستقل برای Probe، ورود/خروجی
// فایل و APIهای مدیریتی. سقف‌های مستقل بعد از احراز هویت نصب می‌شوند تا
// محدودیت «حساب کاربری» هم قابل اعمال باشد (نه فقط IP).
const rl = config.rateLimit;
const generalLimiter = createRateLimiter({ name: 'عمومی', windowMs: rl.windowMs, max: rl.general, maxKeys: rl.maxKeys });
const probeLimiter = createRateLimiter({
  name: 'Probe',
  windowMs: rl.windowMs,
  max: rl.probe,
  maxKeys: rl.maxKeys,
  accountKey: (req) => req.user?.id ?? null,
});
const importLimiter = createRateLimiter({
  name: 'ورود/خروجی فایل',
  windowMs: rl.windowMs,
  max: rl.import,
  maxKeys: rl.maxKeys,
  accountKey: (req) => req.user?.id ?? null,
});
const adminLimiter = createRateLimiter({
  name: 'مدیریتی',
  windowMs: rl.windowMs,
  max: rl.admin,
  maxKeys: rl.maxKeys,
  accountKey: (req) => req.user?.id ?? null,
});
const topologyLimiter = createRateLimiter({
  name: 'Poll توپولوژی',
  windowMs: rl.windowMs,
  max: rl.topologyPoll,
  maxKeys: rl.maxKeys,
  accountKey: (req) => req.user?.id ?? null,
});
app.use('/api', generalLimiter);

/* --------------------------- احراز هویت --------------------------- */
// ترتیب مهم است: ابتدا کاربر از کوکی نشست خوانده می‌شود، سپس حسابرسی (تا
// درخواست‌های ردشده هم ثبت شوند)، بعد گارد ورود + CSRF روی همهٔ APIها. مسیرهای
// عمومی (ورود و سلامت) در requireAuth استثنا هستند؛ خروج و /auth/me مستثنا نیستند.
app.use('/api', attachUser);
app.use('/api', auditMutations);
app.use('/api', requireAuth, csrfGuard);
// محدودیت شبکه‌ای APIهای مدیریتی (اختیاری، NETWATCH_ADMIN_ALLOWED_CIDRS).
// پس از احراز هویت اجرا می‌شود تا ip کاربر و نامش در لاگ رد شدن ثبت شود.
app.use('/api', createAdminNetworkGuard({ adminCidrs: config.auth.adminCidrs }));
// اکنون req.user (در صورت ورود) در دسترس است؛ سقف حساب کاربری هم اعمال می‌شود.
app.use('/api', (req, res, next) => (isProbeRequest(req) ? probeLimiter(req, res, next) : next()));
app.use('/api', (req, res, next) => (isTopologyPollRequest(req) ? topologyLimiter(req, res, next) : next()));
app.use('/api', (req, res, next) => (isImportRequest(req) ? importLimiter(req, res, next) : next()));
app.use('/api', (req, res, next) => (isAdminRequest(req) ? adminLimiter(req, res, next) : next()));
app.use('/api/auth', authRouter);
// پاسخ‌های API داده‌های عملیاتی/کاربری دارند و نباید در کش مشترک بمانند.
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

/* ------------------------------ SSE ------------------------------ */
// مدیریت فشار برگشتی در sse.js انجام می‌شود: فریم‌های قابل‌جایگزینی (نمونه/
// وضعیت) برای کلاینت کند حذف می‌شوند و اگر بافر او از سقف بگذرد، اتصال بسته
// می‌شود تا حافظهٔ سرور بی‌مرز رشد نکند.
const sse = createSseHub();

app.get('/api/events', requirePermission('dashboard:read'), (req, res) => {
  // سقف اتصال‌ها: هر اتصال زنده یک پاسخ باز نگه می‌دارد؛ بدون سقف، چند تب خراب
  // یا یک کلاینت ناشناس می‌تواند حافظهٔ سرور را به پایان برساند.
  const client = sse.add(req, res, { ts: Date.now(), engine: engine.getStatus() });
  if (!client) {
    return res.status(503).setHeader('Retry-After', '10').json({ error: 'ظرفیت اتصال‌های زنده پر است.' });
  }
  return undefined;
});

function broadcast(event, data, options = {}) {
  return sse.broadcast(event, data, options);
}

// دسته‌بندی نمونه‌ها برای کاهش ترافیک
let sampleBatch = [];
let flushTimer = null;
bus.on('sample', (s) => {
  sampleBatch.push(s);
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      broadcast('samples', sampleBatch);
      sampleBatch = [];
      flushTimer = null;
    }, 900);
  }
});
bus.on('status', (s) => broadcast('status', s));
// هشدارها مهم‌اند: در فشار برگشتی هم تلاش می‌شود (مگر بافر از سقف بگذرد)
bus.on('alert', (a) => broadcast('alert', a, { critical: true }));
bus.on('alert-resolved', (a) => broadcast('alert-resolved', a, { critical: true }));
bus.on('engine', (s) => broadcast('engine', s));
bus.on('alerts-changed', (s) => broadcast('alerts-changed', s));

/* ------------------------------ API ------------------------------ */
/* ------------------------------ سلامت ------------------------------ */

/**
 * سلامت عمومی: فقط «زنده/مرده» و وضعیت پایگاه‌داده. هیچ نسخه، مسیر فایل،
 * جزئیات موتور، آمار SSE یا شمار تجهیزات افشا نمی‌شود.
 */
function publicHealthPayload() {
  let ok = true;
  try {
    db.prepare('SELECT 1 AS ok').get();
  } catch {
    ok = false;
  }
  return { ok, status: ok ? 'ok' : 'fail', ts: Date.now() };
}

function sendPublicHealth(_req, res) {
  const body = publicHealthPayload();
  res.status(body.ok ? 200 : 503).setHeader('Cache-Control', 'no-store').json(body);
}

/**
 * سلامت تفصیلی برای مانیتورینگ مجاز (Operator/Administrator). پاسخ ۵۰۳ فقط
 * وقتی پایگاه‌داده واقعاً پاسخ نمی‌دهد؛ توقف یا کهنگی موتور وضعیت degraded است.
 */
let dbHealthCache = { at: 0, value: null };
function cachedDbHealth() {
  if (Date.now() - dbHealthCache.at < 30000) return dbHealthCache.value;
  const value = checkDatabaseHealth({ full: false });
  dbHealthCache = { at: Date.now(), value };
  return value;
}

function detailedHealthPayload() {
  let dbOk = true;
  let devices = null;
  try {
    devices = db.prepare('SELECT COUNT(*) c FROM devices').get().c;
  } catch {
    dbOk = false;
  }
  const health = dbOk ? cachedDbHealth() : { ok: false, errors: ['اتصال پایگاه‌داده پاسخ نداد'] };
  let wal = null;
  try {
    wal = db.walInfo();
  } catch {
    /* پایگاه‌داده پاسخ نداد؛ وضعیت WAL گزارش نمی‌شود */
  }
  const st = engine.getStatus();
  const now = Date.now();
  const staleMs = st.lastRunAt ? now - st.lastRunAt : null;
  const expectedMs = Number(st.interval || 30) * 1000;
  const stale = st.running && staleMs != null && staleMs > expectedMs * 3 + 5000;
  const status = !dbOk ? 'fail' : !st.running || stale ? 'degraded' : 'ok';
  return {
    ok: dbOk,
    status,
    uptime: process.uptime(),
    version: APP_VERSION,
    devices,
    db: {
      ok: dbOk && health.ok !== false,
      health,
      wal,
      disk: diskSpace(),
      backups: backupStatus(),
    },
    tls: tlsEnabled,
    engine: { ...st, staleMs, expectedIntervalMs: expectedMs, stale },
    sse: sse.stats(),
    jobs: jobStats(),
    probes: probeQueue.snapshot(),
    probeJobs: probeJobStats(),
    ts: now,
  };
}

function sendDetailedHealth(_req, res) {
  const body = detailedHealthPayload();
  res.status(body.ok ? 200 : 503).setHeader('Cache-Control', 'no-store').json(body);
}

app.get('/health', sendPublicHealth);
app.get('/api/health', sendPublicHealth);
app.get('/api/system/health', requirePermission('system:health'), sendDetailedHealth);

/**
 * Application Health: سنجه‌های منابع خود برنامه + تاریخچهٔ کوتاه برای نمودار.
 * فقط شاخص‌های سلامت برنامه است (نه دادهٔ تجهیزات) و برای نقش‌های دارای
 * مجوز `system:health` قابل مشاهده است. هیچ مسیر فایل یا راز افشا نمی‌شود.
 */
app.get('/api/system/app-health', requirePermission('system:health'), (_req, res) => {
  const now = Date.now();
  const st = engine.getStatus();
  let wal = null;
  try {
    wal = db.walInfo();
  } catch {
    /* پایگاه‌داده پاسخ نداد؛ سنجهٔ WAL گزارش نمی‌شود */
  }
  let dbBytes = null;
  try {
    dbBytes = fs.statSync(DB_PATH).size;
  } catch {
    /* فایل در دسترس نیست */
  }
  const backup = (() => {
    try {
      const b = backupStatus();
      return {
        enabled: !!b.policy?.enabled,
        lastBackupAt: b.lastBackupAt ?? null,
        count: b.count,
        running: !!b.running,
        intervalHours: b.policy?.intervalHours ?? null,
      };
    } catch {
      return null;
    }
  })();
  const retention = (() => {
    try {
      const r = retentionStatus();
      return {
        lastStatus: r.lastStatus,
        lastRunAt: r.lastRun?.startedAt ?? null,
        lastFinishedAt: r.lastRun?.finishedAt ?? null,
        lastDeletedRows: r.lastDeletedRows,
        nextRunAt: r.nextRunAt,
        running: !!r.running,
      };
    } catch {
      return null;
    }
  })();
  const metrics = metricsSnapshot();
  const jobs = (() => {
    try {
      const j = jobStats();
      return { queued: j.queued ?? 0, running: j.running ?? 0, rejected: j.rejected ?? 0, activeWorkers: j.activeWorkers ?? 0, maxConcurrency: j.maxConcurrency ?? 0 };
    } catch {
      return { queued: 0, running: 0, rejected: 0, activeWorkers: 0, maxConcurrency: 0 };
    }
  })();
  const body = {
    generatedAt: now,
    ok: metrics.memory.rssBytes < 2 * 1024 ** 3 && metrics.eventLoop.p99 < 1000,
    process: metrics,
    db: {
      sizeBytes: dbBytes,
      walBytes: wal?.walBytes ?? wal?.bytes ?? null,
      wal,
      queries: queryStats({ top: 8 }),
    },
    engine: {
      running: st.running,
      leader: st.leader,
      mode: st.mode,
      simulation: st.simulation,
      activeProbes: st.inflight,
      maxWorkers: st.maxWorkers,
      queueDepth: st.queueDepth ?? st.backlog ?? 0,
      backlog: st.backlog ?? 0,
      lastCycleAt: st.lastRunAt,
      lastCycleMs: st.lastCycleMs ?? null,
      lastTickMs: st.lastTickMs ?? null,
      lastTickReady: st.lastTickReady ?? 0,
      lastTickLaunched: st.lastTickLaunched ?? 0,
      checksRun: st.checksRun ?? 0,
      scheduling: st.scheduling,
      stalled: !!st.stalled,
      tickLagMs: st.tickLagMs ?? 0,
    },
    sse: sse.stats(),
    jobs,
    probes: probeQueue.snapshot(),
    probeJobs: probeJobStats(),
    api: apiStats({ top: 12 }),
    backup,
    retention,
    history: historySnapshot(360),
  };
  return res.setHeader('Cache-Control', 'no-store').json(body);
});

/**
 * سلامت «برنامه» (نه شبکه) برای داشبورد و نوار وضعیت.
 * محاسبهٔ آزاد فایل پشتیبان و حجم پایگاه‌داده نسبتاً گران است؛ نتیجه چند ثانیه
 * کش می‌شود تا چند تب باز، دیسک را چند بار در دقیقه اسکن نکنند. فقط اعداد و
 * وضعیت‌های بی‌خطر برگردانده می‌شود؛ هیچ مسیر فایلی افشا نمی‌شود.
 */
let appHealthCache = { at: 0, body: null };
function appHealthSummary(serverOk, now) {
  if (appHealthCache.body && now - appHealthCache.at < 10000) return appHealthCache.body;
  let dbBytes = null;
  try {
    dbBytes = fs.statSync(DB_PATH).size;
  } catch {
    /* فایل پایگاه‌داده در دسترس نیست؛ حجم گزارش نمی‌شود */
  }
  let lastProbeOkAt = null;
  let lastStatusChangeAt = null;
  if (serverOk) {
    try {
      lastProbeOkAt = db.prepare('SELECT ts FROM samples WHERE ok=1 ORDER BY ts DESC LIMIT 1').get()?.ts ?? null;
      lastStatusChangeAt = db.prepare('SELECT MAX(last_status_change_at) AS at FROM devices').get()?.at ?? null;
    } catch {
      /* پرس‌وجوی آماری نباید وضعیت اصلی سرور را خراب کند */
    }
  }
  let backup;
  try {
    const b = backupStatus();
    const intervalMs = Math.max(1, Number(b.policy?.intervalHours) || 24) * 3600 * 1000;
    backup = {
      enabled: !!b.policy?.enabled,
      count: b.count,
      lastBackupAt: b.lastBackupAt,
      running: !!b.running,
      restoring: !!b.restoring,
      ok: !b.policy?.enabled || (!!b.lastBackupAt && now - b.lastBackupAt <= intervalMs * 2),
    };
  } catch {
    backup = { enabled: false, count: 0, lastBackupAt: null, running: false, restoring: false, ok: false };
  }
  let disk;
  try {
    const d = diskSpace();
    disk = { freeBytes: d.freeBytes ?? null, minFreeBytes: d.minFreeBytes, ok: (d.freeBytes ?? 0) > d.minFreeBytes };
  } catch {
    disk = { freeBytes: null, minFreeBytes: 0, ok: false };
  }
  let jobs = { queued: 0, running: 0, rejected: 0 };
  try {
    const j = jobStats();
    jobs = { queued: j.queued ?? 0, running: j.running ?? 0, rejected: j.rejected ?? 0 };
  } catch {
    /* بی‌اثر */
  }
  const body = {
    db: { ok: serverOk, sizeBytes: dbBytes },
    sse: sse.stats(),
    backup,
    disk,
    probe: { lastSuccessAt: lastProbeOkAt, lastStatusChangeAt },
    jobs,
    generatedAt: now,
  };
  appHealthCache = { at: now, body };
  return body;
}

/**
 * وضعیت سبک و مستقل برای نوار وضعیت رابط کاربری:
 *   • server  → آیا خود API/پایگاه‌داده پاسخ می‌دهد؟
 *   • engine  → موتور در حال اجراست؟ رهبر است؟ آخرین چرخه‌اش کهنه است؟
 *   • devices → جدا از موتور، چند تجهیز وصل/قطع هستند؟
 *   • app     → سلامت برنامه (دیتابیس، SSE، پشتیبان، دیسک، آخرین Probe)
 * این پاسخ هیچ مسیر فایل، نسخه یا جزئیات حساسی افشا نمی‌کند.
 */
app.get('/api/status', (_req, res) => {
  const now = Date.now();
  // بدون کش: چند COUNT ایندکس‌شده ارزان‌اند و وضعیت باید بلافاصله پس از
  // تغییر تجهیزات/موتور درست باشد (کش ۲ ثانیه‌ای، شمارش را کهنه نشان می‌داد).
  let serverOk = true;
  try {
    db.prepare('SELECT 1').get();
  } catch {
    serverOk = false;
  }
  let counts = [];
  let total = 0;
  let monitoring = 0;
  if (serverOk) {
    try {
      counts = db.prepare('SELECT status, COUNT(*) AS c FROM devices WHERE enabled = 1 GROUP BY status').all();
      total = db.prepare('SELECT COUNT(*) AS c FROM devices').get().c;
      monitoring = db.prepare('SELECT COUNT(*) AS c FROM devices WHERE enabled=1 AND monitoring_enabled=1').get().c;
    } catch {
      serverOk = false;
    }
  }
  const byStatus = Object.fromEntries(counts.map((r) => [r.status, r.c]));
  const up = (byStatus.online || 0) + (byStatus.warning || 0);
  const down = byStatus.offline || 0;
  const inactive = Math.max(0, total - up - down);
  const st = engine.getStatus();
  const staleMs = st.lastRunAt ? now - st.lastRunAt : null;
  const expectedMs = Number(st.interval || 30) * 1000;
  const stale = !!st.running && staleMs != null && staleMs > expectedMs * 3 + 5000;
  const body = {
    server: { ok: serverOk, ts: now, uptime: Math.round(process.uptime()) },
    engine: { ...st, stale, staleMs },
    devices: { total, up, down, inactive, monitoring },
    app: appHealthSummary(serverOk, now),
    generatedAt: now,
  };
  return res.setHeader('Cache-Control', 'no-store').json(body);
});

// پیوست‌ها پیش از Router تجهیزات سوار می‌شوند تا مسیرهای `/:id/attachments`
// بدون تکیه بر ترتیب تطبیق مسیرها همیشه در دسترس باشند.
app.use('/api/devices', attachmentsRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/discovery', discoveryRouter);
app.use('/api/templates', templatesRouter);
app.use('/api/conflicts', conflictsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/reports', reportsRouter);
app.use('/api', opsRouter);
app.use('/api', inventoryRouter);
app.use('/api', markersRouter);
// سلسله‌مراتب پایدار پیش از Router دیاگرام سوار می‌شود تا مسیرهای
// `/api/topology/hierarchy` هرگز به مسیرهای دیاگرام نرسند.
app.use('/api/topology/hierarchy', topologyHierarchyRouter);
app.use('/api', topologyRouter);
app.use('/api/audit', auditRouter);
app.use('/api/system', systemRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: 'مسیر یافت نشد' }));

const UPLOAD_MESSAGES = {
  LIMIT_FILE_SIZE: 'حجم فایل بارگذاری‌شده بیش از حد مجاز است.',
  LIMIT_FILE_COUNT: 'تعداد فایل‌های بارگذاری‌شده بیش از حد مجاز است.',
  LIMIT_FIELD_VALUE: 'یکی از فیلدهای فرم بیش از حد مجاز است.',
  LIMIT_PART_COUNT: 'تعداد بخش‌های فرم بیش از حد مجاز است.',
  LIMIT_UNEXPECTED_FILE: 'فیلد فایل ناشناخته است.',
  BAD_EXTENSION: 'فقط فایل با پسوند .mbtiles پذیرفته می‌شود.',
  BAD_SPREADSHEET_EXTENSION: 'فقط فایل با پسوند .xlsx، .xls یا .csv پذیرفته می‌شود.',
  STORAGE_LOW: 'فضای ذخیره‌سازی سرور برای بارگذاری این فایل کافی نیست.',
};

const JSON_BODY_MESSAGES = {
  'entity.too.large': 'حجم بدنهٔ درخواست بیش از حد مجاز است.',
  'entity.parse.failed': 'بدنهٔ درخواست JSON معتبر نیست.',
  'entity.unsupported.charset': 'کدگذاری بدنهٔ درخواست پشتیبانی نمی‌شود.',
};

app.use((err, req, res, _next) => {
  const known = UPLOAD_MESSAGES[err.code] || JSON_BODY_MESSAGES[err.type];
  const status = known
    ? Number(err.status || err.statusCode || (err.type === 'entity.too.large' || String(err.code).startsWith('LIMIT_') ? 413 : 400))
    : Number(err.status || err.statusCode || 500);
  log('error', `خطای سرور: ${err.message}`);
  logEvent('error', 'request_error', { method: req.method, path: req.originalUrl, status, code: err.code || err.type });
  // پیام خطاهای کلاینتی (۴xx) برای کاربر مفید است، اما جزئیات خطاهای داخلی
  // (مسیر فایل، پرس‌وجوی SQL و…) نباید برای کلاینت فاش شود. Stack Trace در
  // هیچ حالتی در پاسخ نمی‌آید.
  const message =
    known ||
    (status < 500 ? err.message || 'درخواست نامعتبر است.' : 'خطای داخلی سرور رخ داد. جزئیات در گزارش رویدادهای سرور ثبت شد.');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({ error: message });
});

/* ------------------------------ HTTPS ------------------------------ */
// اجرای سرویس روی شبکهٔ داخلی بدون اینترنت: گواهی با `npm run tls:setup`
// به‌صورت محلی ساخته می‌شود و این‌جا فقط فایل‌هایش خوانده می‌شوند.
//   NETWATCH_TLS_DIR=data/tls            → server.crt/server.key (+ ca.crt اگر باشد)
//   NETWATCH_TLS_CERT=/path/server.crt NETWATCH_TLS_KEY=/path/server.key
let tlsEnabled = false;
let tlsFiles = null;

function readTlsFiles() {
  const tlsCfg = config.tls;
  if (!tlsCfg.enabled) return null;
  const certPath = tlsCfg.certPath;
  const keyPath = tlsCfg.keyPath;
  const caPath = tlsCfg.caPath && fs.existsSync(tlsCfg.caPath) ? tlsCfg.caPath : null;
  if (!certPath || !keyPath) {
    throw new Error('برای HTTPS باید هم NETWATCH_TLS_CERT و هم NETWATCH_TLS_KEY تنظیم شود (یا فقط NETWATCH_TLS_DIR).');
  }
  for (const [label, file] of [
    ['گواهی', certPath],
    ['کلید', keyPath],
    ['CA', caPath],
  ]) {
    if (file && !fs.existsSync(file)) throw new Error(`فایل ${label} پیدا نشد: ${file}`);
  }
  return {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
    ca: caPath ? fs.readFileSync(caPath) : undefined,
    files: { certPath, keyPath, caPath },
  };
}

/* --------------------------- رابط کاربری --------------------------- */
let tls = null;
try {
  tls = readTlsFiles();
} catch (e) {
  console.error(`\n  راه‌اندازی HTTPS ناموفق بود: ${e.message}\n`);
  process.exit(1);
}
if (tls) {
  tlsEnabled = true;
  tlsFiles = tls.files;
}

const server = tls ? https.createServer({ key: tls.key, cert: tls.cert, ca: tls.ca }, app) : http.createServer(app);
// محدودیت‌های HTTP: درخواست نیمه‌کاره/کند (Slowloris) و هدرهای حجیم نمی‌توانند
// اتصال را بی‌پایان باز نگه دارند. keep-alive کوتاه است تا سوکت‌های idle سریع
// آزاد شوند و خاموشی سرویس معطل نماند.
server.requestTimeout = config.http.requestTimeoutMs;
server.headersTimeout = config.http.headersTimeoutMs;
server.keepAliveTimeout = config.http.keepAliveTimeoutMs;
server.maxHeadersCount = config.http.maxHeadersCount;
const scheme = tlsEnabled ? 'https' : 'http';

// ریدایرکت اختیاری HTTP → HTTPS (وقتی اپراتور NETWATCH_HTTP_PORT را تنظیم کند)
let redirectServer = null;

async function boot() {
  if (DEV) {
    const { createServer: createViteServer } = await import('vite');
    const extraHosts = (process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS || '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    const vite = await createViteServer({
      configFile: path.join(ROOT, 'web', 'vite.config.ts'),
      appType: 'spa',
      server: {
        middlewareMode: true,
        // Vite 8 جای hmr.server را با ws.server گرفته است؛ کانال HMR روی همان
        // سرور HTTP اجرا می‌شود تا در حالت توسعه، API و رابط یک پورت داشته باشند.
        ws: { server },
        allowedHosts: [...new Set(['localhost', '127.0.0.1', ...extraHosts])],
      },
    });
    app.use(vite.middlewares);
  } else {
    const dist = path.join(ROOT, 'web', 'dist');
    if (fs.existsSync(dist)) {
      app.use(
        express.static(dist, {
          index: false,
          maxAge: '1h',
          // دارایی‌های دارای هش محتوا می‌توانند طولانی کش شوند، اما index.html
          // باید همیشه تازه بماند تا پس از به‌روزرسانی، رابط قدیمی سرو نشود.
          setHeaders: (res, filePath) => {
            if (path.basename(filePath) === 'index.html') res.setHeader('Cache-Control', 'no-cache');
            else if (path.basename(filePath).match(/-[A-Za-z0-9_]{8}\./)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          },
        })
      );
      // Express 5 الگوی `*` را نمی‌پذیرد؛ `/{*splat}` هم مسیر ریشه و هم
      // مسیرهای تودرتو را می‌گیرد (بقیهٔ مسیرهای API پیش از این ثبت شده‌اند).
      app.get('/{*splat}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
    } else {
      app.get('/{*splat}', (_req, res) =>
        res
          .status(503)
          .type('html')
          .send('<h3>نسخه تولیدی ساخته نشده است.</h3><p>ابتدا <code>npm run build</code> را اجرا کنید یا برنامه را در حالت توسعه با <code>npm run dev</code> بالا بیاورید.</p>')
      );
    }
  }

  server.listen(PORT, HOST, () => {
    const addr = server.address();
    console.log(`\n  NetWatch  ▸  ${scheme}://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${addr.port}`);
    console.log(`  حالت: ${DEV ? 'توسعه (Vite + HMR)' : 'تولیدی'}   |   پایگاه‌داده: ${DB_PATH}`);
    console.log(`  موتور مانیتورینگ: ${getSettings().engine_mode}`);
    if (tlsEnabled) {
      console.log(`  HTTPS فعال است   |   گواهی: ${tlsFiles.certPath}`);
      if (!tlsFiles.caPath) {
        console.log('  توجه: فایل ca.crt پیدا نشد؛ کلاینت‌ها ممکن است خطای اعتماد گواهی بگیرند.');
      }
    }
    console.log('');
    logEvent('info', 'server_listen', {
      host: HOST,
      port: addr.port,
      dev: DEV,
      tls: tlsEnabled,
      dbPath: DB_PATH,
      engineMode: getSettings().engine_mode,
    });
  });

  // HTTP → HTTPS: کاربران با تایپ آدرس بدون https هم به نسخهٔ امن می‌رسند
  const redirectPort = config.tls.httpPort;
  if (tlsEnabled && redirectPort) {
    redirectServer = http.createServer((req, res) => {
      const host = String(req.headers.host || '').split(':')[0] || HOST;
      const target = `${scheme}://${host}${Number(PORT) === 443 ? '' : `:${PORT}`}${req.url || '/'}`;
      res.writeHead(308, { Location: target, 'Cache-Control': 'no-store' });
      res.end();
    });
    redirectServer.listen(redirectPort, HOST, () => {
      console.log(`  ریدایرکت HTTP → HTTPS روی پورت ${redirectPort} فعال است.\n`);
      logEvent('info', 'http_redirect_listen', { host: HOST, port: redirectPort, targetPort: PORT });
    });
    redirectServer.on('error', (err) => {
      console.error(`  خطای ریدایرکت HTTP (پورت ${redirectPort}): ${err.message}\n`);
    });
  }

  // نمونه‌گیری منابع برای صفحهٔ Application Health (حافظهٔ ثابت: ۱ ساعت تاریخچه)
  startSampling(5000);
  startSessionSweeper();
  // Retention Engine مستقل: نگهداری داده، Dry-Run، قفل تک‌نمونه و گزارش.
  // پاک‌سازی حسابرسی هم از همین مسیر انجام می‌شود (نه دو زمان‌بند موازی).
  startRetentionScheduler({ isLeader: () => engine.getStatus().leader || !config.engine.enabled });
  // پشتیبان‌گیری خودکار + Checkpoint دوره‌ای WAL (فقط نمونهٔ رهبر موتور)
  startBackupScheduler({ isLeader: () => engine.getStatus().leader || !config.engine.enabled });
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log(`  توجه: این سرویس روی ${HOST} منتشر شده است؛`);
    console.log('        ورود الزامی است و مجوزها بر اساس نقش (Administrator/Operator/Viewer) اعمال می‌شوند.');
    console.log('        برای امنیت بیشتر، TLS و فایروال/پروکسی معکوس را فعال کنید.\n');
  }

  logEvent('info', 'config_loaded', configSummary(config));
  for (const warning of config.warnings) log('warn', warning);

  if (config.engine.enabled) {
    await engine.start();
    if (!engine.getStatus().leader) {
      console.log('  توجه: موتور دیگری (مثلاً engine-cli) قفل رهبری را دارد؛ این نمونه Ping نمی‌زند و در حالت آماده‌به‌کار است.\n');
    }
  } else {
    console.log('  موتور مانیتورینگ غیرفعال است (NETWATCH_ENGINE=0).');
  }

  // کشف شبکه: فقط رهبر موتور اسکن روزانه را اجرا می‌کند. هشدار تجهیز جدید از
  // همان کانال SSE هشدارها منتشر می‌شود تا مدیر بدون بازخوانی صفحه مطلع شود.
  startDiscoveryScheduler({
    isLeader: () => engine.getStatus().leader || !config.engine.enabled,
    onNew: (alerts) => {
      for (const a of alerts) bus.emit('alert', a);
    },
  });
}

let shuttingDown = false;
let finished = false;
let forceTimer = null;
const SHUTDOWN_GRACE_MS = config.shutdownTimeoutMs;

/**
 * خاموش‌سازی مرتب منابع:
 *   1) موتور: توقف پذیرش، تمدید/تخلیهٔ بررسی‌های در جریان، سپس آزادسازی قفل.
 *   2) تایمرهای دوره‌ای (نشست، حسابرسی، پشتیبان، دسته‌بندی SSE) و Workerها.
 *   3) اتصال‌های SSE و HTTP و پایگاه‌داده.
 * اگر مرحله‌ای در مهلت تمام نشود، مسیر اجباری همیشه خروج تمیز (WAL + بستن)
 * را انجام می‌دهد؛ هیچ تایمر/Worker بدون مالک باقی نمی‌ماند.
 */
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n  در حال خاموش‌سازی…');
  logEvent('info', 'shutdown_start', { code });
  try {
    await engine.stop({ drainMs: config.shutdownTimeoutMs });
  } catch (e) {
    log('warn', `توقف موتور با خطا مواجه شد: ${e?.message || e}`);
  }
  // دسته‌بندی نمونه‌ها ممکن است یک تایمر فعال داشته باشد؛ پیش از بستن SSE و DB
  // باید آزاد شود وگرنه پس از خاموشی تلاش برای نوشتن روی پاسخ بسته می‌کند.
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  sampleBatch = [];
  bus.removeAllListeners();
  try {
    sse.closeAll();
  } catch {}
  // پس از پایان SSE، سوکت‌های idle بسته می‌شوند تا server.close منتظر
  // keep-alive نماند؛ اتصال‌های در جریان پس از مهلت اجباری بسته می‌شوند.
  try {
    server.closeIdleConnections?.();
  } catch {}
  try {
    shutdownJobs('shutdown');
  } catch {}
  try {
    probeQueue.shutdown();
  } catch {}
  try {
    stopSessionSweeper();
  } catch {}
  try {
    closeAuthLimiters();
  } catch {}
  try {
    stopRetentionScheduler();
  } catch {}
  try {
    stopDiscoveryScheduler();
  } catch {}
  // اسکن کشف شبکه سوكت‌های باز دارد؛ پیش از بستن پایگاه‌داده متوقف و تا پایان
  // مهلت کوتاه منتظر می‌مانیم تا هیچ نوشتنی روی DB بسته انجام نشود (BUG-20).
  try {
    if (requestDiscoveryStop()) await waitForDiscoveryScan(2000);
  } catch {}
  try {
    requestRetentionStop();
  } catch {}
  try {
    stopAuditSweeper();
  } catch {}
  for (const limiter of [generalLimiter, probeLimiter, topologyLimiter, importLimiter, adminLimiter]) {
    try {
      limiter.close?.();
    } catch {
      /* بی‌اثر */
    }
  }
  try {
    redirectServer?.close();
  } catch {}
  server.close(() => finish(code));
  // اتصال‌های بی‌کار/گیرکرده پس از مهلت بسته می‌شوند تا خروج معطل نماند.
  forceTimer = setTimeout(() => {
    try {
      server.closeAllConnections?.();
    } catch {
      /* بی‌اثر */
    }
    finish(code);
  }, Math.max(2500, Math.min(10000, SHUTDOWN_GRACE_MS)));
  if (forceTimer.unref) forceTimer.unref();
}

function finish(code) {
  if (finished) return;
  finished = true;
  if (forceTimer) clearTimeout(forceTimer);
  forceTimer = null;
  // پشتیبان‌گیری/Checkpoint متوقف و WAL پیش از بستن، به فایل اصلی منتقل می‌شود.
  // این کار «خاموشی تمیز» را تضمین می‌کند و دفعهٔ بعد بازگشایی سریع است.
  try {
    stopRetentionScheduler();
  } catch {}
  try {
    stopBackupScheduler();
  } catch {}
  try {
    stopSampling();
  } catch {}
  try {
    runCheckpoint('shutdown');
  } catch {}
  try {
    db.close();
  } catch {}
  logEvent('info', 'shutdown_done', { code });
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

// پایداری: یک خطای مهارنشده نباید سرور را بی‌صدا از کار بیندازد — ثبت می‌شود و
// فرآیند با خاموش‌سازی مرتب (نوشتن WAL و بستن پایگاه‌داده) پایان می‌یابد.
process.on('uncaughtException', (err) => {
  log('error', `خطای مهارنشده: ${err?.stack || err?.message || err}`);
  logEvent('error', 'uncaught_exception', { message: err?.message, stack: err?.stack });
  console.error('\n  خطای مهارنشده:', err?.message || err);
  void shutdown(1);
});
process.on('unhandledRejection', (reason) => {
  log('error', `وعدهٔ ردشدهٔ مهارنشده: ${reason?.stack || reason?.message || reason}`);
  logEvent('error', 'unhandled_rejection', { message: reason?.message ?? String(reason), stack: reason?.stack });
  console.error('\n  وعدهٔ ردشدهٔ مهارنشده:', reason?.message || reason);
  void shutdown(1);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  پورت ${PORT} در حال استفاده است. پورت دیگری را با PORT=… تنظیم کنید.`);
    process.exit(1);
  }
  console.error('\n  خطای سرور HTTP:', err.message);
  process.exit(1);
});

boot().catch((e) => {
  console.error('راه‌اندازی ناموفق:', e);
  process.exit(1);
});
