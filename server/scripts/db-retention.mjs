#!/usr/bin/env node
/**
 * NetWatch — اجرای دستی Data Retention از خط فرمان
 * ----------------------------------------------------------------
 *   node server/scripts/db-retention.mjs              # اجرای واقعی (خروجی JSON)
 *   node server/scripts/db-retention.mjs --dry-run    # فقط شمارش قابل‌حذف
 *   node server/scripts/db-retention.mjs --status     # وضعیت و سیاست مؤثر
 *   node server/scripts/db-retention.mjs --stop       # درخواست توقف اجرای جاری
 *
 * برای Cron در سروری که سرویس بالا نیست مناسب است. اگر سرویس فعال باشد، قفل
 * پایگاه‌داده جلوی اجرای هم‌زمان را می‌گیرد (خروج با کد ۲ و پیام روشن).
 */
// خروجی JSON مصرف‌ماشینی است؛ لاگ‌ها به stderr می‌روند.
process.env.NETWATCH_LOG_STREAM = 'stderr';
const args = new Set(process.argv.slice(2));
const { db } = await import('../db.js');
const { retentionStatus, runRetention, requestRetentionStop } = await import('../retention.js');

const finish = (payload, code = 0) => {
  console.log(JSON.stringify(payload, null, 2));
  db.close();
  process.exit(code);
};

try {
  if (args.has('--status')) {
    finish({ ok: true, status: retentionStatus() });
  }
  if (args.has('--stop')) {
    const accepted = requestRetentionStop();
    finish({
      ok: true,
      accepted,
      message: accepted
        ? 'درخواست توقف ثبت شد؛ اجرای جاری پس از پایان Batch فعلی متوقف می‌شود.'
        : 'اجرای Retention در این فرآیند در جریان نیست (پرچم توقف برای نمونه‌های دیگر ثبت شد).',
    });
  }
  const dryRun = args.has('--dry-run');
  const result = runRetention({ trigger: 'cli', actor: `cli:${process.pid}`, dryRun, force: args.has('--force') });
  finish({ ok: result.status === 'completed' || result.status === 'stopped', result });
} catch (e) {
  const code = e?.code === 'DB_BUSY' ? 2 : 1;
  finish({ ok: false, code: e?.code || 'ERROR', error: e?.message || String(e) }, code);
}
