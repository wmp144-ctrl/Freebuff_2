/**
 * آزمون چرخهٔ حیات موتور:
 *   • start هم‌زمان دو بار یک نمونه و یک تایمر می‌سازد.
 *   • stop تایمر چرخه، تایمر تمدید Lease، هشدارهای معوق و قفل را آزاد می‌کند.
 *   • restart هم‌زمان سریال می‌شود و دو موتور موازی نمی‌سازد.
 *   • پس از stop، tick هیچ کاری انجام نمی‌دهد و Event Loop بلوکه نمی‌ماند.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, addDevice, deviceRow, waitFor } from '../helpers.mjs';

const dir = useTempDataDir('engine-lifecycle');
const { db, setSettings, STATUS } = await import('../../db.js');
const { MonitoringEngine } = await import('../../engine.js');

let seq = 0;
function newDevice(overrides = {}) {
  seq += 1;
  return addDevice(db, { name: `life-${seq}`, ip: `10.91.0.${seq}`, ping_interval: 3600, next_check_at: 0, ...overrides });
}

setSettings({ engine_mode: 'simulate', ping_interval: 30, max_workers: 4, alerting_enabled: true, alert_delay: 30 });

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

test('concurrent start calls create one running engine and one timer', async () => {
  const eng = new MonitoringEngine({ emitToBus: false, stopDrainMs: 0 });
  const [a, b] = await Promise.all([eng.start(), eng.start()]);
  assert.equal(a.running, true);
  assert.equal(b.running, true);
  assert.equal(eng.leader, true);
  assert.ok(eng.timer);
  assert.ok(eng.leaseTimer);
  await eng.stop({ drainMs: 0 });
});

test('stop releases the cycle timer, lease timer, pending alerts and the lock', async () => {
  const eng = new MonitoringEngine({ emitToBus: false, stopDrainMs: 0 });
  await eng.start();
  const id = newDevice({ status: STATUS.OFFLINE });
  // هشدار با تأخیر: یک تایمر در pending ساخته می‌شود
  eng.raiseAlert('offline', deviceRow(db, id), {
    severity: 'critical',
    title: 'تست',
    message: 'تست',
    value: 1,
    ts: Date.now(),
  });
  assert.equal(eng.pending.size, 1);

  const status = await eng.stop({ drainMs: 0 });
  assert.equal(status.running, false);
  assert.equal(status.leader, false);
  assert.equal(status.epoch, 0);
  assert.equal(eng.timer, null);
  assert.equal(eng.leaseTimer, null);
  assert.equal(eng.pending.size, 0, 'pending alert timers must be cleared');
  assert.equal(eng.lock.held, false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM engine_lock').get().c, 0);

  // tick پس از توقف نباید چیزی اجرا کند
  const cycles = eng.stats.cycles;
  await eng.tick();
  assert.equal(eng.stats.cycles, cycles);
});

test('concurrent restart calls are serialized and leave one healthy engine', async () => {
  const eng = new MonitoringEngine({ emitToBus: false, stopDrainMs: 0 });
  await eng.start();
  const before = eng.epoch;
  const first = eng.restart({ drainMs: 100 });
  const second = eng.restart({ drainMs: 100 });
  assert.equal(first, second, 'the second restart must reuse the in-flight transition');
  const status = await first;
  assert.equal(status.running, true);
  assert.equal(status.leader, true);
  assert.ok(status.epoch > before);
  assert.ok(eng.timer);
  assert.equal(eng._restartPromise, null);
  await eng.stop({ drainMs: 0 });
});

test('a standby engine never writes and takes over after the leader stops', async () => {
  const leader = new MonitoringEngine({ emitToBus: false, stopDrainMs: 0, lockRetryMs: 50 });
  const standby = new MonitoringEngine({ emitToBus: false, stopDrainMs: 0, lockRetryMs: 50 });
  await leader.start();
  await standby.start();
  try {
    newDevice({ status: STATUS.ONLINE });
    assert.equal(leader.leader, true);
    assert.equal(standby.leader, false);
    const before = standby.stats.checksRun;
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(standby.stats.checksRun, before, 'a standby engine must not run checks');

    await leader.stop({ drainMs: 0 });
    const tookOver = await waitFor(() => standby.leader, { timeout: 3000 });
    assert.ok(tookOver, 'the standby must acquire leadership');
    assert.ok(standby.epoch > 0);
  } finally {
    await standby.stop({ drainMs: 0 });
  }
});
