import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ChevronDown, ChevronUp, X } from 'lucide-react';
import { api } from '../lib/api';
import { faDigits, fmtMs, fmtPct } from '../lib/format';

export interface LivePingTarget {
  id: number;
  name: string;
  ip: string;
  /** وضعیت ثبت‌شدهٔ تجهیز؛ تا رسیدن اولین نمونه نمایش داده می‌شود */
  status?: string;
}

interface LivePingCtx {
  targets: LivePingTarget[];
  open: (t: LivePingTarget) => void;
  close: (id: number) => void;
  toggle: (t: LivePingTarget) => void;
  has: (id: number) => boolean;
}

const LivePingContext = createContext<LivePingCtx>({
  targets: [],
  open: () => {},
  close: () => {},
  toggle: () => {},
  has: () => false,
});

export const useLivePing = () => useContext(LivePingContext);

const MAX_WINDOWS = 8;

export function LivePingProvider({ children }: { children: React.ReactNode }) {
  const [targets, setTargets] = useState<LivePingTarget[]>([]);

  const open = useCallback((t: LivePingTarget) => {
    setTargets((prev) => (prev.some((x) => x.id === t.id) ? prev : [...prev, t].slice(-MAX_WINDOWS)));
  }, []);
  const close = useCallback((id: number) => setTargets((prev) => prev.filter((x) => x.id !== id)), []);
  const toggle = useCallback((t: LivePingTarget) => {
    setTargets((prev) => (prev.some((x) => x.id === t.id) ? prev.filter((x) => x.id !== t.id) : [...prev, t].slice(-MAX_WINDOWS)));
  }, []);
  const has = useCallback((id: number) => targets.some((x) => x.id === id), [targets]);

  const value = useMemo(() => ({ targets, open, close, toggle, has }), [targets, open, close, toggle, has]);
  return (
    <LivePingContext.Provider value={value}>
      {children}
      <LivePingDock />
    </LivePingContext.Provider>
  );
}

/** فهرست کارتی پنجره‌های پینگ زنده — شناور در سمت چپ صفحه */
function LivePingDock() {
  const { targets, close } = useLivePing();
  const [collapsed, setCollapsed] = useState(false);

  if (!targets.length) return null;

  return (
    // z-[900]: پایین‌تر از مودال (z-[1000]) تا پنجرهٔ شناور روی فرم باز نماند.
    <div className="fixed bottom-4 left-4 z-[900] flex w-[272px] max-w-[86vw] flex-col rounded-card border border-white/70 bg-white/95 shadow-pop backdrop-blur-xl">
      <div className="flex items-center justify-between gap-2 border-b border-ink-100 px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-ink-700">
          <Activity size={14} className="text-brand-500" />
          پینگ زنده
          <span className="num rounded-pill bg-brand-50 px-1.5 py-0.5 text-[10px] text-brand-700">{faDigits(targets.length)}</span>
        </span>
        <button type="button" className="btn-ghost btn-xs" onClick={() => setCollapsed((v) => !v)} title={collapsed ? 'باز کردن' : 'جمع کردن'}>
          {collapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>
      {collapsed ? null : (
        <div className="max-h-[62vh] space-y-2 overflow-y-auto p-2">
          {targets.map((t) => (
            <LivePingCard key={t.id} target={t} onClose={() => close(t.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function LivePingCard({ target, onClose }: { target: LivePingTarget; onClose: () => void }) {
  const [samples, setSamples] = useState<{ t: number; rtt: number | null; ok: boolean }[]>([]);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(true);
  // بررسی هر ثانیه اجرا می‌شود؛ اگر پاسخ قبلی هنوز برنگشته باشد، نمونهٔ بعدی
  // شروع نمی‌شود تا درخواست‌ها روی هم انباشته نشوند و نتیجهٔ قدیمی جای جدید را نگیرد.
  const inFlight = useRef(false);

  useEffect(() => {
    if (!running) return;
    let alive = true;
    const tick = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const res = await api.probe(target.id);
        if (!alive) return;
        setError(null);
        setThreshold(res.threshold);
        setSamples((prev) => [...prev.slice(-29), { t: res.result.at, rtt: res.result.rtt, ok: res.result.ok }]);
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        inFlight.current = false;
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [target.id, running]);

  const stats = useMemo(() => {
    const rtts = samples.map((s) => s.rtt).filter((v): v is number => v != null);
    const ok = samples.filter((s) => s.ok).length;
    return {
      last: samples.length ? samples[samples.length - 1] : null,
      min: rtts.length ? Math.min(...rtts) : null,
      max: rtts.length ? Math.max(...rtts) : null,
      avg: rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null,
      loss: samples.length ? ((samples.length - ok) / samples.length) * 100 : 0,
      count: samples.length,
    };
  }, [samples]);

  const last = stats.last;
  const reachable = last ? last.ok : target.status === 'online' || target.status === 'warning';
  const initialLabel =
    target.status === 'offline'
      ? 'قطع'
      : target.status === 'warning'
        ? 'دارای اختلال'
        : target.status === 'maintenance'
          ? 'در تعمیرات'
          : target.status === 'unknown'
            ? 'نامشخص'
            : 'وصل';
  const label = last ? (last.ok ? 'وصل' : 'قطع') : initialLabel;
  const tone = !last
    ? 'text-ink-400'
    : !last.ok
      ? 'text-red-600'
      : threshold != null && last.rtt != null && last.rtt > threshold
        ? 'text-sun-600'
        : 'text-emerald-600';

  return (
    <div className="rounded-soft border border-ink-200 bg-white/85 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <Link to={`/devices/${target.id}`} className="min-w-0">
          <span className="block truncate text-[12px] font-semibold text-ink-700 hover:text-brand-700">{target.name}</span>
          <span className="num block text-[10px] text-ink-400">{target.ip}</span>
        </Link>
        <div className="flex shrink-0 items-center gap-1">
          <span
            className={`inline-flex items-center gap-1 rounded-pill px-1.5 py-0.5 text-[9.5px] font-medium ${
              reachable ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${reachable ? 'bg-emerald-500' : 'bg-red-500'} ${running ? 'animate-pulse' : ''}`} />
            {label}
          </span>
          <button type="button" className="btn-ghost btn-xs !px-1 !py-0.5" onClick={() => setRunning((v) => !v)} title={running ? 'توقف' : 'ادامه'}>
            {running ? '⏸' : '▶'}
          </button>
          <button type="button" className="btn-ghost btn-xs !px-1 !py-0.5" onClick={onClose} title="بستن">
            <X size={12} />
          </button>
        </div>
      </div>

      <div className="mt-2 flex items-end justify-between gap-2">
        <span className={`num text-[18px] font-bold ${tone}`}>{last && last.ok ? fmtMs(last.rtt) : last ? 'بی‌پاسخ' : '—'}</span>
        <span className="text-[10px] text-ink-400">{last ? 'آخرین پاسخ' : 'در حال اندازه‌گیری'}</span>
      </div>

      {/* نوار نمونه‌های اخیر */}
      <div className="mt-1.5 flex h-6 items-end gap-[2px]" dir="ltr">
        {samples.slice(-30).map((s, i) => {
          const peak = Math.max(1, ...samples.map((x) => x.rtt ?? 0));
          const h = s.rtt == null ? 100 : Math.max(8, Math.min(100, (s.rtt / peak) * 100));
          const high = threshold != null && s.rtt != null && s.rtt > threshold;
          return (
            <span
              key={i}
              title={s.rtt == null ? 'بدون پاسخ' : `${s.rtt} ms`}
              className="flex-1 rounded-sm"
              style={{ height: `${h}%`, background: s.rtt == null ? '#dc2626' : high ? '#f59e0b' : '#22c55e' }}
            />
          );
        })}
        {samples.length === 0 ? <span className="text-[10px] text-ink-300">در حال اندازه‌گیری…</span> : null}
      </div>

      <div className="mt-2 grid grid-cols-4 gap-1 text-center text-[9.5px] text-ink-400">
        <span>
          کمینه
          <span className="num mt-0.5 block text-[11px] font-medium text-ink-600">{fmtMs(stats.min)}</span>
        </span>
        <span>
          بیشینه
          <span className="num mt-0.5 block text-[11px] font-medium text-ink-600">{fmtMs(stats.max)}</span>
        </span>
        <span>
          میانگین
          <span className="num mt-0.5 block text-[11px] font-medium text-ink-600">{fmtMs(stats.avg)}</span>
        </span>
        <span>
          افت
          <span className="num mt-0.5 block text-[11px] font-medium text-ink-600">{fmtPct(stats.loss, 0)}</span>
        </span>
      </div>
      {threshold != null ? <p className="mt-1 text-center text-[9.5px] text-ink-400">آستانه: {faDigits(threshold)} ms · {faDigits(stats.count)} نمونه</p> : null}
      {error ? <p className="mt-1 truncate text-[9.5px] text-red-500">{error}</p> : null}
    </div>
  );
}
