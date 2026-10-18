#!/usr/bin/env node
/**
 * NetWatch — پشتیبان‌گیری دستی/زمان‌بندی‌شده از خط فرمان
 *
 *   npm run db:backup
 *   npm run db:backup -- --no-mbtiles --keep=14
 *
 * خروجی JSON برای استفاده در Cron/اسکریپت پایش است. کد خروج ۰ فقط وقتی است
 * که پشتیبان ساخته و اعتبارسنجی شده باشد.
 */
// خروجی این ابزار JSON مصرف‌ماشینی است؛ لاگ‌ها به stderr می‌روند.
process.env.NETWATCH_LOG_STREAM = 'stderr';
const { createBackup, verifyBackup, listBackups } = await import('../backup.js');
const { db } = await import('../db.js');

const args = process.argv.slice(2);
const includeMbtiles = !args.includes('--no-mbtiles');
const keepArg = args.find((a) => a.startsWith('--keep='));
const keep = keepArg ? Number(keepArg.split('=')[1]) : undefined;

try {
  const result = createBackup({ includeMbtiles, keep, reason: 'cli' });
  const verification = verifyBackup(result.dir);
  const summary = {
    ok: verification.ok,
    name: result.name,
    dir: result.dir,
    dbBytes: result.manifest.db.size,
    counts: result.manifest.db.counts,
    mbtiles: result.manifest.mbtiles.length,
    durationMs: result.manifest.durationMs,
    errors: verification.errors,
    backups: listBackups().length,
  };
  console.log(JSON.stringify(summary, null, 2));
  db.close();
  process.exit(verification.ok ? 0 : 1);
} catch (e) {
  console.error(JSON.stringify({ ok: false, code: e.code, error: e.message }, null, 2));
  process.exit(1);
}
