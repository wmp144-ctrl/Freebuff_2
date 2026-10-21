/**
 * آزمون کارخواه SNMP داخلی (بدون وابستگی خارجی):
 *   • کدگذاری/تجزیهٔ BER و OID
 *   • خواندن Counter64/Gauge32/Integer از یک عامل SNMP ساختگی محلی
 *   • مهلت و خطای عدم پاسخ
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildGetRequest, interfaceOids, readTlv, snmpGet } from '../../snmp.js';
import { startSnmpMock } from '../snmp-mock.mjs';

let agent;
let port;

before(async () => {
  const oids = interfaceOids(3);
  agent = await startSnmpMock({
    values: () => ({
      [oids.inOctets]: { type: 'counter64', value: '9000000000' },
      [oids.outOctets]: { type: 'counter64', value: '7000000000' },
      [oids.highSpeed]: { type: 'gauge32', value: 1000 },
      [oids.operStatus]: { value: 1 },
    }),
  });
  port = agent.port;
});

after(() => {
  agent?.close();
});

test('OID and request encoding round-trip through a local SNMP agent', async () => {
  const oids = Object.values(interfaceOids(3));
  const res = await snmpGet({ host: '127.0.0.1', port, community: 'netwatch', oids, timeoutMs: 1000, retries: 1 });
  assert.equal(res.errorStatus, 0);
  assert.equal(res.values.get(oids[0]).value, 9000000000n);
  assert.equal(res.values.get(oids[1]).value, 7000000000n);
  assert.equal(res.values.get(oids[2]).value, 1000n);
  assert.equal(res.values.get(oids[3]).value, 1n);
  assert.equal(agent.requests(), 1);

  const request = buildGetRequest(oids, { requestId: 42 });
  const message = readTlv(request, 0);
  const version = readTlv(message.value, 0);
  const community = readTlv(message.value, version.end);
  const pdu = readTlv(message.value, community.end);
  assert.equal(pdu.tag, 0xa0);
  assert.equal(readTlv(pdu.value, 0).value[0], 42);
});

test('SNMP client reports timeout instead of guessing a value', async () => {
  await assert.rejects(
    () => snmpGet({ host: '127.0.0.2', port: 65534, oids: [interfaceOids(1).inOctets], timeoutMs: 250, retries: 1 }),
    (error) => error.code === 'SNMP_TIMEOUT'
  );
});

test('invalid SNMP agent address is rejected before any socket use', async () => {
  await assert.rejects(
    () => snmpGet({ host: 'example.com', oids: [interfaceOids(1).inOctets] }),
    (error) => error.code === 'SNMP_ADDRESS'
  );
});

