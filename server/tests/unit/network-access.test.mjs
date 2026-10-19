/**
 * آزمون واحد محدودیت شبکه‌ای APIهای مدیریتی.
 * گارد فقط روی مسیرهای مدیریتی اثر دارد و RBAC را جایگزین نمی‌شود.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminNetworkGuard } from '../../network-access.js';

function fakeRes() {
  const state = { status: 200, body: null, headers: {} };
  return {
    state,
    setHeader(name, value) {
      state.headers[name.toLowerCase()] = value;
    },
    status(code) {
      state.status = code;
      return this;
    },
    json(body) {
      state.body = body;
      return this;
    },
  };
}

function run(guard, { ip = '127.0.0.1', path = '/settings', method = 'GET', user = { username: 'admin' } } = {}) {
  const req = { ip, path, method, user };
  const res = fakeRes();
  let nextCalled = false;
  guard(req, res, () => {
    nextCalled = true;
  });
  return { nextCalled, res: res.state };
}

test('without an allowlist the guard never blocks', () => {
  const guard = createAdminNetworkGuard({ adminCidrs: null });
  assert.equal(run(guard, { ip: '203.0.113.5' }).nextCalled, true);
});

test('admin endpoints are limited to the configured networks', () => {
  const guard = createAdminNetworkGuard({ adminCidrs: ['10.0.0.0/8', '192.168.10.0/24'] });
  assert.equal(run(guard, { ip: '10.2.3.4' }).nextCalled, true);
  assert.equal(run(guard, { ip: '192.168.10.9' }).nextCalled, true);

  const denied = run(guard, { ip: '127.0.0.1' });
  assert.equal(denied.nextCalled, false);
  assert.equal(denied.res.status, 403);
  assert.match(denied.res.body.error, /شبکه/);
  assert.equal(denied.res.headers['cache-control'], 'no-store');

  // IPv4-mapped IPv6 با همان قواعد IPv4 سنجیده می‌شود
  assert.equal(run(guard, { ip: '::ffff:10.2.3.4' }).nextCalled, true);
});

test('non-admin paths stay available from other networks', () => {
  const guard = createAdminNetworkGuard({ adminCidrs: ['10.0.0.0/8'] });
  assert.equal(run(guard, { ip: '127.0.0.1', path: '/devices' }).nextCalled, true);
  assert.equal(run(guard, { ip: '127.0.0.1', path: '/dashboard/summary' }).nextCalled, true);
  assert.equal(run(guard, { ip: '127.0.0.1', path: '/auth/login', method: 'POST' }).nextCalled, true);
});

test('every sensitive administrative prefix is covered', () => {
  const guard = createAdminNetworkGuard({ adminCidrs: ['10.0.0.0/8'] });
  for (const path of [
    '/settings',
    '/auth/users',
    '/auth/users/7/unlock',
    '/audit',
    '/system/health',
    '/system/backups/restore',
    '/engine/control/stop',
  ]) {
    assert.equal(run(guard, { ip: '127.0.0.1', path, method: 'POST' }).nextCalled, false, `${path} must be blocked`);
  }
});
