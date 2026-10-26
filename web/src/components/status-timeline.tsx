import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { faDigits, fmtClock, fmtDuration, fmtPct, fmtRangeLabel } from '../lib/format';

/**
 * نمودار پیشرفتهٔ تاریخچهٔ Online/Offline و Availability.
 *
 * یک نوار پیوستهٔ زمانی (نه چند ردیف روزانه) که هر بازه با رنگ وضعیت خودش
 * رسم می‌شود؛ زیر آن ردیف «قطعی‌ها» بازه‌های قطع را با طول واقعی نشان می‌دهد.
 * کاربر می‌تواند با کشیدن ماوس جابه‌جا شود، با Ctrl + چرخ ماوس یا دکمه‌های
 * زوم بزرگ‌نمایی کند و از نوار کوچک بالای نمودار به هر بخش تاریخچه بپرد.
 */

type BandPoint = {
  t: number;
  availability: number;
  samples: number;
  ok: number;
  down: number;
  status: string;
  rtt?: number | null;
  loss?: number;
};
type BandState = 'up' | 'warn' | 'down' | 'none';

const BAND_COLOR: Record<BandState, string> = {
  up: '#22c55e',
  warn: '#f59e0b',
  down: '#ef4444',
  none: '#e2e8f0',
};

const STATE_ORDER: BandState[] = ['up', 'warn', 'down'];

/** گام‌های خوانا برای محور زمان؛ از یک دقیقه تا چند هفته. */
const TICK_STEPS = [
  60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000,
  60 * 60_000, 3 * 60 * 60_000, 6 * 60 * 60_000, 12 * 60 * 60_000,
  24 * 60 * 60_000, 2 * 864e5, 7 * 864e5, 14 * 864e5, 30 * 864e5,
];

function niceStep(raw: number) {
  return TICK_STEPS.find((s) => s >= raw) ?? TICK_STEPS[TICK_STEPS.length - 1];
}

function classifyBand(p: BandPoint, mode: 'status' | 'availability', threshold?: number | null): BandState {
  if (!p.samples) return 'none';
  if (mode === 'availability') {
    if (p.availability >= 99.5) return 'up';
    if (p.availability >= 95) return 'warn';
    return 'down';
  }
  if (p.status === 'offline' || (p.down > 0 && p.ok === 0)) return 'down';
  if (p.status === 'warning' || p.down > 0 || (threshold != null && p.rtt != null && p.rtt > threshold)) return 'warn';
  return 'up';
}

function bandLabel(state: BandState, mode: 'status' | 'availability') {
  if (state === 'up') return mode === 'availability' ? 'دسترس‌پذیر' : 'وصل';
  if (state === 'warn') return mode === 'availability' ? 'افت جزئی' : 'با تأخیر';
  if (state === 'down') return 'قطع';
  return 'بدون داده';
}

function tickText(t: number, step: number, tz: number) {
  const d = new Date(t + tz * 60000);
  const midnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
  if (step >= 864e5 || midnight) return fmtRangeLabel(t, '7d', tz);
  return fmtClock(t, tz);
}

function localDayKey(t: number, tz: number) {
  const d = new Date(t + tz * 60000);
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

export function StatusBands({
  points,
  range = '24h',
  bucketMs = 0,
  tzOffset = 210,
  mode = 'status',
  threshold,
  zoom = 1,
}: {
  points: BandPoint[];
  range?: string;
  bucketMs?: number;
  tzOffset?: number;
  mode?: 'status' | 'availability';
  threshold?: number | null;
  zoom?: number;
  span?: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<number | null>(null);
  const zoomRef = useRef(1);
  const [width, setWidth] = useState(0);
  const [innerZoom, setInnerZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState<string | null>(null);

  const zoomFactor = Math.max(0.5, Number(zoom) || 1) * innerZoom;
  zoomRef.current = zoomFactor;

  const domain = useMemo(() => {
    const bucket = bucketMs || (points.length > 1 ? points[1].t - points[0].t : 60_000);
    if (!points.length) {
      const now = Date.now();
      return { t0: now - 3_600_000, t1: now, bucket };
    }
    const last = points[points.length - 1];
    return { t0: points[0].t, t1: Math.max(last.t + bucket, last.t + 1), bucket };
  }, [points, bucketMs]);

  const totalMs = Math.max(1, domain.t1 - domain.t0);

  // اندازهٔ واقعی قاب (برای محور، پنجرهٔ دید و نوار کوچک) — بدون وابستگی به
  // مقدار ثابت، چیدمان ویجت با تغییر ارتفاع هم درست اندازه‌گیری می‌شود.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const read = () => setWidth(Math.max(0, Math.round(el.clientWidth)));
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const contentWidth = Math.max(280, Math.round((width || 640) * zoomFactor));

  const xOf = useCallback((t: number) => ((t - domain.t0) / totalMs) * contentWidth, [domain.t0, totalMs, contentWidth]);

  const syncViewport = useCallback(() => {
    const el = scrollRef.current;
    const view = viewRef.current;
    if (!el || !view) return;
    const ratio = el.scrollWidth > 0 ? el.clientWidth / el.scrollWidth : 1;
    view.style.width = `${Math.min(100, Math.max(4, ratio * 100))}%`;
    view.style.left = `${el.scrollWidth > 0 ? (el.scrollLeft / el.scrollWidth) * 100 : 0}%`;
  }, []);

  // تغییر بازه/حالت، زوم را بازنشانی می‌کند؛ به‌روزرسانی دوره‌ای داده‌ها نباید
  // زوم و موقعیت کاربر را از بین ببرد.
  const layoutKey = `${range}-${mode}`;
  useEffect(() => {
    setInnerZoom(1);
  }, [layoutKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const anchor = anchorRef.current;
    if (anchor != null) {
      el.scrollLeft = Math.max(0, anchor * el.scrollWidth - el.clientWidth / 2);
      anchorRef.current = null;
    } else {
      el.scrollLeft = el.scrollWidth;
    }
    syncViewport();
  }, [contentWidth, layoutKey, syncViewport]);

  useEffect(() => {
    syncViewport();
  }, [width, syncViewport]);

  const applyZoom = useCallback(
    (next: number, clientX?: number) => {
      const el = scrollRef.current;
      // «next» زوم کل (شامل زوم بیرونی) است؛ سقف ۱۶× برای هر دو منبع اعمال می‌شود.
      const external = Math.max(0.5, Number(zoom) || 1);
      const clamped = Math.min(16, Math.max(external, next));
      if (!el) {
        setInnerZoom(clamped / external);
        return;
      }
      const offset = clientX ?? el.clientWidth / 2;
      const ratio = el.scrollWidth > 0 ? (el.scrollLeft + offset) / el.scrollWidth : 0.5;
      anchorRef.current = ratio;
      setInnerZoom(clamped / external);
    },
    [zoom]
  );

  // چرخ ماوس با Ctrl/⌘ زوم می‌کند؛ چرخ معمولی برای اسکرول صفحه آزاد می‌ماند.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.3 : 1 / 1.3;
      applyZoom(zoomRef.current * factor, e.clientX - rect.left);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyZoom]);

  const dragRef = useRef<{ x: number; left: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = scrollRef.current;
    if (!el) return;
    dragRef.current = { x: e.clientX, left: el.scrollLeft };
    el.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    const drag = dragRef.current;
    if (!el || !drag) return;
    el.scrollLeft = drag.left - (e.clientX - drag.x);
    syncViewport();
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    setDragging(false);
    try {
      scrollRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* بی‌اثر */
    }
  };

  const jumpOverview = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(1, rect.width)));
    el.scrollLeft = Math.max(0, ratio * el.scrollWidth - el.clientWidth / 2);
    syncViewport();
  };

  const stats = useMemo(() => {
    let samples = 0;
    let weighted = 0;
    const totals: Record<BandState, number> = { up: 0, warn: 0, down: 0, none: 0 };
    for (const p of points) {
      const state = classifyBand(p, mode, threshold);
      const dur = bucketMs || 0;
      if (p.samples) {
        samples += p.samples;
        weighted += p.samples * p.availability;
      }
      totals[state] += dur;
    }
    return { uptime: samples ? weighted / samples : null, totals, samples };
  }, [points, mode, threshold, bucketMs]);

  const outageRuns = useMemo(() => {
    const out: { start: number; end: number }[] = [];
    let current: { start: number; end: number } | null = null;
    for (const p of points) {
      const down = classifyBand(p, mode, threshold) === 'down';
      if (down) {
        if (current && p.t - current.end <= domain.bucket * 1.5) current.end = p.t + domain.bucket;
        else {
          if (current) out.push(current);
          current = { start: p.t, end: p.t + domain.bucket };
        }
      } else if (current) {
        out.push(current);
        current = null;
      }
    }
    if (current) out.push(current);
    return out.map((r) => ({ ...r, duration: Math.max(domain.bucket, r.end - r.start) }));
  }, [points, mode, threshold, domain.bucket]);

  const longestOutage = outageRuns.reduce((max, r) => Math.max(max, r.duration), 0);

  const ticks = useMemo(() => {
    const visible = totalMs * Math.min(1, (width || 640) / contentWidth);
    const step = niceStep(visible / 8);
    const out: { t: number; dayStart: boolean }[] = [];
    let t = Math.ceil(domain.t0 / step) * step;
    let guard = 0;
    while (t <= domain.t1 && guard < 400) {
      out.push({ t, dayStart: localDayKey(t, tzOffset) !== localDayKey(t - step, tzOffset) });
      t += step;
      guard += 1;
    }
    return out;
  }, [totalMs, width, contentWidth, domain.t0, domain.t1, tzOffset]);

  const segTitle = (p: BandPoint) => {
    const state = classifyBand(p, mode, threshold);
    const minutes = Math.max(1, Math.round(domain.bucket / 60000));
    const detail = mode === 'availability'
      ? `دسترس‌پذیری ${fmtPct(p.availability, 1)}`
      : `${bandLabel(state, mode)} · ${fmtPct(p.availability, 1)} دسترس‌پذیری`;
    return `${fmtClock(p.t, tzOffset)} تا ${fmtClock(p.t + domain.bucket, tzOffset)} · ${detail} · ${faDigits(minutes)} دقیقه`;
  };

  if (!points.length) {
    return <p className="py-8 text-center text-xs text-ink-400">داده‌ای برای نمایش نیست</p>;
  }

  const baseTrack = (
    <div
      className="relative min-h-[32px] w-full flex-1 overflow-hidden rounded-[5px] bg-ink-100"
      dir="ltr"
    >
      <span className="absolute inset-y-0 left-0 w-full" style={{ background: BAND_COLOR.none }} />
      {points.map((p, i) => {
        const state = classifyBand(p, mode, threshold);
        const left = xOf(p.t);
        const right = xOf(p.t + domain.bucket);
        return (
          <span
            key={`${p.t}-${i}`}
            className="absolute inset-y-0 block transition-opacity hover:opacity-80"
            style={{
              left,
              width: Math.max(1, right - left),
              background: BAND_COLOR[state],
              opacity: state === 'none' ? 0.5 : 1,
            }}
            onMouseEnter={() => setHover(segTitle(p))}
            onMouseLeave={() => setHover(null)}
          />
        );
      })}
      {/* مرز روزها برای تشخیص سریع تاریخ در نمای چندروزه */}
      {ticks
        .filter((tk) => tk.dayStart)
        .map((tk) => (
          <span key={`d-${tk.t}`} className="pointer-events-none absolute inset-y-0 w-px bg-ink-900/15" style={{ left: xOf(tk.t) }} />
        ))}
    </div>
  );

  return (
    <div ref={wrapRef} className="flex h-full min-h-0 w-full flex-col">
      {/* خلاصهٔ وضعیت: در یک نگاه */}
      <div className="mb-2 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] text-ink-500">
        <span>
          دسترس‌پذیری تاریخچه:{' '}
          <span className="num font-semibold text-ink-700">{stats.uptime == null ? '—' : fmtPct(stats.uptime, 2)}</span>
        </span>
        <span>
          قطعی‌ها: <span className="num font-semibold text-ink-700">{faDigits(outageRuns.length)}</span>
        </span>
        <span>
          مجموع قطعی: <span className="num font-semibold text-ink-700">{fmtDuration(stats.totals.down / 1000)}</span>
        </span>
        <span>
          طولانی‌ترین: <span className="num font-semibold text-ink-700">{longestOutage ? fmtDuration(longestOutage / 1000) : '۰'}</span>
        </span>
        <span className="ms-auto inline-flex items-center gap-1">
          <button
            type="button"
            className="grid h-6 w-6 place-items-center rounded-md border border-ink-200 bg-white text-[13px] text-ink-600 disabled:opacity-40"
            onClick={() => applyZoom(zoomFactor / 1.5)}
            disabled={innerZoom <= 1}
            aria-label="کوچک‌نمایی"
            title="کوچک‌نمایی"
          >
            −
          </button>
          <span className="num min-w-[30px] text-center text-[10px] text-ink-500">{faDigits(Number(zoomFactor.toFixed(1)))}×</span>
          <button
            type="button"
            className="grid h-6 w-6 place-items-center rounded-md border border-ink-200 bg-white text-[13px] text-ink-600 disabled:opacity-40"
            onClick={() => applyZoom(zoomFactor * 1.5)}
            disabled={zoomFactor >= 15.99}
            aria-label="بزرگ‌نمایی"
            title="بزرگ‌نمایی"
          >
            +
          </button>
          <button
            type="button"
            className="ms-1 rounded-md border border-ink-200 bg-white px-2 py-1 text-[10px] text-ink-500 hover:text-ink-700"
            onClick={() => {
              setInnerZoom(1);
              const el = scrollRef.current;
              if (el) el.scrollLeft = el.scrollWidth;
              syncViewport();
            }}
            title="نمایش کامل تاریخچه"
          >
            بازنشانی
          </button>
        </span>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          dir="ltr"
          className={`min-h-0 flex-1 overflow-x-auto overflow-y-hidden pb-1 ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
          onScroll={syncViewport}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          style={{ touchAction: 'pan-x' }}
        >
          <div style={{ width: contentWidth }} className="relative flex h-full min-h-0 select-none flex-col">
            {/* محور زمان */}
            <div className="relative h-6 shrink-0">
              {ticks.map((tk) => {
                const x = xOf(tk.t);
                // برچسب‌های دو سر محور کامل دیده شوند و از قاب بیرون نزنند.
                const shift = x < 34 ? '0' : x > contentWidth - 34 ? '-100%' : '-50%';
                return (
                  <span
                    key={`tick-${tk.t}`}
                    className={`num absolute top-0 whitespace-nowrap text-[9.5px] ${tk.dayStart ? 'font-semibold text-ink-500' : 'text-ink-400'}`}
                    style={{ left: x, transform: `translateX(${shift})` }}
                  >
                    {tickText(tk.t, ticks.length > 1 ? ticks[1].t - ticks[0].t : domain.bucket, tzOffset)}
                  </span>
                );
              })}
              {ticks.map((tk) => (
                <span key={`gl-${tk.t}`} className="absolute bottom-0 h-1.5 w-px bg-ink-200" style={{ left: xOf(tk.t) }} />
              ))}
            </div>

            {baseTrack}

            {/* ردیف قطعی‌ها: بازه‌های پیوستهٔ قطع با طول واقعی */}
            <div className="mt-1.5 shrink-0">
              <div className="mb-0.5 flex items-center justify-between text-[9px] text-ink-400" dir="rtl">
                <span>قطعی‌ها</span>
                <span className="num">{faDigits(outageRuns.length)}</span>
              </div>
              <div className="relative w-full overflow-hidden rounded-[4px] bg-ink-50" style={{ height: 14 }} dir="ltr">
                {outageRuns.map((run, i) => {
                  const left = xOf(run.start);
                  const w = Math.max(2, xOf(run.end) - left);
                  return (
                    <span
                      key={`run-${run.start}-${i}`}
                      className="absolute inset-y-0 rounded-[2px] bg-red-500/85 hover:bg-red-600"
                      style={{ left, width: w }}
                      title={`${fmtClock(run.start, tzOffset)} تا ${fmtClock(run.end, tzOffset)} · ${fmtDuration(run.duration / 1000)}`}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* نوار کوچک کل تاریخچه + پنجرهٔ دید فعلی */}
        <div
          className="relative mt-2 shrink-0 cursor-pointer overflow-hidden rounded-[4px] border border-ink-200 bg-ink-50"
          style={{ height: 18 }}
          onClick={jumpOverview}
          title="برای پرش به هر بخش تاریخچه کلیک کنید"
          dir="ltr"
        >
          {points.map((p, i) => {
            const state = classifyBand(p, mode, threshold);
            const left = ((p.t - domain.t0) / totalMs) * 100;
            const right = ((p.t + domain.bucket - domain.t0) / totalMs) * 100;
            return (
              <span
                key={`mini-${p.t}-${i}`}
                className="absolute inset-y-0 block"
                style={{ left: `${left}%`, width: `${Math.max(0.15, right - left)}%`, background: BAND_COLOR[state], opacity: state === 'none' ? 0.45 : 0.9 }}
              />
            );
          })}
          <div
            ref={viewRef}
            className="pointer-events-none absolute inset-y-0 border-2 border-brand-600/80 bg-brand-500/15"
            style={{ width: '100%', left: 0 }}
          />
        </div>
      </div>

      <div className="mt-2 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-ink-100 pt-2 text-[10.5px] text-ink-500">
        {STATE_ORDER.map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: BAND_COLOR[s] }} />
            {bandLabel(s, mode)}
            <span className="num font-medium text-ink-700">{stats.totals[s] ? fmtDuration(stats.totals[s] / 1000) : '۰'}</span>
          </span>
        ))}
        {stats.totals.none ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: BAND_COLOR.none }} />
            بدون داده
            <span className="num font-medium text-ink-700">{fmtDuration(stats.totals.none / 1000)}</span>
          </span>
        ) : null}
        <span className="ms-auto text-ink-400">زمان‌ها به وقت محلی</span>
      </div>

      {hover ? (
        <p className="mt-1 shrink-0 text-[10px] text-ink-500" role="status">{hover}</p>
      ) : (
        <p className="mt-1 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-ink-400">
          <span aria-hidden>⇆</span>
          <span>برای جابه‌جایی بکشید · Ctrl + چرخ ماوس برای زوم · روی نوار بالا کلیک کنید تا به آن بخش بروید.</span>
        </p>
      )}
    </div>
  );
}

