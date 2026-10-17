/**
 * لایهٔ Ping: اعتبارسنجی میزبان و آزادسازی منابع (تایمر/فرآیند).
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { icmpPing, tcpPing, isValidIp, isValidHost, probeIcmp } from '../../ping.js';

const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

after(() => {
  delete process.env.NETWATCH_PING_TEST;
});

test('isValidIp accepts real IPv4/IPv6 and rejects malformed values', () => {
  const good = ['127.0.0.1', '0.0.0.0', '255.255.255.255', '2001:db8::1', '::1', 'fe80::1%eth0'.split('%')[0]];
  for (const v of good) assert.equal(isValidIp(v), true, `expected valid: ${v}`);

  const bad = [
    '',
    ' ',
    'not-an-ip',
    '1.2.3',
    '1.2.3.4.5',
    '999.1.1.1',
    '01.2.3.4',
    '10.0.0.1; rm -rf /',
    '10.0.0.1 -f',
    ':::-',
    '1::2::3',
    '12345::',
    'localhost',
    null,
    undefined,
  ];
  for (const v of bad) assert.equal(isValidIp(v), false, `expected invalid: ${JSON.stringify(v)}`);
});

test('isValidHost still accepts DNS names but not option-like strings', () => {
  assert.equal(isValidHost('switch-1.local'), true);
  assert.equal(isValidHost('10.1.1.1'), true);
  assert.equal(isValidHost('-oProxyCommand=x'), false);
  assert.equal(isValidHost('a..b'), false);
});

test('tcpPing reports DNS failures as a normal down result instead of throwing', async () => {
  const result = await tcpPing('host-that-does-not-exist.invalid', { port: 80, timeoutMs: 300, count: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.rtt, null);
  assert.ok(result.error, 'an error code must be reported');
  assert.equal(result.mode, 'tcp');
});

test('icmpPing reports a missing ping binary instead of crashing', async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = '/nonexistent-path-for-netwatch-test';
  try {
    const result = await icmpPing('127.0.0.1', { timeoutMs: 200, count: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.packetsRecv, 0);
    assert.ok(result.error, 'spawn failure must be reported as an error, not a rejection');
  } finally {
    process.env.PATH = originalPath;
  }
});

test('icmpPing releases its hard-timeout timer on every path', async () => {
  await probeIcmp();
  const baseline = timeouts();
  for (let i = 0; i < 5; i++) {
    await icmpPing('127.0.0.1', { timeoutMs: 200, count: 1 });
  }
  const after = timeouts();
  assert.ok(after - baseline <= 1, `leaked ${after - baseline} timers after 5 pings`);
});
