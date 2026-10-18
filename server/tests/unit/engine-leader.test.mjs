/**
 * آزمون رهبری موتور: دو نمونه روی یک پایگاه‌داده نباید هم‌زمان بررسی کنند.
 * نمونهٔ دوم در حالت آماده‌به‌کار می‌ماند و پس از توقف نمونهٔ اول کار را
 * ادامه می‌دهد (failover).
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, addDevice, waitFor } from '../helpers.mjs';

const dir = useTempDataDir('engine-leader');
const { db, setSettings } = await import('../../db.js');
const { MonitoringEngine } = await import('../../engine.js');
const { LeaderLock } = await import('../../leader.js');

setSettings({ engine_mode: 'simulate', ping_interval: 5, max_workers: 4, alerting_enabled: false });
for (let i = 1; i <= 3; i++) addDevice(db, { name: `lead-${i}`, ip: `10.40.0.${i}`, ping_interval: 5, next_check_at: 0 });

after(() => {
  db.prepare('DELETE FROM engine_lock').run();
  try {
    db.close();
  } catch {
    /* بی‌اثر */
  }
  cleanupDir(dir);
});

test('second engine stays in standby and takes over after the first stops', async () => {
  const lockA = new LeaderLock({ ttlMs: 2000 });
  const lockB = new LeaderLock({ ttlMs: 2000 });
  const a = new MonitoringEngine({ emitToBus: false, lock: lockA, lockRetryMs: 100 });
  const b = new MonitoringEngine({ emitToBus: false, lock: lockB, lockRetryMs: 100 });

  await a.start();
  await b.start();
  try {
    assert.equal(a.leader, true, 'first engine must acquire the lock');
    assert.equal(b.leader, false, 'second engine must not become leader');
    assert.equal(b.lock.status().owner, lockA.owner);

    await waitFor(() => a.stats.checksRun > 0, { timeout: 2000 });
    const checksWhileStandby = b.stats.checksRun;
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(a.stats.checksRun > 0, 'leader must run checks');
    assert.equal(b.stats.checksRun, checksWhileStandby, 'standby engine must not run checks');

    // خاموش‌سازی نمونهٔ اول قفل را آزاد می‌کند؛ نمونهٔ دوم باید رهبر شود
    a.stop();
    const becameLeader = await waitFor(() => b.leader, { timeout: 3000 });
    assert.ok(becameLeader, 'standby engine must acquire leadership after the leader stops');
    // تجهیز تازه‌ای که سررسید است تا بدون انتظار برای بازهٔ ۵ ثانیه‌ای بررسی شود
    addDevice(db, { name: 'lead-after-failover', ip: '10.40.0.9', ping_interval: 5, next_check_at: 0 });
    const before = b.stats.checksRun;
    await waitFor(() => b.stats.checksRun > before, { timeout: 2000 });
    assert.ok(b.stats.checksRun > before, 'new leader must start checking devices');
  } finally {
    a.stop();
    b.stop();
  }
});

test('an engine that loses the lock stops checking immediately', async () => {
  const lock = new LeaderLock({ ttlMs: 150 });
  const engine = new MonitoringEngine({ emitToBus: false, lock, lockRetryMs: 100 });
  await engine.start();
  try {
    assert.equal(engine.leader, true);
    await waitFor(() => engine.stats.checksRun > 0, { timeout: 2000 });
    const checksBefore = engine.stats.checksRun;

    // قفل منقضی می‌شود و نمونهٔ دیگری آن را می‌گیرد (مثلاً فرآیند رهبر کند بوده)
    db.prepare('UPDATE engine_lock SET expires_at = ? WHERE id = 1').run(Date.now() - 1);
    const thief = new LeaderLock({ ttlMs: 5000 });
    assert.equal(thief.tryAcquire(), true);
    engine.lastRenew = 0; // تمدید بعدی را اجباری کن

    await engine.tick();
    assert.equal(engine.leader, false, 'engine must notice lost leadership');
    assert.equal(engine.stats.checksRun, checksBefore, 'no check may run after losing the lock');

    // حتی با tickهای بعدی هم بررسی‌ای انجام نمی‌شود (قفل در اختیار دیگری است)
    await engine.tick();
    assert.equal(engine.stats.checksRun, checksBefore);
    thief.release();
  } finally {
    engine.stop();
  }
});
