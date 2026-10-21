/**
 * تبدیل تقویم شمسی/میلادی در رابط کاربری.
 *
 * قاعدهٔ طلایی: مقدار ذخیره‌شده در API همیشه ISO میلادی (`YYYY-MM-DD`) یا
 * epoch است؛ این ماژول فقط برای نمایش و انتخاب شمسی استفاده می‌شود. الگوریتم
 * همان الگوریتم سبک سرور است (بدون کتابخانهٔ تقویم سنگین) و آزمون رفت‌وبرگشت
 * دارد.
 */

const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];

const div = (a: number, b: number) => Math.trunc(a / b);
const mod = (a: number, b: number) => a - Math.floor(a / b) * b;

export const JALALI_MONTHS = [
  'فروردین',
  'اردیبهشت',
  'خرداد',
  'تیر',
  'مرداد',
  'شهریور',
  'مهر',
  'آبان',
  'آذر',
  'دی',
  'بهمن',
  'اسفند',
];

export interface JalaliParts {
  jy: number;
  jm: number;
  jd: number;
}

function jalCal(jy: number) {
  const gy = jy + 621;
  let leapJ = -14;
  let jp = BREAKS[0];
  if (jy < jp || jy >= BREAKS[BREAKS.length - 1]) throw new RangeError(`سال شمسی نامعتبر: ${jy}`);
  let jump = 0;
  for (let i = 1; i < BREAKS.length; i++) {
    const jm = BREAKS[i];
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

export function isLeapJalaliYear(jy: number): boolean {
  return jalCal(jy).leap === 0;
}

export function jalaliMonthLength(jy: number, jm: number): number {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return isLeapJalaliYear(jy) ? 30 : 29;
}

export function g2d(gy: number, gm: number, gd: number): number {
  let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

export function d2g(jdn: number) {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

export function j2d(jy: number, jm: number, jd: number): number {
  const r = jalCal(jy);
  return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}

export function d2j(jdn: number): JalaliParts {
  const gy = d2g(jdn).gy;
  let jy = gy - 621;
  const r = jalCal(jy);
  const jdn1f = g2d(gy, 3, r.march);
  let k = jdn - jdn1f;
  if (k >= 0) {
    if (k <= 185) return { jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 };
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  return { jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 };
}

export function toJalali(gy: number, gm: number, gd: number): JalaliParts {
  return d2j(g2d(gy, gm, gd));
}

export function toGregorian(jy: number, jm: number, jd: number): { gy: number; gm: number; gd: number } {
  return d2g(j2d(jy, jm, jd));
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** سه‌گانهٔ شمسی → ISO میلادی برای ذخیره در API */
export function jalaliToIso(jy: number, jm: number, jd: number): string {
  if (!Number.isInteger(jy) || !Number.isInteger(jm) || !Number.isInteger(jd)) return '';
  if (jm < 1 || jm > 12 || jd < 1 || jd > jalaliMonthLength(jy, jm)) return '';
  const g = toGregorian(jy, jm, jd);
  return `${String(g.gy).padStart(4, '0')}-${pad2(g.gm)}-${pad2(g.gd)}`;
}

/** ISO میلادی → سه‌گانهٔ شمسی؛ ورودی نامعتبر null */
export function isoToJalali(iso: string | null | undefined): JalaliParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').trim());
  if (!m) return null;
  const gy = Number(m[1]);
  const gm = Number(m[2]);
  const gd = Number(m[3]);
  const date = new Date(Date.UTC(gy, gm - 1, gd));
  if (date.getUTCFullYear() !== gy || date.getUTCMonth() !== gm - 1 || date.getUTCDate() !== gd) return null;
  return toJalali(gy, gm, gd);
}

/** امروز به‌صورت سه‌گانهٔ شمسی (بر اساس ساعت محلی مرورگر) */
export function todayJalali(): JalaliParts {
  const now = new Date();
  return toJalali(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function currentJalaliYear(): number {
  return todayJalali().jy;
}

/** `۱۴۰۵/۰۷/۲۹` (ارقام فارسی برای نمایش) */
export function formatJalaliIso(iso: string | null | undefined, digits: (s: string) => string = (s) => s): string {
  const j = isoToJalali(iso);
  if (!j) return '—';
  return digits(`${String(j.jy).padStart(4, '0')}/${pad2(j.jm)}/${pad2(j.jd)}`);
}

const FA_TO_EN = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

function normalizeDigits(input: string): string {
  return String(input ?? '')
    .replace(/[۰-۹]/g, (d) => String(FA_TO_EN.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

/**
 * پارس تاریخ تایپ‌شدهٔ شمسی (`۱۴۰۵/۰۷/۲۹`، `1405-7-29`).
 * @returns ISO میلادی یا '' در صورت نامعتبر بودن
 */
export function parseJalaliInput(input: string): string {
  const text = normalizeDigits(input).trim().replace(/\s+/g, '');
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (!m) return '';
  return jalaliToIso(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** افزودن ماه شمسی (برای بازه‌های پیش‌فرض مثل «سه ماه اخیر») */
export function addJalaliMonths(parts: JalaliParts, months: number): JalaliParts {
  const total = parts.jy * 12 + (parts.jm - 1) + months;
  const jy = Math.floor(total / 12);
  const jm = mod(total, 12) + 1;
  return { jy, jm, jd: Math.min(parts.jd, jalaliMonthLength(jy, jm)) };
}

export function jalaliDateRange(months: number): { from: string; to: string } {
  const today = todayJalali();
  const start = addJalaliMonths(today, -Math.abs(months));
  return { from: jalaliToIso(start.jy, start.jm, start.jd), to: jalaliToIso(today.jy, today.jm, today.jd) };
}
