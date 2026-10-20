#!/usr/bin/env node
/**
 * NetWatch — سنجش عملکرد سراسری (فاز ۵)
 * ----------------------------------------------------------------
 * این اسکریپت زیرساخت را «حدس» نمی‌زند: یک پایگاه‌دادهٔ موقت می‌سازد، سرور واقعی
 * را بالا می‌آورد و همان مسیرهایی را می‌سنجد که کاربر/داشبورد استفاده می‌کند.
 *
 * مراحل:
 *   ۱) API Latency: p50/p95/p99 برای مسیرهای مهم با هم‌زمانی مشخص
 *   ۲) SSE: اتصال هم‌زمان، دریافت hello، گذردهی نمونه‌ها، رشد حافظه، بستن تمیز
 *   ۳) Import: پیش‌نمایش/ثبت ۱۰k ردیف، فایل خراب، لغو، هم‌زمان با Probe
 *   ۴) Application Health: CPU/RAM/Heap/ELD/DB/WAL/صف/SSE از خود برنامه
 *
 *   node server/scripts/qa-bench.mjs --devices 5000 --sse-clients 150 --out data/qa/bench.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
}

const DEVICES = Math.max(50, Math.min(20000, Number(arg('devices', 5000)) || 5000));
const HISTORY_DAYS = Math.max(0, Math.min(7, Number(arg('history-days', 1)) || 0));
const HISTORY_STEP_SEC = Math.max(60, Number(arg('history-step', 600)) || 600);
const SSE_CLIENTS = Math.max(10, Math.min(1000, Number(arg('sse-clients', 150)) || 150));
const SSE_WATCH = Math.max(0, Math.min(200, Number(arg('sse-watch', 25)) || 0));
const SSE_ALL = args.includes('--sse-all');
const SSE_DURATION_SEC = Math.max(5, Math.min(120, Number(arg('sse-seconds', 20)) || 20));
const API_REQUESTS = Math.max(10, Number(arg('api-requests', 80)) || 80);
const API_CONCURRENCY = Math.max(1, Number(arg('api-concurrency', 8)) || 8);
const IMPORT_ROWS = Math.max(100, Math.min(50000, Number(arg('import-rows', 10000)) || 10000));
const OUT = arg('out', 'data/qa/bench.json');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-bench-'));
process.env.NETWATCH_DATA_DIR = dataDir;
process.env.NETWATCH_DB_CHECK = 'off';
// سقف نرخ عمومی (۶۰۰ در دقیقه در پیکربندی پیش‌فرض) در اندازه‌گیری بار نباید
// پاسخ‌ها را ۴۲۹ کند؛ هدف، سنجیدن کندی واقعی مسیرهاست. سقف پیش‌فرض در
// environment گزارش ثبت می‌شود تا در گزارش ارقام سقف واقعی از بین نرود.
const RATE_LIMIT_DEFAULT = { general: 600, admin: 120, expensive: 60, import: 20 };
const RATE_LIMIT_BENCH = String(Math.max(1000000, API_REQUESTS * 20));
process.env.NETWATCH_RATE_LIMIT_MAX = RATE_LIMIT_BENCH;
// مسیرهای /api/system/* از سقف «مدیریتی» (۱۲۰ در دقیقه) عبور می‌کنند؛ بدون بالا
// بردن آن، نیمی از اندازه‌گیری app-health پاسخ ۴۲۹ می‌گیرد و p50/p95 کاذب می‌شود.
process.env.NETWATCH_ADMIN_RATE_LIMIT_MAX = RATE_LIMIT_BENCH;
process.env.NETWATCH_EXPENSIVE_RATE_LIMIT_MAX = RATE_LIMIT_BENCH;

const helpers = await import('../tests/helpers.mjs');

const round = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function percentile(list, p) {
  if (!list.length) return null;
  const arr = [...list].sort((a, b) => a - b);
  const i = Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1));
  return round(arr[i], 2);
}

function stats(list, errors = 0) {
  if (!list.length) return { count: 0, errors };
  const sum = list.reduce((a, b) => a + b, 0);
  return {
    count: list.length,
    errors,
    min: round(Math.min(...list), 2),
    mean: round(sum / list.length, 2),
    p50: percentile(list, 50),
    p95: percentile(list, 95),
    p99: percentile(list, 99),
    max: round(Math.max(...list), 2),
  };
}

/* ------------------------------ داده‌سازی ------------------------------ */

async function seed() {
  const started = Date.now();
  const { db, setSettings } = await import('../db.js');
  const now = Date.now();
  const deviceStmt = db.prepare(
    `INSERT INTO devices(name, ip, hostname, device_type, location, priority, enabled, monitoring_enabled, status,
        ping_interval, next_check_at, latitude, longitude, created_at, updated_at)
     VALUES (?,?,?,?,?,?,1,1,'unknown',5,0,?,?,?,?)`
  );
  const ids = [];
  const step = Math.max(1, Math.floor(DEVICES / 200));
  db.transaction(() => {
    for (let i = 0; i < DEVICES; i++) {
      const third = Math.floor(i / 250) + 1;
      const fourth = (i % 250) + 1;
      ids.push(
        Number(
          deviceStmt.run(
            `bench-dev-${i + 1}`,
            `10.${20 + (i % 60)}.${third % 250}.${fourth}`,
            `bench-${i + 1}.local`,
            i % 5 === 0 ? 'سوئیچ' : i % 7 === 0 ? 'فایروال' : 'روتر',
            `سالن ${i % 12}`,
            i % 20 === 0 ? 'critical' : i % 5 === 0 ? 'high' : 'normal',
            35.6 + (i % 1000) / 10000,
            51.3 + (i % 1000) / 10000,
            now,
            now
          ).lastInsertRowid
        )
      );
    }
  }, { label: 'bench.devices' });

  let samples = 0;
  if (HISTORY_DAYS > 0) {
    const slots = Math.floor((HISTORY_DAYS * 86400000) / (HISTORY_STEP_SEC * 1000));
    const start = now - slots * HISTORY_STEP_SEC * 1000;
    const sampleStmt = db.prepare(
      `INSERT INTO samples(device_id, ts, rtt_ms, packets_sent, packets_recv, loss_pct, status, ok, mode, scheduled_at, started_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    const BATCH = 20000;
    for (let s = 0; s < slots; s++) {
      const ts = start + s * HISTORY_STEP_SEC * 1000;
      db.transaction(() => {
        let n = 0;
        for (const id of ids) {
          const ok = (s + id) % 97 !== 0;
          sampleStmt.run(id, ts + (id % 977), ok ? round(2 + ((s * 7 + id) % 45), 2) : null, 3, ok ? 3 : 0, ok ? 0 : 100, ok ? 'online' : 'offline', ok ? 1 : 0, 'bench', ts, ts + (id % 977));
          samples += 1;
          n += 1;
          if (n % BATCH === 0) {
            /* دسته‌ها داخل همین تراکنش نوشته می‌شوند */
          }
        }
      }, { label: 'bench.samples' });
    }
  }

  setSettings({
    engine_mode: 'simulate',
    engine_enabled: true,
    max_workers: 256,
    ping_interval: 5,
    timeout_ms: 1200,
    failures_for_offline: 3,
    successes_for_online: 2,
    alerting_enabled: true,
    alert_cooldown: 600,
  });
  db.close();
  return {
    devices: DEVICES,
    samples,
    dbBytes: (() => {
      try {
        return fs.statSync(path.join(dataDir, 'netwatch.db')).size;
      } catch {
        return null;
      }
    })(),
    seedMs: Date.now() - started,
    step,
    firstIds: ids.slice(0, 100),
  };
}

/* ------------------------------ درخواست ------------------------------ */

let session = null;
async function req(url, init = {}) {
  const res = await fetch(session.base + url, {
    ...init,
    headers: {
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* غیر JSON */
  }
  return { status: res.status, data, text, headers: res.headers };
}

async function runLatency(url, { requests = API_REQUESTS, concurrency = API_CONCURRENCY } = {}) {
  const durations = [];
  let errors = 0;
  const statusCodes = {};
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const i = next++;
      if (i >= requests) return;
      const t0 = performance.now();
      try {
        const res = await req(url);
        const ms = performance.now() - t0;
        durations.push(ms);
        statusCodes[res.status] = (statusCodes[res.status] || 0) + 1;
        if (res.status >= 400) errors += 1;
      } catch {
        errors += 1;
      }
    }
  });
  await Promise.all(workers);
  return { url, ...stats(durations, errors), statusCodes };
}

/* ------------------------------- SSE ------------------------------- */

async function openSse(url) {
  const controller = new AbortController();
  const res = await fetch(session.base + url, {
    headers: { cookie: session.cookie, accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const client = { controller, reader, frames: 0, samples: 0, helloAt: null, bytes: 0, closed: false, error: null, maxChunk: 0, chunks: 0, maxFrame: 0, frameBytes: 0, events: {} };
  const pump = (async () => {
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        client.bytes += value.byteLength;
        client.chunks += 1;
        client.maxChunk = Math.max(client.maxChunk, value.byteLength);
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          client.frameBytes += chunk.length + 2;
          const evName = /^event: (\w+)/.exec(chunk)?.[1] || (chunk.startsWith(':') ? 'comment' : 'other');
          client.events[evName] = (client.events[evName] || 0) + 1;
          if (chunk.startsWith('event: hello')) {
            client.helloAt = performance.now();
          } else if (chunk.startsWith('event: samples')) {
            client.frames += 1;
            client.maxFrame = Math.max(client.maxFrame, chunk.length);
            const data = chunk.split('\ndata: ')[1];
            try {
              const list = JSON.parse(data);
              client.samples += Array.isArray(list) ? list.length : 1;
            } catch {
              /* فریم خراب */
            }
          }
        }
      }
    } catch (e) {
      client.error = e?.name || String(e);
    } finally {
      client.closed = true;
    }
  })();
  client.done = pump;
  return client;
}

/* ------------------------------ Import ------------------------------ */

function buildCsv(rows, { valid = true } = {}) {
  const header = 'نام تجهیز,آدرس IP,نوع تجهیز,گروه,موقعیت,عرض جغرافیایی,طول جغرافیایی,اولویت\n';
  const lines = [];
  for (let i = 0; i < rows; i++) {
    if (valid) {
      lines.push(`import-dev-${i + 1},10.${150 + (i % 50)}.${Math.floor(i / 50) % 250}.${(i % 250) + 1},روتر,گروه ورود,سالن ورود,35.7,51.4,normal`);
    } else {
      lines.push(`,bad-ip-${i},,` + 'x'.repeat(20) + ',,,');
    }
  }
  return header + lines.join('\n');
}

async function uploadBench(url, content, filename = 'bench.csv') {
  const t0 = performance.now();
  const res = await helpers.upload(session.base, url, { filename, content, type: 'text/csv', fields: { onlyValid: '1' } });
  return { ms: round(performance.now() - t0, 2), status: res.status, data: res.data };
}

/* --------------------------- Application Health --------------------------- */

async function appHealth() {
  const res = await req('/api/system/app-health');
  return res.status === 200 ? res.data : null;
}

async function historySnapshot() {
  const h = await appHealth();
  return h?.history ?? [];
}

/* -------------------------------- اجرا -------------------------------- */

const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    cpus: os.cpus().length,
    totalMemMb: Math.round(os.totalmem() / 1048576),
    devices: DEVICES,
    historyDays: HISTORY_DAYS,
    historyStepSec: HISTORY_STEP_SEC,
    sseClients: SSE_CLIENTS,
    apiRequests: API_REQUESTS,
    apiConcurrency: API_CONCURRENCY,
    importRows: IMPORT_ROWS,
    rateLimitPerMin: { default: RATE_LIMIT_DEFAULT, bench: Number(RATE_LIMIT_BENCH) },
  },
  phases: {},
};

let server = null;
try {
  process.stdout.write('→ seeding database … ');
  report.phases.seed = await seed();
  console.log(`${report.phases.seed.seedMs} ms, ${report.phases.seed.samples.toLocaleString()} samples`);

  // فاز ۱ و ۳: موتور خاموش تا تأخیر API مستقل از Probe سنجیده شود
  const bootT0 = performance.now();
  server = await helpers.startServer({ dataDir, engine: false });
  // زمان راه‌اندازی شامل تحلیل آمار پرس‌وجو و مهاجرت‌هاست؛ سنجیده می‌شود تا
  // تحلیل کامل جدول بزرگ نمونه، راه‌اندازی را چند ثانیه فلج نکند.
  const apiStartMs = round(performance.now() - bootT0, 1);
  session = server.session;
  session.base = server.base;

  report.phases.api = { cold: {}, warm: {}, routes: [], serverStartMs: apiStartMs };

  // اندازه‌گیری Cold (کش ۵ ثانیه‌ای داشبورد خالی است)
  const coldPaths = ['/api/dashboard/summary', '/api/status', '/api/devices?page=1&pageSize=25'];
  for (const p of coldPaths) {
    const t0 = performance.now();
    const res = await req(p);
    report.phases.api.cold[p] = { ms: round(performance.now() - t0, 2), status: res.status };
  }
  await sleep(5200);
  await req('/api/dashboard/summary');

  const routes = [
    '/api/status',
    '/api/dashboard/summary',
    '/api/devices?page=1&pageSize=25',
    `/api/devices?search=bench-dev-1&page=1&pageSize=25`,
    '/api/devices/map?limit=5000',
    '/api/reports/summary?range=7d',
    '/api/alerts?status=active&pageSize=25',
    '/api/system/health',
    '/api/system/app-health',
  ];
  for (const route of routes) {
    process.stdout.write(`→ API ${route} … `);
    const r = await runLatency(route);
    report.phases.api.routes.push(r);
    console.log(`p50 ${r.p50}ms | p95 ${r.p95}ms | p99 ${r.p99}ms | err ${r.errors}`);
  }
  report.phases.api.healthAfterApi = await appHealth();
  report.phases.api.history = await historySnapshot();

  // فاز ۲: موتور روشن (شبیه‌سازی) + اتصال‌های هم‌زمان SSE
  await server.stop();
  const bootT1 = performance.now();
  server = await helpers.startServer({ dataDir, engine: true });
  // زمان راه‌اندازی نشست دوم (با موتور) هم ثبت می‌شود
  const engineStartMs = round(performance.now() - bootT1, 1);
  session = server.session;
  session.base = server.base;
  // اطمینان از اعمال تنظیمات و شروع چرخه
  await sleep(1500);

  const sseBefore = await appHealth();
  const clients = [];
  // کلاینت واقعی فقط تجهیزات صفحهٔ جاری را نمایش می‌دهد؛ همان اشتراک را شبیه‌سازی
  // می‌کنیم تا گذردهی و پهنای باند، سناریوی واقعی داشبورد را نشان دهد.
  const watch = (report.phases.seed.firstIds || []).slice(0, SSE_WATCH).join(',');
  // --sse-all رفتار قدیمی (ارسال نمونهٔ همهٔ تجهیزات به همه) را برای مقایسه می‌سنجد.
  const sseUrl = SSE_ALL ? '/api/events' : `/api/events?devices=${watch}`;
  const tConnect = performance.now();
  for (let i = 0; i < SSE_CLIENTS; i++) {
    clients.push(await openSse(sseUrl));
  }
  const connectMs = round(performance.now() - tConnect, 2);
  await Promise.all(clients.map((c) => c.helloAt ? Promise.resolve() : sleep(10000)));
  const hello = clients.filter((c) => c.helloAt != null).length;

  const t0 = Date.now();
  const rssStart = sseBefore?.process?.memory?.rssMb ?? null;
  // نمونه‌گیری یک‌ثانیه‌ای برای نمودار CPU/RAM/ELD در همان بازهٔ بار
  const timeline = [];
  for (let i = 0; i < SSE_DURATION_SEC; i++) {
    await sleep(1000);
    const h = await appHealth();
    if (h) {
      timeline.push({
        t: Date.now(),
        cpu: h.process.cpu.processPct,
        rss: h.process.memory.rssMb,
        heap: h.process.memory.heapUsedMb,
        eld: h.process.eventLoop.p99,
        api: h.api.overall.p95,
        probes: h.engine.activeProbes,
        queue: h.engine.queueDepth,
        sse: h.sse.clients,
        bytesOut: h.sse.deliveredFrames,
      });
    }
  }
  const elapsed = (Date.now() - t0) / 1000;
  const sseAfter = await appHealth();
  const receivedSamples = clients.reduce((a, c) => a + c.samples, 0);
  const receivedFrames = clients.reduce((a, c) => a + c.frames, 0);
  const bytes = clients.reduce((a, c) => a + c.bytes, 0);
  const maxChunk = Math.max(0, ...clients.map((c) => c.maxChunk));
  const maxFrame = Math.max(0, ...clients.map((c) => c.maxFrame));
  const chunks = clients.reduce((a, c) => a + c.chunks, 0);
  const frameBytes = clients.reduce((a, c) => a + c.frameBytes, 0);
  const eventCounts = clients.reduce((acc, c) => {
    for (const [k, v] of Object.entries(c.events)) acc[k] = (acc[k] || 0) + v;
    return acc;
  }, {});

  for (const c of clients) {
    try {
      c.controller.abort();
    } catch {
      /* بی‌اثر */
    }
  }
  await Promise.race([Promise.allSettled(clients.map((c) => c.done)), sleep(3000)]);
  await sleep(1200);
  const sseClosed = await appHealth();

  report.phases.sse = {
    serverStartMs: engineStartMs,
    clients: SSE_CLIENTS,
    watchDevices: SSE_ALL ? 'all' : SSE_WATCH,
    connectMs,
    timeline,
    hello,
    durationSec: round(elapsed, 1),
    frames: receivedFrames,
    samples: receivedSamples,
    framesPerSecond: round(receivedFrames / elapsed, 1),
    samplesPerSecond: round(receivedSamples / elapsed, 1),
    bytes,
    chunks,
    maxChunkBytes: maxChunk,
    maxFrameBytes: maxFrame,
    frameBytes,
    eventCounts,
    rssBeforeMb: rssStart,
    rssDuringMb: sseAfter?.process?.memory?.rssMb ?? null,
    rssAfterCloseMb: sseClosed?.process?.memory?.rssMb ?? null,
    clientsDuring: sseAfter?.sse?.clients ?? null,
    clientsAfterClose: sseClosed?.sse?.clients ?? null,
    peakClients: sseAfter?.sse?.peak ?? null,
    dropped: sseAfter?.sse?.droppedClients ?? null,
    skippedFrames: sseAfter?.sse?.skippedFrames ?? null,
  };

  // فاز ۳: Import حجیم هنگام اجرای Probe
  const before = await appHealth();
  const devicesBefore = (await req('/api/status')).data?.devices?.total ?? null;
  const csv = buildCsv(IMPORT_ROWS);
  process.stdout.write(`→ import preview ${IMPORT_ROWS} rows … `);
  const preview = await uploadBench('/api/devices/import/preview', csv);
  console.log(`${preview.ms} ms`);
  process.stdout.write('→ import commit … ');
  const commit = await uploadBench('/api/devices/import/commit', csv);
  console.log(`${commit.ms} ms (${commit.data?.inserted ?? 0} inserted)`);
  const after = await appHealth();
  const devicesAfter = (await req('/api/status')).data?.devices?.total ?? null;

  process.stdout.write('→ corrupt file … ');
  const corrupt = await uploadBench('/api/devices/import/preview', 'not,a,valid\nspreadsheet\nrow', 'broken.csv');
  // فایل دودویی با پسوند CSV نیز نباید سرور را بشکند؛ یا ۴xx روشن می‌دهد یا
  // صفر ردیف معتبر برمی‌گرداند، اما هرگز ۵xx/Timeout نمی‌دهد.
  const binaryRes = await helpers.upload(session.base, '/api/devices/import/preview', {
    filename: 'binary.csv',
    content: Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x50, 0x4b, 0x03, 0x04]),
    type: 'text/csv',
  });
  console.log(`status ${corrupt.status} / binary ${binaryRes.status}`);

  process.stdout.write('→ cancel during preview … ');
  const cancelController = new AbortController();
  const cancelPromise = fetch(session.base + '/api/devices/import/preview', {
    method: 'POST',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, origin: session.base },
    body: (() => {
      const form = new FormData();
      form.append('file', new Blob([buildCsv(3000)], { type: 'text/csv' }), 'cancel.csv');
      return form;
    })(),
    signal: cancelController.signal,
  }).catch((e) => e?.name || String(e));
  await sleep(30);
  cancelController.abort();
  const cancelResult = await cancelPromise;
  const devicesAfterCancel = (await req('/api/status')).data?.devices?.total ?? null;
  console.log(String(cancelResult));

  report.phases.import = {
    rows: IMPORT_ROWS,
    csvBytes: csv.length,
    previewMs: preview.ms,
    previewBytes: preview.text?.length ?? null,
    previewStatus: preview.status,
    previewSummary: preview.data?.summary ?? null,
    commitMs: commit.ms,
    commitStatus: commit.status,
    inserted: commit.data?.inserted ?? null,
    atomic: commit.data?.atomic ?? null,
    devicesBefore,
    devicesAfter,
    devicesAfterCancel,
    corruptFileStatus: corrupt.status,
    corruptFileError: corrupt.data?.error ?? null,
    binaryFileStatus: binaryRes.status,
    cancelResult: typeof cancelResult === 'string' ? cancelResult : 'aborted',
    rssBeforeMb: before?.process?.memory?.rssMb ?? null,
    rssAfterMb: after?.process?.memory?.rssMb ?? null,
    peakHeapMb: after?.process?.memory?.heapUsedMb ?? null,
    dbQueryErrors: after?.db?.queries?.errors ?? null,
    activeProbes: after?.engine?.activeProbes ?? null,
    lastCycleMs: after?.engine?.lastCycleMs ?? null,
  };

  report.phases.finalHealth = await appHealth();
  report.phases.history = await historySnapshot();
} catch (e) {
  report.error = e?.stack || String(e);
  console.error('\n✖ benchmark failed:', e?.message || e);
} finally {
  if (server) {
    try {
      await server.stop();
    } catch {
      /* بی‌اثر */
    }
  }
  helpers.cleanupDir(dataDir);
}

const outPath = path.isAbsolute(OUT) ? OUT : path.join(ROOT, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\n${report.error ? '❌' : '✅'} benchmark ${report.error ? 'failed' : 'completed'} — ${outPath}`);
process.exit(report.error ? 1 : 0);
