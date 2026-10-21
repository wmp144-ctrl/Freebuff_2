/**
 * NetWatch — کارخواه SNMPv2c داخلی (بدون وابستگی خارجی)
 * ----------------------------------------------------------------
 * فقط برای سنجش شمارندهٔ اینترفیس لینک‌های دیاگرام استفاده می‌شود؛ به سرویس
 * اینترنتی وصل نمی‌شود و ترافیک آن UDP محلی/شبکهٔ مدیریت است.
 *
 * چرا پیاده‌سازی داخلی؟ پروژه کاملاً آفلاین نصب می‌شود و نباید برای یک GET
 * سادهٔ SNMP، بستهٔ اضافی یا کتابخانهٔ بومی اضافه کند. پیاده‌سازی فقط
 * SNMPv2c GET (OIDهای IF-MIB) را پوشش می‌دهد و پاسخ بزرگ‌تر از سقف را رد
 * می‌کند؛ پیام‌های Set/Trap و نسخه‌های دیگر پشتیبانی نمی‌شوند.
 */
import dgram from 'node:dgram';

export const SNMP_ERROR = {
  TIMEOUT: 'SNMP_TIMEOUT',
  RESPONSE: 'SNMP_RESPONSE',
  STATUS: 'SNMP_STATUS',
  ADDRESS: 'SNMP_ADDRESS',
};

export class SnmpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SnmpError';
    this.code = code;
  }
}

const MAX_PACKET = 4096;
const MAX_OIDS = 16;

/* --------------------------- BER encoder --------------------------- */

function encodeLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  let n = length;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function encodeTlv(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

export function encodeInteger(value) {
  const n = BigInt(value);
  if (n === 0n) return encodeTlv(0x02, Buffer.from([0]));
  const negative = n < 0n;
  let hex = (negative ? -n : n).toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes = Buffer.from(hex, 'hex');
  if (!negative && bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  if (negative && !(bytes[0] & 0x80)) bytes = Buffer.concat([Buffer.from([0xff]), bytes]);
  return encodeTlv(0x02, bytes);
}

/** کدگذاری OID عددی (مثلاً 1.3.6.1.2.1.2.2.1.8.3) */
export function encodeOid(oid) {
  const parts = String(oid)
    .split('.')
    .map((p) => Number(p));
  if (parts.length < 2 || parts.some((p) => !Number.isInteger(p) || p < 0)) {
    throw new SnmpError(SNMP_ERROR.RESPONSE, 'OID نامعتبر است.');
  }
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const stack = [part & 0x7f];
    let n = Math.floor(part / 128);
    while (n > 0) {
      stack.unshift((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    bytes.push(...stack);
  }
  return encodeTlv(0x06, Buffer.from(bytes));
}

/* --------------------------- BER decoder --------------------------- */

function decodeLength(buf, offset) {
  if (offset >= buf.length) throw new SnmpError(SNMP_ERROR.RESPONSE, 'بستهٔ SNMP ناقص است.');
  const first = buf[offset];
  if (!(first & 0x80)) return { length: first, next: offset + 1 };
  const count = first & 0x7f;
  if (!count || count > 4 || offset + 1 + count > buf.length) {
    throw new SnmpError(SNMP_ERROR.RESPONSE, 'طول BER نامعتبر است.');
  }
  let length = 0;
  for (let i = 0; i < count; i += 1) length = length * 256 + buf[offset + 1 + i];
  return { length, next: offset + 1 + count };
}

export function readTlv(buf, offset = 0) {
  if (offset >= buf.length) throw new SnmpError(SNMP_ERROR.RESPONSE, 'بستهٔ SNMP ناقص است.');
  const tag = buf[offset];
  const { length, next } = decodeLength(buf, offset + 1);
  const end = next + length;
  if (end > buf.length) throw new SnmpError(SNMP_ERROR.RESPONSE, 'طول TLV از بسته بیشتر است.');
  return { tag, value: buf.subarray(next, end), start: offset, end };
}

function decodeOid(value) {
  if (!value.length) return '';
  const first = value[0];
  const parts = [Math.floor(first / 40), first % 40];
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

function decodeVarbind(tlv) {
  if (tlv.tag !== 0x30) throw new SnmpError(SNMP_ERROR.RESPONSE, 'ساختار varbind نامعتبر است.');
  const oidTlv = readTlv(tlv.value, 0);
  if (oidTlv.tag !== 0x06) throw new SnmpError(SNMP_ERROR.RESPONSE, 'OID پاسخ نامعتبر است.');
  const valueTlv = readTlv(tlv.value, oidTlv.end);
  let value;
  switch (valueTlv.tag) {
    case 0x02:
    case 0x41:
    case 0x42:
    case 0x43: {
      let n = 0n;
      for (const byte of valueTlv.value) n = (n << 8n) | BigInt(byte);
      value = n;
      break;
    }
    case 0x46: {
      let n = 0n;
      for (const byte of valueTlv.value) n = (n << 8n) | BigInt(byte);
      value = n;
      break;
    }
    case 0x04:
      value = Buffer.from(valueTlv.value).toString('utf8');
      break;
    case 0x05:
      value = null;
      break;
    case 0x40:
      value = [...valueTlv.value].join('.');
      break;
    default:
      value = Buffer.from(valueTlv.value).subarray(0, 64).toString('hex');
  }
  return { oid: decodeOid(oidTlv.value), type: valueTlv.tag, value };
}

/**
 * ساخت درخواست GET (برای آزمون و استفادهٔ داخلی).
 * @param {string[]} oids
 * @param {{requestId?:number, community?:string}} options
 */
export function buildGetRequest(oids, { requestId = 1, community = 'public' } = {}) {
  const list = (Array.isArray(oids) ? oids : []).slice(0, MAX_OIDS);
  if (!list.length) throw new SnmpError(SNMP_ERROR.RESPONSE, 'فهرست OID خالی است.');
  const varbinds = Buffer.concat(
    list.map((oid) => encodeTlv(0x30, Buffer.concat([encodeOid(oid), encodeTlv(0x05, Buffer.alloc(0))])))
  );
  const pdu = encodeTlv(
    0xa0,
    Buffer.concat([
      encodeInteger(requestId),
      encodeInteger(0),
      encodeInteger(0),
      encodeTlv(0x30, varbinds),
    ])
  );
  return encodeTlv(
    0x30,
    Buffer.concat([encodeInteger(1), encodeTlv(0x04, Buffer.from(String(community), 'utf8')), pdu])
  );
}

/**
 * تجزیهٔ پاسخ GET.
 * @returns {{requestId:number, errorStatus:number, errorIndex:number, values:Map<string,{type:number,value:bigint|string|null}>}}
 */
export function parseGetResponse(buffer) {
  const message = readTlv(buffer, 0);
  if (message.tag !== 0x30) throw new SnmpError(SNMP_ERROR.RESPONSE, 'پیام SNMP نامعتبر است.');
  const version = readTlv(message.value, 0);
  if (version.tag !== 0x02) throw new SnmpError(SNMP_ERROR.RESPONSE, 'نسخهٔ SNMP نامعتبر است.');
  const community = readTlv(message.value, version.end);
  if (community.tag !== 0x04) throw new SnmpError(SNMP_ERROR.RESPONSE, 'community نامعتبر است.');
  const pdu = readTlv(message.value, community.end);
  if (pdu.tag !== 0xa2) throw new SnmpError(SNMP_ERROR.RESPONSE, 'پاسخ GetResponse دریافت نشد.');
  const requestId = readTlv(pdu.value, 0);
  const errorStatus = readTlv(pdu.value, requestId.end);
  const errorIndex = readTlv(pdu.value, errorStatus.end);
  const varbindList = readTlv(pdu.value, errorIndex.end);
  if (varbindList.tag !== 0x30) throw new SnmpError(SNMP_ERROR.RESPONSE, 'فهرست varbind نامعتبر است.');
  const values = new Map();
  let offset = 0;
  while (offset < varbindList.value.length) {
    const item = readTlv(varbindList.value, offset);
    const decoded = decodeVarbind(item);
    values.set(decoded.oid, { type: decoded.type, value: decoded.value });
    offset = item.end;
  }
  const intValue = (tlv) => {
    let n = 0;
    for (const byte of tlv.value) n = n * 256 + byte;
    return n;
  };
  return {
    requestId: intValue(requestId),
    errorStatus: intValue(errorStatus),
    errorIndex: intValue(errorIndex),
    values,
  };
}

/**
 * اجرای یک GET روی UDP. فقط IPv4 پذیرفته می‌شود تا DNS rebinding ممکن نباشد.
 * @param {{host:string, port?:number, community?:string, oids:string[], timeoutMs?:number, retries?:number}} options
 */
export function snmpGet({
  host,
  port = 161,
  community = 'public',
  oids,
  timeoutMs = 2000,
  retries = 1,
}) {
  const address = String(host || '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) {
    return Promise.reject(new SnmpError(SNMP_ERROR.ADDRESS, 'آدرس عامل SNMP باید IPv4 باشد.'));
  }
  const requestId = Math.floor(Math.random() * 0x7fffffff) + 1;
  const packet = buildGetRequest(oids, { requestId, community });
  const attempts = Math.max(1, Math.min(3, Number(retries) || 1));
  const timeout = Math.max(200, Math.min(10000, Number(timeoutMs) || 2000));

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    let timer = null;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* سوکت ممکن است بسته شده باشد */
      }
      if (error) reject(error);
      else resolve(result);
    };

    const attempt = (remaining) => {
      timer = setTimeout(() => {
        if (remaining > 1) attempt(remaining - 1);
        else finish(new SnmpError(SNMP_ERROR.TIMEOUT, 'پاسخی از عامل SNMP دریافت نشد.'));
      }, timeout);
      if (timer.unref) timer.unref();
      socket.send(packet, 0, packet.length, port, address, (err) => {
        if (err) finish(new SnmpError(SNMP_ERROR.ADDRESS, `ارسال بستهٔ SNMP ناموفق بود: ${err.message}`));
      });
    };

    socket.on('error', (err) => {
      finish(new SnmpError(SNMP_ERROR.ADDRESS, `خطای سوکت SNMP: ${err.message}`));
    });
    socket.on('message', (msg, rinfo) => {
      // پاسخ فقط از همان میزبان مقصد پذیرفته می‌شود (جلوگیری از تزریق پاسخ).
      if (String(rinfo?.address || '') !== address) return;
      if (msg.length > MAX_PACKET) {
        finish(new SnmpError(SNMP_ERROR.RESPONSE, 'پاسخ SNMP بیش از حد بزرگ است.'));
        return;
      }
      try {
        const response = parseGetResponse(msg);
        if (response.requestId !== requestId) return; // پاسخ درخواست دیگر
        if (response.errorStatus !== 0) {
          finish(
            new SnmpError(
              SNMP_ERROR.STATUS,
              `عامل SNMP خطا برگرداند (status=${response.errorStatus}, index=${response.errorIndex}).`
            )
          );
          return;
        }
        finish(null, { ...response, elapsedMs: 0 });
      } catch (err) {
        finish(err instanceof SnmpError ? err : new SnmpError(SNMP_ERROR.RESPONSE, String(err?.message || err)));
      }
    });
    attempt(attempts);
  });
}

/** OIDهای استاندارد IF-MIB برای یک ایندکس */
export function interfaceOids(ifIndex) {
  const index = Number(ifIndex);
  if (!Number.isInteger(index) || index <= 0) {
    throw new SnmpError(SNMP_ERROR.RESPONSE, 'شمارهٔ اینترفیس نامعتبر است.');
  }
  return {
    inOctets: `1.3.6.1.2.1.31.1.1.1.6.${index}`,
    outOctets: `1.3.6.1.2.1.31.1.1.1.10.${index}`,
    highSpeed: `1.3.6.1.2.1.31.1.1.1.15.${index}`,
    operStatus: `1.3.6.1.2.1.2.2.1.8.${index}`,
  };
}
