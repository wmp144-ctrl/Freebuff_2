#!/usr/bin/env node
/**
 * NetWatch — بازیابی از پشتیبان با بررسی صحت
 *
 *   npm run db:restore -- <backup-dir|netwatch.db> [--dry-run] [--no-mbtiles] [--force]
 *
 * پیش از بازیابی، checksum و integrity_check و وجود جدول‌ها بررسی می‌شود.
 * اگر سرویس در حال اجراست، ابتدا آن را متوقف کنید؛ در غیر این صورت از
 * --force استفاده کنید (خطر نوشتن هم‌زمان دو فرآیند).
 */
// خروجی این ابزار JSON مصرف‌ماشینی است؛ لاگ‌ها به stderr می‌روند.
process.env.NETWATCH_LOG_STREAM = 'stderr';
const { restoreBackup, verifyBackup } = await import('../backup.js');
const { db } = await import('../db.js');

const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const restoreMbtiles = !args.includes('--no-mbtiles');
const force = args.includes('--force');

if (!source) {
  console.error('استفاده: npm run db:restore -- <backup-dir|netwatch.db> [--dry-run] [--no-mbtiles] [--force]');
  process.exit(2);
}

const verification = verifyBackup(source);
if (!verification.ok) {
  console.error(JSON.stringify({ ok: false, step: 'verify', errors: verification.errors }, null, 2));
  process.exit(1);
}
if (dryRun) {
  console.log(JSON.stringify({ ok: true, step: 'verify', dryRun: true, counts: verification.counts }, null, 2));
  db.close();
  process.exit(0);
}

try {
  const result = restoreBackup(source, { restoreMbtiles, force });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  db.close();
  process.exit(0);
} catch (e) {
  console.error(JSON.stringify({ ok: false, step: 'restore', code: e.code, error: e.message }, null, 2));
  process.exit(1);
}
