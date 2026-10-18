/**
 * آزمون واحد اجزای امنیتی: RBAC، سیاست CIDR، اعتبارسنجی ورودی و CSV Injection.
 * این آزمون‌ها وابسته به سرور یا پایگاه‌داده نیستند.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeRole, hasPermission, permissionsForRole, requirePermission, routePermission } from '../../permissions.js';
import { parseCidr, ipInCidr, isValidCidr, normalizeCidrList, isProbeTargetAllowed, DEFAULT_PROBE_CIDRS } from '../../net-policy.js';
import { hasDangerousKeys, isPlainObject, positiveInt } from '../../validation.js';
import { sanitizeSpreadsheetValue, buildWorkbook, workbookToBuffer } from '../../impexp.js';

test('roles normalize aliases and expose the expected permissions', () => {
  assert.equal(normalizeRole('admin'), 'admin');
  assert.equal(normalizeRole('Administrator'), 'admin');
  assert.equal(normalizeRole('OPERATOR'), 'operator');
  assert.equal(normalizeRole('viewer'), 'viewer');
  assert.equal(normalizeRole('root'), null);

  const viewer = { role: 'viewer' };
  assert.equal(hasPermission(viewer, 'devices:read'), true);
  assert.equal(hasPermission(viewer, 'devices:write'), false);
  assert.equal(hasPermission(viewer, 'probe:run'), false);
  assert.equal(hasPermission(viewer, 'settings:write'), false);

  const operator = { role: 'operator' };
  assert.equal(hasPermission(operator, 'devices:write'), true);
  assert.equal(hasPermission(operator, 'probe:run'), true);
  assert.equal(hasPermission(operator, 'engine:control'), true);
  assert.equal(hasPermission(operator, 'settings:write'), false, 'Operator must not change administrative settings');
  assert.equal(hasPermission(operator, 'users:manage'), false);
  assert.equal(hasPermission(operator, 'audit:read'), false);
  assert.equal(hasPermission(operator, 'demo:reset'), false);

  const admin = { role: 'admin' };
  for (const p of permissionsForRole('admin')) assert.equal(hasPermission(admin, p), true, p);
  // نقش ناشناخته هیچ مجوزی ندارد
  assert.equal(hasPermission({ role: 'nope' }, 'devices:read'), false);
});

test('permission middleware denies missing user and insufficient role', () => {
  const call = (mw, req) => {
    const res = {
      statusCode: null,
      body: null,
      setHeader() {},
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    let next = false;
    mw(req, res, () => (next = true));
    return { res, next };
  };
  assert.equal(call(requirePermission('devices:read'), {}).res.statusCode, 401);
  assert.equal(call(requirePermission('devices:write'), { user: { role: 'viewer' } }).res.statusCode, 403);
  assert.equal(call(requirePermission('devices:read'), { user: { role: 'viewer' } }).next, true);

  const moduleGuard = routePermission({ read: 'devices:read', write: 'devices:write' });
  assert.equal(call(moduleGuard, { method: 'GET', user: { role: 'viewer' } }).next, true);
  assert.equal(call(moduleGuard, { method: 'POST', user: { role: 'viewer' } }).res.statusCode, 403);
  assert.equal(call(moduleGuard, { method: 'POST', user: { role: 'operator' } }).next, true);
});

test('CIDR policy matches IPv4/IPv6 and rejects out-of-range targets', () => {
  assert.equal(isValidCidr('10.0.0.0/8'), true);
  assert.equal(isValidCidr('10.0.0.0/33'), false);
  assert.equal(isValidCidr('999.1.1.1/8'), false);
  assert.equal(parseCidr('not-a-cidr'), null);

  assert.equal(ipInCidr('10.5.4.3', '10.0.0.0/8'), true);
  assert.equal(ipInCidr('11.5.4.3', '10.0.0.0/8'), false);
  assert.equal(ipInCidr('192.168.1.1', '192.168.1.0/24'), true);
  assert.equal(ipInCidr('::1', '::1/128'), true);
  assert.equal(ipInCidr('fe80::1234', 'fe80::/10'), true);
  assert.ok(DEFAULT_PROBE_CIDRS.every((cidr) => ipInCidr('2001:db8::1', cidr) === false), 'public IPv6 must not be allowed by default');
  // نسخهٔ ۴ و ۶ با هم مخلوط نمی‌شوند
  assert.equal(ipInCidr('::ffff:10.0.0.1', '10.0.0.0/8'), false);

  assert.deepEqual(normalizeCidrList('10.0.0.0/8, 10.0.0.0/8, 192.168.0.0/16'), ['10.0.0.0/8', '192.168.0.0/16']);
  assert.equal(normalizeCidrList('10.0.0.0/8, bad'), null);

  assert.equal(isProbeTargetAllowed('192.168.5.5', { probe_allowed_cidrs: ['192.168.0.0/16'] }).allowed, true);
  assert.equal(isProbeTargetAllowed('8.8.8.8', { probe_allowed_cidrs: ['192.168.0.0/16'] }).allowed, false);
  // پیش‌فرض فقط شبکه‌های خصوصی است
  assert.equal(isProbeTargetAllowed('8.8.8.8', {}).allowed, false);
  assert.equal(isProbeTargetAllowed('10.0.0.1', {}).allowed, true);
});

test('request validation helpers reject dangerous structures', () => {
  assert.equal(isPlainObject({ a: 1 }), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(hasDangerousKeys(JSON.parse('{"a":{"__proto__":{"polluted":true}}}')), true);
  assert.equal(hasDangerousKeys({ a: { b: [1, 2, { constructor: 1 }] } }), true);
  assert.equal(hasDangerousKeys({ name: 'ok', nested: { list: [1, 2, 3] } }), false);
  assert.equal(positiveInt('12'), 12);
  assert.equal(positiveInt('-1'), null);
  assert.equal(positiveInt('1.5'), null);
});

test('spreadsheet exports neutralize CSV formula injection', () => {
  assert.equal(sanitizeSpreadsheetValue('=CMD|"/C calc"!A1'), '\'=CMD|"/C calc"!A1');
  assert.equal(sanitizeSpreadsheetValue('+1+2'), "'+1+2");
  assert.equal(sanitizeSpreadsheetValue('-2+3'), "'-2+3");
  assert.equal(sanitizeSpreadsheetValue('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(sanitizeSpreadsheetValue('\t=1'), "'\t=1");
  assert.equal(sanitizeSpreadsheetValue('safe text'), 'safe text');
  assert.equal(sanitizeSpreadsheetValue(42), 42, 'numbers stay numbers');

  const wb = buildWorkbook([{ name: '=HYPERLINK("http://evil")', ip: '10.0.0.1' }]);
  const csv = workbookToBuffer(wb, 'csv').toString('utf8');
  assert.ok(csv.includes('\'=HYPERLINK'), `formula cell must be prefixed: ${csv.slice(0, 120)}`);
  assert.ok(!/\n=HYPERLINK|,=HYPERLINK/.test(csv), 'no bare formula cell may remain');
});
