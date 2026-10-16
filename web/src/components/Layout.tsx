import React, { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  Bell,
  FileBarChart,
  LayoutDashboard,
  Map as MapIcon,
  Menu,
  Network,
  Search,
  Server,
  Settings as SettingsIcon,
  Signal,
  Wrench,
  X,
  Command,
  Radio,
} from 'lucide-react';
import { useApp, useLive } from '../lib/store';
import { faDigits, fmtRelative } from '../lib/format';
import { StatusPill } from './ui';
import { api } from '../lib/api';

const NAV = [
  { to: '/dashboard', label: 'داشبورد', icon: LayoutDashboard },
  { to: '/devices', label: 'تجهیزات شبکه', icon: Server },
  { to: '/map', label: 'نقشه شبکه', icon: MapIcon },
  { to: '/alerts', label: 'هشدارها', icon: Bell },
  { to: '/maintenance', label: 'تعمیرات و نگهداری', icon: Wrench },
  { to: '/reports', label: 'گزارش‌ها و تحلیل', icon: FileBarChart },
  { to: '/settings', label: 'تنظیمات', icon: SettingsIcon },
];

function LiveDot({ connected }: { connected: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-pill border border-ink-200 bg-white/80 px-3 py-1.5 text-[11px] text-ink-600">
      <span className="relative flex h-2 w-2">
        {connected ? <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-70 animate-pulse-ring" /> : null}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-ink-300'}`} />
      </span>
      {connected ? 'به‌روزرسانی زنده' : 'در حال اتصال…'}
    </span>
  );
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [notifOpen, setNotifOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { settings, engine } = useApp();
  const live = useLive();

  useEffect(() => {
    setOpen(false);
    setNotifOpen(false);
  }, [location.pathname]);

  const alertsApi = useAlertSummary(live.version + (notifOpen ? 1 : 0));

  const title = useMemo(() => {
    const match = NAV.find((n) => location.pathname.startsWith(n.to));
    if (match) return match.label;
    return settings?.site_name ?? 'مرکز پایش شبکه';
  }, [location.pathname, settings?.site_name]);

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    navigate(`/devices?search=${encodeURIComponent(q.trim())}`);
    setQ('');
  };

  return (
    <div className="min-h-screen">
      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 right-0 z-[900] w-[264px] shrink-0 border-l border-white/70 bg-white/80 backdrop-blur-xl transition-transform duration-300 lg:translate-x-0 ${
          open ? 'translate-x-0 shadow-pop' : 'translate-x-full'
        }`}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-3 px-5 py-5">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-glow">
              <Activity size={22} />
            </span>
            <div className="min-w-0">
              <p className="text-[15px] font-bold text-ink-800 leading-tight">NetWatch</p>
              <p className="text-[11px] text-ink-400 truncate">{settings?.site_name ?? 'پایش شبکه'}</p>
            </div>
            <button type="button" className="btn-ghost btn-xs ms-auto lg:hidden" onClick={() => setOpen(false)}>
              <X size={14} />
            </button>
          </div>

          <nav className="flex-1 space-y-1 overflow-y-auto px-3 pb-3">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `nav-item ${isActive ? 'nav-item-active' : ''}`}
              >
                <item.icon size={18} />
                <span className="flex-1">{item.label}</span>
                {item.to === '/alerts' && alertsApi.active > 0 ? (
                  <span className="num rounded-pill bg-red-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    {faDigits(alertsApi.active)}
                  </span>
                ) : null}
              </NavLink>
            ))}
          </nav>

          <div className="mx-3 mb-3 rounded-card border border-ink-200/70 bg-gradient-to-br from-brand-50/70 to-sun-50/60 p-3.5">
            <div className="flex items-center gap-2 text-[11px] font-medium text-ink-600">
              <Signal size={14} className="text-brand-500" />
              موتور مانیتورینگ
            </div>
            <div className="mt-2 flex items-center justify-between">
              <StatusPill status={engine?.running ? 'online' : 'offline'} size="sm" showLabel={false} />
              <span className="text-[11px] text-ink-500">{engine?.running ? 'در حال اجرا' : 'متوقف'}</span>
            </div>
            <div className="mt-2 space-y-1 text-[10.5px] text-ink-500">
              <p className="flex items-center justify-between">
                <span>حالت</span>
                <span className="font-medium text-ink-600">{MODE_LABEL[engine?.mode ?? 'simulate'] ?? engine?.mode}</span>
              </p>
              <p className="flex items-center justify-between">
                <span>بازه بررسی</span>
                <span className="num font-medium text-ink-600">{faDigits(engine?.interval ?? 0)} ثانیه</span>
              </p>
              <p className="flex items-center justify-between">
                <span>بررسی‌های انجام‌شده</span>
                <span className="num font-medium text-ink-600">{faDigits(engine?.checksRun ?? 0)}</span>
              </p>
            </div>
            <Link to="/settings" className="mt-2.5 block text-center text-[10.5px] text-brand-600 hover:text-brand-700">
              مدیریت تنظیمات موتور
            </Link>
          </div>
        </div>
      </aside>

      {open ? <div className="fixed inset-0 z-[890] bg-ink-900/20 backdrop-blur-sm lg:hidden" onClick={() => setOpen(false)} /> : null}

      {/* Main */}
      <div className="lg:mr-[264px]">
        <header className="sticky top-0 z-[800] border-b border-white/70 bg-white/75 backdrop-blur-xl">
          <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
            <button type="button" className="btn-ghost btn-xs lg:hidden" onClick={() => setOpen(true)} aria-label="منو">
              <Menu size={16} />
            </button>
            <div className="hidden min-w-0 sm:block">
              <h1 className="truncate text-[15px] font-semibold text-ink-800">{title}</h1>
              <p className="text-[11px] text-ink-400">{fmtRelative(live.lastEventAt ?? Date.now())} به‌روزرسانی</p>
            </div>

            <form onSubmit={submitSearch} className="relative ms-auto w-full max-w-xs">
              <Search size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-400" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="جست‌وجوی تجهیز، IP یا موقعیت…"
                className="field !rounded-pill !py-2 pr-9 pl-3 text-[12.5px]"
              />
              <Command size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-300" />
            </form>

            <div className="hidden md:block">
              <LiveDot connected={live.connected} />
            </div>

            <div className="relative">
              <button type="button" className="btn-ghost btn-xs relative" onClick={() => setNotifOpen((v) => !v)} aria-label="هشدارها">
                <Bell size={16} />
                {alertsApi.active > 0 ? (
                  <span className="num absolute -left-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
                    {faDigits(alertsApi.active)}
                  </span>
                ) : null}
              </button>
              {notifOpen ? (
                <div className="absolute left-0 mt-2 w-80 animate-fade-up rounded-card border border-white/70 bg-white/97 p-3 shadow-pop backdrop-blur-xl">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs font-semibold text-ink-700">هشدارهای فعال</p>
                    <Link to="/alerts" className="text-[11px] text-brand-600">
                      مشاهده همه
                    </Link>
                  </div>
                  <div className="max-h-72 space-y-2 overflow-y-auto">
                    {alertsApi.items.length === 0 ? (
                      <p className="py-6 text-center text-[11px] text-ink-400">هشدار فعالی وجود ندارد</p>
                    ) : (
                      alertsApi.items.slice(0, 6).map((a) => (
                        <Link
                          key={a.id}
                          to={a.deviceId ? `/devices/${a.deviceId}` : '/alerts'}
                          className="block rounded-soft border border-ink-100 bg-ink-50/50 p-2.5 transition hover:border-brand-200"
                        >
                          <p className="truncate text-[12px] font-medium text-ink-700">{a.title}</p>
                          <p className="mt-0.5 line-clamp-2 text-[10.5px] text-ink-500">{a.message}</p>
                          <p className="mt-1 text-[10px] text-ink-400">{fmtRelative(a.createdAt)}</p>
                        </Link>
                      ))
                    )}
                  </div>
                </div>
              ) : null}
            </div>

            <Link to="/devices" className="btn-primary btn-xs hidden sm:inline-flex">
              <Network size={14} />
              تجهیزات
            </Link>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1600px] px-4 py-5 sm:px-6 sm:py-6">{children}</main>

        <footer className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-2 px-4 pb-6 text-[11px] text-ink-400 sm:px-6">
          <span className="inline-flex items-center gap-1.5">
            <Radio size={12} />
            اجرای کاملاً آفلاین — بدون وابستگی به سرویس‌های ابری
          </span>
          <span className="num">
            {settings?.calendar === 'jalali' ? 'تقویم شمسی' : 'تقویم میلادی'} · نسخه ۱٫۰٫۰
          </span>
        </footer>
      </div>
    </div>
  );
}

export const MODE_LABEL: Record<string, string> = {
  auto: 'خودکار',
  icmp: 'ICMP',
  tcp: 'TCP',
  simulate: 'شبیه‌سازی',
};

interface AlertSummary {
  active: number;
  items: { id: number; title: string; message: string; createdAt: number; deviceId: number | null; severity: string }[];
}

function useAlertSummary(refreshKey: number): AlertSummary {
  const [data, setData] = useState<AlertSummary>({ active: 0, items: [] });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await api.alerts({ status: 'active', pageSize: 8 });
        if (alive)
          setData({
            active: res.stats.active,
            items: res.items.map((a) => ({ id: a.id, title: a.title, message: a.message, createdAt: a.createdAt, deviceId: a.deviceId, severity: a.severity })),
          });
      } catch {
        /* بی‌اثر */
      }
    };
    load();
    const id = setInterval(load, 20000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [refreshKey]);
  return data;
}
