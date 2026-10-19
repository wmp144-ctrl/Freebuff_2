#!/usr/bin/env node
/**
 * NetWatch — آماده‌سازی انتشار و نقطهٔ بازگشت (Rollback Point)
 * ----------------------------------------------------------------
 * پیش از انتشار:
 *   ۱) از پایگاه‌دادهٔ جاری و MBTiles یک پشتیبان WAL-سازگار می‌سازد و اعتبارسنجی می‌کند.
 *   ۲) از کدِ کامیت فعلی (نسخهٔ قبلی/منبع Rollback) یک آرشیو tar.gz می‌سازد.
 *   ۳) مانیفست `release.json` با نسخه، کامیت، SHA-256 آرشیو و دستورهای بازگشت می‌نویسد.
 *
 *   npm run release:prepare
 *   NETWATCH_DATA_DIR=/var/lib/netwatch npm run release:prepare
 *
 * خروجی JSON مصرف‌ماشینی است. هیچ فایلی در گیت تغییر نمی‌کند.
 */
process.env.NETWATCH_LOG_STREAM = 'stderr';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const { createBackup, verifyBackup, BACKUP_DIR } = await import('../backup.js');
const { db, DATA_DIR } = await import('../db.js');

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const releaseDir = path.join(DATA_DIR, 'releases', `${pkg.version}-${stamp}`);
fs.mkdirSync(releaseDir, { recursive: true });

const commit = git(['rev-parse', 'HEAD']);
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const status = git(['status', '--porcelain']);
const dirty = Boolean(status);

const backup = createBackup({ includeMbtiles: true, keep: 20, reason: 'pre-release' });
const verification = verifyBackup(backup.dir);
if (!verification.ok) {
  console.error(JSON.stringify({ ok: false, step: 'verify-backup', errors: verification.errors }, null, 2));
  db.close();
  process.exit(1);
}

let archive = null;
let archiveSha = null;
if (commit) {
  const file = path.join(releaseDir, `source-${commit.slice(0, 12)}.tar.gz`);
  execFileSync('git', ['archive', '--format=tar.gz', `--output=${file}`, 'HEAD'], { cwd: ROOT });
  archive = file;
  archiveSha = sha256File(file);
}

const manifest = {
  ok: true,
  kind: 'pre-release',
  createdAt: new Date().toISOString(),
  app: { name: pkg.name, version: pkg.version },
  code: { commit, branch, dirty, sourceArchive: archive, sourceSha256: archiveSha },
  backup: {
    name: backup.name,
    dir: backup.dir,
    manifest: path.join(backup.dir, 'manifest.json'),
    dbBytes: backup.manifest.db.size,
    counts: backup.manifest.db.counts,
    mbtiles: backup.manifest.mbtiles.length,
    verified: verification.ok,
  },
  dataDir: DATA_DIR,
  backupDir: BACKUP_DIR,
  rollback: {
    data: `systemctl stop netwatch || true; npm run db:restore -- "${backup.dir}"`,
    code: commit ? `git checkout ${commit} && npm ci && npm run build` : 'git checkout <previous-commit> && npm ci && npm run build',
    then: 'systemctl start netwatch && curl -fsS http://127.0.0.1:3000/api/health',
    note: 'پس از بازیابی داده، سرویس را متوقف نگه دارید تا کد قبلی مستقر شود؛ سپس سرویس را بالا بیاورید.',
  },
};

const manifestPath = path.join(releaseDir, 'release.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
if (dirty) {
  console.error(JSON.stringify({ warn: 'working tree is dirty; source archive represents HEAD, not uncommitted files' }, null, 2));
}
console.log(JSON.stringify({ ...manifest, manifestPath }, null, 2));
db.close();
