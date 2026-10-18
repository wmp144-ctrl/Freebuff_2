/**
 * NetWatch — سیاست شبکه برای Probe و اسکن فعال
 * ----------------------------------------------------------------
 * اسکن فعال (Probe و Ping دستی) فقط روی محدوده‌های IP مجاز انجام می‌شود.
 * محدوده‌ها هم از تنظیمات پایگاه‌داده (`probe_allowed_cidrs`) و هم با
 * متغیر محیطی `NETWATCH_PROBE_ALLOWED_CIDRS` (اولویت بالاتر) خوانده می‌شوند.
 *
 * پیش‌فرض فقط شبکه‌های خصوصی/محلی است تا نصب تازه نتواند به‌عنوان ابزار
 * اسکن اینترنت به کار رود. هر تغییر آگاهانه باید توسط مدیر انجام شود.
 */
import net from 'node:net';

export const DEFAULT_PROBE_CIDRS = Object.freeze([
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
]);

const MAX_CIDRS = 64;

function ipv4ToBigInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let out = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = (out << 8n) | BigInt(n);
  }
  return out;
}

function ipv6ToBigInt(raw) {
  let ip = String(raw).trim().toLowerCase();
  if (!ip.includes('::') && ip.split(':').length !== 8) return null;
  // IPv4-mapped (::ffff:192.168.0.1): دو گروه آخر را هگز کنیم
  if (ip.includes('.')) {
    const lastColon = ip.lastIndexOf(':');
    const v4 = ip.slice(lastColon + 1);
    const n = ipv4ToBigInt(v4);
    if (n === null) return null;
    ip = ip.slice(0, lastColon + 1) + (n >> 16n).toString(16) + ':' + (n & 0xffffn).toString(16);
  }
  const [leftRaw, rightRaw] = ip.split('::');
  const left = leftRaw ? leftRaw.split(':') : [];
  const right = rightRaw ? rightRaw.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (ip.includes('::') ? missing < 0 : missing !== 0) return null;
  const groups = ip.includes('::') ? [...left, ...Array(missing).fill('0'), ...right] : left;
  if (groups.length !== 8) return null;
  let out = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    out = (out << 16n) | BigInt(parseInt(group, 16));
  }
  return out;
}

/** @returns {{version:4|6,prefix:number,network:bigint,source:string}|null} */
export function parseCidr(cidr) {
  const source = String(cidr ?? '').trim();
  if (!source || source.length > 64) return null;
  const slash = source.indexOf('/');
  const address = (slash < 0 ? source : source.slice(0, slash)).trim();
  const version = net.isIP(address);
  if (!version) return null;
  const max = version === 4 ? 32 : 128;
  const prefix = slash < 0 ? max : Number(source.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  const bits = version === 4 ? ipv4ToBigInt(address) : ipv6ToBigInt(address);
  if (bits === null) return null;
  const mask = prefix === 0 ? 0n : (((1n << BigInt(prefix)) - 1n) << BigInt(max - prefix));
  return { version, prefix, network: bits & mask, mask, source };
}

export function isValidCidr(cidr) {
  return Boolean(parseCidr(cidr));
}

/** مقایسهٔ IP با یک CIDR؛ خانوادهٔ نسخهٔ ۴ و ۶ هرگز با هم تطبیق داده نمی‌شوند */
export function ipInCidr(ip, cidr) {
  const parsed = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  if (!parsed) return false;
  const version = net.isIP(String(ip || '').trim());
  if (!version || version !== parsed.version) return false;
  const bits = version === 4 ? ipv4ToBigInt(ip) : ipv6ToBigInt(ip);
  if (bits === null) return false;
  return (bits & parsed.mask) === parsed.network;
}

/**
 * نرمال‌سازی فهرست CIDR. ورودی می‌تواند آرایه یا رشتهٔ جداشده با ویرگول باشد.
 * @returns {string[]|null} null یعنی ورودی نامعتبر است
 */
export function normalizeCidrList(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null;
  if (!raw) return null;
  const out = [];
  for (const item of raw) {
    const s = String(item ?? '').trim();
    if (!s) continue;
    if (!isValidCidr(s)) return null;
    const parsed = parseCidr(s);
    const canonical = `${parsed.source.split('/')[0]}/${parsed.prefix}`;
    if (!out.includes(canonical)) out.push(canonical);
    if (out.length > MAX_CIDRS) return null;
  }
  return out;
}

/** محدوده‌های مؤثر: متغیر محیطی > تنظیمات > پیش‌فرض امن */
export function resolveProbeCidrs(settings = {}) {
  const envRaw = process.env.NETWATCH_PROBE_ALLOWED_CIDRS;
  if (envRaw !== undefined && String(envRaw).trim() !== '') {
    const fromEnv = normalizeCidrList(String(envRaw));
    // مقدار نامعتبر در محیط، به‌جای بازکردن همه‌چیز، به پیش‌فرض امن برمی‌گردد.
    return fromEnv && fromEnv.length ? fromEnv : [...DEFAULT_PROBE_CIDRS];
  }
  const fromSettings = normalizeCidrList(settings?.probe_allowed_cidrs);
  return fromSettings && fromSettings.length ? fromSettings : [...DEFAULT_PROBE_CIDRS];
}

/**
 * آیا Probe به این مقصد مجاز است؟
 * @returns {{allowed:boolean, matched:string|null, cidrs:string[]}}
 */
export function isProbeTargetAllowed(ip, settings = {}) {
  const cidrs = resolveProbeCidrs(settings);
  const target = String(ip ?? '').trim();
  if (!net.isIP(target)) return { allowed: false, matched: null, cidrs };
  for (const cidr of cidrs) {
    if (ipInCidr(target, cidr)) return { allowed: true, matched: cidr, cidrs };
  }
  return { allowed: false, matched: null, cidrs };
}

export default {
  DEFAULT_PROBE_CIDRS,
  parseCidr,
  isValidCidr,
  ipInCidr,
  normalizeCidrList,
  resolveProbeCidrs,
  isProbeTargetAllowed,
};
