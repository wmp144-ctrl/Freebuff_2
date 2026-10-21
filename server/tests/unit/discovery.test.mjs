/**
 * کشف شبکه — مرزهای منابع، مجاز بودن محدوده، جلوگیری از ثبت تکراری و
 * انقضای ۲۴ ساعته (بدون حذف تجهیز ثبت‌شده).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { useTempDataDir, cleanupDir, addDevice } from '../helpers.mjs';

const dir = useTempDataDir('discovery');
const { db } = await import('../../db.js');
const {
  hostCount,
  expandHosts,
  isRangeAllowed,
  validateRangeInput,
  pruneExpired,
  importDiscoveryResult,
  runDiscoveryScan,
} = await import('../../discovery.js');

test.after(() => {
  db.close();
  cleanupDir(dir);
});

test('تعداد میزبان و حذف آدرس شبکه/broadcast', () => {
  assert.equal(hostCount('192.168.1.0/24'), 256);
  assert.equal(hostCount('10.0.0.0/30'), 4);
  const hosts = expandHosts('192.168.1.0/29', 10);
  assert.deepEqual(hosts, ['192.168.1.1', '192.168.1.2', '192.168.1.3', '192.168.1.4', '192.168.1.5', '192.168.1.6']);
  assert.deepEqual(expandHosts('192.168.1.10/32', 10), ['192.168.1.10']);
  assert.deepEqual(expandHosts('10.0.0.0/8', 10), [], 'محدودهٔ بزرگ‌تر از سقف سخت تولید نمی‌شود');
});

test('محدوده باید کامل زیرمجموعهٔ شبکهٔ مجاز باشد', () => {
  const allowed = ['192.168.0.0/16', '10.0.0.0/8'];
  assert.equal(isRangeAllowed('192.168.5.0/24', allowed), true);
  assert.equal(isRangeAllowed('192.168.0.0/15', allowed), false, 'والد بزرگ‌تر از شبکهٔ مجاز مجاز نیست');
  assert.equal(isRangeAllowed('8.8.8.0/24', allowed), false);
  assert.equal(isRangeAllowed('::1/128', allowed), false);
});

test('اعتبارسنجی محدوده سقف میزبان و سیاست شبکه را اعمال می‌کند', () => {
  const ok = validateRangeInput({ name: 'طبقه ۳', cidr: '192.168.5.0/30' }, { settings: { ...dbDefaults() } });
  assert.equal(ok.cidr, '192.168.5.0/30');
  assert.equal(ok.enabled, 1);
  assert.throws(
    () => validateRangeInput({ name: 'بزرگ', cidr: '10.0.0.0/16' }, { settings: { ...dbDefaults() } }),
    /سقف مجاز/
  );
  assert.throws(
    () => validateRangeInput({ name: 'بیرون', cidr: '8.8.8.0/24' }, { settings: { ...dbDefaults() } }),
    /شبکه‌های مجاز/
  );
  assert.throws(
    () => validateRangeInput({ name: 'لینک‌لوکال', cidr: '169.254.10.0/24' }, { settings: { ...dbDefaults() } }),
    /مجاز نیست|شبکه‌های مجاز/
  );
  assert.throws(() => validateRangeInput({ name: '', cidr: '192.168.5.0/30' }, { settings: { ...dbDefaults() } }), /نام/);
});

function dbDefaults() {
  return {
    probe_allowed_cidrs: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8'],
    probe_allow_link_local: false,
    probe_allow_metadata: false,
    probe_allow_transition: false,
    discovery_max_hosts: 256,
    discovery_interval_hours: 24,
  };
}

function insertResult(ip, { discoveredAt = Date.now(), expiresAt = Date.now() + 3600000, status = 'new' } = {}) {
  const now = Date.now();
  const r = db
    .prepare(
      `INSERT INTO discovery_results(range_id, ip, hostname, open_ports, vendor, first_seen_at, last_seen_at, discovered_at, expires_at, notified, status)
       VALUES (NULL, ?, '', '[]', '', ?, ?, ?, ?, 0, ?)`
    )
    .run(ip, now, now, discoveredAt, expiresAt, status);
  return Number(r.lastInsertRowid);
}

test('انقضای ۲۴ ساعته فقط فهرست کشف را حذف می‌کند، نه تجهیز ثبت‌شده', () => {
  const ip = '192.168.77.10';
  const deviceId = addDevice(db, { name: 'ثبت‌شده', ip });
  insertResult('192.168.77.11', { expiresAt: Date.now() - 1000 });
  insertResult('192.168.77.12', { expiresAt: Date.now() + 3600000 });
  const removed = pruneExpired(Date.now());
  assert.equal(removed, 1);
  assert.ok(db.prepare('SELECT id FROM devices WHERE id=?').get(deviceId), 'تجهیز ثبت‌شده باید باقی بماند');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM discovery_results WHERE ip='192.168.77.11'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM discovery_results WHERE ip='192.168.77.12'").get().c, 1);
});

test('IP تکراری دوباره ثبت نمی‌شود', () => {
  const ip = '192.168.88.20';
  addDevice(db, { name: 'موجود', ip });
  const resultId = insertResult(ip);
  assert.throws(() => importDiscoveryResult(resultId, { actor: 'test' }), /از قبل در سامانه ثبت شده/);
});

test('اسکن واقعی میزبان محلی را یک‌بار کشف می‌کند و بار دوم تکراری ثبت نمی‌کند', async () => {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const set = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  set.run('discovery_ports', JSON.stringify([port]));
  set.run('discovery_timeout_ms', JSON.stringify(300));
  set.run('discovery_concurrency', JSON.stringify(4));
  set.run('discovery_max_hosts', JSON.stringify(8));

  const now = Date.now();
  const range = db
    .prepare('INSERT INTO discovery_ranges(name, cidr, enabled, interval_hours, created_at, updated_at) VALUES (?,?,1,24,?,?)')
    .run('محلی', '127.0.0.1/32', now, now);
  try {
    const first = await runDiscoveryScan({ rangeIds: [Number(range.lastInsertRowid)], trigger: 'manual', now });
    assert.equal(first.found, 1);
    assert.equal(first.added, 1);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM discovery_results WHERE ip='127.0.0.1' AND status='new'").get().c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM alerts WHERE kind='discovery'").get().c, 1, 'اعلان مدیریتی ثبت می‌شود');

    const second = await runDiscoveryScan({ rangeIds: [Number(range.lastInsertRowid)], trigger: 'manual' });
    assert.equal(second.found, 1);
    assert.equal(second.added, 0, 'IP تکراری دوباره ثبت نمی‌شود');
    assert.equal(db.prepare("SELECT COUNT(*) c FROM discovery_results WHERE ip='127.0.0.1'").get().c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM alerts WHERE kind='discovery'").get().c, 1, 'اعلان تکراری ساخته نمی‌شود');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.prepare('DELETE FROM discovery_ranges WHERE id=?').run(Number(range.lastInsertRowid));
  }
});

test('واردکردن نتیجهٔ کشف تجهیز می‌سازد و نتیجه را imported می‌کند', () => {
  const id = insertResult('192.168.88.30');
  const res = importDiscoveryResult(id, { name: 'دوربین کشف‌شده', actor: 'test' });
  assert.equal(res.imported, true);
  const device = db.prepare('SELECT * FROM devices WHERE id=?').get(res.deviceId);
  assert.equal(device.ip, '192.168.88.30');
  assert.equal(device.name, 'دوربین کشف‌شده');
  assert.equal(db.prepare('SELECT status FROM discovery_results WHERE id=?').get(id).status, 'imported');
});
