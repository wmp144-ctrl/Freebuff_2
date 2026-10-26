#!/usr/bin/env node
/**
 * NetWatch — هارنس Soak / پایداری بلندمدت
 * ----------------------------------------------------------------
 * یک سرور واقعی با موتور فعال بالا می‌آورد، تجهیزات شبیه‌سازی‌شده می‌سازد،
 * ترافیک API و SSE تولید می‌کند و در تمام مدت RAM/CPU/دیسک/WAL/سلامت را
 * نمونه‌برداری می‌کند. در پایان، یکپارچگی پایگاه‌داده بررسی و گزارش JSON
 * نوشته می‌شود.
 *
 *   npm run qa:soak                         # ۲ دقیقه (Smoke)
 *   node server/scripts/qa-soak.mjs --minutes 1440   # ۲۴ ساعت
 *   node server/scripts/qa-soak.mjs --minutes 4320   # ۷۲ ساعت
 *
 * هشدار: اجرای ۲۴/۷۲ ساعته باید روی محیط اختصاصی و با دیسک کافی انجام شود؛
 * این ابزار خودش محدودیتی برای مدت زمان ندارد.
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const MINUTES = Number(arg('minutes', 2));
const DEVICES = Number(arg('devices', 50));
const INTERVAL_SEC = Number(arg('interval', 5));
const SAMPLE_MS = Number(arg('sample-ms', 5000));
const CHECKPOINT_MS = Number(arg('checkpoint-ms', 30000));
const OUT = arg('out', 'data/qa/soak.json');
const ADMIN = { username: 'admin', password: 'soak-admin-password-123' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function readProc(pid) {
  const out = { rssMb: null, cpuTicks: null, threads: null };
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    out.rssMb = round(Number(status.match(/VmRSS:\s+(\d+)/)?.[1] || 0) / 1024, 1);
    out.threads = Number(status.match(/Threads:\s+(\d+)/)?.[1] || 0);
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    out.cpuTicks = Number(fields[11]) + Number(fields[12]); // utime + stime
  } catch {
    /* فرآیند پایان یافته */
  }
  return out;
}

function dirBytes(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += dirBytes(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    }
  } catch {
    /* بی‌اثر */
  }
  return total;
}

function fileBytes(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

let cookie = '';
let csrf = '';
/** ساخت حساب مدیر آزمون از مسیر عمومی راه‌اندازی اولیه */
async function ensureAdmin(base) {
  const status = await (await fetch(`${base}/api/auth/setup`)).json().catch(() => null);
  if (!status?.required) return;
  const res = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ ...ADMIN, confirmPassword: ADMIN.password }),
  });
  if (res.status !== 201) throw new Error(`initial setup failed: ${res.status} ${await res.text()}`);
}

async function login(base) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify(ADMIN),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  cookie = cookies.join('; ');
  csrf = cookies.find((c) => c.startsWith('nw_csrf='))?.slice('nw_csrf='.length) || '';
}

async function api(base, method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: {
      cookie,
      'x-csrf-token': csrf,
      ...(body === undefined ? {} : { 'content-type': 'application/json', origin: base }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* غیر JSON */
  }
  return { status: res.status, data, text };
}

async function waitForServer(base, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.status < 500) return true;
    } catch {
      /* هنوز بالا نیامده */
    }
    await sleep(100);
  }
  return false;
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-soak-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const outPath = path.isAbsolute(OUT) ? OUT : path.join(ROOT, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const child = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    NETWATCH_DATA_DIR: dataDir,
    NETWATCH_ENGINE: '1',
    NETWATCH_ENGINE_MODE: 'simulate',
    NETWATCH_PING_INTERVAL: String(INTERVAL_SEC),
    NETWATCH_MAX_WORKERS: '64',
    NETWATCH_SSE_HEARTBEAT_MS: '30000',
    NETWATCH_LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (d) => (logs += d.toString()));
child.stderr.on('data', (d) => (logs += d.toString()));

const result = {
  startedAt: new Date().toISOString(),
  config: { minutes: MINUTES, devices: DEVICES, intervalSec: INTERVAL_SEC, sampleMs: SAMPLE_MS, checkpointMs: CHECKPOINT_MS },
  environment: { node: process.version, cpus: os.cpus().length, totalMemMb: Math.round(os.totalmem() / 1048576) },
  samples: [],
  checkpoints: [],
  failures: [],
  errors: [],
  sseEvents: 0,
  crashed: false,
  exitCode: null,
};

let sseController = null;
try {
  if (!(await waitForServer(base))) throw new Error(`server did not start:\n${logs}`);
  await ensureAdmin(base);
  await login(base);

  // ساخت تجهیزات (دسته‌ای، برای اینکه خود Seed به آزمون فشار تبدیل نشود)
  for (let start = 0; start < DEVICES; start += 10) {
    const batch = [];
    for (let i = start; i < Math.min(DEVICES, start + 10); i++) {
      batch.push(
        api(base, 'POST', '/api/devices', {
          name: `soak-${i}`,
          ip: `10.251.${Math.floor(i / 250)}.${(i % 250) + 1}`,
          ping_interval: INTERVAL_SEC,
        })
      );
    }
    const res = await Promise.all(batch);
    for (const r of res) if (r.status !== 201) result.failures.push({ step: 'seed', status: r.status, body: r.data });
  }

  // یک اتصال SSE پایدار برای اطمینان از زنده‌بودن جریان
  sseController = new AbortController();
  fetch(`${base}/api/events`, {
    headers: { cookie, accept: 'text/event-stream' },
    signal: sseController.signal,
  })
    .then(async (res) => {
      if (res.status !== 200) {
        result.failures.push({ step: 'sse', status: res.status });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          result.sseEvents += (decoder.decode(value, { stream: true }).match(/^event: /gm) || []).length;
        }
      } catch {
        /* هنگام بستن */
      }
    })
    .catch(() => {});

  const started = Date.now();
  const endAt = started + MINUTES * 60000;
  let lastCheckpoint = started;
  let lastCpu = readProc(child.pid).cpuTicks;
  let lastCpuAt = Date.now();

  while (Date.now() < endAt && child.exitCode === null) {
    const sampledAt = Date.now();
    const proc = readProc(child.pid);
    const cpuDelta = lastCpu != null && proc.cpuTicks != null ? proc.cpuTicks - lastCpu : 0;
    const elapsedSec = Math.max(0.001, (sampledAt - lastCpuAt) / 1000);
    const cpuPct = round((cpuDelta / 100 / elapsedSec) * 100, 1);
    lastCpu = proc.cpuTicks;
    lastCpuAt = sampledAt;

    const healthStart = Date.now();
    const health = await api(base, 'GET', '/api/system/health');
    const healthMs = Date.now() - healthStart;
    if (health.status !== 200) result.failures.push({ step: 'health', status: health.status });

    // ترافیک خواندنی واقعی
    const traffic = await Promise.all([
      api(base, 'GET', '/api/devices?pageSize=25'),
      api(base, 'GET', '/api/dashboard/summary'),
      api(base, 'GET', '/api/status'),
      api(base, 'GET', '/api/reports/summary?range=24h'),
    ]);
    for (const r of traffic) if (r.status >= 500) result.failures.push({ step: 'traffic', status: r.status });

    const wal = health.data?.db?.wal || {};
    const engine = health.data?.engine || {};
    result.samples.push({
      t: sampledAt,
      elapsedSec: Math.round((sampledAt - started) / 1000),
      rssMb: proc.rssMb,
      threads: proc.threads,
      cpuPct,
      healthMs,
      diskBytes: dirBytes(dataDir),
      dbBytes: fileBytes(path.join(dataDir, 'netwatch.db')),
      walBytes: fileBytes(path.join(dataDir, 'netwatch.db-wal')),
      journalMode: wal.journalMode,
      sseClients: health.data?.sse?.clients ?? 0,
      engineCycles: engine.cycles ?? null,
      engineErrors: engine.errors ?? null,
      backlog: engine.backlog ?? null,
      devices: health.data?.devices ?? null,
    });

    if (Date.now() - lastCheckpoint >= CHECKPOINT_MS) {
      const before = fileBytes(path.join(dataDir, 'netwatch.db-wal'));
      const cpStart = Date.now();
      const cp = await api(base, 'POST', '/api/system/db/checkpoint', {});
      result.checkpoints.push({
        t: Date.now(),
        elapsedSec: Math.round((Date.now() - started) / 1000),
        status: cp.status,
        durationMs: Date.now() - cpStart,
        walBefore: before,
        walAfter: fileBytes(path.join(dataDir, 'netwatch.db-wal')),
        result: cp.data,
      });
      lastCheckpoint = Date.now();
    }

    await sleep(SAMPLE_MS);
  }

  result.durationSec = Math.round((Date.now() - started) / 1000);
  result.crashed = child.exitCode !== null;
  result.exitCode = child.exitCode;
  if (child.exitCode !== null) result.errors.push(`server exited with ${child.exitCode} during soak`);
} catch (e) {
  result.errors.push(e.message);
} finally {
  try {
    sseController?.abort();
  } catch {
    /* بی‌اثر */
  }
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, 10000);
      child.once('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    result.exitCode = code;
  }
  result.endedAt = new Date().toISOString();
  result.logTail = logs.split('\n').slice(-40).join('\n');

  // سلامت نهایی پایگاه‌داده با همان ابزار تولیدی
  const doctor = spawnSync(process.execPath, ['server/scripts/db-doctor.mjs'], {
    cwd: ROOT,
    env: { ...process.env, NETWATCH_DATA_DIR: dataDir, NETWATCH_LOG_STREAM: 'stderr' },
    encoding: 'utf8',
    timeout: 120000,
  });
  try {
    const parsed = JSON.parse(doctor.stdout);
    result.dbFinal = { ok: parsed.ok, health: parsed.db?.health, wal: parsed.db?.wal, sizes: parsed.sizes, warnings: parsed.warnings };
  } catch {
    result.dbFinal = { ok: false, error: doctor.stderr || doctor.stdout };
  }

  const rss = result.samples.map((s) => s.rssMb).filter((n) => Number.isFinite(n));
  result.summary = {
    samples: result.samples.length,
    cpuAvgPct: round(result.samples.reduce((a, s) => a + (s.cpuPct || 0), 0) / Math.max(1, result.samples.length), 1),
    cpuMaxPct: round(Math.max(0, ...result.samples.map((s) => s.cpuPct || 0)), 1),
    rssFirstMb: rss[0] ?? null,
    rssLastMb: rss.at(-1) ?? null,
    rssPeakMb: rss.length ? Math.max(...rss) : null,
    rssGrowthMb: rss.length ? round(rss.at(-1) - rss[0], 1) : null,
    healthP95Ms: (() => {
      const list = result.samples.map((s) => s.healthMs).sort((a, b) => a - b);
      return list.length ? list[Math.min(list.length - 1, Math.floor(list.length * 0.95))] : null;
    })(),
    diskGrowthMb: result.samples.length
      ? round((result.samples.at(-1).diskBytes - result.samples[0].diskBytes) / 1048576, 1)
      : null,
    walMaxMb: result.samples.length ? round(Math.max(...result.samples.map((s) => s.walBytes)) / 1048576, 2) : null,
    sseEvents: result.sseEvents,
    engineErrors: result.samples.at(-1)?.engineErrors ?? null,
    checkpoints: result.checkpoints.length,
    failures: result.failures.length,
    errors: result.errors.length,
  };
  // آستانهٔ نشتی برای اجرای کوتاه سخت‌گیرانه‌تر است؛ در ۲۴/۷۲ ساعت هم رشد
  // پایدار بیش از ۶۴ مگابایت نشانهٔ نشتی در نظر گرفته می‌شود.
  const leak = result.summary.rssGrowthMb != null && result.summary.rssGrowthMb > 64;
  result.ok =
    !result.crashed &&
    result.errors.length === 0 &&
    result.failures.length === 0 &&
    result.dbFinal?.ok === true &&
    (result.summary.engineErrors ?? 0) === 0 &&
    !leak;
  result.leakSuspected = leak;
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  fs.rmSync(dataDir, { recursive: true, force: true });

  console.log(JSON.stringify({ ok: result.ok, durationSec: result.durationSec, summary: result.summary, leakSuspected: leak }, null, 2));
  console.log(`گزارش: ${outPath}`);
}
process.exit(result.ok ? 0 : 1);
