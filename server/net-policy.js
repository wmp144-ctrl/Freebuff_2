/**
 * NetWatch — سیاست شبکه برای Probe و اسکن فعال
 * ----------------------------------------------------------------
 * اسکن فعال (Probe، Ping دستی و بررسی موتور) فقط روی مقاصد مجاز انجام می‌شود.
 * محدوده‌ها از تنظیمات پایگاه‌داده (`probe_allowed_cidrs`)، متغیر محیطی
 * `NETWATCH_PROBE_ALLOWED_CIDRS` (اولویت بالاتر) خوانده می‌شوند.
 *
 * سخت‌سازی‌های این نسخه:
 *   • Link-Local (169.254.0.0/16 و fe80::/10) و Cloud Metadata به‌طور پیش‌فرض
 *     مسدودند و فقط با پرچم صریح مدیر باز می‌شوند.
 *   • IPv4-mapped IPv6 (`::ffff:10.0.0.1`) و IPv4-compatible (`::10.0.0.1`)
 *     پیش از مقایسه به IPv4 نرمال می‌شوند؛ پس محدودیت IPv4 با نوشتن آدرس
 *     به‌شکل IPv6 دور زده نمی‌شود.
 *   • مکانیزم‌های انتقال 6to4/Teredo/NAT64 پیش‌فرض مسدودند.
 *   • نام میزبان (در صورت استفاده) با DNS حل می‌شود و «همهٔ» آدرس‌های حاصل
 *     باید مجاز باشند؛ یک آدرس غیرمجاز کل درخواست را رد می‌کند.
 *   • Zone ID (`fe80::1%eth0`) پذیرفته نمی‌شود.
 */
import net from 'node:net';
import dns from 'node:dns/promises';

/**
 * پیش‌فرض امن: فقط شبکه‌های خصوصی و loopback. Link-Local، Metadata و
 * مکانیزم‌های انتقال عمداً در این فهرست نیستند.
 */
export const DEFAULT_PROBE_CIDRS = Object.freeze([
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '::1/128',
  'fc00::/7',
]);

/** مقاصدی که حتی با CIDR مجاز هم نباید بدون پرچم صریح Probe شوند */
export const METADATA_CIDRS = Object.freeze([
  '169.254.169.254/32', // AWS/GCP/Azure/Oracle IMDS
  '169.254.170.2/32', // AWS ECS task metadata
  '100.100.100.200/32', // Alibaba Cloud metadata
  'fd00:ec2::254/128', // AWS IMDS IPv6
]);

export const LINK_LOCAL_CIDRS = Object.freeze(['169.254.0.0/16', 'fe80::/10']);

const ALWAYS_BLOCKED_CIDRS = Object.freeze([
  '0.0.0.0/8', // «این شبکه» و آدرس نامشخص
  '224.0.0.0/4', // Multicast
  '240.0.0.0/4', // رزرو/ broadcast
  '::/128', // آدرس نامشخص
  'ff00::/8', // Multicast IPv6
]);

const TRANSITION_CIDRS = Object.freeze([
  '2002::/16', // 6to4
  '2001::/32', // Teredo
  '64:ff9b::/96', // NAT64
  '64:ff9b:1::/48', // NAT64 local-use
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
  // IPv4-mapped/compatible (::ffff:192.168.0.1): دو گروه آخر را هگز کنیم
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

/**
 * نرمال‌سازی آدرس برای تصمیم امنیتی. Zone ID حذف/رد می‌شود و آدرس‌های
 * IPv4-mapped/compatible به IPv4 تبدیل می‌شوند تا با همان قواعد IPv4 سنجیده
 * شوند.
 * @returns {{version:4|6,address:string,mapped:boolean}|null}
 */
export function canonicalizeIp(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value.length > 80) return null;
  // آدرس دارای zone (مثل fe80::1%eth0) برای تصمیم شبکه مبهم است؛ رد می‌شود.
  if (value.includes('%')) return null;
  const version = net.isIP(value);
  if (!version) return null;
  if (version === 4) return { version: 4, address: value, mapped: false };
  const lower = value.toLowerCase();
  let m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (m && ipv4ToBigInt(m[1]) !== null) return { version: 4, address: m[1], mapped: true };
  m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (m) {
    const hi = parseInt(m[1], 16);
    const lo = parseInt(m[2], 16);
    return { version: 4, address: `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`, mapped: true };
  }
  m = /^::(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (m && ipv4ToBigInt(m[1]) !== null) return { version: 4, address: m[1], mapped: true };
  return { version: 6, address: lower, mapped: false };
}

/** @returns {{version:4|6,prefix:number,network:bigint,mask:bigint,source:string}|null} */
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

/**
 * مقایسهٔ IP با یک CIDR؛ خانوادهٔ نسخهٔ ۴ و ۶ هرگز با هم تطبیق داده نمی‌شوند.
 * این تابع عمداً «خام» است (بدون نرمال‌سازی mapped) تا رفتار ریاضی CIDR
 * قابل‌پیش‌بینی و قابل‌آزمون بماند؛ تصمیم Probe از canonicalizeIp استفاده
 * می‌کند.
 */
export function ipInCidr(ip, cidr) {
  const parsed = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  if (!parsed) return false;
  const version = net.isIP(String(ip || '').trim());
  if (!version || version !== parsed.version) return false;
  const bits = version === 4 ? ipv4ToBigInt(ip) : ipv6ToBigInt(ip);
  if (bits === null) return false;
  return (bits & parsed.mask) === parsed.network;
}

/** تطبیق آدرس canonical با CIDR (نگاشت IPv4-mapped پیش‌تر انجام شده است) */
function canonicalInCidr(canonical, cidr) {
  if (!canonical || !cidr || canonical.version !== cidr.version) return false;
  const bits = canonical.version === 4 ? ipv4ToBigInt(canonical.address) : ipv6ToBigInt(canonical.address);
  if (bits === null) return false;
  return (bits & cidr.mask) === cidr.network;
}

/** آیا آدرس در یکی از فهرست‌های CIDR داده‌شده است؟ */
export function ipInAnyCidr(ip, cidrs) {
  const canonical = typeof ip === 'string' ? canonicalizeIp(ip) : ip;
  if (!canonical) return false;
  for (const raw of cidrs || []) {
    const parsed = typeof raw === 'string' ? parseCidr(raw) : raw;
    if (parsed && canonicalInCidr(canonical, parsed)) return true;
  }
  return false;
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

/**
 * محدوده‌های مؤثر: متغیر محیطی > تنظیمات > پیش‌فرض امن.
 * اگر مقدار محیطی نامعتبر باشد (مثلاً از یک نسخهٔ قدیمی/اسکریپت)، به‌جای
 * بازکردن همه‌چیز به پیش‌فرض امن برمی‌گردیم؛ راه‌اندازی سرور چنین مقداری را
 * پیش‌تر در config.js رد می‌کند.
 */
export function resolveProbeCidrs(settings = {}) {
  const envRaw = process.env.NETWATCH_PROBE_ALLOWED_CIDRS;
  if (envRaw !== undefined && String(envRaw).trim() !== '') {
    const fromEnv = normalizeCidrList(String(envRaw));
    return fromEnv && fromEnv.length ? fromEnv : [...DEFAULT_PROBE_CIDRS];
  }
  const fromSettings = normalizeCidrList(settings?.probe_allowed_cidrs);
  return fromSettings && fromSettings.length ? fromSettings : [...DEFAULT_PROBE_CIDRS];
}

function probePolicyFlags(settings = {}) {
  const env = process.env;
  const allowLinkLocal =
    env.NETWATCH_PROBE_ALLOW_LINK_LOCAL !== undefined
      ? ['1', 'true', 'yes', 'on'].includes(String(env.NETWATCH_PROBE_ALLOW_LINK_LOCAL).toLowerCase())
      : settings?.probe_allow_link_local === true;
  const allowMetadata =
    env.NETWATCH_PROBE_ALLOW_METADATA !== undefined
      ? ['1', 'true', 'yes', 'on'].includes(String(env.NETWATCH_PROBE_ALLOW_METADATA).toLowerCase())
      : settings?.probe_allow_metadata === true;
  const allowTransition =
    env.NETWATCH_PROBE_ALLOW_TRANSITION !== undefined
      ? ['1', 'true', 'yes', 'on'].includes(String(env.NETWATCH_PROBE_ALLOW_TRANSITION).toLowerCase())
      : settings?.probe_allow_transition === true;
  return { allowLinkLocal, allowMetadata, allowTransition };
}

/**
 * آیا Probe به این مقصد مجاز است؟
 * @returns {{allowed:boolean, reason:string|null, matched:string|null, cidrs:string[], address:string|null}}
 */
export function isProbeTargetAllowed(ip, settings = {}, policyFlags = null) {
  const cidrs = resolveProbeCidrs(settings);
  const flags = policyFlags || probePolicyFlags(settings);
  const target = String(ip ?? '').trim();
  const canonical = canonicalizeIp(target);
  if (!canonical) {
    return { allowed: false, reason: 'INVALID_ADDRESS', matched: null, cidrs, address: null };
  }
  if (ipInAnyCidr(canonical, ALWAYS_BLOCKED_CIDRS)) {
    return { allowed: false, reason: 'RESERVED_RANGE', matched: null, cidrs, address: canonical.address };
  }
  const isMetadata = ipInAnyCidr(canonical, METADATA_CIDRS);
  if (isMetadata && !flags.allowMetadata) {
    return { allowed: false, reason: 'CLOUD_METADATA', matched: null, cidrs, address: canonical.address };
  }
  // metadata معمولاً در محدودهٔ link-local است؛ بازکردن صریح metadata نباید
  // کل 169.254.0.0/16 را باز کند و برعکس.
  if (!isMetadata && !flags.allowLinkLocal && ipInAnyCidr(canonical, LINK_LOCAL_CIDRS)) {
    return { allowed: false, reason: 'LINK_LOCAL', matched: null, cidrs, address: canonical.address };
  }
  if (!flags.allowTransition && canonical.version === 6 && ipInAnyCidr(canonical, TRANSITION_CIDRS)) {
    return { allowed: false, reason: 'TRANSITION_MECHANISM', matched: null, cidrs, address: canonical.address };
  }
  for (const cidr of cidrs) {
    const parsed = parseCidr(cidr);
    if (parsed && canonicalInCidr(canonical, parsed)) {
      return { allowed: true, reason: null, matched: cidr, cidrs, address: canonical.address };
    }
  }
  return { allowed: false, reason: 'NOT_IN_ALLOWLIST', matched: null, cidrs, address: canonical.address };
}

function looksLikeHostname(value) {
  const v = String(value ?? '').trim();
  if (!v || v.length > 253) return false;
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(v);
}

/**
 * بررسی مقصد Probe با پشتیبانی از نام میزبان: همهٔ آدرس‌های حاصل از DNS
 * باید مجاز باشند. اگر حل ناموفق باشد یا یکی از آدرس‌ها غیرمجاز باشد،
 * درخواست رد می‌شود (DNS rebinding / دورزدن allowlist).
 * @returns {Promise<{allowed:boolean,reason:string|null,addresses:string[],matched:string|null,cidrs:string[]}>}
 */
export async function checkProbeTarget(host, settings = {}) {
  const direct = canonicalizeIp(host);
  if (direct) {
    const result = isProbeTargetAllowed(direct.address, settings);
    return { ...result, addresses: [direct.address] };
  }
  if (!looksLikeHostname(host)) {
    return { allowed: false, reason: 'INVALID_ADDRESS', addresses: [], matched: null, cidrs: resolveProbeCidrs(settings) };
  }
  let rows;
  try {
    rows = await dns.lookup(String(host).trim(), { all: true, verbatim: true });
  } catch {
    return { allowed: false, reason: 'DNS_FAILED', addresses: [], matched: null, cidrs: resolveProbeCidrs(settings) };
  }
  const addresses = [];
  for (const row of rows || []) {
    const canonical = canonicalizeIp(row.address);
    if (!canonical) continue;
    const result = isProbeTargetAllowed(canonical.address, settings);
    addresses.push(canonical.address);
    if (!result.allowed) return { ...result, addresses };
  }
  if (!addresses.length) {
    return { allowed: false, reason: 'DNS_EMPTY', addresses, matched: null, cidrs: resolveProbeCidrs(settings) };
  }
  return { allowed: true, reason: null, addresses, matched: null, cidrs: resolveProbeCidrs(settings) };
}

export default {
  DEFAULT_PROBE_CIDRS,
  METADATA_CIDRS,
  LINK_LOCAL_CIDRS,
  canonicalizeIp,
  parseCidr,
  isValidCidr,
  ipInCidr,
  ipInAnyCidr,
  normalizeCidrList,
  resolveProbeCidrs,
  isProbeTargetAllowed,
  checkProbeTarget,
};
