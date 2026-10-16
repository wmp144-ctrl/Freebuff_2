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
import { seedIfEmpty, getSettings, DB_PATH } from './db.js';

seedIfEmpty();

const once = process.argv.includes('--once');
const s = getSettings();

console.log('\n  NetWatch Engine');
console.log(`  پایگاه‌داده : ${DB_PATH}`);
console.log(`  حالت پایش   : ${s.engine_mode}   |   بازه: ${s.ping_interval}s   |   همزمانی: ${s.max_workers}`);
console.log('  برای خروج Ctrl+C را بزنید.\n');

await engine.start();

if (once) {
  await engine.tick();
  await new Promise((r) => setTimeout(r, 1500));
  engine.stop();
  console.log('  یک چرخه بررسی انجام شد.');
  process.exit(0);
}

const report = setInterval(() => {
  const st = engine.getStatus();
  console.log(
    `  [${new Date().toLocaleTimeString('fa-IR')}] چرخه: ${st.cycles} | بررسی: ${st.checksRun} | در حال اجرا: ${st.inflight} | خطا: ${st.errors}`
  );
}, 60000);

process.on('SIGINT', () => {
  clearInterval(report);
  engine.stop();
  console.log('\n  موتور متوقف شد.');
  process.exit(0);
});
