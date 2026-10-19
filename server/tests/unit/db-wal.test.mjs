/**
 * رشد WAL و عملکرد Checkpoint.
 *
 * نوشتن پیوسته نباید فایل WAL را بی‌مرز کند؛ checkpoint باید سریع، بدون از دست
 * رفتن داده و با کوتاه‌کردن WAL انجام شود. این آزمون اندازه‌ها را از همان API
 * تولیدی (`db.walInfo`/`db.checkpoint`) می‌خواند، نه از فرضیات فایل.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { useTempDataDir, cleanupDir, addDevice } from '../helpers.mjs';

const dir = useTempDataDir('wal');
const { db, DB_PATH, checkDatabaseHealth } = await import('../../db.js');
const ids = [];

before(() => {
  for (let i = 0; i < 20; i++) ids.push(addDevice(db, { name: `wal-${i}`, ip: `10.230.0.${i + 1}` }));
});

after(() => {
  db.close();
  cleanupDir(dir);
});

function insertSamples(count, startTs = Date.now() - 86400000) {
  const stmt = db.prepare(
    'INSERT INTO samples(device_id, ts, rtt_ms, packets_sent, packets_recv, loss_pct, status, ok, mode) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  const started = Date.now();
  db.raw.exec('BEGIN');
  for (let i = 0; i < count; i++) {
    stmt.run(ids[i % ids.length], startTs + i, 10, 3, 3, 0, 'online', 1, 'wal-test');
  }
  db.raw.exec('COMMIT');
  return Date.now() - started;
}

test('sustained writes grow WAL, checkpoint truncates it, and no row is lost', () => {
  const samples = db.prepare('SELECT COUNT(*) c FROM samples').get().c;
  insertSamples(40000);
  const afterWrite = db.prepare('SELECT COUNT(*) c FROM samples').get().c;
  assert.equal(afterWrite, samples + 40000);

  const wal = db.walInfo();
  assert.equal(String(wal.journalMode).toLowerCase(), 'wal');
  assert.ok(wal.walBytes > 0, 'WAL must contain frames after a burst of writes');
  assert.ok(wal.walBytes < 64 * 1024 * 1024, `WAL grew to ${wal.walBytes} bytes`);

  const checkpointStarted = Date.now();
  const result = db.checkpoint('TRUNCATE');
  const checkpointMs = Date.now() - checkpointStarted;
  assert.equal(result.mode, 'TRUNCATE');
  assert.ok(checkpointMs < 5000, `checkpoint took ${checkpointMs} ms`);

  const afterCheckpoint = db.walInfo();
  assert.ok(afterCheckpoint.walBytes <= 64 * 1024, `WAL not truncated: ${afterCheckpoint.walBytes} bytes`);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM samples').get().c, afterWrite);

  const health = checkDatabaseHealth({ full: true });
  assert.equal(health.ok, true, JSON.stringify(health.errors));
});

test('auto-checkpoint keeps WAL bounded under a long write stream', () => {
  // پنج دستهٔ ۱۰٬۰۰۰ ردیفی؛ هر دسته از سقف auto-checkpoint عبور می‌کند.
  for (let batch = 0; batch < 5; batch++) {
    insertSamples(10000, Date.now() - 43200000 + batch * 10000);
    const wal = db.walInfo();
    assert.ok(
      wal.walBytes < 32 * 1024 * 1024,
      `batch ${batch + 1}: WAL exceeded 32MB (${wal.walBytes} bytes)`
    );
  }
  const total = db.prepare('SELECT COUNT(*) c FROM samples').get().c;
  assert.equal(total, 90000);
  const checked = db.checkpoint('TRUNCATE');
  assert.equal(checked.mode, 'TRUNCATE');
  assert.ok(fs.statSync(DB_PATH).size > 0);
  assert.ok(db.walInfo().walBytes <= 64 * 1024);
});
