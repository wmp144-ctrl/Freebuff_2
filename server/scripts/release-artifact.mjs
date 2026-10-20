#!/usr/bin/env node
/**
 * NetWatch — ساخت Artifact انتشار و Checksum
 * ----------------------------------------------------------------
 *   npm run release:artifact
 *   OUTPUT_DIR=/tmp/release npm run release:artifact
 *
 * خروجی:
 *   netwatch-<version>.tar.gz      سورس تحت کنترل نسخه (git archive)
 *   netwatch-web-<version>.tar.gz  خروجی Build رابط کاربری (web/dist)
 *   SHA256SUMS                     checksum هر دو فایل
 *   release.json                   نسخه، کامیت، زمان و checksum ها
 *
 * این اسکریپت هیچ فایلی را در گیت تغییر نمی‌دهد و فقط در OUTPUT_DIR می‌نویسد.
 * برای انتشار، ابتدا `npm run build` را اجرا کنید.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const outDir = path.resolve(process.env.OUTPUT_DIR || path.join(ROOT, 'artifacts', 'release'));
const distDir = path.join(ROOT, 'web', 'dist');

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function sizeOf(file) {
  return fs.statSync(file).size;
}

if (git(['status', '--porcelain'])) {
  fail('درخت کاری تغییرات ثبت‌نشده دارد؛ برای Artifact قابل‌بازتولید ابتدا commit کنید.');
}
if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  fail('web/dist وجود ندارد؛ ابتدا `npm run build` را اجرا کنید.');
}

fs.mkdirSync(outDir, { recursive: true });

const sourceName = `netwatch-${pkg.version}.tar.gz`;
const webName = `netwatch-web-${pkg.version}.tar.gz`;
const sourcePath = path.join(outDir, sourceName);
const webPath = path.join(outDir, webName);

// سورس: فقط فایل‌های تحت کنترل نسخه (بدون node_modules/data/آزمون‌ها).
execFileSync('git', ['archive', '--format=tar.gz', `--prefix=netwatch-${pkg.version}/`, '-o', sourcePath, 'HEAD'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'inherit'],
});

// رابط کاربری: خروجی Build شده با محتوای ثابت.
execFileSync('tar', ['-czf', webPath, '-C', distDir, '.'], { stdio: ['ignore', 'pipe', 'inherit'] });

const files = [
  { name: sourceName, bytes: sizeOf(sourcePath), sha256: sha256(sourcePath) },
  { name: webName, bytes: sizeOf(webPath), sha256: sha256(webPath) },
];

const sums = files.map((f) => `${f.sha256}  ${f.name}`).join('\n') + '\n';
fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), sums);

const manifest = {
  ok: true,
  name: 'netwatch',
  version: pkg.version,
  commit: git(['rev-parse', 'HEAD']),
  branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
  builtAt: new Date().toISOString(),
  node: process.version,
  files,
};
fs.writeFileSync(path.join(outDir, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(JSON.stringify({ ...manifest, dir: outDir }, null, 2));
