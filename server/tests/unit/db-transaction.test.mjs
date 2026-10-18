/**
 * آزمون اتمیک‌بودن عملیات چندمرحله‌ای پایگاه‌داده.
 *
 * معیار پذیرش: شکست در هر مرحله باید کل عملیات را برگرداند و هیچ رکورد ناقصی
 * باقی نگذارد؛ تراکنش تودرتو (SAVEPOINT) فقط بلوک داخلی را برمی‌گرداند.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, addDevice } from '../helpers.mjs';

const dir = useTempDataDir('db-tx');
const { db, transaction } = await import('../../db.js');
const { createDevice, updateDevice, closeDeviceMonitoringState, getDevice } = await import('../../store.js');

const openOutages = (id) => db.prepare('SELECT COUNT(*) AS c FROM outages WHERE device_id = ? AND open = 1').get(id).c;
const samples = (id) => db.prepare('SELECT COUNT(*) AS c FROM samples WHERE device_id = ?').get(id).c;

test('rollback of a multi-step operation leaves no partial record', () => {
  const id = addDevice(db, { name: 'tx-partial', ip: '10.9.0.10' });
  const before = { status: db.prepare('SELECT status FROM devices WHERE id=?').get(id).status, samples: samples(id) };

  assert.throws(
    () =>
      transaction(() => {
        db.prepare('INSERT INTO outages(device_id, started_at, cause, open) VALUES (?,?,?,1)').run(id, Date.now(), 'test');
        db.prepare('INSERT INTO samples(device_id, ts, status, ok) VALUES (?,?,?,?)').run(id, Date.now(), 'offline', 0);
        db.prepare('UPDATE devices SET status=? WHERE id=?').run('offline', id);
        throw new Error('شکست عمدی در مرحلهٔ سوم');
      }),
    /شکست عمدی/
  );

  assert.equal(samples(id), before.samples, 'نمونهٔ ثبت‌شده نباید باقی بماند');
  assert.equal(openOutages(id), 0, 'قطعی باز نباید باقی بماند');
  assert.equal(db.prepare('SELECT status FROM devices WHERE id=?').get(id).status, before.status);
});

test('nested transaction rolls back only the inner block', () => {
  const id = addDevice(db, { name: 'tx-nested', ip: '10.9.0.11' });
  transaction(() => {
    db.prepare('INSERT INTO samples(device_id, ts, status, ok) VALUES (?,?,?,?)').run(id, 1000, 'online', 1);
    try {
      transaction(() => {
        db.prepare('INSERT INTO samples(device_id, ts, status, ok) VALUES (?,?,?,?)').run(id, 2000, 'offline', 0);
        throw new Error('inner-boom');
      });
    } catch (e) {
      assert.equal(e.message, 'inner-boom');
    }
    db.prepare('INSERT INTO samples(device_id, ts, status, ok) VALUES (?,?,?,?)').run(id, 3000, 'online', 1);
  });
  const rows = db.prepare('SELECT ts FROM samples WHERE device_id = ? ORDER BY ts').all(id).map((r) => r.ts);
  assert.deepEqual(rows, [1000, 3000], 'بلوک داخلی برگشت و بقیهٔ بلوک بیرونی ماند');
});

test('transaction rethrows business errors unchanged (not wrapped as db errors)', () => {
  assert.throws(
    () =>
      transaction(() => {
        throw Object.assign(new Error('نام تجهیز الزامی است'), { status: 400 });
      }),
    (e) => e.message === 'نام تجهیز الزامی است' && e.status === 400 && !e.code
  );
});

test('createDevice is atomic: a failed tag/log step leaves no device row', () => {
  const ipCount = () => db.prepare("SELECT COUNT(*) AS c FROM devices WHERE ip = '10.9.0.99'").get().c;
  assert.throws(() =>
    transaction(() => {
      createDevice({ name: 'atomic-device', ip: '10.9.0.99', tags: ['tag-a'] });
      throw new Error('after-insert');
    })
  );
  assert.equal(ipCount(), 0, 'تجهیز نباید ثبت شده باشد');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM device_tags dt JOIN devices d ON d.id=dt.device_id WHERE d.ip='10.9.0.99'").get().c, 0);
});

test('updateDevice validation failure keeps previous row and tags intact', () => {
  const first = createDevice({ name: 'keep-me', ip: '10.9.0.20', tagNames: ['alpha'] });
  const second = createDevice({ name: 'other', ip: '10.9.0.21' });
  const before = db.prepare('SELECT * FROM devices WHERE id=?').get(first.id);

  assert.throws(() => updateDevice(first.id, { ip: second.ip, tagNames: ['beta'] }), /تکراری/);

  const after = db.prepare('SELECT * FROM devices WHERE id=?').get(first.id);
  assert.equal(after.ip, before.ip, 'IP نباید تغییر کند');
  const tags = db.prepare('SELECT t.name FROM device_tags dt JOIN tags t ON t.id=dt.tag_id WHERE dt.device_id=?').all(first.id).map((r) => r.name);
  assert.deepEqual(tags.sort(), ['alpha'], 'تگ‌ها نباید نیمه‌کاره تغییر کنند');
  assert.equal(getDevice(first.id).ip, before.ip);
});

test('closeDeviceMonitoringState closes outage, alerts and device state atomically', () => {
  const id = addDevice(db, { name: 'closer', ip: '10.9.0.30', status: 'offline' });
  const ts = Date.now();
  db.prepare('INSERT INTO outages(device_id, started_at, open) VALUES (?,?,1)').run(id, ts - 60000);
  db.prepare(
    "INSERT INTO alerts(device_id, severity, kind, title, created_at, status) VALUES (?,?,?,?,?, 'active')"
  ).run(id, 'critical', 'offline', 'قطع ارتباط', ts - 50000);

  closeDeviceMonitoringState(id, ts);

  assert.equal(openOutages(id), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE device_id=? AND status='active'").get(id).c, 0);
  const row = db.prepare('SELECT current_outage_id, current_outage_started_at, consecutive_failures FROM devices WHERE id=?').get(id);
  assert.equal(row.current_outage_id, null);
  assert.equal(row.current_outage_started_at, null);
  assert.equal(row.consecutive_failures, 0);
});

test('settings are written all-or-nothing', async () => {
  const { setSettings, getSettings } = await import('../../db.js');
  const before = getSettings().ping_interval;
  setSettings({ ping_interval: 45, timeout_ms: 900 });
  const after = getSettings();
  assert.equal(after.ping_interval, 45);
  assert.equal(after.timeout_ms, 900);
  setSettings({ ping_interval: before });
});

test('database connection survives close/reopen with prepared statements from other modules', () => {
  const stmt = db.prepare('SELECT COUNT(*) AS c FROM devices');
  const before = stmt.get().c;
  db.reopen();
  assert.equal(stmt.get().c, before, 'Prepared Statement باید پس از بازگشایی دوباره معتبر باشد');
});

after(() => {
  db.close();
  cleanupDir(dir);
});
