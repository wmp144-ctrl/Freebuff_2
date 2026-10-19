/**
 * Backup/Restore در شرایط واقعی:
 *   ۱) پشتیبان‌گیری → تغییر داده → بازیابی کامل از طریق API
 *   ۲) خراب‌کردن فایل پشتیبان → رد پیش از بازیابی و سالم‌ماندن دادهٔ فعلی
 *
 * آزمون واحد قبلی مسیر توابع را پوشش می‌دهد؛ اینجا همان مسیر از HTTP و با
 * چرخهٔ عمر واقعی سرور بررسی می‌شود.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDataDir, cleanupDir, startServer, api } from '../helpers.mjs';

const dir = useTempDataDir('backup-conditions');
let srv;
let deviceId;
let backupName;

before(async () => {
  srv = await startServer({ dataDir: dir, engine: false });
});

after(async () => {
  await srv.stop();
  cleanupDir(dir);
});

test('a backup taken before a change restores the exact previous state', async () => {
  const created = await api(srv.base, 'POST', '/api/devices', {
    name: 'restore-me',
    ip: '10.250.0.1',
    location: 'before-backup',
  });
  assert.equal(created.status, 201);
  deviceId = created.data.id;

  const backup = await api(srv.base, 'POST', '/api/system/backups', { includeMbtiles: false, keep: 5 });
  assert.equal(backup.status, 201, JSON.stringify(backup.data));
  backupName = backup.data.name;
  assert.equal(backup.data.manifest.db.counts.devices >= 1, true);

  assert.equal((await api(srv.base, 'DELETE', `/api/devices/${deviceId}`)).status, 200);
  assert.equal((await api(srv.base, 'GET', `/api/devices/${deviceId}`)).status, 404);

  const restored = await api(srv.base, 'POST', '/api/system/backups/restore', {
    name: backupName,
    restoreMbtiles: false,
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.equal(restored.data.restored, true);

  const row = await api(srv.base, 'GET', `/api/devices/${deviceId}`);
  assert.equal(row.status, 200, 'device deleted after the backup must come back');
  assert.equal(row.data.location, 'before-backup');
  assert.equal(srv.child.exitCode, null);
});

test('a tampered backup is rejected before restore and current data stays intact', async () => {
  const backups = await api(srv.base, 'GET', '/api/system/backups');
  assert.equal(backups.status, 200);
  const item = backups.data.items.find((b) => b.name === backupName);
  assert.ok(item, 'backup must be listed');
  const dbFile = path.join(item.dir, 'netwatch.db');
  assert.ok(fs.existsSync(dbFile));

  // یک بایت به انتهای فایل اضافه می‌کنیم: checksum دیگر با manifest نمی‌خواند.
  fs.appendFileSync(dbFile, Buffer.from([0x00]));

  const verify = await api(srv.base, 'POST', '/api/system/backups/verify', { name: backupName });
  assert.equal(verify.status, 400);
  assert.equal(verify.data.ok, false);
  assert.ok(verify.data.errors.length >= 1);

  const restore = await api(srv.base, 'POST', '/api/system/backups/restore', {
    name: backupName,
    restoreMbtiles: false,
  });
  assert.equal(restore.status, 400, JSON.stringify(restore.data));

  const row = await api(srv.base, 'GET', `/api/devices/${deviceId}`);
  assert.equal(row.status, 200, 'a rejected restore must not touch current data');
  assert.equal(row.data.location, 'before-backup');
  assert.equal((await api(srv.base, 'GET', '/api/health', undefined, { auth: false })).status, 200);
});
