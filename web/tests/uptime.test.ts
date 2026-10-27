/**
 * آزمون منطق مشترک نمای دسترس‌پذیری: مرز روز/هفته/ماه، برش باکت‌ها و آمار.
 * اگر این قواعد درست باشند، چهار نما دادهٔ یکسانی نشان می‌دهند.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DAY_MS,
  HOUR_MS,
  bucketForView,
  classifyPoint,
  clippedOutages,
  clippedSegments,
  dayWindow,
  hourWindow,
  localDayStart,
  monthDays,
  monthWindow,
  rangeStats,
  shiftMonth,
  weekWindow,
  weekdayIndex,
  windowFor,
  type CalendarMode,
} from '../src/lib/uptime.ts';
import type { Outage, SeriesPoint } from '../src/lib/types.ts';

const TZ = 210; // UTC+03:30

function point(t: number, overrides: Partial<SeriesPoint> = {}): SeriesPoint {
  return {
    t,
    rtt: 12,
    minRtt: 10,
    maxRtt: 14,
    loss: 0,
    availability: 100,
    samples: 10,
    ok: 10,
    down: 0,
    status: 'online',
    ...overrides,
  };
}

function outage(startedAt: number, endedAt: number | null, id = 1): Outage {
  return {
    id,
    startedAt,
    endedAt,
    durationSec: endedAt ? Math.round((endedAt - startedAt) / 1000) : 0,
    cause: 'test',
    detail: '',
    lat: null,
    lng: null,
    open: endedAt == null,
    maintenance: null,
  };
}

test('مرز روز محلی با اختلاف زمانی تنظیمات جابه‌جا می‌شود', () => {
  const noon = Date.UTC(2026, 9, 26, 12, 0, 0);
  const start = localDayStart(noon, TZ);
  assert.equal(new Date(start + TZ * 60_000).toISOString(), '2026-10-26T00:00:00.000Z');
  assert.equal(dayWindow(noon, TZ).to - dayWindow(noon, TZ).from, DAY_MS);
});

test('هفته از شنبه شروع می‌شود و هفت روز کامل دارد', () => {
  const monday = Date.UTC(2026, 9, 26, 9, 0, 0); // دوشنبه
  const week = weekWindow(monday, TZ);
  const local = new Date(week.from + TZ * 60_000);
  assert.equal(local.getUTCDay(), 6, 'شروع هفته باید شنبه باشد');
  assert.equal(week.to - week.from, 7 * DAY_MS);
  assert.equal(weekdayIndex(monday, TZ), 2);
});

test('نمای ساعتی دقیقاً یک ساعت است و به ساعت محلی تراز می‌شود', () => {
  const ts = Date.UTC(2026, 9, 26, 12, 34, 56);
  const hour = hourWindow(ts, TZ);
  assert.equal(hour.to - hour.from, HOUR_MS);
  const local = new Date(hour.from + TZ * 60_000);
  assert.equal(local.getUTCMinutes(), 0);
  assert.equal(local.getUTCSeconds(), 0);
});

test('ماه شمسی و میلادی مرزهای درست و طول درست دارند', () => {
  const ts = Date.UTC(2026, 9, 26, 12, 0, 0);
  for (const calendar of ['jalali', 'gregorian'] as CalendarMode[]) {
    const month = monthWindow(ts, TZ, calendar);
    assert.ok(ts >= month.from && ts < month.to);
    const length = (month.to - month.from) / DAY_MS;
    assert.ok(length === 29 || length === 30 || length === 31, `${calendar}: ${length}`);
    const first = new Date(month.from + TZ * 60_000);
    if (calendar === 'gregorian') assert.equal(first.getUTCDate(), 1);
  }
});

test('جابه‌جایی ماه روز را حفظ می‌کند و از مرز سال رد می‌شود', () => {
  const cursor = Date.UTC(2026, 0, 15, 12, 0, 0);
  const prev = shiftMonth(cursor, -1, TZ, 'gregorian');
  const prevLocal = new Date(prev + TZ * 60_000);
  assert.equal(prevLocal.getUTCMonth(), 11);
  assert.equal(prevLocal.getUTCFullYear(), 2025);
  assert.equal(prevLocal.getUTCDate(), 15);

  const jalali = monthWindow(Date.UTC(2026, 2, 25, 12, 0, 0), TZ, 'jalali');
  const next = shiftMonth(jalali.from + 2 * DAY_MS, 1, TZ, 'jalali');
  assert.ok(next >= jalali.to, 'ماه بعد باید پس از پایان ماه جاری باشد');
});

test('انتخاب پنجره و باکت هر نما درست است', () => {
  const cursor = Date.UTC(2026, 9, 26, 12, 0, 0);
  for (const view of ['month', 'week', 'day', 'hour'] as const) {
    const window = windowFor(view, cursor, TZ, 'jalali');
    assert.ok(window.from <= cursor && cursor < window.to, view);
    assert.ok(bucketForView(view) > 0, view);
  }
});

test('تشخیص وضعیت: سبز، نارنجی و قرمز', () => {
  assert.equal(classifyPoint(point(0)), 'up');
  assert.equal(classifyPoint(point(0, { down: 1, ok: 9, availability: 90 })), 'warn');
  assert.equal(classifyPoint(point(0, { ok: 0, down: 10, availability: 0, status: 'offline' })), 'down');
  assert.equal(classifyPoint(point(0, { samples: 0 })), 'none');
  assert.equal(classifyPoint(point(0, { rtt: 90 }), 50), 'warn');
});

test('برش باکت لبه‌ای و قطعی با مرز پنجره', () => {
  const from = 1000;
  const to = 5000;
  const segments = clippedSegments([point(0), point(4000)], from, to, 2000);
  assert.equal(segments[0].from, 1000);
  assert.equal(segments[0].to, 2000);
  assert.equal(segments[1].to, 5000);

  const bars = clippedOutages([outage(500, 3000)], from, to, to);
  assert.equal(bars[0].from, 1000);
  assert.equal(bars[0].to, 3000);
});

test('آمار پنجره با وزن مدت پوشش و قطعی واقعی محاسبه می‌شود', () => {
  const from = 0;
  const to = 4 * HOUR_MS;
  const bucket = HOUR_MS;
  const points = [
    point(0),
    point(HOUR_MS),
    point(2 * HOUR_MS, { availability: 50, ok: 5, down: 5 }),
    point(3 * HOUR_MS),
  ];
  const stats = rangeStats(points, [outage(HOUR_MS + 10 * 60_000, HOUR_MS + 40 * 60_000)], from, to, bucket, null, to);
  assert.equal(stats.outageCount, 1);
  assert.equal(stats.downtimeMs, 30 * 60_000);
  assert.ok(stats.uptime != null && Math.abs(stats.uptime - 87.5) < 0.01, String(stats.uptime));
  assert.equal(stats.state, 'down');
});

test('روزهای ماه کامل و هم‌راستا با تقویم انتخاب‌شده‌اند', () => {
  const window = monthWindow(Date.UTC(2026, 9, 26, 12, 0, 0), TZ, 'jalali');
  const days = monthDays(window, [point(window.from + 2 * DAY_MS)], [], 30 * 60_000, TZ, null, window.to);
  assert.equal(days.length, Math.round((window.to - window.from) / DAY_MS));
  assert.equal(days[0].from, window.from);
  assert.equal(days[2].stats.state, 'up');
  assert.equal(days[1].stats.state, 'none');
});
