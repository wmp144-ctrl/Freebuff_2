/**
 * NetWatch — آزمون بار ۱۰۰۰ تجهیز
 * ----------------------------------------------------------------
 * یک پایگاه‌دادهٔ موقت می‌سازد، ۱۰۰۰ تجهیز اضافه می‌کند و یک چرخهٔ کامل بررسی
 * را اندازه می‌گیرد: زمان تکمیل، مصرف CPU، اوج حافظه، تأخیر حلقهٔ رویداد،
 * هم‌زمانی واقعی، رشد پایگاه‌داده و هزینهٔ تجمیع روزانه.
 *
 *   node server/scripts/load-test.mjs
 *   node server/scripts/load-test.mjs --devices 1000 --workers 128 --probe-latency 3
 *   node server/scripts/load-test.mjs --probe simulate --history-days 0
 *
 * پیش‌فرض‌ها: ۱۰۰۰ تجهیز، ۱۲۸ هم‌زمانی، ۳ms تأخیر شبکهٔ شبیه‌سازی‌شده،
 * ۱ روز تاریخچه (هر ۵ دقیقه یک نمونه) و گزارش JSON در data/load-report.json.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const DEVICES = Number(arg('devices', 1000));
const WORKERS = Number(arg('workers', 128));
const PROBE = arg('probe', 'mock'); // mock | simulate
const PROBE_LATENCY_MS = Number(arg('probe-latency', 3));
const LOSS_RATE = Number(arg('loss', 0.01));
const INTERVAL_SEC = Number(arg('interval', 3600));
const HISTORY_DAYS = Number(arg('history-days', 1));
const HISTORY_STEP_SEC = Number(arg('history-step', 300));
const OUT = arg('out', 'data/load-report.json');
const TIMEOUT_MS = Number(arg('timeout', 180000));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-load-'));
process.env.NETWATCH_DATA_DIR = dataDir;
process.env.NETWATCH_ENGINE = '0';

const { db, setSettings, DB_PATH } = await import('../db.js');
const { MonitoringEngine } = await import('../engine.js');
const { seriesFor } = await import('../routes/devices.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

function rssMb() {
  return round(process.memoryUsage().rss / 1048576, 1);
}

/* ---------------------- ساخت داده ---------------------- */

function seedDevices() {
  const insert = db.prepare(
    'INSERT INTO devices(name, ip, status, enabled, monitoring_enabled, ping_interval, timeout_ms, packet_count, retries, priority, latitude, longitude, created_at, updated_at, next_check_at) VALUES (?,?,?,1,1,?,1200,3,1,?,?,?,?,?,0)'
  );
  const now = Date.now();
  db.exec('BEGIN');
  for (let i = 0; i < DEVICES; i++) {
    const third = Math.floor(i / 250) + 1;
    const fourth = (i % 250) + 1;
    insert.run(
      `load-dev-${i + 1}`,
      `10.${100 + (i % 50)}.${third}.${fourth}`,
      'unknown',
      INTERVAL_SEC,
      i % 100 === 0 ? 'critical' : i % 10 === 0 ? 'high' : 'normal',
      35.7 + (i % 100) / 1000,
      51.4 + (i % 100) / 1000,
      now,
      now
    );
  }
  db.exec('COMMIT');
}

function seedHistory() {
  if (HISTORY_DAYS <= 0) return 0;
  const stepMs = HISTORY_STEP_SEC * 1000;
  const slots = Math.floor((HISTORY_DAYS * 86400000) / stepMs);
  const start = Date.now() - slots * stepMs;
  const ids = db.prepare('SELECT id FROM devices ORDER BY id').all().map((r) => r.id);
  const insert = db.prepare(
    'INSERT INTO samples(device_id, ts, rtt_ms, packets_sent, packets_recv, loss_pct, status, ok, mode) VALUES (?,?,?,3,?,?,?,?,?)'
  );
  let count = 0;
  db.exec('BEGIN');
  for (let s = 0; s < slots; s++) {
    const ts = start + s * stepMs;
    for (const id of ids) {
      const ok = Math.random() > LOSS_RATE;
      insert.run(id, ts, ok ? round(3 + Math.random() * 40) : null, ok ? 3 : 0, ok ? 0 : 100, ok ? 'online' : 'offline', ok ? 1 : 0, 'load');
      count++;
    }
  }
  db.exec('COMMIT');
  return count;
}

/* ---------------------- اندازه‌گیری ---------------------- */

function dbSizeBytes() {
  let total = 0;
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try {
      total += fs.statSync(f).size;
    } catch {
      /* فایل وجود ندارد */
    }
  }
  return total;
}

const engine = new MonitoringEngine({ emitToBus: false });

async function measureCycle() {
  let probeCalls = 0;
  if (PROBE === 'mock') {
    engine.probe = async () => {
      probeCalls++;
      if (PROBE_LATENCY_MS > 0) await sleep(PROBE_LATENCY_MS + Math.random() * 2);
      const ok = Math.random() > LOSS_RATE;
      return {
        ok,
        rtt: ok ? round(2 + Math.random() * 45) : null,
        packetsSent: 3,
        packetsRecv: ok ? 3 : 0,
        lossPct: ok ? 0 : 100,
        mode: 'load-mock',
        error: ok ? undefined : 'TIMEOUT',
      };
    };
  }

  const rssStart = rssMb();
  const cpuStart = process.cpuUsage();
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();

  let peakInflight = 0;
  const sampler = setInterval(() => {
    peakInflight = Math.max(peakInflight, engine.inflight.size);
  }, 20);
  if (sampler.unref) sampler.unref();

  const started = Date.now();
  await engine.start();
  engine.invalidate(); // تنظیمات آزمایش (max_workers/حالت) همین حالا اعمال شود

  let done = null;
  while (Date.now() - started < TIMEOUT_MS) {
    const checked = db.prepare('SELECT COUNT(*) c FROM samples WHERE ts >= ?').get(started).c;
    if (checked >= DEVICES) {
      done = checked;
      break;
    }
    await sleep(50);
  }
  const elapsedMs = Date.now() - started;
  await engine.stop();
  await engine.drain(10000);
  clearInterval(sampler);
  delay.disable();

  const cpu = process.cpuUsage(cpuStart);
  const stats = engine.getStatus();
  return {
    devicesChecked: done ?? db.prepare('SELECT COUNT(DISTINCT device_id) c FROM samples WHERE ts >= ?').get(started).c,
    fullCycleMs: elapsedMs,
    checksPerSecond: round((DEVICES / elapsedMs) * 1000, 1),
    probeCalls,
    peakInflight,
    configuredWorkers: WORKERS,
    cpuUserMs: round(cpu.user / 1000, 1),
    cpuSystemMs: round(cpu.system / 1000, 1),
    cpuTotalMs: round((cpu.user + cpu.system) / 1000, 1),
    cpuMsPerCheck: round((cpu.user + cpu.system) / 1000 / DEVICES, 3),
    rssStartMb: rssStart,
    rssEndMb: rssMb(),
    eventLoopDelayMs: {
      mean: round(delay.mean / 1e6, 2),
      p50: round(delay.percentile(50) / 1e6, 2),
      p99: round(delay.percentile(99) / 1e6, 2),
      max: round(delay.max / 1e6, 2),
    },
    engineErrors: stats.errors,
    engineSkipped: stats.skipped,
  };
}

function measureRollup() {
  const started = Date.now();
  engine.rollup();
  return { rollupMs: Date.now() - started, rollupBackfill: engine.backfillDays(7) };
}

function measureQueries() {
  const id = db.prepare('SELECT id FROM devices ORDER BY id LIMIT 1').get().id;
  const t1 = Date.now();
  const series = seriesFor(id, '24h');
  const seriesMs = Date.now() - t1;

  const t2 = Date.now();
  const dashboard = db
    .prepare(
      `SELECT COUNT(*) AS checks, SUM(ok) AS okc,
              AVG(CASE WHEN ok=1 THEN rtt_ms END) AS avg_rtt,
              AVG(CASE WHEN ok=1 THEN 0 ELSE 100 END) AS loss
       FROM samples WHERE ts >= ?`
    )
    .get(Date.now() - 86400000);
  const dashboardMs = Date.now() - t2;

  const t3 = Date.now();
  const report = db
    .prepare(
      `SELECT d.id, COUNT(s.id) AS checks, SUM(COALESCE(s.ok,0)) AS okCount,
              AVG(CASE WHEN s.ok=1 THEN s.rtt_ms END) AS avgRtt
       FROM devices d LEFT JOIN samples s ON s.device_id = d.id AND s.ts >= ?
       GROUP BY d.id`
    )
    .all(Date.now() - 7 * 86400000);
  const reportMs = Date.now() - t3;
  return { seriesPoints: series.points.length, seriesMs, dashboardChecks: dashboard.checks, dashboardMs, reportRows: report.length, reportMs };
}

/* ---------------------- اجرا ---------------------- */

const result = { config: { devices: DEVICES, workers: WORKERS, probe: PROBE, probeLatencyMs: PROBE_LATENCY_MS, lossRate: LOSS_RATE, intervalSec: INTERVAL_SEC, historyDays: HISTORY_DAYS, historyStepSec: HISTORY_STEP_SEC } };

seedDevices();
setSettings({
  engine_mode: PROBE === 'simulate' ? 'simulate' : 'simulate', // پروب mock مستقیماً جایگزین می‌شود
  max_workers: WORKERS,
  ping_interval: INTERVAL_SEC,
  failures_for_offline: 3,
  successes_for_online: 2,
  alerting_enabled: true,
  alert_cooldown: 600,
});
engine.invalidate();

result.historySamples = seedHistory();
result.dbBeforeMb = round(dbSizeBytes() / 1048576, 1);

result.cycle = await measureCycle();
result.dbAfterCycleMb = round(dbSizeBytes() / 1048576, 1);

const tRollup = measureRollup();
result.dbAfterRollupMb = round(dbSizeBytes() / 1048576, 1);
result.dailyStatsRows = db.prepare('SELECT COUNT(*) c FROM daily_stats').get().c;
result.rollupMs = tRollup.rollupMs;
result.queries = measureQueries();
result.openOutages = db.prepare('SELECT COUNT(*) c FROM outages WHERE open = 1').get().c;
result.alerts = db.prepare('SELECT COUNT(*) c FROM alerts').get().c;
result.dbFinalMb = round(dbSizeBytes() / 1048576, 1);

console.log('\n=== آزمون بار NetWatch ===');
console.log(`تجهیزات: ${DEVICES}   هم‌زمانی: ${WORKERS}   پروب: ${PROBE}   تاریخچه: ${result.historySamples.toLocaleString()} نمونه`);
console.log(`یک چرخهٔ کامل: ${result.cycle.fullCycleMs.toLocaleString()} ms (${result.cycle.checksPerSecond} بررسی/ثانیه)`);
console.log(`CPU: ${result.cycle.cpuTotalMs} ms (${result.cycle.cpuMsPerCheck} ms به‌ازای هر بررسی)   حافظه: ${result.cycle.rssStartMb} → ${result.cycle.rssEndMb} MB`);
console.log(`تأخیر حلقهٔ رویداد: میانگین ${result.cycle.eventLoopDelayMs.mean} ms | p99 ${result.cycle.eventLoopDelayMs.p99} ms | بیشینه ${result.cycle.eventLoopDelayMs.max} ms`);
console.log(`اوج هم‌زمانی مشاهده‌شده: ${result.cycle.peakInflight}   خطای موتور: ${result.cycle.engineErrors}`);
console.log(`پایگاه‌داده: ${result.dbBeforeMb} → ${result.dbFinalMb} MB   تجمیع روزانه: ${result.rollupMs} ms   کوئری نمودار: ${result.queries.seriesMs} ms   گزارش: ${result.queries.reportMs} ms`);
console.log(`قطعی باز: ${result.openOutages}   هشدارها: ${result.alerts}\n`);

if (OUT) {
  const outPath = path.isAbsolute(OUT) ? OUT : path.join(ROOT, OUT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`گزارش JSON: ${outPath}`);
}

db.close();
fs.rmSync(dataDir, { recursive: true, force: true });
