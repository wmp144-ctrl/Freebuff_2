#!/usr/bin/env node
/**
 * NetWatch — سنجش عملکرد پایگاه‌داده در مقیاس میلیونی
 * ----------------------------------------------------------------
 *   node server/scripts/qa-db-scale.mjs [--samples=3000000] [--devices=200]
 *        [--out=docs/phase2-scale-measurements.json] [--keep]
 *
 * کارها:
 *   • ساخت پایگاه‌دادهٔ موقت و درج میلیون‌ها نمونه (Batch + تراکنش مشخص)
 *   • اندازه‌گیری زمان Queryهای حیاتی داشبورد/گزارش/هرس
 *   • اندازه‌گیری رشد WAL و زمان Checkpoint
 *   • اجرای هم‌زمان «Import» و «Probe» در دو فرآیند و شمارش نوشته‌های گم‌شده
 *   • اجرای Retention واقعی روی دادهٔ کهنه و گزارش تعداد/زمان
 *   • مصرف CPU/RAM/Disk I/O از resourceUsage و /proc/self/io
 *
 * خروجی JSON روی فایل `--out` نوشته می‌شود (پیش‌فرض: docs/phase2-scale-measurements.json).
 * هیچ داده‌ای در پایگاه‌دادهٔ اصلی پروژه لمس نمی‌شود.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const SAMPLES = Math.max(10000, Math.min(10_000_000, Number(args.get('samples')) || 3_000_000));
const DEVICES = Math.max(10, Math.min(2000, Number(args.get('devices')) || 200));
const OUT = path.resolve(ROOT, args.get('out') || 'docs/phase2-scale-measurements.json');
const KEEP = args.has('keep');
const DAY = 86400000;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-scale-'));
process.env.NETWATCH_DATA_DIR = dataDir;
process.env.NETWATCH_DB_CHECK = 'off';
process.env.NETWATCH_LOG_STREAM = 'stderr';

const startedAt = Date.now();
const log = (...a) => console.error('[scale]', ...a);

const { db, DB_PATH, setSettings, checkDatabaseHealth } = await import('../db.js');
const { createBackup, verifyBackup, listBackups } = await import('../backup.js');
const { runRetention, retentionPolicy } = await import('../retention.js');

/* ------------------------------ داده‌سازی ------------------------------ */

function insertDevices(count) {
  const stmt = db.prepare(
    `INSERT INTO devices(name, ip, hostname, device_type, group_id, location, priority, enabled, monitoring_enabled,
       status, ping_interval, next_check_at, created_at, updated_at)
     VALUES (?,?,?,?,NULL,?,?,1,1,?,?,0,?,?)`
  );
  const now = Date.now();
  const ids = [];
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const ip = `10.${20 + (i % 40)}.${Math.floor(i / 40) % 250}.${(i % 250) + 1}`;
      ids.push(
        Number(
          stmt.run(
            `scale-device-${i}`,
            ip,
            `scale-${i}.local`,
            i % 5 === 0 ? 'سوئیچ' : 'روتر',
            'محیط آزمون',
            i % 11 === 0 ? 'critical' : i % 4 === 0 ? 'high' : 'normal',
            i % 7 === 0 ? 'offline' : 'online',
            30,
            now,
            now
          ).lastInsertRowid
        )
      );
    }
  }, { label: 'seed.devices' });
  return ids;
}

function insertSamples(deviceIds, total, days) {
  const stmt = db.prepare(
    'INSERT INTO samples(device_id, ts, rtt_ms, packets_sent, packets_recv, loss_pct, status, ok, mode, scheduled_at, started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  );
  const now = Date.now();
  const windowMs = days * DAY;
  const perDevice = Math.ceil(total / deviceIds.length);
  // گام زمانی یکتا برای هر تجهیز: قید یکتای (device_id, started_at) نباید
  // با رکوردهای هم‌زمان همان دستگاه برخورد کند.
  const stepMs = Math.max(1000, Math.floor(windowMs / perDevice));
  const batchRows = 50000;
  let inserted = 0;
  const durations = [];
  while (inserted < total) {
    const rows = Math.min(batchRows, total - inserted);
    const t0 = Date.now();
    db.transaction(() => {
      for (let i = 0; i < rows; i++) {
        const idx = inserted + i;
        const device = deviceIds[idx % deviceIds.length];
        const seq = Math.floor(idx / deviceIds.length);
        const ts = now - seq * stepMs - (idx % 977);
        const ok = idx % 97 === 0 ? 0 : 1;
        stmt.run(device, ts, ok ? 4 + (idx % 40) : null, 3, ok ? 3 : 0, ok ? 0 : 100, ok ? 'online' : 'offline', ok, 'test', ts, ts);
      }
    }, { label: 'seed.samples' });
    durations.push(Date.now() - t0);
    inserted += rows;
    if (inserted % 500000 === 0 || inserted === total) log(`samples: ${inserted.toLocaleString()}`);
  }
  return { inserted, batchDurationsMs: durations };
}

function seedDailyStats(deviceIds, days) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO daily_stats(device_id, day, checks, failed, avg_rtt, min_rtt, max_rtt, loss_pct, outages, downtime_sec, uptime_pct)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  const now = Date.now();
  db.transaction(() => {
    for (let d = 0; d < days; d++) {
      const day = new Date(now - d * DAY).toISOString().slice(0, 10);
      for (const id of deviceIds) stmt.run(id, day, 2880, 20, 12.5, 4, 40, 0.7, 0, 0, 99.3);
    }
  }, { label: 'seed.daily' });
  return days * deviceIds.length;
}

/* ------------------------------ اندازه‌گیری ------------------------------ */

function timeIt(fn, iterations = 1) {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn(i);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { totalMs: Math.round(ms * 100) / 100, avgMs: Math.round((ms / iterations) * 1000) / 1000 };
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function walInfo() {
  return { walBytes: fileSize(`${DB_PATH}-wal`), dbBytes: fileSize(DB_PATH), shmBytes: fileSize(`${DB_PATH}-shm`) };
}

function procIo() {
  try {
    const text = fs.readFileSync('/proc/self/io', 'utf8');
    const out = {};
    for (const line of text.split('\n')) {
      const [k, v] = line.split(':');
      if (k && v) out[k.trim()] = Number(v.trim());
    }
    return out;
  } catch {
    return null;
  }
}

function rssPeak() {
  try {
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    const m = status.match(/VmHWM:\s+(\d+) kB/);
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

/** عبارت import ماژول پایگاه‌داده برای اسکریپت‌های فرزند (ثابت، بدون ورودی کاربر) */
const DB_MODULE_IMPORT = `await import(${JSON.stringify(new URL('../db.js', import.meta.url).href)})`;

/** اجرای یک فرآیند فرزند با اسکریپت موقت روی دیسک (بدون دردسر کوتیشن) */
let childSeq = 0;
function runChild(code, extraEnv = {}) {
  const file = path.join(dataDir, `child-${++childSeq}.mjs`);
  fs.writeFileSync(file, code);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      cwd: ROOT,
      env: {
        ...process.env,
        NETWATCH_DATA_DIR: dataDir,
        NETWATCH_DB_CHECK: 'off',
        NETWATCH_LOG_STREAM: 'stderr',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

/* ------------------------------- اجرا ------------------------------- */

const report = {
  env: {
    node: process.version,
    platform: `${os.platform()} ${os.arch()}`,
    cpus: os.cpus().length,
    cores: os.cpus()[0]?.model || 'unknown',
    totalMemBytes: os.totalmem(),
    synchronous: await (async () => db.prepare('PRAGMA synchronous').get()?.synchronous)(),
    journalMode: db.prepare('PRAGMA journal_mode').get()?.journal_mode,
    pageSize: db.prepare('PRAGMA page_size').get()?.page_size,
    samplesRequested: SAMPLES,
    devices: DEVICES,
  },
  phases: {},
};

log(`dataDir=${dataDir} samples=${SAMPLES} devices=${DEVICES}`);
const deviceIds = insertDevices(DEVICES);
const sampleSeed = insertSamples(deviceIds, SAMPLES, 120);
const dailyRows = seedDailyStats(deviceIds, 130);

// چند قطعی/هشدار برای اندازه‌گیری Queryهای واقعی
const nowMs = Date.now();
db.transaction(() => {
  const outage = db.prepare('INSERT INTO outages(device_id, started_at, ended_at, duration_sec, cause, open) VALUES (?,?,?,?,?,0)');
  const alert = db.prepare("INSERT INTO alerts(device_id, severity, kind, title, created_at, status, duplicate_key) VALUES (?,?,?,?,?, 'resolved', ?)");
  for (let i = 0; i < 20000; i++) {
    const id = deviceIds[i % deviceIds.length];
    const ts = nowMs - (i % 300) * DAY;
    outage.run(id, ts, ts + 60000, 60, 'مشکل شبکه');
    alert.run(id, i % 3 === 0 ? 'critical' : 'warning', 'offline', `هشدار ${i}`, ts, `offline:${id}:${i}`);
  }
}, { label: 'seed.events' });

report.phases.seed = {
  devices: deviceIds.length,
  samples: sampleSeed.inserted,
  sampleBatches: sampleSeed.batchDurationsMs.length,
  sampleBatchMaxMs: Math.max(...sampleSeed.batchDurationsMs),
  sampleBatchAvgMs: Math.round((sampleSeed.batchDurationsMs.reduce((a, b) => a + b, 0) / sampleSeed.batchDurationsMs.length) * 100) / 100,
  rowsPerSecond: Math.round(sampleSeed.inserted / ((Date.now() - startedAt) / 1000)),
  dailyRows,
  dbBytes: fileSize(DB_PATH),
  durationMs: Date.now() - startedAt,
};
log('seed done', JSON.stringify(report.phases.seed));

/* ---------- Queryهای حیاتی (همان SQL مسیرهای داشبورد/گزارش) ---------- */

const one = deviceIds[0];
const queries = [
  {
    name: 'dashboard-series-1h',
    sql: 'SELECT (ts / 60000) * 60000 AS bucket, COUNT(*) c, SUM(ok) ok FROM samples WHERE device_id = ? AND ts >= ? GROUP BY bucket',
    params: [one, nowMs - 3600000],
    iterations: 50,
  },
  {
    name: 'reports-series-24h',
    sql: 'SELECT (ts / 300000) * 300000 AS bucket, COUNT(*) c, AVG(CASE WHEN ok=1 THEN rtt_ms END) rtt FROM samples WHERE device_id = ? AND ts >= ? GROUP BY bucket',
    params: [one, nowMs - DAY],
    iterations: 30,
  },
  {
    name: 'device-availability-total',
    sql: 'SELECT COUNT(*) c, SUM(ok) ok FROM samples WHERE device_id = ?',
    params: [one],
    iterations: 20,
  },
  {
    name: 'all-devices-check-count',
    sql: 'SELECT device_id, COUNT(*) c FROM samples WHERE ts >= ? GROUP BY device_id',
    params: [nowMs - DAY],
    iterations: 10,
  },
  {
    name: 'devices-due',
    sql: `SELECT id, ip FROM devices WHERE enabled = 1 AND monitoring_enabled = 1 AND next_check_at <= ? LIMIT 500`,
    params: [nowMs],
    iterations: 50,
  },
  {
    name: 'outages-device-recent',
    sql: 'SELECT * FROM outages WHERE device_id = ? ORDER BY started_at DESC LIMIT 100',
    params: [one],
    iterations: 50,
  },
  {
    name: 'alerts-active',
    sql: "SELECT * FROM alerts WHERE status = 'active' ORDER BY created_at DESC LIMIT 25",
    params: [],
    iterations: 30,
  },
  {
    name: 'daily-stats-range',
    sql: 'SELECT device_id, day, checks, failed FROM daily_stats WHERE day >= ? AND day < ?',
    params: ['2020-01-01', '2100-01-01'],
    iterations: 20,
  },
  {
    name: 'audit-recent',
    sql: 'SELECT * FROM audit_log ORDER BY ts DESC LIMIT 50',
    params: [],
    iterations: 30,
  },
];

report.phases.queries = queries.map((q) => {
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params).map((r) => String(r.detail));
  const timing = timeIt(() => db.prepare(q.sql).all(...q.params), q.iterations);
  return { name: q.name, iterations: q.iterations, plan, ...timing };
});
log('queries measured');

/* ---------- رشد WAL و زمان Checkpoint ---------- */

const walBefore = walInfo();
const checkpointTiming = timeIt(() => {
  db.checkpoint('TRUNCATE');
}, 3);
const walAfter = walInfo();
report.phases.wal = {
  before: walBefore,
  afterCheckpoint: walAfter,
  checkpoint: checkpointTiming,
  autocheckpointPages: db.prepare('PRAGMA wal_autocheckpoint').get()?.wal_autocheckpoint,
  journalSizeLimit: db.prepare('PRAGMA journal_size_limit').get()?.journal_size_limit,
};

/* ---------- نوشتن هم‌زمان: Import + Probe ---------- */  const importChild = runChild(`
  process.env.NETWATCH_DB_CHECK='off';
  process.env.NETWATCH_LOG_STREAM='stderr';
  const { db } = ${DB_MODULE_IMPORT};
  const now = Date.now();
  const stmt = db.prepare('INSERT INTO devices(name, ip, status, enabled, monitoring_enabled, created_at, updated_at, next_check_at) VALUES (?,?,?,1,1,?,?,0)');
  const base = 200 + (process.pid % 50);
  let ok = 0, failed = 0;
  for (let i = 0; i < 800; i++) {
    try {
      const ip = '10.' + base + '.' + (Math.floor(i / 250)) + '.' + ((i % 250) + 1);
      stmt.run('import-'+process.pid+'-'+i, ip, 'online', now, now); ok++;
    } catch { failed++; }
  }
  process.stdout.write('RESULT:'+JSON.stringify({ok, failed})+'\\n');
  db.close();
`);  const probeChild = runChild(`
  process.env.NETWATCH_DB_CHECK='off';
  process.env.NETWATCH_LOG_STREAM='stderr';
  const { db } = ${DB_MODULE_IMPORT};
  const devices = db.prepare('SELECT id FROM devices ORDER BY id LIMIT 50').all();
  const stmt = db.prepare('INSERT INTO samples(device_id, ts, rtt_ms, packets_sent, packets_recv, loss_pct, status, ok, mode) VALUES (?,?,?,1,1,0,?,1,\\'test\\')');
  let ok = 0, failed = 0;
  for (let i = 0; i < 1500; i++) {
    try { stmt.run(devices[i % devices.length].id, Date.now() + i, 5, 'online'); ok++; }
    catch { failed++; }
  }
  process.stdout.write('RESULT:'+JSON.stringify({ok, failed})+'\\n');
  db.close();
`);

const [importRes, probeRes] = await Promise.all([importChild, probeChild]);
const parseChild = (r) => {
  const line = String(r.out).split('\n').find((l) => l.startsWith('RESULT:'));
  return line ? JSON.parse(line.slice(7)) : { error: r.out.slice(-1200), code: r.code };
};
report.phases.concurrentWrite = {
  import: parseChild(importRes),
  probe: parseChild(probeRes),
  importedDevices: db.prepare("SELECT COUNT(*) c FROM devices WHERE name LIKE 'import-%'").get().c,
  testModeSamples: db.prepare("SELECT COUNT(*) c FROM samples WHERE mode = 'test'").get().c,
  busyErrors: db.prepare("SELECT COUNT(*) c FROM engine_log WHERE message LIKE '%BUSY%' OR message LIKE '%locked%'").get().c,
};
log('concurrent write done', JSON.stringify(report.phases.concurrentWrite));

/* ---------- Retention در مقیاس (با تجمیع تثبیت‌شده) ---------- */

setSettings({ samples_retention_days: 60, retention_batch_size: 20000, retention_max_rows_per_run: 3000000, timezone_offset_minutes: 0 });
const policy = retentionPolicy();
const dry = runRetention({ trigger: 'manual', dryRun: true, actor: 'scale' });
const beforeRetention = db.prepare('SELECT COUNT(*) c FROM samples').get().c;
const retentionRun = runRetention({ trigger: 'manual', actor: 'scale' });
const afterRetention = db.prepare('SELECT COUNT(*) c FROM samples').get().c;
report.phases.retention = {
  policy,
  dryRunCounts: dry.counts,
  blocked: retentionRun.blocked,
  deleted: retentionRun.deleted,
  deletedRows: retentionRun.deletedRows,
  batches: retentionRun.batches,
  durationMs: retentionRun.durationMs,
  freedBytes: retentionRun.freedBytes,
  samplesBefore: beforeRetention,
  samplesAfter: afterRetention,
  status: retentionRun.status,
};
log('retention done', JSON.stringify(report.phases.retention));

/* ---------- Backup/Restore در مقیاس ---------- */

const backupStarted = Date.now();
const backup = createBackup({ reason: 'scale', includeMbtiles: false });
const backupDuration = Date.now() - backupStarted;
const verifyStarted = Date.now();
const verification = verifyBackup(backup.dir);
const verifyDuration = Date.now() - verifyStarted;
report.phases.backup = {
  durationMs: backupDuration,
  verifyDurationMs: verifyDuration,
  sizeBytes: backup.manifest.db.size,
  sha256: backup.manifest.db.sha256,
  counts: backup.manifest.db.counts,
  integrityOk: verification.ok,
  sets: listBackups().length,
};
log('backup done', JSON.stringify(report.phases.backup));

/* ---------- سلامت و منابع ---------- */

const health = checkDatabaseHealth({ full: true });
const usage = process.resourceUsage();
const io = procIo();
report.phases.health = { ok: health.ok, durationMs: health.durationMs, foreignKeyViolations: health.foreignKeyViolations };
report.phases.resources = {
  wallMs: Date.now() - startedAt,
  cpuUserMs: Math.round(usage.userCPUTime / 1000),
  cpuSystemMs: Math.round(usage.systemCPUTime / 1000),
  maxRssBytes: usage.maxRSS * 1024,
  peakRssBytes: rssPeak(),
  heapUsedBytes: process.memoryUsage().heapUsed,
  readBytes: io?.read_bytes ?? null,
  writeBytes: io?.write_bytes ?? null,
  dbBytes: fileSize(DB_PATH),
  walBytes: fileSize(`${DB_PATH}-wal`),
};
report.phases.table_rows = Object.fromEntries(
  ['devices', 'samples', 'outages', 'alerts', 'daily_stats', 'audit_log', 'retention_runs']
    .map((t) => [t, db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c])
);
report.generatedAt = new Date().toISOString();
report.totalDurationMs = Date.now() - startedAt;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ out: OUT, totalDurationMs: report.totalDurationMs, phases: Object.keys(report.phases) }, null, 2));

db.close();
if (!KEEP) fs.rmSync(dataDir, { recursive: true, force: true });
else console.error(`[scale] kept ${dataDir}`);
