/**
 * آزمون یکپارچهٔ احراز هویت روی سرور واقعی:
 * محافظت API و SSE، نقش‌ها، CSRF، خروج و سقف نرخ ورود.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, startServer, api, login, sessionFor, TEST_ADMIN } from '../helpers.mjs';

const dir = useTempDataDir('auth-int');
let srv;

before(async () => {
  srv = await startServer({ dataDir: dir, engine: false });
});

after(async () => {
  await srv.stop();
  cleanupDir(dir);
});

test('health stays public while every other API requires a session', async () => {
  const health = await api(srv.base, 'GET', '/api/health', undefined, { auth: false });
  assert.equal(health.status, 200);

  for (const path of ['/api/devices', '/api/dashboard/summary', '/api/alerts', '/api/settings', '/api/reports/summary']) {
    const res = await api(srv.base, 'GET', path, undefined, { auth: false });
    assert.equal(res.status, 401, `${path} must require authentication`);
  }
  // نوشتن بدون نشست هم ۴۰۱ است (نه ۴۰۳) تا مسیر و نقش لو نرود
  const write = await api(srv.base, 'POST', '/api/devices', { name: 'x', ip: '10.1.2.3' }, { auth: false });
  assert.equal(write.status, 401);
});

test('SSE endpoint is protected too', async () => {
  const res = await fetch(`${srv.base}/api/events`, { headers: { accept: 'text/event-stream' } });
  assert.equal(res.status, 401);
  await res.body?.cancel();
});

test('login rejects bad credentials without revealing whether the user exists', async () => {
  const wrong = await api(srv.base, 'POST', '/api/auth/login', { username: 'admin', password: 'nope-nope' }, { auth: false });
  assert.equal(wrong.status, 401);
  const missing = await api(srv.base, 'POST', '/api/auth/login', { username: 'ghost-user', password: 'nope-nope' }, { auth: false });
  assert.equal(missing.status, 401);
  assert.equal(missing.data.error, wrong.data.error, 'same generic message for both cases');
  const empty = await api(srv.base, 'POST', '/api/auth/login', {}, { auth: false });
  assert.equal(empty.status, 400);
});

test('login sets a hardened session cookie and /me returns the role', async () => {
  const res = await fetch(`${srv.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: srv.base },
    body: JSON.stringify(TEST_ADMIN),
  });
  assert.equal(res.status, 200);
  const cookies = res.headers.getSetCookie();
  const session = cookies.find((c) => c.startsWith('nw_session='));
  assert.ok(session, 'session cookie expected');
  assert.match(session, /HttpOnly/);
  assert.match(session, /SameSite=Strict/);
  assert.match(session, /Path=\//);
  const body = await res.json();
  assert.equal(body.user.username, 'admin');
  assert.equal(body.user.role, 'admin');
  assert.equal(body.user.password_hash, undefined, 'password hash must never be returned');
});

test('state-changing request without CSRF token is rejected', async () => {
  const body = { name: 'csrf-test', ip: '10.20.0.1' };
  assert.equal((await api(srv.base, 'POST', '/api/devices', body, { headers: { 'x-csrf-token': '' } })).status, 403);
  assert.equal((await api(srv.base, 'POST', '/api/devices', body, { headers: { 'x-csrf-token': 'wrong-token' } })).status, 403);
  const ok = await api(srv.base, 'POST', '/api/devices', body);
  assert.equal(ok.status, 201);
  await api(srv.base, 'DELETE', `/api/devices/${ok.data.id}`);
});

test('viewer can read but cannot mutate anything or list users', async () => {
  const created = await api(srv.base, 'POST', '/api/auth/users', {
    username: 'viewer1',
    password: 'viewer-password-123',
    role: 'viewer',
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.role, 'viewer');
  assert.equal(created.data.password_hash, undefined);

  await login(srv.base, 'viewer1', 'viewer-password-123');
  const read = await api(srv.base, 'GET', '/api/devices');
  assert.equal(read.status, 200);
  const write = await api(srv.base, 'POST', '/api/devices', { name: 'x', ip: '10.20.0.9' });
  assert.equal(write.status, 403);
  assert.equal((await api(srv.base, 'PUT', '/api/settings', { ping_interval: 10 })).status, 403);
  assert.equal((await api(srv.base, 'DELETE', '/api/devices/1')).status, 403);
  assert.equal((await api(srv.base, 'GET', '/api/auth/users')).status, 403);

  // نشست مدیر برای آزمون‌های بعدی
  await login(srv.base);
});

test('admin cannot delete or demote the last active admin', async () => {
  const users = await api(srv.base, 'GET', '/api/auth/users');
  const admin = users.data.items.find((u) => u.username === 'admin');
  assert.equal((await api(srv.base, 'DELETE', `/api/auth/users/${admin.id}`)).status, 400);
  assert.equal((await api(srv.base, 'PUT', `/api/auth/users/${admin.id}`, { role: 'viewer' })).status, 400);
});

test('foreign Origin is rejected even with a valid session', async () => {
  const res = await api(srv.base, 'POST', '/api/devices', { name: 'x', ip: '10.20.0.2' }, { origin: 'http://evil.example' });
  assert.equal(res.status, 403);
});

test('logout destroys the session server-side', async () => {
  const session = sessionFor(srv.base);
  const out = await api(srv.base, 'POST', '/api/auth/logout', {});
  assert.equal(out.status, 200);
  const after = await fetch(`${srv.base}/api/devices`, {
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
  });
  assert.equal(after.status, 401, 'the old cookie must not work after logout');
  await after.body?.cancel();
  await login(srv.base);
});

test('login is rate limited per IP', async () => {
  const otherDir = useTempDataDir('auth-rate');
  const other = await startServer({ dataDir: otherDir, engine: false });
  try {
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      const res = await api(other.base, 'POST', '/api/auth/login', { username: 'admin', password: `wrong-${i}` }, { auth: false });
      statuses.push(res.status);
    }
    assert.ok(statuses.includes(429), `expected a 429, got ${statuses.join(',')}`);
    assert.equal(statuses.at(-1), 429);
    // ورود صحیح هم پس از پر شدن سطل باید ۴۲۹ بگیرد (نه بایپس با رمز درست)
    const right = await api(other.base, 'POST', '/api/auth/login', TEST_ADMIN, { auth: false });
    assert.equal(right.status, 429);
  } finally {
    await other.stop();
    cleanupDir(otherDir);
  }
});
