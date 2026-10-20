/**
 * سلامت برنامه در /api/status
 * ----------------------------------------------------------------
 * داشبورد و نوار وضعیت به یک پاسخ مشترک نیاز دارند که:
 *   • سلامت API/پایگاه‌داده، موتور، SSE، پشتیبان، دیسک و آخرین Probe موفق را بدهد
 *   • هیچ مسیر فایلی یا جزئیات حساسی افشا نکند
 *   • برای Viewer هم قابل خواندن باشد (داشبورد بدون مجوز مدیریتی)
 *   • /api/system/health همچنان فقط برای Operator/Administrator باشد
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, startServer, api, login } from '../helpers.mjs';

const dir = useTempDataDir('status-app-health');
let srv;

before(async () => {
  srv = await startServer({ dataDir: dir, engine: false });
});

after(async () => {
  await srv.stop();
  cleanupDir(dir);
});

test('status exposes independent application health fields without leaking paths', async () => {
  const res = await api(srv.base, 'GET', '/api/status');
  assert.equal(res.status, 200);

  const body = res.data;
  assert.equal(typeof body.server.ok, 'boolean');
  assert.equal(typeof body.app.db.ok, 'boolean');
  assert.ok(body.app.db.sizeBytes === null || body.app.db.sizeBytes > 0);
  assert.equal(typeof body.app.sse.clients, 'number');
  assert.equal(typeof body.app.backup.count, 'number');
  assert.equal(typeof body.app.backup.enabled, 'boolean');
  assert.equal(typeof body.app.disk.freeBytes, 'number');
  assert.equal(typeof body.app.disk.ok, 'boolean');
  assert.equal(typeof body.app.probe.lastSuccessAt, 'number');
  assert.equal(typeof body.app.probe.lastStatusChangeAt, 'number');
  assert.equal(typeof body.app.generatedAt, 'number');

  // مسیر فایل‌ها نباید در پاسخ عمومی وضعیت بیاید.
  const raw = JSON.stringify(body);
  assert.equal(raw.includes(dir), false, 'status must not expose the data directory');
  assert.equal(raw.includes('dataDir'), false);
  assert.equal(raw.includes('path'), false);
});

test('viewer can read dashboard status but not the privileged system health endpoint', async () => {
  const created = await api(srv.base, 'POST', '/api/auth/users', {
    username: 'status-viewer',
    password: 'ViewerPass!2345',
    role: 'viewer',
    displayName: 'بیننده وضعیت',
  });
  assert.equal(created.status, 201);

  await login(srv.base, 'status-viewer', 'ViewerPass!2345');
  const status = await api(srv.base, 'GET', '/api/status');
  assert.equal(status.status, 200, 'viewer needs /api/status for the dashboard');
  assert.equal(typeof status.data.app.disk.freeBytes, 'number');

  const privileged = await api(srv.base, 'GET', '/api/system/health');
  assert.equal(privileged.status, 403, 'detailed health must stay Operator/Administrator only');

  // بازگشت به نشست مدیر برای پایان‌بندی سایر آزمون‌ها
  await login(srv.base);
});
