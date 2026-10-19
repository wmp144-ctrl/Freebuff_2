import React from 'react';
import { Link } from 'react-router-dom';
import { Activity, RefreshCw, Server, Signal, Wifi, WifiOff } from 'lucide-react';
import { api } from '../lib/api';
import { useAsync, useLive } from '../lib/store';
import { faDigits, fmtRelative } from '../lib/format';

const MODE_LABEL: Record<string, string> = {
  auto: 'خودکار',
  icmp: 'ICMP',
  tcp: 'TCP',
  simulate: 'شبیه‌سازی',
};

type Tone = 'ok' | 'warn' | 'down' | 'wait';

const TONE: Record<Tone, { dot: string; text: string; ring: string }> = {
  ok: { dot: 'bg-emerald-500', text: 'text-emerald-700', ring: 'bg-emerald-400' },
  warn: { dot: 'bg-sun-500', text: 'text-sun-700', ring: 'bg-sun-400' },
  down: { dot: 'bg-red-500', text: 'text-red-600', ring: 'bg-red-400' },
  wait: { dot: 'bg-ink-300', text: 'text-ink-500', ring: 'bg-ink-300' },
};

function StatusRow({
  icon,
  label,
  tone,
  value,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  tone: Tone;
  value: string;
  title?: string;
}) {
  const t = TONE[tone];
  return (
    <div className="flex items-center justify-between gap-2 text-[10.5px]" title={title}>
      <span className="flex min-w-0 items-center gap-1.5 text-ink-500">
        <span className="relative flex h-1.5 w-1.5 shrink-0">
          {tone !== 'wait' ? (
            <span className={`absolute inline-flex h-full w-full rounded-full opacity-60 ${t.ring} ${tone === 'ok' ? 'animate-pulse-ring' : ''}`} />
          ) : null}
          <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${t.dot}`} />
        </span>
        <span className="truncate">{icon}</span>
        <span className="truncate">{label}</span>
      </span>
      <span className={`num shrink-0 font-medium ${t.text}`}>{value}</span>
    </div>
  );
}

/**
 * سه وضعیت مستقل و قابل‌اعتماد:
 *   ۱) سرور/API (از پاسخ واقعی /api/status)
 *   ۲) موتور پایش (اجرا/توقف/کهنگی چرخه/رهبری)
 *   ۳) تجهیزات (وصل/قطع) + وضعیت اتصال زندهٔ SSE
 * زمان آخرین به‌روزرسانی هم جداگانه نمایش داده می‌شود.
 */
export default function StatusPanel({ collapsed = false }: { collapsed?: boolean }) {
  const live = useLive();
  const { data, error, refreshing, refresh, updatedAt } = useAsync((signal) => api.status(signal), [], {
    interval: 10000,
  });

  const serverTone: Tone = error ? 'down' : data?.server.ok ? 'ok' : 'wait';
  const serverText = error ? 'بی‌پاسخ' : data?.server.ok ? 'متصل' : 'در حال بررسی…';

  const engine = data?.engine;
  const engineTone: Tone = !engine
    ? 'wait'
    : !engine.running
      ? 'down'
      : engine.stale
        ? 'warn'
        : engine.leader === false
          ? 'warn'
          : 'ok';
  const engineText = !engine
    ? '—'
    : !engine.running
      ? 'متوقف'
      : engine.stale
        ? 'چرخهٔ کهنه'
        : engine.leader === false
          ? 'آماده (بدون رهبری)'
          : 'در حال اجرا';

  const devices = data?.devices;
  const devicesTone: Tone = !devices ? 'wait' : devices.down > 0 ? 'warn' : 'ok';
  const devicesText = !devices ? '—' : `${faDigits(devices.up)} وصل · ${faDigits(devices.down)} قطع`;

  const transportTone: Tone = live.connected ? 'ok' : live.connectionState === 'offline' ? 'down' : 'warn';
  const transportText = live.connected
    ? 'برقرار'
    : live.connectionState === 'reconnecting'
      ? `اتصال مجدد (${faDigits(live.reconnectAttempt)})`
      : live.connectionState === 'offline'
        ? 'قطع'
        : 'در حال اتصال…';

  return (
    <div
      className={`mx-3 mb-3 rounded-card border border-ink-200/70 bg-gradient-to-br from-brand-50/70 to-sun-50/60 p-3.5 ${
        collapsed ? 'lg:mx-auto lg:mb-4 lg:flex lg:items-center lg:justify-center lg:p-2' : ''
      }`}
    >
      <div className={`flex items-center justify-between gap-2 text-[11px] font-medium text-ink-600 ${collapsed ? 'lg:hidden' : ''}`}>
        <span className="flex items-center gap-2">
          <Activity size={14} className="text-brand-500" />
          وضعیت سامانه
        </span>
        <button
          type="button"
          className="btn-ghost btn-xs !p-1"
          onClick={refresh}
          aria-label="به‌روزرسانی وضعیت"
          title="به‌روزرسانی وضعیت"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>
      {collapsed ? <Activity size={16} className="hidden text-brand-500 lg:block" /> : null}

      <div className={`mt-2.5 space-y-1.5 ${collapsed ? 'lg:hidden' : ''}`}>
        <StatusRow icon={<Server size={11} />} label="سرور" tone={serverTone} value={serverText} title={error || undefined} />
        <StatusRow
          icon={live.connected ? <Wifi size={11} /> : <WifiOff size={11} />}
          label="اتصال زنده"
          tone={transportTone}
          value={transportText}
        />
        <StatusRow
          icon={<Signal size={11} />}
          label="موتور"
          tone={engineTone}
          value={engineText}
          title={engine ? `حالت: ${MODE_LABEL[engine.mode] ?? engine.mode}` : undefined}
        />
        <StatusRow
          icon={<Activity size={11} />}
          label="تجهیزات"
          tone={devicesTone}
          value={devicesText}
          title={devices ? `${faDigits(devices.monitoring)} تحت پایش از ${faDigits(devices.total)}` : undefined}
        />
      </div>

      <div className={`mt-2.5 space-y-1 border-t border-ink-200/60 pt-2 text-[10px] text-ink-400 ${collapsed ? 'lg:hidden' : ''}`}>
        <p className="flex items-center justify-between">
          <span>حالت موتور</span>
          <span className="font-medium text-ink-600">{engine ? (MODE_LABEL[engine.mode] ?? engine.mode) : '—'}</span>
        </p>
        <p className="flex items-center justify-between">
          <span>آخرین به‌روزرسانی</span>
          <span className="num font-medium text-ink-600">{fmtRelative(updatedAt ?? data?.generatedAt)}</span>
        </p>
      </div>

      <Link to="/settings" className={`mt-2 block text-center text-[10.5px] text-brand-600 hover:text-brand-700 ${collapsed ? 'lg:hidden' : ''}`}>
        مدیریت تنظیمات موتور
      </Link>
    </div>
  );
}
