#!/usr/bin/env node
/**
 * NetWatch — ماتریس بار ۱۰۰/۵۰۰/۱۰۰۰/۵۰۰۰ تجهیز با SLA صریح.
 *
 *   npm run qa:load
 *   node server/scripts/qa-load-matrix.mjs --sizes 100,1000 --workers 128
 *
 * هر اندازه در یک فرآیند جدا اجرا می‌شود تا حافظه/CPU بین سناریوها مخلوط نشود.
 * خروجی: data/qa/load-matrix.json + جدول خلاصه. کد خروج ۱ اگر هر SLA نقض شود.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const SIZES = String(arg('sizes', '100,500,1000,5000'))
  .split(',')
  .map(Number)
  .filter((n) => Number.isFinite(n) && n > 0);
const WORKERS = Number(arg('workers', 128));
const PROBE_LATENCY = Number(arg('probe-latency', 2));
const OUT_DIR = path.join(ROOT, 'data/qa');

/** SLA بر پایهٔ ظرفیت مرجع (۲ vCPU، ۴GB): یک چرخه باید از بازهٔ پایش عقب نماند. */
const SLA = {
  100: { cycleMs: 2000, p99Ms: 250, maxMs: 1000, rssGrowthMb: 100 },
  500: { cycleMs: 3000, p99Ms: 250, maxMs: 1000, rssGrowthMb: 100 },
  1000: { cycleMs: 5000, p99Ms: 250, maxMs: 1000, rssGrowthMb: 120 },
  5000: { cycleMs: 20000, p99Ms: 250, maxMs: 1000, rssGrowthMb: 150 },
};

function runOne(devices) {
  const out = path.join(OUT_DIR, `load-${devices}.json`);
  const started = Date.now();
  const res = spawnSync(
    process.execPath,
    [
      'server/scripts/load-test.mjs',
      '--devices', String(devices),
      '--workers', String(WORKERS),
      '--probe-latency', String(PROBE_LATENCY),
      '--history-days', '0',
      '--out', path.relative(ROOT, out),
    ],
    { cwd: ROOT, encoding: 'utf8', timeout: 240000 }
  );
  if (res.status !== 0) {
    throw new Error(`load-test ${devices} failed (exit ${res.status}):\n${res.stdout}\n${res.stderr}`);
  }
  const report = JSON.parse(fs.readFileSync(out, 'utf8'));
  const limits = SLA[devices] || SLA[1000];
  const checks = {
    completedAllChecks: report.cycle.devicesChecked === devices,
    cycleWithinSla: report.cycle.fullCycleMs <= limits.cycleMs,
    p99WithinSla: report.cycle.eventLoopDelayMs.p99 <= limits.p99Ms,
    maxWithinSla: report.cycle.eventLoopDelayMs.max <= limits.maxMs,
    noEngineErrors: report.cycle.engineErrors === 0,
    memoryBounded: report.cycle.rssEndMb - report.cycle.rssStartMb <= limits.rssGrowthMb,
  };
  return {
    devices,
    workers: WORKERS,
    probeLatencyMs: PROBE_LATENCY,
    limits,
    wallMs: Date.now() - started,
    cycleMs: report.cycle.fullCycleMs,
    checksPerSecond: report.cycle.checksPerSecond,
    cycle: report.cycle,
    dbFinalMb: report.dbFinalMb,
    queries: report.queries,
    checks,
    ok: Object.values(checks).every(Boolean),
  };
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const results = [];
let failed = false;
console.log('=== NetWatch load matrix ===');
console.log(`node ${process.version} | cpu ${os.cpus().length} | mem ${Math.round(os.totalmem() / 1048576)} MB | workers ${WORKERS}`);
for (const size of SIZES) {
  process.stdout.write(`\n→ ${size} devices ... `);
  try {
    const result = runOne(size);
    results.push(result);
    failed ||= !result.ok;
    console.log(
      `${result.cycleMs} ms | ${result.checksPerSecond}/s | p99 ${result.cycle.eventLoopDelayMs.p99} ms | ` +
      `RSS +${Math.round((result.cycle.rssEndMb - result.cycle.rssStartMb) * 10) / 10} MB | ${result.ok ? 'PASS' : 'FAIL'}`
    );
    if (!result.ok) console.log('  failed SLA:', Object.entries(result.checks).filter(([, v]) => !v).map(([k]) => k).join(', '));
  } catch (e) {
    failed = true;
    results.push({ devices: size, ok: false, error: e.message });
    console.log(`ERROR: ${e.message}`);
  }
}

const output = {
  generatedAt: new Date().toISOString(),
  environment: { node: process.version, cpus: os.cpus().length, totalMemMb: Math.round(os.totalmem() / 1048576) },
  sla: SLA,
  ok: !failed,
  results,
};
fs.writeFileSync(path.join(OUT_DIR, 'load-matrix.json'), JSON.stringify(output, null, 2));
console.log(`\n${failed ? '❌' : '✅'} load matrix ${failed ? 'failed' : 'passed'} — ${path.join(OUT_DIR, 'load-matrix.json')}`);
process.exit(failed ? 1 : 0);
