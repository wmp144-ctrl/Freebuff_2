/**
 * آزمون‌های رگرسیون برای یافته‌های ممیزی: نوشتن روی تجهیز حذف‌شده،
 * هشدارهای سکوت تکراری، سقف هم‌زمانی و تخلیهٔ بررسی‌های در جریان.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, probeResult, addDevice, deviceRow, waitFor } from '../helpers.mjs';

const dir = useTempDataDir('resilience');
const { db, setSettings, STATUS } = await import('../../db.js');
const { MonitoringEngine } = await import('../../engine.js');

let seq = 1;
function newDevice(overrides = {}) {
  seq += 1;
  return addDevice(db, { name: `res-${seq}`, ip: `10.30.0.${seq}`, ping_interval: 3600, ...overrides });
}

before(() => {
  setSettings({ engine_mode: 'simulate', alerting_enabled: true, alert_cooldown: 600, max_workers: 8 });
});

after(() => {
  db.close();
  cleanupDir(dir);
});

test('a device deleted mid-cycle is skipped without a database error', async () => {
  const id = newDevice({ status: STATUS.ONLINE });
  const stale = deviceRow(db, id);
  db.prepare('DELETE FROM devices WHERE id = ?').run(id);

  const eng = new MonitoringEngine({ emitToBus: false });
  eng.probe = async () => probeResult(false);
  const result = await eng.checkDevice(stale, { manual: true });

  assert.equal(result, null, 'no payload should be produced for a removed device');
  assert.equal(eng.stats.errors, 0, 'removing a device must not be counted as an engine error');
});

test('quiet-hours suppression records at most one suppressed alert per cooldown', async () => {
  setSettings({ suppression_enabled: true, suppression_start: '00:00', suppression_end: '23:59' });
  db.prepare('UPDATE alert_rules SET enabled = 0').run();
  db.prepare(
    "INSERT INTO alert_rules(name, enabled, metric, threshold, severity, cooldown_sec, silent, created_at) VALUES ('سکوت آزمون',1,'offline',1,'critical',600,1,?)"
  ).run(Date.now());

  const id = newDevice({ status: STATUS.ONLINE });
  const eng = new MonitoringEngine({ emitToBus: false });
  eng.invalidate();
  const row = deviceRow(db, id);
  for (let i = 0; i < 5; i++) {
    eng.raiseAlert('offline', row, { severity: 'critical', title: 't', message: 'm', value: 1, ts: Date.now() + i });
  }

  const suppressed = db.prepare("SELECT COUNT(*) c FROM alerts WHERE device_id = ? AND status = 'suppressed'").get(id).c;
  assert.equal(suppressed, 1, `expected one suppressed alert, got ${suppressed}`);
  db.prepare('UPDATE alert_rules SET enabled = 0').run();
  setSettings({ suppression_enabled: false });
});

test('overlapping ticks never exceed max_workers', async () => {
  setSettings({ max_workers: 2, engine_mode: 'simulate' });
  for (let i = 0; i < 6; i++) newDevice();

  const eng = new MonitoringEngine({ emitToBus: false });
  const releases = [];
  eng.probe = () => new Promise((resolve) => releases.push(() => resolve(probeResult(true))));
  eng.running = true;
  eng.settingsCache = { at: 0, value: undefined };

  const ticks = [eng.tick(), eng.tick(), eng.tick()];
  await waitFor(() => eng.inflight.size > 0, { timeout: 1000 });
  const peak = eng.inflight.size;
  assert.ok(peak <= 2, `engine started ${peak} concurrent checks with max_workers=2`);

  for (const release of releases) release();
  await Promise.all(ticks);
  for (const release of releases) release();
  await waitFor(() => eng.inflight.size === 0, { timeout: 2000 });
  eng.running = false;
});

test('overdue devices surface as a backlog metric with a warning log', async () => {
  setSettings({ max_workers: 8, ping_interval: 5, engine_mode: 'simulate' });
  for (let i = 0; i < 6; i++) newDevice({ ping_interval: 5, next_check_at: 0 });

  const eng = new MonitoringEngine({ emitToBus: false });
  eng.probe = () => new Promise(() => {}); // بررسی‌ها هرگز تمام نمی‌شوند → صف معوق می‌ماند
  eng.running = true;
  eng.settingsCache = { at: 0, value: undefined };
  eng.lastBacklogCheck = 0;
  const warningsBefore = db.prepare("SELECT COUNT(*) c FROM engine_log WHERE level = 'warn'").get().c;

  // tick عمداً await نمی‌شود: بررسی‌ها هرگز تمام نمی‌شوند و باید فقط ببینیم
  // شاخص عقب‌ماندگی پیش از شروع بررسی‌ها (همگام) محاسبه و ثبت شده است.
  void eng.tick();
  assert.ok(eng.stats.backlog >= 6, `backlog=${eng.stats.backlog}`);
  assert.ok(
    db.prepare("SELECT COUNT(*) c FROM engine_log WHERE level = 'warn'").get().c > warningsBefore,
    'a backlog warning must be written to the engine log'
  );
  eng.running = false;
  for (const task of eng.inflight.values()) void task;
});

test('drain waits for in-flight checks so their samples are persisted', async () => {
  const id = newDevice({ status: STATUS.ONLINE });
  const eng = new MonitoringEngine({ emitToBus: false });
  let finishProbe = null;
  eng.probe = () => new Promise((resolve) => (finishProbe = () => resolve(probeResult(true))));

  const check = eng.checkDevice(deviceRow(db, id), { manual: true });
  await waitFor(() => eng.inflight.size === 1, { timeout: 1000 });
  eng.stop();
  const drained = eng.drain(2000);
  setTimeout(() => finishProbe(), 30);

  assert.equal(await drained, true, 'drain should report a clean finish');
  await check;
  assert.equal(db.prepare('SELECT COUNT(*) c FROM samples WHERE device_id = ?').get(id).c, 1);
});

test('drain gives up after its timeout instead of hanging shutdown', async () => {
  const id = newDevice({ status: STATUS.ONLINE });
  const eng = new MonitoringEngine({ emitToBus: false });
  eng.probe = () => new Promise(() => {});
  const check = eng.checkDevice(deviceRow(db, id), { manual: true });
  await waitFor(() => eng.inflight.size === 1, { timeout: 1000 });
  eng.stop();
  const started = Date.now();
  assert.equal(await eng.drain(80), false);
  assert.ok(Date.now() - started < 1000);
  // promise عمداً رهاشده می‌ماند؛ تایمری باقی نمی‌ماند که فرآیند را زنده نگه دارد
  void check;
});
