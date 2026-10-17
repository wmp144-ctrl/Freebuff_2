/**
 * منطق تشخیص وضعیت و هشدار (بدون شبکه): گذارها، آستانه‌ها و ضد‌تکرار.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, probeResult, addDevice, deviceRow } from '../helpers.mjs';

const dir = useTempDataDir('detection');
const { db, setSettings, STATUS } = await import('../../db.js');
const { MonitoringEngine } = await import('../../engine.js');

let seq = 1;
function newDevice(overrides = {}) {
  seq += 1;
  return addDevice(db, { name: `unit-${seq}`, ip: `10.20.0.${seq}`, ...overrides });
}

function engineWith(...results) {
  const eng = new MonitoringEngine({ emitToBus: false });
  const queue = [...results];
  eng.probe = async () => {
    const next = queue.shift();
    if (typeof next === 'function') return next();
    return typeof next === 'boolean' ? probeResult(next) : next;
  };
  return eng;
}

before(() => {
  setSettings({
    engine_mode: 'simulate',
    failures_for_offline: 3,
    successes_for_online: 2,
    alerting_enabled: true,
    alert_cooldown: 600,
  });
});

after(() => {
  db.close();
  cleanupDir(dir);
});

test('below the failure threshold the device stays up and no outage is opened', async () => {
  const id = newDevice({ status: STATUS.ONLINE });
  const eng = engineWith(...Array(10).fill(false));
  for (let i = 0; i < 2; i++) await eng.checkDevice(deviceRow(db, id), { manual: true });

  const row = deviceRow(db, id);
  assert.equal(row.status, STATUS.ONLINE);
  assert.equal(row.consecutive_failures, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM outages WHERE device_id = ?').get(id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM alerts WHERE device_id = ?').get(id).c, 0);
});

test('three consecutive failures open exactly one outage and one alert', async () => {
  const id = newDevice({ status: STATUS.ONLINE });
  const eng = engineWith(...Array(10).fill(false));
  for (let i = 0; i < 3; i++) await eng.checkDevice(deviceRow(db, id), { manual: true });

  const row = deviceRow(db, id);
  assert.equal(row.status, STATUS.OFFLINE);
  assert.equal(row.consecutive_failures, 3);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM outages WHERE device_id = ? AND open = 1').get(id).c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM alerts WHERE device_id = ? AND kind = 'offline' AND status = 'active'").get(id).c, 1);
  assert.ok(row.current_outage_id, 'current outage id must be stored');
});

test('one success is not enough to recover; the configured count is honored', async () => {
  const id = newDevice({ status: STATUS.ONLINE });
  const eng = engineWith(false, false, false, true, true);
  for (let i = 0; i < 4; i++) await eng.checkDevice(deviceRow(db, id), { manual: true });

  let row = deviceRow(db, id);
  assert.equal(row.status, STATUS.OFFLINE, 'still offline after one successful probe');
  assert.equal(row.consecutive_successes, 1);

  await eng.checkDevice(deviceRow(db, id), { manual: true });
  row = deviceRow(db, id);
  assert.equal(row.status, STATUS.ONLINE);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM outages WHERE device_id = ? AND open = 1').get(id).c, 0);
  const closed = db.prepare('SELECT * FROM outages WHERE device_id = ? ORDER BY id DESC LIMIT 1').get(id);
  assert.equal(closed.open, 0);
  assert.ok(closed.ended_at && closed.duration_sec >= 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM alerts WHERE device_id = ? AND kind = 'offline' AND status = 'active'").get(id).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM alerts WHERE device_id = ? AND kind = 'recovery'").get(id).c, 1);
});

test('alert cooldown suppresses duplicate alerts for the same device and kind', async () => {
  const id = newDevice({ status: STATUS.ONLINE });
  const eng = engineWith(...Array(12).fill(false));
  for (let i = 0; i < 3; i++) await eng.checkDevice(deviceRow(db, id), { manual: true });
  // قطعی دوم پس از یک بازگشت، در فاصلهٔ cooldown
  eng.probe = async () => probeResult(true);
  await eng.checkDevice(deviceRow(db, id), { manual: true });
  await eng.checkDevice(deviceRow(db, id), { manual: true });
  eng.probe = async () => probeResult(false);
  for (let i = 0; i < 3; i++) await eng.checkDevice(deviceRow(db, id), { manual: true });

  assert.equal(db.prepare("SELECT COUNT(*) c FROM alerts WHERE device_id = ? AND kind = 'offline'").get(id).c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM outages WHERE device_id = ? AND open = 1').get(id).c, 1);
});

test('high latency produces a warning state and a single latency alert', async () => {
  const id = newDevice({ status: STATUS.ONLINE, latency_threshold: 100 });
  const eng = engineWith(...Array(4).fill(() => probeResult(true, { rtt: 400 })));
  for (let i = 0; i < 4; i++) await eng.checkDevice(deviceRow(db, id), { manual: true });

  const row = deviceRow(db, id);
  assert.equal(row.status, STATUS.WARNING);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM alerts WHERE device_id = ? AND kind = 'latency'").get(id).c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM alerts WHERE device_id = ? AND kind = 'offline'").get(id).c, 0);
});

test('a degraded-but-reachable device never opens an outage', async () => {
  const id = newDevice({ status: STATUS.ONLINE, latency_threshold: 50, loss_threshold: 5 });
  const eng = engineWith(() => probeResult(true, { rtt: 200, lossPct: 40 }));
  await eng.checkDevice(deviceRow(db, id), { manual: true });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM outages WHERE device_id = ?').get(id).c, 0);
});
