/**
 * آزمون Fencing موتور:
 *   • رهبر سابق پس از انتقال رهبری نمی‌تواند نمونه/وضعیت ثبت کند.
 *   • دو بررسی هم‌زمان یک تجهیز فقط یک نمونه می‌سازند.
 *   • Restart در میانهٔ Probe: موتور جدید تا تخلیهٔ عملیات قبلی شروع نمی‌شود و
 *     نمونهٔ در جریان یک‌بار ثبت می‌شود.
 *   • توقف با مهلت: نتیجهٔ Probe دیرکرده پس از توقف ثبت نمی‌شود.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, addDevice, deviceRow, waitFor, probeResult } from '../helpers.mjs';

const dir = useTempDataDir('engine-fencing');
const { db, setSettings } = await import('../../db.js');
const { MonitoringEngine } = await import('../../engine.js');
const { LeaderLock } = await import('../../leader.js');

let seq = 0;
function newDevice(overrides = {}) {
  seq += 1;
  return addDevice(db, { name: `fence-${seq}`, ip: `10.90.0.${seq}`, ping_interval: 3600, next_check_at: 0, ...overrides });
}
const sampleCount = (id) => db.prepare('SELECT COUNT(*) c FROM samples WHERE device_id = ?').get(id).c;

setSettings({ engine_mode: 'simulate', ping_interval: 30, max_workers: 8, alerting_enabled: false });

after(() => {
  try {
    db.prepare('DELETE FROM engine_lock').run();
  } catch {
    /* بی‌اثر */
  }
  try {
    db.close();
  } catch {
    /* بی‌اثر */
  }
  cleanupDir(dir);
});

test('a former leader cannot record after leadership moves to another process', async () => {
  const lockA = new LeaderLock({ ttlMs: 60000 });
  const eng = new MonitoringEngine({ emitToBus: false, lock: lockA, stopDrainMs: 0 });
  await eng.start();
  const oldEpoch = eng.epoch;
  assert.equal(eng.leader, true);

  const id = newDevice({ status: 'online' });
  let releaseProbe;
  eng.probeWithDeadline = () => new Promise((resolve) => (releaseProbe = resolve));
  const pending = eng.checkDevice(deviceRow(db, id), { manual: true });
  await waitFor(() => eng.inflight.size === 1, { timeout: 2000 });

  // شبیه‌سازی Crash/توقف طولانی: Lease منقضی و فرآیند دوم رهبر می‌شود.
  db.prepare('UPDATE engine_lock SET expires_at = ? WHERE id = 1').run(Date.now() - 1);
  const lockB = new LeaderLock({ ttlMs: 60000 });
  assert.equal(lockB.tryAcquire(), true);
  assert.ok(lockB.epoch > oldEpoch, 'a takeover must get a new fencing token');

  releaseProbe(probeResult(true));
  const out = await pending;
  assert.equal(out, null, 'the fenced result must not be returned as a recorded sample');
  assert.equal(eng.stats.fenced, 1);
  assert.equal(eng.leader, false, 'the old leader must drop its local leadership');
  assert.equal(sampleCount(id), 0, 'no sample may be written by the former leader');
  assert.equal(deviceRow(db, id).total_checks, 0, 'device state must remain untouched');

  await eng.stop({ drainMs: 0 });
  lockB.release();
});

test('concurrent checks of the same device produce exactly one sample', async () => {
  const eng = new MonitoringEngine({ emitToBus: false, stopDrainMs: 0 });
  await eng.start();
  const id = newDevice({ status: 'online' });
  let releaseProbe;
  eng.probeWithDeadline = () => new Promise((resolve) => (releaseProbe = resolve));

  const first = eng.checkDevice(deviceRow(db, id), { manual: true });
  await waitFor(() => eng.inflight.size === 1, { timeout: 2000 });
  const second = eng.checkDevice(deviceRow(db, id), { manual: true });
  releaseProbe(probeResult(true));
  const [a, b] = await Promise.all([first, second]);

  assert.equal(a, b, 'the second caller receives the in-flight result');
  assert.equal(sampleCount(id), 1, 'exactly one record per operation');
  assert.equal(deviceRow(db, id).total_checks, 1);
  await eng.stop({ drainMs: 0 });
});

test('restart during an in-flight probe waits, records once and uses a new epoch', async () => {
  const eng = new MonitoringEngine({ emitToBus: false, stopDrainMs: 0 });
  await eng.start();
  const beforeEpoch = eng.epoch;
  const id = newDevice({ status: 'online' });

  let releaseProbe;
  eng.probeWithDeadline = () => new Promise((resolve) => (releaseProbe = resolve));
  const pending = eng.checkDevice(deviceRow(db, id), { manual: true });
  await waitFor(() => eng.inflight.size === 1, { timeout: 2000 });

  // restart باید ابتدا تخلیه کند؛ Probe ۳۰ms بعد تمام می‌شود.
  const restarting = eng.restart({ drainMs: 2000 });
  setTimeout(() => releaseProbe(probeResult(true)), 30);

  const status = await restarting;
  await pending;
  assert.equal(status.running, true);
  assert.equal(status.leader, true);
  assert.ok(status.epoch > beforeEpoch, 'the restarted engine leads a new term');
  assert.ok(eng.timer, 'the new cycle timer must be active');
  assert.equal(sampleCount(id), 1, 'the drained probe is recorded exactly once');
  await eng.stop({ drainMs: 0 });
});

test('a late probe result after stop is fenced and never recorded', async () => {
  const eng = new MonitoringEngine({ emitToBus: false, stopDrainMs: 0 });
  await eng.start();
  const id = newDevice({ status: 'online' });
  let releaseProbe;
  eng.probeWithDeadline = () => new Promise((resolve) => (releaseProbe = resolve));
  const pending = eng.checkDevice(deviceRow(db, id), { manual: true });
  await waitFor(() => eng.inflight.size === 1, { timeout: 2000 });

  const stopped = await eng.stop({ drainMs: 25 });
  assert.equal(stopped.running, false);
  releaseProbe(probeResult(true));
  const out = await pending;

  assert.equal(out, null);
  assert.equal(sampleCount(id), 0, 'a stopped engine must not write results');
  assert.equal(deviceRow(db, id).total_checks, 0);
  assert.equal(eng.lock.held, false);
});

test('manual checks are rejected when another process holds leadership', async () => {
  const other = new LeaderLock({ ttlMs: 60000 });
  assert.equal(other.tryAcquire(), true);
  const eng = new MonitoringEngine({ emitToBus: false, stopDrainMs: 0 });
  const id = newDevice({ status: 'online' });
  await assert.rejects(
    () => eng.checkDevice(deviceRow(db, id), { manual: true }),
    (e) => e.code === 'ENGINE_NOT_LEADER' && e.status === 409
  );
  assert.equal(sampleCount(id), 0);
  other.release();
});
