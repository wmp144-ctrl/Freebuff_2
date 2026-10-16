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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DEV = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';
const PORT = Number(process.env.PORT || (DEV ? 3000 : 8787));
const HOST = process.env.HOST || '0.0.0.0';

seedIfEmpty();

const app = express();
app.locals.seedIfEmpty = seedIfEmpty;
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));

/* ------------------------------ SSE ------------------------------ */
const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now(), engine: engine.getStatus() })}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* بی‌اثر */
    }
  }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
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

app.use('/api', (_req, res) => res.status(404).json({ error: 'مسیر یافت نشد' }));

app.use((err, _req, res, _next) => {
  log('error', `خطای سرور: ${err.message}`);
  res.status(err.status || 500).json({ error: err.message || 'خطای داخلی سرور' });
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
        hmr: { server },
        allowedHosts: [...new Set(['localhost', '127.0.0.1', ...extraHosts])],
      },
    });
    app.use(vite.middlewares);
  } else {
    const dist = path.join(ROOT, 'web', 'dist');
    if (fs.existsSync(dist)) {
      app.use(express.static(dist, { index: false, maxAge: '1h' }));
      app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
    } else {
      app.get('*', (_req, res) =>
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

  if (process.env.NETWATCH_ENGINE !== '0') {
    await engine.start();
  } else {
    console.log('  موتور مانیتورینگ غیرفعال است (NETWATCH_ENGINE=0).');
  }
}

function shutdown() {
  console.log('\n  در حال خاموش‌سازی…');
  try {
    engine.stop();
    db.close();
  } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

boot().catch((e) => {
  console.error('راه‌اندازی ناموفق:', e);
  process.exit(1);
});
