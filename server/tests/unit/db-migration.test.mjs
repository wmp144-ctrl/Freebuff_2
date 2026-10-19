/**
 * آزمون Migration سازگار با نسخه‌های قبلی:
 *   • پایگاه‌دادهٔ قدیمی (engine_lock بدون epoch، user_version=1) پیش از تغییر
 *     یک پشتیبان فایلی قابل‌بازیابی می‌گیرد.
 *   • دادهٔ موجود حفظ می‌شود و ستون‌های تازه با پیش‌فرض امن اضافه می‌شوند.
 *   • user_version به نسخهٔ جدید می‌رسد.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { useTempDataDir, cleanupDir, ROOT } from '../helpers.mjs';

const dir = useTempDataDir('db-migration');
const dbFile = path.join(dir, 'legacy.db');

after(() => cleanupDir(dir));

test('an old schema is backed up before migration and upgraded in place', () => {
  const legacy = new DatabaseSync(dbFile);
  legacy.exec(`
    CREATE TABLE engine_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO engine_lock(id, owner, expires_at, updated_at)
      VALUES (1, 'legacy-owner', 123456789, 123456789);
    PRAGMA user_version = 1;
  `);
  legacy.close();

  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { db, SCHEMA_VERSION } = await import(process.env.NETWATCH_DB_MODULE);
       const columns = db.prepare('PRAGMA table_info(engine_lock)').all().map((c) => c.name);
       const row = db.prepare('SELECT * FROM engine_lock WHERE id = 1').get();
       const meta = db.prepare("SELECT value FROM engine_meta WHERE key = 'leader_epoch'").get();
       const version = db.prepare('PRAGMA user_version').get().user_version;
       const hasSamplesIndex = db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name='idx_samples_operation'").get();
       process.stdout.write('RESULT:' + JSON.stringify({ columns, row, meta, version, schemaVersion: SCHEMA_VERSION, hasSamplesIndex: !!hasSamplesIndex }) + '\\n');
       db.close();`,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        NETWATCH_DATA_DIR: dir,
        NETWATCH_DB: dbFile,
        NETWATCH_LOG_STREAM: 'stderr',
        NETWATCH_DB_MODULE: pathToFileURL(path.join(ROOT, 'server', 'db.js')).href,
      },
    }
  );
  assert.equal(child.status, 0, `child failed:\n${child.stdout}\n${child.stderr}`);
  const line = child.stdout.split('\n').find((l) => l.startsWith('RESULT:'));
  assert.ok(line, `missing result:\n${child.stdout}\n${child.stderr}`);
  const result = JSON.parse(line.slice('RESULT:'.length));

  assert.ok(result.columns.includes('epoch'), 'epoch column must be added');
  assert.equal(result.row.owner, 'legacy-owner', 'existing lock row is preserved');
  assert.equal(Number(result.row.epoch), 0, 'existing rows get a safe default epoch');
  assert.equal(Number(result.meta.value), 0, 'epoch counter is initialized');
  assert.equal(Number(result.version), Number(result.schemaVersion));
  assert.equal(result.hasSamplesIndex, true, 'duplicate-result guard index exists');

  // پشتیبان پیش از Migration باید موجود و خودش یک SQLite سالم با دادهٔ قدیمی باشد.
  const backups = fs.readdirSync(dir).filter((f) => f.includes('.pre-migration-v1-'));
  assert.equal(backups.length, 1, `expected one pre-migration backup, got ${backups.join(',')}`);
  const backupPath = path.join(dir, backups[0]);
  const backup = new DatabaseSync(backupPath);
  const oldRow = backup.prepare('SELECT owner FROM engine_lock WHERE id = 1').get();
  const oldVersion = backup.prepare('PRAGMA user_version').get().user_version;
  const oldColumns = backup.prepare('PRAGMA table_info(engine_lock)').all().map((c) => c.name);
  backup.close();
  assert.equal(oldRow.owner, 'legacy-owner');
  assert.equal(Number(oldVersion), 1);
  assert.equal(oldColumns.includes('epoch'), false, 'the backup predates the migration');
});
