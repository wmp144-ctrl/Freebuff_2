/**
 * آزمون یکپارچهٔ امنیت (P0) روی سرور واقعی:
 *   • هیچ API عملیاتی بدون احراز هویت پاسخ نمی‌دهد
 *   • Viewer نمی‌تواند داده را تغییر دهد یا Probe بزند
 *   • Operator عملیات روزمره را انجام می‌دهد اما به تنظیمات/کاربران/حسابرسی دست ندارد
 *   • Administrator به مدیریت کاربران، تنظیمات و حسابرسی دسترسی دارد
 *   • CSRF، محدودهٔ Probe، اعتبارسنجی ورودی، محدودیت فایل و Audit Log
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, startServer, api, login, sessionFor, TEST_ADMIN } from '../helpers.mjs';

const dir = useTempDataDir('security-int');
let srv;
const operatorPassword = 'operator-pass-123';
const viewerPassword = 'viewer-pass-123';

function formFile(name, content, type = 'text/plain') {
  const fd = new FormData();
  fd.set('file', new Blob([content], { type }), name);
  return fd;
}

async function upload(base, path, form) {
  const session = sessionFor(base);
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
      origin: base,
    },
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
  srv = await startServer({ dataDir: dir, engine: false, env: { NETWATCH_ALLOW_RESET: '1' } });
});

after(async () => {
  await srv.stop();
  cleanupDir(dir);
});

test('every operational API rejects anonymous requests', async () => {
  const paths = [
    '/api/devices',
    '/api/devices/meta',
    '/api/dashboard/summary',
    '/api/reports/summary',
    '/api/alerts',
    '/api/maintenance',
    '/api/engine/status',
    '/api/engine/log',
    '/api/settings',
    '/api/groups',
    '/api/tags',
    '/api/layers',
    '/api/marker-types',
    '/api/markers',
    '/api/audit',
    '/api/system/health',
    '/api/auth/users',
    '/api/auth/me',
  ];
  for (const path of paths) {
    const res = await api(srv.base, 'GET', path, undefined, { auth: false });
    assert.equal(res.status, 401, `${path} must require authentication (got ${res.status})`);
    assert.ok(res.data?.error, `${path} must return a JSON error`);
  }
  // خروج بدون نشست هم ۴۰۱ است (نه یک عملیات بی‌صاحب)
  assert.equal((await api(srv.base, 'POST', '/api/auth/logout', {}, { auth: false })).status, 401);
  // و هیچ پاسخ بدون نشست نباید اطلاعات داخلی افشا کند
  const pub = await api(srv.base, 'GET', '/api/health', undefined, { auth: false });
  assert.deepEqual(Object.keys(pub.data).sort(), ['ok', 'status', 'ts']);
});

test('admin provisions Operator and Viewer accounts with explicit roles', async () => {
  const op = await api(srv.base, 'POST', '/api/auth/users', {
    username: 'operator1',
    password: operatorPassword,
    role: 'operator',
  });
  assert.equal(op.status, 201);
  assert.equal(op.data.role, 'operator');
  assert.ok(op.data.permissions.includes('probe:run'));
  assert.ok(!op.data.permissions.includes('settings:write'));

  const viewer = await api(srv.base, 'POST', '/api/auth/users', {
    username: 'viewer1',
    password: viewerPassword,
    role: 'viewer',
  });
  assert.equal(viewer.status, 201);
  assert.equal(viewer.data.role, 'viewer');
  assert.ok(!viewer.data.permissions.includes('probe:run'));
  assert.equal(JSON.stringify(viewer.data).includes('password'), false, 'password hash must never leak');

  const bad = await api(srv.base, 'POST', '/api/auth/users', { username: 'bad1', password: 'long-enough-1', role: 'root' });
  assert.equal(bad.status, 400);
  // نام‌های رایج نقش پذیرفته و نرمال می‌شوند
  const alias = await api(srv.base, 'POST', '/api/auth/users', { username: 'aliasadmin', password: 'long-enough-1', role: 'administrator' });
  assert.equal(alias.status, 201);
  assert.equal(alias.data.role, 'admin');
});

test('viewer can read but cannot mutate, probe, or reach admin APIs', async () => {
  await login(srv.base, 'viewer1', viewerPassword);
  assert.equal((await api(srv.base, 'GET', '/api/devices')).status, 200);
  assert.equal((await api(srv.base, 'GET', '/api/settings')).status, 200);

  assert.equal((await api(srv.base, 'POST', '/api/devices', { name: 'v', ip: '10.40.0.1' })).status, 403);
  assert.equal((await api(srv.base, 'DELETE', '/api/devices/1')).status, 403);
  assert.equal((await api(srv.base, 'PUT', '/api/settings', { ping_interval: 10 })).status, 403);
  assert.equal((await api(srv.base, 'GET', '/api/auth/users')).status, 403);
  assert.equal((await api(srv.base, 'GET', '/api/audit')).status, 403);
  assert.equal((await api(srv.base, 'GET', '/api/system/health')).status, 403);
  // Probe یک اسکن فعال است و Viewer مجاز نیست
  assert.equal((await api(srv.base, 'GET', '/api/devices/1/probe?mode=simulate')).status, 403);
  assert.equal((await api(srv.base, 'POST', '/api/devices/1/ping', { mode: 'simulate' })).status, 403);
});

test('operator performs daily operations but cannot change administrative settings', async () => {
  // ساخت تجهیزات آزمایشی با مدیر
  await login(srv.base);
  const allowed = await api(srv.base, 'POST', '/api/devices', { name: 'probe-allowed', ip: '10.240.0.9', monitoring_enabled: 0 });
  assert.equal(allowed.status, 201);
  const blocked = await api(srv.base, 'POST', '/api/devices', { name: 'probe-blocked', ip: '203.0.113.9', monitoring_enabled: 0 });
  assert.equal(blocked.status, 201);

  await login(srv.base, 'operator1', operatorPassword);
  // عملیات مجاز
  const created = await api(srv.base, 'POST', '/api/devices', { name: 'operator-device', ip: '10.240.1.1', monitoring_enabled: 0 });
  assert.equal(created.status, 201);
  assert.equal((await api(srv.base, 'GET', `/api/devices/${allowed.data.id}/probe?mode=simulate`)).status, 200);
  assert.equal((await api(srv.base, 'POST', '/api/devices/bulk', { ids: [created.data.id], action: 'disable' })).status, 200);
  assert.equal((await api(srv.base, 'DELETE', `/api/devices/${created.data.id}`)).status, 200);

  // Probe خارج از محدودهٔ مجاز مسدود می‌شود
  const denied = await api(srv.base, 'GET', `/api/devices/${blocked.data.id}/probe?mode=simulate`);
  assert.equal(denied.status, 403);
  assert.match(denied.data.error, /Probe/);

  // عملیات مدیریتی مجاز نیست
  assert.equal((await api(srv.base, 'PUT', '/api/settings', { ping_interval: 20 })).status, 403);
  assert.equal((await api(srv.base, 'POST', '/api/settings/reset-demo', { confirm: 'reset' })).status, 403);
  assert.equal((await api(srv.base, 'GET', '/api/auth/users')).status, 403);
  assert.equal((await api(srv.base, 'GET', '/api/audit')).status, 403);
  // Operator مانیتورینگ/سلامت تفصیلی را می‌بیند اما حسابرسی و کاربران را نه
  assert.equal((await api(srv.base, 'GET', '/api/system/health')).status, 200);
  // موتور عملیاتی است و برای Operator مجاز است
  assert.equal((await api(srv.base, 'POST', '/api/engine/control/stop', {})).status, 200);
});

test('administrator can change settings, users and read the audit log', async () => {
  await login(srv.base);
  assert.equal((await api(srv.base, 'GET', '/api/auth/users')).status, 200);
  const audit = await api(srv.base, 'GET', '/api/audit?pageSize=100');
  assert.equal(audit.status, 200);
  const actions = audit.data.items.map((i) => i.action);
  assert.ok(actions.includes('auth.login'), 'login must be audited');
  assert.ok(actions.includes('user.manage'), 'user management must be audited');
  assert.ok(actions.includes('data.delete'), 'deletions must be audited');
  assert.ok(actions.includes('probe.run'), 'probe must be audited');
  const entries = audit.data.items.filter((i) => i.action === 'user.manage');
  const okEntries = entries.filter((e) => e.success);
  assert.ok(okEntries.length >= 2);
  assert.ok(
    okEntries.every((e) => e.actorUsername === 'admin' && e.actorRole === 'admin'),
    'audit rows must carry actor and role'
  );
  // تلاش ناموفق (نقش نامعتبر) هم باید ثبت شده باشد
  assert.ok(entries.some((e) => !e.success), 'failed operations must be audited too');
  // رمزها هرگز در حسابرسی ذخیره نمی‌شوند
  assert.equal(JSON.stringify(audit.data).includes(operatorPassword), false, 'audit must not contain passwords');
  assert.equal(JSON.stringify(audit.data).includes(viewerPassword), false, 'audit must not contain passwords');
});

test('sensitive settings changes and deletes are audited with actor and target', async () => {
  await login(srv.base);
  const changed = await api(srv.base, 'PUT', '/api/settings', { ping_interval: 42 });
  assert.equal(changed.status, 200);
  const created = await api(srv.base, 'POST', '/api/devices', { name: 'audit-target', ip: '10.240.2.2', monitoring_enabled: 0 });
  assert.equal(created.status, 201);
  assert.equal((await api(srv.base, 'DELETE', `/api/devices/${created.data.id}`)).status, 200);

  const audit = await api(srv.base, 'GET', '/api/audit?pageSize=100');
  const settingsRow = audit.data.items.find((i) => i.action === 'settings.update');
  assert.ok(settingsRow, 'settings update must be audited');
  assert.equal(settingsRow.actorUsername, 'admin');
  assert.ok(settingsRow.details.bodyKeys.includes('ping_interval'));
  const deleteRow = audit.data.items.find((i) => i.action === 'data.delete' && i.details.targetId === String(created.data.id));
  assert.ok(deleteRow, 'device delete must be audited with its target id');
});

test('CSRF and foreign Origin cannot change data even with a valid session', async () => {
  await login(srv.base);
  const body = { name: 'csrf', ip: '10.240.3.3' };
  assert.equal((await api(srv.base, 'POST', '/api/devices', body, { headers: { 'x-csrf-token': '' } })).status, 403);
  assert.equal((await api(srv.base, 'POST', '/api/devices', body, { headers: { 'x-csrf-token': 'forged' } })).status, 403);
  assert.equal((await api(srv.base, 'POST', '/api/devices', body, { origin: 'http://evil.example' })).status, 403);
  const ok = await api(srv.base, 'POST', '/api/devices', body);
  assert.equal(ok.status, 201);
  await api(srv.base, 'DELETE', `/api/devices/${ok.data.id}`);
});

test('malicious input, wrong content types and disallowed files are rejected', async () => {
  await login(srv.base);
  // نمونه‌سازی خطرناک
  const protoRes = await fetch(`${srv.base}/api/settings`, {
    method: 'PUT',
    headers: {
      cookie: sessionFor(srv.base).cookie,
      'x-csrf-token': sessionFor(srv.base).csrf,
      origin: srv.base,
      'content-type': 'application/json',
    },
    body: '{"__proto__":{"polluted":true},"ping_interval":30}',
  });
  assert.equal(protoRes.status, 400);
  // Content-Type نامعتبر
  const wrongType = await fetch(`${srv.base}/api/devices`, {
    method: 'POST',
    headers: { cookie: sessionFor(srv.base).cookie, 'x-csrf-token': sessionFor(srv.base).csrf, origin: srv.base, 'content-type': 'text/plain' },
    body: JSON.stringify({ name: 'x', ip: '10.240.4.4' }),
  });
  assert.equal(wrongType.status, 415);
  // IP مخرب
  assert.equal((await api(srv.base, 'POST', '/api/devices', { name: 'x', ip: '10.0.0.1; rm -rf /' })).status, 400);
  // فایل غیرمجاز برای ورود گروهی
  const badFile = await upload(srv.base, '/api/devices/import/preview', formFile('payload.exe', 'binary'));
  assert.equal(badFile.status, 400);
  assert.match(badFile.data.error, /xlsx|\.csv/);
  // فایل غیر SQLite برای MBTiles
  const badTiles = await upload(srv.base, '/api/layers/upload', formFile('map.mbtiles', 'not a sqlite database'));
  assert.equal(badTiles.status, 400);
});

test('probe allowlist can be narrowed through configuration', async () => {
  const otherDir = useTempDataDir('security-probe');
  const other = await startServer({
    dataDir: otherDir,
    engine: false,
    env: { NETWATCH_PROBE_ALLOWED_CIDRS: '10.0.0.0/8' },
  });
  try {
    const allowed = await api(other.base, 'POST', '/api/devices', { name: 'in-range', ip: '10.1.2.3', monitoring_enabled: 1 });
    assert.equal(allowed.status, 201);
    const blocked = await api(other.base, 'POST', '/api/devices', { name: 'out-range', ip: '192.168.1.5', monitoring_enabled: 1 });
    assert.equal(blocked.status, 201);

    assert.equal((await api(other.base, 'GET', `/api/devices/${allowed.data.id}/probe?mode=simulate`)).status, 200);
    assert.equal((await api(other.base, 'GET', `/api/devices/${blocked.data.id}/probe?mode=simulate`)).status, 403);
    // بررسی دستی همه هم باید مقاصد غیرمجاز را رد کند
    const all = await api(other.base, 'POST', '/api/engine/check-all', {});
    assert.equal(all.status, 200);
    assert.ok(all.data.skipped >= 1, `out-of-range targets must be skipped: ${JSON.stringify(all.data)}`);
  } finally {
    await other.stop();
    cleanupDir(otherDir);
  }
});

test('oversized spreadsheet uploads are refused before parsing', async () => {
  const otherDir = useTempDataDir('security-upload');
  const other = await startServer({
    dataDir: otherDir,
    engine: false,
    env: { NETWATCH_MAX_IMPORT_BYTES: '65536' },
  });
  try {
    const big = 'a,b\n' + 'x,y\n'.repeat(40000);
    const res = await upload(other.base, '/api/devices/import/preview', formFile('big.csv', big, 'text/csv'));
    assert.equal(res.status, 413);
    assert.ok(res.data.error);
  } finally {
    await other.stop();
    cleanupDir(otherDir);
  }
});

test('session cookie is hardened and role permissions survive re-login', async () => {
  const res = await fetch(`${srv.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: srv.base },
    body: JSON.stringify(TEST_ADMIN),
  });
  assert.equal(res.status, 200);
  const raw = res.headers.getSetCookie();
  const session = raw.find((c) => c.startsWith('nw_session='));
  assert.match(session, /HttpOnly/);
  assert.match(session, /SameSite=Strict/);
  const body = await res.json();
  assert.equal(body.user.role, 'admin');
  assert.ok(body.user.permissions.includes('audit:read'));
});
