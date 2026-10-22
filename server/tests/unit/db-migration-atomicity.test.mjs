/**
 * Migration دیتابیس — اتمی بودن و ارتقا از همهٔ نسخه‌های پشتیبانی‌شده (BUG-24)
 * ----------------------------------------------------------------
 *  • شکست در میانهٔ یک گام باید کل گام (DDL و داده) را برگرداند، نسخهٔ قبلی را
 *    حفظ کند و رکوردی در schema_migrations جا نگذارد.
 *  • اجرای مجدد همان گام (پس از رفع خطا) باید از همان وضعیت معتبر ادامه دهد.
 *  • هر نسخهٔ ثبت‌شده از ۰ تا آخرین نسخه باید بدون از‌دست‌رفتن داده به نسخهٔ
 *    فعلی برسد و اجرای مجدد مهاجرت‌های اعمال‌شده نباید خطا بدهد.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { useTempDataDir, cleanupDir, ROOT } from '../helpers.mjs';

const dir = useTempDataDir('db-migration-atomicity');
const dbFile = path.join(dir, 'netwatch.db');
const DB_MODULE = pathToFileURL(path.join(ROOT, 'server', 'db.js')).href;

after(() => cleanupDir(dir));

function runNode(script) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      NETWATCH_DATA_DIR: dir,
      NETWATCH_DB: dbFile,
      NETWATCH_LOG_STREAM: 'stderr',
      NETWATCH_SEED_DEMO: '0',
      NETWATCH_DB_MODULE: DB_MODULE,
    },
  });
}

function resultOf(child) {
  const line = child.stdout.split('\n').find((l) => l.startsWith('RESULT:'));
  assert.ok(line, `missing result:\n${child.stdout}\n${child.stderr}`);
  return JSON.parse(line.slice('RESULT:'.length));
}

test('a failing migration step rolls back completely and can be retried', () => {
  const child = runNode(`
    const { db, applyMigrationStep } = await import(process.env.NETWATCH_DB_MODULE);
    db.exec('CREATE TABLE mig_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO mig_probe(value) VALUES (?)').run('before');
    const versionBefore = db.prepare('PRAGMA user_version').get().user_version;

    let failure = null;
    try {
      applyMigrationStep({
        version: 9001,
        name: 'failing-step',
        up: () => {
          db.exec("INSERT INTO mig_probe(value) VALUES ('partial')");
          db.exec('ALTER TABLE mig_probe ADD COLUMN extra TEXT');
          db.exec('CREATE TABLE should_not_exist (id INTEGER)');
          throw new Error('simulated mid-migration failure');
        },
      });
    } catch (e) {
      failure = { message: e.message, code: e.code, status: e.status, detail: e.detail };
    }

    const afterFailure = {
      version: db.prepare('PRAGMA user_version').get().user_version,
      recorded: db.prepare('SELECT * FROM schema_migrations WHERE version = 9001').get(),
      partialRow: db.prepare("SELECT COUNT(*) AS c FROM mig_probe WHERE value = 'partial'").get().c,
      extraColumn: db.prepare('PRAGMA table_info(mig_probe)').all().some((c) => c.name === 'extra'),
      leakedTable: db.prepare("SELECT COUNT(*) AS c FROM sqlite_schema WHERE type='table' AND name='should_not_exist'").get().c,
    };

    // اجرای مجدد همان گام، این بار بدون خطا
    applyMigrationStep({
      version: 9001,
      name: 'fixed-step',
      up: () => {
        db.exec('ALTER TABLE mig_probe ADD COLUMN extra TEXT');
        db.exec("INSERT INTO mig_probe(value) VALUES ('fixed')");
      },
    });
    const afterRetry = {
      version: db.prepare('PRAGMA user_version').get().user_version,
      recorded: db.prepare('SELECT * FROM schema_migrations WHERE version = 9001').get(),
      rows: db.prepare('SELECT value FROM mig_probe ORDER BY id').all().map((r) => r.value),
      successEvent: null,
    };
    process.stdout.write('RESULT:' + JSON.stringify({ versionBefore, failure, afterFailure, afterRetry }) + '\\n');
    db.close();
  `);
  assert.equal(child.status, 0, `child failed:\n${child.stdout}\n${child.stderr}`);
  const result = resultOf(child);

  assert.ok(result.failure, 'گام خراب باید خطا بدهد');
  assert.equal(result.failure.code, 'DB_MIGRATION_FAILED');
  assert.equal(result.failure.status, 500);
  assert.match(result.failure.message, /برگشت داده شد/);
  assert.deepEqual(result.failure.detail, { version: 9001, name: 'failing-step' });

  assert.equal(result.afterFailure.version, result.versionBefore, 'نسخه نباید جلو برود');
  assert.equal(result.afterFailure.recorded, undefined, 'گام ناموفق نباید ثبت شود');
  assert.equal(result.afterFailure.partialRow, 0, 'دادهٔ نیمه‌کاره باید برگردد');
  assert.equal(result.afterFailure.extraColumn, false, 'ستون تازهٔ گام ناموفق نباید بماند');
  assert.equal(result.afterFailure.leakedTable, 0, 'جدول ساخته‌شده در گام ناموفق نباید بماند');

  assert.equal(result.afterRetry.version, 9001, 'اجرای مجدد نسخه را ثبت می‌کند');
  assert.ok(result.afterRetry.recorded, 'گام موفق در schema_migrations ثبت می‌شود');
  assert.equal(result.afterRetry.recorded.name, 'fixed-step');
  assert.deepEqual(result.afterRetry.rows, ['before', 'fixed'], 'دادهٔ قبلی حفظ و فقط تغییر موفق اعمال می‌شود');
});

test('every supported recorded version upgrades to the current version without data loss', () => {
  fs.mkdirSync(dir, { recursive: true });
  const prepare = runNode(`
    const { db, SCHEMA_VERSION } = await import(process.env.NETWATCH_DB_MODULE);
    const now = Date.now();
    db.prepare('INSERT INTO devices(name, ip, status, enabled, monitoring_enabled, created_at, updated_at) VALUES (?,?,?,1,1,?,?)')
      .run('legacy-device', '10.91.0.1', 'unknown', now, now);
    process.stdout.write('RESULT:' + JSON.stringify({ schemaVersion: SCHEMA_VERSION }) + '\\n');
    db.close();
  `);
  assert.equal(prepare.status, 0, `prepare failed:\n${prepare.stdout}\n${prepare.stderr}`);
  const { schemaVersion } = resultOf(prepare);
  assert.ok(schemaVersion >= 2);

  for (let version = 0; version < schemaVersion; version++) {
    // شبیه‌سازی نسخهٔ ثبت‌شدهٔ v: نشانگر نسخه عقب می‌رود و رکوردهای بالاتر پاک
    // می‌شوند؛ خود داده (تجهیز) باید دست‌نخورده بماند.
    const legacy = new DatabaseSync(dbFile);
    legacy.exec(`PRAGMA user_version = ${version}`);
    legacy.exec(`DELETE FROM schema_migrations WHERE version > ${version}`);
    legacy.close();

    const child = runNode(`
      const { db, SCHEMA_VERSION } = await import(process.env.NETWATCH_DB_MODULE);
      const device = db.prepare('SELECT * FROM devices WHERE ip = ?').get('10.91.0.1');
      const version = db.prepare('PRAGMA user_version').get().user_version;
      const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
      const applied = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
      const hasSamples = db.prepare("SELECT COUNT(*) AS c FROM sqlite_schema WHERE type='table' AND name='samples'").get().c;
      process.stdout.write('RESULT:' + JSON.stringify({ device, version, integrity, applied, hasSamples, schemaVersion: SCHEMA_VERSION }) + '\\n');
      db.close();
    `);
    assert.equal(child.status, 0, `upgrade from v${version} failed:\n${child.stdout}\n${child.stderr}`);
    const result = resultOf(child);
    assert.equal(Number(result.version), Number(result.schemaVersion), `v${version} must reach current version`);
    assert.equal(result.integrity, 'ok', `v${version} must leave a healthy database`);
    assert.ok(result.device, `v${version} must preserve existing device rows`);
    assert.equal(result.device.name, 'legacy-device');
    assert.equal(result.hasSamples, 1, 'ساختار پایه پس از ارتقا کامل است');
    for (let v = 1; v <= schemaVersion; v++) {
      assert.ok(result.applied.includes(v), `گام ${v} باید پس از ارتقا از v${version} ثبت شده باشد`);
    }
  }
});
