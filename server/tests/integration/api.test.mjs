/**
 * آزمون یکپارچهٔ API روی سرور واقعی با پایگاه‌دادهٔ موقت.
 * حالت‌های لبه: ورودی خالی/نامعتبر، حذف تجهیز، مسیر ناشناخته، JSON خراب.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { useTempDataDir, cleanupDir, startServer, api } from '../helpers.mjs';

const dir = useTempDataDir('api-int');
let srv;

before(async () => {
  srv = await startServer({ dataDir: dir, engine: false });
});

after(async () => {
  await srv.stop();
  cleanupDir(dir);
});

test('public health is minimal and detailed health needs an authorized session', async () => {
  const pub = await api(srv.base, 'GET', '/api/health', undefined, { auth: false });
  assert.equal(pub.status, 200);
  assert.equal(pub.data.ok, true);
  assert.deepEqual(Object.keys(pub.data).sort(), ['ok', 'status', 'ts'], 'public health must not expose internal state');
  assert.equal(pub.data.engine, undefined);
  assert.equal(pub.data.db, undefined);
  assert.equal(pub.data.version, undefined);

  const detail = await api(srv.base, 'GET', '/api/system/health');
  assert.equal(detail.status, 200);
  assert.equal(detail.data.ok, true);
  assert.ok(typeof detail.data.uptime === 'number');
  assert.ok(typeof detail.data.devices === 'number');
  assert.ok(detail.data.engine, 'engine status must be included for authorized users');
  assert.equal(JSON.stringify(detail.data).includes('netwatch.db'), false, 'internal paths must not leak');
});

test('POST /api/devices validates empty and malformed input', async () => {
  assert.equal((await api(srv.base, 'POST', '/api/devices', {})).status, 400);
  assert.equal((await api(srv.base, 'POST', '/api/devices', { name: '', ip: '' })).status, 400);
  assert.equal((await api(srv.base, 'POST', '/api/devices', { name: 'x', ip: 'not-an-ip' })).status, 400);
  assert.equal((await api(srv.base, 'POST', '/api/devices', { name: 'x', ip: '10.0.0.1; reboot' })).status, 400);
  assert.equal((await api(srv.base, 'POST', '/api/devices', { name: 'x', ip: '10.1.1.1', ping_interval: -5 })).status, 400);
  assert.equal((await api(srv.base, 'POST', '/api/devices', { name: 'x', ip: '10.1.1.2', timeout_ms: 10 ** 8 })).status, 400);
  assert.equal((await api(srv.base, 'POST', '/api/devices', { name: 'x', ip: '10.1.1.3', packet_count: 500 })).status, 400);
  assert.equal((await api(srv.base, 'POST', '/api/devices', { name: 'x', ip: '10.1.1.4', latitude: 200 })).status, 400);
});

test('malformed JSON body is rejected with a clear error', async () => {
  const res = await api(srv.base, 'POST', '/api/devices', '{ this is not json');
  assert.equal(res.status, 400);
  assert.ok(res.data?.error, 'error message expected');
});

test('device lifecycle: create, read, patch, delete', async () => {
  const created = await api(srv.base, 'POST', '/api/devices', { name: 'آزمون یکپارچه', ip: '10.50.0.1', ping_interval: 30 });
  assert.equal(created.status, 201);
  const id = created.data.id;

  const read = await api(srv.base, 'GET', `/api/devices/${id}`);
  assert.equal(read.status, 200);
  assert.equal(read.data.ip, '10.50.0.1');
  assert.equal(read.data.effective.pingInterval, 30);

  const patched = await api(srv.base, 'PATCH', `/api/devices/${id}`, { notes: 'به‌روزرسانی' });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.notes, 'به‌روزرسانی');

  const list = await api(srv.base, 'GET', '/api/devices?search=آزمون یکپارچه');
  assert.equal(list.status, 200);
  assert.ok(list.data.items.some((d) => d.id === id));

  const dup = await api(srv.base, 'POST', '/api/devices', { name: 'تکراری', ip: '10.50.0.1' });
  assert.equal(dup.status, 400);

  assert.equal((await api(srv.base, 'DELETE', `/api/devices/${id}`)).status, 200);
  assert.equal((await api(srv.base, 'GET', `/api/devices/${id}`)).status, 404);
  assert.equal((await api(srv.base, 'DELETE', `/api/devices/${id}`)).status, 404);
});

test('bulk operations reject unknown actions and empty id lists', async () => {
  assert.equal((await api(srv.base, 'POST', '/api/devices/bulk', { ids: [], action: 'delete' })).status, 400);
  assert.equal((await api(srv.base, 'POST', '/api/devices/bulk', { ids: [1], action: 'nope' })).status, 400);
});

test('alert rules get safe defaults when optional fields are missing', async () => {
  const created = await api(srv.base, 'POST', '/api/alert-rules', { name: 'قانون با پیش‌فرض‌ها', metric: 'offline' });
  assert.equal(created.status, 201);
  assert.equal(created.data.cooldown_sec, 600, 'default cooldown must be a real number, not NaN');
  assert.equal(created.data.metric, 'offline');
  assert.equal(created.data.severity, 'warning');
  await api(srv.base, 'DELETE', `/api/alert-rules/${created.data.id}`);
});

test('alerts endpoint paginates and reports stats', async () => {
  const res = await api(srv.base, 'GET', '/api/alerts?pageSize=5&status=all');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.data.items));
  assert.ok(res.data.stats && typeof res.data.stats.active === 'number');
});

test('unknown API route and missing device return JSON errors', async () => {
  const unknown = await api(srv.base, 'GET', '/api/definitely-missing');
  assert.equal(unknown.status, 404);
  assert.ok(unknown.data.error);
  assert.equal((await api(srv.base, 'GET', '/api/devices/999999')).status, 404);
});

test('cross-origin mutations are rejected while same-origin ones pass', async () => {
  const evil = await api(srv.base, 'POST', '/api/devices', { name: 'x', ip: '10.60.0.1' }, { origin: 'http://evil.example' });
  assert.equal(evil.status, 403);
  const good = await api(srv.base, 'POST', '/api/devices', { name: 'ok', ip: '10.60.0.2' });
  assert.equal(good.status, 201);
  await api(srv.base, 'DELETE', `/api/devices/${good.data.id}`);
});

test('server process is still alive and database file is inside the temp dir', () => {
  assert.equal(srv.child.exitCode, null);
  assert.ok(fs.existsSync(`${dir}/netwatch.db`));
});
