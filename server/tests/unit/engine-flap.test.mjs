/**
 * قطع و وصل مکرر شبکه (Flapping).
 *
 * یک تجهیز پنج بار پیاپی قطع و وصل می‌شود. انتظار: هر قطعی دقیقاً یک Outage
 * باز می‌کند، هر بازگشت همان را می‌بندد، هیچ Outage بازی باقی نمی‌ماند و
 * شمارنده/هشدارها به‌درستی بازنشانی می‌شوند — بدون رکورد تکراری یا خطای موتور.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, probeResult, addDevice, deviceRow } from '../helpers.mjs';

const dir = useTempDataDir('engine-flap');
const { db, setSettings, STATUS } = await import('../../db.js');
const { MonitoringEngine } = await import('../../engine.js');

let id;

before(() => {
  setSettings({
    engine_mode: 'simulate',
    failures_for_offline: 3,
    successes_for_online: 2,
    alerting_enabled: true,
    alert_cooldown: 600,
    max_workers: 8,
  });
  id = addDevice(db, { name: 'flapping-device', ip: '10.220.0.1', status: STATUS.ONLINE, ping_interval: 5 });
});

after(() => {
  db.close();
  cleanupDir(dir);
});

test('five down/up cycles leave exactly one outage per cycle and no dangling state', async () => {
  const eng = new MonitoringEngine({ emitToBus: false });
  let ok = true;
  eng.probe = async () => probeResult(ok);

  for (let cycle = 1; cycle <= 5; cycle++) {
    // سه شکست متوالی → قطعی
    ok = false;
    for (let i = 0; i < 3; i++) await eng.checkDevice(deviceRow(db, id), { manual: true });
    let row = deviceRow(db, id);
    assert.equal(row.status, STATUS.OFFLINE, `cycle ${cycle}: must be offline`);
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM outages WHERE device_id = ? AND open = 1').get(id).c,
      1,
      `cycle ${cycle}: exactly one open outage`
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM outages WHERE device_id = ?').get(id).c,
      cycle,
      `cycle ${cycle}: one outage per cycle`
    );

    // دو موفقیت متوالی → بازگشت
    ok = true;
    for (let i = 0; i < 2; i++) await eng.checkDevice(deviceRow(db, id), { manual: true });
    row = deviceRow(db, id);
    assert.equal(row.status, STATUS.ONLINE, `cycle ${cycle}: must recover`);
    assert.equal(row.consecutive_failures, 0);
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM outages WHERE device_id = ? AND open = 1').get(id).c,
      0,
      `cycle ${cycle}: no open outage after recovery`
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) c FROM alerts WHERE device_id = ? AND kind='offline' AND status='active'").get(id).c,
      0,
      `cycle ${cycle}: offline alert must be resolved`
    );
  }

  assert.equal(eng.stats.errors, 0, 'flapping must not be counted as engine errors');
  const recoveries = db.prepare("SELECT COUNT(*) c FROM alerts WHERE device_id = ? AND kind='recovery'").get(id).c;
  assert.ok(recoveries >= 1 && recoveries <= 5, `unexpected recovery alert count: ${recoveries}`);
});
