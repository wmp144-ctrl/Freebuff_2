/**
 * NetWatch — بازتولید داده‌های نمایشی
 * ----------------------------------------------------------------
 * اجرا:  npm run seed:reset
 *
 * تمام داده‌های فعلی (تجهیزات، نمونه‌ها، قطعی‌ها، هشدارها، سوابق تعمیرات،
 * علامت‌های نقشه و…) حذف و داده‌های نمونه از نو ساخته می‌شوند. تنظیمات
 * برنامه دست‌نخورده می‌ماند.
 *
 * پیش از اجرا سامانه را متوقف کنید تا دو فرآیند هم‌زمان روی یک پایگاه‌داده
 * ننویسند. معادل داخل برنامه: «تنظیمات ← داده‌ها و نگهداری ← بازنشانی».
 */
import { db, seedIfEmpty, DB_PATH } from '../db.js';

process.stdout.write(`  پایگاه‌داده: ${DB_PATH}\n`);
try {
  seedIfEmpty({ force: true });
  const counts = {
    devices: db.prepare('SELECT COUNT(*) AS c FROM devices').get().c,
    groups: db.prepare('SELECT COUNT(*) AS c FROM groups').get().c,
    outages: db.prepare('SELECT COUNT(*) AS c FROM outages').get().c,
    alerts: db.prepare('SELECT COUNT(*) AS c FROM alerts').get().c,
    markers: db.prepare('SELECT COUNT(*) AS c FROM map_markers').get().c,
  };
  console.log(
    `  داده‌های نمونه بازسازی شد: ${counts.devices} تجهیز، ${counts.groups} گروه، ` +
      `${counts.outages} قطعی، ${counts.alerts} هشدار، ${counts.markers} علامت نقشه.`
  );
} catch (e) {
  console.error(`  بازنشانی ناموفق بود: ${e.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
