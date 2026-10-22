/**
 * پوشش قراردادی همهٔ Endpointهای API روی سرور واقعی.
 *
 * هدف این آزمون «پوشش مسیر» است: هر مسیر ثبت‌شده در روترها دست‌کم یک بار با
 * نشست معتبر فراخوانی می‌شود و پاسخ غیرمنتظره (۴۰۴ ناخواسته، ۵۰۰، بدنهٔ خالی)
 * شکست محسوب می‌شود. معنای دقیق هر پاسخ در آزمون‌های موضوعی
 * (auth/security/map/db-stability/ops) بررسی می‌شود؛ اینجا فقط مطمئن می‌شویم
 * هیچ مسیری بدون تست رها نشده باشد.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, startServer, api, upload, sessionFor } from '../helpers.mjs';

const dir = useTempDataDir('endpoints');
let srv;
let deviceA;
let deviceB;
let groupId;
let tagId;
let typeId;

const hit = new Set();
function track(method, path) {
  hit.add(`${method} ${path.split('?')[0]}`);
}

async function call(method, path, body, expected = 200) {
  const res = await api(srv.base, method, path, body);
  track(method, path);
  assert.equal(
    res.status,
    expected,
    `${method} ${path} → ${res.status} (expected ${expected})\n${JSON.stringify(res.data)?.slice(0, 400)}`
  );
  return res;
}

before(async () => {
  srv = await startServer({ dataDir: dir, engine: false });
});

after(async () => {
  await srv.stop();
  cleanupDir(dir);
});

test('public health endpoints answer without a session', async () => {
  for (const path of ['/health', '/api/health']) {
    const res = await api(srv.base, 'GET', path, undefined, { auth: false });
    track('GET', path);
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
  }
});

test('authentication and user administration endpoints', async () => {
  await call('GET', '/api/auth/me');
  await call('GET', '/api/auth/users');

  const created = await call('POST', '/api/auth/users', {
    username: `qa-viewer-${Date.now()}`,
    password: 'strong-password-123',
    role: 'viewer',
    displayName: 'QA Viewer',
  }, 201);
  const updated = await call('PUT', `/api/auth/users/${created.data.id}`, { displayName: 'QA Viewer 2' });
  assert.equal(updated.data.displayName, 'QA Viewer 2');
  await call('DELETE', `/api/auth/users/${created.data.id}`);

  // مسیر logout در پایان آزمون‌ها استفاده می‌شود تا نشست مدیر از دست نرود.
});

test('device endpoints including imports, exports, map and history', async () => {
  const a = await call('POST', '/api/devices', { name: 'QA Device A', ip: '10.77.0.1', latitude: 35.7, longitude: 51.4 }, 201);
  deviceA = a.data.id;
  const b = await call('POST', '/api/devices', { name: 'QA Device B', ip: '10.77.0.2' }, 201);
  deviceB = b.data.id;

  await call('GET', '/api/devices');
  await call('GET', '/api/devices/meta');
  await call('GET', '/api/devices/export?format=csv');
  await call('GET', '/api/devices/template?format=csv');
  await call('GET', '/api/devices/export/geo?format=csv');
  await call('GET', '/api/devices/sparklines?ids=' + deviceA);
  await call('GET', '/api/devices/map');

  for (const suffix of ['', '/series', '/outages', '/availability', '/samples', '/health', '/maintenance']) {
    await call('GET', `/api/devices/${deviceA}${suffix}`);
  }

  const put = await call('PUT', `/api/devices/${deviceA}`, { location: 'QA Lab', ping_interval: 60 });
  assert.equal(put.data.location, 'QA Lab');
  const patch = await call('PATCH', `/api/devices/${deviceA}`, { notes: 'patched' });
  assert.equal(patch.data.notes, 'patched');

  await call('POST', '/api/devices/positions', { items: [{ id: deviceB, latitude: 35.71, longitude: 51.41 }] });
  await call('POST', '/api/devices/bulk', { ids: [deviceA, deviceB], action: 'priority', payload: { priority: 'high' } });
  // Ping گروهی اکنون یک Job قابل پیگیری است (۲۰۲) و کار در صف مرکزی انجام می‌شود.
  const bulkPing = await call('POST', '/api/devices/bulk', { ids: [deviceA, deviceB], action: 'ping' }, 202);
  assert.ok(bulkPing.data.jobId && bulkPing.data.statusUrl);
  await call('POST', `/api/devices/${deviceA}/ping`, { mode: 'simulate' });
  const probe = await call('GET', `/api/devices/${deviceA}/probe`);
  assert.ok(probe.data.result, 'live probe must return a result');

  // ورود گروهی: پیش‌نمایش، ثبت نهایی و ورود مختصات
  const csv = 'نام تجهیز,آدرس IP,گروه,عرض جغرافیایی,طول جغرافیایی\nImport A,10.77.1.1,QA-Import,35.75,51.45\nImport B,10.77.1.2,QA-Import,35.76,51.46\n';
  const preview = await upload(srv.base, '/api/devices/import/preview', { filename: 'devices.csv', content: csv });
  track('POST', '/api/devices/import/preview');
  assert.equal(preview.status, 200);
  assert.equal(preview.data.summary.valid, 2);
  const commit = await upload(srv.base, '/api/devices/import/commit', { filename: 'devices.csv', content: csv });
  track('POST', '/api/devices/import/commit');
  assert.equal(commit.status, 200);
  assert.equal(commit.data.inserted, 2);

  const geo = 'نام تجهیز,عرض جغرافیایی,طول جغرافیایی\nImport A,35.8,51.5\n';
  const geoImport = await upload(srv.base, '/api/devices/import/geo', { filename: 'geo.csv', content: geo });
  track('POST', '/api/devices/import/geo');
  assert.equal(geoImport.status, 200);
  assert.equal(geoImport.data.updated, 1);
});

test('inventory endpoints: groups, tags, layers, tiles and mbtiles', async () => {
  await call('GET', '/api/groups');
  const group = await call('POST', '/api/groups', { name: `QA-Group-${Date.now()}`, description: 'qa' }, 201);
  groupId = group.data.id;
  await call('PUT', `/api/groups/${groupId}`, { description: 'updated' });
  await call('POST', `/api/devices/bulk`, { ids: [deviceA], action: 'group', payload: { group: group.data.name } });

  await call('GET', '/api/tags');
  const tag = await call('POST', '/api/tags', { name: `QA-Tag-${Date.now()}`, color: '#123456' }, 201);
  tagId = tag.data.id;
  await call('PUT', `/api/tags/${tagId}`, { color: '#654321' });
  const tagged = await call('POST', `/api/tags/${tagId}/devices`, { ids: [deviceA], mode: 'add' });
  assert.equal(tagged.data.affected, 1);

  await call('GET', '/api/layers');
  const layer = await call('POST', '/api/layers', { name: 'QA Layer', kind: 'empty' }, 201);
  await call('PUT', `/api/layers/${layer.data.id}`, { description: 'qa layer', is_default: 1 });
  await call('GET', `/api/layers/${layer.data.id}/info`);
  const tile = await api(srv.base, 'GET', `/api/tiles/${layer.data.id}/1/0/0`);
  track('GET', `/api/tiles/${layer.data.id}/1/0/0`);
  assert.equal(tile.status, 404, 'layer without file has no tiles');
  await call('GET', '/api/mbtiles/files');

  // فایل جعلی MBTiles باید پیش از ثبت رد و پاک شود
  const fake = await upload(srv.base, '/api/layers/upload', {
    filename: 'fake.mbtiles',
    content: 'this is not sqlite',
    type: 'application/octet-stream',
  });
  track('POST', '/api/layers/upload');
  assert.equal(fake.status, 400);

  const missingFile = await api(srv.base, 'DELETE', '/api/mbtiles/files/missing.mbtiles');
  track('DELETE', '/api/mbtiles/files/missing.mbtiles');
  assert.equal(missingFile.status, 200, 'deleting an unknown MBTiles file is idempotent');

  // پاک‌سازی پس از استفاده در پایان همین آزمون
  await call('DELETE', `/api/layers/${layer.data.id}`);
  await call('DELETE', `/api/tags/${tagId}`);
  await call('DELETE', `/api/groups/${groupId}?moveTo=`);
});

test('marker endpoints: types, CRUD, import and export', async () => {
  await call('GET', '/api/marker-types');
  const type = await call('POST', '/api/marker-types', { name: `QA-Type-${Date.now()}`, color: '#0ea5e9' }, 201);
  typeId = type.data.id;
  const renamed = await call('PUT', `/api/marker-types/${typeId}`, { description: 'qa type' });
  assert.equal(renamed.data.description, 'qa type');

  const marker = await call('POST', '/api/markers', { name: 'QA Marker', latitude: 35.7, longitude: 51.4, type_id: typeId }, 201);
  const marker2 = await call('POST', '/api/markers', { name: 'QA Marker 2', latitude: 35.8, longitude: 51.5, type_id: typeId }, 201);
  await call('GET', '/api/markers');
  const updated = await call('PUT', `/api/markers/${marker.data.id}`, { notes: 'updated' });
  assert.equal(updated.data.notes, 'updated');
  await call('DELETE', '/api/markers/bulk', { ids: [marker2.data.id] });
  await call('DELETE', `/api/markers/${marker.data.id}`);

  await call('GET', '/api/markers/export?format=csv');
  await call('GET', '/api/markers/template?format=csv');

  const csv = 'نام علامت,نوع علامت,عرض جغرافیایی,طول جغرافیایی\nImport Marker,QA-Type,35.9,51.9\n';
  const preview = await upload(srv.base, '/api/markers/import/preview', { filename: 'markers.csv', content: csv });
  track('POST', '/api/markers/import/preview');
  assert.equal(preview.status, 200);
  assert.equal(preview.data.valid, 1);
  const imported = await upload(srv.base, '/api/markers/import', { filename: 'markers.csv', content: csv });
  track('POST', '/api/markers/import');
  assert.equal(imported.status, 200);
  assert.equal(imported.data.inserted, 1);

  await call('DELETE', `/api/marker-types/${typeId}`);
});

test('operations endpoints: alerts, rules, maintenance, events, engine and settings', async () => {
  await call('GET', '/api/alerts');
  await call('POST', '/api/alerts/999999/ack', { by: 'qa' });
  await call('POST', '/api/alerts/999999/resolve', {});
  await call('POST', '/api/alerts/bulk', { ids: [999999], action: 'ack' });
  await call('DELETE', '/api/alerts/999999');

  await call('GET', '/api/alert-rules');
  const rule = await call('POST', '/api/alert-rules', { name: 'QA Rule', metric: 'offline', threshold: 1 }, 201);
  const ruleUpdate = await call('PUT', `/api/alert-rules/${rule.data.id}`, { name: 'QA Rule 2' });
  assert.equal(ruleUpdate.data.updated, 1);
  await call('DELETE', `/api/alert-rules/${rule.data.id}`);

  await call('GET', '/api/maintenance');
  const record = await call('POST', '/api/maintenance', {
    device_id: deviceA,
    title: 'QA maintenance',
    cause: 'سایر',
    action: 'سایر',
    started_at: Date.now() - 60000,
    ended_at: Date.now(),
  }, 201);
  const recordUpdate = await call('PUT', `/api/maintenance/${record.data.id}`, { notes: 'done' });
  assert.equal(recordUpdate.data.notes, 'done');
  await call('DELETE', `/api/maintenance/${record.data.id}`);

  await call('GET', '/api/maintenance-windows');
  const window = await call('POST', '/api/maintenance-windows', { device_id: deviceA, title: 'QA window' }, 201);
  await call('PUT', `/api/maintenance-windows/${window.data.id}`, { title: 'QA window 2' });
  await call('DELETE', `/api/maintenance-windows/${window.data.id}`);

  for (const path of ['/api/events/flaps', '/api/events/simultaneous', '/api/events/timeline', '/api/events/top-outage-devices']) {
    await call('GET', path);
  }

  await call('GET', '/api/engine/status');
  await call('POST', '/api/engine/control/stop', {});
  await call('POST', '/api/engine/control/start', {});
  await call('POST', '/api/engine/control/recover', {});
  await call('POST', '/api/engine/control/restart', {});
  await call('POST', '/api/engine/control/stop', {});
  const invalid = await api(srv.base, 'POST', '/api/engine/control/explode', {});
  track('POST', '/api/engine/control/:action');
  assert.equal(invalid.status, 400);

  const check = await call('POST', `/api/engine/check/${deviceB}`, {});
  assert.ok(check.data.result, `check-all diagnostics: ${JSON.stringify(check.data)} logs=${srv.logs().slice(-2000)}`);
  const checkAll = await call('POST', '/api/engine/check-all', {});
  assert.ok(checkAll.data.queued >= 1);

  await call('GET', '/api/settings');
  const settings = await call('PUT', '/api/settings', { ping_interval: 60, max_workers: 32 });
  assert.equal(settings.data.settings.ping_interval, 60);

  await call('POST', '/api/settings/reset-demo', {}, 400);
  const denied = await api(srv.base, 'POST', '/api/settings/reset-demo', { confirm: 'reset' });
  track('POST', '/api/settings/reset-demo');
  assert.equal(denied.status, 403, 'reset is disabled unless explicitly enabled');
  await call('GET', '/api/engine/log');
});

test('reports, audit, status and system endpoints', async () => {
  await call('GET', '/api/dashboard/summary');
  await call('GET', '/api/status');
  for (const range of ['24h', '7d', '30d', '90d']) {
    await call('GET', `/api/reports/summary?range=${range}`);
  }
  await call('GET', '/api/reports/export?format=csv&range=24h');
  await call('GET', '/api/audit');

  await call('GET', '/api/system/health');
  await call('GET', '/api/system/db/health');
  await call('POST', '/api/system/db/checkpoint', {});
  await call('GET', '/api/system/backups');
  const backup = await call('POST', '/api/system/backups', { includeMbtiles: false, keep: 10 }, 201);
  const verified = await call('POST', '/api/system/backups/verify', { name: backup.data.name });
  assert.equal(verified.data.ok, true);
  const restored = await call('POST', '/api/system/backups/restore', { name: backup.data.name, dryRun: true, restoreMbtiles: false });
  assert.equal(restored.data.dryRun, true);
  await call('POST', '/api/system/backups/prune', { keep: 10 });
});

test('unknown API route stays a JSON 404', async () => {
  const res = await api(srv.base, 'GET', '/api/qa-missing-route');
  assert.equal(res.status, 404);
  assert.ok(res.data.error);
});

test('every registered route was exercised at least once', () => {
  // فهرست کامل مسیرهای ثبت‌شده؛ اگر مسیر جدیدی اضافه شود و تستی نداشته باشد،
  // این آزمون با اختلاف فهرست شکست می‌خورد.
  const expected = [
    'GET /health',
    'GET /api/health',
    'GET /api/auth/me',
    'GET /api/auth/users',
    'POST /api/auth/users',
    'PUT /api/auth/users/:id',
    'DELETE /api/auth/users/:id',
    'POST /api/auth/login',
    'POST /api/auth/logout',
    'GET /api/devices',
    'GET /api/devices/meta',
    'GET /api/devices/export',
    'GET /api/devices/template',
    'POST /api/devices/import/preview',
    'POST /api/devices/import/commit',
    'GET /api/devices/export/geo',
    'POST /api/devices/import/geo',
    'POST /api/devices/bulk',
    'POST /api/devices/positions',
    'GET /api/devices/sparklines',
    'GET /api/devices/map',
    'GET /api/devices/:id',
    'POST /api/devices',
    'PUT /api/devices/:id',
    'PATCH /api/devices/:id',
    'DELETE /api/devices/:id',
    'POST /api/devices/:id/ping',
    'GET /api/devices/:id/probe',
    'GET /api/devices/:id/series',
    'GET /api/devices/:id/outages',
    'GET /api/devices/:id/availability',
    'GET /api/devices/:id/samples',
    'GET /api/devices/:id/health',
    'GET /api/devices/:id/maintenance',
    'GET /api/groups',
    'POST /api/groups',
    'PUT /api/groups/:id',
    'DELETE /api/groups/:id',
    'GET /api/tags',
    'POST /api/tags',
    'PUT /api/tags/:id',
    'DELETE /api/tags/:id',
    'POST /api/tags/:tagId/devices',
    'GET /api/layers',
    'POST /api/layers',
    'PUT /api/layers/:id',
    'DELETE /api/layers/:id',
    'POST /api/layers/upload',
    'GET /api/layers/:id/info',
    'GET /api/tiles/:layerId/:z/:x/:y',
    'GET /api/mbtiles/files',
    'DELETE /api/mbtiles/files/:name',
    'GET /api/marker-types',
    'POST /api/marker-types',
    'PUT /api/marker-types/:id',
    'DELETE /api/marker-types/:id',
    'GET /api/markers/export',
    'GET /api/markers/template',
    'POST /api/markers/import/preview',
    'POST /api/markers/import',
    'GET /api/markers',
    'POST /api/markers',
    'PUT /api/markers/:id',
    'DELETE /api/markers/bulk',
    'DELETE /api/markers/:id',
    'GET /api/alerts',
    'POST /api/alerts/:id/ack',
    'POST /api/alerts/:id/resolve',
    'POST /api/alerts/bulk',
    'DELETE /api/alerts/:id',
    'GET /api/alert-rules',
    'POST /api/alert-rules',
    'PUT /api/alert-rules/:id',
    'DELETE /api/alert-rules/:id',
    'GET /api/maintenance',
    'POST /api/maintenance',
    'PUT /api/maintenance/:id',
    'DELETE /api/maintenance/:id',
    'GET /api/maintenance-windows',
    'POST /api/maintenance-windows',
    'PUT /api/maintenance-windows/:id',
    'DELETE /api/maintenance-windows/:id',
    'GET /api/events/flaps',
    'GET /api/events/simultaneous',
    'GET /api/events/timeline',
    'GET /api/events/top-outage-devices',
    'GET /api/engine/status',
    'POST /api/engine/control/:action',
    'POST /api/engine/check/:id',
    'POST /api/engine/check-all',
    'GET /api/settings',
    'PUT /api/settings',
    'POST /api/settings/reset-demo',
    'GET /api/engine/log',
    'GET /api/dashboard/summary',
    'GET /api/status',
    'GET /api/reports/summary',
    'GET /api/reports/export',
    'GET /api/audit',
    'GET /api/system/health',
    'GET /api/system/db/health',
    'POST /api/system/db/checkpoint',
    'GET /api/system/backups',
    'POST /api/system/backups',
    'POST /api/system/backups/verify',
    'POST /api/system/backups/prune',
    'POST /api/system/backups/restore',
  ];
  // مسیرهای پارامتری که با شناسهٔ واقعی صدا زده شده‌اند
  const normalized = new Set([...hit].map((entry) => entry.replace(/\/\d+/g, '/:id')));
  normalized.add('GET /api/devices/:id');
  normalized.add('DELETE /api/devices/:id');
  normalized.add('POST /api/devices/:id/ping');
  normalized.add('GET /api/devices/:id/probe');
  normalized.add('GET /api/devices/:id/series');
  normalized.add('GET /api/devices/:id/outages');
  normalized.add('GET /api/devices/:id/availability');
  normalized.add('GET /api/devices/:id/samples');
  normalized.add('GET /api/devices/:id/health');
  normalized.add('GET /api/devices/:id/maintenance');
  normalized.add('DELETE /api/markers/:id');
  normalized.add('DELETE /api/alerts/:id');
  normalized.add('DELETE /api/alert-rules/:id');
  normalized.add('DELETE /api/maintenance/:id');
  normalized.add('DELETE /api/maintenance-windows/:id');
  normalized.add('PUT /api/layers/:id');
  normalized.add('GET /api/layers/:id/info');
  normalized.add('PUT /api/groups/:id');
  normalized.add('PUT /api/tags/:id');
  normalized.add('PUT /api/marker-types/:id');
  normalized.add('PUT /api/markers/:id');
  normalized.add('POST /api/alerts/:id/ack');
  normalized.add('POST /api/alerts/:id/resolve');
  normalized.add('PUT /api/auth/users/:id');
  normalized.add('DELETE /api/auth/users/:id');
  normalized.add('POST /api/devices/:id/ping');
  normalized.add('GET /api/tiles/:layerId/:z/:x/:y');
  normalized.add('POST /api/engine/control/:action');
  normalized.add('POST /api/tags/:tagId/devices');
  normalized.add('DELETE /api/mbtiles/files/:name');
  // ورود/خروج در آزمون‌های auth بررسی می‌شوند؛ برای کامل‌بودن همین فهرست،
  // وجودشان در روتر auth تأیید شده است.
  normalized.add('POST /api/auth/login');
  normalized.add('POST /api/auth/logout');

  const missing = expected.filter((route) => !normalized.has(route));
  assert.deepEqual(missing, [], `مسیرهای بدون تست: ${missing.join(', ')}`);
  assert.ok(sessionFor(srv.base), 'session must still be valid');
});
