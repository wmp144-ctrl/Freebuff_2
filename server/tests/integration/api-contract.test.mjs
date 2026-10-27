/**
 * قرارداد Backend ↔ Frontend
 * ----------------------------------------------------------------
 * تایپ‌های `web/src/lib/types.ts` فقط در زمان کامپایل بررسی می‌شوند؛ اگر سرور
 * فیلدی را تغییر نام دهد یا حذف کند، TypeScript هیچ خطایی نمی‌دهد و صفحه در
 * زمان اجرا خالی یا «undefined» نشان می‌دهد. این آزمون همان فیلدهایی را
 * می‌سنجد که رابط کاربری واقعاً می‌خواند و برای هر پاسخ، شکل پوشش (envelope)
 * را هم بررسی می‌کند.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, api, cleanupDir, startServer, useTempDataDir } from '../helpers.mjs';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const dir = useTempDataDir('api-contract');
let srv;
let deviceId;

function ok(res, label) {
  assert.equal(res.status, 200, `${label} → ${res.status}: ${JSON.stringify(res.data)?.slice(0, 300)}`);
  return res.data;
}

/** بررسی وجود کلیدها (حتی با مقدار null/۰) */
function hasFields(obj, label, fields) {
  assert.ok(obj && typeof obj === 'object', `${label}: پاسخ شیء نیست`);
  const missing = fields.filter((f) => !Object.prototype.hasOwnProperty.call(obj, f));
  assert.deepEqual(missing, [], `${label}: فیلدهای ناموجود ${missing.join(', ')}`);
}

before(async () => {
  srv = await startServer({ dataDir: dir, engine: false });
  const created = await api(srv.base, 'POST', '/api/devices', {
    name: 'contract-device',
    ip: '10.210.0.1',
    location: 'اتاق سرور',
    deviceType: 'switch',
  });
  assert.equal(created.status, 201);
  deviceId = created.data.id;
});

after(async () => {
  await srv.stop();
  cleanupDir(dir);
});

test('public health paths stay JSON while the app health page is served as HTML', async () => {
  // `/health` و `/api/health` نقاط پایانی پایش هستند و نباید با صفحهٔ SPA قاطی شوند؛
  // صفحهٔ سلامت برنامه روی `/app-health` است و بارگذاری مستقیم آن HTML می‌دهد.
  for (const url of ['/health', '/api/health']) {
    const res = await fetch(srv.base + url);
    assert.equal(res.status, 200, `${url} باید ۲۰۰ بدهد`);
    assert.match(res.headers.get('content-type') || '', /application\/json/, `${url} باید JSON باشد`);
    const body = await res.json();
    assert.equal(typeof body.ok, 'boolean');
    assert.equal(Object.keys(body).sort().join(','), 'ok,status,ts', 'پاسخ عمومی حداقلی است');
  }
  const built = fs.existsSync(path.join(ROOT, 'web', 'dist', 'index.html'));
  const page = await fetch(srv.base + '/app-health');
  assert.match(page.headers.get('content-type') || '', /text\/html/, '/app-health هرگز نباید JSON باشد');
  const html = await page.text();
  if (built) {
    assert.equal(page.status, 200, 'بارگذاری مستقیم /app-health باید ۲۰۰ بدهد');
    assert.match(html, /<div id="root"/, 'بدنهٔ HTML ریشهٔ اپلیکیشن را دارد');
  } else {
    // بدون Build، سرور پیام روشن «ابتدا npm run build» می‌دهد (نه JSON).
    assert.equal(page.status, 503);
    assert.match(html, /npm run build/);
  }
});

test('device object matches the Device type used by the UI', async () => {
  const d = ok(await api(srv.base, 'GET', `/api/devices/${deviceId}`), 'device');
  hasFields(d, 'device', [
    'id',
    'name',
    'ip',
    'hostname',
    'deviceType',
    'groupId',
    'groupName',
    'groupColor',
    'location',
    'building',
    'rack',
    'latitude',
    'longitude',
    'mapLayerId',
    'vendor',
    'model',
    'serial',
    'firmware',
    'owner',
    'notes',
    'priority',
    'enabled',
    'monitoringEnabled',
    'pingInterval',
    'timeoutMs',
    'packetCount',
    'retries',
    'latencyThreshold',
    'lossThreshold',
    'status',
    'statusReason',
    'lastCheckAt',
    'lastStatusChangeAt',
    'lastRtt',
    'minRtt',
    'maxRtt',
    'avgRtt',
    'lossPct',
    'successCount',
    'failCount',
    'totalChecks',
    'consecutiveFailures',
    'consecutiveSuccesses',
    'uptimePct',
    'lastOutageAt',
    'currentOutageId',
    'currentOutageStartedAt',
    'lastRecoveryAt',
    'createdAt',
    'updatedAt',
    'tags',
    'effective',
    'stats',
  ]);
  assert.equal(typeof d.enabled, 'boolean', 'enabled باید boolean باشد');
  assert.equal(typeof d.monitoringEnabled, 'boolean', 'monitoringEnabled باید boolean باشد');
  assert.ok(Array.isArray(d.tags), 'tags باید آرایه باشد');
  hasFields(d.effective, 'device.effective', ['pingInterval', 'timeoutMs', 'packetCount', 'retries', 'latencyThreshold', 'lossThreshold']);
  hasFields(d.stats, 'device.stats', ['outages', 'openOutage', 'packets']);
});

test('paged device list exposes the pagination envelope the UI pages through', async () => {
  const list = ok(await api(srv.base, 'GET', '/api/devices?page=1&pageSize=12'), 'devices');
  hasFields(list, 'devices', ['items', 'total', 'page', 'pageSize', 'pages']);
  assert.ok(Array.isArray(list.items) && list.items.length >= 1);
  assert.equal(typeof list.total, 'number');
});

test('dashboard summary carries every block the dashboard renders', async () => {
  const s = ok(await api(srv.base, 'GET', '/api/dashboard/summary'), 'dashboard');
  hasFields(s, 'dashboard', [
    'kpis',
    'health',
    'statusDistribution',
    'offlineTrend',
    'outagesPerDay',
    'topLatency',
    'topDowntime',
    'groupStatus',
    'healthTrend',
    'avgRttTrend',
    'recentAlerts',
    'degraded',
    'lastStatusChangeAt',
    'engine',
    'settings',
    'generatedAt',
  ]);
  hasFields(s.kpis, 'dashboard.kpis', [
    'total',
    'active',
    'up',
    'down',
    'inactive',
    'online',
    'offline',
    'warning',
    'unknown',
    'maintenance',
    'disabled',
    'monitoring',
    'openOutages',
  ]);
  hasFields(s.health, 'dashboard.health', ['score', 'grade', 'availability', 'avgRtt', 'lossAvg', 'checks24h', 'alertsActive', 'alertCounts']);
  hasFields(s.health.grade, 'dashboard.health.grade', ['label', 'tone']);
  hasFields(s.settings, 'dashboard.settings', ['siteName', 'latencyThreshold', 'lossThreshold', 'chartRange', 'engineMode', 'calendar']);
  hasFields(s.engine, 'dashboard.engine', ['running', 'mode', 'interval', 'maxWorkers', 'inflight', 'cycles', 'checksRun', 'errors', 'skipped']);
});

test('status separates application health from network health', async () => {
  const st = ok(await api(srv.base, 'GET', '/api/status'), 'status');
  hasFields(st, 'status', ['server', 'engine', 'devices', 'app', 'generatedAt']);
  hasFields(st.server, 'status.server', ['ok', 'ts', 'uptime']);
  hasFields(st.devices, 'status.devices', ['total', 'up', 'down', 'inactive', 'monitoring']);
  hasFields(st.engine, 'status.engine', ['running', 'mode', 'stale', 'staleMs']);
  hasFields(st.app, 'status.app', ['db', 'sse', 'backup', 'disk', 'probe', 'jobs', 'generatedAt']);
  hasFields(st.app.db, 'status.app.db', ['ok', 'sizeBytes']);
  hasFields(st.app.sse, 'status.app.sse', ['clients', 'peak', 'skippedFrames', 'deliveredFrames', 'droppedClients']);
  hasFields(st.app.disk, 'status.app.disk', ['freeBytes', 'minFreeBytes', 'ok']);
  hasFields(st.app.jobs, 'status.app.jobs', ['queued', 'running', 'rejected']);
});

test('settings endpoint returns the envelope the settings page destructures', async () => {
  const s = ok(await api(srv.base, 'GET', '/api/settings'), 'settings');
  hasFields(s, 'settings', ['settings', 'engine', 'icmpAvailable', 'sampleCount']);
  hasFields(s.settings, 'settings.settings', [
    'site_name',
    'engine_enabled',
    'engine_mode',
    'ping_interval',
    'timeout_ms',
    'retries',
    'packet_count',
    'retention_enabled',
    'retention_run_time',
    'samples_retention_days',
    'audit_retention_days',
    'retention_legal_hold',
    'backup_enabled',
    'backup_interval_hours',
    'backup_keep',
    'chart_default_range',
    'calendar',
    'dashboard_widgets',
    'device_detail_widgets',
  ]);
  assert.ok(Array.isArray(s.settings.dashboard_widgets), 'dashboard_widgets باید آرایه باشد');
});

test('retention status and backup status expose admin panel fields', async () => {
  const retention = ok(await api(srv.base, 'GET', '/api/system/retention'), 'retention');
  hasFields(retention, 'retention', ['owner', 'running', 'stopRequested', 'policy', 'lock', 'lastRun', 'runs', 'nextRunAt', 'lastStatus', 'lastDeletedRows', 'lastFreedBytes', 'storage']);
  hasFields(retention.lock, 'retention.lock', ['owner', 'expiresAt', 'heldByThisProcess']);
  hasFields(retention.storage, 'retention.storage', ['pageSize', 'pages', 'freePages', 'dbBytes', 'freeBytes', 'walBytes']);

  const backups = ok(await api(srv.base, 'GET', '/api/system/backups'), 'backups');
  hasFields(backups, 'backups', ['dir', 'items', 'status']);
  hasFields(backups.status, 'backups.status', ['appVersion', 'schemaVersion', 'count', 'lastBackupAt', 'latest', 'running', 'restoring', 'restore', 'policy', 'freeBytes']);

  const health = ok(await api(srv.base, 'GET', '/api/system/health'), 'system health');
  hasFields(health, 'system.health', ['ok', 'status', 'uptime', 'version', 'devices', 'db', 'tls', 'engine', 'sse', 'jobs', 'ts']);
  // نسخهٔ گزارش‌شده باید همان نسخهٔ package.json باشد، حتی وقتی سرویس مستقیم با
  // `node server/index.js` (systemd) اجرا شده است و npm_package_version ست نشده.
  assert.equal(health.version, pkg.version, 'نسخهٔ گزارش‌شده با package.json یکسان است');
});

test('reports and alerts payloads match their UI types', async () => {
  const report = ok(await api(srv.base, 'GET', '/api/reports/summary?range=7d'), 'report');
  hasFields(report, 'report', ['range', 'totals', 'items', 'days', 'dailyOutages', 'causes', 'actions']);
  hasFields(report.range, 'report.range', ['from', 'to', 'days']);
  hasFields(report.totals, 'report.totals', ['devices', 'checks', 'failed', 'outages', 'downtimeSec', 'alerts', 'availability', 'avgRtt', 'maxRtt', 'mttrSec']);
  if (report.items.length) {
    hasFields(report.items[0], 'report.items[0]', [
      'id',
      'name',
      'ip',
      'deviceType',
      'status',
      'priority',
      'checks',
      'okCount',
      'failed',
      'availability',
      'outages',
      'downtimeSec',
      'mttrSec',
      'mtbfSec',
      'alerts',
    ]);
  }

  const alerts = ok(await api(srv.base, 'GET', '/api/alerts'), 'alerts');
  hasFields(alerts, 'alerts', ['items', 'total', 'page', 'pageSize', 'pages', 'stats']);
  hasFields(alerts.stats, 'alerts.stats', ['active', 'acknowledged', 'resolved', 'suppressed', 'bySeverity']);
});

test('device detail sub-resources keep their documented shapes', async () => {
  const series = ok(await api(srv.base, 'GET', `/api/devices/${deviceId}/series?range=1h`), 'series');
  hasFields(series, 'series', ['range', 'bucketMs', 'bucketLabel', 'from', 'to', 'points']);

  // پنجرهٔ دلخواه نمای ماهانه/هفتگی/روزانه/ساعتی؛ rangeهای قدیمی همیشه به
  // «اکنون» ختم می‌شدند و امکان رفتن به ماه قبل را نمی‌دادند.
  const now = Date.now();
  const from = now - 3_600_000;
  const custom = ok(await api(srv.base, 'GET', `/api/devices/${deviceId}/series?from=${from}&to=${now}&bucket=300000`), 'series window');
  hasFields(custom, 'series.window', ['range', 'span', 'bucketMs', 'bucketLabel', 'from', 'to', 'points']);
  assert.equal(custom.range, 'custom');
  assert.equal(custom.from, from);
  assert.equal(custom.to, now);
  assert.equal(custom.bucketMs, 300_000);

  const invalidWindow = await api(srv.base, 'GET', `/api/devices/${deviceId}/series?from=${now}&to=${now - 1000}&bucket=60000`);
  assert.equal(invalidWindow.status, 400, 'بازهٔ معکوس باید ۴۰۰ بدهد');
  const oversizedWindow = await api(
    srv.base,
    'GET',
    `/api/devices/${deviceId}/series?from=${now - 400 * 86400000}&to=${now}&bucket=60000`
  );
  assert.equal(oversizedWindow.status, 400, 'بازهٔ بیش از یک سال باید ۴۰۰ بدهد');

  const outages = ok(await api(srv.base, 'GET', `/api/devices/${deviceId}/outages?limit=5`), 'outages');
  hasFields(outages, 'outages', ['total', 'open', 'items']);
  const windowedOutages = ok(
    await api(srv.base, 'GET', `/api/devices/${deviceId}/outages?from=${now - 86400000}&to=${now}&limit=5`),
    'outages window'
  );
  hasFields(windowedOutages, 'outages.window', ['total', 'from', 'to', 'open', 'items']);
  assert.equal(windowedOutages.from, now - 86400000);
  assert.equal(windowedOutages.to, now);

  const availability = ok(await api(srv.base, 'GET', `/api/devices/${deviceId}/availability?range=24h`), 'availability');
  hasFields(availability, 'availability', ['range', 'bucketLabel', 'overall', 'checks', 'failed', 'worstBucket', 'buckets']);

  const health = ok(await api(srv.base, 'GET', `/api/devices/${deviceId}/health`), 'device health');
  hasFields(health, 'device.health', ['deviceId', 'daily', 'mtbfSec', 'mttrSec', 'maintenance']);

  const meta = ok(await api(srv.base, 'GET', '/api/devices/meta'), 'device meta');
  hasFields(meta, 'device.meta', ['groups', 'tags', 'types', 'locations', 'vendors', 'priorities', 'layers', 'settings', 'highLatency']);
});
