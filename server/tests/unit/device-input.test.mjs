/**
 * اعتبارسنجی ورودی تجهیز: مقادیر پایشی باید مرزگذاری شوند تا یک درخواست
 * نادرست نتواند موتور را به حلقهٔ بی‌وقفه یا اجرای فرمان سنگین بکشاند.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, deviceRow } from '../helpers.mjs';

const dir = useTempDataDir('input');
const { db } = await import('../../db.js');
const { createDevice, updateDevice, getDevice } = await import('../../store.js');

let seq = 1;
const ip = () => `10.40.0.${(seq += 1)}`;

before(() => {
  db.prepare('DELETE FROM devices').run();
});

after(() => {
  db.close();
  cleanupDir(dir);
});

test('rejects out-of-range per-device monitoring parameters', () => {
  const bad = [
    { ping_interval: 0 },
    { ping_interval: -1 },
    { ping_interval: 2 },
    { ping_interval: 'abc' },
    { timeout_ms: 50 },
    { timeout_ms: 10 ** 9 },
    { timeout_ms: 'x' },
    { packet_count: 0 },
    { packet_count: 1000 },
    { retries: 99 },
    { latency_threshold: -5 },
    { loss_threshold: 150 },
  ];
  for (const patch of bad) {
    assert.throws(
      () => createDevice({ name: 'bad', ip: ip(), ...patch }),
      (e) => /نامعتبر/.test(e.message) && !/UNIQUE/.test(e.message),
      `expected rejection for ${JSON.stringify(patch)}`
    );
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM devices').get().c, 0, 'no invalid device may be stored');
});

test('accepts null monitoring parameters (fallback to global settings)', () => {
  const d = createDevice({ name: 'fallback', ip: ip(), ping_interval: null, timeout_ms: null, packet_count: null, retries: null });
  assert.equal(d.pingInterval, null);
  assert.equal(d.timeoutMs, null);
});

test('rejects malformed IPs, including shell metacharacters', () => {
  for (const value of ['127.0.0.1; rm -rf /', '$(reboot)', '999.1.1.1', '10.0.0', 'host name', '']) {
    assert.throws(() => createDevice({ name: 'bad-ip', ip: value }), /IP/, `expected rejection for ${JSON.stringify(value)}`);
  }
});

test('rejects invalid coordinates and unbounded strings are truncated', () => {
  assert.throws(() => createDevice({ name: 'geo', ip: ip(), latitude: 120, longitude: 51 }), /عرض جغرافیایی/);
  assert.throws(() => createDevice({ name: 'geo2', ip: ip(), latitude: 35, longitude: -400 }), /طول جغرافیایی/);

  const d = createDevice({ name: 'x'.repeat(5000), ip: ip(), notes: 'y'.repeat(10_000) });
  const row = deviceRow(db, d.id);
  assert.ok(row.name.length <= 120, `name length ${row.name.length}`);
  assert.ok(row.notes.length <= 2000, `notes length ${row.notes.length}`);
});

test('updateDevice applies the same validation as createDevice', () => {
  const d = createDevice({ name: 'upd', ip: ip(), ping_interval: 30 });
  assert.throws(() => updateDevice(d.id, { ping_interval: -1 }), /نامعتبر/);
  assert.throws(() => updateDevice(d.id, { timeout_ms: 999999 }), /نامعتبر/);
  assert.throws(() => updateDevice(d.id, { latitude: 300 }), /عرض جغرافیایی/);
  assert.equal(getDevice(d.id).pingInterval, 30, 'rejected update must not change stored values');
});

test('legacy out-of-range values are clamped defensively by the engine', async () => {
  const d = createDevice({ name: 'legacy', ip: ip() });
  // مقدار خراب را مستقیم در پایگاه‌داده می‌نویسیم (مثل نسخه‌های قدیمی نرم‌افزار)
  db.prepare('UPDATE devices SET ping_interval=0, timeout_ms=0, packet_count=0, retries=-3 WHERE id=?').run(d.id);
  const { MonitoringEngine } = await import('../../engine.js');
  const eng = new MonitoringEngine({ emitToBus: false });
  let seen = null;
  eng.probe = async (_device, opts) => {
    seen = opts;
    return { ok: true, rtt: 1, packetsSent: 1, packetsRecv: 1, lossPct: 0, mode: 'test' };
  };
  await eng.checkDevice(deviceRow(db, d.id), { manual: true });
  assert.ok(seen.timeoutMs >= 100 && seen.timeoutMs <= 30000, `timeout=${seen.timeoutMs}`);
  assert.ok(seen.count >= 1 && seen.count <= 10, `count=${seen.count}`);
  assert.ok(seen.retries >= 0 && seen.retries <= 5, `retries=${seen.retries}`);
});

test('disabling monitoring closes open outages and resolves active alerts', async () => {
  const d = createDevice({ name: 'disable-me', ip: ip() });
  const outage = db
    .prepare("INSERT INTO outages(device_id, started_at, cause, open) VALUES (?,?,'Ping Timeout',1)")
    .run(d.id, Date.now() - 60000);
  db.prepare("UPDATE devices SET status='offline', current_outage_id=?, current_outage_started_at=? WHERE id=?").run(
    Number(outage.lastInsertRowid),
    Date.now() - 60000,
    d.id
  );
  db.prepare(
    "INSERT INTO alerts(device_id, severity, kind, title, message, created_at, status, notified, duplicate_key) VALUES (?,'critical','offline','x','y',?,'active',1,?)"
  ).run(d.id, Date.now(), `offline:${d.id}`);

  updateDevice(d.id, { enabled: 0 });

  assert.equal(db.prepare('SELECT COUNT(*) c FROM outages WHERE device_id=? AND open=1').get(d.id).c, 0, 'open outage must be closed');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM alerts WHERE device_id=? AND status='active'").get(d.id).c, 0, 'active alerts must be resolved');
  assert.equal(deviceRow(db, d.id).current_outage_id, null);
});

test('disabling only the monitor (monitoring_enabled=0) also closes open state', () => {
  const d = createDevice({ name: 'mon-off', ip: ip() });
  const outage = db
    .prepare("INSERT INTO outages(device_id, started_at, cause, open) VALUES (?,?,'Ping Timeout',1)")
    .run(d.id, Date.now() - 30000);
  db.prepare("UPDATE devices SET status='offline', current_outage_id=? WHERE id=?").run(Number(outage.lastInsertRowid), d.id);
  updateDevice(d.id, { monitoring_enabled: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM outages WHERE device_id=? AND open=1').get(d.id).c, 0);
});
