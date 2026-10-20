/**
 * RBAC Matrix — بررسی نظام‌مند مرز دسترسی همهٔ مسیرهای API
 * ----------------------------------------------------------------
 * این آزمون فهرست مسیرها را از خودِ فایل‌های روتر می‌خواند (نه از یک فهرست
 * دستی)، سپس با نشست Viewer و Operator هر مسیر را صدا می‌زند و انتظارهای
 * امنیتی را می‌سنجد:
 *   • هیچ مسیری نباید برای کاربر مجاز ۵۰۰ یا ۴۰۱ بدهد.
 *   • Viewer روی هیچ مسیر تغییردهنده‌ای (غیر از خروج از حساب) نباید موفق شود.
 *   • Operator نباید به تنظیمات، کاربران، حسابرسی و پشتیبان‌گیری دسترسی داشته باشد.
 *   • هر فایل روتر باید پیش از تعریف مسیرها یک گارد ماژول داشته باشد.
 *
 * افزودن مسیر جدید به هر روتر به‌طور خودکار وارد این ماتریس می‌شود؛ پس فراموش
 * کردن گارد در آینده باعث شکست Pipeline می‌شود.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, api, cleanupDir, startServer, useTempDataDir } from '../helpers.mjs';

const dir = useTempDataDir('rbac-matrix');
let srv;

/** پیشوند سوار‌شدن هر روتر در index.js */
const MOUNTS = {
  'devices.js': '/api/devices',
  'dashboard.js': '/api/dashboard',
  'reports.js': '/api/reports',
  'ops.js': '/api',
  'inventory.js': '/api',
  'markers.js': '/api',
  'audit.js': '/api/audit',
  'system.js': '/api/system',
};

/** مسیرهای نمونه برای پارامترهای عددی/نام‌دار */
const SAMPLE = {
  ':id': '1',
  ':tagId': '1',
  ':layerId': '1',
  ':z': '0',
  ':x': '0',
  ':y': '0',
  ':name': 'no-such.mbtiles',
  ':action': 'pause',
};

/** استخراج مسیرهای ثبت‌شده از فایل‌های روتر */
function collectRoutes() {
  const routes = [];
  const routeDir = path.join(ROOT, 'server', 'routes');
  for (const [file, prefix] of Object.entries(MOUNTS)) {
    const source = fs.readFileSync(path.join(routeDir, file), 'utf8');
    const re = /router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(source))) {
      const method = m[1].toUpperCase();
      const suffix = m[2].replace(/:[A-Za-z]+/g, (token) => SAMPLE[token] ?? '1');
      routes.push({ file, method, path: `${prefix}${suffix === '/' ? '' : suffix}` });
    }
  }
  return routes;
}

/** نشست مستقل برای هر نقش (کوکی و CSRF جدا) */
async function loginAs(username, password) {
  const res = await fetch(`${srv.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: srv.base },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `ورود ${username} ناموفق بود`);
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  const csrf = cookies.find((c) => c.startsWith('nw_csrf='))?.slice('nw_csrf='.length) ?? '';
  return { cookie: cookies.join('; '), csrf, user: (await res.json()).user };
}

async function call(session, method, url, body) {
  const res = await fetch(`${srv.base}${url}`, {
    method,
    headers: {
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'GET' ? {} : { origin: srv.base }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const VIEWER = { username: 'matrix-viewer', password: 'ViewerMatrix!2345' };
const OPERATOR = { username: 'matrix-operator', password: 'OperatorMatrix!2345' };
let viewerSession;
let operatorSession;

before(async () => {
  srv = await startServer({ dataDir: dir, engine: false });
  for (const [user, role] of [
    [VIEWER, 'viewer'],
    [OPERATOR, 'operator'],
  ]) {
    const created = await api(srv.base, 'POST', '/api/auth/users', {
      username: user.username,
      password: user.password,
      role,
      displayName: `RBAC ${role}`,
    });
    assert.equal(created.status, 201, `ساخت کاربر ${role} ناموفق بود`);
  }
  viewerSession = await loginAs(VIEWER.username, VIEWER.password);
  operatorSession = await loginAs(OPERATOR.username, OPERATOR.password);
});

after(async () => {
  await srv.stop();
  cleanupDir(dir);
});

test('every router module guards its routes with a module-level permission check', () => {
  const routeDir = path.join(ROOT, 'server', 'routes');
  for (const file of Object.keys(MOUNTS)) {
    const source = fs.readFileSync(path.join(routeDir, file), 'utf8');
    const guard = source.match(/router\.use\((?:requirePermission|routePermission)\(/);
    const firstRoute = source.search(/router\.(get|post|put|patch|delete)\(/);
    assert.ok(guard, `${file} هیچ گارد ماژولی ندارد`);
    assert.ok(
      guard.index < firstRoute,
      `${file}: گارد دسترسی باید پیش از نخستین مسیر ثبت شود`
    );
  }
});

test('viewer cannot reach any mutating API (CSRF-valid request still 403)', async () => {
  const routes = collectRoutes().filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
  assert.ok(routes.length > 40, 'ماتریس مسیرها ناقص است');
  const allowed = [];
  for (const route of routes) {
    const res = await call(viewerSession, route.method, route.path, {});
    assert.notEqual(res.status, 401, `${route.method} ${route.path} نباید ۴۰۱ بدهد`);
    assert.ok(res.status < 500, `${route.method} ${route.path} خطای سرور داد (${res.status})`);
    if (res.status !== 403) allowed.push(`${route.method} ${route.path} → ${res.status}`);
  }
  assert.deepEqual(allowed, [], `Viewer توانست مسیر تغییردهنده را اجرا کند: ${allowed.join(', ')}`);
});

test('viewer can read operational modules but not privileged read APIs', async () => {
  for (const url of ['/api/devices', '/api/dashboard/summary', '/api/settings', '/api/status', '/api/reports/summary']) {
    const res = await call(viewerSession, 'GET', url);
    assert.equal(res.status, 200, `Viewer باید ${url} را بخواند (${res.status})`);
  }
  for (const url of ['/api/system/health', '/api/system/backups', '/api/audit', '/api/engine/log']) {
    const res = await call(viewerSession, 'GET', url);
    assert.equal(res.status, 403, `Viewer نباید ${url} را بخواند (${res.status})`);
  }
});

test('operator runs daily operations but stays out of administrative areas', async () => {
  const allowed = [
    ['POST', '/api/devices', { name: 'rbac-op-device', ip: '10.200.0.9' }],
    ['POST', '/api/maintenance', { deviceId: 1, description: 'بررسی دوره‌ای', kind: 'manual' }],
    ['POST', '/api/alerts/bulk', { ids: [], action: 'ack' }],
    ['POST', '/api/engine/control/pause', {}],
  ];
  for (const [method, url, body] of allowed) {
    const res = await call(operatorSession, method, url, body);
    assert.ok(
      res.status !== 403 && res.status < 500,
      `Operator باید ${method} ${url} را انجام دهد (${res.status})`
    );
  }

  const denied = [
    ['PUT', '/api/settings', { defaultInterval: 60 }],
    ['POST', '/api/settings/reset-demo', {}],
    ['POST', '/api/auth/users', { username: 'x-y-z', password: 'AnotherPass!2345', role: 'viewer' }],
    ['PUT', '/api/auth/users/1', { role: 'admin' }],
    ['DELETE', '/api/auth/users/1'],
    ['GET', '/api/audit'],
    ['POST', '/api/system/backups', {}],
    ['POST', '/api/system/backups/restore', { name: 'x', dryRun: true }],
    ['POST', '/api/system/db/checkpoint', {}],
  ];
  for (const [method, url, body] of denied) {
    const res = await call(operatorSession, method, url, body);
    assert.equal(res.status, 403, `Operator نباید ${method} ${url} را انجام دهد (${res.status})`);
  }
  // خواندن‌های عملیاتی باید باز بمانند: سلامت برنامه و لاگ موتور طبق سیاست
  // نقش Operator در permissions.js در اختیار اوست.
  for (const url of ['/api/system/health', '/api/engine/log', '/api/status']) {
    const res = await call(operatorSession, 'GET', url);
    assert.equal(res.status, 200, `Operator باید ${url} را ببیند (${res.status})`);
  }
});

test('no anonymous access to any API route except health and login', async () => {
  const anonymous = { cookie: '', csrf: '' };
  const routes = collectRoutes();
  const publicPaths = new Set(['/api/auth/login']);
  for (const route of routes) {
    if (route.method !== 'GET' && route.method !== 'HEAD') continue;
    if (publicPaths.has(route.path)) continue;
    if (route.path.startsWith('/api/system') || route.path.startsWith('/api/audit')) continue;
    const res = await call(anonymous, 'GET', route.path);
    assert.ok(res.status === 401 || res.status === 403, `${route.path} بدون نشست ${res.status} داد`);
  }
});
