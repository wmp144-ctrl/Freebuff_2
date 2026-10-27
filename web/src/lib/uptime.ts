/**
 * منطق زمانی و آماری «کاوشگر دسترس‌پذیری».
 *
 * همهٔ محاسبات این‌جا خالص و مستقل از React است تا هر چهار نما (ماهانه،
 * هفتگی، روزانه و ساعتی) دقیقاً از یک قاعدهٔ مشترک برای مرز روزها، رنگ وضعیت
 * و آمار استفاده کنند. زمان نمایش با همان اختلاف زمانی تنظیمات جابه‌جا
 * می‌شود؛ مقدار ذخیره‌شده همیشه epoch است.
 */
import { faDigits } from './format.ts';
import { jalaliMonthLength, toGregorian, toJalali } from './jalali.ts';
import type { Outage, SeriesPoint } from './types';

export type UptimeView = 'month' | 'week' | 'day' | 'hour';
export type UptimeState = 'up' | 'warn' | 'down' | 'none';
export type CalendarMode = 'jalali' | 'gregorian';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** رنگ‌های ثابت نمودار؛ همان سبز/نارنجی/قرمز در همهٔ نماها. */
export const UPTIME_COLORS: Record<UptimeState, string> = {
  up: '#22c55e',
  warn: '#f59e0b',
  down: '#ef4444',
  none: '#e2e8f0',
};

export const UPTIME_TINTS: Record<UptimeState, string> = {
  up: 'rgba(34,197,94,0.13)',
  warn: 'rgba(245,158,11,0.15)',
  down: 'rgba(239,68,68,0.14)',
  none: 'rgba(148,163,184,0.10)',
};

export const UPTIME_LABELS: Record<UptimeState, string> = {
  up: 'اتصال برقرار',
  warn: 'اختلال',
  down: 'قطعی',
  none: 'بدون داده',
};

export const VIEW_LABELS: Record<UptimeView, string> = {
  month: 'ماهانه',
  week: 'هفتگی',
  day: 'روزانه',
  hour: 'ساعتی',
};

/** ترتیب روزهای هفته در ایران: شنبه تا جمعه. */
export const WEEKDAY_LABELS = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'];
export const WEEKDAY_SHORT = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'];

export interface TimeWindow {
  from: number;
  to: number;
}

function localDate(ts: number, tzOffset: number) {
  return new Date(ts + tzOffset * MINUTE_MS);
}

/** ابتدای روز محلی بر حسب epoch (با احترام به اختلاف زمانی تنظیمات). */
export function localDayStart(ts: number, tzOffset: number): number {
  return Math.floor((ts + tzOffset * MINUTE_MS) / DAY_MS) * DAY_MS - tzOffset * MINUTE_MS;
}

export function localDateKey(ts: number, tzOffset: number): string {
  const d = localDate(ts, tzOffset);
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

/** ۰ = شنبه … ۶ = جمعه */
export function weekdayIndex(ts: number, tzOffset: number): number {
  return (localDate(ts, tzOffset).getUTCDay() + 1) % 7;
}

export function dayWindow(ts: number, tzOffset: number): TimeWindow {
  const from = localDayStart(ts, tzOffset);
  return { from, to: from + DAY_MS };
}

/** هفتهٔ ایرانی از شنبهٔ ۰۰:۰۰ تا جمعهٔ ۲۴:۰۰ */
export function weekWindow(ts: number, tzOffset: number): TimeWindow {
  const from = localDayStart(ts, tzOffset) - weekdayIndex(ts, tzOffset) * DAY_MS;
  return { from, to: from + 7 * DAY_MS };
}

export function hourWindow(ts: number, tzOffset: number): TimeWindow {
  const from = Math.floor((ts + tzOffset * MINUTE_MS) / HOUR_MS) * HOUR_MS - tzOffset * MINUTE_MS;
  return { from, to: from + HOUR_MS };
}

export function monthWindow(ts: number, tzOffset: number, calendar: CalendarMode): TimeWindow {
  const d = localDate(ts, tzOffset);
  const gy = d.getUTCFullYear();
  const gm = d.getUTCMonth() + 1;
  if (calendar === 'gregorian') {
    const start = Date.UTC(gy, gm - 1, 1) - tzOffset * MINUTE_MS;
    const end = Date.UTC(gy, gm, 1) - tzOffset * MINUTE_MS;
    return { from: start, to: end };
  }
  const j = toJalali(gy, gm, d.getUTCDate());
  const startG = toGregorian(j.jy, j.jm, 1);
  const next = j.jm === 12 ? { jy: j.jy + 1, jm: 1 } : { jy: j.jy, jm: j.jm + 1 };
  const endG = toGregorian(next.jy, next.jm, 1);
  const start = Date.UTC(startG.gy, startG.gm - 1, startG.gd) - tzOffset * MINUTE_MS;
  const end = Date.UTC(endG.gy, endG.gm - 1, endG.gd) - tzOffset * MINUTE_MS;
  return { from: start, to: end };
}

export function windowFor(view: UptimeView, cursor: number, tzOffset: number, calendar: CalendarMode): TimeWindow {
  if (view === 'month') return monthWindow(cursor, tzOffset, calendar);
  if (view === 'week') return weekWindow(cursor, tzOffset);
  if (view === 'day') return dayWindow(cursor, tzOffset);
  return hourWindow(cursor, tzOffset);
}

/** جابه‌جایی تقویمی یک ماه؛ روزِ ماه تا حد ممکن حفظ می‌شود. */
export function shiftMonth(cursor: number, delta: number, tzOffset: number, calendar: CalendarMode): number {
  const d = localDate(cursor, tzOffset);
  const gy = d.getUTCFullYear();
  const gm = d.getUTCMonth() + 1;
  const gd = d.getUTCDate();
  if (calendar === 'gregorian') {
    const total = gy * 12 + (gm - 1) + delta;
    const ty = Math.floor(total / 12);
    const tm = ((total % 12) + 12) % 12;
    const max = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
    return Date.UTC(ty, tm, Math.min(gd, max)) - tzOffset * MINUTE_MS;
  }
  const j = toJalali(gy, gm, gd);
  const total = j.jy * 12 + (j.jm - 1) + delta;
  const jy = Math.floor(total / 12);
  const jm = (((total % 12) + 12) % 12) + 1;
  const g = toGregorian(jy, jm, Math.min(j.jd, jalaliMonthLength(jy, jm)));
  return Date.UTC(g.gy, g.gm - 1, g.gd) - tzOffset * MINUTE_MS;
}

export function shiftCursor(
  cursor: number,
  view: UptimeView,
  delta: number,
  tzOffset: number,
  calendar: CalendarMode
): number {
  if (view === 'month') return shiftMonth(cursor, delta, tzOffset, calendar);
  if (view === 'week') return cursor + delta * 7 * DAY_MS;
  if (view === 'day') return cursor + delta * DAY_MS;
  return cursor + delta * HOUR_MS;
}

/** گام باکت هر نما؛ کوچک‌ترین گام برای دقیق‌ترین نمایش. */
export function bucketForView(view: UptimeView): number {
  if (view === 'month') return 30 * MINUTE_MS;
  if (view === 'week') return 15 * MINUTE_MS;
  if (view === 'day') return 5 * MINUTE_MS;
  return MINUTE_MS;
}

/** رنگ یک بازه بر اساس وضعیت ثبت‌شده در همان بازه. */
export function classifyPoint(point: SeriesPoint, threshold?: number | null): UptimeState {
  if (!point.samples) return 'none';
  if (point.ok <= 0 || point.status === 'offline') return 'down';
  if (
    point.down > 0 ||
    point.status === 'warning' ||
    (threshold != null && point.rtt != null && point.rtt > threshold)
  ) {
    return 'warn';
  }
  return 'up';
}

export function classifyAvailability(point: SeriesPoint): UptimeState {
  if (!point.samples) return 'none';
  if (point.availability >= 99.5) return 'up';
  if (point.availability >= 95) return 'warn';
  return 'down';
}

export interface ClippedSegment {
  point: SeriesPoint;
  from: number;
  to: number;
  state: UptimeState;
}

/** بازه‌های یک پنجره را به مرزهای همان پنجره می‌برد (باکت لبه‌ای بریده می‌شود). */
export function clippedSegments(
  points: SeriesPoint[],
  from: number,
  to: number,
  bucketMs: number,
  threshold?: number | null
): ClippedSegment[] {
  const out: ClippedSegment[] = [];
  for (const point of points) {
    const start = Math.max(point.t, from);
    const end = Math.min(point.t + bucketMs, to);
    if (end <= start) continue;
    out.push({ point, from: start, to: end, state: classifyPoint(point, threshold) });
  }
  return out;
}

export interface ClippedOutage {
  outage: Outage;
  from: number;
  to: number;
}

/** قطعی‌های واقعی، بریده‌شده با مرزهای پنجره. */
export function clippedOutages(outages: Outage[], from: number, to: number, now = Date.now()): ClippedOutage[] {
  const out: ClippedOutage[] = [];
  for (const outage of outages) {
    const start = Math.max(outage.startedAt, from);
    const end = Math.min(outage.endedAt ?? now, to);
    if (end <= start) continue;
    out.push({ outage, from: start, to: end });
  }
  return out;
}

export interface RangeStats {
  uptime: number | null;
  samples: number;
  downSamples: number;
  downtimeMs: number;
  outageCount: number;
  longestOutageMs: number;
  state: UptimeState;
}

/**
 * آمار یک پنجره. Uptime با مدت پوشش هر باکت وزن‌دهی می‌شود تا باکت‌های
 * لبه‌ای (نیمهٔ اول یا آخر روز) نتیجه را منحرف نکنند. مجموع قطعی از
 * رکوردهای واقعی قطعی می‌آید و فقط اگر رکوردی نبود، از باکت‌های ناموفق
 * تخمین زده می‌شود.
 */
export function rangeStats(
  points: SeriesPoint[],
  outages: Outage[],
  from: number,
  to: number,
  bucketMs: number,
  threshold?: number | null,
  now = Date.now()
): RangeStats {
  let weighted = 0;
  let covered = 0;
  let samples = 0;
  let downSamples = 0;
  let estimatedDownMs = 0;
  let anyWarn = false;
  let anyDown = false;

  for (const point of points) {
    const start = Math.max(point.t, from);
    const end = Math.min(point.t + bucketMs, to);
    const overlap = end - start;
    if (overlap <= 0 || point.samples <= 0) continue;
    covered += overlap;
    weighted += point.availability * overlap;
    samples += (point.samples * overlap) / bucketMs;
    downSamples += (point.down * overlap) / bucketMs;
    estimatedDownMs += overlap * (point.down / point.samples);
    const state = classifyPoint(point, threshold);
    if (state === 'down') anyDown = true;
    if (state === 'warn') anyWarn = true;
  }

  const bars = clippedOutages(outages, from, to, now);
  const recordedDownMs = bars.reduce((sum, bar) => sum + (bar.to - bar.from), 0);
  const downtimeMs = recordedDownMs > 0 ? recordedDownMs : estimatedDownMs;
  const uptime = covered > 0 ? weighted / covered : null;

  let state: UptimeState = 'none';
  if (samples > 0 || bars.length > 0) {
    if (bars.length > 0 || anyDown || (uptime != null && uptime < 95)) state = 'down';
    else if (anyWarn || (uptime != null && uptime < 99.5)) state = 'warn';
    else state = 'up';
  }

  return {
    uptime,
    samples: Math.round(samples),
    downSamples: Math.round(downSamples),
    downtimeMs,
    outageCount: bars.length || countDownRuns(points, from, to, bucketMs, threshold),
    longestOutageMs: bars.reduce((max, bar) => Math.max(max, bar.to - bar.from), 0),
    state,
  };
}

/** شمارش قطعی‌های پیوسته از روی باکت‌ها؛ جایگزین وقتی رکورد قطعی موجود نیست. */
function countDownRuns(
  points: SeriesPoint[],
  from: number,
  to: number,
  bucketMs: number,
  threshold?: number | null
): number {
  let runs = 0;
  let open = false;
  let lastEnd = 0;
  for (const segment of clippedSegments(points, from, to, bucketMs, threshold)) {
    const down = segment.state === 'down';
    if (down && (!open || segment.from - lastEnd > bucketMs * 1.6)) runs += 1;
    open = down;
    lastEnd = segment.to;
  }
  return runs;
}

export interface DayBucket extends TimeWindow {
  dayKey: string;
  stats: RangeStats;
}

/** تجمیع روزانهٔ یک ماه؛ هر روز یک خانهٔ تقویم. */
export function monthDays(
  window: TimeWindow,
  points: SeriesPoint[],
  outages: Outage[],
  bucketMs: number,
  tzOffset: number,
  threshold?: number | null,
  now = Date.now()
): DayBucket[] {
  const days: DayBucket[] = [];
  const count = Math.max(1, Math.round((window.to - window.from) / DAY_MS));
  for (let i = 0; i < count; i += 1) {
    const from = window.from + i * DAY_MS;
    const to = Math.min(from + DAY_MS, window.to);
    days.push({
      from,
      to,
      dayKey: localDateKey(from, tzOffset),
      stats: rangeStats(points, outages, from, to, bucketMs, threshold, now),
    });
  }
  return days;
}

/* ------------------------------ قالب‌بندی ------------------------------ */

const FORMAT_CACHE = new Map<string, Intl.DateTimeFormat>();

function calendarLocale(calendar: CalendarMode) {
  return calendar === 'gregorian' ? 'fa-IR' : 'fa-IR-u-ca-persian';
}

function calendarFormat(calendar: CalendarMode, options: Intl.DateTimeFormatOptions) {
  const key = `${calendar}:${JSON.stringify(options)}`;
  let formatter = FORMAT_CACHE.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(calendarLocale(calendar), { timeZone: 'UTC', ...options });
    FORMAT_CACHE.set(key, formatter);
  }
  return formatter;
}

export function formatCalendar(
  ts: number,
  options: Intl.DateTimeFormatOptions,
  tzOffset: number,
  calendar: CalendarMode
): string {
  return calendarFormat(calendar, options).format(localDate(ts, tzOffset));
}

export function monthTitle(from: number, tzOffset: number, calendar: CalendarMode): string {
  return formatCalendar(from, { year: 'numeric', month: 'long' }, tzOffset, calendar);
}

export function dayTitle(from: number, tzOffset: number, calendar: CalendarMode): string {
  return formatCalendar(from, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }, tzOffset, calendar);
}

export function shortDayTitle(from: number, tzOffset: number, calendar: CalendarMode): string {
  return formatCalendar(from, { day: 'numeric', month: 'short' }, tzOffset, calendar);
}

export function weekTitle(from: number, to: number, tzOffset: number, calendar: CalendarMode): string {
  const last = to - DAY_MS;
  return `${shortDayTitle(from, tzOffset, calendar)} تا ${shortDayTitle(last, tzOffset, calendar)}`;
}

export function periodTitle(
  view: UptimeView,
  window: TimeWindow,
  tzOffset: number,
  calendar: CalendarMode
): string {
  if (view === 'month') return monthTitle(window.from, tzOffset, calendar);
  if (view === 'week') return weekTitle(window.from, window.to, tzOffset, calendar);
  if (view === 'day') return dayTitle(window.from, tzOffset, calendar);
  // هر ساعت داخل یک جداساز دوجهته قرار می‌گیرد؛ وگرنه «۰۰:۰۰ تا ۰۱:۰۰» در
  // متن راست‌به‌چپ بازچینش می‌شود و هر دو سر بازه شبیه هم دیده می‌شوند.
  return `${shortDayTitle(window.from, tzOffset, calendar)} · ساعت ${isoLtr(
    clockLabel(window.from, tzOffset)
  )} تا ${isoLtr(clockLabel(window.to, tzOffset))}`;
}

/** متن لاتین‌گرا (ساعت/عدد) را از بازچینش دوجهتهٔ متن فارسی جدا می‌کند. */
export function isoLtr(text: string): string {
  return `\u2066${text}\u2069`;
}

export function clockLabel(ts: number, tzOffset: number): string {
  const d = localDate(ts, tzOffset);
  return faDigits(`${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`);
}
