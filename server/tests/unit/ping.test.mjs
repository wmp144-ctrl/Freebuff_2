/**
 * لایهٔ Ping: اعتبارسنجی میزبان و آزادسازی منابع (تایمر/فرآیند).
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { icmpPing, tcpPing, isValidIp, isValidHost, probeIcmp } from '../../ping.js';

function listen(port = 0) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.end());
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

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

test('tcpPing separates network reachability from service availability (BUG-10)', async () => {
  // پورت بسته روی loopback: هسته با RST پاسخ می‌دهد؛ شبکه در دسترس است اما
  // سرویس روی آن پورت بالا نیست. پیش‌تر این حالت «قطع» شمرده می‌شد.
  const probePort = await (async () => {
    const { server, port } = await listen();
    await new Promise((resolve) => server.close(resolve));
    return port;
  })();
  const refused = await tcpPing('127.0.0.1', { port: probePort, timeoutMs: 500, count: 1 });
  assert.equal(refused.reachable, true, 'RST proves the host answered on the network');
  assert.equal(refused.ok, false, 'a closed service port is still a failed probe target');
  assert.equal(refused.service, 'unavailable');
  assert.equal(refused.servicePort, probePort);
  assert.equal(refused.packetsRecv, 0);
  assert.equal(refused.lossPct, 100);

  // پورت باز: هم شبکه و هم سرویس در دسترس است.
  const { server, port } = await listen();
  try {
    const open = await tcpPing('127.0.0.1', { port, timeoutMs: 500, count: 1 });
    assert.equal(open.reachable, true);
    assert.equal(open.ok, true);
    assert.equal(open.service, 'available');
    assert.ok(open.rtt > 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // ICMP فقط دسترسی شبکه را می‌سنجد و هرگز ادعای سلامت سرویس نمی‌کند.
  const icmp = await icmpPing('127.0.0.1', { timeoutMs: 300, count: 1 });
  if (icmp.ok) {
    assert.equal(icmp.reachable, true);
    assert.equal(icmp.service, 'unknown');
  }
});

test('tcpPing honours an abort signal and releases the socket', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await tcpPing('10.255.255.1', { port: 80, timeoutMs: 500, count: 1, signal: controller.signal });
  assert.equal(result.ok, false);
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
