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

// انصال مستقل موتور هم باید از سلامت و دوام پایگاه‌داده مطمئن شود (وگرنه می‌تواند
// هفته‌ها روی یک فایل خراب بنویسد).
verifyDatabaseAtStartup();
seedIfEmpty();
// پشتیبان‌گیری/Checkpoint خودکار برای اجرای مستقل موتور (Cron/سرویس)
startBackupScheduler({ isLeader: () => engine.leader });

const once = process.argv.includes('--once');
const s = getSettings();

console.log('\n  NetWatch Engine');
console.log(`  پایگاه‌داده : ${DB_PATH}`);
console.log(`  حالت پایش   : ${s.engine_mode}   |   بازه: ${s.ping_interval}s   |   همزمانی: ${s.max_workers}`);
console.log('  برای خروج Ctrl+C را بزنید.\n');

await engine.start();

if (once) {
  if (!engine.leader) {
    // نمونهٔ دیگری (مثلاً موتور داخل سرور) قفل رهبری را دارد؛ این اجرا نباید
    // هم‌زمان Ping بزند. کد خروج ۰ است چون در استقرار عادی، این حالت مورد
    // انتظار است و Cron نباید آن را خرابی تلقی کند.
    console.log('  موتور دیگری فعال است؛ این اجرا بررسی‌ای انجام نداد (قفل رهبری در اختیار نمونهٔ دیگر است).');
    engine.stop();
    shutdown(0);
  }
  await engine.tick();
  await new Promise((r) => setTimeout(r, 1500));
  engine.stop();
  console.log('  یک چرخه بررسی انجام شد.');
  shutdown(0);
}

if (!engine.leader) {
  console.log('  توجه: نمونهٔ دیگری رهبر است؛ این فرآیند در حالت آماده‌به‌کار است و در صورت آزادشدن قفل، کار را ادامه می‌دهد.');
}

const report = setInterval(() => {
  const st = engine.getStatus();
  console.log(
    `  [${new Date().toLocaleTimeString('fa-IR')}] چرخه: ${st.cycles} | بررسی: ${st.checksRun} | در حال اجرا: ${st.inflight} | خطا: ${st.errors}${st.leader ? '' : ' | آماده‌به‌کار (نمونهٔ دیگر رهبر است)'}`
  );
}, 60000);

process.on('SIGINT', () => {
  clearInterval(report);
  engine.stop();
  console.log('\n  موتور متوقف شد.');
  shutdown(0);
});

/** خاموشی تمیز: توقف زمان‌بند، انتقال WAL به فایل اصلی و بستن اتصال */
function shutdown(code = 0) {
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
