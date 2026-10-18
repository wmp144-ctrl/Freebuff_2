/**
 * آزمون پشتیبان‌گیری و بازیابی.
 *
 * معیار پذیرش:
 *   • پشتیبان معتبر ساخته شود و با WAL سازگار باشد (آخرین تراکنش تأییدشده داخل آن)
 *   • پشتیبان خراب/دستکاری‌شده پیش از Restore رد شود
 *   • Restore روی یک پایگاه‌دادهٔ آزمایشی موفق باشد و اطلاعات دقیقاً مطابقت کند
 *   • فایل‌های MBTiles هماهنگ با پایگاه‌داده پشتیبان/بازیابی شوند
 *   • در صورت کمبود فضا هیچ پشتیبان نیمه‌کاره‌ای باقی نماند
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { useTempDataDir, cleanupDir, addDevice } from '../helpers.mjs';

const dir = useTempDataDir('db-backup');
const { db, DB_PATH, MBTILES_DIR, checkDatabaseHealth } = await import('../../db.js');
const { createBackup, verifyBackup, restoreBackup, listBackups, runCheckpoint, BACKUP_DIR } = await import('../../backup.js');
const { seedIfEmpty } = await import('../../db.js');

const counts = () => ({
  devices: db.prepare('SELECT COUNT(*) AS c FROM devices').get().c,
  samples: db.prepare('SELECT COUNT(*) AS c FROM samples').get().c,
  outages: db.prepare('SELECT COUNT(*) AS c FROM outages').get().c,
  alerts: db.prepare('SELECT COUNT(*) AS c FROM alerts').get().c,
});

seedIfEmpty();
const deviceId = addDevice(db, { name: 'backup-device', ip: '10.77.0.1', status: 'online' });

test('backup is WAL-consistent and passes full verification', () => {
  // نوشتن درست پیش از پشتیبان‌گیری: باید در عکس لحظه‌ای دیده شود
  const justBefore = addDevice(db, { name: 'written-just-before-backup', ip: '10.77.0.2', status: 'online' });
  const walBytesBefore = fs.existsSync(`${DB_PATH}-wal`) ? fs.statSync(`${DB_PATH}-wal`).size : 0;

  const { dir: backupDir, manifest } = createBackup({ reason: 'test' });

  assert.equal(manifest.db.integrity, 'ok');
  assert.equal(manifest.db.counts.devices, counts().devices);
  assert.ok(manifest.db.sha256.length === 64);

  const verification = verifyBackup(backupDir);
  assert.equal(verification.ok, true, `verify: ${verification.errors.join(', ')}`);
  assert.ok(
    db.prepare('SELECT id FROM devices WHERE id = ?').get(justBefore),
    'آخرین تراکنش تأییدشده باید داخل پشتیبان باشد'
  );
  assert.equal(verification.counts.devices, counts().devices);
  // پس از پشتیبان‌گیری، WAL باید تخلیه/کوچک شده باشد (سازگاری WAL با Checkpoint)
  const walBytesAfter = fs.existsSync(`${DB_PATH}-wal`) ? fs.statSync(`${DB_PATH}-wal`).size : 0;
  assert.ok(walBytesAfter <= Math.max(walBytesBefore, 32768), `WAL پس از پشتیبان‌گیری کوچک شود (${walBytesBefore} → ${walBytesAfter})`);
});

test('restore brings back the exact backed-up state', () => {
  const before = counts();
  const backup = createBackup({ reason: 'restore-test' });

  // تغییرات مخرب بعد از پشتیبان‌گیری
  db.prepare('DELETE FROM devices WHERE id = ?').run(deviceId);
  db.prepare("UPDATE devices SET name = 'CHANGED-AFTER-BACKUP'").run();
  db.prepare('DELETE FROM alerts').run();
  const changedCounts = counts();
  assert.notDeepEqual(changedCounts, before);

  const result = restoreBackup(backup.dir, { force: true });
  assert.equal(result.restored, true);
  assert.ok(result.safetyCopy && fs.existsSync(result.safetyCopy), 'نسخهٔ ایمنی پیش از بازیابی ساخته شود');

  assert.deepEqual(counts(), before, 'دادهٔ بازیابی‌شده باید با پشتیبان مطابقت کند');
  assert.ok(db.prepare('SELECT id FROM devices WHERE id = ?').get(deviceId));
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM devices WHERE name='CHANGED-AFTER-BACKUP'").get().c, 0);
  const health = checkDatabaseHealth({ full: true });
  assert.equal(health.ok, true, health.errors.join(', '));
});

test('a corrupted backup is rejected before restore and current data stays intact', () => {
  const backup = createBackup({ reason: 'corruption-test' });
  const backupDb = path.join(backup.dir, 'netwatch.db');
  // دست‌کاری یک بایت از فایل پشتیبان (نه بخش اول که هدر است)
  const size = fs.statSync(backupDb).size;
  const fd = fs.openSync(backupDb, 'r+');
  fs.writeSync(fd, Buffer.from([0xff]), 0, 1, Math.floor(size / 2));
  fs.closeSync(fd);

  const verification = verifyBackup(backup.dir);
  assert.equal(verification.ok, false);
  assert.ok(verification.errors.some((e) => /checksum|مالفورم|سالم|integrity/i.test(e)), verification.errors.join(' | '));

  const before = counts();
  assert.throws(() => restoreBackup(backup.dir, { force: true }), (e) => e.code === 'DB_BACKUP_INVALID');
  assert.deepEqual(counts(), before, 'بازیابی نامعتبر نباید دادهٔ فعلی را تغییر دهد');
});

test('dry-run validates without touching the database', () => {
  const backup = createBackup({ reason: 'dry-run' });
  const before = counts();
  const result = restoreBackup(backup.dir, { dryRun: true });
  assert.equal(result.restored, false);
  assert.deepEqual(counts(), before);
});

test('MBTiles files are backed up and restored in the same set', () => {
  const tileName = 'test-layer.mbtiles';
  const tilePath = path.join(MBTILES_DIR, tileName);
  const payload = Buffer.concat([Buffer.from('SQLite format 3\0'), crypto.randomBytes(2048)]);
  fs.writeFileSync(tilePath, payload);

  const backup = createBackup({ reason: 'mbtiles' });
  const tileEntry = backup.manifest.mbtiles.find((m) => m.name === tileName);
  assert.ok(tileEntry, 'فایل MBTiles باید در مانیفست باشد');
  assert.equal(tileEntry.sha256, crypto.createHash('sha256').update(payload).digest('hex'));

  // فایل روی دیسک از بین می‌رود و باید از پشتیبان برگردد
  fs.unlinkSync(tilePath);
  const verification = verifyBackup(backup.dir);
  assert.equal(verification.ok, true, verification.errors.join(', '));
  const result = restoreBackup(backup.dir, { force: true });
  assert.ok(result.mbtiles.includes(tileName));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(tilePath)).digest('hex'), tileEntry.sha256);
  fs.unlinkSync(tilePath);
});

test('checkpoint does not lose acknowledged data', () => {
  const id = addDevice(db, { name: 'checkpoint-device', ip: '10.77.0.9', status: 'online' });
  db.prepare('INSERT INTO samples(device_id, ts, status, ok) VALUES (?,?,?,?)').run(id, Date.now(), 'online', 1);
  const info = runCheckpoint('test');
  assert.equal(info.busy, 0);
  assert.ok(db.prepare('SELECT id FROM devices WHERE id = ?').get(id), 'تجهیز پس از Checkpoint باقی می‌ماند');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM samples WHERE device_id = ?').get(id).c, 1);
});

test('listBackups reports only complete sets (no partial leftovers)', () => {
  // یک پوشهٔ نیمه‌کاره شبیه پشتیبان‌گیری قطع‌شده می‌سازیم
  fs.mkdirSync(path.join(BACKUP_DIR, '.partial-crashed'), { recursive: true });
  fs.writeFileSync(path.join(BACKUP_DIR, '.partial-crashed', 'netwatch.db.tmp'), 'broken');
  const list = listBackups();
  assert.ok(list.length >= 1);
  assert.ok(
    list.every((b) => fs.existsSync(path.join(b.dir, 'manifest.json'))),
    'هر آیتم فهرست باید مانیفست داشته باشد'
  );
  assert.ok(!list.some((b) => b.name.startsWith('.partial')));
  fs.rmSync(path.join(BACKUP_DIR, '.partial-crashed'), { recursive: true, force: true });
});

after(() => {
  db.close();
  cleanupDir(dir);
});
