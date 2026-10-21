/**
 * NetWatch — تبدیل تقویم شمسی/میلادی و کمک‌تابع‌های تاریخ
 * ----------------------------------------------------------------
 * ذخیره‌سازی تاریخ در پایگاه‌داده همیشه استاندارد و مستقل از تقویم نمایشی
 * است: epoch milliseconds برای لحظه‌ها و `YYYY-MM-DD` میلادی برای تاریخ‌های
 * فقط-روز. این ماژول تنها لایهٔ تبدیل است تا نمایش شمسی هیچ‌گاه قالب ذخیره
 * را تغییر ندهد.
 *
 * الگوریتم تبدیل، نسخهٔ سبک و بدون وابستگی الگوریتم شناخته‌شدهٔ jalaali
 * (بر پایهٔ محاسبهٔ نوروز) است؛ برای بازهٔ ۱۱۷۸ تا ۱۶۳۳ شمسی دقیق است و
 * برای سال‌های عملیاتی شبکه بیش از کافی است. هیچ کتابخانهٔ سنگین تقویم
 * اضافه نشده است.
 */

const breaks = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];

function div(a, b) {
  return Math.trunc(a / b);
}

function mod(a, b) {
  return a - Math.floor(a / b) * b;
}

/** اطلاعات سال شمسی: کبیسه بودن و روز ژولینی نوروز */
export function jalCal(jy) {
  const gy = jy + 621;
  let leapJ = -14;
  let jp = breaks[0];
  if (jy < jp || jy >= breaks[breaks.length - 1]) {
    throw new RangeError(`سال شمسی خارج از بازهٔ پشتیبانی‌شده است: ${jy}`);
  }
  let jump = 0;
  for (let i = 1; i < breaks.length; i++) {
    const jm = breaks[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ += div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ += div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

export function isLeapJalaliYear(jy) {
  return jalCal(jy).leap === 0;
}

export function jalaliMonthLength(jy, jm) {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return isLeapJalaliYear(jy) ? 30 : 29;
}

/** شمارهٔ روز ژولینی از تاریخ شمسی */
export function j2d(jy, jm, jd) {
  const r = jalCal(jy);
  return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}

/** تاریخ شمسی از شمارهٔ روز ژولینی */
export function d2j(jdn) {
  const gy = d2g(jdn).gy;
  let jy = gy - 621;
  const r = jalCal(jy);
  const jdn1f = g2d(gy, 3, r.march);
  let k = jdn - jdn1f;
  if (k >= 0) {
    if (k <= 185) {
      const jm = 1 + div(k, 31);
      return { jy, jm, jd: mod(k, 31) + 1 };
    }
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  const jm = 7 + div(k, 30);
  return { jy, jm, jd: mod(k, 30) + 1 };
}

export function g2d(gy, gm, gd) {
  let d =
    div((gy + div(gm - 8, 6) + 100100) * 1461, 4) +
    div(153 * mod(gm + 9, 12) + 2, 5) +
    gd -
    34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

export function d2g(jdn) {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

function isValidJalali(jy, jm, jd) {
  return (
    Number.isInteger(jy) &&
    Number.isInteger(jm) &&
    Number.isInteger(jd) &&
    jy >= breaks[0] &&
    jy < breaks[breaks.length - 1] &&
    jm >= 1 &&
    jm <= 12 &&
    jd >= 1 &&
    jd <= jalaliMonthLength(jy, jm)
  );
}

function isValidGregorian(gy, gm, gd) {
  if (!Number.isInteger(gy) || !Number.isInteger(gm) || !Number.isInteger(gd)) return false;
  if (gy < 560 || gy > 3800 || gm < 1 || gm > 12 || gd < 1) return false;
  const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][gm - 1];
  return gd <= days;
}

/** @returns {{jy:number,jm:number,jd:number}} */
export function toJalali(gy, gm, gd) {
  if (!isValidGregorian(gy, gm, gd)) throw new RangeError('تاریخ میلادی نامعتبر است.');
  return d2j(g2d(gy, gm, gd));
}

/** @returns {{gy:number,gm:number,gd:number}} */
export function toGregorian(jy, jm, jd) {
  if (!isValidJalali(jy, jm, jd)) throw new RangeError('تاریخ شمسی نامعتبر است.');
  return d2g(j2d(jy, jm, jd));
}

const pad2 = (n) => String(n).padStart(2, '0');

/** ISO تاریخ میلادی (YYYY-MM-DD) از سه‌گانهٔ شمسی */
export function jalaliToIsoDate(jy, jm, jd) {
  const g = toGregorian(jy, jm, jd);
  return `${String(g.gy).padStart(4, '0')}-${pad2(g.gm)}-${pad2(g.gd)}`;
}

/** ISO تاریخ میلادی → سه‌گانهٔ شمسی */
export function isoDateToJalali(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').trim());
  if (!m) return null;
  const gy = Number(m[1]);
  const gm = Number(m[2]);
  const gd = Number(m[3]);
  if (!isValidGregorian(gy, gm, gd)) return null;
  return toJalali(gy, gm, gd);
}

/** قالب بومی شمسی برای نمایش (بدون تبدیل رقم؛ UI خودش ارقام فارسی می‌کند) */
export function formatJalaliDate(jy, jm, jd) {
  if (!isValidJalali(jy, jm, jd)) return '—';
  return `${String(jy).padStart(4, '0')}-${pad2(jm)}-${pad2(jd)}`;
}

/**
 * پارس ورودی تاریخ از API.
 * پشتیبانی: عدد epoch (ms)، ISO datetime، ISO date (YYYY-MM-DD میلادی).
 * تاریخ فقط-روز در نیمه‌شب محلی (بر اساس timezone_offset_minutes) به epoch
 * تبدیل می‌شود تا نمایش همان روز را برگرداند.
 * @returns {number|null}
 */
export function parseDateInput(value, offsetMin = 0) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{13}$/.test(text)) return Number(text);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) {
    const ts = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    if (Number.isNaN(ts)) return null;
    return ts - (Number(offsetMin) || 0) * 60000;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

/** تاریخ فقط-روز محلی (YYYY-MM-DD میلادی) از epoch */
export function isoDateFromMs(ts, offsetMin = 0) {
  if (ts === null || ts === undefined || !Number.isFinite(Number(ts))) return null;
  return new Date(Number(ts) + (Number(offsetMin) || 0) * 60000).toISOString().slice(0, 10);
}

/** روز شمسی از epoch، به‌صورت ISO میلادی برای ذخیره */
export function isoDateFromJalaliDate(isoJalali) {
  return String(isoJalali);
}

/**
 * برچسب شمسی یک epoch با احترام به اختلاف زمانی نمایش.
 * @returns {string} `YYYY-MM-DD` شمسی
 */
export function jalaliLabelFromMs(ts, offsetMin = 0) {
  const iso = isoDateFromMs(ts, offsetMin);
  if (!iso) return '—';
  const j = isoDateToJalali(iso);
  return j ? formatJalaliDate(j.jy, j.jm, j.jd) : '—';
}

/** افزودن ماه شمسی به یک تاریخ شمسی (برای بازه‌های پیش‌فرض گزارش) */
export function addJalaliMonths(jy, jm, months) {
  const total = jy * 12 + (jm - 1) + Number(months || 0);
  const ny = Math.floor(total / 12);
  const nm = mod(total, 12) + 1;
  return { jy: ny, jm: nm };
}

export default {
  jalCal,
  isLeapJalaliYear,
  jalaliMonthLength,
  j2d,
  d2j,
  g2d,
  d2g,
  toJalali,
  toGregorian,
  jalaliToIsoDate,
  isoDateToJalali,
  formatJalaliDate,
  parseDateInput,
  isoDateFromMs,
  jalaliLabelFromMs,
  addJalaliMonths,
};
