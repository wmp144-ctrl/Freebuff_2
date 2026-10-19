/**
 * NetWatch — اجرای مستقل موتور مانیتورینگ
 * ----------------------------------------------------------------
 * این فرآیند هیچ صفحه‌ی رابط کاربری را باز نمی‌کند و تنها وظیفه‌ی آن
 * ارسال Ping، ثبت نتایج، تشخیص قطعی و تولید هشدار است.
 *
 *   node server/engine-cli.js          →  اجرای دائمی
 *   node server/engine-cli.js --once   →  یک چرخه بررسی و خروج
 */
import { engine } from './engine.js';
import { seedIfEmpty, getSettings, DB_PATH, verifyDatabaseAtStartup, db } from './db.js';
import { startBackupScheduler, stopBackupScheduler, runCheckpoint } from './backup.js';
import {
  markInterruptedRetentionRuns,
  startRetentionScheduler,
  stopRetentionScheduler,
} from './retention.js';
import { config } from './config.js';

// انصال مستقل موتور هم باید از سلامت و دوام پایگاه‌داده مطمئن شود (وگرنه می‌تواند
// هفته‌ها روی یک فایل خراب بنویسد).
verifyDatabaseAtStartup();
markInterruptedRetentionRuns();
seedIfEmpty();
// پشتیبان‌گیری/Checkpoint خودکار برای اجرای مستقل موتور (Cron/سرویس)
startBackupScheduler({ isLeader: () => engine.leader });
// Retention Engine فقط در نمونهٔ رهبر اجرا می‌شود؛ قفل پایگاه‌داده هم مانع
// اجرای هم‌زمان با سرور می‌شود.
startRetentionScheduler({ isLeader: () => engine.leader });

const once = process.argv.includes('--once');
const s = getSettings();

console.log('\n  NetWatch Engine');
console.log(`  پایگاه‌داده : ${DB_PATH}`);
console.log(`  حالت پایش   : ${s.engine_mode}${s.engine_mode === 'simulate' ? '  (دادهٔ شبیه‌سازی‌شده — برای پایش واقعی مقدار auto را تنظیم کنید)' : ''}`);
console.log(`  بازه: ${s.ping_interval}s   |   هم‌زمانی: ${s.max_workers}`);
console.log('  برای خروج Ctrl+C یا SIGTERM را بزنید.\n');

await engine.start();

if (once) {
  if (!engine.leader) {
    // نمونهٔ دیگری (مثلاً موتور داخل سرور) قفل رهبری را دارد؛ این اجرا نباید
    // هم‌زمان Ping بزند. کد خروج ۰ است چون در استقرار عادی، این حالت مورد
    // انتظار است و Cron نباید آن را خرابی تلقی کند.
    console.log('  موتور دیگری فعال است؛ این اجرا بررسی‌ای انجام نداد (قفل رهبری در اختیار نمونهٔ دیگر است).');
    await engine.stop({ drainMs: 0 });
    shutdown(0);
  }
  await engine.tick();
  await new Promise((r) => setTimeout(r, 1500));
  const st = engine.getStatus();
  await engine.stop({ drainMs: config.shutdownTimeoutMs });
  console.log(`  یک چرخه بررسی انجام شد (بررسی: ${st.checksRun} | خطای داخلی: ${st.internalErrors} | تأخیر زمان‌بندی: ${st.scheduling.lastLagMs}ms).`);
  shutdown(0);
}

if (!engine.leader) {
  console.log('  توجه: نمونهٔ دیگری رهبر است؛ این فرآیند در حالت آماده‌به‌کار است و در صورت آزادشدن قفل، کار را ادامه می‌دهد.');
}

const report = setInterval(() => {
  const st = engine.getStatus();
  console.log(
    `  [${new Date().toLocaleTimeString('fa-IR')}] چرخه: ${st.cycles} | بررسی: ${st.checksRun} | در حال اجرا: ${st.inflight}` +
      ` | خطای داخلی: ${st.internalErrors} | تأخیر زمان‌بندی: ${st.scheduling.lastLagMs}ms | معوق: ${st.backlog}` +
      `${st.leader ? '' : ' | آماده‌به‌کار (نمونهٔ دیگر رهبر است)'}`
  );
}, 60000);

// خاموش‌سازی مرتب با Ctrl+C یا SIGTERM (systemd/docker هنگام توقف سرویس SIGTERM می‌فرستد)
const onSignal = (signal) => {
  clearInterval(report);
  console.log(`\n  سیگنال ${signal} دریافت شد؛ تخلیهٔ بررسی‌های در جریان…`);
  engine
    .stop({ drainMs: config.shutdownTimeoutMs })
    .catch(() => {})
    .finally(() => {
      console.log('  موتور متوقف شد.');
      shutdown(0);
    });
};
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

/** خاموشی تمیز: توقف زمان‌بند، انتقال WAL به فایل اصلی و بستن اتصال */
function shutdown(code = 0) {
  try {
    stopRetentionScheduler();
  } catch {}
  try {
    stopBackupScheduler();
  } catch {}
  try {
    runCheckpoint('engine-cli-shutdown');
  } catch {}
  try {
    db.close();
  } catch {}
  process.exit(code);
}
