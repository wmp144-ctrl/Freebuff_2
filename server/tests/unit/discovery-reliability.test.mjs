/**
 * کشف شبکه — آزمون‌های پایایی (BUG-15..17، BUG-20..22)
 * ----------------------------------------------------------------
 * تمرکز این فایل روی مرزهای منابع و شرایط غیرعادی است، نه اسکن واقعی:
 *   • سقف ۳۲ محدوده نباید ویرایش محدودهٔ موجود را بلاک کند
 *   • محدودهٔ غیرفعال هرگز اسکن نمی‌شود
 *   • خطای یک محدوده بقیه را متوقف نمی‌کند و وضعیت همان محدوده ثبت می‌شود
 *   • توقف اسکن (خاموشی) سوکت‌ها را می‌بندد و وضعیت را تعیین تکلیف می‌کند
 *   • وضعیت اسکن پس از Crash «interrupted» می‌شود و کهنه نمی‌ماند
 *   • نتایج تکراری/هم‌پوشان یک ردیف بیشتر نمی‌سازند
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, addDevice } from '../helpers.mjs';

const dir = useTempDataDir('discovery-reliability');
const { db, setSettings } = await import('../../db.js');
const {
  MAX_RANGES,
  validateRangeInput,
  assertRangeCapacity,
  runDiscoveryScan,
  importDiscoveryResult,
  recoverDiscoveryState,
  requestDiscoveryStop,
  discoveryStatus,
} = await import('../../discovery.js');

after(() => {
  db.close();
  cleanupDir(dir);
});

const now = Date.now();

function insertRange(cidr, { enabled = 1, name = null, lastScanStatus = null } = {}) {
  const r = db
    .prepare(
      `INSERT INTO discovery_ranges(name, cidr, enabled, interval_hours, last_scan_status, created_at, updated_at)
       VALUES (?,?,?,24,?,?,?)`
    )
    .run(name || cidr, cidr, enabled, lastScanStatus || 'never', now, now);
  return Number(r.lastInsertRowid);
}

function clearRanges() {
  db.prepare('DELETE FROM discovery_ranges').run();
  db.prepare('DELETE FROM discovery_results').run();
}

// اسکن سریع: هیچ پورتی باز نیست و اتصال loopback فوراً رد می‌شود.
setSettings({ discovery_ports: [9], discovery_timeout_ms: 100, discovery_concurrency: 8, discovery_max_hosts: 64 });

test('BUG-15: capacity is enforced on create only, never on edit', () => {
  clearRanges();
  for (let i = 1; i <= MAX_RANGES; i++) insertRange(`192.168.${i}.0/32`);
  const existing = db.prepare('SELECT * FROM discovery_ranges ORDER BY id LIMIT 1').get();
  // ویرایش یک محدودهٔ موجود در سقف ۳۲ تایی باید موفق باشد.
  const payload = validateRangeInput({ ...existing, name: 'نام تازه', cidr: existing.cidr });
  assert.equal(payload.name, 'نام تازه');
  assert.equal(payload.cidr, existing.cidr);
  // افزودن محدودهٔ جدید همچنان با خطای قابل‌فهم رد می‌شود.
  assert.throws(
    () => assertRangeCapacity(),
    (error) => error.status === 409 && /حداکثر/.test(error.message)
  );
  clearRanges();
  assert.doesNotThrow(() => assertRangeCapacity());
});

test('BUG-16: disabled ranges are skipped even when explicitly selected', async () => {
  clearRanges();
  const enabledId = insertRange('127.0.0.1/32');
  const disabledId = insertRange('127.0.0.2/32', { enabled: 0 });
  const result = await runDiscoveryScan({
    rangeIds: [enabledId, disabledId],
    trigger: 'manual',
    now,
  });
  assert.equal(result.ranges, 1, 'فقط محدودهٔ فعال اسکن شود');
  assert.equal(result.skippedDisabled, 1);
  const disabled = db.prepare('SELECT * FROM discovery_ranges WHERE id=?').get(disabledId);
  assert.equal(disabled.last_scan_at, null, 'محدودهٔ غیرفعال هیچ اثری از اسکن ندارد');
  const enabled = db.prepare('SELECT * FROM discovery_ranges WHERE id=?').get(enabledId);
  assert.equal(enabled.last_scan_status, 'ok');
  clearRanges();
});

test('BUG-16: a scan with only disabled ranges does nothing', async () => {
  clearRanges();
  const id = insertRange('127.0.0.1/32', { enabled: 0 });
  const result = await runDiscoveryScan({ rangeIds: [id], trigger: 'manual', now });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'NO_ENABLED_RANGES');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM discovery_results').get().c, 0);
  clearRanges();
});

test('BUG-17: a failure in one range does not abort the remaining ranges', async () => {
  clearRanges();
  const a = insertRange('127.0.0.1/32');
  const b = insertRange('127.0.0.2/32');
  const c = insertRange('127.0.0.3/32');
  // با یک Trigger، به‌روزرسانی وضعیت محدودهٔ b را شکست می‌دهیم؛ این خطا باید
  // فقط همان محدوده را «error» کند و اسکن a و c ادامه یابد.
  db.exec(`
    CREATE TRIGGER fail_discovery_range_b BEFORE UPDATE ON discovery_ranges
    WHEN NEW.id = ${b} AND NEW.last_scan_status = 'running'
    BEGIN SELECT RAISE(ABORT, 'simulated range failure'); END;
  `);
  try {
    const result = await runDiscoveryScan({ rangeIds: [a, b, c], trigger: 'manual', now });
    assert.equal(result.failedRanges, 1);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].rangeId, b);
    assert.match(String(result.failures[0].message), /simulated range failure/);
    const status = (id) => db.prepare('SELECT last_scan_status FROM discovery_ranges WHERE id=?').get(id).last_scan_status;
    assert.equal(status(a), 'ok');
    assert.equal(status(b), 'error');
    assert.equal(status(c), 'ok');
  } finally {
    db.exec('DROP TRIGGER IF EXISTS fail_discovery_range_b');
    clearRanges();
  }
});

test('BUG-20: stopping a scan aborts in-flight probes and marks it stopped', async () => {
  clearRanges();
  insertRange('127.0.0.1/32');
  insertRange('127.0.0.2/32');
  insertRange('127.0.0.3/32');
  // Probe ساختگی که تا Abort آویزان می‌ماند؛ برای آزمون مسیر خاموشی.
  const hangingProbe = (_ip, { signal } = {}) =>
    new Promise((resolve) => {
      const done = () => resolve({ up: false, ports: [] });
      if (signal?.aborted) return done();
      signal?.addEventListener('abort', done, { once: true });
    });
  const scan = runDiscoveryScan({ trigger: 'manual', now, probeHostFn: hangingProbe });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(discoveryStatus().running, true);
  assert.equal(requestDiscoveryStop(), true);
  const result = await scan;
  assert.equal(result.stopped, true);
  assert.equal(discoveryStatus().running, false);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM runtime_state WHERE key='discovery_scan'").get().c, 0);
  assert.equal(requestDiscoveryStop(), false, 'اسکن متوقف‌شده دوباره متوقف نمی‌شود');
  clearRanges();
});

test('BUG-22: interrupted scans are reconciled after restart', () => {
  clearRanges();
  const id = insertRange('127.0.0.1/32', { lastScanStatus: 'running' });
  db.prepare(
    `INSERT INTO runtime_state(key, value, updated_at) VALUES ('discovery_scan', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).run(JSON.stringify({ scanId: 'crashed-scan', startedAt: now - 3_600_000 }), now - 3_600_000);

  const recovered = recoverDiscoveryState({ now });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.ranges, 1);
  const row = db.prepare('SELECT * FROM discovery_ranges WHERE id=?').get(id);
  assert.equal(row.last_scan_status, 'interrupted');
  assert.match(String(row.last_scan_message), /متوقف|نیمه‌کاره/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM runtime_state WHERE key='discovery_scan'").get().c, 0);
  clearRanges();
});

test('BUG-22: a fresh scan state from another instance is not clobbered', () => {
  clearRanges();
  const id = insertRange('127.0.0.1/32', { lastScanStatus: 'running' });
  db.prepare(
    `INSERT INTO runtime_state(key, value, updated_at) VALUES ('discovery_scan', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).run(JSON.stringify({ scanId: 'live-scan', startedAt: now }), now);
  const recovered = recoverDiscoveryState({ now, staleMs: 15 * 60 * 1000 });
  assert.equal(recovered.recovered, false);
  assert.equal(recovered.active, true);
  assert.equal(db.prepare('SELECT last_scan_status FROM discovery_ranges WHERE id=?').get(id).last_scan_status, 'running');
  db.prepare("DELETE FROM runtime_state WHERE key='discovery_scan'").run();
  clearRanges();
});

test('BUG-21: overlapping ranges and repeated import never create duplicate rows/devices', async () => {
  clearRanges();
  // یک پورت محلی واقعی تا اسکن هم‌پوشان حتماً یک میزبان پیدا کند.
  const net = await import('node:net');
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  setSettings({ discovery_ports: [port], discovery_timeout_ms: 300, discovery_max_hosts: 8 });
  // دو محدودهٔ هم‌پوشان که هر دو 127.0.0.1 را پوشش می‌دهند.
  const wide = insertRange('127.0.0.0/29');
  const narrow = insertRange('127.0.0.1/32');
  try {
    const result = await runDiscoveryScan({ rangeIds: [wide, narrow], trigger: 'manual', now });
    assert.equal(result.found, 2, 'هر دو محدوده میزبان را پیدا می‌کنند');
    assert.equal(result.added, 1, 'ولی فقط یک ردیف یکتا ثبت می‌شود');
    assert.equal(db.prepare("SELECT COUNT(*) c FROM discovery_results WHERE ip='127.0.0.1'").get().c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM alerts WHERE kind='discovery' AND title LIKE '%127.0.0.1%'").get().c, 1);

    const rowId = db.prepare("SELECT id FROM discovery_results WHERE ip='127.0.0.1'").get().id;
    const first = importDiscoveryResult(rowId, { name: 'loopback' });
    assert.equal(first.imported, true);
    const again = importDiscoveryResult(rowId, { name: 'loopback' });
    assert.equal(again.imported, false);
    assert.equal(again.duplicate, true);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM devices WHERE ip='127.0.0.1'").get().c, 1, 'تجهیز تکراری ساخته نمی‌شود');

    // یک نتیجهٔ دیگر با همان IP (سناریوی دادهٔ قدیمی) هم باید رد شود.
    db.prepare('DELETE FROM devices WHERE ip=?').run('127.0.0.1');
    db.prepare("UPDATE discovery_results SET imported_device_id=NULL, status='new' WHERE ip='127.0.0.1'").run();
    addDevice(db, { name: 'ثبت دستی', ip: '127.0.0.1' });
    assert.throws(() => importDiscoveryResult(rowId), /از قبل در سامانه ثبت شده/);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM devices WHERE ip='127.0.0.1'").get().c, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    clearRanges();
    db.prepare("DELETE FROM devices WHERE ip='127.0.0.1'").run();
  }
});
