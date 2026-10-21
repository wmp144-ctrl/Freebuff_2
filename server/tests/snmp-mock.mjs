/**
 * عامل SNMP ساختگی برای آزمون‌ها.
 * فقط درخواست GET را می‌فهمد و پاسخ GetResponse با مقادیر داده‌شده می‌سازد.
 * هیچ ارتباط بیرونی ندارد و روی 127.0.0.1 گوش می‌دهد.
 */
import dgram from 'node:dgram';
import { encodeInteger, encodeOid, encodeTlv, readTlv } from '../snmp.js';

export function counter64(value) {
  let n = BigInt(value);
  const bytes = [];
  do {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  } while (n > 0n);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return encodeTlv(0x46, Buffer.from(bytes));
}

export function gauge32(value) {
  const bytes = [];
  let n = Number(value);
  do {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  } while (n > 0);
  return encodeTlv(0x41, Buffer.from(bytes));
}

function decodeOid(value) {
  const parts = [Math.floor(value[0] / 40), value[0] % 40];
  let n = 0;
  for (let i = 1; i < value.length; i += 1) {
    n = n * 128 + (value[i] & 0x7f);
    if (!(value[i] & 0x80)) {
      parts.push(n);
      n = 0;
    }
  }
  return parts.join('.');
}

export function buildResponse(request, valuesByOid) {
  const message = readTlv(request, 0);
  const version = readTlv(message.value, 0);
  const community = readTlv(message.value, version.end);
  const pdu = readTlv(message.value, community.end);
  const requestId = readTlv(pdu.value, 0);
  const errorStatus = readTlv(pdu.value, requestId.end);
  const errorIndex = readTlv(pdu.value, errorStatus.end);
  const varbindList = readTlv(pdu.value, errorIndex.end);
  const varbinds = [];
  let offset = 0;
  while (offset < varbindList.value.length) {
    const item = readTlv(varbindList.value, offset);
    const oidTlv = readTlv(item.value, 0);
    const oid = decodeOid(oidTlv.value);
    const entry = valuesByOid[oid];
    const encoded =
      entry?.type === 'counter64'
        ? counter64(entry.value)
        : entry?.type === 'gauge32'
          ? gauge32(entry.value)
          : encodeInteger(entry?.value ?? 0);
    varbinds.push(encodeTlv(0x30, Buffer.concat([encodeOid(oid), encoded])));
    offset = item.end;
  }
  const responsePdu = encodeTlv(
    0xa2,
    Buffer.concat([
      Buffer.from(pdu.value.subarray(0, requestId.end)),
      encodeInteger(0),
      encodeInteger(0),
      encodeTlv(0x30, Buffer.concat(varbinds)),
    ])
  );
  return encodeTlv(
    0x30,
    Buffer.concat([encodeInteger(1), encodeTlv(0x04, Buffer.from(community.value)), responsePdu])
  );
}

/**
 * @param {{values: () => Record<string, object>}} options
 * @returns {Promise<{port:number, close:() => void, requests:() => number}>}
 */
export async function startSnmpMock({ values }) {
  const socket = dgram.createSocket('udp4');
  let count = 0;
  socket.on('message', (message, rinfo) => {
    count += 1;
    try {
      const response = buildResponse(message, values());
      socket.send(response, rinfo.port, rinfo.address);
    } catch {
      /* درخواست نامعتبر در آزمون نادیده گرفته می‌شود */
    }
  });
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return {
    port: socket.address().port,
    close: () => socket.close(),
    requests: () => count,
  };
}
