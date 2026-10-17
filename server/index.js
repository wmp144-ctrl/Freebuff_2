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
import { fileURLToPath } from 'node:url';
import express from 'express';

import { db, getSettings, seedIfEmpty, log, DB_PATH } from './db.js';
import { engine, bus } from './engine.js';
import devicesRouter from './routes/devices.js';
import dashboardRouter from './routes/dashboard.js';
import reportsRouter from './routes/reports.js';
import opsRouter from './routes/ops.js';
import inventoryRouter from './routes/inventory.js';
import markersRouter from './routes/markers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DEV = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';
const PORT = Number(process.env.PORT || (DEV ? 3000 : 8787));
const HOST = process.env.HOST || '0.0.0.0';

seedIfEmpty();

const app = express();
app.locals.seedIfEmpty = seedIfEmpty;
app.disable('x-powered-by');
// بدنهٔ JSON در این برنامه کوچک است (فهرست شناسه‌ها، تنظیمات، موقعیت نقشه) و فایل‌های
// حجیم از طریق multipart و با محدودیت حجم جداگانه بارگذاری می‌شوند.
app.use(express.json({ limit: '2mb' }));

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
  const allowed = [
    req.get('host'),
    (req.get('x-forwarded-host') || '').split(',')[0].trim(),
    `localhost:${PORT}`,
    `127.0.0.1:${PORT}`,
  ].filter(Boolean);
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

app.use('/api', sameOriginOnly);

/* ------------------------------ SSE ------------------------------ */
const sseClients = new Set();
const SSE_MAX_CLIENTS = Number(process.env.NETWATCH_SSE_MAX || 32);

app.get('/api/events', (req, res) => {
  // سقف اتصال‌ها: هر اتصال زنده یک پاسخ باز نگه می‌دارد؛ بدون سقف، چند تب خراب
  // یا یک کلاینت ناشناس می‌تواند حافظهٔ سرور را به پایان برساند.
  if (sseClients.size >= SSE_MAX_CLIENTS) {
    return res.status(503).setHeader('Retry-After', '10').json({ error: 'ظرفیت اتصال‌های زنده پر است.' });
  }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(`retry: 5000\nevent: hello\ndata: ${JSON.stringify({ ts: Date.now(), engine: engine.getStatus() })}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* بی‌اثر */
    }
  }, 25000);
  const drop = () => {
    clearInterval(ping);
    sseClients.delete(res);
  };
  req.on('close', drop);
  req.on('error', drop);
  res.on('error', drop);
});

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
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
bus.on('alert', (a) => broadcast('alert', a));
bus.on('alert-resolved', (a) => broadcast('alert-resolved', a));
bus.on('engine', (s) => broadcast('engine', s));
bus.on('alerts-changed', (s) => broadcast('alerts-changed', s));

/* ------------------------------ API ------------------------------ */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), devices: db.prepare('SELECT COUNT(*) c FROM devices').get().c, engine: engine.getStatus(), db: DB_PATH });
});

app.use('/api/devices', devicesRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/reports', reportsRouter);
app.use('/api', opsRouter);
app.use('/api', inventoryRouter);
app.use('/api', markersRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: 'مسیر یافت نشد' }));

const UPLOAD_MESSAGES = {
  LIMIT_FILE_SIZE: 'حجم فایل بارگذاری‌شده بیش از حد مجاز است.',
  LIMIT_FILE_COUNT: 'تعداد فایل‌های بارگذاری‌شده بیش از حد مجاز است.',
  LIMIT_UNEXPECTED_FILE: 'فیلد فایل ناشناخته است.',
  BAD_EXTENSION: 'فقط فایل با پسوند .mbtiles پذیرفته می‌شود.',
  STORAGE_LOW: 'فضای ذخیره‌سازی سرور برای بارگذاری این فایل کافی نیست.',
};

app.use((err, _req, res, _next) => {
  const known = UPLOAD_MESSAGES[err.code];
  const status = known
    ? Number(err.status || (String(err.code).startsWith('LIMIT_') ? 413 : 500))
    : Number(err.status || err.statusCode || 500);
  log('error', `خطای سرور: ${err.message}`);
  // پیام خطاهای کلاینتی (۴xx) برای کاربر مفید است، اما جزئیات خطاهای داخلی
  // (مسیر فایل، پرس‌وجوی SQL و…) نباید برای کلاینت فاش شود.
  const message =
    known ||
    (status < 500 ? err.message || 'درخواست نامعتبر است.' : 'خطای داخلی سرور رخ داد. جزئیات در گزارش رویدادهای سرور ثبت شد.');
  res.status(status).json({ error: message });
});

/* --------------------------- رابط کاربری --------------------------- */
const server = http.createServer(app);

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
    console.log(`\n  NetWatch  ▸  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${addr.port}`);
    console.log(`  حالت: ${DEV ? 'توسعه (Vite + HMR)' : 'تولیدی'}   |   پایگاه‌داده: ${DB_PATH}`);
    console.log(`  موتور مانیتورینگ: ${getSettings().engine_mode}\n`);
  });

  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log(`  توجه: این سرویس روی ${HOST} منتشر شده و احراز هویت ندارد؛`);
    console.log('        تنها در شبکهٔ مورد اعتماد اجرا کنید یا با HOST=127.0.0.1 محدودش کنید.\n');
  }

  if (process.env.NETWATCH_ENGINE !== '0') {
    await engine.start();
  } else {
    console.log('  موتور مانیتورینگ غیرفعال است (NETWATCH_ENGINE=0).');
  }
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n  در حال خاموش‌سازی…');
  try {
    engine.stop();
  } catch {}
  for (const client of sseClients) {
    try {
      client.end();
    } catch {}
  }
  server.close(() => finish(code));
  setTimeout(() => finish(code), 2500);
}

function finish(code) {
  try {
    db.close();
  } catch {}
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// پایداری: یک خطای مهارنشده نباید سرور را بی‌صدا از کار بیندازد — ثبت می‌شود و
// فرآیند با خاموش‌سازی مرتب (نوشتن WAL و بستن پایگاه‌داده) پایان می‌یابد.
process.on('uncaughtException', (err) => {
  log('error', `خطای مهارنشده: ${err?.stack || err?.message || err}`);
  console.error('\n  خطای مهارنشده:', err?.message || err);
  shutdown(1);
});
process.on('unhandledRejection', (reason) => {
  log('error', `وعدهٔ ردشدهٔ مهارنشده: ${reason?.stack || reason?.message || reason}`);
  console.error('\n  وعدهٔ ردشدهٔ مهارنشده:', reason?.message || reason);
  shutdown(1);
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
