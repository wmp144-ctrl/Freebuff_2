import React, { useEffect, useRef, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { faDigits, fmtClock, fmtDayLabel, fmtDuration, fmtMs, fmtNumber, fmtPct, fmtRangeLabel } from '../lib/format';
import { JALALI_MONTHS, jalaliMonthLength, j2d, toJalali } from '../lib/jalali';

export { fmtClock, fmtDayLabel, fmtDuration, fmtMs, fmtNumber, fmtPct, fmtRangeLabel };

/* --------------------------- Tooltip --------------------------- */
function TooltipShell({ title, rows }: { title: React.ReactNode; rows: { label: string; value: React.ReactNode; color?: string }[] }) {
  return (
    <div className="rounded-soft border border-ink-200 bg-white/97 px-3 py-2 shadow-pop backdrop-blur">
      <p className="mb-1 text-[11px] font-medium text-ink-500">{title}</p>
      <div className="flex flex-col gap-1">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center justify-between gap-4 text-[11px]">
            <span className="flex items-center gap-1.5 text-ink-500">
              {r.color ? <span className="h-2 w-2 rounded-full" style={{ background: r.color }} /> : null}
              {r.label}
            </span>
            <span className="num font-medium text-ink-800">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const tickStyle = { fontSize: 10, fill: '#94a3b8' };

/* ------------------------ Latency area chart ------------------------ */
export function LatencyAreaChart({
  points,
  range = '1h',
  threshold,
  height = 220,
  tzOffset = 210,
  showMinMax = false,
  color = '#2563eb',
  accent = '#f59e0b',
}: {
  points: { t: number; rtt: number | null; minRtt?: number | null; maxRtt?: number | null }[];
  range?: string;
  threshold?: number | null;
  height?: number;
  tzOffset?: number;
  showMinMax?: boolean;
  color?: string;
  accent?: string;
}) {
  const data = points.map((p) => ({ ...p, label: fmtRangeLabel(p.t, range, tzOffset), rtt: p.rtt ?? null }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id="latencyFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.34} />
            <stop offset="60%" stopColor={color} stopOpacity={0.12} />
            <stop offset="100%" stopColor={color} stopOpacity={0.01} />
          </linearGradient>
          <linearGradient id="maxFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity={0.22} />
            <stop offset="100%" stopColor={accent} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 6" stroke="#e8eef5" vertical={false} />
        <XAxis dataKey="label" tick={tickStyle} tickLine={false} axisLine={false} minTickGap={26} />
        <YAxis tick={tickStyle} tickLine={false} axisLine={false} width={46} unit="" />
        {threshold ? <ReferenceLine y={threshold} stroke="#f59e0b" strokeDasharray="4 4" strokeOpacity={0.8} /> : null}
        <Tooltip
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as { rtt: number | null; minRtt?: number | null; maxRtt?: number | null; t: number };
            return (
              <TooltipShell
                title={fmtRangeLabel(p.t, range, tzOffset)}
                rows={[
                  { label: 'میانگین تأخیر', value: fmtMs(p.rtt), color },
                  ...(showMinMax && p.minRtt != null ? [{ label: 'کمترین', value: fmtMs(p.minRtt), color: '#16a34a' }] : []),
                  ...(showMinMax && p.maxRtt != null ? [{ label: 'بیشترین', value: fmtMs(p.maxRtt), color: accent }] : []),
                ]}
              />
            );
          }}
        />
        {showMinMax ? (
          <Area
            type="monotone"
            dataKey="maxRtt"
            stroke={accent}
            strokeWidth={1}
            strokeDasharray="4 4"
            fill="url(#maxFill)"
            dot={false}
            connectNulls
          />
        ) : null}
        <Area
          type="monotone"
          dataKey="rtt"
          stroke={color}
          strokeWidth={2.2}
          fill="url(#latencyFill)"
          dot={false}
          activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }}
          connectNulls
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/* ------------------------- Packet loss chart ------------------------- */
export function LossAreaChart({
  points,
  range = '24h',
  height = 180,
  tzOffset = 210,
}: {
  points: { t: number; loss: number }[];
  range?: string;
  height?: number;
  tzOffset?: number;
}) {
  const data = points.map((p) => ({ ...p, label: fmtRangeLabel(p.t, range, tzOffset) }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id="lossFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#f59e0b" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 6" stroke="#e8eef5" vertical={false} />
        <XAxis dataKey="label" tick={tickStyle} tickLine={false} axisLine={false} minTickGap={26} />
        <YAxis tick={tickStyle} tickLine={false} axisLine={false} width={46} domain={[0, (max: number) => Math.max(5, Math.ceil(max))]} />
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as { t: number; loss: number };
            return <TooltipShell title={fmtRangeLabel(p.t, range, tzOffset)} rows={[{ label: 'افت بسته', value: fmtPct(p.loss), color: '#f59e0b' }]} />;
          }}
        />
        <Area type="monotone" dataKey="loss" stroke="#f59e0b" strokeWidth={2.2} fill="url(#lossFill)" dot={false} connectNulls />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/* ------------------------ Availability bars ------------------------ */
export function AvailabilityBars({
  buckets,
  range = '24h',
  height = 170,
  tzOffset = 210,
  threshold = 99,
}: {
  buckets: { t: number; availability: number; samples?: number }[];
  range?: string;
  height?: number;
  tzOffset?: number;
  threshold?: number;
}) {
  const data = buckets.map((b) => ({ ...b, label: fmtRangeLabel(b.t, range, tzOffset) }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barCategoryGap={1}>
        <CartesianGrid strokeDasharray="3 6" stroke="#e8eef5" vertical={false} />
        <XAxis dataKey="label" tick={tickStyle} tickLine={false} axisLine={false} minTickGap={26} />
        <YAxis domain={[Math.max(0, threshold - 12), 100]} tick={tickStyle} tickLine={false} axisLine={false} width={46} />
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as { t: number; availability: number; samples?: number };
            return (
              <TooltipShell
                title={fmtRangeLabel(p.t, range, tzOffset)}
                rows={[
                  { label: 'دسترس‌پذیری', value: fmtPct(p.availability, 2), color: p.availability >= threshold ? '#16a34a' : '#f59e0b' },
                  { label: 'تعداد بررسی', value: fmtNumber(p.samples ?? 0) },
                ]}
              />
            );
          }}
        />
        <Bar dataKey="availability" radius={[4, 4, 0, 0]}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.availability >= threshold ? '#34d399' : d.availability >= threshold - 8 ? '#fbbf24' : '#f87171'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/* --------------------- Online / Offline timeline --------------------- */
export function StatusTimeline({
  points,
  range = '24h',
  height = 160,
  tzOffset = 210,
}: {
  points: { t: number; ok: number; down: number; samples: number }[];
  range?: string;
  height?: number;
  tzOffset?: number;
}) {
  const data = points.map((p) => ({ ...p, label: fmtRangeLabel(p.t, range, tzOffset) }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barCategoryGap={1}>
        <CartesianGrid strokeDasharray="3 6" stroke="#e8eef5" vertical={false} />
        <XAxis dataKey="label" tick={tickStyle} tickLine={false} axisLine={false} minTickGap={26} />
        <YAxis tick={tickStyle} tickLine={false} axisLine={false} width={46} />
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as { t: number; ok: number; down: number };
            return (
              <TooltipShell
                title={fmtRangeLabel(p.t, range, tzOffset)}
                rows={[
                  { label: 'پاسخ موفق', value: fmtNumber(p.ok), color: '#16a34a' },
                  { label: 'بدون پاسخ', value: fmtNumber(p.down), color: '#dc2626' },
                ]}
              />
            );
          }}
        />
        <Bar dataKey="ok" stackId="s" fill="#4ade80" radius={[0, 0, 0, 0]} />
        <Bar dataKey="down" stackId="s" fill="#f87171" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/* --------------------------- Status donut --------------------------- */
export function StatusDonut({
  data,
  height = 210,
  total,
}: {
  data: { key: string; label: string; value: number; color: string }[];
  height?: number;
  total?: number;
}) {
  const sum = total ?? data.reduce((a, b) => a + b.value, 0);
  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="label" innerRadius="62%" outerRadius="88%" paddingAngle={2} strokeWidth={0}>
            {data.map((d) => (
              <Cell key={d.key} fill={d.color} />
            ))}
          </Pie>
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as { label: string; value: number; color: string };
              return (
                <TooltipShell
                  title={p.label}
                  rows={[
                    { label: 'تعداد', value: fmtNumber(p.value), color: p.color },
                    { label: 'سهم', value: sum ? fmtPct((p.value / sum) * 100) : '—' },
                  ]}
                />
              );
            }}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="num text-xl font-bold text-ink-800">{fmtNumber(sum)}</span>
        <span className="text-[10px] text-ink-400">تجهیز</span>
      </div>
    </div>
  );
}

/* -------------------------- Top-N bar list -------------------------- */
export function TopBarList({
  items,
  valueKey,
  nameKey = 'name',
  suffix,
  color = '#2563eb',
  formatter,
  onSelect,
  max = 10,
}: {
  items: Record<string, unknown>[];
  valueKey: string;
  nameKey?: string;
  suffix?: string;
  color?: string;
  formatter?: (v: number) => string;
  onSelect?: (item: Record<string, unknown>) => void;
  max?: number;
}) {
  const list = items.slice(0, max);
  const peak = Math.max(1, ...list.map((i) => Number(i[valueKey]) || 0));
  if (!list.length) return <p className="py-8 text-center text-xs text-ink-400">داده‌ای برای نمایش وجود ندارد</p>;
  return (
    <div className="flex flex-col gap-2.5">
      {list.map((item, idx) => {
        const value = Number(item[valueKey]) || 0;
        const label = String(item[nameKey] ?? '');
        const groupColor = (item.groupColor as string) || null;
        return (
          <button
            key={`${label}-${idx}`}
            type="button"
            onClick={() => onSelect?.(item)}
            className={`group flex w-full items-center gap-3 rounded-soft px-2 py-1.5 text-right transition ${
              onSelect ? 'hover:bg-brand-50/60' : 'cursor-default'
            }`}
          >
            <span className="num w-5 shrink-0 text-[11px] text-ink-400">{idx + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] text-ink-700 group-hover:text-brand-700">{label}</span>
              <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-pill bg-ink-100">
                <span
                  className="block h-full rounded-pill transition-all duration-700"
                  style={{ width: `${Math.max(4, (value / peak) * 100)}%`, background: groupColor || color }}
                />
              </span>
            </span>
            <span className="num shrink-0 text-[12px] font-semibold text-ink-700">
              {formatter ? formatter(value) : fmtNumber(value)}
              {suffix ? <span className="ms-0.5 text-[10px] font-normal text-ink-400">{suffix}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ---------------------------- Mini spark ---------------------------- */
export function MiniSpark({
  points,
  color = '#2563eb',
  height = 46,
  dataKey = 'rtt',
}: {
  points: { t: number; [k: string]: number | null }[];
  color?: string;
  height?: number;
  dataKey?: string;
}) {
  if (!points.length) return <div className="h-[46px] rounded-soft bg-ink-50" />;
  const id = `spark-${dataKey}-${color.replace('#', '')}`;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.32} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.8} fill={`url(#${id})`} dot={false} connectNulls />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/* --------------- Latency spark با آستانهٔ پینگ (سبز/نارنجی/قرمز) --------------- */
export function LatencySpark({
  points,
  threshold,
  height = 52,
}: {
  points: { t: number; rtt: number | null; loss: number }[];
  threshold: number | null;
  height?: number;
}) {
  // شناسهٔ یکتا برای گرادیان‌ها؛ در حالت کارتی ده‌ها نمودار هم‌زمان روی صفحه‌اند و
  // شناسهٔ ثابت باعث می‌شد همهٔ آن‌ها به یک تعریف مشترک ارجاع دهند.
  const uid = React.useId().replace(/[:]/g, '');
  const belowId = `spark-below-${uid}`;
  const aboveId = `spark-above-${uid}`;
  const th = threshold ?? 0;
  const peak = Math.max(th * 1.2, ...points.map((p) => p.rtt ?? 0), 1);
  const data = points.map((p) => ({
    ...p,
    below: p.rtt == null ? null : p.rtt <= th ? p.rtt : null,
    above: p.rtt == null ? null : p.rtt > th ? p.rtt : null,
    // بخش‌های بدون پاسخ (قطعی) با یک خط قرمز در بالای نمودار نشان داده می‌شوند
    off: p.rtt == null ? peak : null,
  }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 6, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={belowId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#16a34a" stopOpacity={0.3} />
            <stop offset="100%" stopColor="#16a34a" stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id={aboveId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#f59e0b" stopOpacity={0.04} />
          </linearGradient>
        </defs>
        {/* دامنهٔ ثابت با کمی فاصله از بالا تا خط قطعی (که روی سقف رسم می‌شود)
            در لبهٔ نمودار بریده نشود و خط آستانه همیشه دیده شود */}
        <YAxis hide domain={[0, Math.ceil(peak * 1.1)]} />
        {threshold ? <ReferenceLine y={threshold} stroke="#f97316" strokeDasharray="4 4" strokeWidth={1} /> : null}
        <Area type="monotone" dataKey="off" stroke="#ef4444" strokeWidth={3} fill="none" dot={false} connectNulls={false} />
        <Area type="monotone" dataKey="below" stroke="#16a34a" strokeWidth={2} fill={`url(#${belowId})`} dot={false} connectNulls={false} />
        <Area type="monotone" dataKey="above" stroke="#f59e0b" strokeWidth={2} fill={`url(#${aboveId})`} dot={false} connectNulls={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/* ------------------- Flap chart: قطع و وصل شدن ------------------- */
export function FlapChart({
  series,
  range = '24h',
  height = 210,
  tzOffset = 210,
}: {
  series: { t: number; down: number; up: number }[];
  range?: string;
  height?: number;
  tzOffset?: number;
}) {
  const data = series.map((s) => ({ ...s, label: fmtRangeLabel(s.t, range, tzOffset) }));
  // خطی نمایش داده می‌شود تا روند قطع/وصل در طول بازه دیده شود
  const showDots = data.length <= 24;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 10, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 6" stroke="#e8eef5" vertical={false} />
        <XAxis dataKey="label" tick={tickStyle} tickLine={false} axisLine={false} minTickGap={26} />
        <YAxis tick={tickStyle} tickLine={false} axisLine={false} width={46} allowDecimals={false} />
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as { t: number; down: number; up: number };
            return (
              <TooltipShell
                title={fmtRangeLabel(p.t, range, tzOffset)}
                rows={[
                  { label: 'قطع شد', value: fmtNumber(p.down), color: '#ef4444' },
                  { label: 'وصل شد', value: fmtNumber(p.up), color: '#22c55e' },
                ]}
              />
            );
          }}
        />
        <Legend
          verticalAlign="top"
          height={24}
          formatter={(v) => <span style={{ fontSize: 11, color: '#64748b' }}>{v === 'down' ? 'قطع شد' : 'وصل شد'}</span>}
        />
        <Line
          type="monotone"
          dataKey="down"
          stroke="#ef4444"
          strokeWidth={2}
          dot={showDots ? { r: 2.5, strokeWidth: 0, fill: '#ef4444' } : false}
          activeDot={{ r: 4 }}
          connectNulls
        />
        <Line
          type="monotone"
          dataKey="up"
          stroke="#22c55e"
          strokeWidth={2}
          dot={showDots ? { r: 2.5, strokeWidth: 0, fill: '#22c55e' } : false}
          activeDot={{ r: 4 }}
          connectNulls
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

/* -------------- Simultaneous outage concurrency chart -------------- */
export function SimultaneousChart({
  series,
  range = '24h',
  height = 190,
  tzOffset = 210,
}: {
  series: { t: number; concurrent: number }[];
  range?: string;
  height?: number;
  tzOffset?: number;
}) {
  const data = series.map((s) => ({ ...s, label: fmtRangeLabel(s.t, range, tzOffset) }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id="concFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7c3aed" stopOpacity={0.32} />
            <stop offset="100%" stopColor="#7c3aed" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 6" stroke="#e8eef5" vertical={false} />
        <XAxis dataKey="label" tick={tickStyle} tickLine={false} axisLine={false} minTickGap={26} />
        <YAxis tick={tickStyle} tickLine={false} axisLine={false} width={46} allowDecimals={false} />
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as { t: number; concurrent: number };
            return (
              <TooltipShell
                title={fmtRangeLabel(p.t, range, tzOffset)}
                rows={[{ label: 'تجهیزات قطع هم‌زمان', value: fmtNumber(p.concurrent), color: '#7c3aed' }]}
              />
            );
          }}
        />
        <Area type="stepAfter" dataKey="concurrent" stroke="#7c3aed" strokeWidth={2} fill="url(#concFill)" dot={false} connectNulls />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/* --------------------- Outage timeline (Gantt) --------------------- */
export function OutageGantt({
  devices,
  from,
  to,
  onSelect,
}: {
  devices: { deviceId: number; name: string; ip: string; bars: { id: number; start: number; end: number; open: boolean; cause: string }[] }[];
  from: number;
  to: number;
  onSelect?: (deviceId: number) => void;
}) {
  const span = Math.max(1, to - from);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ f, t: from + span * f }));
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="w-40 shrink-0" />
        <div className="relative flex-1 border-b border-ink-100 pb-1" dir="ltr">
          {ticks.map((tk) => (
            <span key={tk.f} className="absolute -translate-x-1/2 text-[9.5px] text-ink-400" style={{ left: `${tk.f * 100}%` }}>
              {fmtClock(tk.t)}
            </span>
          ))}
        </div>
      </div>
      {devices.map((d) => (
        <div key={d.deviceId} className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onSelect?.(d.deviceId)}
            className="w-40 shrink-0 truncate text-right text-[11.5px] text-ink-600 hover:text-brand-700"
            title={`${d.name} — ${d.ip}`}
          >
            {d.name}
          </button>
          <div className="relative h-6 flex-1 overflow-hidden rounded-soft bg-ink-50" dir="ltr">
            {d.bars.map((b) => {
              const left = ((Math.max(b.start, from) - from) / span) * 100;
              const width = Math.max(0.5, ((Math.min(b.end, to) - Math.max(b.start, from)) / span) * 100);
              return (
                <span
                  key={b.id}
                  title={`${b.cause}${b.open ? ' — در جریان' : ''}`}
                  className="absolute top-1 h-4 rounded-sm"
                  style={{ left: `${left}%`, width: `${width}%`, background: b.open ? '#dc2626' : '#f59e0b' }}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------ Multi-line trend ------------------------ */
export function TrendLineChart({
  points,
  height = 200,
  series,
  yDomain,
  suffix,
  tzOffset = 210,
}: {
  points: Record<string, number | string | null>[];
  height?: number;
  series: { key: string; label: string; color: string }[];
  yDomain?: [number, number];
  suffix?: string;
  tzOffset?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={points} margin={{ top: 8, right: 10, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 6" stroke="#e8eef5" vertical={false} />
        <XAxis dataKey="label" tick={tickStyle} tickLine={false} axisLine={false} minTickGap={20} />
        <YAxis tick={tickStyle} tickLine={false} axisLine={false} width={46} domain={yDomain} />
        <Tooltip
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            return (
              <TooltipShell
                title={String(label)}
                rows={payload.map((p) => ({
                  label: series.find((s) => s.key === p.dataKey)?.label ?? String(p.dataKey),
                  value: `${fmtNumber(Number(p.value))}${suffix ?? ''}`,
                  color: p.color as string,
                }))}
              />
            );
          }}
        />
        <Legend
          verticalAlign="top"
          height={26}
          formatter={(v) => <span style={{ fontSize: 11, color: '#64748b' }}>{series.find((s) => s.key === v)?.label ?? v}</span>}
        />
        {series.map((s) => (
          <Line key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={2} dot={false} connectNulls />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/* --------------------- Group stacked status bar --------------------- */
export function GroupStatusBar({
  groups,
  onSelect,
  height = 210,
}: {
  groups: { name: string; online: number; warning: number; offline: number; total: number }[];
  onSelect?: (name: string) => void;
  height?: number;
}) {
  const data = groups.map((g) => ({ ...g, label: g.name }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }} barCategoryGap={12}>
        <CartesianGrid strokeDasharray="3 6" stroke="#e8eef5" horizontal={false} />
        <XAxis type="number" tick={tickStyle} tickLine={false} axisLine={false} allowDecimals={false} />
        <YAxis type="category" dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} width={112} />
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as { name: string; online: number; warning: number; offline: number; total: number };
            return (
              <TooltipShell
                title={p.name}
                rows={[
                  { label: 'در دسترس', value: fmtNumber(p.online), color: '#16a34a' },
                  { label: 'دارای اختلال', value: fmtNumber(p.warning), color: '#f59e0b' },
                  { label: 'قطع‌شده', value: fmtNumber(p.offline), color: '#dc2626' },
                  { label: 'کل', value: fmtNumber(p.total) },
                ]}
              />
            );
          }}
        />
        <Bar
          dataKey="online"
          stackId="a"
          fill="#4ade80"
          onClick={(d: any) => onSelect?.(d?.payload?.name ?? '')}
          cursor={onSelect ? 'pointer' : 'default'}
        />
        <Bar dataKey="warning" stackId="a" fill="#fbbf24" />
        <Bar dataKey="offline" stackId="a" fill="#f87171" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ------------------------- Offline count trend ------------------------- */
export function OfflineTrendChart({
  points,
  height = 190,
  tzOffset = 210,
}: {
  points: { t: number; offline: number; devices: number }[];
  height?: number;
  tzOffset?: number;
}) {
  const data = points.map((p) => ({ ...p, label: fmtClock(p.t, tzOffset) }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id="offlineFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#dc2626" stopOpacity={0.3} />
            <stop offset="100%" stopColor="#dc2626" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 6" stroke="#e8eef5" vertical={false} />
        <XAxis dataKey="label" tick={tickStyle} tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis tick={tickStyle} tickLine={false} axisLine={false} width={46} allowDecimals={false} />
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as { t: number; offline: number; devices: number };
            return (
              <TooltipShell
                title={fmtClock(p.t, tzOffset)}
                rows={[
                  { label: 'تجهیزات قطع‌شده', value: fmtNumber(p.offline), color: '#dc2626' },
                  { label: 'کل تجهیزات پایش‌شده', value: fmtNumber(p.devices) },
                ]}
              />
            );
          }}
        />
        <Area type="monotone" dataKey="offline" stroke="#dc2626" strokeWidth={2} fill="url(#offlineFill)" dot={false} connectNulls />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/* ---------------------------- Daily bars ---------------------------- */
export function DailyBars({
  points,
  height = 190,
  tzOffset = 210,
  color = '#f59e0b',
  valueKey = 'count',
  label = 'تعداد قطعی',
  suffix = '',
}: {
  points: Record<string, unknown>[];
  height?: number;
  tzOffset?: number;
  color?: string;
  valueKey?: string;
  label?: string;
  suffix?: string;
}) {
  const data = points.map((p) => ({ ...p, label: fmtDayLabel(String(p.day ?? ''), tzOffset) }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 6" stroke="#e8eef5" vertical={false} />
        <XAxis dataKey="label" tick={tickStyle} tickLine={false} axisLine={false} minTickGap={10} />
        <YAxis tick={tickStyle} tickLine={false} axisLine={false} width={46} allowDecimals={false} />
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as Record<string, unknown>;
            return (
              <TooltipShell
                title={String(p.day ?? '')}
                rows={[
                  { label, value: `${fmtNumber(Number(p[valueKey] ?? 0))}${suffix}`, color },
                  ...(p.downtimeSec != null ? [{ label: 'مجموع مدت قطعی', value: fmtDuration(Number(p.downtimeSec)) }] : []),
                ]}
              />
            );
          }}
        />
        <Bar dataKey={valueKey} fill={color} radius={[5, 5, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ================================================================== */
/* نمودارهای وضعیت/دسترس‌پذیری با اسکرول و زوم افقی                    */
/* ================================================================== */

export const CHART_ZOOM_LEVELS = [1, 1.5, 2, 3];

/** دکمه‌های زوم مشترک نمودارها؛ ۱ یعنی «به اندازهٔ پنجرهٔ زمانی انتخاب‌شده». */
export function ChartZoomControls({ zoom, onChange }: { zoom: number; onChange: (z: number) => void }) {
  const idx = CHART_ZOOM_LEVELS.reduce((best, z, i) => (Math.abs(z - zoom) < Math.abs(CHART_ZOOM_LEVELS[best] - zoom) ? i : best), 0);
  return (
    <div className="inline-flex items-center gap-0.5 rounded-soft border border-ink-200 bg-white/70 px-1 py-0.5" role="group" aria-label="زوم نمودار">
      <button
        type="button"
        className="rounded-md px-1.5 text-[12px] text-ink-500 hover:bg-ink-100 disabled:opacity-40"
        onClick={() => onChange(CHART_ZOOM_LEVELS[Math.max(0, idx - 1)])}
        disabled={idx === 0}
        aria-label="کوچک‌نمایی نمودار"
        title="کوچک‌نمایی"
      >
        −
      </button>
      <span className="num min-w-[28px] text-center text-[10.5px] text-ink-500">{faDigits(zoom)}×</span>
      <button
        type="button"
        className="rounded-md px-1.5 text-[12px] text-ink-500 hover:bg-ink-100 disabled:opacity-40"
        onClick={() => onChange(CHART_ZOOM_LEVELS[Math.min(CHART_ZOOM_LEVELS.length - 1, idx + 1)])}
        disabled={idx === CHART_ZOOM_LEVELS.length - 1}
        aria-label="بزرگ‌نمایی نمودار"
        title="بزرگ‌نمایی"
      >
        +
      </button>
    </div>
  );
}

/**
 * قاب اسکرول افقی برای نمودارهای Recharts.
 * عرض محتوا = تعداد پنجره‌های خوانده‌شده × زوم؛ در نتیجه فقط پنجرهٔ جاری دیده
 * می‌شود و پنجره‌های قبلی با اسکرول افقی قابل مشاهده‌اند.
 */
export function ChartScroll({
  factor = 1,
  zoom = 1,
  anchorKey,
  children,
  hint = 'برای مشاهدهٔ بازه‌های قبل، نمودار را افقی اسکرول کنید.',
}: {
  factor?: number;
  zoom?: number;
  anchorKey?: string | number;
  children: React.ReactNode;
  hint?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const atEnd = el.scrollWidth - el.scrollLeft - el.clientWidth < 80;
    if (first.current || atEnd) el.scrollLeft = el.scrollWidth;
    first.current = false;
  }, [factor, zoom, anchorKey]);
  return (
    <div>
      <div ref={ref} dir="ltr" className="overflow-x-auto overflow-y-hidden pb-1">
        <div style={{ width: `${Math.max(1, factor) * Math.max(1, zoom) * 100}%`, minWidth: '100%' }}>{children}</div>
      </div>
      {factor > 1 || zoom > 1 ? (
        <p className="mt-1 flex items-center gap-1 text-[10px] text-ink-400">
          <span aria-hidden>⇆</span>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------- نوارهای وضعیت ------------------------- */

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
const WEEKDAY_FULL = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'];

function localParts(t: number, tz: number) {
  const d = new Date(t + tz * 60000);
  return {
    gy: d.getUTCFullYear(),
    gm: d.getUTCMonth() + 1,
    gd: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
  };
}

function jDayLabel(jy: number, jm: number, jd: number) {
  return `${faDigits(jd)} ${JALALI_MONTHS[jm - 1]}`;
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

function HorizontalBandScroll({
  children,
  width,
  resetKey,
}: {
  children: React.ReactNode;
  width: string;
  resetKey: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const atEnd = el.scrollWidth - el.scrollLeft - el.clientWidth < 80;
    if (first.current || atEnd) el.scrollLeft = el.scrollWidth;
    first.current = false;
  }, [resetKey]);
  return (
    <div ref={ref} dir="ltr" className="overflow-x-auto overflow-y-hidden pb-1">
      <div dir="ltr" style={{ width, minWidth: '100%' }}>
        {children}
      </div>
    </div>
  );
}

/**
 * نمودار پیشرفتهٔ Online/Offline و Availability.
 *
 * • روزانه (۲۴ ساعت): هر روز ۶ ردیف چهارساعته دارد؛ هر ردیف یک نوار افقی
 *   سبز/نارنجی/قرمز است و روزهای قبل با اسکرول افقی دیده می‌شوند.
 * • هفتگی: هر ردیف یک روز کامل است.
 * • ماهانه: هر روز در تقویم شمسی با رنگ وضعیت علامت می‌خورد.
 * مقدار زمان هر وضعیت (وصل/با تأخیر/قطع) زیر نمودار نمایش داده می‌شود.
 */
export function StatusBands({
  points,
  range = '24h',
  bucketMs = 0,
  tzOffset = 210,
  mode = 'status',
  threshold,
  zoom = 1,
  span = 1,
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
  const [hover, setHover] = useState<string | null>(null);

  // گروه‌بندی نقاط بر اساس روز محلی + روز شمسی.
  const days = React.useMemo(() => {
    const map = new Map<
      string,
      { key: string; t: number; jy: number; jm: number; jd: number; hour: number; minute: number; points: BandPoint[] }
    >();
    for (const p of points) {
      const lp = localParts(p.t, tzOffset);
      const j = toJalali(lp.gy, lp.gm, lp.gd);
      const existing = map.get(lp.key);
      if (existing) existing.points.push(p);
      else map.set(lp.key, { key: lp.key, t: p.t, jy: j.jy, jm: j.jm, jd: j.jd, hour: lp.hour, minute: lp.minute, points: [p] });
    }
    return [...map.values()].sort((a, b) => a.t - b.t);
  }, [points, tzOffset]);

  const totals = React.useMemo(() => {
    const out: Record<BandState, number> = { up: 0, warn: 0, down: 0, none: 0 };
    for (const p of points) {
      const state = classifyBand(p, mode, threshold);
      if (state !== 'none' && p.samples) out[state] += (bucketMs || 0) / 1000;
    }
    return out;
  }, [points, mode, threshold, bucketMs]);

  const segTitle = (p: BandPoint) => {
    const state = classifyBand(p, mode, threshold);
    const end = p.t + (bucketMs || 0);
    const minutes = Math.max(1, Math.round((bucketMs || 0) / 60000));
    const rangeText = mode === 'availability' ? `${fmtPct(p.availability, 1)}` : bandLabel(state, mode);
    return `${fmtClock(p.t, tzOffset)} تا ${fmtClock(end, tzOffset)} · ${rangeText} · ${faDigits(minutes)} دقیقه`;
  };

  const hoverBand = (p: BandPoint | null) => setHover(p ? segTitle(p) : null);

  const bar = (list: BandPoint[], minHeight = 18) => (
    <div className="flex w-full overflow-hidden rounded-[4px] bg-ink-100" dir="ltr" style={{ minHeight }}>
      {list.length === 0 ? <span className="flex-1" style={{ background: BAND_COLOR.none }} /> : null}
      {list.map((p, i) => {
        const state = classifyBand(p, mode, threshold);
        return (
          <span
            key={`${p.t}-${i}`}
            className="block h-full flex-1 transition-opacity hover:opacity-80"
            style={{ background: BAND_COLOR[state], minWidth: 2 }}
            title={segTitle(p)}
            onMouseEnter={() => hoverBand(p)}
            onMouseLeave={() => hoverBand(null)}
          />
        );
      })}
    </div>
  );

  const rangeKey = `${range}-${points[points.length - 1]?.t ?? 0}`;

  let body: React.ReactNode;
  if (range === '24h') {
    // شش ردیف چهارساعته برای هر روز؛ روزها کنار هم و قابل اسکرول.
    const blockWidth = 640 * zoom;
    body = (
      <HorizontalBandScroll width="max-content" resetKey={`${rangeKey}-${zoom}`}>
        <div className="flex items-start gap-3">
          {days.map((day) => (
            <div key={day.key} dir="rtl" className="shrink-0" style={{ width: blockWidth }}>
              <div className="mb-1.5 flex items-center justify-between gap-2 text-[10.5px] text-ink-500">
                <span className="font-medium">{jDayLabel(day.jy, day.jm, day.jd)}</span>
                <span className="num text-ink-400">{WEEKDAY_FULL[(j2d(day.jy, day.jm, day.jd) + 2) % 7]}</span>
              </div>
              <div className="space-y-1">
                {[0, 1, 2, 3, 4, 5].map((row) => {
                  const cells = day.points.filter((p) => {
                    const h = localParts(p.t, tzOffset).hour;
                    return h >= row * 4 && h < row * 4 + 4;
                  });
                  return (
                    <div key={row} className="flex items-center gap-2">
                      <span className="num w-11 shrink-0 text-[9.5px] text-ink-400" dir="ltr">
                        {String(row * 4).padStart(2, '0')}–{String(row * 4 + 4).padStart(2, '0')}
                      </span>
                      <div className="min-w-0 flex-1">{bar(cells, 16)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {days.length === 0 ? <p className="py-8 text-center text-xs text-ink-400">داده‌ای برای نمایش نیست</p> : null}
        </div>
      </HorizontalBandScroll>
    );
  } else if (range === '7d') {
    // یک ردیف برای هر روز؛ کل عرض با زوم بزرگ/کوچک و اسکرول می‌شود.
    const lastDays = days.slice(-7);
    body = (
      <HorizontalBandScroll width={`${Math.max(1, zoom) * 100}%`} resetKey={`${rangeKey}-${zoom}`}>
        <div dir="rtl" className="space-y-1.5">
          {lastDays.map((day) => (
            <div key={day.key} className="flex items-center gap-2">
              <span className="w-[84px] shrink-0 text-left text-[10.5px] text-ink-500">
                {jDayLabel(day.jy, day.jm, day.jd)}
                <span className="ms-1 text-ink-400">{WEEKDAY_FULL[(j2d(day.jy, day.jm, day.jd) + 2) % 7]}</span>
              </span>
              <div className="min-w-0 flex-1">{bar(day.points, 18)}</div>
            </div>
          ))}
          {lastDays.length === 0 ? <p className="py-8 text-center text-xs text-ink-400">داده‌ای برای نمایش نیست</p> : null}
        </div>
      </HorizontalBandScroll>
    );
  } else if (range === '30d') {
    // تقویم شمسی؛ هر روز با رنگ وضعیت همان روز.
    const months = new Map<string, { jy: number; jm: number; days: typeof days }>();
    for (const day of days) {
      const key = `${day.jy}-${day.jm}`;
      const existing = months.get(key);
      if (existing) existing.days.push(day);
      else months.set(key, { jy: day.jy, jm: day.jm, days: [day] });
    }
    body = (
      <HorizontalBandScroll width="max-content" resetKey={`${rangeKey}-${zoom}`}>
        <div className="flex items-start gap-4">
          {[...months.values()].map((month) => {
            const monthDays = jalaliMonthLength(month.jy, month.jm);
            const offset = (j2d(month.jy, month.jm, 1) + 2) % 7;
            const byDay = new Map(month.days.map((d) => [d.jd, d]));
            return (
              <div key={`${month.jy}-${month.jm}`} dir="rtl" style={{ width: 280 * zoom }} className="shrink-0">
                <p className="mb-1.5 text-[11px] font-medium text-ink-600">
                  {JALALI_MONTHS[month.jm - 1]} <span className="num text-ink-400">{faDigits(month.jy)}</span>
                </p>
                <div className="grid grid-cols-7 gap-1 text-center">
                  {['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'].map((w) => (
                    <span key={w} className="text-[9px] text-ink-400">{w}</span>
                  ))}
                  {Array.from({ length: offset }, (_, i) => (
                    <span key={`e-${i}`} />
                  ))}
                  {Array.from({ length: monthDays }, (_, i) => i + 1).map((jd) => {
                    const day = byDay.get(jd);
                    let state: BandState = 'none';
                    if (day) {
                      const states = day.points.map((p) => classifyBand(p, mode, threshold));
                      state = states.includes('down') ? 'down' : states.includes('warn') ? 'warn' : states.includes('up') ? 'up' : 'none';
                    }
                    const avg = day?.points.length
                      ? day.points.reduce((a, p) => a + (p.samples ? p.availability : 0), 0) / day.points.length
                      : null;
                    return (
                      <span
                        key={jd}
                        className="num grid h-7 place-items-center rounded-md text-[10px] text-white"
                        style={{ background: BAND_COLOR[state], opacity: state === 'none' ? 0.55 : 1 }}
                        title={day ? `${jDayLabel(month.jy, month.jm, jd)} · ${bandLabel(state, mode)}${avg != null ? ` · دسترس‌پذیری ${faDigits(avg.toFixed(1))}٪` : ''}` : `${jDayLabel(month.jy, month.jm, jd)} · بدون داده`}
                      >
                        {faDigits(jd)}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {months.size === 0 ? <p className="py-8 text-center text-xs text-ink-400">داده‌ای برای نمایش نیست</p> : null}
        </div>
      </HorizontalBandScroll>
    );
  } else {
    // بازه‌های کوتاه (۱/۶ ساعت): یک نوار پیوسته فقط برای پنجرهٔ انتخاب‌شده.
    const windowPoints = span > 1 ? points.slice(-Math.max(1, Math.round(points.length / span))) : points;
    body = <div className="py-4">{bar(windowPoints, 26)}</div>;
  }

  return (
    <div>
      {body}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-ink-100 pt-2 text-[10.5px] text-ink-500">
        <span className="text-ink-400">زمان هر وضعیت (بازهٔ خوانده‌شده):</span>
        {STATE_ORDER.map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: BAND_COLOR[s] }} />
            {bandLabel(s, mode)}
            <span className="num font-medium text-ink-700">{totals[s] ? fmtDuration(totals[s]) : '۰'}</span>
          </span>
        ))}
      </div>
      {hover ? (
        <p className="mt-1 text-[10px] text-ink-500" role="status">{hover}</p>
      ) : (
        <p className="mt-1 flex items-center gap-1 text-[10px] text-ink-400">
          <span aria-hidden>⇆</span>
          برای دیدن بازه‌های زمانی، روی هر بخش نگه دارید؛ روزها/ماه‌های قبل با اسکرول افقی دیده می‌شوند.
        </p>
      )}
    </div>
  );
}
