/**
 * آزمون کنترل فضای دیسک.
 *
 * معیار پذیرش: در کمبود فضا هیچ عملیات ناقصی ثبت نمی‌شود — به‌جای نوشتن
 * نیمه‌کاره، پیش از شروع کار خطای روشن (DB_DISK_FULL) برگردانده می‌شود و
 * هیچ پوشهٔ پشتیبان نیمه‌کاره‌ای روی دیسک نمی‌ماند.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { useTempDataDir, cleanupDir, addDevice } from '../helpers.mjs';

const dir = useTempDataDir('db-disk');
// پیش از import شدن ماژول‌ها، حد فضای آزاد را غیرواقعی بالا می‌بریم
process.env.NETWATCH_MIN_FREE_BYTES = String(Number.MAX_SAFE_INTEGER);

const { db, DATA_DIR } = await import('../../db.js');
const { assertDiskSpace } = await import('../../db-safety.js');
const { createBackup, BACKUP_DIR, listBackups } = await import('../../backup.js');

addDevice(db, { name: 'disk-device', ip: '10.91.0.1' });

test('assertDiskSpace throws a standard DB_DISK_FULL error', () => {
  assert.throws(
    () => assertDiskSpace(DATA_DIR, 1024, 'آزمون'),
    (e) => e.code === 'DB_DISK_FULL' && e.name === 'DiskSpaceError' && /فضای دیسک/.test(e.message)
  );
});

test('backup is refused before writing anything when space is insufficient', () => {
  assert.throws(() => createBackup({ reason: 'no-space' }), (e) => e.code === 'DB_DISK_FULL');
  const leftovers = fs.existsSync(BACKUP_DIR)
    ? fs.readdirSync(BACKUP_DIR, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('.partial'))
    : [];
  assert.deepEqual(leftovers.map((e) => e.name), [], 'هیچ پوشهٔ نیمه‌کاره‌ای نباید باقی بماند');
  assert.deepEqual(listBackups(), [], 'پشتیبان ناقصی ثبت نشده است');
});

after(() => {
  db.close();
  cleanupDir(dir);
});
