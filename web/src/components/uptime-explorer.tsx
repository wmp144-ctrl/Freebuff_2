import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Clock,
  Percent,
  Radio,
  RefreshCw,
  Timer,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { useApp, useAsync } from '../lib/store';
import { faDigits, fmtDateTime, fmtDuration, fmtMs, fmtNumber, fmtPct, statusMeta } from '../lib/format';
import { Card, CardHeader } from './ui';
import {
  DAY_MS,
  HOUR_MS,
  UPTIME_COLORS,
  UPTIME_LABELS,
  UPTIME_TINTS,
  VIEW_LABELS,
  WEEKDAY_LABELS,
  WEEKDAY_SHORT,
  bucketForView,
  classifyAvailability,
  clippedOutages,
  clippedSegments,
  clockLabel,
  dayTitle,
  formatCalendar,
  isoLtr,
  localDateKey,
  monthDays,
  periodTitle,
  rangeStats,
  shiftCursor,
  shortDayTitle,
  weekTitle,
  weekdayIndex,
  windowFor,
  type ClippedOutage,
  type ClippedSegment,
  type DayBucket,
  type RangeStats,
  type TimeWindow,
  type UptimeState,
  type UptimeView,
} from '../lib/uptime';
import type { CalendarMode } from '../lib/uptime';
import type { DeviceStatus, Outage, Series } from '../lib/types';

/* ------------------------------ انواع کمکی ------------------------------ */

interface TipRow {
  label: string;
  value: string;
  color?: string;
}

interface HoverInfo {
  title: React.ReactNode;
  rows: TipRow[];
  note?: string;
}

interface HoverTip extends HoverInfo {
  x: number;
  y: number;
  /** اگر بالای مکان‌نما جا نباشد، زیر آن باز می‌شود */
  below: boolean;
}

interface Selection {
  title: React.ReactNode;
  from: number;
  to: number;
  stats: RangeStats;
  bars: ClippedOutage[];
}

type HoverHandler = (event: React.MouseEvent, info: HoverInfo) => void;
type SelectHandler = (from: number, to: number, title: React.ReactNode) => void;

interface ExplorerProps {
  deviceId: number | string;
  currentStatus?: DeviceStatus | string;
  threshold?: number | null;
  initialView?: UptimeView;
  className?: string;
}

const UPTIME_TEXT: Record<UptimeState, string> = {
  up: 'text-emerald-600',
  warn: 'text-sun-600',
  down: 'text-red-600',
  none: 'text-ink-500',
};

const VIEWS: UptimeView[] = ['month', 'week', 'day', 'hour'];

/**
 * کاوشگر دسترس‌پذیری تجهیز.
 *
 * یک منبع داده و یک قاعدهٔ رنگ برای چهار نما؛ با همین یک کامپوننت هر جای
 * برنامه که «تاریخچهٔ Online/Offline یا Availability» لازم است، نمای کامل
 * ماهانه/هفتگی/روزانه/ساعتی در دسترس خواهد بود.
 */
export function AvailabilityExplorer({
  deviceId,
  currentStatus,
  threshold,
  initialView = 'day',
  className = '',
}: ExplorerProps) {
  const { settings, tzOffset } = useApp();
  const calendar: CalendarMode = settings?.calendar === 'gregorian' ? 'gregorian' : 'jalali';
  const [view, setView] = useState<UptimeView>(initialView);
  const [cursor, setCursor] = useState(() => Date.now());
  const [tip, setTip] = useState<HoverTip | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // قطعی باز و آمار «امروز» بدون دریافت دوبارهٔ داده هم به‌روز بماند.
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const window: TimeWindow = useMemo(
    () => windowFor(view, cursor, tzOffset, calendar),
    [view, cursor, tzOffset, calendar]
  );
  const bucketMs = bucketForView(view);
  const live = window.from <= now && now < window.to;
  // پنجرهٔ تاریخی ثابت است و نیازی به دریافت دوره‌ای ندارد؛ ماه جاری هم
  // لازم نیست هر ۳۰ ثانیه با ۱۴۰۰ باکت دوباره خوانده شود.
  const pollMs = live ? (view === 'hour' ? 30_000 : view === 'day' ? 60_000 : view === 'week' ? 120_000 : 300_000) : undefined;

  const seriesState = useAsync<Series>(
    (signal) => api.seriesWindow(deviceId, { from: window.from, to: window.to, bucket: bucketMs }, signal),
    [deviceId, window.from, window.to, bucketMs],
    { interval: pollMs }
  );
  const outageState = useAsync(
    (signal) => api.outagesWindow(deviceId, { from: window.from, to: window.to }, signal),
    [deviceId, window.from, window.to],
    { interval: pollMs }
  );

  const series = useMemo(() => {
    const data = seriesState.data;
    if (!data) return null;
    if (Math.abs(data.from - window.from) > 1500 || Math.abs(data.to - window.to) > 1500) return null;
    return data;
  }, [seriesState.data, window.from, window.to]);

  const outages = useMemo(() => {
    const data = outageState.data;
    if (!data) return null;
    if (typeof data.from !== 'number' || typeof data.to !== 'number') return null;
    if (Math.abs(data.from - window.from) > 1500 || Math.abs(data.to - window.to) > 1500) return null;
    return data.items;
  }, [outageState.data, window.from, window.to]);

  const points = series?.points ?? [];
  const outageItems = outages ?? [];
  const ready = Boolean(series) && outages !== null;

  const stats = useMemo(
    () => rangeStats(points, outageItems, window.from, window.to, bucketMs, threshold, now),
    [points, outageItems, window.from, window.to, bucketMs, threshold, now]
  );

  const clearContext = () => {
    setTip(null);
    setSelection(null);
  };

  const changeView = (next: UptimeView) => {
    if (next === view) return;
    setView(next);
    clearContext();
  };

  const move = (delta: number) => {
    setCursor((current) => shiftCursor(current, view, delta, tzOffset, calendar));
    clearContext();
  };

  const goNow = () => {
    setCursor(Date.now());
    clearContext();
  };

  const openDay = (ts: number) => {
    setCursor(ts);
    setView('day');
    setTip(null);
    setSelection(null);
  };

  const openWeek = (ts: number) => {
    setCursor(ts);
    setView('week');
    setTip(null);
    setSelection(null);
  };

  const openHour = (ts: number) => {
    setCursor(ts);
    setView('hour');
    setTip(null);
    setSelection(null);
  };

  const showTip = useCallback((event: React.MouseEvent, info: HoverInfo) => {
    // مختصات نسبت به viewport؛ تولتیپ در portal رندر می‌شود تا هرگز داخل
    // قاب اسکرول‌شوندهٔ ویجت بریده نشود.
    const viewportWidth = document.documentElement.clientWidth || 1024;
    const x = Math.min(viewportWidth - 120, Math.max(120, event.clientX));
    setTip({
      ...info,
      x,
      y: Math.max(8, event.clientY),
      below: event.clientY < 180,
    });
  }, []);

  const selectRange = useCallback(
    (from: number, to: number, title: React.ReactNode) => {
      const safeTo = Math.max(from + 1, to);
      setSelection({
        title,
        from,
        to: safeTo,
        stats: rangeStats(points, outageItems, from, safeTo, bucketMs, threshold, now),
        bars: clippedOutages(outageItems, from, safeTo, now),
      });
      setTip(null);
    },
    [points, outageItems, bucketMs, threshold, now]
  );

  const refresh = () => {
    seriesState.refresh();
    outageState.refresh();
  };

  const viewHint =
    view === 'month'
      ? 'روی هر روز کلیک کنید تا نمای روزانه باز شود؛ از ستون کنار هر هفته به نمای هفتگی بروید.'
      : view === 'week'
        ? 'هر ردیف: نوار وضعیت، نوار نازک دسترس‌پذیری و خط قطعی‌ها. روی نام روز برای نمای روزانه کلیک کنید.'
        : view === 'day'
          ? 'هر ردیف: نوار وضعیت، نوار نازک دسترس‌پذیری و خط قطعی‌ها. روی برچسب هر بازهٔ ۴ ساعته برای نمای ساعتی کلیک کنید.'
          : 'سه نوار: وضعیت اتصال، دسترس‌پذیری و قطعی‌های ثبت‌شده. زوم با اسکرول ماوس و جابه‌جایی با کشیدن نمودار.';

  return (
    <Card className={`flex flex-col overflow-visible ${className}`}>
      <CardHeader
        title="دسترس‌پذیری و وضعیت اتصال"
        subtitle="تاریخچهٔ یکپارچهٔ Online/Offline، Availability و قطعی‌های ثبت‌شده"
        icon={<Activity size={18} />}
        action={
          <button type="button" className="btn-ghost btn-xs" onClick={refresh} aria-label="بروزرسانی نمودار دسترس‌پذیری">
            <RefreshCw size={13} className={seriesState.refreshing || outageState.refreshing ? 'animate-spin' : ''} />
            بروزرسانی
          </button>
        }
      />

      {/* آمار بالای نمودار — مستقل از نما، از همان پنجرهٔ انتخاب‌شده */}
      <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Metric
          label="Uptime"
          value={ready ? fmtPct(stats.uptime, 2) : '—'}
          hint={ready ? `${fmtNumber(stats.samples)} بررسی در این بازه` : 'در حال محاسبه…'}
          tone={UPTIME_TEXT[stats.state]}
          icon={<Percent size={13} />}
        />
        <Metric
          label="مجموع Downtime"
          value={ready ? fmtDuration(stats.downtimeMs / 1000) : '—'}
          hint={stats.longestOutageMs ? `طولانی‌ترین: ${fmtDuration(stats.longestOutageMs / 1000)}` : 'قطعی ثبت‌شده‌ای نیست'}
          tone={stats.downtimeMs > 0 ? 'text-red-600' : 'text-emerald-600'}
          icon={<Timer size={13} />}
        />
        <Metric
          label="تعداد قطعی‌ها"
          value={ready ? fmtNumber(stats.outageCount) : '—'}
          hint="بر اساس رویدادهای همین بازه"
          tone={stats.outageCount ? 'text-sun-600' : 'text-emerald-600'}
          icon={<AlertTriangle size={13} />}
        />
        <Metric
          label="وضعیت فعلی شبکه"
          value={
            <span className="inline-flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${statusMeta(currentStatus).dot}`} />
              {statusMeta(currentStatus).label}
            </span>
          }
          hint={live ? 'این بازه شامل لحظهٔ اکنون است' : 'نمای تاریخی'}
          tone={statusMeta(currentStatus).text}
          icon={<Radio size={13} />}
        />
      </div>

      {/* انتخاب نما و جابه‌جایی دوره */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex items-center gap-0.5 rounded-soft border border-ink-200 bg-white/80 p-0.5" role="tablist" aria-label="نمای زمانی">
          {VIEWS.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={view === item}
              onClick={() => changeView(item)}
              className={`rounded-[10px] px-2.5 py-1.5 text-[11.5px] font-medium transition-all duration-200 ${
                view === item
                  ? 'bg-brand-600 text-white shadow-soft'
                  : 'text-ink-500 hover:bg-ink-50 hover:text-ink-700'
              }`}
            >
              {VIEW_LABELS[item]}
            </button>
          ))}
        </div>

        <div className="flex min-w-0 items-center gap-1">
          <button type="button" className="nav-arrow" onClick={() => move(-1)} aria-label="دورهٔ قبل" title="دورهٔ قبل">
            <ChevronRight size={15} />
          </button>
          <span className="min-w-[132px] text-center text-[12px] font-semibold text-ink-700">{periodTitle(view, window, tzOffset, calendar)}</span>
          <button type="button" className="nav-arrow" onClick={() => move(1)} aria-label="دورهٔ بعد" title="دورهٔ بعد">
            <ChevronLeft size={15} />
          </button>
          <button type="button" className="btn-ghost btn-xs ms-1" onClick={goNow} title="بازگشت به اکنون">
            <Clock size={12} />
            اکنون
          </button>
        </div>
      </div>

      {/* نمودار */}
      <div
        className="relative mt-3 flex-1"
        style={{ minHeight: view === 'month' ? 300 : view === 'week' ? 235 : view === 'day' ? 220 : 160 }}
      >
        <div key={`${view}-${window.from}`} className="h-full animate-fade-in">
        {!ready ? (
          <ExplorerSkeleton error={seriesState.error || outageState.error} onRetry={refresh} />
        ) : view === 'month' ? (
          <MonthCalendar
            days={monthDays(window, points, outageItems, bucketMs, tzOffset, threshold, now)}
            window={window}
            tzOffset={tzOffset}
            calendar={calendar}
            now={now}
            onHover={showTip}
            onLeave={() => setTip(null)}
            onOpenDay={openDay}
            onOpenWeek={openWeek}
          />
        ) : view === 'week' ? (
          <LaneGrid
            rows={Array.from({ length: 7 }, (_, i) => ({ from: window.from + i * DAY_MS, to: window.from + (i + 1) * DAY_MS }))}
            axisHours
            window={window}
            points={points}
            bucketMs={bucketMs}
            outages={outageItems}
            tzOffset={tzOffset}
            calendar={calendar}
            threshold={threshold}
            now={now}
            onHover={showTip}
            onLeave={() => setTip(null)}
            onSelect={selectRange}
            onOpenRow={openDay}
            rowMode="day"
          />
        ) : view === 'day' ? (
          <LaneGrid
            rows={Array.from({ length: 6 }, (_, i) => ({ from: window.from + i * 4 * HOUR_MS, to: window.from + (i + 1) * 4 * HOUR_MS }))}
            window={window}
            points={points}
            bucketMs={bucketMs}
            outages={outageItems}
            tzOffset={tzOffset}
            calendar={calendar}
            threshold={threshold}
            now={now}
            onHover={showTip}
            onLeave={() => setTip(null)}
            onSelect={selectRange}
            onOpenRow={openHour}
            rowMode="hour"
          />
        ) : (
          <HourTimeline
            window={window}
            points={points}
            bucketMs={bucketMs}
            outages={outageItems}
            tzOffset={tzOffset}
            threshold={threshold}
            now={now}
            onHover={showTip}
            onLeave={() => setTip(null)}
            onSelect={selectRange}
          />
        )}
        </div>

        {tip ? createPortal(<HoverCard tip={tip} />, document.body) : null}
      </div>

      {/* راهنما و راهنمای تعامل */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-ink-100 pt-2.5 text-[10.5px] text-ink-500">
        {(['up', 'warn', 'down', 'none'] as UptimeState[]).map((state) => (
          <span key={state} className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: UPTIME_COLORS[state] }} />
            {UPTIME_LABELS[state]}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[3px] bg-red-700" />
          قطعی ثبت‌شده
        </span>
        <span className="ms-auto text-ink-400">{viewHint}</span>
      </div>

      {selection ? <SelectionPanel selection={selection} tzOffset={tzOffset} onClose={() => setSelection(null)} /> : null}
    </Card>
  );
}

/* ------------------------------ آمار بالای نمودار ------------------------------ */

function Metric({
  label,
  value,
  hint,
  tone = 'text-ink-800',
  icon,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-soft border border-ink-200/70 bg-white/75 px-3 py-2.5 backdrop-blur">
      <p className="flex items-center gap-1.5 text-[10.5px] text-ink-400">
        {icon}
        {label}
      </p>
      <p className={`mt-1 text-[16px] font-bold ${tone}`}>{value}</p>
      {hint ? <p className="mt-0.5 truncate text-[9.5px] text-ink-400">{hint}</p> : null}
    </div>
  );
}

/* ------------------------------ نمای ماهانه ------------------------------ */

function MonthCalendar({
  days,
  window,
  tzOffset,
  calendar,
  now,
  onHover,
  onLeave,
  onOpenDay,
  onOpenWeek,
}: {
  days: DayBucket[];
  window: TimeWindow;
  tzOffset: number;
  calendar: CalendarMode;
  now: number;
  onHover: HoverHandler;
  onLeave: () => void;
  onOpenDay: (ts: number) => void;
  onOpenWeek: (ts: number) => void;
}) {
  const lead = weekdayIndex(window.from, tzOffset);
  const cells: (DayBucket | null)[] = [...Array.from({ length: lead }, () => null), ...days];
  while (cells.length % 7 !== 0) cells.push(null);
  const weekRows = Array.from({ length: Math.ceil(cells.length / 7) }, (_, i) => cells.slice(i * 7, i * 7 + 7));
  const todayKey = localDateKey(now, tzOffset);

  const dayHover = (event: React.MouseEvent, day: DayBucket) => {
    onHover(event, {
      title: dayTitle(day.from, tzOffset, calendar),
      rows: [
        { label: 'وضعیت', value: UPTIME_LABELS[day.stats.state], color: UPTIME_COLORS[day.stats.state] },
        { label: 'دسترس‌پذیری', value: day.stats.uptime == null ? 'بدون داده' : fmtPct(day.stats.uptime, 2) },
        { label: 'مجموع قطعی', value: day.stats.downtimeMs ? fmtDuration(day.stats.downtimeMs / 1000) : '—' },
        { label: 'تعداد قطعی', value: fmtNumber(day.stats.outageCount) },
      ],
      note: 'برای باز کردن نمای روزانه کلیک کنید',
    });
  };

  return (
    <div>
      <div className="grid grid-cols-[30px_repeat(7,minmax(0,1fr))] gap-1 sm:grid-cols-[44px_repeat(7,minmax(0,1fr))] sm:gap-1.5">
        <span className="text-center text-[9px] text-ink-400">هفته</span>
        {WEEKDAY_LABELS.map((label, i) => (
          <span key={label} className="pb-1 text-center text-[9.5px] font-medium text-ink-400">
            <span className="hidden sm:inline">{label}</span>
            <span className="sm:hidden">{WEEKDAY_SHORT[i]}</span>
          </span>
        ))}

        {weekRows.map((row, wi) => {
          const weekStart = window.from + (wi * 7 - lead) * DAY_MS;
          const week = { from: weekStart, to: weekStart + 7 * DAY_MS };
          return (
            <React.Fragment key={wi}>
              <button
                type="button"
                onClick={() => onOpenWeek(weekStart)}
                className="group flex flex-col items-center justify-center gap-0.5 rounded-[9px] border border-dashed border-ink-200/80 text-[9px] text-ink-400 transition hover:border-brand-300 hover:bg-brand-50/60 hover:text-brand-700"
                title={`نمای هفتگی ${weekTitle(week.from, week.to, tzOffset, calendar)}`}
                aria-label={`نمای هفتگی ${weekTitle(week.from, week.to, tzOffset, calendar)}`}
              >
                <span className="hidden sm:inline">هفته</span>
                <span className="num text-[11px] font-semibold">{faDigits(wi + 1)}</span>
              </button>

              {row.map((day, di) => {
                if (!day) return <span key={`empty-${wi}-${di}`} className="min-h-[52px] rounded-[10px]" />;
                const state = day.stats.state;
                const color = UPTIME_COLORS[state];
                const isToday = day.dayKey === todayKey;
                const future = day.from > now;
                return (
                  <button
                    key={day.dayKey}
                    type="button"
                    onMouseEnter={(e) => dayHover(e, day)}
                    onMouseLeave={onLeave}
                    onClick={() => onOpenDay(day.from)}
                    className={`group relative flex min-h-[52px] flex-col items-stretch justify-between overflow-hidden rounded-[10px] border p-1.5 text-right transition-all duration-200 hover:-translate-y-0.5 hover:shadow-soft focus-visible:z-10 ${
                      future ? 'opacity-55' : ''
                    }`}
                    style={{
                      background: UPTIME_TINTS[state],
                      borderColor: `${color}40`,
                      boxShadow: isToday ? 'inset 0 0 0 2px rgba(37,99,235,0.75)' : undefined,
                    }}
                    title={`${dayTitle(day.from, tzOffset, calendar)} — ${UPTIME_LABELS[state]}`}
                  >
                    <span className="flex items-start justify-between gap-1">
                      <span className={`num text-[9px] font-semibold ${state === 'none' ? 'text-ink-400' : 'text-ink-600'}`}>
                        {formatCalendar(day.from, { day: 'numeric' }, tzOffset, calendar)}
                      </span>
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
                    </span>
                    <span className="mt-1 block min-w-0">
                      <span className={`num block truncate text-[9px] font-semibold ${UPTIME_TEXT[state]}`}>
                        {day.stats.uptime == null ? '—' : fmtPct(day.stats.uptime, 1)}
                      </span>
                      <span className="mt-1 block h-1 w-full overflow-hidden rounded-pill bg-white/70">
                        <span
                          className="block h-full rounded-pill transition-[width] duration-500"
                          style={{
                            width: `${Math.max(0, Math.min(100, day.stats.uptime ?? 0))}%`,
                            background: color,
                          }}
                        />
                      </span>
                    </span>
                    {day.stats.outageCount ? (
                      <span className="absolute -left-0.5 top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full bg-red-500" aria-hidden />
                    ) : null}
                  </button>
                );
              })}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

/* --------------------------- ردیف‌های هفتگی/روزانه --------------------------- */

function LaneGrid({
  rows,
  window,
  points,
  bucketMs,
  outages,
  tzOffset,
  calendar,
  threshold,
  now,
  onHover,
  onLeave,
  onSelect,
  onOpenRow,
  rowMode,
  axisHours = false,
}: {
  rows: TimeWindow[];
  window: TimeWindow;
  points: Series['points'];
  bucketMs: number;
  outages: Outage[];
  tzOffset: number;
  calendar: CalendarMode;
  threshold?: number | null;
  now: number;
  onHover: HoverHandler;
  onLeave: () => void;
  onSelect: SelectHandler;
  onOpenRow: (ts: number) => void;
  rowMode: 'day' | 'hour';
  axisHours?: boolean;
}) {
  const rowData = useMemo(
    () =>
      rows.map((row) => ({
        ...row,
        segments: clippedSegments(points, row.from, row.to, bucketMs, threshold),
        bars: clippedOutages(outages, row.from, row.to, now),
      })),
    [rows, points, bucketMs, threshold, outages, now]
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="w-[78px] shrink-0 sm:w-[112px]" />
        {axisHours ? (
          <HourAxis window={{ from: window.from, to: window.from + DAY_MS }} tzOffset={tzOffset} ticks={8} endLabel="۲۴:۰۰" />
        ) : (
          // هر ردیف نمای روزانه دقیقاً ۴ ساعت است، پس محور مشترک، ساعتِ
          // داخل همان ردیف را نشان می‌دهد (۰۰:۰۰ تا ۰۴:۰۰).
          <div className="relative flex flex-1 items-center justify-between text-[9.5px] text-ink-500" dir="ltr">
            {[0, 1, 2, 3, 4].map((h) => (
              <span key={h} className="num whitespace-nowrap">
                {isoLtr(`${faDigits(String(h).padStart(2, '0'))}:۰۰`)}
              </span>
            ))}
          </div>
        )}
      </div>

      {rowData.map((row) => {
        const dayStart = rowMode === 'day';
        const future = row.from > now;
        const label = dayStart
          ? WEEKDAY_LABELS[weekdayIndex(row.from, tzOffset)]
          : null;
        const sub = future ? 'آینده' : dayStart ? shortDayTitle(row.from, tzOffset, calendar) : '۴ ساعت';
        return (
          <div key={row.from} className={`flex items-stretch gap-2 ${future ? 'opacity-55' : ''}`}>
            <button
              type="button"
              onClick={() => onOpenRow(row.from)}
              className="group flex w-[78px] shrink-0 flex-col items-start justify-center rounded-[8px] px-1 py-0.5 text-right transition hover:bg-brand-50/70 sm:w-[112px]"
              title={dayStart ? `نمای روزانهٔ ${dayTitle(row.from, tzOffset, calendar)}` : 'نمای ساعتی این بازه'}
            >
              <span className="w-full truncate text-[11px] font-medium text-ink-700 group-hover:text-brand-700">
                {dayStart ? label : <LaneClockRange from={row.from} to={row.to} tzOffset={tzOffset} />}
              </span>
              <span className="w-full truncate text-[9px] text-ink-400">{sub}</span>
            </button>

            <div className="relative min-w-0 flex-1" onMouseLeave={onLeave}>
              <div className="relative">
                <div className="flex flex-col gap-[2px] py-0.5">
                  <StatusLane
                    from={row.from}
                    to={row.to}
                    segments={row.segments}
                    height={16}
                    onHover={onHover}
                    onSelect={onSelect}
                    tzOffset={tzOffset}
                  />
                  <AvailabilityLane
                    from={row.from}
                    to={row.to}
                    segments={row.segments}
                    height={4}
                    tzOffset={tzOffset}
                    onHover={onHover}
                    onSelect={onSelect}
                  />
                  <OutageLane
                    from={row.from}
                    to={row.to}
                    bars={row.bars}
                    height={4}
                    tzOffset={tzOffset}
                    onHover={onHover}
                    onSelect={onSelect}
                  />
                </div>
                <span
                  className="pointer-events-none absolute inset-0"
                  style={{
                    backgroundImage: 'linear-gradient(to right, rgba(148,163,184,0.22) 1px, transparent 1px)',
                    backgroundSize: axisHours ? '12.5% 100%' : '25% 100%',
                  }}
                  aria-hidden
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------ نمای ساعتی ------------------------------ */

function HourTimeline({
  window,
  points,
  bucketMs,
  outages,
  tzOffset,
  threshold,
  now,
  onHover,
  onLeave,
  onSelect,
}: {
  window: TimeWindow;
  points: Series['points'];
  bucketMs: number;
  outages: Outage[];
  tzOffset: number;
  threshold?: number | null;
  now: number;
  onHover: HoverHandler;
  onLeave: () => void;
  onSelect: SelectHandler;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  const pendingAnchor = useRef<{ ratio: number; x: number } | null>(null);
  const dragRef = useRef<{ x: number; left: number } | null>(null);
  const didDrag = useRef(false);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  zoomRef.current = zoom;

  const segments = useMemo(
    () => clippedSegments(points, window.from, window.to, bucketMs, threshold),
    [points, window.from, window.to, bucketMs, threshold]
  );
  const bars = useMemo(() => clippedOutages(outages, window.from, window.to, now), [outages, window.from, window.to, now]);

  useEffect(() => {
    setZoom(1);
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
  }, [window.from]);

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const read = () => setWidth(Math.max(0, Math.round(el.clientWidth)));
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const contentWidth = Math.max(300, Math.round((width || 640) * zoom));

  const applyZoom = useCallback((next: number, clientX?: number) => {
    const el = scrollRef.current;
    const clamped = Math.min(16, Math.max(1, Number(next.toFixed(3))));
    if (!el) {
      setZoom(clamped);
      return;
    }
    const rect = el.getBoundingClientRect();
    const x = clientX == null ? el.clientWidth / 2 : clientX - rect.left;
    pendingAnchor.current = { ratio: (el.scrollLeft + x) / Math.max(1, el.scrollWidth), x };
    setZoom(clamped);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    const anchor = pendingAnchor.current;
    if (!el || !anchor) return;
    el.scrollLeft = Math.max(0, anchor.ratio * el.scrollWidth - anchor.x);
    pendingAnchor.current = null;
  }, [zoom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      // در بزرگ‌نمایی کامل، چرخ به سمت پایین به اسکرول صفحه می‌رسد تا نمودار
      // صفحه را قفل نکند؛ چرخ به بالا همیشه زوم می‌کند.
      if (zoomRef.current <= 1 && event.deltaY > 0) return;
      event.preventDefault();
      onLeave();
      const factor = event.deltaY < 0 ? 1.25 : 0.8;
      applyZoom(zoomRef.current * factor, event.clientX);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyZoom, onLeave]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const el = scrollRef.current;
    if (!el) return;
    dragRef.current = { x: event.clientX, left: el.scrollLeft };
    didDrag.current = false;
    // عمداً Pointer Capture نمی‌گیریم: با capture، رویداد click به عنصر
    // اسکرول رتارگت می‌شود و کلیک روی قطعه‌ها/نوار قطعی هرگز به handler نمی‌رسد.
    onLeave();
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    const drag = dragRef.current;
    if (!el || !drag) return;
    const dx = event.clientX - drag.x;
    if (Math.abs(dx) > 3 && zoom > 1) didDrag.current = true;
    el.scrollLeft = drag.left - dx;
  };

  const endDrag = () => {
    dragRef.current = null;
    setDragging(false);
  };

  const guardClick = (action: () => void) => {
    if (didDrag.current) {
      didDrag.current = false;
      return;
    }
    action();
  };

  const visibleMs = (window.to - window.from) / zoom;
  const tickStep = visibleMs <= 6 * 60_000 ? 60_000 : visibleMs <= 20 * 60_000 ? 5 * 60_000 : 10 * 60_000;
  const ticks = useMemo(() => {
    const list: number[] = [];
    for (let t = window.from; t <= window.to; t += tickStep) list.push(t);
    if (list[list.length - 1] !== window.to) list.push(window.to);
    return list;
  }, [window.from, window.to, tickStep]);

  return (
    <div ref={frameRef} className="flex h-full min-h-[150px] flex-col">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] text-ink-400">
          <span className="num">{clockLabel(window.from, tzOffset)}</span> تا <span className="num">{clockLabel(window.to, tzOffset)}</span> · دقت {faDigits(Math.round(bucketMs / 60_000))} دقیقه
        </p>
        <div className="flex items-center gap-1 text-[10px] text-ink-500">
          <span className="me-1 hidden sm:inline">زوم با اسکرول ماوس</span>
          <button
            type="button"
            className="grid h-6 w-6 place-items-center rounded-md border border-ink-200 bg-white text-[13px] text-ink-600 hover:bg-ink-50 disabled:opacity-40"
            onClick={() => applyZoom(zoom / 1.5)}
            disabled={zoom <= 1}
            aria-label="کوچک‌نمایی"
          >
            −
          </button>
          <span className="num min-w-[32px] text-center font-semibold text-ink-600">{faDigits(Number(zoom.toFixed(1)))}×</span>
          <button
            type="button"
            className="grid h-6 w-6 place-items-center rounded-md border border-ink-200 bg-white text-[13px] text-ink-600 hover:bg-ink-50 disabled:opacity-40"
            onClick={() => applyZoom(zoom * 1.5)}
            disabled={zoom >= 16}
            aria-label="بزرگ‌نمایی"
          >
            +
          </button>
          <button
            type="button"
            className="ms-1 rounded-md border border-ink-200 bg-white px-1.5 py-1 text-[9.5px] text-ink-500 hover:bg-ink-50"
            onClick={() => applyZoom(1)}
          >
            بازنشانی
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 items-start gap-2">
        {/* برچسب لایه‌ها بیرون از ناحیهٔ اسکرول می‌ماند تا هنگام زوم جابه‌جا نشود. */}
        <div className="w-[86px] shrink-0 text-[9px] text-ink-400" dir="rtl">
          <div className="h-5" />
          <p className="mb-1 truncate leading-[14px]">وضعیت اتصال</p>
          <div style={{ height: 30 }} />
          <p className="mb-1 mt-2 truncate leading-[14px]">دسترس‌پذیری</p>
          <div style={{ height: 6 }} />
          <p className="mb-1 mt-2 truncate leading-[14px]">قطعی‌های ثبت‌شده</p>
          <div style={{ height: 6 }} />
        </div>

        <div
          ref={scrollRef}
          dir="ltr"
          className={`relative min-h-0 flex-1 overflow-x-auto overflow-y-hidden pb-1 ${dragging ? 'cursor-grabbing' : zoom > 1 ? 'cursor-grab' : ''}`}
          onMouseLeave={onLeave}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          style={{ touchAction: 'pan-x' }}
        >
          <div style={{ width: contentWidth }} className="relative select-none">
            {/* محور زمان */}
            <div className="relative h-5">
              {ticks.map((tick) => {
                const left = ((tick - window.from) / Math.max(1, window.to - window.from)) * 100;
                return (
                  <span
                    key={tick}
                    className="num absolute top-0 whitespace-nowrap text-[9.5px] text-ink-500"
                    style={{
                      left: `${left}%`,
                      transform: left <= 0 ? 'translateX(0)' : left >= 100 ? 'translateX(-100%)' : 'translateX(-50%)',
                    }}
                  >
                    {clockLabel(tick, tzOffset)}
                  </span>
                );
              })}
            </div>

            <p className="mb-1 text-[9px] leading-[14px] text-ink-400">&nbsp;</p>
            <div className="relative">
              {ticks.map((tick) => {
                const left = ((tick - window.from) / Math.max(1, window.to - window.from)) * 100;
                return <span key={`grid-${tick}`} className="pointer-events-none absolute inset-y-0 w-px bg-ink-900/5" style={{ left: `${left}%` }} />;
              })}
              <StatusLane
                from={window.from}
                to={window.to}
                segments={segments}
                height={30}
                tzOffset={tzOffset}
                onHover={onHover}
                onSelect={(from, to, title) => guardClick(() => onSelect(from, to, title))}
              />
            </div>

            <p className="mb-1 mt-2 text-[9px] leading-[14px] text-ink-400">&nbsp;</p>
            <AvailabilityLane
              from={window.from}
              to={window.to}
              segments={segments}
              height={6}
              tzOffset={tzOffset}
              onHover={onHover}
              onSelect={onSelect}
            />
            <p className="mb-1 mt-2 text-[9px] leading-[14px] text-ink-400">&nbsp;</p>
            <OutageLane
              from={window.from}
              to={window.to}
              bars={bars}
              height={6}
              tzOffset={tzOffset}
              onHover={onHover}
              onSelect={(from, to, title) => guardClick(() => onSelect(from, to, title))}
            />
          </div>
        </div>
      </div>

      <p className="mt-1.5 shrink-0 text-[9.5px] text-ink-400">
        برای جابه‌جایی افقی، نمودار را بکشید؛ برای زوم، اسکرول ماوس را روی نمودار بچرخانید.
      </p>
    </div>
  );
}

/* ------------------------------ لایه‌های مشترک ------------------------------ */

function StatusLane({
  from,
  to,
  segments,
  height = 16,
  tzOffset,
  onHover,
  onSelect,
}: {
  from: number;
  to: number;
  segments: ClippedSegment[];
  height?: number;
  tzOffset: number;
  onHover: HoverHandler;
  onSelect: SelectHandler;
}) {
  const span = Math.max(1, to - from);
  return (
    <div
      className="relative w-full overflow-hidden rounded-[4px] bg-ink-100"
      style={{ height }}
      data-uptime-lane="status"
      onMouseLeave={() => undefined}
    >
      {segments.map((segment) => {
        const left = ((segment.from - from) / span) * 100;
        const width = Math.max(0.18, ((segment.to - segment.from) / span) * 100);
        return (
          <span
            key={`${segment.point.t}-${segment.from}`}
            className="absolute inset-y-0 block cursor-pointer transition-all duration-300 hover:opacity-80"
            style={{
              left: `${left}%`,
              width: `${width}%`,
              background: UPTIME_COLORS[segment.state],
            }}
            onMouseEnter={(event) => onHover(event, segmentHover(segment, tzOffset))}
            onClick={() =>
              onSelect(
                segment.from,
                segment.to,
                <TimeRangeLabel from={segment.from} to={segment.to} tzOffset={tzOffset} />
              )
            }
          />
        );
      })}
    </div>
  );
}

function AvailabilityLane({
  from,
  to,
  segments,
  height = 3,
  tzOffset,
  onHover,
  onSelect,
}: {
  from: number;
  to: number;
  segments: ClippedSegment[];
  height?: number;
  tzOffset: number;
  onHover: HoverHandler;
  onSelect: SelectHandler;
}) {
  const span = Math.max(1, to - from);
  return (
    <div className="relative w-full overflow-hidden rounded-[3px] bg-ink-100" style={{ height }} data-uptime-lane="availability">
      {segments.map((segment) => {
        const left = ((segment.from - from) / span) * 100;
        const width = Math.max(0.18, ((segment.to - segment.from) / span) * 100);
        const state = classifyAvailability(segment.point);
        return (
          <span
            key={`avail-${segment.point.t}-${segment.from}`}
            className="absolute inset-y-0 block cursor-pointer opacity-90 transition-opacity hover:opacity-100"
            style={{
              left: `${left}%`,
              width: `${width}%`,
              background: UPTIME_COLORS[state],
            }}
            onMouseEnter={(event) =>
              onHover(event, {
                title: (
                  <span className="inline-flex flex-wrap items-center gap-1">
                    دسترس‌پذیری
                    <TimeRangeLabel from={segment.from} to={segment.to} tzOffset={tzOffset} />
                  </span>
                ),
                rows: [
                  { label: 'Availability', value: fmtPct(segment.point.availability, 2), color: UPTIME_COLORS[state] },
                  { label: 'تعداد بررسی', value: fmtNumber(segment.point.samples) },
                  { label: 'تأخیر میانگین', value: fmtMs(segment.point.rtt) },
                ],
                note: 'نوار دوم: درصد دسترس‌پذیری هر بازه',
              })
            }
            onClick={() =>
              onSelect(
                segment.from,
                segment.to,
                <span className="inline-flex flex-wrap items-center gap-1">
                  دسترس‌پذیری
                  <TimeRangeLabel from={segment.from} to={segment.to} tzOffset={tzOffset} />
                </span>
              )
            }
          />
        );
      })}
    </div>
  );
}

function OutageLane({
  from,
  to,
  bars,
  height = 3,
  tzOffset,
  onHover,
  onSelect,
}: {
  from: number;
  to: number;
  bars: ClippedOutage[];
  height?: number;
  tzOffset: number;
  onHover: HoverHandler;
  onSelect: SelectHandler;
}) {
  const span = Math.max(1, to - from);
  return (
    <div className="relative w-full overflow-hidden rounded-[3px] bg-ink-100" style={{ height }} data-uptime-lane="outages">
      {bars.map((bar) => {
        const left = ((bar.from - from) / span) * 100;
        const width = Math.max(0.4, ((bar.to - bar.from) / span) * 100);
        return (
          <span
            key={`outage-${bar.outage.id}-${bar.from}`}
            className="absolute inset-y-0 block cursor-pointer rounded-[2px] bg-red-700 transition-opacity hover:opacity-85"
            style={{ left: `${left}%`, width: `${width}%` }}
            onMouseEnter={(event) => onHover(event, outageHover(bar, tzOffset))}
            onClick={() => onSelect(bar.from, bar.to, bar.outage.open ? 'قطعی در جریان' : 'قطعی ثبت‌شده')}
          />
        );
      })}
    </div>
  );
}

function HourAxis({
  window,
  tzOffset,
  ticks,
  endLabel,
}: {
  window: TimeWindow;
  tzOffset: number;
  ticks: number;
  endLabel?: string;
}) {
  return (
    <div className="relative h-4 flex-1" dir="ltr">
      {Array.from({ length: ticks + 1 }, (_, i) => {
        const t = window.from + ((window.to - window.from) * i) / ticks;
        const left = (i / ticks) * 100;
        return (
          <span
            key={i}
            className="num absolute top-0 whitespace-nowrap text-[9.5px] text-ink-500"
            style={{
              left: `${left}%`,
              transform: left <= 0 ? 'translateX(0)' : left >= 100 ? 'translateX(-100%)' : 'translateX(-50%)',
            }}
          >
            {i === ticks && endLabel ? endLabel : clockLabel(t, tzOffset)}
          </span>
        );
      })}
    </div>
  );
}

/* --------------------------- Tooltip و جزئیات --------------------------- */

/**
 * بازهٔ زمانی را با ترتیب قطعی «شروع تا پایان» نشان می‌دهد.
 * رشتهٔ «23:25 تا 23:26» در متن راست‌به‌چپ توسط الگوریتم bidi جابه‌جا می‌شد؛
 * دو عدد در دو عنصر جدا با جهت ltr قرار می‌گیرند تا ترتیب زمانی همیشه درست باشد.
 */
function TimeRangeLabel({ from, to, tzOffset }: { from: number; to: number; tzOffset: number }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" dir="rtl">
      <span className="num">{clockLabel(from, tzOffset)}</span>
      <span className="font-normal text-ink-400">تا</span>
      <span className="num">{clockLabel(to, tzOffset)}</span>
    </span>
  );
}

/** بازهٔ ساعتی فشرده برای برچسب ردیف‌ها: ۰۴:۰۰–۰۰:۰۰ در جهت ltr. */
function LaneClockRange({ from, to, tzOffset }: { from: number; to: number; tzOffset: number }) {
  return (
    <span className="num inline-block max-w-full truncate align-middle" dir="ltr">
      {clockLabel(from, tzOffset)}–{clockLabel(to, tzOffset)}
    </span>
  );
}

function DateTimeRangeLabel({ from, to, tzOffset }: { from: number; to: number; tzOffset: number }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1" dir="rtl">
      <span className="num">{fmtDateTime(from, tzOffset)}</span>
      <span className="font-normal text-ink-400">تا</span>
      <span className="num">{fmtDateTime(to, tzOffset)}</span>
    </span>
  );
}

function segmentHover(segment: ClippedSegment, tzOffset: number): HoverInfo {
  return {
    title: <TimeRangeLabel from={segment.from} to={segment.to} tzOffset={tzOffset} />,
    rows: [
      { label: 'وضعیت', value: UPTIME_LABELS[segment.state], color: UPTIME_COLORS[segment.state] },
      { label: 'دسترس‌پذیری', value: fmtPct(segment.point.availability, 2) },
      { label: 'تعداد بررسی', value: fmtNumber(segment.point.samples) },
      { label: 'تأخیر میانگین', value: fmtMs(segment.point.rtt) },
    ],
    note: 'برای دیدن جزئیات همین بازه کلیک کنید',
  };
}

function outageHover(bar: ClippedOutage, tzOffset: number): HoverInfo {
  const end = bar.outage.endedAt;
  const duration = ((end ?? Date.now()) - bar.outage.startedAt) / 1000;
  return {
    title: bar.outage.open ? 'قطعی در جریان' : 'قطعی ثبت‌شده',
    rows: [
      { label: 'شروع', value: fmtDateTime(bar.outage.startedAt, tzOffset) },
      { label: 'پایان', value: end ? fmtDateTime(end, tzOffset) : 'در جریان' },
      { label: 'مدت', value: fmtDuration(duration), color: '#dc2626' },
      { label: 'علت', value: bar.outage.cause || '—' },
    ],
    note: 'زمان شروع و پایان از رویداد واقعی قطعی خوانده می‌شود',
  };
}

function HoverCard({ tip }: { tip: HoverTip }) {
  return (
    <div
      className="pointer-events-none fixed z-[1100] w-[228px] rounded-soft border border-ink-200 bg-white/97 px-3 py-2 shadow-pop backdrop-blur"
      style={{
        left: tip.x,
        top: tip.y,
        transform: tip.below ? 'translate(-50%, 14px)' : 'translate(-50%, calc(-100% - 12px))',
      }}
      role="tooltip"
    >
      <p className="mb-1 text-[11px] font-semibold text-ink-700">{tip.title}</p>
      <div className="flex flex-col gap-0.5">
        {tip.rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3 text-[10.5px]">
            <span className="flex items-center gap-1.5 text-ink-500">
              {row.color ? <span className="h-1.5 w-1.5 rounded-full" style={{ background: row.color }} /> : null}
              {row.label}
            </span>
            <span className="num text-left font-medium text-ink-800">{row.value}</span>
          </div>
        ))}
      </div>
      {tip.note ? <p className="mt-1.5 border-t border-ink-100 pt-1 text-[9px] text-ink-400">{tip.note}</p> : null}
    </div>
  );
}

function uptimeChipClass(uptime: number | null): string {
  if (uptime == null) return 'border-ink-200 bg-ink-50 text-ink-600';
  if (uptime >= 99.5) return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (uptime >= 95) return 'border-sun-200 bg-sun-50 text-sun-700';
  return 'border-red-200 bg-red-50 text-red-600';
}

function SelectionPanel({ selection, tzOffset, onClose }: { selection: Selection; tzOffset: number; onClose: () => void }) {
  return (
    <div className="mt-3 shrink-0 overflow-hidden rounded-soft border border-brand-100 bg-brand-50/35">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-brand-100/80 px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-[11.5px] font-semibold text-ink-800">{selection.title}</p>
          <p className="mt-0.5 text-[9.5px] text-ink-500">
            <DateTimeRangeLabel from={selection.from} to={selection.to} tzOffset={tzOffset} />
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`chip ${uptimeChipClass(selection.stats.uptime)}`}>
            <Percent size={10} />
            <span className="num">{selection.stats.uptime == null ? '—' : fmtPct(selection.stats.uptime, 2)}</span>
          </span>
          <span className={`chip ${selection.stats.downtimeMs > 0 ? 'border-red-200 bg-red-50 text-red-600' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
            <Timer size={10} />
            <span className="num">{fmtDuration(selection.stats.downtimeMs / 1000)}</span>
          </span>
          <button type="button" className="btn-ghost btn-xs" onClick={onClose} aria-label="بستن جزئیات">
            <X size={12} />
          </button>
        </div>
      </div>

      <div className="max-h-40 overflow-auto px-3 py-2">
        {selection.bars.length === 0 ? (
          <p className="flex items-center gap-1.5 py-1 text-[10.5px] text-emerald-700">
            <CircleCheck size={12} />
            در این بازه قطعی ثبت‌شده‌ای وجود ندارد.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>شروع</th>
                <th>پایان</th>
                <th>مدت</th>
                <th>علت</th>
              </tr>
            </thead>
            <tbody>
              {selection.bars.map((bar) => (
                <tr key={bar.outage.id}>
                  <td className="num text-[10.5px]">{fmtDateTime(bar.outage.startedAt, tzOffset)}</td>
                  <td className="num text-[10.5px]">
                    {bar.outage.endedAt ? fmtDateTime(bar.outage.endedAt, tzOffset) : <span className="text-red-600">در جریان</span>}
                  </td>
                  <td className="num text-[10.5px] font-medium">{fmtDuration(((bar.outage.endedAt ?? Date.now()) - bar.outage.startedAt) / 1000)}</td>
                  <td className="text-[10.5px]">{bar.outage.cause || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function ExplorerSkeleton({ error, onRetry }: { error?: string | null; onRetry: () => void }) {
  if (error) {
    return (
      <div className="flex h-full min-h-[260px] flex-col items-center justify-center gap-2 rounded-soft border border-red-100 bg-red-50/50 p-5 text-center">
        <AlertTriangle size={22} className="text-red-500" />
        <p className="text-[12px] font-medium text-red-700">دریافت تاریخچه ممکن نشد</p>
        <p className="max-w-sm text-[10.5px] text-red-600">{error}</p>
        <button type="button" className="btn-ghost btn-xs mt-1" onClick={onRetry}>
          <RefreshCw size={12} />
          تلاش دوباره
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="skeleton h-16 rounded-soft" />
      <div className="skeleton h-16 rounded-soft" />
      <div className="skeleton h-16 rounded-soft" />
      <div className="skeleton h-12 rounded-soft" />
    </div>
  );
}

export default AvailabilityExplorer;
