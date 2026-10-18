/**
 * آزمون بین‌فرآیندی «قطع ناگهانی موتور» (Crash / kill -9):
 *   ۱) قطع ناگهانی وسط یک تراکنش چندمرحله‌ای موتور: هیچ رکورد نیمه‌کاره نمی‌ماند،
 *      هیچ قطعی باز تکراری ساخته نمی‌شود و پایگاه‌داده سالم است.
 *   ۲) قفل رهبری پس از Crash در وضعیت قفل‌شدهٔ ابدی نمی‌ماند؛ اجرای بعدی
 *      («engine-cli --once») بلافاصله پس از انقضای Lease رهبر می‌شود.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { useTempDataDir, cleanupDir, waitFor, ROOT } from '../helpers.mjs';

/** اجرای یک اسکریپت کوتاه در فرآیندی جدا روی پایگاه‌دادهٔ آزمون */
function runNode(args, dir, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, NETWATCH_DATA_DIR: dir, NETWATCH_LOG_LEVEL: 'error', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

/** فرآیندی که تا وقتی کشته شود زنده می‌ماند و هر خروجی‌اش جمع می‌شود */
function spawnHolder(args, dir, extraEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, NETWATCH_DATA_DIR: dir, NETWATCH_LOG_LEVEL: 'error', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d.toString()));
  child.stderr.on('data', (d) => (out += d.toString()));
  return { child, logs: () => out };
}

function openDb(dir) {
  return new DatabaseSync(path.join(dir, 'netwatch.db'));
}

const seedDevices = (dir) =>
  runNode(
    [
      '--input-type=module',
      '-e',
      `const m = await import('./server/db.js');
       const now = Date.now();
       for (let i = 1; i <= 3; i++) {
         m.db.prepare("INSERT INTO devices(name, ip, status, enabled, monitoring_enabled, ping_interval, next_check_at, created_at, updated_at) VALUES (?,?,?,1,1,3600,0,?,?)")
           .run('crash-' + i, '10.50.0.' + i, 'unknown', now, now);
       }
       m.db.close();`,
    ],
    dir
  );

test('a killed engine leaves no half-written record and never duplicates an open outage', async () => {
  const dir = useTempDataDir('engine-crash-int');
  try {
    const seeded = await seedDevices(dir);
    assert.equal(seeded.code, 0, `seed failed:\n${seeded.out}`);

    // فرآیند موتور وسط یک عملیات چندمرحله‌ای (باز کردن قطعی + تغییر وضعیت تجهیز)
    // با SIGKILL از بین می‌رود؛ تراکنش هرگز COMMIT نمی‌شود.
    const holder = spawnHolder(
      [
        '--input-type=module',
        '-e',
        `const m = await import('./server/db.js');
         const id = m.db.prepare('SELECT id FROM devices ORDER BY id LIMIT 1').get().id;
         m.transaction(() => {
           m.db.prepare("INSERT INTO outages(device_id, started_at, ended_at, duration_sec, cause, detail, open) VALUES (?,?,NULL,NULL,'Ping Timeout','',1)").run(id, Date.now());
           m.db.prepare("UPDATE devices SET status='offline', current_outage_id=last_insert_rowid() WHERE id=?").run(id);
           process.stdout.write('IN_TX\\n');
           Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
         });`,
      ],
      dir
    );
    const reachedTx = await waitFor(() => /IN_TX/.test(holder.logs()), { timeout: 15000 });
    assert.ok(reachedTx, `engine never reached the transaction:\n${holder.logs()}`);
    holder.child.kill('SIGKILL');
    const killed = await waitFor(() => holder.child.exitCode !== null || holder.child.signalCode !== null, { timeout: 5000 });
    assert.ok(killed, 'the engine process must be gone');

    // ۱) هیچ رکورد نیمه‌کاره‌ای باقی نمانده است
    const db = openDb(dir);
    try {
      const integrity = db.prepare('PRAGMA quick_check').get();
      assert.equal(Object.values(integrity)[0], 'ok', 'the database must still be healthy after kill -9');
      assert.equal(db.prepare('SELECT COUNT(*) c FROM outages').get().c, 0, 'the uncommitted outage must be rolled back');
      assert.equal(db.prepare("SELECT COUNT(*) c FROM devices WHERE status = 'offline'").get().c, 0);
      assert.equal(db.prepare('SELECT COUNT(*) c FROM devices').get().c, 3);
      assert.equal(db.prepare('SELECT COUNT(*) c FROM engine_lock').get().c, 0);
    } finally {
      db.close();
    }

    // ۲) قفل رهبری گرفته‌شده توسط فرآیند کشته‌شده، اجرای بعدی را قفل نمی‌کند
    const lockHolder = spawnHolder(
      [
        '--input-type=module',
        '-e',
        `const { LeaderLock } = await import('./server/leader.js');
         const lock = new LeaderLock({ ttlMs: 700 });
         process.stdout.write(lock.tryAcquire() ? 'LOCKED\\n' : 'NOT_LOCKED\\n');
         setInterval(() => {}, 1000);`,
      ],
      dir
    );
    const locked = await waitFor(() => /LOCKED|NOT_LOCKED/.test(lockHolder.logs()), { timeout: 15000 });
    assert.ok(locked, `the lock holder did not start:\n${lockHolder.logs()}`);
    assert.match(lockHolder.logs(), /LOCKED/);
    lockHolder.child.kill('SIGKILL');
    await waitFor(() => lockHolder.child.signalCode !== null, { timeout: 5000 });

    // اجرای تازه پیش از انقضای Lease: موتور دیگر هنوز «رهبر» شمرده می‌شود و این
    // اجرا نباید بررسی‌ای انجام دهد (وگرنه دو موتور هم‌زمان Ping می‌زنند).
    const tooEarly = await runNode(['server/engine-cli.js', '--once'], dir, {
      NETWATCH_ENGINE_MODE: 'simulate',
      NETWATCH_MAX_WORKERS: '64',
    });
    assert.equal(tooEarly.code, 0, `engine-cli --once failed:\n${tooEarly.out}`);
    const early = openDb(dir);
    try {
      assert.equal(early.prepare('SELECT COUNT(*) c FROM samples').get().c, 0, 'a still-valid lease must keep other engines in standby');
    } finally {
      early.close();
    }

    // پس از انقضای Lease، اجرای تازه باید رهبر شود و همهٔ تجهیزات را بررسی کند
    const reclaimed = await waitFor(
      () => {
        const d = openDb(dir);
        try {
          const row = d.prepare('SELECT expires_at FROM engine_lock WHERE id = 1').get();
          return !row || row.expires_at <= Date.now();
        } finally {
          d.close();
        }
      },
      { timeout: 5000, interval: 50 }
    );
    assert.ok(reclaimed, 'the crashed leader lease must expire by itself');

    const once = await runNode(['server/engine-cli.js', '--once'], dir, {
      NETWATCH_ENGINE_MODE: 'simulate',
      NETWATCH_MAX_WORKERS: '64',
    });
    assert.equal(once.code, 0, `engine-cli --once failed:\n${once.out}`);

    const after = openDb(dir);
    try {
      const { c, d } = after.prepare('SELECT COUNT(*) c, COUNT(DISTINCT device_id) d FROM samples').get();
      assert.equal(d, 3, 'the new leader must check every device');
      assert.equal(c, d, `each device exactly once (samples=${c}, devices=${d})`);
      assert.equal(after.prepare('SELECT COUNT(*) c FROM engine_lock').get().c, 0, 'the lock is released on exit');
      const duplicated = after.prepare('SELECT device_id, COUNT(*) c FROM outages WHERE open = 1 GROUP BY device_id HAVING c > 1').all();
      assert.deepEqual(duplicated, [], 'no device may have more than one open outage');
    } finally {
      after.close();
    }
  } finally {
    cleanupDir(dir);
  }
});
