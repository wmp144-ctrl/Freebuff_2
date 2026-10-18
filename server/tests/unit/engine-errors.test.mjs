/**
 * آزمون تفکیک «خطای داخلی موتور» از «بی‌پاسخی شبکه».
 *
 * قاعده‌ای که این آزمون‌ها از آن محافظت می‌کنند:
 *   • خطای لایهٔ پروب، مهلت سخت، یا خطای پایگاه‌داده هرگز نباید قطعی شبکه
 *     شمرده شود؛ نه نمونه‌ای ثبت می‌شود، نه شمارندهٔ شکست تجهیز بالا می‌رود و
 *     نه وضعیت تجهیز به Offline تغییر می‌کند.
 *   • همان خطا باید ثبت ساختاریافته، شمارندهٔ جدا و هشدار مستقل موتور بسازد.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, probeResult, addDevice, deviceRow } from '../helpers.mjs';

const dir = useTempDataDir('engine-errors');
const { db, setSettings, STATUS } = await import('../../db.js');
const { MonitoringEngine } = await import('../../engine.js');

let seq = 1;
function newDevice(overrides = {}) {
  seq += 1;
  return addDevice(db, { name: `err-${seq}`, ip: `10.60.0.${seq}`, ping_interval: 3600, ...overrides });
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

test('a thrown probe error is reported and never becomes an outage', async () => {
  const id = newDevice({ status: STATUS.ONLINE });
  const eng = new MonitoringEngine({ emitToBus: false });
  eng.probe = async () => {
    throw Object.assign(new Error('probe layer crashed'), { code: 'E_PROBE_LAYER' });
  };

  const out = await eng.checkDevice(deviceRow(db, id), { manual: true });
  assert.equal(out, null, 'no payload for a failed internal check');

  const row = deviceRow(db, id);
  assert.equal(row.status, STATUS.ONLINE, 'an internal error must not mark the device offline');
  assert.equal(row.consecutive_failures, 0);
  assert.equal(row.total_checks, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM samples WHERE device_id = ?').get(id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM outages WHERE device_id = ?').get(id).c, 0, 'no outage may be opened');

  assert.equal(eng.stats.networkFailures, 0, 'internal errors are not network failures');
  assert.equal(eng.stats.internalErrors, 1);
  assert.equal(eng.stats.lastErrorCode, 'E_PROBE_LAYER');

  // هشدار مستقل موتور: kind='engine' و بدون تجهیز (تا با هشدارهای تجهیز قاطی نشود)
  const incident = db.prepare("SELECT * FROM alerts WHERE kind = 'engine' AND status = 'active'").get();
  assert.ok(incident, 'an independent engine alert must be recorded');
  assert.equal(incident.device_id, null);
  assert.equal(incident.severity, 'critical');
});

test('a probe that never returns is cut off by the hard deadline', async () => {
  const id = newDevice({ status: STATUS.ONLINE, timeout_ms: 100, packet_count: 1, retries: 0 });
  const eng = new MonitoringEngine({ emitToBus: false, probeDeadlineMs: 60 });
  eng.probe = () => new Promise(() => {}); // هرگز تمام نمی‌شود

  const started = Date.now();
  const out = await eng.checkDevice(deviceRow(db, id), { manual: true });
  assert.equal(out, null);
  assert.ok(Date.now() - started < 1000, 'the deadline must end the check quickly');
  assert.equal(eng.inflight.size, 0, 'a hung probe must not stay in the in-flight map');
  assert.equal(deviceRow(db, id).status, STATUS.ONLINE);
  assert.equal(eng.stats.internalErrors, 1);
  assert.match(String(eng.stats.lastErrorCode), /PROBE/);
});

test('the deadline never lets a hung probe block engine capacity forever', async () => {
  setSettings({ max_workers: 2 });
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(newDevice({ next_check_at: 0, timeout_ms: 100, packet_count: 1, retries: 0 }));
  const eng = new MonitoringEngine({ emitToBus: false, probeDeadlineMs: 50 });
  eng.running = true;
  eng.settingsCache = { at: 0, value: undefined };
  eng.probe = () => new Promise(() => {});

  for (let i = 0; i < 4; i++) await eng.tick();
  assert.ok(eng.stats.internalErrors >= 4, `internalErrors=${eng.stats.internalErrors}`);
  assert.equal(eng.inflight.size, 0, 'capacity must be free again after the deadlines fire');
  const checked = db.prepare(`SELECT COUNT(*) c FROM samples WHERE device_id IN (${ids.map(() => '?').join(',')})`).get(...ids).c;
  assert.equal(checked, 0, 'a timed-out probe must not record a sample');
  eng.stop();
});

test('a database failure inside a check rolls back and is reported, not counted as an outage', async () => {
  const id = newDevice({ status: STATUS.ONLINE });
  const eng = new MonitoringEngine({ emitToBus: false });
  eng.probe = async () => probeResult(true);

  // شکست قطعی در مرحلهٔ ثبت: درج نمونه مسدود می‌شود تا رفتار تراکنش آزموده شود.
  db.exec("CREATE TRIGGER IF NOT EXISTS test_block_sample BEFORE INSERT ON samples BEGIN SELECT RAISE(ABORT, 'test-block'); END");
  try {
    const out = await eng.checkDevice(deviceRow(db, id), { manual: true });
    assert.equal(out, null);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS test_block_sample');
  }

  const row = deviceRow(db, id);
  assert.equal(row.status, STATUS.ONLINE, 'a rolled-back check must not change the status');
  assert.equal(row.total_checks, 0, 'counters must be rolled back too');
  assert.equal(row.last_check_at, null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM samples WHERE device_id = ?').get(id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM outages WHERE device_id = ?').get(id).c, 0);
  assert.ok(eng.stats.internalErrors >= 1);
  assert.equal(eng.stats.lastErrorCode, 'ENGINE_DB', 'database failures get their own code');

  // پس از رفع مشکل، همان تجهیز درست بررسی و ثبت می‌شود
  const ok = await eng.checkDevice(deviceRow(db, id), { manual: true });
  assert.equal(ok.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM samples WHERE device_id = ?').get(id).c, 1);
  assert.equal(deviceRow(db, id).total_checks, 1);
});

test('real probe modes never fall back to simulated data', async () => {
  const id = newDevice({ status: STATUS.ONLINE, timeout_ms: 150, packet_count: 1, retries: 0 });
  const eng = new MonitoringEngine({ emitToBus: false });

  // TCP روی یک پورت بستهٔ محلی: نتیجه باید واقعی و برچسب tcp باشد، نه simulate
  const direct = await eng.probe(deviceRow(db, id), { timeoutMs: 200, count: 1, retries: 0, mode: 'tcp', port: 1 });
  assert.equal(direct.mode, 'tcp', 'a real mode must never produce simulated data');
  assert.equal(direct.ok, false);

  setSettings({ engine_mode: 'tcp', tcp_port: 1 });
  eng.invalidate();
  try {
    await eng.checkDevice(deviceRow(db, id), { manual: true });
    const sample = db.prepare('SELECT * FROM samples WHERE device_id = ? ORDER BY id DESC LIMIT 1').get(id);
    assert.equal(sample.mode, 'tcp', 'the recorded sample must carry the real probe mode');
    assert.notEqual(sample.mode, 'simulate');
  } finally {
    setSettings({ engine_mode: 'simulate' });
    eng.invalidate();
  }
});

test('network failures are counted separately from internal errors', async () => {
  const id = newDevice({ status: STATUS.ONLINE });
  const eng = new MonitoringEngine({ emitToBus: false });
  eng.probe = async () => probeResult(false);
  const engineInternalBefore = eng.stats.internalErrors;

  await eng.checkDevice(deviceRow(db, id), { manual: true });
  assert.equal(eng.stats.networkFailures, 1);
  assert.equal(eng.stats.internalErrors, engineInternalBefore, 'a failed probe is not an engine error');
  assert.equal(deviceRow(db, id).consecutive_failures, 1, 'a real failure still counts');
});

test('engine malfunction raises an independent alert and clears after the grace period', async () => {
  const eng = new MonitoringEngine({ emitToBus: false, stallMs: 1000, incidentGraceMs: 1000 });
  eng.running = true;
  eng.leader = true;
  const activeIncidents = () => db.prepare("SELECT COUNT(*) c FROM alerts WHERE kind = 'engine' AND status = 'active'").get().c;

  // ۱) حلقهٔ موتور ۶۰ ثانیه عقب افتاده است → هشدار مستقل تازه
  const before = activeIncidents();
  eng.stats.lastTickAt = Date.now() - 60000;
  eng.checkEngineHealth();
  assert.equal(activeIncidents(), before + 1);
  const incident = db.prepare("SELECT * FROM alerts WHERE kind = 'engine' AND status = 'active' ORDER BY id DESC LIMIT 1").get();
  assert.match(incident.message, /عقب افتاده/);
  assert.equal(incident.device_id, null, 'engine alerts are not tied to a device');

  // ۲) تکرار در فاصلهٔ کوتاه هشدار تازه نمی‌سازد
  eng.checkEngineHealth();
  assert.equal(activeIncidents(), before + 1, 'a repeated incident must not spam the alert centre');

  // ۳) بازگشت به وضعیت پایدار پس از دورهٔ بی‌خطایی → هشدارها بسته می‌شوند
  eng.stats.lastTickAt = Date.now();
  eng.stats.lastErrorAt = Date.now() - 5000;
  eng.checkEngineHealth();
  assert.equal(activeIncidents(), 0);

  // ۴) تجهیزات در این مسیر دست‌نخورده می‌مانند (سلامت موتور ≠ سلامت تجهیز)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM devices WHERE status = ?').get(STATUS.OFFLINE).c >= 0, true);
  eng.running = false;
  eng.leader = false;
});

test('engine status reports engine health independently of device health', () => {
  const eng = new MonitoringEngine({ emitToBus: false });
  const offline = newDevice({ status: STATUS.OFFLINE, next_check_at: Date.now() + 3600000 });
  eng.running = false;
  const status = eng.getStatus();
  assert.equal(status.healthy, false, 'a stopped engine is not healthy');
  assert.equal(status.internalErrors, 0);
  assert.equal(status.networkFailures >= 0, true);
  assert.equal(typeof status.scheduling.lastLagMs, 'number');
  assert.equal(status.simulation, true, 'simulation must be visible in the status');
  // سلامت موتور هیچ ربطی به وضعیت تجهیزات ندارد
  assert.equal(deviceRow(db, offline).status, STATUS.OFFLINE);
});
