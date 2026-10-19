/**
 * آزمون سخت‌سازی سیاست شبکه:
 *   • Link-Local و Cloud Metadata پیش‌فرض مسدود؛ فقط با پرچم صریح باز می‌شوند.
 *   • IPv4-mapped IPv6 و IPv4-compatible پیش از مقایسه به IPv4 نرمال می‌شوند.
 *   • مکانیزم‌های انتقال 6to4/Teredo/NAT64 پیش‌فرض مسدودند.
 *   • Zone ID و آدرس نامعتبر رد می‌شوند.
 *   • نام میزبان با همهٔ آدرس‌های DNS سنجیده می‌شود.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROBE_CIDRS,
  canonicalizeIp,
  isProbeTargetAllowed,
  checkProbeTarget,
  resolveProbeCidrs,
  ipInCidr,
} from '../../net-policy.js';

const allow10 = { probe_allowed_cidrs: ['10.0.0.0/8'] };

test('defaults exclude link-local, metadata and transition ranges', () => {
  assert.equal(DEFAULT_PROBE_CIDRS.includes('169.254.0.0/16'), false);
  assert.equal(DEFAULT_PROBE_CIDRS.includes('fe80::/10'), false);
  assert.equal(isProbeTargetAllowed('169.254.169.254', {}).allowed, false);
  assert.equal(isProbeTargetAllowed('169.254.169.254', {}).reason, 'CLOUD_METADATA');
  assert.equal(isProbeTargetAllowed('169.254.10.10', {}).reason, 'LINK_LOCAL');
  assert.equal(isProbeTargetAllowed('fe80::1', {}).reason, 'LINK_LOCAL');
  assert.equal(isProbeTargetAllowed('fd00:ec2::254', {}).reason, 'CLOUD_METADATA');
  assert.equal(isProbeTargetAllowed('10.1.2.3', {}).allowed, true);
  assert.equal(isProbeTargetAllowed('2001:db8::1', {}).allowed, false);
  assert.equal(ipInCidr('10.1.2.3', '10.0.0.0/8'), true);
});

test('IPv4-mapped and compatible IPv6 cannot bypass the IPv4 allowlist', () => {
  assert.deepEqual(canonicalizeIp('::ffff:10.1.2.3'), { version: 4, address: '10.1.2.3', mapped: true });
  assert.equal(isProbeTargetAllowed('::ffff:10.1.2.3', allow10).allowed, true);
  assert.equal(isProbeTargetAllowed('::ffff:8.8.8.8', allow10).allowed, false);
  assert.equal(isProbeTargetAllowed('::10.1.2.3', allow10).allowed, true);
  assert.equal(isProbeTargetAllowed('::8.8.8.8', allow10).allowed, false);
  // Mapped metadata: نشانی IPv6 نباید قید metadata را دور بزند
  assert.equal(
    isProbeTargetAllowed('::ffff:169.254.169.254', { probe_allowed_cidrs: ['169.254.0.0/16'] }).reason,
    'CLOUD_METADATA'
  );
  // خود ::ffff:10.0.0.1 به‌عنوان CIDR نسخهٔ ۶ با IPv4 مخلوط نمی‌شود (رفتار ریاضی)
  assert.equal(ipInCidr('::ffff:10.0.0.1', '10.0.0.0/8'), false);
});

test('metadata and link-local require explicit admin opt-in', () => {
  assert.equal(
    isProbeTargetAllowed('169.254.169.254', { probe_allowed_cidrs: ['169.254.169.254/32'], probe_allow_metadata: true }).allowed,
    true
  );
  assert.equal(
    isProbeTargetAllowed('169.254.10.10', { probe_allowed_cidrs: ['169.254.0.0/16'], probe_allow_link_local: true }).allowed,
    true
  );
  // پرچم metadata، link-local عمومی را باز نمی‌کند
  assert.equal(
    isProbeTargetAllowed('169.254.10.10', { probe_allowed_cidrs: ['169.254.0.0/16'], probe_allow_metadata: true }).reason,
    'LINK_LOCAL'
  );
});

test('transition mechanisms are blocked unless explicitly enabled', () => {
  assert.equal(isProbeTargetAllowed('2002:0a00:0001::1', { probe_allowed_cidrs: ['2002::/16'] }).reason, 'TRANSITION_MECHANISM');
  assert.equal(isProbeTargetAllowed('2001:0000:4136:e378::1', { probe_allowed_cidrs: ['2001::/32'] }).reason, 'TRANSITION_MECHANISM');
  assert.equal(isProbeTargetAllowed('64:ff9b::a00:1', { probe_allowed_cidrs: ['64:ff9b::/96'] }).reason, 'TRANSITION_MECHANISM');
  assert.equal(
    isProbeTargetAllowed('2002:0a00:0001::1', { probe_allowed_cidrs: ['2002::/16'], probe_allow_transition: true }).allowed,
    true
  );
});

test('invalid/ambiguous addresses and zones are rejected', () => {
  assert.equal(canonicalizeIp('fe80::1%eth0'), null);
  assert.equal(isProbeTargetAllowed('fe80::1%eth0', {}).reason, 'INVALID_ADDRESS');
  assert.equal(isProbeTargetAllowed('not-an-ip', {}).allowed, false);
  assert.equal(isProbeTargetAllowed('224.0.0.1', { probe_allowed_cidrs: ['224.0.0.0/4'] }).reason, 'RESERVED_RANGE');
  assert.equal(isProbeTargetAllowed('0.0.0.0', { probe_allowed_cidrs: ['0.0.0.0/0'] }).reason, 'RESERVED_RANGE');
});

test('hostname resolution checks every resolved address', async () => {
  const local = await checkProbeTarget('localhost', {});
  assert.equal(local.allowed, true);
  assert.ok(local.addresses.length >= 1);
  assert.ok(local.addresses.every((a) => a === '127.0.0.1' || a === '::1'));

  const missing = await checkProbeTarget('does-not-exist.invalid', {});
  assert.equal(missing.allowed, false);
  assert.equal(missing.reason, 'DNS_FAILED');
});

test('an invalid env CIDR list falls back to the safe default (server rejects it earlier)', () => {
  const previous = process.env.NETWATCH_PROBE_ALLOWED_CIDRS;
  process.env.NETWATCH_PROBE_ALLOWED_CIDRS = '10.0.0.0/99';
  try {
    assert.deepEqual(resolveProbeCidrs({}), [...DEFAULT_PROBE_CIDRS]);
  } finally {
    if (previous === undefined) delete process.env.NETWATCH_PROBE_ALLOWED_CIDRS;
    else process.env.NETWATCH_PROBE_ALLOWED_CIDRS = previous;
  }
});
