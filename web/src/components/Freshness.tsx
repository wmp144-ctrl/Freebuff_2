import React, { useEffect, useState } from 'react';
import { CloudOff, RefreshCw, Radio, TriangleAlert } from 'lucide-react';
import { useLiveState } from '../lib/store';
import { faDigits, fmtRelative } from '../lib/format';

/** یک ساعت سبک برای بازمحاسبهٔ «کهنه بودن» بدون وابستگی به رویداد جدید */
export function useNow(intervalMs = 10000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setNow(Date.now());
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

const CONNECTION: Record<string, { label: string; className: string; dot: string }> = {
  live: { label: 'داده زنده', className: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
  connecting: { label: 'در حال اتصال…', className: 'border-ink-200 bg-white/80 text-ink-600', dot: 'bg-ink-300' },
  reconnecting: { label: 'اتصال مجدد…', className: 'border-sun-200 bg-sun-50 text-sun-800', dot: 'bg-sun-500' },
  offline: { label: 'اتصال قطع است', className: 'border-red-200 bg-red-50 text-red-700', dot: 'bg-red-500' },
};

/**
 * وضعیت اتصال زنده (SSE) با متن روشن.
 * وضعیت «وصل» به‌تنهایی کافی نیست: کاربر باید بداند داده‌ای که می‌بیند زنده است
 * یا از آخرین Snapshot مانده است.
 */
export function LiveBadge({
  className = '',
  showAttempt = false,
  compact = false,
}: {
  className?: string;
  showAttempt?: boolean;
  /** روی صفحه‌های کوچک فقط نشانگر وضعیت نمایش داده می‌شود */
  compact?: boolean;
}) {
  const live = useLiveState();
  const meta = CONNECTION[live.connectionState] ?? CONNECTION.connecting;
  const title = live.connected
    ? live.lastEventAt
      ? `آخرین رویداد ${fmtRelative(live.lastEventAt)}`
      : 'اتصال برقرار است'
    : live.connectionState === 'reconnecting'
      ? `تلاش شمارهٔ ${faDigits(live.reconnectAttempt)} برای اتصال مجدد`
      : 'داده‌های زنده در دسترس نیستند';
  return (
    <span
      className={`chip shrink-0 ${meta.className} ${className}`}
      title={title}
      role="status"
      aria-live="polite"
      data-testid="live-badge"
      data-state={live.connectionState}
    >
      <span className="relative flex h-2 w-2">
        {live.connected ? <span className={`absolute inline-flex h-full w-full rounded-full opacity-70 animate-pulse-ring ${meta.dot}`} /> : null}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${meta.dot}`} />
      </span>
      <span className={compact ? 'sr-only sm:not-sr-only' : ''}>{meta.label}</span>
      {showAttempt && live.connectionState === 'reconnecting' && live.reconnectAttempt > 0 ? (
        <span className="num hidden opacity-70 sm:inline">· تلاش {faDigits(live.reconnectAttempt)}</span>
      ) : null}
    </span>
  );
}

/**
 * هشدار کهنگی داده‌های صفحه.
 * اگر اتصال زنده قطع باشد یا پاسخ آخرین Snapshot از دو برابر بازهٔ تازه‌سازی
 * قدیمی‌تر باشد، داده به‌عنوان «زنده» نمایش داده نمی‌شود.
 */
export function DataFreshness({
  updatedAt,
  intervalMs = 30000,
  onRefresh,
  className = '',
}: {
  updatedAt?: number | null;
  intervalMs?: number;
  onRefresh?: () => void;
  className?: string;
}) {
  const live = useLiveState();
  const now = useNow(10000);

  // در نخستین لحظهٔ بارگذاری، «در حال اتصال» هشدار کهنگی نیست.
  if (!live.connected && live.connectionState === 'connecting' && !live.lastEventAt) {
    return (
      <p className={`inline-flex items-center gap-1.5 text-[11px] text-ink-400 ${className}`} data-testid="fresh-hint">
        <Radio size={12} />
        در حال اتصال به رویدادهای زنده…
      </p>
    );
  }

  if (!live.connected) {
    return (
      <div
        className={`flex flex-wrap items-center gap-2 rounded-soft border border-sun-200 bg-sun-50/80 px-3 py-2 text-[11.5px] text-sun-800 ${className}`}
        role="status"
        data-testid="stale-notice"
      >
        <CloudOff size={14} className="shrink-0" />
        <span>
          اتصال زنده برقرار نیست؛ اطلاعات نمایش‌داده‌شده ممکن است قدیمی باشد
          {updatedAt ? ` (آخرین دریافت ${fmtRelative(updatedAt)})` : ''}.
        </span>
        {onRefresh ? (
          <button type="button" className="btn-ghost btn-xs ms-auto" onClick={onRefresh}>
            <RefreshCw size={12} />
            دریافت دوباره
          </button>
        ) : null}
      </div>
    );
  }

  const age = updatedAt ? now - updatedAt : 0;
  if (!updatedAt || age <= intervalMs * 2.5) {
    return (
      <p className={`inline-flex items-center gap-1.5 text-[11px] text-ink-400 ${className}`} data-testid="fresh-hint">
        <Radio size={12} />
        {updatedAt ? `آخرین به‌روزرسانی ${fmtRelative(updatedAt)}` : 'در انتظار داده…'}
      </p>
    );
  }

  return (
    <div
      className={`flex flex-wrap items-center gap-2 rounded-soft border border-sun-200 bg-sun-50/80 px-3 py-2 text-[11.5px] text-sun-800 ${className}`}
      role="status"
      data-testid="stale-notice"
    >
      <TriangleAlert size={14} className="shrink-0" />
      <span>
        داده این بخش از {fmtRelative(updatedAt)} به‌روزرسانی نشده و ممکن است قدیمی باشد.
      </span>
      {onRefresh ? (
        <button type="button" className="btn-ghost btn-xs ms-auto" onClick={onRefresh}>
          <RefreshCw size={12} />
          به‌روزرسانی
        </button>
      ) : null}
    </div>
  );
}
