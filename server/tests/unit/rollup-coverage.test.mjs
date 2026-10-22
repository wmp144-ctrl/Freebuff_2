/**
 * تجمیع روزانه — تکمیل تجمیع در سطح تجهیز (BUG-23)
 * ----------------------------------------------------------------
 * اگر برای یک روز فقط ردیف برخی تجهیزها در daily_stats وجود داشته باشد،
 * تجمیع نباید «کامل» تلقی شود؛ وگرنه نمونه‌های خام بقیهٔ تجهیزها هرس می‌شوند و
 * آمار تاریخیشان برای همیشه از دست می‌رود.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, addDevice } from '../helpers.mjs';

const dir = useTempDataDir('rollup-coverage');
const { db } = await import('../../db.js');
const { ensureDailyStatsBefore, dailyRollupGap, localDayStart, rollupDay } = await import('../../rollup.js');
const { DAY_MS, dayLabel } = await import('../../daily.js');

after(() => {
  db.close();
  cleanupDir(dir);
});

const insertSample = db.prepare(
  'INSERT INTO samples(device_id, ts, rtt_ms, packets_sent, packets_recv, loss_pct, status, ok, mode) VALUES (?,?,?,?,?,?,?,?,?)'
);

test('a partially rolled-up day is completed for every device with samples', () => {
  const a = addDevice(db, { name: 'rollup-a', ip: '10.92.0.1', status: 'online', ping_interval: 3600 });
  const b = addDevice(db, { name: 'rollup-b', ip: '10.92.0.2', status: 'online', ping_interval: 3600 });
  const dayStart = localDayStart(Date.now() - 40 * DAY_MS, 0);
  const day = dayLabel(dayStart, 0);

  // هر دو تجهیز در همان روز نمونه دارند.
  for (const device of [a, b]) {
    for (let i = 0; i < 3; i++) {
      insertSample.run(device, dayStart + 1000 + i * 1000, 5, 1, 1, 0, 'online', 1, 'test');
    }
  }
  // فقط تجهیز a تجمیع شده است (مثلاً تجمیع نیمه‌کاره یا تجهیز b تازه اضافه شده).
  db.prepare(
    `INSERT INTO daily_stats(device_id, day, checks, failed, avg_rtt, min_rtt, max_rtt, loss_pct, outages, downtime_sec, uptime_pct)
     VALUES (?,?,?,?,?,?,?,?,0,0,?)`
  ).run(a, day, 3, 0, 5, 5, 5, 0, 100);

  assert.equal(dailyRollupGap(dayStart, 0), 1, 'یک تجهیز دارای نمونه و فاقد ردیف روزانه است');

  const result = ensureDailyStatsBefore({ cutoff: dayStart + DAY_MS, offsetMin: 0, limit: 31 });
  assert.equal(result.days, 1);
  assert.deepEqual(result.missing, [day]);
  assert.equal(result.rolledUp, 1, 'روز ناقص باید دوباره تجمیع شود');
  assert.equal(result.remaining, 0);
  assert.equal(dailyRollupGap(dayStart, 0), 0, 'پس از تجمیع هیچ تجهیزی جا نمی‌ماند');

  const rows = db.prepare('SELECT device_id, checks FROM daily_stats WHERE day = ? ORDER BY device_id').all(day);
  assert.equal(rows.length, 2, 'برای هر دو تجهیز ردیف روزانه ساخته می‌شود');
  assert.equal(rows.find((r) => r.device_id === b).checks, 3);
  assert.equal(rows.find((r) => r.device_id === a).checks, 3, 'تجمیع مجدد idempotent است');
});

test('a fully rolled-up day is not rolled up again', () => {
  const dayStart = localDayStart(Date.now() - 50 * DAY_MS, 0);
  const day = dayLabel(dayStart, 0);
  const device = addDevice(db, { name: 'rollup-full', ip: '10.92.0.3', status: 'online', ping_interval: 3600 });
  insertSample.run(device, dayStart + 5000, 7, 1, 1, 0, 'online', 1, 'test');
  assert.equal(rollupDay(dayStart, 0), 1);
  assert.equal(dailyRollupGap(dayStart, 0), 0);

  const again = ensureDailyStatsBefore({ cutoff: dayStart + DAY_MS, offsetMin: 0, limit: 31 });
  assert.deepEqual(again.missing, [], 'روز کامل نباید دوباره تجمیع شود');
  assert.equal(again.rolledUp, 0);
  assert.equal(db.prepare('SELECT checks FROM daily_stats WHERE device_id = ? AND day = ?').get(device, day).checks, 1);
});
