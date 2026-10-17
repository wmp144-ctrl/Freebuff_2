/**
 * پنجرهٔ تعمیرات: قطعی باز و هشدار فعال نباید در طول تعمیرات باز بمانند و پس از
 * پایان پنجره نباید قطعی باز دوم برای همان تجهیز ساخته شود.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, probeResult, addDevice, deviceRow } from '../helpers.mjs';

const dir = useTempDataDir('maintenance');
const { db, setSettings, STATUS } = await import('../../db.js');
const { MonitoringEngine } = await import('../../engine.js');

let seq = 1;
function newDevice(overrides = {}) {
  seq += 1;
  return addDevice(db, { name: `mnt-${seq}`, ip: `10.60.0.${seq}`, status: STATUS.ONLINE, ping_interval: 3600, ...overrides });
}

function engineWith(ok) {
  const eng = new MonitoringEngine({ emitToBus: false });
  eng.probe = async () => probeResult(ok);
  return eng;
}

before(() => {
  setSettings({ engine_mode: 'simulate', failures_for_offline: 2, successes_for_online: 1, alerting_enabled: true, alert_cooldown: 0 });
});

after(() => {
  db.close();
  cleanupDir(dir);
});

test('entering a maintenance window closes the open outage and resolves active alerts', async () => {
  const id = newDevice();
  const eng = engineWith(false);
  await eng.checkDevice(deviceRow(db, id), { manual: true });
  await eng.checkDevice(deviceRow(db, id), { manual: true });
  assert.equal(deviceRow(db, id).status, STATUS.OFFLINE);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM outages WHERE device_id=? AND open=1').get(id).c, 1);

  db.prepare(
    "INSERT INTO maintenance_windows(device_id, title, days, start_time, end_time, enabled, created_at) VALUES (NULL,'پنجره آزمون','0,1,2,3,4,5,6','00:00','23:59',1,?)"
  ).run(Date.now());
  eng.invalidate();

  // بررسی خودکار (بدون manual) در پنجرهٔ فعال
  await eng.checkDevice(deviceRow(db, id));

  const row = deviceRow(db, id);
  assert.equal(row.status, STATUS.MAINTENANCE);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM outages WHERE device_id=? AND open=1').get(id).c, 0, 'open outage must be closed during maintenance');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM alerts WHERE device_id=? AND status='active'").get(id).c, 0, 'active alerts must be resolved');
  assert.equal(row.current_outage_id, null);

  db.prepare('UPDATE maintenance_windows SET enabled=0').run();
  eng.invalidate();
});

test('after the window ends while the device is still down, exactly one open outage exists', async () => {
  const id = newDevice();
  const eng = engineWith(false);
  // ابتدا تجهیز واقعاً قطع می‌شود تا یک قطعی باز داشته باشیم
  await eng.checkDevice(deviceRow(db, id), { manual: true });
  await eng.checkDevice(deviceRow(db, id), { manual: true });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM outages WHERE device_id=? AND open=1').get(id).c, 1);

  db.prepare(
    "INSERT INTO maintenance_windows(device_id, title, days, start_time, end_time, enabled, created_at) VALUES (NULL,'پنجره آزمون ۲','0,1,2,3,4,5,6','00:00','23:59',1,?)"
  ).run(Date.now());
  eng.invalidate();
  await eng.checkDevice(deviceRow(db, id));
  assert.equal(deviceRow(db, id).status, STATUS.MAINTENANCE);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM outages WHERE device_id=? AND open=1').get(id).c, 0);

  db.prepare('UPDATE maintenance_windows SET enabled=0').run();
  eng.invalidate();
  for (let i = 0; i < 3; i++) await eng.checkDevice(deviceRow(db, id), { manual: true });

  assert.equal(deviceRow(db, id).status, STATUS.OFFLINE);
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM outages WHERE device_id=? AND open=1').get(id).c,
    1,
    'a device must never have two open outages'
  );
});
