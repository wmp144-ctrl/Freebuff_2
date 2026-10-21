/**
 * تقویم شمسی — تبدیل دقیق، رفت‌وبرگشت و کمک‌تابع‌های ذخیره‌سازی.
 * تاریخ ذخیره‌شده همیشه استاندارد (epoch/ISO میلادی) می‌ماند؛ این آزمون‌ها
 * تضمین می‌کنند نمایش شمسی هیچ‌گاه داده را جابه‌جا یا گرد نکند.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  jalCal,
  isLeapJalaliYear,
  jalaliMonthLength,
  toJalali,
  toGregorian,
  jalaliToIsoDate,
  isoDateToJalali,
  parseDateInput,
  isoDateFromMs,
  jalaliLabelFromMs,
  addJalaliMonths,
} from '../../jalali.js';

test('نوروز و کبیسه بودن سال‌های شناخته‌شده', () => {
  assert.deepEqual(toJalali(2024, 3, 20), { jy: 1403, jm: 1, jd: 1 });
  assert.deepEqual(toJalali(2025, 3, 21), { jy: 1404, jm: 1, jd: 1 });
  assert.deepEqual(toJalali(2026, 3, 21), { jy: 1405, jm: 1, jd: 1 });
  assert.deepEqual(toJalali(2023, 3, 21), { jy: 1402, jm: 1, jd: 1 });
  assert.equal(isLeapJalaliYear(1403), true);
  assert.equal(isLeapJalaliYear(1404), false);
  assert.equal(jalaliMonthLength(1403, 12), 30);
  assert.equal(jalaliMonthLength(1404, 12), 29);
});

test('تبدیل رفت‌وبرگشت برای ۱۲ سال پیوسته', () => {
  for (let gy = 2018; gy <= 2029; gy++) {
    for (let gm = 1; gm <= 12; gm++) {
      const days = [31, (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][gm - 1];
      for (let gd = 1; gd <= days; gd++) {
        const j = toJalali(gy, gm, gd);
        const g = toGregorian(j.jy, j.jm, j.jd);
        assert.deepEqual(g, { gy, gm, gd }, `رفت‌وبرگشت ${gy}-${gm}-${gd}`);
      }
    }
  }
});

test('ISO میلادی استاندارد برای ذخیره‌سازی', () => {
  assert.equal(jalaliToIsoDate(1403, 1, 1), '2024-03-20');
  assert.equal(jalaliToIsoDate(1403, 12, 30), '2025-03-20');
  assert.deepEqual(isoDateToJalali('2025-03-20'), { jy: 1403, jm: 12, jd: 30 });
  assert.equal(isoDateToJalali('2025-02-30'), null);
  assert.equal(isoDateToJalali('not-a-date'), null);
});

test('پارس ورودی تاریخ و نمایش با اختلاف زمانی', () => {
  const ts = parseDateInput('2024-03-20', 210);
  assert.equal(isoDateFromMs(ts, 210), '2024-03-20');
  assert.equal(jalaliLabelFromMs(ts, 210), '1403-01-01');
  // پارس و نمایش باید با یک اختلاف زمانی انجام شوند تا روز جابه‌جا نشود
  assert.equal(isoDateFromMs(parseDateInput('2024-03-20', 0), 0), '2024-03-20');
  assert.equal(parseDateInput('', 210), null);
  assert.equal(parseDateInput('نامعتبر', 210), null);
  assert.equal(parseDateInput(1710892800000, 210), 1710892800000);
});

test('جمع ماه شمسی برای بازه‌های گزارش', () => {
  assert.deepEqual(addJalaliMonths(1404, 1, -3), { jy: 1403, jm: 10 });
  assert.deepEqual(addJalaliMonths(1404, 11, 3), { jy: 1405, jm: 2 });
});

test('سال خارج از بازه به‌جای نتیجهٔ غلط، خطا می‌دهد', () => {
  assert.throws(() => jalCal(5000));
  assert.throws(() => toGregorian(1403, 13, 1));
});
