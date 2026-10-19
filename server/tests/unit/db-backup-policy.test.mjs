/**
 * آزمون سیاست Backup و بازیابی پس از Crash.
 *
 * معیارهای پذیرش Phase 2:
 *   • Manifest هر پشتیبان شامل زمان، نسخهٔ برنامه، نسخهٔ Schema، اندازه و SHA-256 است
 *   • سیاست نگهداری ۷ نسخهٔ روزانه + ۴ نسخهٔ هفتگی رعایت می‌شود
 *   • پشتیبان با Schema جدیدتر از برنامه رد می‌شود
 *   • اگر فرآیند در میانهٔ Restore از بین برود، در راه‌اندازی بعدی داده از
 *     نسخهٔ ایمنی بازگردانده می‌شود و وضعیت Restore قابل مشاهده است
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { useTempDataDir, cleanupDir, addDevice, ROOT } from '../helpers.mjs';

const dir = useTempDataDir('db-backup-policy');
const { db, DB_PATH, SCHEMA_VERSION } = await import('../../db.js');
const { createBackup, verifyBackup, restoreBackup, restoreStatus, pruneBackupsByPolicy, APP_VERSION } = await import(
  '../../backup.js'
);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
addDevice(db, { name: 'policy-device', ip: '10.77.9.1', status: 'online' });

test('manifest records time, app version, schema version, size and checksum', () => {
  const { manifest } = createBackup({ reason: 'policy-test' });
  assert.equal(manifest.appVersion, pkg.version);
  assert.equal(APP_VERSION, pkg.version);
  assert.equal(Number(manifest.schemaVersion), SCHEMA_VERSION);
  assert.ok(!Number.isNaN(Date.parse(manifest.createdAt)), 'createdAt باید زمان ISO معتبر باشد');
  assert.ok(Number(manifest.createdAtMs) > 0);
  assert.ok(manifest.db.size > 0, 'اندازهٔ فایل در مانیفست ثبت شود');
  assert.match(manifest.db.sha256, /^[a-f0-9]{64}$/, 'SHA-256 پشتیبان باید ثبت شود');
  assert.equal(manifest.db.integrity, 'ok');
});

test('GFS pruning keeps 7 daily and 4 weekly snapshots', () => {
  const pruneDir = path.join(dir, 'gfs');
  fs.mkdirSync(pruneDir, { recursive: true });
  const makeItem = (name, createdAtMs) => {
    const itemDir = path.join(pruneDir, name);
    fs.mkdirSync(itemDir, { recursive: true });
    fs.writeFileSync(
      path.join(itemDir, 'manifest.json'),
      JSON.stringify({ format: 1, app: 'netwatch', name, createdAt: new Date(createdAtMs).toISOString(), createdAtMs, db: { size: 1, integrity: 'ok' } })
    );
    return itemDir;
  };
  // ۲۰ نسخه: روزی یکی/دو تا در ۱۰ روز گذشته، و یک نسخه در ۵ هفتهٔ دورتر
  const base = Date.UTC(2026, 5, 1, 4, 0, 0);
  const names = [];
  for (let d = 0; d < 10; d++) {
    for (let k = 0; k < 2; k++) {
      const ts = base - d * 86400000 + k * 3600000;
      const name = `netwatch-2026060${d}-00000${k}-aaaaa${k}`;
      names.push(name);
      makeItem(name, ts);
    }
  }
  for (let w = 2; w <= 5; w++) {
    const name = `netwatch-week${w}-bbbbb0`;
    names.push(name);
    makeItem(name, base - w * 7 * 86400000);
  }

  // نسخه‌های ساخته‌شده در پوشهٔ اصلی نباید در این آزمون حذف شوند؛ فقط زیرپوشهٔ gfs
  const removed = pruneBackupsByPolicy({ dailyKeep: 7, weeklyKeep: 4, dir: pruneDir });
  const remaining = fs.readdirSync(pruneDir);
  // ۷ روز نخست + ۴ هفته + جدیدترین نسخه = بیش از ۷ و کمتر از ۲۰
  assert.ok(remaining.length <= 12, `بیش از حد انتظار باقی مانده: ${remaining.length}`);
  assert.ok(remaining.length >= 7, `حداقل نسخه‌های روزانه باید بمانند: ${remaining.length}`);
  assert.ok(removed.length > 0);
});

test('a backup from a newer schema is rejected before restore', () => {
  const backup = createBackup({ reason: 'schema-guard' });
  const manifestPath = path.join(backup.dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.schemaVersion = SCHEMA_VERSION + 5;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const report = verifyBackup(backup.dir);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /جدیدتر/.test(e)), report.errors.join(' | '));
});

test('restore reports its status for the UI', () => {
  const backup = createBackup({ reason: 'status-test' });
  const result = restoreBackup(backup.dir, { force: true });
  assert.equal(result.restored, true);
  const status = restoreStatus();
  assert.equal(status.status, 'completed');
  assert.equal(status.inProgress, false);
  assert.ok(status.finishedAt > 0);
  assert.equal(status.rolledBack, undefined);
});

test('a crash in the middle of restore recovers from the safety copy on next startup', () => {
  const crashDir = fs.mkdtempSync(path.join(process.env.NETWATCH_DATA_DIR || dir, 'crash-'));
  const liveDb = path.join(crashDir, 'netwatch.db');
  // پایگاه‌دادهٔ «قبل از بازیابی» + نسخهٔ ایمنی؛ نسخهٔ ایمنی یک SQLite کامل و
  // سالم است (همان چیزی که restoreBackup پیش از جای‌گذاری می‌سازد).
  db.checkpoint('TRUNCATE');
  const safety = `${liveDb}.pre-restore-1`;
  fs.copyFileSync(DB_PATH, safety);
  // شبیه‌سازی Crash دقیقاً پیش از rename فایل جدید: فایل اصلی غایب است
  fs.writeFileSync(liveDb, '');
  fs.rmSync(liveDb);
  fs.writeFileSync(
    path.join(crashDir, '.restore-state.json'),
    JSON.stringify({ status: 'in_progress', phase: 'installing', safetyFile: safety, source: 'x', startedAt: Date.now() })
  );

  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { db } = await import(process.env.NETWATCH_DB_MODULE);
       const device = db.prepare("SELECT name FROM devices ORDER BY id LIMIT 1").get();
       const state = JSON.parse((await import('node:fs')).readFileSync(process.env.NETWATCH_STATE_FILE, 'utf8'));
       process.stdout.write('RESULT:' + JSON.stringify({ device: device?.name || null, state: state.status }) + '\\n');
       db.close();`,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        NETWATCH_DATA_DIR: crashDir,
        NETWATCH_DB: liveDb,
        NETWATCH_LOG_STREAM: 'stderr',
        NETWATCH_DB_MODULE: new URL('../../db.js', import.meta.url).href,
        NETWATCH_STATE_FILE: path.join(crashDir, '.restore-state.json'),
      },
    }
  );
  assert.equal(child.status, 0, `child failed:\n${child.stdout}\n${child.stderr}`);
  const line = child.stdout.split('\n').find((l) => l.startsWith('RESULT:'));
  assert.ok(line, `missing result:\n${child.stdout}\n${child.stderr}`);
  const result = JSON.parse(line.slice('RESULT:'.length));
  assert.equal(result.device, 'policy-device', 'دادهٔ نسخهٔ ایمنی باید بازگردانده شود');
  assert.equal(result.state, 'recovered_interrupted');
  assert.ok(fs.existsSync(liveDb));
  cleanupDir(crashDir);
});

after(() => {
  db.close();
  cleanupDir(dir);
});
