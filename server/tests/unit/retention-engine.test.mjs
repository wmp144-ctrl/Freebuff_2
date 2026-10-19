/**
 * آزمون Data Retention Engine.
 *
 * معیارهای پذیرش Phase 2:
 *   • سیاست قابل تنظیم است و مقادیر خارج از الزام قانونی به کف مجاز برگردانده می‌شوند
 *   • Dry-Run هیچ تغییری در داده نمی‌دهد و حجم قابل حذف را گزارش می‌کند
 *   • قبل از حذف نمونه‌ها، روزهای دارای نمونه در daily_stats تثبیت می‌شوند؛ اگر
 *     تجمیع کامل نشود، حذف نمونه‌ها متوقف می‌شود (دادهٔ تاریخی از دست نمی‌رود)
 *   • قطعی «باز»، هشدار «حل‌نشده» و قطعی متصل به سابقهٔ تعمیرات هرگز حذف نمی‌شوند
 *   • سقف هر اجرا رعایت می‌شود و اجرای بعدی از همان وضعیت معتبر ادامه می‌دهد
 *   • اجرای هم‌زمان با قفل پایگاه‌داده رد می‌شود
 *   • هر اجرا در retention_runs و Audit Log ثبت می‌شود
 *   • Legal Hold و حالت غیرفعال، از حذف خودکار جلوگیری می‌کنند
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, addDevice } from '../helpers.mjs';

const dir = useTempDataDir('retention');
const { db, setSettings, transaction } = await import('../../db.js');
const {
  retentionPolicy,
  retentionStatus,
  runRetention,
  computeNextRunAt,
  markInterruptedRetentionRuns,
  requestRetentionStop,
} = await import('../../retention.js');

const DAY = 86400000;
const NOW = Date.now();

const deviceId = addDevice(db, { name: 'retention-device', ip: '10.99.0.1', status: 'offline', ping_interval: 3600 });
const healthyId = addDevice(db, { name: 'retention-device-healthy', ip: '10.99.0.2', status: 'online', ping_interval: 3600 });

const insertSample = db.prepare('INSERT INTO samples(device_id, ts, rtt_ms, packets_sent, packets_recv, loss_pct, status, ok, mode) VALUES (?,?,?,?,?,?,?,?,?)');
const insertOldSamples = (device, daysAgo, count = 5) => {
  const base = NOW - daysAgo * DAY;
  for (let i = 0; i < count; i++) insertSample.run(device, base + i * 1000, 5, 1, 1, 0, 'online', 1, 'test');
};

setSettings({
  retention_enabled: true,
  retention_legal_hold: false,
  samples_retention_days: 10,
  outages_retention_days: 365,
  alerts_retention_days: 180,
  daily_stats_retention_days: 365,
  audit_retention_days: 365,
  engine_log_retention_days: 30,
  retention_batch_size: 100,
  retention_max_rows_per_run: 100000,
  retention_run_time: '03:00',
  retention_interval_minutes: 1440,
  timezone_offset_minutes: 0,
  retention_prune_backups: false,
});

const rows = (sql, ...params) => db.prepare(sql).get(...params).c;

test('policy reads settings and clamps values below legal minimums', () => {
  const policy = retentionPolicy();
  assert.equal(policy.samplesDays, 10);
  assert.equal(policy.outagesDays, 365);
  assert.equal(policy.maxRowsPerRun, 100000);

  // مقدار دستکاری‌شده نباید دادهٔ تاریخی را نابود کند
  setSettings({ audit_retention_days: 365, outages_retention_days: 365, daily_stats_retention_days: 365 });
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'outages_retention_days'").run();
  db.prepare("UPDATE settings SET value = '2' WHERE key = 'audit_retention_days'").run();
  const clamped = retentionPolicy();
  assert.equal(clamped.outagesDays, 365, 'کف قانونی قطعی‌ها اعمال شود');
  assert.equal(clamped.auditDays, 365, 'کف قانونی حسابرسی اعمال شود');
  setSettings({ outages_retention_days: 365, audit_retention_days: 365 });
});

test('computeNextRunAt respects the configured local time and minimum interval', () => {
  const base = Date.UTC(2026, 0, 10, 1, 0, 0); // 01:00 UTC
  const next = computeNextRunAt({ runTime: '03:00', timezoneOffsetMinutes: 0, intervalMinutes: 1440 }, base);
  assert.equal(new Date(next).toISOString(), new Date(Date.UTC(2026, 0, 10, 3, 0, 0)).toISOString());

  const afterTime = computeNextRunAt({ runTime: '03:00', timezoneOffsetMinutes: 0, intervalMinutes: 1440 }, Date.UTC(2026, 0, 10, 5, 0, 0));
  assert.equal(new Date(afterTime).toISOString(), new Date(Date.UTC(2026, 0, 11, 3, 0, 0)).toISOString());
});

test('dry-run reports removable volume without deleting anything and is audited', () => {
  insertOldSamples(deviceId, 40, 3);
  const before = rows('SELECT COUNT(*) AS c FROM samples');
  const result = runRetention({ trigger: 'manual', actor: 'tester', dryRun: true });
  assert.equal(result.status, 'completed');
  assert.equal(result.dryRun, true);
  // اگر روزها تجمیع نشده باشند، Dry-Run صادقانه «قابل حذف نبودن» را گزارش می‌کند
  // و هیچ تجمیعی هم انجام نمی‌دهد؛ در غیر این صورت حجم قابل حذف را می‌دهد.
  assert.ok(
    result.counts.samples >= 3 || /missing_daily_stats/.test(String(result.blocked.samples || '')),
    `گزارش Dry-Run باید حجم قابل حذف یا دلیل توقف را بدهد: ${JSON.stringify(result)}
`
  );
  assert.equal(rows('SELECT COUNT(*) AS c FROM samples'), before, 'Dry-Run نباید رکوردی حذف کند');

  const run = db.prepare('SELECT * FROM retention_runs WHERE id = ?').get(result.runId);
  assert.equal(Number(run.dry_run), 1);
  assert.equal(run.status, 'completed');
  const audit = db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'retention.dry_run'").get().c;
  assert.ok(audit >= 1, 'Dry-Run باید در Audit Log ثبت شود');
});

test('a real run rolls up days before pruning raw samples and protects essential records', () => {
  const openOutageId = Number(
    db.prepare('INSERT INTO outages(device_id, started_at, cause, open) VALUES (?,?,?,1)').run(deviceId, NOW - 400 * DAY, 'Ping Timeout').lastInsertRowid
  );
  const linkedOutageId = Number(
    db
      .prepare('INSERT INTO outages(device_id, started_at, ended_at, duration_sec, cause, open) VALUES (?,?,?,?,?,0)')
      .run(healthyId, NOW - 500 * DAY, NOW - 500 * DAY + 60000, 60, 'قطعی برق').lastInsertRowid
  );
  db.prepare(
    "INSERT INTO maintenance_records(device_id, outage_id, cause, action, started_at, ended_at, downtime_sec, status, created_at) VALUES (?,?,?,?,?,?,?, 'closed', ?)"
  ).run(healthyId, linkedOutageId, 'قطعی برق', 'تعمیر', NOW - 500 * DAY, NOW - 500 * DAY + 60000, 60, NOW - 500 * DAY);
  const closedOutageId = Number(
    db
      .prepare('INSERT INTO outages(device_id, started_at, ended_at, duration_sec, cause, open) VALUES (?,?,?,?,?,0)')
      .run(healthyId, NOW - 400 * DAY, NOW - 400 * DAY + 60000, 60, 'مشکل شبکه').lastInsertRowid
  );
  const activeAlert = Number(
    db.prepare("INSERT INTO alerts(device_id, severity, kind, title, created_at, status) VALUES (?,?,?,?,?, 'active')").run(deviceId, 'critical', 'offline', 'هشدار فعال', NOW - 400 * DAY).lastInsertRowid
  );
  const acknowledgedAlert = Number(
    db
      .prepare("INSERT INTO alerts(device_id, severity, kind, title, created_at, status, acknowledged_at) VALUES (?,?,?,?,?, 'acknowledged', ?)")
      .run(deviceId, 'warning', 'latency', 'هشدار تأییدشده', NOW - 400 * DAY, NOW - 400 * DAY).lastInsertRowid
  );
  db.prepare("INSERT INTO alerts(device_id, severity, kind, title, created_at, status) VALUES (?,?,?,?,?, 'resolved')").run(
    healthyId,
    'info',
    'recovery',
    'هشدار حل‌شده تجهیز سالم',
    NOW - 400 * DAY
  );
  // هشدار حل‌شده اما روی تجهیزی با قطعی باز => باید بماند
  db.prepare("INSERT INTO alerts(device_id, severity, kind, title, created_at, status) VALUES (?,?,?,?,?, 'resolved')").run(
    deviceId,
    'info',
    'recovery',
    'هشدار حل‌شده تجهیز قطع',
    NOW - 400 * DAY
  );

  const result = runRetention({ trigger: 'manual', actor: 'tester' });
  assert.equal(result.status, 'completed');
  assert.ok(result.deleted.samples >= 3, 'نمونه‌های قدیمی هرس شوند');
  assert.equal(result.deleted.outages, 1, 'فقط قطعی بستهٔ بی‌ارجاع هرس شود');

  assert.ok(db.prepare('SELECT id FROM outages WHERE id = ?').get(openOutageId), 'قطعی باز هرگز حذف نمی‌شود');
  assert.ok(db.prepare('SELECT id FROM outages WHERE id = ?').get(linkedOutageId), 'قطعی متصل به تعمیرات حفظ می‌شود');
  assert.equal(db.prepare('SELECT id FROM outages WHERE id = ?').get(closedOutageId), undefined);
  assert.ok(db.prepare('SELECT id FROM alerts WHERE id = ?').get(activeAlert), 'هشدار فعال حفظ می‌شود');
  assert.ok(db.prepare('SELECT id FROM alerts WHERE id = ?').get(acknowledgedAlert), 'هشدار تأییدشده حفظ می‌شود');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE title='هشدار حل‌شده تجهیز سالم'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE title='هشدار حل‌شده تجهیز قطع'").get().c, 1);

  // روزهای هرس‌شده باید در daily_stats تثبیت شده باشند
  const day = new Date(NOW - 40 * DAY).toISOString().slice(0, 10);
  const rolled = db.prepare('SELECT checks FROM daily_stats WHERE device_id = ? AND day = ?').get(deviceId, day);
  assert.ok(rolled, 'روز نمونه‌های حذف‌شده باید تجمیع شده باشد');
  assert.ok(rolled.checks >= 3);

  const audit = db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'retention.run'").get().c;
  assert.ok(audit >= 1, 'اجرای واقعی باید در Audit Log ثبت شود');
});

test('missing daily aggregates block sample deletion until rollup completes', () => {
  const fresh = addDevice(db, { name: 'retention-gap', ip: '10.99.0.9', status: 'online', ping_interval: 3600 });
  // ۷۰ روز متمایز بدون تجمیع؛ سقف تجمیع هر اجرا ۶۲ روز است
  for (let d = 200; d < 270; d++) insertSample.run(fresh, NOW - d * DAY, 5, 1, 1, 0, 'online', 1, 'test');

  const before = rows('SELECT COUNT(*) AS c FROM samples WHERE device_id = ?', fresh);
  const first = runRetention({ trigger: 'manual', dryRun: false, policyOverride: { batchSize: 100, maxRowsPerRun: 100000 } });
  assert.equal(first.deleted.samples, 0, 'حذف نمونه تا تثبیت کامل تجمیع متوقف می‌شود');
  assert.match(String(first.blocked.samples || ''), /missing_daily_stats/);
  assert.equal(rows('SELECT COUNT(*) AS c FROM samples WHERE device_id = ?', fresh), before, 'هیچ نمونه‌ای حذف نشده است');

  // اجرای دوم/سوم تجمیع را کامل و سپس حذف را انجام می‌دهد (ادامه از وضعیت معتبر)
  let last = first;
  for (let i = 0; i < 3 && rows('SELECT COUNT(*) AS c FROM samples WHERE device_id = ?', fresh) > 0; i++) {
    last = runRetention({ trigger: 'manual', dryRun: false });
  }
  assert.equal(rows('SELECT COUNT(*) AS c FROM samples WHERE device_id = ?', fresh), 0, 'پس از تثبیت، حذف کامل می‌شود');
  assert.equal(last.deleted.samples > 0 || last.blocked.samples === undefined, true);
  const rolledDays = db.prepare('SELECT COUNT(*) AS c FROM daily_stats WHERE device_id = ?').get(fresh).c;
  assert.equal(rolledDays, 70, 'همهٔ روزهای دارای نمونه تجمیع شده‌اند');
});

test('maxRowsPerRun bounds each run and the next run continues from valid state', () => {
  const big = addDevice(db, { name: 'retention-big', ip: '10.99.0.10', status: 'online', ping_interval: 3600 });
  transaction(() => {
    for (let i = 0; i < 50; i++) insertSample.run(big, NOW - (100 + i) * DAY, 5, 1, 1, 0, 'online', 1, 'test');
  });
  const total = rows('SELECT COUNT(*) AS c FROM samples WHERE device_id = ? AND ts < ?', big, NOW - 10 * DAY);
  assert.equal(total, 50);

  const first = runRetention({ trigger: 'manual', policyOverride: { maxRowsPerRun: 20, batchSize: 5 } });
  assert.equal(first.deletedRows, 20, 'سقف هر اجرا رعایت شود');
  const afterFirst = rows('SELECT COUNT(*) AS c FROM samples WHERE device_id = ? AND ts < ?', big, NOW - 10 * DAY);
  assert.equal(afterFirst, 30);

  const second = runRetention({ trigger: 'manual', policyOverride: { maxRowsPerRun: 1000, batchSize: 100 } });
  assert.ok(second.deletedRows >= 30);
  assert.equal(rows('SELECT COUNT(*) AS c FROM samples WHERE device_id = ? AND ts < ?', big, NOW - 10 * DAY), 0);
});

test('a stop request halts between batches and the next run resumes from valid state', () => {
  const stoppable = addDevice(db, { name: 'retention-stop', ip: '10.99.0.11', status: 'online', ping_interval: 3600 });
  transaction(() => {
    for (let i = 0; i < 20; i++) insertSample.run(stoppable, NOW - (150 + i) * DAY, 5, 1, 1, 0, 'online', 1, 'test');
  });
  const before = rows('SELECT COUNT(*) AS c FROM samples WHERE device_id = ?', stoppable);
  assert.equal(before, 20);

  const stopped = runRetention({
    trigger: 'manual',
    policyOverride: { batchSize: 1, maxRowsPerRun: 1000 },
    onBatch: ({ deletedRows }) => {
      if (deletedRows >= 5) requestRetentionStop();
    },
  });
  assert.equal(stopped.status, 'stopped');
  assert.ok(stopped.deletedRows >= 5 && stopped.deletedRows < 20, `حذف باید نیمه‌کاره بایستد: ${stopped.deletedRows}`);
  const remaining = rows('SELECT COUNT(*) AS c FROM samples WHERE device_id = ? AND ts < ?', stoppable, NOW - 10 * DAY);
  assert.ok(remaining > 0, 'رکوردهای باقی‌مانده باید در وضعیت معتبر بمانند');

  // اجرای بعدی (بدون توقف) باید از همان وضعیت ادامه دهد
  const resumed = runRetention({ trigger: 'manual', policyOverride: { batchSize: 100, maxRowsPerRun: 1000 } });
  assert.equal(resumed.status, 'completed');
  assert.equal(rows('SELECT COUNT(*) AS c FROM samples WHERE device_id = ? AND ts < ?', stoppable, NOW - 10 * DAY), 0);
  const stoppedRun = db.prepare('SELECT status FROM retention_runs WHERE id = ?').get(stopped.runId);
  assert.equal(stoppedRun.status, 'stopped', 'وضعیت توقف در پایگاه‌داده ثبت شود');
});

test('legal hold and disabled mode prevent automatic deletion; manual run is explicit', () => {
  insertOldSamples(healthyId, 300, 2);
  setSettings({ retention_legal_hold: true });
  const held = runRetention({ trigger: 'scheduled' });
  assert.equal(held.status, 'skipped');
  assert.equal(held.reason, 'legal_hold');
  setSettings({ retention_legal_hold: false });

  setSettings({ retention_enabled: false });
  const off = runRetention({ trigger: 'scheduled' });
  assert.equal(off.status, 'skipped');
  assert.equal(off.reason, 'disabled');
  const manual = runRetention({ trigger: 'manual', actor: 'admin' });
  assert.equal(manual.status, 'completed', 'اجرای دستی مدیر حتی با خاموش‌بودن خودکار مجاز است');
  setSettings({ retention_enabled: true });
});

test('a concurrent run is rejected by the database lease', () => {
  db.prepare("UPDATE retention_state SET lock_owner = 'other-process', lock_expires_at = ? WHERE id = 1").run(Date.now() + 60000);
  assert.throws(
    () => runRetention({ trigger: 'manual' }),
    (e) => e.code === 'DB_BUSY' && e.status === 409,
    'اجرای هم‌زمان باید با خطای BUSY رد شود'
  );
  db.prepare("UPDATE retention_state SET lock_owner = NULL, lock_expires_at = 0 WHERE id = 1").run();
  assert.equal(requestRetentionStop(), false, 'توقف وقتی اجرایی نیست پذیرفته نمی‌شود');
});

test('interrupted runs are marked and stale progress never blocks the next run', () => {
  db.prepare(
    "INSERT INTO retention_runs(started_at, trigger, dry_run, status, stage) VALUES (?, 'scheduled', 0, 'running', 'samples')"
  ).run(Date.now() - 60000);
  const marked = markInterruptedRetentionRuns();
  assert.ok(marked >= 1);
  const stale = db.prepare("SELECT status FROM retention_runs WHERE stage = 'interrupted' ORDER BY id DESC LIMIT 1").get();
  assert.equal(stale.status, 'interrupted');
  const status = retentionStatus();
  assert.equal(status.running, false);
  assert.ok(Array.isArray(status.runs));
  assert.ok(status.policy.samplesDays >= 1);
});

after(() => {
  db.close();
  cleanupDir(dir);
});
