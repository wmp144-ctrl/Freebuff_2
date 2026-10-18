/**
 * آزمون یکپارچهٔ پایگاه‌داده روی سرور واقعی:
 *   • سلامت پایگاه‌داده از API
 *   • ساخت/اعتبارسنجی/بازیابی پشتیبان از API (فقط Administrator)
 *   • اتمیک بودن ورود گروهی: خطا در یک ردیف = هیچ ردیفی ثبت نشود
 *   • رد مسیر نامعتبر برای بازیابی (path traversal)
 *   • Checkpoint بدون از دست رفتن داده
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, startServer, api, sessionFor } from '../helpers.mjs';

const dir = useTempDataDir('db-stability-int');
let srv;

function formFile(name, content, type = 'text/csv') {
  const fd = new FormData();
  fd.set('file', new Blob([content], { type }), name);
  return fd;
}

async function upload(base, url, form, extra = {}) {
  const session = sessionFor(base);
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, ...extra },
    body: form,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* بدنهٔ غیر JSON */
  }
  return { status: res.status, data };
}

before(async () => {
  srv = await startServer({ dataDir: dir, engine: false });
});

after(async () => {
  await srv.stop();
  cleanupDir(dir);
});

test('database health endpoint reports a healthy schema and WAL policy', async () => {
  const res = await api(srv.base, 'GET', '/api/system/db/health');
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.health.ok, true);
  assert.equal(res.data.wal.journalMode, 'wal');
  assert.ok(res.data.tables.includes('devices'));
  assert.ok(res.data.backups && typeof res.data.backups.count === 'number');
});

test('administrator can create, verify and dry-run restore a backup', async () => {
  const created = await api(srv.base, 'POST', '/api/system/backups', { includeMbtiles: true });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.manifest.db.integrity, 'ok');

  const verified = await api(srv.base, 'POST', '/api/system/backups/verify', { name: created.data.name });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  assert.equal(verified.data.ok, true);

  const dry = await api(srv.base, 'POST', '/api/system/backups/restore', { name: created.data.name, dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.data.restored, false);

  const listed = await api(srv.base, 'GET', '/api/system/backups');
  assert.equal(listed.status, 200);
  assert.ok(listed.data.items.some((b) => b.name === created.data.name));
});

test('restore rejects path traversal and unknown backup names', async () => {
  const bad = await api(srv.base, 'POST', '/api/system/backups/restore', { name: '../../etc/passwd' });
  assert.equal(bad.status, 400);
  const unknown = await api(srv.base, 'POST', '/api/system/backups/restore', { name: 'netwatch-20200101-000000-abcdef' });
  assert.equal(unknown.status, 404);
});

test('group import is atomic: one bad row rolls back the whole file', async () => {
  const before = await api(srv.base, 'GET', '/api/devices?pageSize=1');

  // ردیف سوم نام ندارد (خطای اعتبارسنجی) اما IP معتبر دارد؛ با onlyValid=0 وارد
  // تراکنش می‌شود و در همان‌جا شکست می‌خورد — پس کل فایل باید برگردد.
  const csv = [
    'name,ip,device_type',
    'import-ok-1,10.200.0.1,سوئیچ',
    'import-ok-2,10.200.0.2,روتر',
    ',10.200.0.3,سرور',
  ].join('\n');
  const form = formFile('devices.csv', csv);
  form.set('onlyValid', '0');
  const res = await upload(srv.base, '/api/devices/import/commit', form);
  assert.equal(res.status, 400, JSON.stringify(res.data));
  assert.equal(res.data.rolledBack, true);
  assert.match(res.data.error, /هیچ تغییری ثبت نگردید/);

  const check = await api(srv.base, 'GET', '/api/devices?search=import-&pageSize=10');
  assert.equal(check.data.items.length, 0, 'هیچ ردیفی از فایل نباید ثبت شده باشد');
  const after = await api(srv.base, 'GET', '/api/devices?pageSize=1');
  assert.equal(after.data.total, before.data.total);
});

test('checkpoint API keeps data and reports frames', async () => {
  const before = await api(srv.base, 'GET', '/api/devices?pageSize=1');
  const res = await api(srv.base, 'POST', '/api/system/db/checkpoint', {});
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.busy, 0);
  const after = await api(srv.base, 'GET', '/api/devices?pageSize=1');
  assert.equal(after.data.total, before.data.total);
});

test('viewer cannot create backups (admin-only operation)', async () => {
  const created = await api(srv.base, 'POST', '/api/auth/users', {
    username: 'db-viewer',
    password: 'viewer-pass-1234',
    role: 'viewer',
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));

  const login = await fetch(`${srv.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: srv.base },
    body: JSON.stringify({ username: 'db-viewer', password: 'viewer-pass-1234' }),
  });
  assert.equal(login.status, 200);
  const cookies = login.headers.getSetCookie().map((c) => c.split(';')[0]);
  const csrf = cookies.find((c) => c.startsWith('nw_csrf='))?.split('=')[1] || '';
  const res = await fetch(`${srv.base}/api/system/backups`, {
    method: 'POST',
    headers: { cookie: cookies.join('; '), 'x-csrf-token': csrf, origin: srv.base, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 403);
  await api(srv.base, 'DELETE', `/api/auth/users/${created.data.id}`);
});
