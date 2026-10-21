/**
 * آزمون نصب و ارتقا (بند ۴ سند پذیرش)
 * ----------------------------------------------------------------
 *   • نصب تمیز با NETWATCH_SEED_DEMO=0: بدون دادهٔ نمایشی، فقط حساب مدیر.
 *   • ارتقا از نسخهٔ قبلی (schema v3) روی پایگاه‌دادهٔ کپی‌شده و پرشده:
 *     داده حفظ می‌شود، پشتیبان پیش از Migration ساخته می‌شود و همان فایل
 *     می‌تواند نقطهٔ بازگشت (Rollback) باشد.
 *   • خطای Migration: گام نیمه‌کاره باقی نمی‌ماند و سرویس با پیام روشن بالا
 *     نمی‌آید.
 *   • پایگاه‌دادهٔ خراب: پیش‌فرض «توقف» است؛ با NETWATCH_DB_CHECK=warn فقط
 *     هشدار داده می‌شود.
 *
 * هیچ آزمونی روی پایگاه‌دادهٔ واقعی اجرا نمی‌شود؛ همه‌چیز کپی موقت است.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, TEST_ADMIN, api, cleanupDir, freePort, startServer, useTempDataDir } from '../helpers.mjs';

const dirs = [];
function tempDir(tag) {
  const d = useTempDataDir(tag);
  dirs.push(d);
  return d;
}

after(() => {
  for (const d of dirs) cleanupDir(d);
});

function dbFile(dir) {
  return path.join(dir, 'netwatch.db');
}

function countDevices(dir) {
  const db = new DatabaseSync(dbFile(dir));
  try {
    return Number(db.prepare('SELECT COUNT(*) AS c FROM devices').get().c);
  } finally {
    db.close();
  }
}

/**
 * بازگرداندن یک پایگاه‌دادهٔ کامل به وضعیت نسخهٔ قبلی (schema v3):
 * ستون‌های امنیتی v4 و ایندکس‌های عملکردی v5 برداشته می‌شوند.
 */
function downgradeToV3(dir) {
  const legacy = new DatabaseSync(dbFile(dir));
  legacy.exec(`
    DROP INDEX IF EXISTS idx_sessions_last_seen;
    ALTER TABLE users DROP COLUMN failed_login_count;
    ALTER TABLE users DROP COLUMN locked_until;
    ALTER TABLE users DROP COLUMN password_changed_at;
    DROP INDEX IF EXISTS idx_alerts_status_created;
    DROP INDEX IF EXISTS idx_outages_ended_open;
    DROP INDEX IF EXISTS idx_daily_device_day;
    DELETE FROM schema_migrations WHERE version >= 4;
    PRAGMA user_version = 3;
  `);
  legacy.close();
}

/** اجرای سرور تا پایان (برای سناریوهای شکست راه‌اندازی) */
async function runServerUntilExit(dir, env = {}) {
  return spawnSync(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      NETWATCH_DATA_DIR: dir,
      NETWATCH_ENGINE: '0',
      NETWATCH_ADMIN_PASSWORD: TEST_ADMIN.password,
      HOST: '127.0.0.1',
      PORT: String(await freePort()),
      ...env,
    },
  });
}

test('clean production install seeds no demo data but creates the admin account', async () => {
  const dir = tempDir('install-clean');
  const srv = await startServer({ dataDir: dir, engine: false, env: { NETWATCH_SEED_DEMO: '0' } });
  try {
    const devices = await api(srv.base, 'GET', '/api/devices');
    assert.equal(devices.status, 200);
    assert.equal(devices.data.total, 0, 'نصب Production نباید تجهیز نمایشی داشته باشد');

    const users = await api(srv.base, 'GET', '/api/auth/users');
    assert.equal(users.status, 200);
    assert.deepEqual(
      users.data.items.map((u) => u.username),
      ['admin'],
      'تنها حساب مدیر ساخته می‌شود'
    );

    const status = await api(srv.base, 'GET', '/api/system/db/health');
    assert.equal(status.data.ok, true);
  } finally {
    await srv.stop();
  }
});

test('upgrade of a populated v3 database keeps data and leaves a usable rollback point', async () => {
  const dir = tempDir('upgrade-v3');
  let srv = await startServer({ dataDir: dir, engine: false });
  try {
    const created = await api(srv.base, 'POST', '/api/devices', { name: 'Legacy-Device', ip: '10.220.0.5' });
    assert.equal(created.status, 201);
  } finally {
    await srv.stop();
  }
  const before = countDevices(dir);
  assert.ok(before >= 1);

  downgradeToV3(dir);
  srv = await startServer({ dataDir: dir, engine: false });
  try {
    const devices = await api(srv.base, 'GET', '/api/devices?pageSize=100');
    assert.equal(devices.data.total, before, 'دادهٔ تجهیزات باید پس از ارتقا حفظ شود');
    assert.ok(devices.data.items.some((d) => d.name === 'Legacy-Device'));

    const health = await api(srv.base, 'GET', '/api/system/db/health');
    assert.equal(health.data.ok, true, 'پایگاه‌داده پس از ارتقا باید سالم باشد');
  } finally {
    await srv.stop();
  }

  const upgraded = new DatabaseSync(dbFile(dir));
  const state = {
    version: Number(upgraded.prepare('PRAGMA user_version').get().user_version),
    migrations: upgraded.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => Number(r.version)),
    usersColumns: upgraded.prepare('PRAGMA table_info(users)').all().map((c) => c.name),
    indexes: upgraded.prepare("SELECT name FROM sqlite_schema WHERE type='index'").all().map((i) => i.name),
    devices: Number(upgraded.prepare('SELECT COUNT(*) AS c FROM devices').get().c),
  };
  upgraded.close();

  assert.equal(state.version, state.migrations.at(-1));
  assert.deepEqual(state.migrations, [1, 2, 3, 4, 5, 6]);
  for (const column of ['failed_login_count', 'locked_until', 'password_changed_at']) {
    assert.ok(state.usersColumns.includes(column), `ستون ${column} باید اضافه شود`);
  }
  for (const index of ['idx_alerts_status_created', 'idx_outages_ended_open', 'idx_daily_device_day', 'idx_sessions_last_seen']) {
    assert.ok(state.indexes.includes(index), `ایندکس ${index} باید ساخته شود`);
  }
  assert.equal(state.devices, before);

  // نقطهٔ بازگشت: فایل پیش از Migration باید نسخهٔ ۳ و همان داده را داشته باشد.
  const backupName = fs.readdirSync(dir).find((f) => f.includes('.pre-migration-v3-'));
  assert.ok(backupName, 'پشتیبان پیش از Migration باید ساخته شود');
  const rollback = new DatabaseSync(path.join(dir, backupName));
  const rollbackVersion = Number(rollback.prepare('PRAGMA user_version').get().user_version);
  const rollbackDevices = Number(rollback.prepare('SELECT COUNT(*) AS c FROM devices').get().c);
  const rollbackColumns = rollback.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  rollback.close();
  assert.equal(rollbackVersion, 3);
  assert.equal(rollbackDevices, before);
  assert.equal(rollbackColumns.includes('locked_until'), false, 'فایل بازگشت پیش از Migration است');
});

test('a failing migration aborts startup and leaves no partial schema', async () => {
  // (سناریوی خطای Migration: گام باید اتمیک برگردد و راه‌اندازی متوقف شود)
  const dir = tempDir('upgrade-fail');
  // پایگاه‌دادهٔ واقعی (بدون دادهٔ نمایشی برای سرعت)، سپس بازگرداندن به v3 و
  // ایجاد یک شیء همنام که ساخت ایندکس Migration 5 را شکست می‌دهد.
  const seedSrv = await startServer({ dataDir: dir, engine: false, env: { NETWATCH_SEED_DEMO: '0' } });
  await seedSrv.stop();
  downgradeToV3(dir);
  const legacy = new DatabaseSync(dbFile(dir));
  legacy.exec('CREATE VIEW idx_alerts_status_created AS SELECT 1 AS conflict;');
  legacy.close();

  const run = await runServerUntilExit(dir);
  assert.notEqual(run.status, 0, 'راه‌اندازی باید با خطا متوقف شود');
  const output = `${run.stdout}\n${run.stderr}`;
  assert.match(output, /مهاجرت|migration/i, `پیام خطای Migration دیده نشد:\n${output.slice(0, 800)}`);

  const db = new DatabaseSync(dbFile(dir));
  const state = {
    version: Number(db.prepare('PRAGMA user_version').get().user_version),
    migrations: db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => Number(r.version)),
    indexes: db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name LIKE 'idx_%'").all().map((i) => i.name),
  };
  db.close();
  // گام ۴ کامل شده است، اما گام ۵ (شکست‌خورده) هیچ اثری باقی نگذاشته است.
  assert.equal(state.version, 4, 'نسخه باید در آخرین گام موفق بماند');
  assert.deepEqual(state.migrations, [1, 2, 3, 4]);
  assert.equal(state.indexes.includes('idx_alerts_status_created'), false, 'ایندکس گام ناموفق نباید ساخته شود');

  // پس از رفع تعارض، همان پایگاه‌داده باید قابل ارتقا باشد (بازیابی از خطا).
  const fixed = new DatabaseSync(dbFile(dir));
  fixed.exec('DROP VIEW idx_alerts_status_created;');
  fixed.close();
  const retry = await startServer({ dataDir: dir, engine: false });
  try {
    assert.equal((await api(retry.base, 'GET', '/api/health')).status, 200);
  } finally {
    await retry.stop();
  }
  const dbAfter = new DatabaseSync(dbFile(dir));
  const version = Number(dbAfter.prepare('PRAGMA user_version').get().user_version);
  dbAfter.close();
  assert.equal(version, 6, 'اجرای دوباره باید Migration را کامل کند');
});

test('a corrupt database stops startup unless explicitly downgraded to warning', async () => {
  const good = tempDir('corrupt-source');
  const srv = await startServer({ dataDir: good, engine: false });
  await srv.stop();

  const broken = tempDir('corrupt-copy');
  fs.copyFileSync(dbFile(good), dbFile(broken));
  // خراب‌کردن یک صفحهٔ دادهٔ انتهایی: فایل باز و قابل‌نوشتن می‌ماند ولی
  // quick_check آسیب را می‌بیند (سناریوی واقعی «دیتابیس خراب»).
  const size = fs.statSync(dbFile(broken)).size;
  assert.ok(size > 8192, 'پایگاه‌داده باید چند صفحه داشته باشد');
  const fd = fs.openSync(dbFile(broken), 'r+');
  fs.writeSync(fd, Buffer.alloc(4096, 0xff), 0, 4096, size - 8192);
  fs.closeSync(fd);

  const run = await runServerUntilExit(broken);
  assert.notEqual(run.status, 0, 'راه‌اندازی روی پایگاه‌دادهٔ خراب باید متوقف شود');
  assert.match(
    `${run.stdout}\n${run.stderr}`,
    /پایگاه‌داده آسیب دیده|db_health_failed|quick_check/i,
    'پیام باید علت را روشن کند'
  );

  // با NETWATCH_DB_CHECK=warn سرویس بالا می‌آید تا اپراتور بتواند پشتیبان را
  // بازیابی کند؛ این حالت باید صریح و آگاهانه باشد.
  const port = await freePort();
  const relaxed = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NETWATCH_DATA_DIR: broken,
      NETWATCH_ENGINE: '0',
      NETWATCH_ADMIN_PASSWORD: TEST_ADMIN.password,
      NETWATCH_DB_CHECK: 'warn',
      HOST: '127.0.0.1',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  relaxed.stdout.on('data', (d) => (logs += d.toString()));
  relaxed.stderr.on('data', (d) => (logs += d.toString()));
  try {
    let health = null;
    for (let i = 0; i < 40 && !health; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      health = await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null);
    }
    assert.ok(health && health.status < 500, `با warn سرویس باید بالا بیاید:\n${logs.slice(0, 600)}`);
    assert.match(logs, /هشدار|warn/i, 'هشدار صریح دربارهٔ پایگاه‌دادهٔ ناسالم باید ثبت شود');
  } finally {
    relaxed.kill('SIGTERM');
    await new Promise((resolve) => relaxed.once('exit', resolve));
  }
});
