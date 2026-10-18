/**
 * آزمون بین‌فرآیندی قفل رهبری: دو اجرای هم‌زمان `engine-cli --once` روی یک
 * پایگاه‌داده نباید هر تجهیز را دو بار بررسی کنند. این همان حالتی است که
 * سرور با موتور داخلی و یک engine-cli جداگانه هم‌زمان اجرا می‌شوند.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { useTempDataDir, cleanupDir, ROOT } from '../helpers.mjs';

function runNode(args, dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        NETWATCH_DATA_DIR: dir,
        NETWATCH_ENGINE_MODE: 'simulate',
        NETWATCH_MAX_WORKERS: '512',
        NETWATCH_LOG_LEVEL: 'error',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

const runOnce = (dir) => runNode(['server/engine-cli.js', '--once'], dir);

test('two concurrent engines check every device exactly once', async () => {
  const dir = useTempDataDir('engine-lock-int');
  try {
    // ۱) ساخت پایگاه‌داده و دادهٔ نمایشی بدون اجرای موتور (تا نمونه‌های اولیه
    //    با نمونه‌های آزمون قاطی نشوند) و سررسیدکردن همهٔ تجهیزات
    const seed = await runNode(
      [
        '--input-type=module',
        '-e',
        "const m = await import('./server/db.js'); m.seedIfEmpty(); m.db.prepare('UPDATE devices SET next_check_at = 0').run(); m.db.close();",
      ],
      dir
    );
    assert.equal(seed.code, 0, `seed failed:\n${seed.out}`);

    const before = new DatabaseSync(path.join(dir, 'netwatch.db'));
    const since = before.prepare('SELECT COALESCE(MAX(ts), 0) AS ts FROM samples').get().ts;
    const totalDevices = before
      .prepare('SELECT COUNT(*) AS c FROM devices WHERE enabled = 1 AND monitoring_enabled = 1')
      .get().c;
    before.close();

    // ۲) دو فرآیند هم‌زمان با یک پایگاه‌داده
    const runs = await Promise.all([runOnce(dir), runOnce(dir)]);
    for (const r of runs) assert.equal(r.code, 0, `engine-cli failed:\n${r.out}`);

    const db = new DatabaseSync(path.join(dir, 'netwatch.db'));
    try {
      const { c, d } = db
        .prepare('SELECT COUNT(*) AS c, COUNT(DISTINCT device_id) AS d FROM samples WHERE ts > ?')
        .get(since);
      assert.ok(d > 0, 'at least one device must have been checked');
      assert.equal(d, totalDevices, `all ${totalDevices} devices must be checked by the leader`);
      assert.equal(c, d, `each device must be checked exactly once (samples=${c}, devices=${d})`);
      const lock = db.prepare('SELECT COUNT(*) AS c FROM engine_lock').get().c;
      assert.equal(lock, 0, 'the lock must be released when both processes exit');
    } finally {
      db.close();
    }
  } finally {
    cleanupDir(dir);
  }
});
