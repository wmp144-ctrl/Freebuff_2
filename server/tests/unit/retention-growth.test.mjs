/**
 * Retention — کنترل رشد جدول‌های تاریخی (BUG-23)
 * ----------------------------------------------------------------
 * `retention_runs` و نتایج کشفِ واردشده پیش‌تر هیچ سیاستی نداشتند و در بهره‌برداری
 * طولانی‌مدت بی‌مرز رشد می‌کردند. این آزمون تضمین می‌کند:
 *   • فقط ۵۰۰ اجرای آخر نگه داشته می‌شود و ردیف running هرگز حذف نمی‌شود.
 *   • نتایج کشفِ imported قدیمی هرس می‌شوند اما new/dismissed و مرجع تجهیز
 *     دست‌نخورده می‌مانند.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, addDevice } from '../helpers.mjs';

const dir = useTempDataDir('retention-growth');
const { db, setSettings } = await import('../../db.js');
const { runRetention } = await import('../../retention.js');

after(() => {
  db.close();
  cleanupDir(dir);
});

const DAY = 86400000;
const NOW = Date.now();

setSettings({
  retention_enabled: true,
  retention_legal_hold: false,
  samples_retention_days: 10,
  outages_retention_days: 365,
  alerts_retention_days: 180,
  daily_stats_retention_days: 365,
  audit_retention_days: 365,
  engine_log_retention_days: 30,
  retention_batch_size: 200,
  retention_max_rows_per_run: 100000,
  retention_prune_backups: false,
});

const count = (sql, ...args) => db.prepare(sql).get(...args).c;

test('retention keeps only the newest run history and never drops a running row', () => {
  db.prepare('DELETE FROM retention_runs').run();
  const insert = db.prepare(
    `INSERT INTO retention_runs(started_at, trigger, status, stage, deleted, policy)
     VALUES (?, 'manual', 'completed', 'done', '{}', '{}')`
  );
  for (let i = 0; i < 620; i++) insert.run(NOW - (700 - i) * 60000);
  const running = Number(
    db
      .prepare("INSERT INTO retention_runs(started_at, trigger, status, stage) VALUES (?, 'manual', 'running', 'samples')")
      .run(NOW - 1000).lastInsertRowid
  );

  const result = runRetention({ trigger: 'manual' });
  assert.equal(result.status, 'completed');
  assert.ok(result.deleted.retention_runs > 0, 'تاریخچهٔ قدیمی باید هرس شود');
  assert.equal(count("SELECT COUNT(*) AS c FROM retention_runs WHERE status <> 'running'"), 500, 'فقط ۵۰۰ اجرای آخر می‌ماند');
  assert.ok(db.prepare('SELECT id FROM retention_runs WHERE id = ?').get(running), 'ردیف running هرگز حذف نمی‌شود');
});

test('old imported discovery rows are pruned while active results are kept', () => {
  db.prepare('DELETE FROM discovery_results').run();
  const device = addDevice(db, { name: 'discovery-imported', ip: '10.93.0.1', status: 'unknown', ping_interval: 3600 });
  const rangeId = Number(
    db
      .prepare(
        `INSERT INTO discovery_ranges(name, cidr, enabled, interval_hours, last_scan_status, created_at, updated_at)
         VALUES ('retention', '10.93.0.0/24', 1, 24, 'ok', ?, ?)`
      )
      .run(NOW, NOW).lastInsertRowid
  );
  const add = db.prepare(
    `INSERT INTO discovery_results(range_id, ip, open_ports, first_seen_at, last_seen_at, discovered_at, expires_at, status, imported_device_id)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  add.run(rangeId, '10.93.0.1', '[]', NOW - 200 * DAY, NOW - 200 * DAY, NOW - 200 * DAY, NOW + DAY, 'imported', device);
  add.run(rangeId, '10.93.0.2', '[]', NOW - 200 * DAY, NOW - 200 * DAY, NOW - 200 * DAY, NOW - DAY, 'dismissed', null);
  add.run(rangeId, '10.93.0.3', '[]', NOW - 2 * DAY, NOW - 2 * DAY, NOW - 2 * DAY, NOW + DAY, 'new', null);
  add.run(rangeId, '10.93.0.4', '[]', NOW - 2 * DAY, NOW - 2 * DAY, NOW - 2 * DAY, NOW + DAY, 'imported', null);

  const result = runRetention({ trigger: 'manual' });
  assert.equal(result.deleted.discovery_results, 1, 'فقط ردیف imported قدیمی حذف می‌شود');
  assert.equal(count("SELECT COUNT(*) AS c FROM discovery_results WHERE ip = '10.93.0.1'"), 0);
  for (const ip of ['10.93.0.2', '10.93.0.3', '10.93.0.4']) {
    assert.equal(count('SELECT COUNT(*) AS c FROM discovery_results WHERE ip = ?', ip), 1, `${ip} باید بماند`);
  }
});
