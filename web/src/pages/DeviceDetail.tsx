import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CircleCheck,
  Clock,
  Edit3,
  Gauge,
  MapPin,
  Package,
  Percent,
  Radio,
  RefreshCw,
  Server,
  ShieldAlert,
  Timer,
  Trash2,
  TrendingUp,
  Wifi,
  Wrench,
  Paperclip,
  Image as ImageIcon,
  Upload,
  FileDown,
  Eye,
} from 'lucide-react';
import { api } from '../lib/api';
import { useApp, useAsync, useDeviceLive, useLiveState, useToast } from '../lib/store';
import { useAuth } from '../lib/auth';
import { DataFreshness } from '../components/Freshness';
import { faDigits, fmtDate, fmtDateTime, fmtDuration, fmtMs, fmtNumber, fmtPct, fmtRelative, PRIORITY_META, statusMeta } from '../lib/format';
import { Badge, Card, CardHeader, EmptyState, ErrorState, Modal, PageLoader, Progress, StatusPill, Tabs } from '../components/ui';
import { AvailabilityBars, LatencyAreaChart, LossAreaChart, StatusTimeline, TrendLineChart } from '../components/charts';
import MaintenanceForm from '../features/MaintenanceForm';
import DeviceForm from '../features/DeviceForm';
import { useLivePing } from '../components/LivePing';
import { LayoutToolbar, WidgetShell, useDragRef, useWidgetLayout, type WidgetDef } from '../components/widgets';
import { DETAIL_WIDGETS } from '../lib/widgetdefs';
import type { Device, Outage, Series } from '../lib/types';

type ChartRange = '1h' | '6h' | '24h' | '7d' | '30d';

export default function DeviceDetail() {
  const { id } = useParams();
  const { settings, tzOffset, refreshMeta } = useApp();
  const { push } = useToast();
  const navigate = useNavigate();
  const live = useDeviceLive(id);
  const livePing = useLivePing();
  const liveState = useLiveState();
  const { can } = useAuth();
  const canWrite = can('devices:write');
  const canProbe = can('probe:run');
  const canMaintenance = can('maintenance:write');

  const [editOpen, setEditOpen] = useState(false);
  const [maintOpen, setMaintOpen] = useState(false);
  const [maintDefaults, setMaintDefaults] = useState<{ cause?: string; startedAt?: number }>({});
  const [pinging, setPinging] = useState(false);

  const layoutHook = useWidgetLayout('device_detail_widgets', DETAIL_WIDGETS);
  const { layout, editMode } = layoutHook;
  const dragId = useDragRef();
  const [dragging, setDragging] = useState<string | null>(null);

  const { data: device, loading, error, refresh, updatedAt } = useAsync<Device>((signal) => api.device(id!, signal), [id], { interval: 20000 });
  const { data: health, refresh: refreshHealth } = useAsync((signal) => api.deviceHealth(id!, signal), [id], { interval: 60000 });
  const { data: outages, refresh: refreshOutages } = useAsync((signal) => api.outages(id!, 100, signal), [id], { interval: 30000 });
  const { data: maint } = useAsync((signal) => api.deviceMaintenance(id!, signal), [id]);
  const { data: samples } = useAsync((signal) => api.samples(id!, 120, signal), [id]);

  useEffect(() => {
    if (live?.ts) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.ts]);

  // پس از قطع/وصل مجدد SSE، جزئیات و تاریخچه دوباره خوانده می‌شود.
  const seenSync = React.useRef(liveState.syncToken);
  useEffect(() => {
    if (liveState.syncToken === seenSync.current) return;
    seenSync.current = liveState.syncToken;
    refresh();
    refreshHealth();
    refreshOutages();
  }, [liveState.syncToken, refresh, refreshHealth, refreshOutages]);

  const ping = async () => {
    setPinging(true);
    try {
      const res = await api.pingDevice(id!);
      const r = res.result;
      push(r.ok ? `پاسخ دریافت شد — ${fmtMs(r.rtt)} (حالت: ${r.mode})` : `پاسخی دریافت نشد — ${r.error ?? 'Timeout'}`, r.ok ? 'success' : 'error');
      refresh();
      refreshHealth();
    } catch (e) {
      push((e as Error).message, 'error');
    } finally {
      setPinging(false);
    }
  };

  const removeDevice = async () => {
    if (!device) return;
    if (!window.confirm(`تجهیز «${device.name}» و تمام تاریخچه آن حذف شود؟`)) return;
    try {
      await api.deleteDevice(device.id);
      push('تجهیز حذف شد', 'success');
      refreshMeta();
      navigate('/devices');
    } catch (e) {
      push((e as Error).message, 'error');
    }
  };

  if (loading && !device) return <PageLoader label="در حال دریافت اطلاعات تجهیز…" />;
  if (error && !device) return <ErrorState message={error} onRetry={refresh} />;
  if (!device) return null;

  const meta = statusMeta(device.status);
  const eff = device.effective;
  const currentOutageSec = device.currentOutageStartedAt ? Math.round((Date.now() - device.currentOutageStartedAt) / 1000) : 0;
  const defById = Object.fromEntries(DETAIL_WIDGETS.map((d) => [d.id, d])) as Record<string, WidgetDef>;

  const renderWidget = (wid: string): React.ReactNode => {
    switch (wid) {
      case 'general':
        return (
          <Card className="h-full">
            <CardHeader title="اطلاعات عمومی" subtitle="مشخصات پایه تجهیز" icon={<Server size={18} />} />
            <dl className="mt-4 divide-y divide-ink-100">
              <InfoRow label="نام دستگاه" value={device.name} />
              <InfoRow label="آدرس IP" value={<span className="num">{device.ip}</span>} />
              <InfoRow label="نوع تجهیز" value={device.deviceType} />
              <InfoRow label="گروه" value={device.groupName ?? '—'} />
              <InfoRow
                label="عضویت گروهی"
                value={
                  device.groups?.length ? (
                    <span className="flex flex-wrap justify-end gap-1">
                      {device.groups.map((g) => (
                        <span key={g.id} className="chip" style={{ borderColor: `${g.color}44`, background: `${g.color}12`, color: g.color }}>
                          {g.name}
                        </span>
                      ))}
                    </span>
                  ) : (
                    '—'
                  )
                }
              />
              <InfoRow label="تاریخ نصب" value={device.installedAt ? fmtDate(device.installedAt, tzOffset) : 'ثبت نشده'} />
              <InfoRow label="محل استقرار" value={device.location || '—'} sub={[device.building, device.rack].filter(Boolean).join(' · ')} />
              <InfoRow label="وضعیت فعلی" value={<StatusPill status={device.status} size="sm" />} />
              <InfoRow label="زمان آخرین بررسی" value={fmtDateTime(device.lastCheckAt, tzOffset)} />
              <InfoRow label="سازنده / مدل" value={[device.vendor, device.model].filter(Boolean).join(' ') || '—'} />
              <InfoRow label="شماره سریال" value={<span className="num">{device.serial || '—'}</span>} />
              <InfoRow label="مسئول" value={device.owner || '—'} />
              <InfoRow label="موقعیت جغرافیایی" value={device.latitude != null ? <span className="num">{device.latitude.toFixed(5)}, {device.longitude?.toFixed(5)}</span> : 'ثبت نشده'} />
              <InfoRow label="یادداشت" value={device.notes || '—'} />
            </dl>
          </Card>
        );

      case 'monitoring':
        return (
          <Card className="h-full">
            <CardHeader
              title="اطلاعات مانیتورینگ"
              subtitle={`حالت موتور: ${settings?.engine_mode ?? '—'} · بازه مؤثر ${faDigits(eff?.pingInterval ?? 0)} ثانیه`}
              icon={<Gauge size={18} />}
            />
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <MetricBox label="وضعیت Online / Offline" value={meta.label} tone={meta.text} />
              <MetricBox label="زمان آخرین Ping" value={fmtDateTime(device.lastCheckAt, tzOffset)} small />
              <MetricBox label="Response Time" value={fmtMs(live?.rtt ?? device.lastRtt)} />
              <MetricBox label="Minimum Latency" value={fmtMs(device.minRtt)} />
              <MetricBox label="Maximum Latency" value={fmtMs(device.maxRtt)} />
              <MetricBox label="Average Latency" value={fmtMs(device.avgRtt)} />
              <MetricBox label="Packet Loss" value={fmtPct(device.lossPct, 2)} tone={device.lossPct > 5 ? 'text-sun-600' : undefined} />
              <MetricBox label="Ping موفق" value={fmtNumber(device.successCount)} tone="text-emerald-600" />
              <MetricBox label="Ping ناموفق" value={fmtNumber(device.failCount)} tone={device.failCount ? 'text-red-600' : undefined} />
              <MetricBox label="Consecutive Failures" value={fmtNumber(device.consecutiveFailures)} tone={device.consecutiveFailures ? 'text-red-600' : undefined} />
              <MetricBox label="Uptime" value={fmtPct(device.uptimePct, 2)} tone={(device.uptimePct ?? 100) < 98 ? 'text-sun-600' : 'text-emerald-600'} />
              <MetricBox label="زمان آخرین قطعی" value={fmtDateTime(device.lastOutageAt, tzOffset)} small />
              <MetricBox label="مدت قطعی فعلی" value={device.currentOutageStartedAt ? fmtDuration(currentOutageSec) : '—'} tone={device.currentOutageStartedAt ? 'text-red-600' : undefined} />
              <MetricBox label="MTBF" value={health?.mtbfSec ? fmtDuration(health.mtbfSec) : '—'} small />
              <MetricBox label="MTTR" value={health?.mttrSec ? fmtDuration(health.mttrSec) : '—'} small />
              <MetricBox label="تعداد کل بررسی‌ها" value={fmtNumber(device.totalChecks)} />
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div>
                <div className="mb-1.5 flex items-center justify-between text-[11px]">
                  <span className="text-ink-500">
                    <Percent size={11} className="inline" /> آستانه‌های مؤثر
                  </span>
                </div>
                <div className="space-y-2 rounded-soft border border-ink-200 bg-white/70 p-3 text-[11.5px]">
                  <Row label="آستانه تأخیر" value={`${faDigits(eff?.latencyThreshold ?? 0)} ms`} />
                  <Row label="آستانه افت بسته" value={`${faDigits(eff?.lossThreshold ?? 0)}٪`} />
                  <Row label="زمان انتظار پاسخ" value={`${faDigits(eff?.timeoutMs ?? 0)} ms`} />
                  <Row label="تعداد Packet" value={`${faDigits(eff?.packetCount ?? 0)}`} />
                  <Row label="تلاش مجدد" value={`${faDigits(eff?.retries ?? 0)}`} />
                </div>
              </div>
              <div>
                <div className="mb-1.5 text-[11px] text-ink-500">
                  <Package size={11} className="inline" /> آخرین نمونه‌های ثبت‌شده
                </div>
                <div className="max-h-[168px] overflow-auto rounded-soft border border-ink-200 bg-white/70">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>زمان</th>
                        <th>تأخیر</th>
                        <th>افت</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(samples?.items ?? []).slice(0, 40).map((s) => (
                        <tr key={s.ts}>
                          <td className="text-[11px]">{fmtDateTime(s.ts, tzOffset)}</td>
                          <td className="num">{fmtMs(s.rtt)}</td>
                          <td className="num">{fmtPct(s.lossPct)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </Card>
        );

      case 'charts':
        return (
          <div className="space-y-4">
            <h3 className="section-title">
              <TrendingUp size={17} className="text-brand-500" />
              نمودارهای تاریخی
            </h3>
            <div className="grid gap-5 xl:grid-cols-2">
              <SeriesCard
                title="نمودار Latency"
                subtitle="تغییرات تأخیر — همراه سایه زیر نمودار"
                icon={<Activity size={18} />}
                ranges={['1h', '6h', '24h', '7d', '30d']}
                defaultRange={(settings?.chart_default_range as ChartRange) || '1h'}
                deviceId={id!}
                threshold={eff?.latencyThreshold}
                tzOffset={tzOffset}
                render={(series) => <LatencyAreaChart points={series.points} range={series.range} threshold={eff?.latencyThreshold} showMinMax height={250} tzOffset={tzOffset} />}
              />
              <SeriesCard
                title="نمودار Packet Loss"
                subtitle="درصد افت بسته در بازه‌های زمانی"
                icon={<Percent size={18} />}
                ranges={['1h', '24h', '7d', '30d']}
                defaultRange="24h"
                deviceId={id!}
                tzOffset={tzOffset}
                render={(series) => <LossAreaChart points={series.points} range={series.range} height={250} tzOffset={tzOffset} />}
              />
              <SeriesCard
                title="نمودار وضعیت Online / Offline"
                subtitle="تعداد پاسخ‌های موفق و ناموفق در هر بازه"
                icon={<Radio size={18} />}
                ranges={['1h', '24h', '7d', '30d']}
                defaultRange="24h"
                deviceId={id!}
                tzOffset={tzOffset}
                render={(series) => <StatusTimeline points={series.points} range={series.range} height={250} tzOffset={tzOffset} />}
              />
              <SeriesCard
                title="نمودار Availability"
                subtitle="دسترس‌پذیری تجهیز در هر بازه (٪)"
                icon={<CircleCheck size={18} />}
                ranges={['1h', '24h', '7d', '30d']}
                defaultRange="24h"
                deviceId={id!}
                tzOffset={tzOffset}
                render={(series) => <AvailabilityBars buckets={series.points} range={series.range} height={250} tzOffset={tzOffset} />}
              />
            </div>
          </div>
        );

      case 'daily':
        return (
          <Card>
            <CardHeader title="روند دسترس‌پذیری روزانه" subtitle="۱۴ روز گذشته — بر اساس آمار تجمیعی روزانه" icon={<CalendarClock size={18} />} />
            <div className="mt-3">
              {health?.daily?.length ? (
                <TrendLineChart
                  points={health.daily.map((d) => ({
                    label: new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(
                      new Date(Date.parse(`${d.day}T12:00:00Z`) + tzOffset * 60000)
                    ),
                    uptime: d.uptime_pct,
                    avgRtt: d.avg_rtt,
                  }))}
                  series={[
                    { key: 'uptime', label: 'دسترس‌پذیری', color: '#16a34a' },
                    { key: 'avgRtt', label: 'میانگین تأخیر', color: '#2563eb' },
                  ]}
                  tzOffset={tzOffset}
                />
              ) : (
                <p className="py-10 text-center text-xs text-ink-400">داده روزانه‌ای موجود نیست</p>
              )}
            </div>
          </Card>
        );

      case 'outages':
        return (
          <Card>
            <CardHeader
              title="تاریخچه اختلالات و قطعی‌ها"
              subtitle={`${faDigits(outages?.total ?? 0)} رویداد ثبت‌شده برای این تجهیز`}
              icon={<ShieldAlert size={18} />}
              action={
                <div className="flex gap-2">
                  <button type="button" className="btn-ghost btn-xs" onClick={refreshOutages}>
                    <RefreshCw size={13} />
                    بروزرسانی
                  </button>
                  <button type="button" className="btn-soft btn-xs" onClick={() => { setMaintDefaults({}); setMaintOpen(true); }}>
                    <Wrench size={13} />
                    ثبت سابقه
                  </button>
                </div>
              }
            />

            {outages?.open ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-soft border border-red-200 bg-red-50/70 p-3">
                <div className="flex items-center gap-2 text-[12px] text-red-700">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-70 animate-pulse-ring" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
                  </span>
                  قطعی در جریان است — شروع {fmtDateTime(outages.open.started_at, tzOffset)}
                </div>
                <span className="num text-[12px] font-semibold text-red-700">مدت: {fmtDuration(outages.open.durationSec)}</span>
              </div>
            ) : null}

            <div className="mt-4">
              {!outages?.items?.length ? (
                <EmptyState title="اختلالی ثبت نشده است" description="برای این تجهیز در بازه نگهداری داده‌ها هیچ قطعی ثبت نشده است." icon={<CircleCheck size={22} />} />
              ) : (
                <div className="table-wrap max-h-[520px]">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>زمان شروع</th>
                        <th>زمان پایان</th>
                        <th>مدت قطعی</th>
                        <th>علت اختلال</th>
                        <th>اقدام ثبت‌شده</th>
                        <th>وضعیت</th>
                      </tr>
                    </thead>
                    <tbody>
                      {outages.items.map((o: Outage) => (
                        <tr key={o.id}>
                          <td className="num text-[12px]">{fmtDateTime(o.startedAt, tzOffset)}</td>
                          <td className="num text-[12px]">{o.open ? <span className="text-red-600">در جریان</span> : fmtDateTime(o.endedAt, tzOffset)}</td>
                          <td className="num">{fmtDuration(o.durationSec)}</td>
                          <td>
                            <span className="chip border-ink-200 bg-ink-50 text-ink-600">{o.cause}</span>
                          </td>
                          <td className="text-[12px]">{o.maintenance ? o.maintenance.action : <span className="text-ink-400">ثبت نشده</span>}</td>
                          <td>{o.open ? <Badge tone="red">باز</Badge> : <Badge tone="emerald">بسته‌شده</Badge>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Card>
        );

      case 'maintenance':
        return (
          <Card>
            <CardHeader
              title="سوابق تعمیرات و نگهداری"
              subtitle={`${faDigits(maint?.items?.length ?? 0)} سابقه ثبت‌شده برای این تجهیز`}
              icon={<Wrench size={18} />}
              action={
                <button type="button" className="btn-soft btn-xs" onClick={() => { setMaintDefaults({}); setMaintOpen(true); }}>
                  <Wrench size={13} />
                  سابقه جدید
                </button>
              }
            />
            <div className="mt-4">
              {!maint?.items?.length ? (
                <EmptyState title="سابقه تعمیراتی ثبت نشده" description="با ثبت علت خرابی و اقدام انجام‌شده، سوابق نگهداری این تجهیز را کامل کنید. قطعی‌های شناسایی‌شده توسط موتور به‌صورت خودکار سابقه نمی‌سازند." icon={<Wrench size={22} />} />
              ) : (
                <div className="space-y-3">
                  {maint.items.map((m) => (
                    <div key={m.id} className="rounded-soft border border-ink-200/70 bg-white/70 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-[12.5px] font-semibold text-ink-700">{m.title || m.action}</p>
                        <span className="flex items-center gap-2">
                          <Badge tone="brand">{m.cause}</Badge>
                          <Badge tone="sun">{m.action}</Badge>
                          {m.status === 'open' ? <Badge tone="red">در جریان</Badge> : <Badge tone="emerald">پایان‌یافته</Badge>}
                        </span>
                      </div>
                      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-500">{m.description || '—'}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] text-ink-400">
                        <span>شروع: {fmtDateTime(m.startedAt, tzOffset)}</span>
                        <span>پایان: {m.endedAt ? fmtDateTime(m.endedAt, tzOffset) : '—'}</span>
                        <span>مدت: {fmtDuration(m.downtimeSec)}</span>
                        <span>تکنسین: {m.technician || '—'}</span>
                        {m.cost ? <span className="num">هزینه: {fmtNumber(m.cost)}</span> : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        );

      default:
        return null;
    }
  };

  return (
    <div className="space-y-5">
      {/* سربرگ */}
      <Card className="relative overflow-hidden">
        <div className="pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full bg-brand-400/10 blur-3xl" />
        <div className="pointer-events-none absolute -right-10 -bottom-20 h-56 w-56 rounded-full bg-sun-300/20 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4">
            <button type="button" className="btn-ghost btn-xs mt-1" onClick={() => navigate('/devices')} aria-label="بازگشت">
              <ArrowRight size={15} />
            </button>
            <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-glow">
              <Server size={24} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-lg font-bold text-ink-800">{device.name}</h2>
                <StatusPill status={device.status} />
                <Badge className={PRIORITY_META[device.priority]?.className}>اولویت {PRIORITY_META[device.priority]?.label}</Badge>
                {!device.enabled ? <Badge tone="ink">غیرفعال</Badge> : null}
                {!device.monitoringEnabled ? <Badge tone="sun">پایش غیرفعال</Badge> : null}
                {device.serviceStatus === 'unavailable' ? (
                  <Badge tone="sun">
                    سرویس{device.servicePort ? ` پورت ${device.servicePort}` : ''} قطع
                  </Badge>
                ) : null}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-500">
                <span className="num">{device.ip}</span>
                {device.hostname ? <span className="num">{device.hostname}</span> : null}
                <span>{device.deviceType}</span>
                {device.groupName ? (
                  <span className="chip" style={{ borderColor: `${device.groupColor}44`, background: `${device.groupColor}12`, color: device.groupColor ?? undefined }}>
                    {device.groupName}
                  </span>
                ) : null}
                {device.location ? (
                  <span className="inline-flex items-center gap-1">
                    <MapPin size={12} />
                    {device.location}
                  </span>
                ) : null}
                {(device.tags || []).map((t) => (
                  <span key={t.id} className="chip" style={{ borderColor: `${t.color}44`, background: `${t.color}12`, color: t.color }}>
                    {t.name}
                  </span>
                ))}
              </div>
              {device.statusReason ? (
                <p className="mt-2 inline-flex items-center gap-1.5 rounded-soft bg-sun-50 px-2.5 py-1 text-[11px] text-sun-800">
                  <AlertTriangle size={12} />
                  {device.statusReason}
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <LayoutToolbar
              editMode={editMode}
              setEditMode={layoutHook.setEditMode}
              layout={layout}
              defs={DETAIL_WIDGETS}
              onAdd={(id) => layoutHook.setVisible(id, true)}
              onReset={layoutHook.reset}
            />
            {canProbe ? (
              <>
                <button type="button" className="btn-primary btn-xs" onClick={ping} disabled={pinging}>
                  <Wifi size={14} />
                  {pinging ? 'در حال ارسال…' : 'Ping لحظه‌ای'}
                </button>
                <button
                  type="button"
                  className={`btn-xs ${livePing.has(device.id) ? 'btn-soft' : 'btn-ghost'}`}
                  onClick={() => livePing.toggle({ id: device.id, name: device.name, ip: device.ip, status: device.status })}
                >
                  <Gauge size={14} />
                  پنجرهٔ پینگ زنده
                </button>
              </>
            ) : null}
            {canWrite ? (
              <button type="button" className="btn-ghost btn-xs" onClick={() => setEditOpen(true)}>
                <Edit3 size={14} />
                ویرایش
              </button>
            ) : null}
            {canMaintenance ? (
              <button
                type="button"
                className="btn-ghost btn-xs"
                onClick={() => {
                  setMaintDefaults({ cause: outages?.open ? 'مشکل شبکه' : undefined, startedAt: device.currentOutageStartedAt ?? Date.now() });
                  setMaintOpen(true);
                }}
              >
                <Wrench size={14} />
                ثبت تعمیرات
              </button>
            ) : null}
            {device.latitude != null ? (
              <Link className="btn-ghost btn-xs" to={`/map?device=${device.id}`}>
                <MapPin size={14} />
                نمایش روی نقشه
              </Link>
            ) : null}
            {canWrite ? (
              <button type="button" className="btn-danger btn-xs" onClick={removeDevice}>
                <Trash2 size={14} />
                حذف
              </button>
            ) : null}
            <button type="button" className="btn-ghost btn-xs" onClick={refresh}>
              <RefreshCw size={14} />
            </button>
          </div>
        </div>

        <div className="relative mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MiniStat label="وضعیت فعلی" value={meta.label} tone={meta.text} icon={<Activity size={15} />} />
          <MiniStat label="آخرین بررسی" value={fmtRelative(device.lastCheckAt)} hint={fmtDateTime(device.lastCheckAt, tzOffset)} icon={<Clock size={15} />} />
          <MiniStat
            label="مدت قطعی فعلی"
            value={device.currentOutageStartedAt ? fmtDuration(currentOutageSec) : '—'}
            tone={device.currentOutageStartedAt ? 'text-red-600' : 'text-emerald-600'}
            icon={<Timer size={15} />}
          />
          <MiniStat label="آخرین قطعی" value={fmtRelative(device.lastOutageAt)} hint={fmtDateTime(device.lastOutageAt, tzOffset)} icon={<ShieldAlert size={15} />} />
        </div>
      </Card>

      <DataFreshness updatedAt={updatedAt} intervalMs={20000} onRefresh={refresh} />

      {editMode ? (
        <div className="animate-fade-up rounded-card border border-brand-200 bg-brand-50/70 p-3 text-[12px] text-brand-800">
          حالت چیدمان فعال است: ویجت‌ها را بکشید و روی هم رها کنید تا ترتیبشان تغییر کند، اندازه را انتخاب کنید یا آن‌ها را مخفی سازید.
        </div>
      ) : null}

      {/* ویجت‌های قابل تنظیم */}
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

      <DeviceAttachments deviceId={device.id} canWrite={canWrite} />

      <DeviceForm open={editOpen} device={device} onClose={() => setEditOpen(false)} onSaved={() => { refresh(); refreshMeta(); }} />
      <MaintenanceForm
        open={maintOpen}
        onClose={() => setMaintOpen(false)}
        deviceId={device.id}
        outageId={outages?.open?.id ?? null}
        defaults={maintDefaults}
        onSaved={refreshOutages}
      />
    </div>
  );
}

/* --------------------------- پیوست‌ها و مستندات --------------------------- */

function formatBytes(bytes: number) {
  if (!bytes) return '۰';
  if (bytes < 1024) return `${faDigits(bytes)} بایت`;
  if (bytes < 1024 * 1024) return `${faDigits((bytes / 1024).toFixed(0))} کیلوبایت`;
  return `${faDigits((bytes / 1024 / 1024).toFixed(1))} مگابایت`;
}

function DeviceAttachments({ deviceId, canWrite }: { deviceId: number; canWrite: boolean }) {
  const { push } = useToast();
  const { data, loading, error, refresh } = useAsync((signal) => api.attachments(deviceId, signal), [deviceId]);
  const [preview, setPreview] = useState<import('../lib/types').DeviceAttachment | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const upload = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy(true);
    try {
      await api.uploadAttachment(deviceId, file);
      push('پیوست افزوده شد', 'success');
      refresh();
    } catch (e) {
      push((e as Error).message, 'error');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async (att: import('../lib/types').DeviceAttachment) => {
    if (!window.confirm(`پیوست «${att.fileName}» حذف شود؟`)) return;
    try {
      await api.deleteAttachment(deviceId, att.id);
      push('پیوست حذف شد', 'success');
      refresh();
    } catch (e) {
      push((e as Error).message, 'error');
    }
  };

  const items = data?.items ?? [];
  return (
    <Card>
      <CardHeader
        title="مستندات و پیوست‌ها"
        subtitle={data ? `${faDigits(items.length)} فایل · حداکثر ${formatBytes(data.maxBytes)} برای هر فایل` : 'تصویر، PDF یا متن ساده'}
        icon={<Paperclip size={18} />}
        action={
          canWrite ? (
            <div>
              <input
                ref={inputRef}
                type="file"
                className="hidden"
                accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain"
                onChange={(e) => upload(e.target.files?.[0])}
              />
              <button type="button" className="btn-soft btn-xs" onClick={() => inputRef.current?.click()} disabled={busy}>
                <Upload size={13} />
                {busy ? 'در حال بارگذاری…' : 'افزودن پیوست'}
              </button>
            </div>
          ) : null
        }
      />
      {loading && !data ? (
        <div className="mt-4 skeleton h-16" />
      ) : error && !data ? (
        <ErrorState message={error} onRetry={refresh} />
      ) : items.length === 0 ? (
        <EmptyState title="پیوستی ثبت نشده" description="برای مستندسازی نصب، عکس تجهیز یا فایل PDF راهنما را بارگذاری کنید." icon={<Paperclip size={20} />} />
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((att) => (
            <div key={att.id} className="overflow-hidden rounded-soft border border-ink-200 bg-white/70">
              {att.kind === 'image' ? (
                <button type="button" className="block h-28 w-full overflow-hidden bg-ink-100" onClick={() => setPreview(att)} aria-label={`نمایش ${att.fileName}`}>
                  <img src={att.downloadUrl} alt={att.fileName} className="h-full w-full object-cover" loading="lazy" />
                </button>
              ) : null}
              <div className="p-2.5">
                <p className="flex items-center gap-1 truncate text-[11.5px] font-medium text-ink-700">
                  {att.kind === 'image' ? <ImageIcon size={12} /> : <Paperclip size={12} />}
                  {att.fileName}
                </p>
                <p className="mt-0.5 text-[10px] text-ink-400">
                  {formatBytes(att.sizeBytes)} · {att.uploadedBy || '—'} · {fmtRelative(att.createdAt)}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  {att.kind === 'image' ? (
                    <button type="button" className="btn-ghost btn-xs" onClick={() => setPreview(att)}>
                      <Eye size={12} /> نمایش
                    </button>
                  ) : null}
                  <a className="btn-ghost btn-xs" href={att.downloadUrl} target="_blank" rel="noreferrer">
                    <FileDown size={12} /> دانلود
                  </a>
                  {canWrite ? (
                    <button type="button" className="btn-ghost btn-xs ms-auto text-red-600" onClick={() => remove(att)}>
                      <Trash2 size={12} />
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <Modal open={!!preview} onClose={() => setPreview(null)} size="xl" title={preview?.fileName ?? 'پیش‌نمایش تصویر'} subtitle="تصویر پیوست تجهیز">
        {preview ? (
          <div className="grid place-items-center rounded-soft bg-ink-900/5 p-2">
            <img src={preview.downloadUrl} alt={preview.fileName} className="max-h-[70vh] w-auto max-w-full rounded object-contain" />
          </div>
        ) : null}
      </Modal>
    </Card>
  );
}

/* ------------------------------ helpers ------------------------------ */
function MiniStat({ label, value, hint, icon, tone = 'text-ink-700' }: { label: string; value: React.ReactNode; hint?: string; icon?: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-soft border border-white/70 bg-white/70 p-3 backdrop-blur">
      <div className="flex items-center gap-1.5 text-[10.5px] text-ink-400">
        {icon}
        {label}
      </div>
      <p className={`mt-1 text-[14px] font-semibold ${tone}`}>{value}</p>
      {hint ? <p className="num mt-0.5 text-[10px] text-ink-400">{hint}</p> : null}
    </div>
  );
}

function InfoRow({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5">
      <dt className="shrink-0 text-[11.5px] text-ink-400">{label}</dt>
      <dd className="min-w-0 text-left text-[12.5px] font-medium text-ink-700">
        {value}
        {sub ? <span className="mt-0.5 block text-[10.5px] font-normal text-ink-400">{sub}</span> : null}
      </dd>
    </div>
  );
}

function MetricBox({ label, value, tone = 'text-ink-800', small }: { label: string; value: React.ReactNode; tone?: string; small?: boolean }) {
  return (
    <div className="rounded-soft border border-ink-200/70 bg-white/70 px-3 py-2.5">
      <p className="text-[10.5px] text-ink-400">{label}</p>
      <p className={`mt-1 font-semibold ${small ? 'text-[11.5px]' : 'num text-[15px]'} ${tone}`}>{value}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-ink-400">{label}</span>
      <span className="num font-medium text-ink-700">{value}</span>
    </div>
  );
}

function SeriesCard({
  title,
  subtitle,
  icon,
  ranges,
  defaultRange,
  deviceId,
  threshold,
  tzOffset,
  render,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  ranges: ChartRange[];
  defaultRange: ChartRange;
  deviceId: string;
  threshold?: number | null;
  tzOffset: number;
  render: (series: Series) => React.ReactNode;
}) {
  const [range, setRange] = useState<ChartRange>(defaultRange);
  const { data, loading, error, refresh } = useAsync<Series>((signal) => api.series(deviceId, range, signal), [deviceId, range], {
    interval: range === '1h' || range === '6h' ? 60000 : 180000,
  });

  const stats = useMemo(() => {
    if (!data?.points?.length) return null;
    const rtts = data.points.map((p) => p.rtt).filter((v): v is number => v != null);
    const avg = rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null;
    const avail = data.points.reduce((a, b) => a + b.availability, 0) / data.points.length;
    return { avg, avail, count: data.points.length };
  }, [data]);

  const rangeLabels: Record<ChartRange, string> = { '1h': '۱ ساعت', '6h': '۶ ساعت', '24h': '۲۴ ساعت', '7d': '۷ روز', '30d': '۳۰ روز' };

  return (
    <Card>
      <CardHeader
        title={title}
        subtitle={subtitle}
        icon={icon}
        action={<Tabs size="sm" value={range} onChange={setRange} tabs={ranges.map((r) => ({ value: r, label: rangeLabels[r] }))} />}
      />
      <div className="mt-3">
        {loading && !data ? (
          <div className="skeleton h-[250px]" />
        ) : error && !data ? (
          <ErrorState message={error} onRetry={refresh} />
        ) : !data?.points?.length ? (
          <EmptyState title="داده‌ای برای این بازه ثبت نشده" description="بازه دیگری را انتخاب کنید یا منتظر ثبت نمونه‌های جدید توسط موتور مانیتورینگ بمانید." icon={<Gauge size={22} />} />
        ) : (
          render(data)
        )}
      </div>
      {stats ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-ink-100 pt-3 text-[11px] text-ink-500">
          <span>
            میانگین تأخیر: <span className="num font-medium text-ink-700">{fmtMs(stats.avg)}</span>
          </span>
          <span>
            دسترس‌پذیری بازه: <span className="num font-medium text-ink-700">{fmtPct(stats.avail, 2)}</span>
          </span>
          <span>
            تعداد بازه‌ها: <span className="num font-medium text-ink-700">{faDigits(stats.count)}</span>
          </span>
          {threshold ? (
            <span className="ms-auto inline-flex items-center gap-1.5">
              <span className="h-0.5 w-5 rounded" style={{ background: '#f59e0b' }} />
              آستانه {faDigits(threshold)} ms
            </span>
          ) : null}
        </div>
      ) : null}
      {stats && data ? (
        <div className="mt-2">
          <Progress value={stats.avail} color={stats.avail >= 99 ? '#16a34a' : stats.avail >= 95 ? '#f59e0b' : '#dc2626'} height={4} />
        </div>
      ) : null}
    </Card>
  );
}
