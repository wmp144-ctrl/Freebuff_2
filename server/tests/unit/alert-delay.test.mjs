/**
 * آزمون تأخیر هشدار: `rule.duration_sec` (مدت پایداری شرط) و
 * `settings.alert_delay` (تأخیر عمومی). تا وقتی شرط پایدار نمانده هشداری ثبت
 * نمی‌شود و اگر تجهیز پیش از پایان تأخیر برگردد، هشدار لغو می‌شود.
 */
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, addDevice, waitFor } from '../helpers.mjs';

const dir = useTempDataDir('alert-delay');
const { db, setSettings, STATUS } = await import('../../db.js');
const { MonitoringEngine } = await import('../../engine.js');

const engine = new MonitoringEngine({ emitToBus: false });

function alertRows(deviceId) {
  return db.prepare('SELECT * FROM alerts WHERE device_id = ? ORDER BY id').all(deviceId);
}

function addRule(patch = {}) {
  const rule = {
    name: 'قانون آزمون',
    enabled: 1,
    metric: 'offline',
    comparator: 'gte',
    threshold: 1,
    duration_sec: 0,
    severity: 'critical',
    scope_group_id: null,
    cooldown_sec: 0,
    apply_to_unmon: 0,
    silent: 0,
    ...patch,
  };
  const cols = Object.keys(rule);
  const res = db
    .prepare(`INSERT INTO alert_rules(${cols.join(',')}, created_at) VALUES (${cols.map(() => '?').join(',')}, ?)`)
    .run(...cols.map((c) => rule[c]), Date.now());
  engine.invalidate();
  return Number(res.lastInsertRowid);
}

beforeEach(() => {
  db.prepare('DELETE FROM alerts').run();
  db.prepare('DELETE FROM alert_rules').run();
  setSettings({ alerting_enabled: true, suppression_enabled: false, alert_delay: 0, alert_cooldown: 0 });
  engine.clearPending();
  engine.invalidate();
});

after(() => {
  engine.stop();
  db.close();
  cleanupDir(dir);
});

test('rule.duration_sec holds the alert until the condition is sustained', async () => {
  addRule({ duration_sec: 1 });
  const id = addDevice(db, { name: 'delay-1', ip: '10.70.0.1', status: STATUS.OFFLINE });

  const ret = engine.raiseAlert('offline', { id, name: 'delay-1', group_id: null }, {
    severity: 'critical',
    title: 'قطع',
    message: 'قطع',
    value: 3,
    ts: Date.now(),
  });
  assert.equal(ret?.pending, true, 'alert must be deferred, not written');
  assert.equal(alertRows(id).length, 0, 'no row before the condition is sustained');
  assert.equal(engine.getStatus().pendingAlerts, 1);

  const stored = await waitFor(() => alertRows(id).length > 0, { timeout: 3000 });
  assert.ok(stored, 'alert must be written after duration_sec');
  assert.equal(alertRows(id)[0].status, 'active');
  assert.equal(engine.getStatus().pendingAlerts, 0);
});

test('a device that recovers before the delay produces no alert', async () => {
  addRule({ duration_sec: 1 });
  const id = addDevice(db, { name: 'delay-2', ip: '10.70.0.2', status: STATUS.OFFLINE });

  engine.raiseAlert('offline', { id, name: 'delay-2', group_id: null }, {
    severity: 'critical',
    title: 'قطع',
    message: 'قطع',
    value: 3,
    ts: Date.now(),
  });
  assert.equal(engine.getStatus().pendingAlerts, 1);

  // همان کاری که runCheck هنگام بازگشت به وضعیت عادی انجام می‌دهد
  db.prepare('UPDATE devices SET status = ? WHERE id = ?').run(STATUS.ONLINE, id);
  engine.resolveDeviceAlerts(id, Date.now());

  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(alertRows(id).length, 0, 'recovered device must not raise a stale alert');
  assert.equal(engine.getStatus().pendingAlerts, 0);
});

test('settings.alert_delay delays alerts even without a matching rule', async () => {
  setSettings({ alert_delay: 1 });
  engine.invalidate();
  const id = addDevice(db, { name: 'delay-3', ip: '10.70.0.3', status: STATUS.OFFLINE });

  engine.raiseAlert('offline', { id, name: 'delay-3', group_id: null }, {
    severity: 'critical',
    title: 'قطع',
    message: 'قطع',
    value: 3,
    ts: Date.now(),
  });
  assert.equal(alertRows(id).length, 0);
  const stored = await waitFor(() => alertRows(id).length > 0, { timeout: 3000 });
  assert.ok(stored, 'global alert_delay must eventually raise the alert');
});

test('the longer of duration_sec and alert_delay wins (delays are not added)', async () => {
  addRule({ duration_sec: 2 });
  setSettings({ alert_delay: 1 });
  engine.invalidate();
  const id = addDevice(db, { name: 'delay-4', ip: '10.70.0.4', status: STATUS.OFFLINE });

  const started = Date.now();
  engine.raiseAlert('offline', { id, name: 'delay-4', group_id: null }, {
    severity: 'critical',
    title: 'قطع',
    message: 'قطع',
    value: 3,
    ts: started,
  });
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(alertRows(id).length, 0, 'a 1s alert_delay must not fire when the rule asks for 2s');

  const stored = await waitFor(() => alertRows(id).length > 0, { timeout: 2500 });
  assert.ok(stored, 'alert must arrive after the longer delay');
  const written = alertRows(id)[0];
  assert.ok(written.created_at - started >= 1900, `alert came too early: ${written.created_at - started}ms`);
});

test('cooldown still suppresses duplicates and never schedules a pending alert', async () => {
  addRule({ duration_sec: 1, cooldown_sec: 600 });
  const id = addDevice(db, { name: 'delay-5', ip: '10.70.0.5', status: STATUS.OFFLINE });
  db.prepare(
    "INSERT INTO alerts(device_id, severity, kind, title, message, created_at, status, notified, duplicate_key) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(id, 'critical', 'offline', 'قبلی', 'قبلی', Date.now(), 'active', 1, `offline:${id}`);

  const ret = engine.raiseAlert('offline', { id, name: 'delay-5', group_id: null }, {
    severity: 'critical',
    title: 'قطع',
    message: 'قطع',
    value: 3,
    ts: Date.now(),
  });
  assert.equal(ret, null, 'cooldown must suppress immediately');
  assert.equal(engine.getStatus().pendingAlerts, 0, 'nothing may be scheduled inside the cooldown');

  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(alertRows(id).length, 1, 'only the pre-existing alert may exist');
});

test('stop() cancels pending alerts so nothing fires after shutdown', async () => {
  addRule({ duration_sec: 3 });
  const id = addDevice(db, { name: 'delay-6', ip: '10.70.0.6', status: STATUS.OFFLINE });
  engine.raiseAlert('offline', { id, name: 'delay-6', group_id: null }, {
    severity: 'critical',
    title: 'قطع',
    message: 'قطع',
    value: 3,
    ts: Date.now(),
  });
  assert.equal(engine.getStatus().pendingAlerts, 1);

  engine.stop();
  assert.equal(engine.getStatus().pendingAlerts, 0, 'shutdown must clear pending alerts');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(alertRows(id).length, 0);
});

test('a pending alert is dropped when the device no longer matches the condition', async () => {
  addRule({ duration_sec: 1 });
  const id = addDevice(db, { name: 'delay-7', ip: '10.70.0.7', status: STATUS.OFFLINE });
  engine.raiseAlert('offline', { id, name: 'delay-7', group_id: null }, {
    severity: 'critical',
    title: 'قطع',
    message: 'قطع',
    value: 3,
    ts: Date.now(),
  });
  // دستگاه بدون فراخوانی resolveDeviceAlerts عادی می‌شود (مثلاً بررسی دستی)
  db.prepare('UPDATE devices SET status = ? WHERE id = ?').run(STATUS.ONLINE, id);

  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(alertRows(id).length, 0, 'delivery must re-check the device state');
});
