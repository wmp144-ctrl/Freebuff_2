/**
 * آزمون Rate Limiting:
 *   • سقف مستقل برای هر حوزه (اینجا دو لیمیتر جدا).
 *   • شمارش هم‌زمان IP و حساب کاربری.
 *   • سقف تعداد کلیدها و تخلیهٔ حافظه.
 *   • نرمال‌سازی IPv4-mapped و شمارش معکوس پنجره.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRateLimiter,
  normalizeClientIp,
  clientIp,
  isProbeRequest,
  isTopologyPollRequest,
} from '../../rate-limit.js';

function req({ ip = '10.0.0.1', user = null } = {}) {
  return { ip, socket: { remoteAddress: ip }, user };
}

function res() {
  const out = {
    headers: {},
    code: 200,
    body: null,
    setHeader(k, v) {
      this.headers[k] = String(v);
    },
    status(c) {
      this.code = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
  return out;
}

function call(mw, request) {
  const response = res();
  let next = false;
  mw(request, response, () => {
    next = true;
  });
  return { next, response };
}

test('generic limiter blocks after max and reports headers', () => {
  let now = 1_000_000;
  const mw = createRateLimiter({ name: 'test', windowMs: 60_000, max: 2, now: () => now });
  const r1 = call(mw, req({ ip: '10.0.0.1' }));
  const r2 = call(mw, req({ ip: '10.0.0.1' }));
  const r3 = call(mw, req({ ip: '10.0.0.1' }));
  assert.equal(r1.next, true);
  assert.equal(r2.next, true);
  assert.equal(r3.next, false);
  assert.equal(r3.response.code, 429);
  assert.ok(Number(r3.response.headers['Retry-After']) >= 1);
  assert.equal(r3.response.headers['X-RateLimit-Remaining'], '0');

  // IP دیگر مستقل است
  assert.equal(call(mw, req({ ip: '10.0.0.2' })).next, true);
  // پس از پنجره، همان IP دوباره مجاز است
  now += 60_001;
  assert.equal(call(mw, req({ ip: '10.0.0.1' })).next, true);
  mw.close();
});

test('separate scopes keep independent budgets', () => {
  const probe = createRateLimiter({ name: 'probe', windowMs: 60_000, max: 1 });
  const imports = createRateLimiter({ name: 'import', windowMs: 60_000, max: 5 });
  const r = req({ ip: '10.0.0.5' });
  assert.equal(call(probe, r).next, true);
  assert.equal(call(probe, r).next, false);
  // مصرف Probe سهم Import را کم نمی‌کند
  assert.equal(call(imports, r).next, true);
  probe.close();
  imports.close();
});

test('an account is limited even when the IP changes', () => {
  const mw = createRateLimiter({
    name: 'login',
    windowMs: 60_000,
    max: 10,
    userMax: 2,
    accountKey: (r) => r.body?.username,
  });
  const mk = (ip, username) => Object.assign(req({ ip }), { body: { username } });
  assert.equal(call(mw, mk('10.0.0.1', 'admin')).next, true);
  assert.equal(call(mw, mk('10.0.0.2', 'admin')).next, true);
  const blocked = call(mw, mk('10.0.0.3', 'admin'));
  assert.equal(blocked.next, false);
  assert.equal(blocked.response.headers['X-RateLimit-Scope'], 'account');
  // حساب دیگر از همان IP همچنان مجاز است (تا سقف IP)
  assert.equal(call(mw, mk('10.0.0.3', 'operator')).next, true);
  mw.close();
});

test('key storage is bounded and memory is measurable', () => {
  const mw = createRateLimiter({ name: 'bounded', windowMs: 60_000, max: 10, maxKeys: 100 });
  for (let i = 0; i < 260; i++) call(mw, req({ ip: `10.1.${Math.floor(i / 250)}.${i % 250}` }));
  const stats = mw.stats();
  assert.ok(stats.keys <= 100, `keys=${stats.keys}`);
  assert.ok(stats.evictions > 0, 'old keys must be evicted');
  assert.ok(stats.estimatedBytes > 0);
  assert.equal(stats.maxKeys, 100);
  mw.close();
  assert.equal(mw.stats().keys, 0, 'close() releases all state');
});

test('probe scope covers bulk ping, discovery and direct checks but not ordinary bulk edits', () => {
  assert.equal(isProbeRequest({ path: '/devices/12/ping' }), true);
  assert.equal(isProbeRequest({ path: '/devices/12/probe' }), true);
  assert.equal(isProbeRequest({ path: '/devices/bulk', body: { action: 'ping' } }), true);
  assert.equal(isProbeRequest({ path: '/devices/bulk', body: { action: 'enable' } }), false);
  assert.equal(isProbeRequest({ path: '/devices/bulk', body: {} }), false);
  assert.equal(isProbeRequest({ path: '/engine/check/3' }), true);
  assert.equal(isProbeRequest({ path: '/engine/check-all' }), true);
  assert.equal(isProbeRequest({ path: '/discovery/scan' }), true);
  assert.equal(isProbeRequest({ path: '/discovery/ranges/4/scan' }), true);
  assert.equal(isProbeRequest({ path: '/devices/12/series' }), false);

  assert.equal(isTopologyPollRequest({ path: '/topology/diagrams/1/status' }), true);
  assert.equal(isTopologyPollRequest({ path: '/topology/diagrams/1/analysis' }), true);
  assert.equal(isTopologyPollRequest({ path: '/topology/diagrams/1/impact' }), true);
  assert.equal(isTopologyPollRequest({ path: '/topology/diagrams/1/graph' }), false);
});

test('IPv4-mapped addresses share one bucket with their IPv4 form', () => {
  assert.equal(normalizeClientIp('::ffff:10.0.0.1'), '10.0.0.1');
  assert.equal(normalizeClientIp('10.0.0.1'), '10.0.0.1');
  assert.equal(normalizeClientIp('fe80::1%eth0'), 'fe80::1');
  assert.equal(clientIp({ ip: '::ffff:192.168.1.7' }), '192.168.1.7');

  const mw = createRateLimiter({ name: 'mapped', windowMs: 60_000, max: 1 });
  assert.equal(call(mw, req({ ip: '10.0.0.9' })).next, true);
  const same = call(mw, req({ ip: '::ffff:10.0.0.9' }));
  assert.equal(same.next, false, 'changing address form must not reset the counter');
  mw.close();
});
