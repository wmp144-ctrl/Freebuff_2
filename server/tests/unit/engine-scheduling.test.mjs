/**
 * آزمون زمان‌بندی، چرخهٔ حیات و بازیابی وضعیت موتور:
 *   • زمان برنامه‌ریزی‌شده و زمان واقعی شروع هر بررسی ثبت می‌شود
 *   • شاخص Scheduling Lag محاسبه و در وضعیت موتور منتشر می‌شود
 *   • در یک چرخه، برای هر تجهیز فقط یک نمونه ثبت می‌شود
 *   • بار زیاد صف نامحدود نمی‌سازد و از سقف هم‌زمانی رد نمی‌شود
 *   • توقف/راه‌اندازی مجدد موتور وضعیت تجهیزات و قطعی‌های باز را خراب نمی‌کند
 *   • برای هر تجهیز حداکثر یک قطعی باز وجود دارد (قید پایگاه‌داده)
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, probeResult, addDevice, deviceRow, waitFor } from '../helpers.mjs';

const dir = useTempDataDir('engine-sched');
const { db, setSettings, STATUS } = await import('../../db.js');
const { MonitoringEngine } = await import('../../engine.js');

let seq = 1;
const future = () => Date.now() + 3600000;
function newDevice(overrides = {}) {
  seq += 1;
  return addDevice(db, { name: `sched-${seq}`, ip: `10.61.0.${seq}`, ping_interval: 3600, next_check_at: future(), ...overrides });
}

before(() => {
  setSettings({
    engine_mode: 'simulate',
    failures_for_offline: 3,
    successes_for_online: 2,
    alerting_enabled: true,
    alert_cooldown: 0,
    max_workers: 8,
  });
});

after(() => {
  db.close();
  cleanupDir(dir);
});

test('scheduled and actual start times are recorded and exposed as a scheduling lag', async () => {
  setSettings({ ping_interval: 5 });
  const scheduled = Date.now() - 5000;
  const id = newDevice({ status: STATUS.ONLINE, ping_interval: 5, next_check_at: scheduled });
  const eng = new MonitoringEngine({ emitToBus: false });
  eng.probe = async () => probeResult(true);

  await eng.checkDevice(deviceRow(db, id));

  const sample = db.prepare('SELECT * FROM samples WHERE device_id = ? ORDER BY id DESC LIMIT 1').get(id);
  assert.equal(sample.scheduled_at, scheduled, 'the scheduled time must be persisted');
  assert.ok(sample.started_at >= scheduled, 'the actual start must not precede the schedule');
  assert.equal(eng.stats.scheduling.samples, 1);
  assert.ok(eng.stats.scheduling.lastLagMs >= 4000, `lag=${eng.stats.scheduling.lastLagMs}`);
  assert.ok(eng.stats.scheduling.maxLagMs >= 4000);

  const status = eng.getStatus();
  assert.equal(status.scheduling.lastLagMs, eng.stats.scheduling.lastLagMs);
});

test('a manual check does not pollute the scheduling lag metric', async () => {
  const id = newDevice({ status: STATUS.ONLINE, ping_interval: 5, next_check_at: Date.now() - 9000 });
  const eng = new MonitoringEngine({ emitToBus: false });
  eng.probe = async () => probeResult(true);
  const before = eng.stats.scheduling.samples;
  await eng.checkDevice(deviceRow(db, id), { manual: true });
  assert.equal(eng.stats.scheduling.samples, before, 'manual checks are not part of the schedule');
  const sample = db.prepare('SELECT * FROM samples WHERE device_id = ? ORDER BY id DESC LIMIT 1').get(id);
  assert.ok(sample.started_at > 0, 'start time is recorded for manual checks too');
});

test('one engine cycle records exactly one sample per device', async () => {
  setSettings({ max_workers: 8, ping_interval: 5, engine_mode: 'simulate' });
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(newDevice({ status: STATUS.ONLINE, ping_interval: 5, next_check_at: 0 }));

  const eng = new MonitoringEngine({ emitToBus: false });
  eng.running = true;
  eng.probe = () => new Promise((resolve) => setTimeout(() => resolve(probeResult(true)), 20));

  for (let i = 0; i < 10; i++) await eng.tick();
  await waitFor(() => eng.inflight.size === 0, { timeout: 2000 });

  const counted = db
    .prepare(`SELECT device_id, COUNT(*) c FROM samples WHERE device_id IN (${ids.map(() => '?').join(',')}) GROUP BY device_id`)
    .all(...ids);
  assert.equal(counted.length, ids.length, 'every due device must be checked once');
  for (const row of counted) assert.equal(row.c, 1, `device ${row.device_id} got ${row.c} samples in one cycle`);

  // چرخهٔ بعدی پیش از رسیدن سررسید (۵ ثانیه) نباید نمونهٔ تازه بسازد
  await eng.tick();
  await waitFor(() => eng.inflight.size === 0, { timeout: 2000 });
  const after = db.prepare(`SELECT COUNT(*) c FROM samples WHERE device_id IN (${ids.map(() => '?').join(',')})`).get(...ids).c;
  assert.equal(after, ids.length, 'no duplicate sample before the next due time');
  eng.stop();
});

test('high load is drained in bounded batches without an unbounded queue', async () => {
  setSettings({ max_workers: 4, ping_interval: 30, engine_mode: 'simulate' });
  const ids = [];
  for (let i = 0; i < 60; i++) ids.push(newDevice({ status: STATUS.ONLINE, ping_interval: 30, next_check_at: 0 }));

  const eng = new MonitoringEngine({ emitToBus: false });
  eng.running = true;
  eng.settingsCache = { at: 0, value: undefined };
  let peak = 0;
  eng.probe = async () => {
    peak = Math.max(peak, eng.inflight.size);
    await new Promise((r) => setTimeout(r, 5));
    return probeResult(true);
  };

  const placeholders = ids.map(() => '?').join(',');
  let checked = 0;
  for (let i = 0; i < 200 && checked < ids.length; i++) {
    await eng.tick();
    checked = db.prepare(`SELECT COUNT(*) c FROM samples WHERE device_id IN (${placeholders})`).get(...ids).c;
  }
  assert.equal(checked, ids.length, `all due devices must eventually be checked (checked=${checked})`);
  assert.ok(peak <= 4, `engine started ${peak} concurrent checks with max_workers=4`);
  assert.ok(eng.inflight.size <= 4);
  assert.equal(eng.stats.internalErrors, 0);
  const perDevice = db
    .prepare(`SELECT MAX(c) mx FROM (SELECT COUNT(*) c FROM samples WHERE device_id IN (${placeholders}) GROUP BY device_id)`)
    .get(...ids).mx;
  assert.equal(perDevice, 1, 'each device is checked once per interval');
  eng.stop();
});

test('stopping the engine never marks devices offline', async () => {
  setSettings({ ping_interval: 30 });
  const up = newDevice({ status: STATUS.ONLINE });
  const down = newDevice({ status: STATUS.OFFLINE });
  const eng = new MonitoringEngine({ emitToBus: false });
  await eng.start();
  try {
    await waitFor(() => eng.stats.cycles > 2, { timeout: 3000 });
    eng.stop();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(deviceRow(db, up).status, STATUS.ONLINE, 'a stopped engine must not touch device status');
    assert.equal(deviceRow(db, down).status, STATUS.OFFLINE);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM samples WHERE device_id IN (?, ?)').get(up, down).c, 0, 'nothing was checked yet');
  } finally {
    eng.stop();
  }
});

test('a second engine stays in standby and marks nothing offline', async () => {
  const id = newDevice({ status: STATUS.ONLINE });
  const leader = new MonitoringEngine({ emitToBus: false });
  const standby = new MonitoringEngine({ emitToBus: false, lockRetryMs: 100 });
  await leader.start();
  await standby.start();
  try {
    assert.equal(leader.leader, true);
    assert.equal(standby.leader, false);
    await waitFor(() => leader.stats.cycles > 2, { timeout: 3000 });
    assert.equal(standby.stats.checksRun, 0, 'the standby engine must not run checks');
    assert.equal(deviceRow(db, id).status, STATUS.ONLINE);
  } finally {
    leader.stop();
    standby.stop();
  }
});

test('one open outage per device is enforced by the database itself', () => {
  const id = newDevice({ status: STATUS.OFFLINE });
  const now = Date.now();
  db.prepare("INSERT INTO outages(device_id, started_at, ended_at, duration_sec, cause, detail, open) VALUES (?,?,NULL,NULL,'Ping Timeout','',1)").run(id, now - 60000);
  assert.throws(
    () => db.prepare("INSERT INTO outages(device_id, started_at, ended_at, duration_sec, cause, detail, open) VALUES (?,?,NULL,NULL,'Ping Timeout','',1)").run(id, now),
    /UNIQUE|constraint/i,
    'a second open outage must be rejected'
  );
  assert.equal(db.prepare('SELECT COUNT(*) c FROM outages WHERE device_id = ? AND open = 1').get(id).c, 1);
});

test('a failing check adopts the existing open outage instead of opening a duplicate', async () => {
  const id = newDevice({ status: STATUS.OFFLINE });
  const started = Date.now() - 300000;
  // قطع ناگهانی موتور: قطعی باز در پایگاه‌داده هست اما ارجاع تجهیز گم شده است
  const outage = Number(
    db.prepare("INSERT INTO outages(device_id, started_at, ended_at, duration_sec, cause, detail, open) VALUES (?,?,NULL,NULL,'Ping Timeout','',1)").run(id, started).lastInsertRowid
  );
  const eng = new MonitoringEngine({ emitToBus: false });
  eng.probe = async () => probeResult(false);

  for (let i = 0; i < 3; i++) await eng.checkDevice(deviceRow(db, id), { manual: true });

  assert.equal(db.prepare('SELECT COUNT(*) c FROM outages WHERE device_id = ? AND open = 1').get(id).c, 1, 'still exactly one open outage');
  const row = deviceRow(db, id);
  assert.equal(Number(row.current_outage_id), outage, 'the existing outage is adopted');
  assert.equal(Number(row.current_outage_started_at), started, 'the original start time is preserved');
  assert.equal(row.status, STATUS.OFFLINE);
});

test('restart and recovery keep open outages and never silently bring a device online', async () => {
  const id = newDevice({ status: STATUS.OFFLINE });
  const started = Date.now() - 600000;
  const outage = Number(
    db.prepare("INSERT INTO outages(device_id, started_at, ended_at, duration_sec, cause, detail, open) VALUES (?,?,NULL,NULL,'Ping Timeout','',1)").run(id, started).lastInsertRowid
  );
  db.prepare('UPDATE devices SET current_outage_id = NULL, current_outage_started_at = NULL WHERE id = ?').run(id);

  const eng = new MonitoringEngine({ emitToBus: false });
  await eng.start();
  try {
    assert.equal(eng.leader, true);
    let row = deviceRow(db, id);
    assert.equal(row.status, STATUS.OFFLINE, 'restart must not fabricate a recovery');
    assert.equal(Number(row.current_outage_id), outage, 'the open outage is re-linked on startup');
    assert.equal(Number(row.current_outage_started_at), started);

    const status = await eng.restart({ drainMs: 500 });
    assert.equal(status.leader, true, 'the engine is leader again after restart');
    row = deviceRow(db, id);
    assert.equal(row.status, STATUS.OFFLINE);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM outages WHERE device_id = ? AND open = 1').get(id).c, 1, 'restart must not close or duplicate the outage');
    assert.equal(Number(row.current_outage_id), outage);
  } finally {
    eng.stop();
  }
});

test('recovery repairs a dangling outage reference and keeps the device state', () => {
  const id = newDevice({ status: STATUS.ONLINE });
  const ghost = Number(db.prepare("INSERT INTO outages(device_id, started_at, ended_at, duration_sec, cause, detail, open) VALUES (?,?,?,?, 'Ping Timeout','',0)").run(id, Date.now() - 1000, Date.now() - 500, 1).lastInsertRowid);
  // ارجاع به قطعیِ بسته‌شده (ناسازگاری پس از بازیابی داده)
  db.prepare('UPDATE devices SET current_outage_id = ?, current_outage_started_at = ? WHERE id = ?').run(ghost, Date.now() - 1000, id);
  const eng = new MonitoringEngine({ emitToBus: false });
  const report = eng.recoverState();
  assert.equal(report.dangling, 1);
  const row = deviceRow(db, id);
  assert.equal(row.current_outage_id, null, 'a reference to a closed outage is cleared');
  assert.equal(row.status, STATUS.ONLINE, 'recovery only repairs consistency, it does not change status');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM outages WHERE device_id = ? AND open = 1').get(id).c, 0);
});

test('runtime settings changes are applied and logged without restarting the engine', async () => {
  const eng = new MonitoringEngine({ emitToBus: false });
  // خروج از شبیه‌سازی و بازگشت به آن باید کنترل‌شده و قابل‌ردیابی باشد
  setSettings({ max_workers: 12, engine_mode: 'tcp' });
  let status = eng.invalidate();
  assert.equal(status.maxWorkers, 12);
  assert.equal(status.mode, 'tcp');
  assert.equal(status.simulation, false);

  setSettings({ engine_mode: 'simulate' });
  status = eng.invalidate();
  assert.equal(status.simulation, true);
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM engine_log WHERE message LIKE '%شبیه‌سازی فعال است%'").get().c > 0,
    true,
    'activating simulation must leave a visible trace in the engine log'
  );
  // تغییر تنظیمات نباید وضعیت تجهیزات را لمس کند
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM devices WHERE status NOT IN ('online','offline','warning','unknown','maintenance')").get().c,
    0
  );
  setSettings({ max_workers: 8, engine_mode: 'simulate' });
  eng.invalidate();
});
