/**
 * آزمون امنیتی Phase 3 روی سرور واقعی (HTTP + DB):
 *   • Brute Force و Account Lockout (IP + Username + Recovery)
 *   • Session Fixation، Expiration، Idle Timeout، Logout All
 *   • تغییر نقش روی نشست فعال (بدون نیاز به ورود دوباره)
 *   • CSRF نامعتبر/تکراری و مرز Origin
 *   • RBAC مستقیم HTTP و Privilege Escalation
 *   • XSS/SQL Injection/Path Traversal
 *   • File Upload Abuse (محتوای جعلی، ZIP Bomb، CSV باینری، نبود فایل موقت)
 *   • Oversized/Incomplete/Deep JSON
 *   • Rate Limiting ورود و مقصد شبکهٔ ممنوع Probe
 *   • نشت نکردن رمز/توکن در لاگ و حسابرسی
 *   • محدودیت شبکه‌ای APIهای مدیریتی
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  useTempDataDir,
  cleanupDir,
  startServer,
  api,
  upload,
  login,
  sessionFor,
  TEST_ADMIN,
} from '../helpers.mjs';

const dir = useTempDataDir('phase3-security');
let srv;

const PASSWORD = 'Phase3-Pass-123!';
const ACCOUNTS = {
  viewer: { username: 'p3-viewer', password: PASSWORD, role: 'viewer' },
  operator: { username: 'p3-operator', password: PASSWORD, role: 'operator' },
  locked: { username: 'p3-locked', password: 'Locked-Account-123!', role: 'viewer' },
};

function dbHandle() {
  const d = new DatabaseSync(path.join(dir, 'netwatch.db'));
  d.exec('PRAGMA busy_timeout = 5000');
  return d;
}

function withDb(fn) {
  const d = dbHandle();
  try {
    return fn(d);
  } finally {
    d.close();
  }
}

async function rawLogin(username, password, cookie = '') {
  const res = await fetch(`${srv.base}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: srv.base,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ username, password }),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* بدنهٔ غیر JSON */
  }
  const setCookies = res.headers.getSetCookie();
  const pairs = setCookies.map((c) => c.split(';')[0]);
  return {
    status: res.status,
    data,
    setCookies,
    cookie: pairs.join('; '),
    csrf: pairs.find((p) => p.startsWith('nw_csrf='))?.slice('nw_csrf='.length) || '',
  };
}

async function me(cookie) {
  const res = await fetch(`${srv.base}/api/auth/me`, { headers: { cookie } });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* بی‌بدنه */
  }
  return { status: res.status, data };
}

async function mutation({ cookie, csrf, method = 'POST', url, body, origin = srv.base }) {
  const res = await fetch(srv.base + url, {
    method,
    headers: {
      cookie,
      'x-csrf-token': csrf,
      origin,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* بی‌بدنه */
  }
  return { status: res.status, data };
}

/** آرشیو ZIP حداقلی برای آزمون ZIP Bomb (فقط دایرکتوری مرکزی خوانده می‌شود) */
function makeZip(entries) {
  const local = Buffer.alloc(4);
  local.writeUInt32LE(0x04034b50, 0);
  const centralParts = entries.map((entry) => {
    const name = Buffer.from(entry.name, 'utf8');
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(entry.flags ?? 0, 8);
    header.writeUInt16LE(entry.method ?? 8, 10);
    header.writeUInt32LE(entry.compressed ?? 100, 20);
    header.writeUInt32LE(entry.uncompressed ?? 1000, 24);
    header.writeUInt16LE(name.length, 28);
    return Buffer.concat([header, name]);
  });
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(4, 16);
  return Buffer.concat([local, central, eocd]);
}

before(async () => {
  srv = await startServer({
    dataDir: dir,
    engine: false,
    env: {
      NETWATCH_LOGIN_MAX_FAILURES: '3',
      NETWATCH_LOGIN_LOCKOUT_MINUTES: '15',
      // سقف نرخ ورود در این آزمون بالا است تا Lockout/سیاست رمز مستقل سنجیده شود.
      NETWATCH_LOGIN_RATE_LIMIT_MAX: '500',
      NETWATCH_SESSION_HOURS: '12',
      NETWATCH_SESSION_IDLE_MINUTES: '60',
    },
  });
});

after(async () => {
  await srv.stop();
  cleanupDir(dir);
});

test('password policy rejects weak, common and username-derived secrets at the API', async () => {
  for (const password of ['1234', 'password123', 'aaaaaaaaaaaa', 'p3-newuser123']) {
    const res = await api(srv.base, 'POST', '/api/auth/users', {
      username: 'p3-newuser',
      password,
      role: 'viewer',
    });
    assert.equal(res.status, 400, `weak password accepted: ${password}`);
    assert.match(String(res.data?.error), /رمز عبور/);
  }
  const ok = await api(srv.base, 'POST', '/api/auth/users', {
    username: 'p3-newuser',
    password: 'New-User-Pass-123!',
    role: 'viewer',
  });
  assert.equal(ok.status, 201);
  assert.equal(JSON.stringify(ok.data).includes('New-User-Pass-123!'), false);

  const users = await api(srv.base, 'GET', '/api/auth/users');
  assert.ok(users.data.passwordPolicy.minLength >= 12, 'policy metadata must be available to admins');
  assert.equal(JSON.stringify(users.data).includes('New-User-Pass-123!'), false);
});

test('brute force locks the account by username, answers generically and can be unlocked', async () => {
  for (const account of Object.values(ACCOUNTS)) {
    const created = await api(srv.base, 'POST', '/api/auth/users', account);
    assert.equal(created.status, 201, JSON.stringify(created.data));
  }

  const missing = await rawLogin('p3-does-not-exist', 'whatever-wrong');
  assert.equal(missing.status, 401);

  for (let i = 0; i < 3; i++) {
    const res = await rawLogin(ACCOUNTS.locked.username, 'wrong-password-value');
    assert.equal(res.status, 401);
    assert.equal(res.data.error, missing.data.error, 'failure message must not reveal account existence or lock state');
    assert.equal(res.setCookies.length, 0, 'failed login must not issue a session');
  }
  // رمز صحیح هم در بازهٔ قفل پذیرفته نمی‌شود.
  const lockedCorrect = await rawLogin(ACCOUNTS.locked.username, ACCOUNTS.locked.password);
  assert.equal(lockedCorrect.status, 401);
  assert.equal(lockedCorrect.data.error, missing.data.error);

  const list = await api(srv.base, 'GET', '/api/auth/users');
  const row = list.data.items.find((u) => u.username === ACCOUNTS.locked.username);
  assert.equal(row.locked, true);
  assert.ok(row.lockedUntil > Date.now());
  assert.equal(JSON.stringify(list.data).includes(ACCOUNTS.locked.password), false);

  const unlocked = await api(srv.base, 'POST', `/api/auth/users/${row.id}/unlock`, {});
  assert.equal(unlocked.status, 200);
  assert.equal(unlocked.data.locked, false);
  const success = await rawLogin(ACCOUNTS.locked.username, ACCOUNTS.locked.password);
  assert.equal(success.status, 200, JSON.stringify(success.data));
  assert.match(success.setCookies.find((c) => c.startsWith('nw_session=')), /HttpOnly/);
  assert.match(success.setCookies.find((c) => c.startsWith('nw_session=')), /SameSite=Strict/);
});

test('session fixation is prevented: the presented session is rotated and invalidated', async () => {
  const first = await rawLogin(ACCOUNTS.viewer.username, ACCOUNTS.viewer.password);
  assert.equal(first.status, 200);
  assert.equal((await me(first.cookie)).status, 200);

  // ورود دوباره با همان کوکی (سناریوی تثبیت نشست): توکن تازه صادر و قدیمی باطل می‌شود.
  const second = await rawLogin(ACCOUNTS.viewer.username, ACCOUNTS.viewer.password, first.cookie);
  assert.equal(second.status, 200);
  assert.notEqual(second.cookie, first.cookie, 'session id must be regenerated on login');
  assert.equal((await me(first.cookie)).status, 401, 'the pre-login session must no longer work');
  assert.equal((await me(second.cookie)).status, 200);
});

test('logout-all revokes every session of the user', async () => {
  const a = await rawLogin(ACCOUNTS.viewer.username, ACCOUNTS.viewer.password);
  const b = await rawLogin(ACCOUNTS.viewer.username, ACCOUNTS.viewer.password);
  const c = await rawLogin(ACCOUNTS.viewer.username, ACCOUNTS.viewer.password);
  assert.equal((await me(b.cookie)).status, 200);

  const res = await mutation({ cookie: a.cookie, csrf: a.csrf, url: '/api/auth/logout-all', body: {} });
  assert.equal(res.status, 200);
  assert.ok(res.data.revoked >= 2);
  assert.equal((await me(a.cookie)).status, 401);
  assert.equal((await me(b.cookie)).status, 401);
  assert.equal((await me(c.cookie)).status, 401);
});

test('role changes take effect immediately on an active session', async () => {
  const viewer = await rawLogin(ACCOUNTS.viewer.username, ACCOUNTS.viewer.password);
  assert.equal((await me(viewer.cookie)).status, 200);
  assert.equal((await mutation({ cookie: viewer.cookie, csrf: viewer.csrf, url: '/api/devices', body: { name: 'p3-no-write', ip: '10.80.0.1' } })).status, 403);

  const userRow = withDb((d) => d.prepare('SELECT id FROM users WHERE username = ?').get(ACCOUNTS.viewer.username));
  await login(srv.base); // نشست مدیر برای تغییر نقش
  const promoted = await api(srv.base, 'PUT', `/api/auth/users/${userRow.id}`, { role: 'operator' });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.data.role, 'operator');

  // همان کوکی/نشست، بدون ورود دوباره، اکنون اجازهٔ نوشتن دارد.
  const created = await mutation({
    cookie: viewer.cookie,
    csrf: viewer.csrf,
    url: '/api/devices',
    body: { name: 'p3-promoted', ip: '10.80.0.2', monitoring_enabled: 0 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));

  const demoted = await api(srv.base, 'PUT', `/api/auth/users/${userRow.id}`, { role: 'viewer' });
  assert.equal(demoted.status, 200);
  assert.equal(
    (await mutation({ cookie: viewer.cookie, csrf: viewer.csrf, url: '/api/devices', body: { name: 'p3-demoted', ip: '10.80.0.3' } })).status,
    403,
    'demotion must apply to the active session immediately'
  );
});

test('absolute expiration and idle timeout invalidate server-side sessions', async () => {
  const expired = await rawLogin(ACCOUNTS.viewer.username, ACCOUNTS.viewer.password);
  withDb((d) =>
    d
      .prepare('UPDATE sessions SET expires_at = 0 WHERE user_id = (SELECT id FROM users WHERE username = ?)')
      .run(ACCOUNTS.viewer.username)
  );
  assert.equal((await me(expired.cookie)).status, 401);

  const idle = await rawLogin(ACCOUNTS.viewer.username, ACCOUNTS.viewer.password);
  withDb((d) =>
    d
      .prepare('UPDATE sessions SET last_seen_at = ? WHERE user_id = (SELECT id FROM users WHERE username = ?)')
      .run(Date.now() - 2 * 60 * 60 * 1000, ACCOUNTS.viewer.username)
  );
  assert.equal((await me(idle.cookie)).status, 401, 'idle session must be rejected');
  // خود ردیف نشست بی‌فعالیت باید حذف شده باشد (نه فقط رد شود).
  const tokenOf = (cookie) =>
    cookie
      .split('; ')
      .find((p) => p.startsWith('nw_session='))
      ?.slice('nw_session='.length) || '';
  const hashOfIdle = crypto.createHash('sha256').update(tokenOf(idle.cookie)).digest('hex');
  const rows = withDb((d) => d.prepare('SELECT COUNT(*) AS c FROM sessions WHERE token_hash = ?').get(hashOfIdle));
  assert.equal(Number(rows.c), 0);
});

test('CSRF tokens that are missing, forged, stale or duplicated are rejected', async () => {
  const a = await rawLogin(ACCOUNTS.operator.username, ACCOUNTS.operator.password);
  const body = { name: 'p3-csrf', ip: '10.81.0.1', monitoring_enabled: 0 };
  assert.equal((await mutation({ cookie: a.cookie, csrf: '', url: '/api/devices', body })).status, 403);
  assert.equal((await mutation({ cookie: a.cookie, csrf: 'forged-token', url: '/api/devices', body })).status, 403);
  assert.equal((await mutation({ cookie: a.cookie, csrf: a.csrf, url: '/api/devices', body, origin: 'http://evil.example' })).status, 403);

  // چرخش نشست: توکن CSRF قدیمی با نشست جدید معتبر نیست.
  const b = await rawLogin(ACCOUNTS.operator.username, ACCOUNTS.operator.password, a.cookie);
  assert.equal((await mutation({ cookie: b.cookie, csrf: a.csrf, url: '/api/devices', body })).status, 403);
  assert.equal((await mutation({ cookie: a.cookie, csrf: a.csrf, url: '/api/devices', body })).status, 401);

  const ok = await mutation({ cookie: b.cookie, csrf: b.csrf, url: '/api/devices', body });
  assert.equal(ok.status, 201);
  await mutation({ cookie: b.cookie, csrf: b.csrf, url: `/api/devices/${ok.data.id}`, method: 'DELETE' });
});

test('RBAC blocks direct HTTP privilege escalation for Viewer and Operator', async () => {
  const viewer = await rawLogin(ACCOUNTS.viewer.username, ACCOUNTS.viewer.password);
  const operator = await rawLogin(ACCOUNTS.operator.username, ACCOUNTS.operator.password);

  const viewerCases = [
    ['POST', '/api/devices', { name: 'p3-viewer-write', ip: '10.82.0.1' }],
    ['PUT', '/api/settings', { ping_interval: 30 }],
    ['POST', '/api/auth/users', { username: 'p3-escalate', password: PASSWORD, role: 'admin' }],
    ['GET', '/api/audit', undefined],
    ['GET', '/api/system/health', undefined],
    ['POST', '/api/engine/control/stop', {}],
  ];
  for (const [method, url, body] of viewerCases) {
    const res = await mutation({ cookie: viewer.cookie, csrf: viewer.csrf, method, url, body });
    assert.equal(res.status, 403, `viewer must not ${method} ${url}`);
  }

  const operatorCases = [
    ['PUT', '/api/settings', { ping_interval: 30 }],
    ['POST', '/api/auth/users', { username: 'p3-op-admin', password: PASSWORD, role: 'admin' }],
    ['GET', '/api/audit', undefined],
  ];
  for (const [method, url, body] of operatorCases) {
    const res = await mutation({ cookie: operator.cookie, csrf: operator.csrf, method, url, body });
    assert.equal(res.status, 403, `operator must not ${method} ${url}`);
  }

  // کاربر ساخته‌شده با نقش نمایشی، واقعاً Viewer است (نقش از بدنهٔ درخواست بالاتر نمی‌رود).
  await login(srv.base);
  const created = await api(srv.base, 'POST', '/api/auth/users', {
    username: 'p3-role-check',
    password: PASSWORD,
    role: 'viewer',
    permissions: ['users:manage'],
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.role, 'viewer');
  assert.equal(created.data.permissions.includes('users:manage'), false);
});

test('XSS, SQL injection and path traversal payloads are contained', async () => {
  await login(srv.base);
  const xss = '<img src=x onerror=alert(1)>';
  const created = await api(srv.base, 'POST', '/api/devices', { name: xss, ip: '10.83.0.1', monitoring_enabled: 0 });
  assert.equal(created.status, 201);

  const session = sessionFor(srv.base);
  const raw = await fetch(`${srv.base}/api/devices?search=${encodeURIComponent('onerror')}`, {
    headers: { cookie: session.cookie },
  });
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get('content-type'), /application\/json/);
  const text = await raw.text();
  assert.equal(text.includes('<img'), false, 'JSON must escape HTML metacharacters');
  assert.equal(JSON.parse(text).items[0].name, xss, 'stored value must round-trip safely');

  // SQL Injection در ورود و جست‌وجو
  const sqli = await rawLogin("' OR 1=1 --", 'anything');
  assert.equal(sqli.status, 401);
  assert.equal(sqli.setCookies.length, 0);
  const search = await api(srv.base, 'GET', `/api/devices?search=${encodeURIComponent("' OR 1=1 --")}&limit=${encodeURIComponent('1e999')}`);
  assert.equal(search.status, 200);
  assert.equal(Array.isArray(search.data.items), true);

  // Path Traversal در نام فایل MBTiles و پشتیبان
  const victim = '/etc/hostname';
  const before = fs.existsSync(victim) ? fs.readFileSync(victim, 'utf8') : null;
  const del = await mutation({ cookie: session.cookie, csrf: session.csrf, method: 'DELETE', url: '/api/mbtiles/files/..%2F..%2Fetc%2Fhostname' });
  assert.ok([200, 400, 404].includes(del.status));
  if (before !== null) assert.equal(fs.readFileSync(victim, 'utf8'), before, 'traversal must not delete outside data dir');

  const restore = await api(srv.base, 'POST', '/api/system/backups/restore', { name: '../../etc/passwd' });
  assert.equal(restore.status, 400);
});

test('file upload abuse is rejected without leaving temp files or crashing', async () => {
  await login(srv.base);
  const fake = await upload(srv.base, '/api/devices/import/preview', {
    filename: 'devices.xlsx',
    content: 'this is not a zip archive',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  assert.equal(fake.status, 400);
  assert.match(String(fake.data?.error), /ZIP|xlsx|محتو/i);

  const bomb = makeZip([
    { name: '[Content_Types].xml', compressed: 50, uncompressed: 10 * 1024 * 1024 },
    { name: 'xl/workbook.xml', compressed: 50, uncompressed: 10 * 1024 * 1024 },
  ]);
  const bombRes = await upload(srv.base, '/api/devices/import/preview', {
    filename: 'bomb.xlsx',
    content: bomb,
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  assert.equal(bombRes.status, 400);
  assert.match(String(bombRes.data?.error), /ZIP Bomb|فشرده/);

  const binaryCsv = await upload(srv.base, '/api/devices/import/preview', {
    filename: 'devices.csv',
    content: Buffer.from([0x4e, 0x00, 0x4d, 0xff, 0xfe]),
    type: 'text/csv',
  });
  assert.equal(binaryCsv.status, 400);

  const badTiles = await upload(srv.base, '/api/layers/upload', {
    filename: '../../escape.mbtiles',
    content: 'SQLite format 3\u0000 but not a database',
    type: 'application/octet-stream',
  });
  assert.equal(badTiles.status, 400);
  assert.equal(fs.existsSync('/tmp/escape.mbtiles'), false);
  const leftovers = fs.existsSync(path.join(dir, 'tmp'))
    ? fs.readdirSync(path.join(dir, 'tmp')).filter((name) => /\.upload$/.test(name))
    : [];
  assert.deepEqual(leftovers, [], 'invalid uploads must not leave temp files');

  assert.equal(srv.child.exitCode, null, 'server must survive malicious files');
  assert.equal((await api(srv.base, 'GET', '/api/health', undefined, { auth: false })).status, 200);
});

test('oversized, incomplete and deeply nested JSON are rejected without stack traces', async () => {
  const session = sessionFor(srv.base);
  const headers = {
    cookie: session.cookie,
    'x-csrf-token': session.csrf,
    origin: srv.base,
    'content-type': 'application/json',
  };
  const oversizedBody = JSON.stringify({ name: 'big', ip: '10.84.0.1', pad: 'x'.repeat(2.2 * 1024 * 1024) });
  const oversized = await fetch(`${srv.base}/api/devices`, { method: 'POST', headers, body: oversizedBody });
  assert.equal(oversized.status, 413);
  const oversizedText = await oversized.text();
  assert.equal(/stack|SQLITE|server\.js/i.test(oversizedText), false);

  const incomplete = await fetch(`${srv.base}/api/devices`, { method: 'POST', headers, body: '{"name":' });
  assert.equal(incomplete.status, 400);

  let nested = { value: 'x' };
  for (let i = 0; i < 12; i++) nested = { child: nested };
  const deep = await fetch(`${srv.base}/api/devices`, { method: 'POST', headers, body: JSON.stringify(nested) });
  assert.equal(deep.status, 400);

  assert.equal(srv.child.exitCode, null);
});

test('Probe to cloud metadata and reserved ranges is blocked', async () => {
  await login(srv.base);
  const meta = await api(srv.base, 'POST', '/api/devices', { name: 'p3-metadata', ip: '169.254.169.254', monitoring_enabled: 0 });
  assert.equal(meta.status, 201);
  const probe = await api(srv.base, 'GET', `/api/devices/${meta.data.id}/probe?mode=simulate`);
  assert.equal(probe.status, 403);
  assert.match(String(probe.data.error), /CLOUD_METADATA|مجاز نیست/);

  const reserved = await api(srv.base, 'POST', '/api/devices', { name: 'p3-multicast', ip: '224.0.0.1', monitoring_enabled: 0 });
  assert.equal(reserved.status, 201);
  assert.equal((await api(srv.base, 'GET', `/api/devices/${reserved.data.id}/probe?mode=simulate`)).status, 403);
});

test('secrets never leak into logs or audit rows', async () => {
  const logs = srv.logs();
  assert.equal(logs.includes(TEST_ADMIN.password), false, 'admin password leaked into logs');
  assert.equal(logs.includes(ACCOUNTS.viewer.password), false, 'user password leaked into logs');
  assert.equal(logs.includes(ACCOUNTS.locked.password), false, 'user password leaked into logs');
  assert.equal(logs.includes('nw_session='), false, 'session cookie leaked into logs');
  assert.equal(logs.includes('nw_csrf='), false, 'csrf cookie leaked into logs');
  assert.equal(/level":"error".{0,80}stack/i.test(logs), false, 'stack traces must not be logged as response data');

  const audit = await api(srv.base, 'GET', '/api/audit?pageSize=100');
  assert.equal(audit.status, 200);
  const text = JSON.stringify(audit.data);
  for (const secret of [TEST_ADMIN.password, ACCOUNTS.viewer.password, ACCOUNTS.locked.password]) {
    assert.equal(text.includes(secret), false);
  }
  const failedLogins = audit.data.items.filter((i) => i.action === 'auth.login' && !i.success);
  assert.ok(failedLogins.length >= 3, 'failed logins must be audited');
  const roleChanges = audit.data.items.filter((i) => i.action === 'user.manage' && i.success);
  assert.ok(roleChanges.length >= 2, 'role changes must be audited');
});

test('login attempts are rate limited per IP with Retry-After', async () => {
  const rateDir = useTempDataDir('phase3-rate');
  const rateServer = await startServer({
    dataDir: rateDir,
    engine: false,
    env: {
      NETWATCH_LOGIN_RATE_LIMIT_MAX: '3',
      NETWATCH_LOGIN_MAX_FAILURES: '100',
    },
  });
  try {
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${rateServer.base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: rateServer.base },
        body: JSON.stringify({ username: 'admin', password: `wrong-${i}` }),
      });
      statuses.push(res.status);
      if (res.status === 429) assert.ok(Number(res.headers.get('retry-after')) >= 1);
      await res.body?.cancel();
    }
    // ورود خودکار startServer یک واحد از سطل ۳تایی را مصرف کرده است.
    assert.equal(statuses[0], 401, statuses.join(','));
    assert.equal(statuses.at(-1), 429);
    const correct = await fetch(`${rateServer.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: rateServer.base },
      body: JSON.stringify(TEST_ADMIN),
    });
    assert.equal(correct.status, 429, 'the correct password must not bypass the limiter');
    await correct.body?.cancel();
  } finally {
    await rateServer.stop();
    cleanupDir(rateDir);
  }
});

test('administrative APIs are restricted to explicitly allowed networks', async () => {
  const netDir = useTempDataDir('phase3-admin-net');
  const netServer = await startServer({
    dataDir: netDir,
    engine: false,
    env: { NETWATCH_ADMIN_ALLOWED_CIDRS: '10.0.0.0/8' },
  });
  try {
    // ورود از loopback مجاز است، اما مسیرهای مدیریتی از 127.0.0.1 در 10/8 نیستند.
    const settings = await api(netServer.base, 'GET', '/api/settings');
    assert.equal(settings.status, 403);
    assert.match(String(settings.data?.error), /شبکه/);
    assert.equal((await api(netServer.base, 'GET', '/api/auth/users')).status, 403);
    assert.equal((await api(netServer.base, 'GET', '/api/audit')).status, 403);
    assert.equal((await api(netServer.base, 'GET', '/api/system/health')).status, 403);
    // مسیرهای عملیاتی غیرمدیریتی همچنان کار می‌کنند (کنترل نقش جدا است).
    assert.equal((await api(netServer.base, 'GET', '/api/devices')).status, 200);
  } finally {
    await netServer.stop();
    cleanupDir(netDir);
  }
});
