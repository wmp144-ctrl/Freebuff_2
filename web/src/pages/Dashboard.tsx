import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Bell,
  CircleSlash,
  Clock,
  Gauge,
  RefreshCw,
  Server,
  ShieldCheck,
  Timer,
  TrendingDown,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { api } from '../lib/api';
import { useApp, useAsync, useLive } from '../lib/store';
import {
  faDigits,
  fmtDuration,
  fmtMs,
  fmtNumber,
  fmtPct,
  fmtRelative,
  healthTone,
  SEVERITY_META,
  statusMeta,
} from '../lib/format';
import { Card, CardHeader, ErrorState, HealthRing, PageLoader, Progress, StatCard, StatusLegend, Tabs } from '../components/ui';
import {
  DailyBars,
  GroupStatusBar,
  LatencyAreaChart,
  OfflineTrendChart,
  StatusDonut,
  TopBarList,
  TrendLineChart,
} from '../components/charts';
import { LayoutToolbar, WidgetShell, useDragRef, useWidgetLayout, type WidgetDef } from '../components/widgets';
import { DASHBOARD_WIDGETS } from '../lib/widgetdefs';
import type { DashboardData } from '../lib/types';

export default function Dashboard() {
  const { settings, tzOffset } = useApp();
  const live = useLive();
  const navigate = useNavigate();
  const lastRefresh = useRef(0);

  const layoutHook = useWidgetLayout('dashboard_widgets', DASHBOARD_WIDGETS);
  const { layout, editMode } = layoutHook;
  const dragId = useDragRef();
  const [dragging, setDragging] = useState<string | null>(null);

  const { data, loading, error, refresh } = useAsync<DashboardData>(() => api.dashboard(), [], { interval: 25000 });

  useEffect(() => {
    if (!live.version) return;
    if (Date.now() - lastRefresh.current < 12000) return;
    lastRefresh.current = Date.now();
    refresh();
  }, [live.version, refresh]);

  if (loading && !data) return <PageLoader label="در حال آماده‌سازی داشبورد…" />;
  if (error && !data) return <ErrorState message={error} onRetry={refresh} />;
  if (!data) return null;

  const { kpis, health, statusDistribution, offlineTrend, outagesPerDay, topLatency, topDowntime, groupStatus, healthTrend, recentAlerts, degraded } = data;
  const tone = healthTone(health.score);
  const availability = health.availability;
  const defById = Object.fromEntries(DASHBOARD_WIDGETS.map((d) => [d.id, d])) as Record<string, WidgetDef>;

  const healthTrendPoints = healthTrend.map((t) => ({
    label: new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(
      new Date(Date.parse(`${t.day}T12:00:00Z`) + tzOffset * 60000)
    ),
    health: t.health,
    availability: t.availability,
  }));

  const renderWidget = (wid: string): React.ReactNode => {
    switch (wid) {
      case 'kpis':
        return (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-6">
            <StatCard label="کل تجهیزات" value={fmtNumber(kpis.total)} hint={`${faDigits(kpis.monitoring)} تجهیز تحت پایش`} icon={<Server size={20} />} tone="brand" onClick={() => navigate('/devices')} />
            <StatCard label="در دسترس" value={fmtNumber(kpis.online)} hint="وضعیت Online" icon={<Wifi size={20} />} tone="emerald" onClick={() => navigate('/devices?status=online')} />
            <StatCard label="قطع‌شده" value={fmtNumber(kpis.offline)} hint="نیازمند بررسی فوری" icon={<WifiOff size={20} />} tone="red" onClick={() => navigate('/devices?status=offline')} />
            <StatCard label="دارای اختلال" value={fmtNumber(kpis.warning)} hint="تأخیر یا افت بسته" icon={<AlertTriangle size={20} />} tone="sun" onClick={() => navigate('/devices?status=warning')} />
            <StatCard label="هشدارهای فعال" value={fmtNumber(health.alertsActive)} hint={`${faDigits(health.alertCounts?.critical ?? 0)} بحرانی`} icon={<Bell size={20} />} tone="violet" onClick={() => navigate('/alerts')} />
            <StatCard label="غیرفعال" value={fmtNumber(kpis.disabled)} hint="پایش غیرفعال" icon={<CircleSlash size={20} />} tone="ink" onClick={() => navigate('/devices?enabled=0')} />
          </div>
        );

      case 'health':
        return (
          <Card className="h-full">
            <CardHeader title="شاخص سلامت شبکه" subtitle="ترکیب دسترس‌پذیری، تأخیر، افت بسته و هشدارها" icon={<ShieldCheck size={18} />} />
            <div className="mt-4 flex flex-col items-center gap-5 sm:flex-row sm:justify-center">
              <HealthRing score={health.score} color={tone.ring} caption={health.grade.label} />
              <div className="w-full max-w-[240px] space-y-3">
                <div>
                  <div className="mb-1 flex items-center justify-between text-[11px]">
                    <span className="text-ink-500">دسترس‌پذیری کل (۲۴ ساعت)</span>
                    <span className="num font-semibold text-ink-700">{fmtPct(availability, 2)}</span>
                  </div>
                  <Progress value={availability} color={availability >= 99 ? '#16a34a' : availability >= 95 ? '#f59e0b' : '#dc2626'} />
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between text-[11px]">
                    <span className="text-ink-500">میانگین تأخیر</span>
                    <span className="num font-semibold text-ink-700">{fmtMs(health.avgRtt)}</span>
                  </div>
                  <Progress value={Math.min(100, (health.avgRtt ?? 0) / 2)} color="#2563eb" />
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between text-[11px]">
                    <span className="text-ink-500">میانگین افت بسته</span>
                    <span className="num font-semibold text-ink-700">{fmtPct(health.lossAvg, 2)}</span>
                  </div>
                  <Progress value={Math.min(100, (health.lossAvg ?? 0) * 4)} color="#f59e0b" />
                </div>
                <div className="flex items-center justify-between rounded-soft bg-ink-50 px-3 py-2">
                  <span className="text-[11px] text-ink-500">وضعیت لحظه‌ای</span>
                  <span className={`text-[12px] font-semibold ${tone.text}`}>{health.grade.label}</span>
                </div>
              </div>
            </div>
          </Card>
        );

      case 'distribution':
        return (
          <Card className="h-full">
            <CardHeader title="وضعیت لحظه‌ای تجهیزات" subtitle="توزیع وضعیت در بین تجهیزات فعال" icon={<Activity size={18} />} />
            <StatusDonut data={statusDistribution} total={kpis.active} />
            <div className="mt-2 grid grid-cols-2 gap-2">
              {statusDistribution.map((s) => (
                <div key={s.key} className="flex items-center justify-between rounded-soft bg-ink-50/70 px-3 py-2">
                  <span className="flex items-center gap-1.5 text-[11px] text-ink-500">
                    <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                    {s.label}
                  </span>
                  <span className="num text-[12px] font-semibold text-ink-700">{fmtNumber(s.value)}</span>
                </div>
              ))}
            </div>
          </Card>
        );

      case 'degraded':
        return (
          <Card className="h-full">
            <CardHeader title="تجهیزات دارای افت کیفیت" subtitle="شناسایی خودکار اختلال و تأخیر غیرعادی" icon={<TrendingDown size={18} />} />
            <div className="mt-3 space-y-2">
              {degraded.length === 0 ? (
                <p className="py-8 text-center text-xs text-ink-400">هیچ تجهیز دارای افت کیفیت یافت نشد</p>
              ) : (
                degraded.map((d) => (
                  <Link key={d.id} to={`/devices/${d.id}`} className="flex items-center justify-between gap-3 rounded-soft border border-ink-100 bg-white/70 px-3 py-2 transition hover:border-brand-200 hover:bg-brand-50/40">
                    <span className="min-w-0">
                      <span className="block truncate text-[12.5px] font-medium text-ink-700">{d.name}</span>
                      <span className="num block text-[10.5px] text-ink-400">{d.ip}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="num text-[11px] text-ink-500">{fmtMs(d.avgRtt)}</span>
                      <span className={`chip ${statusMeta(d.status).bg} ${statusMeta(d.status).text} ${statusMeta(d.status).border} px-2 py-0.5 text-[10px]`}>{fmtPct(d.uptime, 1)}</span>
                    </span>
                  </Link>
                ))
              )}
            </div>
          </Card>
        );

      case 'offline-trend':
        return (
          <Card className="h-full">
            <CardHeader title="تغییرات تعداد تجهیزات قطع‌شده" subtitle="۲۴ ساعت گذشته — بازه‌های ۱۵ دقیقه‌ای" icon={<WifiOff size={18} />} />
            <div className="mt-3">
              <OfflineTrendChart points={offlineTrend} tzOffset={tzOffset} />
            </div>
          </Card>
        );

      case 'outages-per-day':
        return (
          <Card className="h-full">
            <CardHeader title="تعداد قطعی‌ها به تفکیک روز" subtitle="۱۴ روز گذشته" icon={<Zap size={18} />} />
            <div className="mt-3">
              <DailyBars points={outagesPerDay} tzOffset={tzOffset} />
            </div>
          </Card>
        );

      case 'health-trend':
        return (
          <Card className="h-full">
            <CardHeader title="روند شاخص سلامت و دسترس‌پذیری" subtitle="۷ روز گذشته" icon={<ShieldCheck size={18} />} />
            <div className="mt-3">
              {healthTrendPoints.length ? (
                <TrendLineChart
                  points={healthTrendPoints}
                  series={[
                    { key: 'health', label: 'شاخص سلامت', color: '#2563eb' },
                    { key: 'availability', label: 'دسترس‌پذیری', color: '#16a34a' },
                  ]}
                  yDomain={[0, 100]}
                  suffix="٪"
                />
              ) : (
                <p className="py-10 text-center text-xs text-ink-400">داده کافی برای نمایش روند وجود ندارد</p>
              )}
            </div>
          </Card>
        );

      case 'group-status':
        return (
          <Card className="h-full">
            <CardHeader title="وضعیت گروه‌های تجهیزات" subtitle="برای فیلتر کردن روی هر گروه کلیک کنید" icon={<Server size={18} />} />
            <div className="mt-3">
              <GroupStatusBar groups={groupStatus} onSelect={(name) => navigate(`/devices?group=${encodeURIComponent(name)}`)} />
            </div>
          </Card>
        );

      case 'top-latency':
        return (
          <Card className="h-full">
            <CardHeader title="۱۰ تجهیز با بیشترین تأخیر" subtitle="میانگین ۲۴ ساعت گذشته" icon={<Timer size={18} />} />
            <div className="mt-3">
              <TopBarList items={topLatency as unknown as Record<string, unknown>[]} valueKey="avgRtt" formatter={(v) => fmtMs(v)} color="#2563eb" onSelect={(item) => navigate(`/devices/${item.id}`)} />
            </div>
          </Card>
        );

      case 'top-downtime':
        return (
          <Card className="h-full">
            <CardHeader title="۱۰ تجهیز با بیشترین قطعی" subtitle="مجموع مدت قطعی در ۷ روز گذشته" icon={<Clock size={18} />} />
            <div className="mt-3">
              <TopBarList items={topDowntime as unknown as Record<string, unknown>[]} valueKey="downtimeSec" formatter={(v) => fmtDuration(v)} color="#dc2626" onSelect={(item) => navigate(`/devices/${item.id}`)} />
            </div>
          </Card>
        );

      case 'recent-alerts':
        return (
          <Card className="h-full">
            <CardHeader
              title="آخرین هشدارها"
              subtitle="رویدادهای ثبت‌شده توسط سیستم هشدار"
              icon={<Bell size={18} />}
              action={
                <Link to="/alerts" className="btn-ghost btn-xs">
                  همه هشدارها
                </Link>
              }
            />
            <div className="mt-3 divide-y divide-ink-100">
              {recentAlerts.length === 0 ? (
                <p className="py-8 text-center text-xs text-ink-400">هشداری ثبت نشده است</p>
              ) : (
                recentAlerts.map((a) => {
                  const sev = SEVERITY_META[a.severity] ?? SEVERITY_META.info;
                  return (
                    <Link key={a.id} to={a.deviceId ? `/devices/${a.deviceId}` : '/alerts'} className="flex items-start gap-3 py-2.5 transition hover:bg-brand-50/30">
                      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${sev.dot}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-medium text-ink-700">{a.title}</span>
                        <span className="mt-0.5 line-clamp-1 block text-[11px] text-ink-500">{a.message}</span>
                      </span>
                      <span className="shrink-0 text-[10.5px] text-ink-400">{fmtRelative(a.createdAt)}</span>
                    </Link>
                  );
                })
              )}
            </div>
          </Card>
        );

      case 'avg-rtt':
        return (
          <Card className="h-full">
            <CardHeader title="میانگین تأخیر شبکه" subtitle="۷ روز گذشته" icon={<Gauge size={18} />} />
            <div className="mt-3">
              {data.avgRttTrend?.some((d) => d.avgRtt != null) ? (
                <TrendLineChart
                  points={(data.avgRttTrend ?? []).map((d) => ({
                    label: new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(
                      new Date(Date.parse(`${d.day}T12:00:00Z`) + tzOffset * 60000)
                    ),
                    avgRtt: d.avgRtt ?? null,
                  }))}
                  series={[{ key: 'avgRtt', label: 'میانگین تأخیر', color: '#f59e0b' }]}
                  suffix=" ms"
                />
              ) : (
                <LatencyAreaChart points={offlineTrend.map((o) => ({ t: o.t, rtt: null }))} height={180} tzOffset={tzOffset} />
              )}
            </div>
            <div className="mt-3 rounded-soft border border-sun-100 bg-sun-50/70 p-3 text-[11px] text-sun-800">
              آستانه مجاز تأخیر: <span className="num font-semibold">{faDigits(settings?.latency_threshold ?? 150)} ms</span> — آستانه افت بسته:{' '}
              <span className="num font-semibold">{faDigits(settings?.loss_threshold ?? 10)}٪</span>
            </div>
          </Card>
        );

      case 'quick-links':
        return (
          <Card>
            <CardHeader title="نکات کاربردی" subtitle="برای دسترسی سریع به بخش‌های کلیدی" icon={<Zap size={18} />} />
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <QuickLink to="/devices?status=offline" title="بررسی تجهیزات قطع‌شده" desc="مشاهده و ثبت سابقه برای تجهیزات خارج از دسترس" />
              <QuickLink to="/maintenance" title="ثبت سابقه تعمیرات" desc="ثبت علت خرابی، اقدام انجام‌شده و هزینه نگهداری" />
              <QuickLink to="/map" title="موقعیت جغرافیایی تجهیزات" desc="نمایش تجهیزات روی نقشه آفلاین و مدیریت لایه‌ها" />
            </div>
          </Card>
        );

      default:
        return null;
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-ink-800">نمای کلی زیرساخت</h2>
          <p className="mt-1 text-xs text-ink-500">
            آخرین به‌روزرسانی {fmtRelative(data.generatedAt)} · {faDigits(health.checks24h)} بررسی در ۲۴ ساعت گذشته
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusLegend className="hidden md:flex" />
          <LayoutToolbar
            editMode={editMode}
            setEditMode={layoutHook.setEditMode}
            layout={layout}
            defs={DASHBOARD_WIDGETS}
            onAdd={(id) => layoutHook.setVisible(id, true)}
            onReset={layoutHook.reset}
          />
          <button type="button" className="btn-ghost btn-xs" onClick={refresh}>
            <RefreshCw size={14} />
            بروزرسانی
          </button>
          <Link to="/reports" className="btn-soft btn-xs">
            <Gauge size={14} />
            تحلیل کامل
          </Link>
        </div>
      </div>

      {editMode ? (
        <div className="animate-fade-up rounded-card border border-brand-200 bg-brand-50/70 p-3 text-[12px] text-brand-800">
          حالت چیدمان فعال است: ویجت‌ها را بکشید و روی هم رها کنید تا جابه‌جا شوند، اندازه انتخاب کنید یا حذف/افزوده کنید.
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-6">
        {layout
          .filter((w) => w.visible)
          .map((w) => (
            <WidgetShell
              key={w.id}
              item={w}
              def={defById[w.id]}
              editMode={editMode}
              dragging={dragging === w.id}
              onDragStart={() => {
                dragId.current = w.id;
                setDragging(w.id);
              }}
              onDragEnd={() => {
                dragId.current = null;
                setDragging(null);
              }}
              onDropOn={() => {
                if (dragId.current) layoutHook.move(dragId.current, w.id);
                dragId.current = null;
                setDragging(null);
              }}
              onSize={(s) => layoutHook.setSize(w.id, s)}
              onHide={() => layoutHook.setVisible(w.id, false)}
            >
              {renderWidget(w.id)}
            </WidgetShell>
          ))}
      </div>
    </div>
  );
}

function QuickLink({ to, title, desc }: { to: string; title: string; desc: string }) {
  return (
    <Link to={to} className="group rounded-soft border border-ink-200/70 bg-white/70 p-4 transition-all duration-300 hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-soft">
      <p className="text-[13px] font-semibold text-ink-700 group-hover:text-brand-700">{title}</p>
      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-500">{desc}</p>
    </Link>
  );
}
