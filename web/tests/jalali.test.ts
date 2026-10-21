/**
 * تقویم شمسی کلاینت — همان رفتار سرور و بدون جابه‌جایی روز.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  toJalali,
  toGregorian,
  jalaliToIso,
  isoToJalali,
  formatJalaliIso,
  parseJalaliInput,
  jalaliMonthLength,
  addJalaliMonths,
  jalaliDateRange,
} from '../src/lib/jalali.ts';

test('تبدیل شمسی و میلادی', () => {
  assert.deepEqual(toJalali(2024, 3, 20), { jy: 1403, jm: 1, jd: 1 });
  assert.deepEqual(toGregorian(1403, 12, 30), { gy: 2025, gm: 3, gd: 20 });
  assert.equal(jalaliToIso(1403, 12, 30), '2025-03-20');
  assert.deepEqual(isoToJalali('2025-03-20'), { jy: 1403, jm: 12, jd: 30 });
  assert.equal(isoToJalali('2025-02-30'), null);
  assert.equal(jalaliMonthLength(1403, 12), 30);
  assert.equal(jalaliMonthLength(1404, 12), 29);
});

test('رفت‌وبرگشت همهٔ روزهای ۳ سال', () => {
  for (let jy = 1402; jy <= 1404; jy++) {
    for (let jm = 1; jm <= 12; jm++) {
      for (let jd = 1; jd <= jalaliMonthLength(jy, jm); jd++) {
        const iso = jalaliToIso(jy, jm, jd);
        assert.deepEqual(isoToJalali(iso), { jy, jm, jd }, `${jy}/${jm}/${jd}`);
      }
    }
  }
});

test('پارس ورودی فارسی و لاتین', () => {
  assert.equal(parseJalaliInput('۱۴۰۵/۰۷/۲۹'), '2026-10-21');
  assert.equal(parseJalaliInput('1405-7-29'), '2026-10-21');
  assert.equal(parseJalaliInput('1405/13/01'), '');
  assert.equal(parseJalaliInput('نامعتبر'), '');
  assert.equal(formatJalaliIso('2026-10-21'), '1405/07/29');
});

test('بازهٔ سه ماه اخیر معتبر و قابل تبدیل است', () => {
  const range = jalaliDateRange(3);
  assert.match(range.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(range.to, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(range.from < range.to);
  const a = addJalaliMonths({ jy: 1404, jm: 1, jd: 31 }, -3);
  assert.deepEqual(a, { jy: 1403, jm: 10, jd: 30 });
});
