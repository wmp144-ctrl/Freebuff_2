/**
 * Migration نسخهٔ ۱۰ روی پایگاه‌دادهٔ واقعی نسخهٔ ۹:
 *   • دادهٔ تجهیزات و گروه‌ها دست‌نخورده می‌ماند.
 *   • تاریخ نصب به‌صورت NULL (ناشناخته) اضافه می‌شود.
 *   • عضویت گروهی از ستون قدیمی group_id پر می‌شود.
 *   • جداول کشف/قالب/پیوست ساخته می‌شوند و نسخه به ۱۰ می‌رسد.
 *   • پیش از تغییر، پشتیبان فایلی گرفته می‌شود.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { useTempDataDir, cleanupDir, ROOT } from '../helpers.mjs';

const dir = useTempDataDir('db-management-migration');
const dbFile = path.join(dir, 'legacy-v9.db');
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

test('v9 database is upgraded to v10 and group membership is backfilled', () => {
  // ۱) ساخت پایگاه‌دادهٔ کامل با خود برنامه (نسخهٔ فعلی)
  const prepare = runNode(`await import(process.env.NETWATCH_DB_MODULE); process.stdout.write('READY\\n');`);
  assert.equal(prepare.status, 0, `prepare failed:\n${prepare.stdout}\n${prepare.stderr}`);

  // ۲) شبیه‌سازی نسخهٔ ۹: حذف دقیقاً همان چیزی که گام ۱۰ اضافه می‌کند
  const legacy = new DatabaseSync(dbFile);
  legacy.exec(`
    DROP TABLE IF EXISTS device_group_members;
    DROP TABLE IF EXISTS device_templates;
    DROP TABLE IF EXISTS device_attachments;
    DROP TABLE IF EXISTS discovery_ranges;
    DROP TABLE IF EXISTS discovery_results;
    DROP INDEX IF EXISTS idx_devices_installed;
    ALTER TABLE devices DROP COLUMN installed_at;
    DELETE FROM schema_migrations WHERE version = 10;
    PRAGMA user_version = 9;
  `);
  const now = Date.UTC(2026, 0, 1);
  legacy.prepare('INSERT INTO groups(name, created_at) VALUES (?,?)').run('قدیمی', now);
  const groupId = legacy.prepare('SELECT id FROM groups WHERE name=?').get('قدیمی').id;
  legacy
    .prepare('INSERT INTO devices(name, ip, group_id, status, enabled, monitoring_enabled, created_at, updated_at) VALUES (?,?,?,?,1,1,?,?)')
    .run('تجهیز قدیمی', '10.90.0.5', groupId, 'unknown', now, now);
  legacy.close();

  // ۳) ارتقا با اجرای واقعی برنامه
  const child = runNode(`const { db, SCHEMA_VERSION } = await import(process.env.NETWATCH_DB_MODULE);
   const device = db.prepare('SELECT * FROM devices WHERE name = ?').get('تجهیز قدیمی');
   const columns = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name);
   const membership = db.prepare('SELECT * FROM device_group_members WHERE device_id = ?').all(device.id);
   const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((r) => r.name);
   const migration = db.prepare('SELECT * FROM schema_migrations WHERE version = 10').get();
   const version = db.prepare('PRAGMA user_version').get().user_version;
   process.stdout.write('RESULT:' + JSON.stringify({ device, columns, membership, tables, migration, version, schemaVersion: SCHEMA_VERSION }) + '\\n');
   db.close();`);
  assert.equal(child.status, 0, `child failed:\n${child.stdout}\n${child.stderr}`);
  const line = child.stdout.split('\n').find((l) => l.startsWith('RESULT:'));
  assert.ok(line, `missing result:\n${child.stdout}\n${child.stderr}`);
  const result = JSON.parse(line.slice('RESULT:'.length));

  assert.equal(result.device.name, 'تجهیز قدیمی');
  assert.equal(result.device.status, 'unknown');
  assert.ok(result.columns.includes('installed_at'), 'installed_at اضافه می‌شود');
  assert.equal(result.device.installed_at, null, 'تجهیز قدیمی تاریخ نصب ناشناخته دارد');
  assert.equal(result.membership.length, 1, 'عضویت گروهی از group_id پر می‌شود');
  assert.equal(result.membership[0].group_id, groupId);
  for (const table of ['device_group_members', 'device_templates', 'device_attachments', 'discovery_ranges', 'discovery_results']) {
    assert.ok(result.tables.includes(table), `جدول ${table} باید ساخته شود`);
  }
  assert.ok(result.migration, 'گام ۱۰ در schema_migrations ثبت می‌شود');
  assert.equal(Number(result.version), Number(result.schemaVersion));
  assert.equal(Number(result.version), 10);

  const backups = fs.readdirSync(dir).filter((f) => f.includes('.pre-migration-v9-'));
  assert.equal(backups.length, 1, `پشتیبان پیش از Migration: ${backups.join(',')}`);
});
