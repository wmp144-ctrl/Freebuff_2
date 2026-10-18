/**
 * NetWatch — ساخت گواهی داخلی برای اجرای HTTPS بدون اینترنت
 * ----------------------------------------------------------------
 * یک مرجع صدور گواهی (CA) محلی و یک گواهی سرور با نام‌های معتبر (SAN) برای
 * همان میزبان‌ها/IPهایی که سرویس روی آن‌ها شنود می‌کند می‌سازد. همه‌چیز محلی و
 * با `openssl` سیستم انجام می‌شود؛ هیچ درخواستی به اینترنت نمی‌رود و هیچ
 * سرویس بیرونی (Let's Encrypt و…) لازم نیست.
 *
 *   npm run tls:setup                       # فقط localhost و 127.0.0.1
 *   npm run tls:setup -- 192.168.10.20 netwatch.local
 *   npm run tls:setup -- --force 10.0.0.5   # بازسازی گواهی‌های موجود
 *
 * خروجی در `data/tls/`:
 *   ca.crt       → این فایل را در مرورگر/سیستم کلاینت‌ها به‌عنوان مرجع معتبر
 *                  وارد کنید (بدون آن مرورگر هشدار می‌دهد)
 *   ca.key       → کلید CA؛ روی سرور بماند و هرگز توزیع نشود
 *   server.crt   → گواهی سرور
 *   server.key   → کلید سرور (فقط خواندنی برای مالک فایل)
 *
 * اجرای سرور با این گواهی‌ها:
 *   NETWATCH_TLS_DIR=data/tls npm start
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const args = process.argv.slice(2);
const newCa = args.includes('--new-ca');
// --new-ca خودش بازسازی کامل است (CA تازه + گواهی سرور تازه امضاشده با همان)
const force = args.includes('--force') || newCa;
let outDir = process.env.NETWATCH_TLS_DIR || path.join(ROOT, 'data', 'tls');
let days = 397; // کمتر از سقف ۳۹۸ روزهٔ مرورگرها (برای سازگاری کامل)
let caDays = 3650;
const hosts = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--force' || a === '--new-ca') continue;
  if (a === '--out') {
    outDir = path.resolve(args[++i] || outDir);
    continue;
  }
  if (a === '--days') {
    days = Number(args[++i]) || days;
    continue;
  }
  if (a === '--ca-days') {
    caDays = Number(args[++i]) || caDays;
    continue;
  }
  if (a.startsWith('--')) {
    console.error(`گزینهٔ ناشناخته: ${a}`);
    process.exit(2);
  }
  hosts.push(a);
}

/* --------------------------- بررسی پیش‌نیازها --------------------------- */

function fail(message) {
  console.error(`\n  خطا: ${message}\n`);
  process.exit(1);
}

const opensslVersion = spawnSync('openssl', ['version'], { encoding: 'utf8' });
if (opensslVersion.error || opensslVersion.status !== 0) {
  fail(
    'برنامهٔ openssl روی این سیستم پیدا نشد. openssl در همهٔ توزیع‌های لینوکس به‌صورت پیش‌فرض هست؛ ' +
      'اگر نیست، بستهٔ آن را آفلاین نصب کنید (یا گواهی را روی سیستم دیگری با همان دستور بسازید و فقط فایل‌ها را کپی کنید).'
  );
}

const DNS_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const names = [];
for (const raw of ['localhost', '127.0.0.1', ...hosts]) {
  const host = String(raw).trim();
  if (!host || names.includes(host)) continue;
  if (net.isIP(host) || DNS_RE.test(host)) names.push(host);
  else fail(`نام/آدرس نامعتبر: «${host}» (فقط نام دامنه، IPv4 یا IPv6 مجاز است).`);
}
if (!names.length) fail('حداقل یک نام یا آدرس لازم است.');

const san = names.map((n) => (net.isIP(n) ? `IP:${n}` : `DNS:${n}`)).join(',');
const primary = names.find((n) => !net.isIP(n) && n !== 'localhost') || names[0];

fs.mkdirSync(outDir, { recursive: true });
const file = (name) => path.join(outDir, name);
const existing = ['ca.crt', 'ca.key', 'server.crt', 'server.key'].filter((f) => fs.existsSync(file(f)));
if (existing.length && !force) {
  fail(
    `گواهی‌های قبلی در ${outDir} وجود دارد (${existing.join(', ')}). برای تمدید گواهی سرور، دستور را با --force اجرا کنید ` +
      '(CA دست‌نخورده می‌ماند و کلاینت‌ها نیازی به وارد کردن مجدد ca.crt ندارند).'
  );
}
// CA فقط یک‌بار ساخته می‌شود؛ تا وقتی --new-ca ندهید، تمدید گواهی سرور با همان
// CA امضا می‌شود و اعتماد نصب‌شده روی کلاینت‌ها باطل نمی‌گردد.
const reuseCa = !newCa && fs.existsSync(file('ca.crt')) && fs.existsSync(file('ca.key'));

/* ------------------------------ اجرای openssl ------------------------------ */

function run(command, commandArgs, label) {
  const res = spawnSync(command, commandArgs, { cwd: outDir, encoding: 'utf8' });
  if (res.status !== 0) {
    fail(`${label} ناموفق بود:\n${(res.stderr || res.stdout || '').trim()}`);
  }
}

console.log(`\n  ساخت گواهی داخلی برای: ${names.join(', ')}`);
if (existing.length && force) {
  const remove = ['server.crt', 'server.key', 'server.csr', 'ca.srl', 'ext.cnf'];
  if (newCa || !reuseCa) remove.push('ca.crt', 'ca.key');
  for (const f of remove) fs.rmSync(file(f), { force: true });
}

// ۱) مرجع صدور محلی (CA) — یک‌بار ساخته می‌شود و کلاینت‌ها به آن اعتماد می‌کنند
if (reuseCa) {
  console.log('  CA موجود دوباره استفاده می‌شود (گواهی سرور تازه اما معتبر برای همان اعتماد نصب‌شده).');
} else {
  run(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:4096', '-sha256',
      '-days', String(caDays),
      '-nodes',
      '-keyout', 'ca.key',
      '-out', 'ca.crt',
      '-subj', '/CN=NetWatch Internal CA/O=NetWatch',
      '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    ],
    'ساخت CA'
  );
}

// ۲) کلید و درخواست امضای گواهی سرور
run(
  'openssl',
  ['req', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', `/CN=${primary}`],
  'ساخت CSR سرور'
);

// ۳) پسوندهای گواهی سرور: نام‌های معتبر (SAN) و کاربرد کلید
fs.writeFileSync(
  file('ext.cnf'),
  [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    `subjectAltName=${san}`,
    '# گواهی سرور؛ فقط با کلید CA محلی معتبر است',
    '',
  ].join('\n')
);

// ۴) امضای گواهی سرور با CA محلی
run(
  'openssl',
  [
    'x509', '-req',
    '-in', 'server.csr',
    '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
    '-out', 'server.crt',
    '-days', String(days),
    '-sha256',
    '-extfile', 'ext.cnf',
  ],
  'امضای گواهی سرور'
);

// ۵) پاک‌سازی فایل‌های میانی و سخت‌سازی دسترسی کلیدها
for (const f of ['server.csr', 'ca.srl', 'ext.cnf']) fs.rmSync(file(f), { force: true });
for (const f of ['ca.key', 'server.key']) {
  try {
    fs.chmodSync(file(f), 0o600);
  } catch {
    /* ویندوز این حالت را پشتیبانی نمی‌کند */
  }
}

const info = spawnSync('openssl', ['x509', '-in', file('server.crt'), '-noout', '-enddate', '-subject'], { encoding: 'utf8' });
const fingerprint = spawnSync('openssl', ['x509', '-in', file('ca.crt'), '-noout', '-fingerprint', '-sha256'], {
  encoding: 'utf8',
});
console.log(`  گواهی سرور ساخته شد (${names.length} نام معتبر).`);
console.log(`  ${(info.stdout || '').trim().split('\n').join('\n  ')}`);
console.log(`  ${(fingerprint.stdout || '').trim()}`);
console.log(`\n  فایل‌ها در: ${outDir}`);
console.log(`    ca.crt      → این فایل را در کلاینت‌ها به‌عنوان «مرجع معتبر» وارد کنید`);
console.log(`    server.crt  server.key  ca.key (فقط روی سرور، محرمانه)`);
console.log('\n  تمدید بعدی گواهی سرور (بدون تغییر CA): npm run tls:setup -- --force <همان نام‌ها>');
console.log('  اجرای سرویس با HTTPS:');
console.log(`    NETWATCH_TLS_DIR=${path.relative(ROOT, outDir) || '.'} npm start`);
console.log('  (برای ریدایرکت HTTP به HTTPS، متغیر NETWATCH_HTTP_PORT را هم تنظیم کنید.)\n');
