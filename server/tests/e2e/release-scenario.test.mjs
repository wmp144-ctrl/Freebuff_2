/**
 * سناریوی پذیرش انتشار (Release Scenario)
 * ----------------------------------------------------------------
 * این آزمون همان مسیر بند ۳ سند پذیرش را روی یک نصب تازه اجرا می‌کند:
 *
 *   نصب تازه → Migration → ورود مدیر → ساخت کاربران و نقش‌ها → افزودن تجهیز
 *   → Probe → Sample → قطعی → Outage و Alert → داشبورد → SSE و اتصال مجدد
 *   → Import → Backup → Retention (dry-run) → توقف سرویس → Restore
 *   → راه‌اندازی مجدد → بررسی صحت داده
 *
 * همه‌چیز روی پوشهٔ دادهٔ موقت انجام می‌شود؛ دادهٔ واقعی پروژه لمس نمی‌شود.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, api, cleanupDir, freePort, startServer, upload, useTempDataDir, waitFor } from '../helpers.mjs';

const dir = useTempDataDir('release-scenario');
let srv;
let closedPort;
let deviceId;
let backupCounts = null;
let backupName = null;

/** اجرای اسکریپت CLI با همان پوشهٔ دادهٔ این سناریو */
function runScript(script, args = []) {
  const out = execFileSync(process.execPath, [path.join('server', 'scripts', script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NETWATCH_DATA_DIR: dir, NETWATCH_LOG_STREAM: 'stderr' },
  });
  const start = out.indexOf('{');
  return JSON.parse(out.slice(start));
}

/** خواندن مستقیم پایگاه‌داده (پس از توقف سرویس) */
function readDb(fn) {
  const db = new DatabaseSync(path.join(dir, 'netwatch.db'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

before(async () => {
  closedPort = await freePort();
  srv = await startServer({ dataDir: dir, engine: false });
  const settings = await api(srv.base, 'PUT', '/api/settings', {
    engine_mode: 'tcp',
    tcp_port: closedPort,
    timeout_ms: 200,
    retries: 0,
    packet_count: 1,
    ping_interval: 3600,
    failures_for_offline: 2,
    successes_for_online: 1,
    alerting_enabled: true,
    alert_cooldown: 0,
    suppression_enabled: false,
    backup_enabled: false,
  });
  assert.equal(settings.status, 200, 'تنظیمات پایش باید ذخیره شود');
});

after(async () => {
  if (srv) await srv.stop().catch(() => {});
  cleanupDir(dir);
});

test('clean install: schema is current and no half-finished state exists', async () => {
  // مجوز فایل پایگاه‌داده پس از نصب: فقط مالک (حتی اگر umask سرور باز باشد).
  const dbMode = fs.statSync(path.join(dir, 'netwatch.db')).mode & 0o777;
  assert.equal(dbMode & 0o077, 0, `پایگاه‌داده نباید برای گروه/دیگران خواندنی باشد (${dbMode.toString(8)})`);

  const health = await api(srv.base, 'GET', '/api/system/db/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true, 'پایگاه‌داده پس از نصب تازه سالم است');
  const version = readDb((db) => ({
    user: Number(db.prepare('PRAGMA user_version').get().user_version),
    migrations: db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all().map((r) => Number(r.version)),
    integrity: db.prepare('PRAGMA quick_check').get(),
  }));
  assert.equal(version.user, version.migrations.at(-1), 'user_version با آخرین Migration همگام است');
  assert.deepEqual(version.migrations, [1, 2, 3, 4, 5, 6, 7, 8].slice(0, version.migrations.length));
  assert.equal(Object.values(version.integrity)[0], 'ok');
});

test('admin creates operator and viewer accounts with separate permissions', async () => {
  const users = [
    { username: 'ops-release', password: 'OpsRelease!2345', role: 'operator' },
    { username: 'view-release', password: 'ViewRelease!2345', role: 'viewer' },
  ];
  for (const user of users) {
    const created = await api(srv.base, 'POST', '/api/auth/users', { ...user, displayName: user.username });
    assert.equal(created.status, 201, `ساخت ${user.role} ناموفق بود`);
  }
  const list = await api(srv.base, 'GET', '/api/auth/users');
  assert.equal(list.status, 200);
  const roles = Object.fromEntries(list.data.items.map((u) => [u.username, u.role]));
  assert.equal(roles['ops-release'], 'operator');
  assert.equal(roles['view-release'], 'viewer');
});

test('device is added, probed, sampled, and a failure creates an outage and an alert', async () => {
  const created = await api(srv.base, 'POST', '/api/devices', {
    name: 'Release-Core-SW',
    ip: '127.0.0.1',
    location: 'اتاق سرور',
    group: 'هسته',
    priority: 'critical',
  });
  assert.equal(created.status, 201);
  deviceId = created.data.id;

  // Probe اول: وضعیت هنوز «نامشخص» است (آستانهٔ قطعی دو شکست است)
  const first = await api(srv.base, 'POST', `/api/devices/${deviceId}/ping`, { mode: 'engine' });
  assert.equal(first.status, 200);
  assert.equal(first.data.result.ok, false);
  assert.equal((await api(srv.base, 'GET', `/api/devices/${deviceId}`)).data.status, 'unknown');

  // Probe دوم: قطعی ثبت می‌شود
  const second = await api(srv.base, 'POST', `/api/devices/${deviceId}/ping`, { mode: 'engine' });
  assert.equal(second.status, 200);
  const device = (await api(srv.base, 'GET', `/api/devices/${deviceId}`)).data;
  assert.equal(device.status, 'offline');
  assert.ok(device.consecutiveFailures >= 2);

  const samples = await api(srv.base, 'GET', `/api/devices/${deviceId}/samples?limit=10`);
  assert.equal(samples.status, 200);
  assert.ok(samples.data.items.length >= 2, 'نمونه‌های Probe باید ذخیره شوند');

  const outages = await api(srv.base, 'GET', `/api/devices/${deviceId}/outages`);
  assert.equal(outages.data.open?.id != null, true, 'قطعی باز باید ثبت شود');
  assert.ok(outages.data.open.durationSec >= 0);

  const alerts = await api(srv.base, 'GET', `/api/alerts?status=active&deviceId=${deviceId}`);
  const offlineAlert = alerts.data.items.find((a) => a.kind === 'offline');
  assert.ok(offlineAlert, 'هشدار قطعی باید ساخته شود');
  assert.equal(offlineAlert.severity, 'critical');
});

test('dashboard, reports and status reflect the outage', async () => {
  const summary = await api(srv.base, 'GET', '/api/dashboard/summary');
  assert.equal(summary.status, 200);
  assert.ok(summary.data.kpis.total >= 1);
  assert.ok(summary.data.kpis.offline >= 1);
  assert.ok(summary.data.health.alertsActive >= 1);
  assert.ok(summary.data.statusDistribution.some((s) => s.key === 'offline' && s.value >= 1));
  assert.ok(summary.data.recentAlerts.some((a) => a.deviceId === deviceId));

  const report = await api(srv.base, 'GET', '/api/reports/summary?range=24h');
  assert.equal(report.status, 200);
  assert.ok(report.data.totals.outages >= 1);
  assert.ok(report.data.totals.alerts >= 1);

  const status = await api(srv.base, 'GET', '/api/status');
  assert.equal(status.status, 200);
  assert.equal(status.data.server.ok, true);
  assert.equal(status.data.app.db.ok, true);
  assert.ok(status.data.devices.down >= 1, 'سلامت شبکه باید قطعی را نشان دهد');
});

test('SSE stream delivers hello and resumes after a disconnect', async () => {
  const session = srv.session;
  async function readHello() {
    const controller = new AbortController();
    const res = await fetch(`${srv.base}/api/events?devices=`, {
      headers: { cookie: session.cookie },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes('event: hello')) break;
      }
    } finally {
      controller.abort();
      try {
        await reader.cancel();
      } catch {
        /* جریان قبلاً بسته شده است */
      }
    }
    assert.ok(buffer.includes('event: hello'), `hello دریافت نشد: ${buffer.slice(0, 200)}`);
    return buffer;
  }

  const first = await readHello();
  assert.ok(first.includes('event: status') || first.includes('event: hello'));
  // اتصال دوم باید مستقل باز شود (بدون نشست‌های سرگردان)
  await readHello();
});

test('CSV import adds devices through preview and commit', async () => {
  const csv = 'name,ip,group,location\nRelease-Import-1,127.0.0.3,واردشده,طبقه ۱\nRelease-Import-2,127.0.0.4,واردشده,طبقه ۲\n';
  const preview = await upload(srv.base, '/api/devices/import/preview', {
    filename: 'release.csv',
    content: Buffer.from('\uFEFF' + csv, 'utf8'),
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.summary.valid, 2);
  assert.equal(preview.data.summary.invalid, 0);

  const commit = await upload(srv.base, '/api/devices/import/commit', {
    filename: 'release.csv',
    content: Buffer.from('\uFEFF' + csv, 'utf8'),
    fields: { onlyValid: '1' },
  });
  assert.equal(commit.status, 200);
  assert.equal(commit.data.inserted, 2);

  const list = await api(srv.base, 'GET', '/api/devices?search=Release-Import&pageSize=10');
  assert.equal(list.data.items.length, 2);
});

test('backup reports verified counts and a dry-run retention deletes nothing', async () => {
  const before = readDb((db) => ({
    devices: Number(db.prepare('SELECT COUNT(*) AS c FROM devices').get().c),
    samples: Number(db.prepare('SELECT COUNT(*) AS c FROM samples').get().c),
    alerts: Number(db.prepare('SELECT COUNT(*) AS c FROM alerts').get().c),
    outages: Number(db.prepare('SELECT COUNT(*) AS c FROM outages').get().c),
  }));

  const backup = runScript('db-backup.mjs', ['--no-mbtiles']);
  assert.equal(backup.ok, true, 'پشتیبان باید ساخته و اعتبارسنجی شود');
  assert.equal(backup.counts.devices, before.devices);
  assert.equal(backup.counts.samples, before.samples);
  backupCounts = backup.counts;
  backupName = backup.dir;

  // پشتیبان باید قابل‌اعتماد و خصوصی باشد: manifest + checksum + مجوز 600.
  assert.ok(fs.existsSync(path.join(backup.dir, 'manifest.json')), 'manifest پشتیبان ساخته شود');
  const backupFiles = ['netwatch.db', 'manifest.json'];
  for (const file of backupFiles) {
    const mode = fs.statSync(path.join(backup.dir, file)).mode & 0o777;
    assert.equal(mode & 0o077, 0, `${file} در پشتیبان نباید برای گروه/دیگران خواندنی باشد`);
  }

  const retention = runScript('db-retention.mjs', ['--dry-run']);
  assert.equal(retention.ok, true, 'اجرای Retention باید موفق باشد');
  assert.equal(retention.result.dryRun, true, 'اجرای آزمایشی باید dryRun باشد');
  assert.ok(retention.result.deletedRows >= 0);

  const after = readDb((db) => ({
    devices: Number(db.prepare('SELECT COUNT(*) AS c FROM devices').get().c),
    samples: Number(db.prepare('SELECT COUNT(*) AS c FROM samples').get().c),
    alerts: Number(db.prepare('SELECT COUNT(*) AS c FROM alerts').get().c),
    outages: Number(db.prepare('SELECT COUNT(*) AS c FROM outages').get().c),
  }));
  assert.deepEqual(after, before, 'Retention آزمایشی نباید هیچ ردیفی حذف کند');
});

test('service stops cleanly, restores from the verified backup and keeps consistent data', async () => {
  const expected = readDb((db) => ({
    devices: Number(db.prepare('SELECT COUNT(*) AS c FROM devices').get().c),
    alerts: Number(db.prepare('SELECT COUNT(*) AS c FROM alerts').get().c),
    outages: Number(db.prepare('SELECT COUNT(*) AS c FROM outages').get().c),
    users: Number(db.prepare('SELECT COUNT(*) AS c FROM users').get().c),
    schema: Number(db.prepare('PRAGMA user_version').get().user_version),
  }));

  const code = await srv.stop();
  assert.equal(code, 0, 'SIGTERM باید با کد ۰ تمام شود');

  const verify = runScript('db-restore.mjs', [backupName, '--dry-run', '--no-mbtiles']);
  assert.equal(verify.ok, true);
  assert.equal(verify.counts.devices, expected.devices);

  const restore = runScript('db-restore.mjs', [backupName, '--no-mbtiles']);
  assert.equal(restore.ok, true, 'بازیابی از پشتیبان معتبر باید موفق باشد');
  assert.ok(backupCounts.devices === expected.devices);

  // راه‌اندازی مجدد سرویس روی همان داده (سناریوی Restart)
  srv = await startServer({ dataDir: dir, engine: false });
  const health = await api(srv.base, 'GET', '/api/system/db/health');
  assert.equal(health.data.ok, true);

  const after = readDb((db) => ({
    devices: Number(db.prepare('SELECT COUNT(*) AS c FROM devices').get().c),
    alerts: Number(db.prepare('SELECT COUNT(*) AS c FROM alerts').get().c),
    outages: Number(db.prepare('SELECT COUNT(*) AS c FROM outages').get().c),
    users: Number(db.prepare('SELECT COUNT(*) AS c FROM users').get().c),
    schema: Number(db.prepare('PRAGMA user_version').get().user_version),
  }));
  assert.deepEqual(after, expected, 'داده پس از Restore و Restart باید یکسان بماند');
  assert.equal(after.schema, expected.schema);

  // ورود مجدد و صحت دادهٔ کسب‌وکار از مسیر API
  const device = await api(srv.base, 'GET', `/api/devices/${deviceId}`);
  assert.equal(device.status, 200);
  assert.equal(device.data.name, 'Release-Core-SW');
  const outages = await api(srv.base, 'GET', `/api/devices/${deviceId}/outages`);
  assert.ok(outages.data.items.length >= 1, 'تاریخچهٔ قطعی باید پس از Restart باقی بماند');
  const users = await api(srv.base, 'GET', '/api/auth/users');
  assert.deepEqual(
    users.data.items.map((u) => u.username).sort(),
    ['admin', 'ops-release', 'view-release']
  );

  const fetched = await waitFor(async () => {
    const res = await api(srv.base, 'GET', '/api/engine/status');
    return res.status === 200 ? res : null;
  });
  assert.ok(fetched, 'موتور پس از Restart باید وضعیت خود را گزارش کند');
});
