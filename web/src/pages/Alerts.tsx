import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  Bell,
  BellOff,
  Check,
  CheckCheck,
  Clock,
  Info,
  Layers,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  TrendingDown,
  TriangleAlert,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { api } from '../lib/api';
import { useApp, useAsync, useLive, useToast } from '../lib/store';
import { useAuth } from '../lib/auth';
import { ALERT_KIND_LABEL, faDigits, fmtDateTime, fmtDuration, fmtNumber, fmtRelative, SEVERITY_META, statusMeta } from '../lib/format';
import { Badge, Card, CardHeader, EmptyState, ErrorState, Field, Modal, PageLoader, Pagination, StatCard, Tabs, Toggle } from '../components/ui';
import { FlapChart, OutageGantt, SimultaneousChart, TopBarList } from '../components/charts';
import type { Alert, AlertRule } from '../lib/types';

const STATUS_TABS = [
  { value: 'active', label: 'فعال' },
  { value: 'acknowledged', label: 'بررسی‌شده' },
  { value: 'resolved', label: 'رفع‌شده' },
  { value: 'suppressed', label: 'سکوت‌شده' },
  { value: 'all', label: 'همه' },
];

type Section = 'alerts' | 'flaps' | 'simultaneous' | 'timeline' | 'top';

const RANGE_TABS = [
  { value: '6', label: '۶ ساعت' },
  { value: '24', label: '۲۴ ساعت' },
  { value: '72', label: '۳ روز' },
  { value: '168', label: '۷ روز' },
];

export default function Alerts() {
  const { settings, meta, tzOffset, saveSettings } = useApp();
  const { push } = useToast();
  const live = useLive();
  const groups = meta?.groups ?? [];

  const [section, setSection] = useState<Section>('alerts');
  const [hours, setHours] = useState(24);

  const [status, setStatus] = useState('active');
  const [severity, setSeverity] = useState('all');
  const [kind, setKind] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number[]>([]);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [ruleEditing, setRuleEditing] = useState<AlertRule | null>(null);
  const [acting, setActing] = useState(false);

  const { data, loading, error, refresh } = useAsync(
    (signal) => api.alerts({ status, severity, kind, search, page, pageSize: 25 }, signal),
    [status, severity, kind, search, page],
    { interval: 25000 }
  );

  const { can } = useAuth();
  const canOperate = can('ops:write');

  useEffect(() => {
    if (live.version) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.version]);

  // پس از اتصال مجدد SSE، فهرست هشدارها دوباره خوانده می‌شود.
  const seenSync = useRef(live.syncToken);
  useEffect(() => {
    if (live.syncToken === seenSync.current) return;
    seenSync.current = live.syncToken;
    refresh();
  }, [live.syncToken, refresh]);

  const { data: rulesData, refresh: refreshRules } = useAsync((signal) => api.alertRules(signal), []);
  const { data: flaps, loading: flapsLoading } = useAsync((signal) => api.flaps({ hours }, signal), [hours, section], { enabled: section === 'flaps', interval: 30000 });
  const { data: sim } = useAsync((signal) => api.simultaneous({ hours }, signal), [hours, section], { enabled: section === 'simultaneous', interval: 30000 });
  const { data: timeline } = useAsync((signal) => api.outageTimeline({ hours }, signal), [hours, section], { enabled: section === 'timeline', interval: 60000 });
  const { data: top } = useAsync((signal) => api.topOutageDevices({ days: 7 }, signal), [section], { enabled: section === 'top', interval: 60000 });

  const stats = data?.stats;

  const run = async (action: 'ack' | 'resolve', id?: number) => {
    if (acting) return;
    setActing(true);
    try {
      if (id) {
        if (action === 'ack') await api.ackAlert(id);
        else await api.resolveAlert(id);
      } else {
        await api.bulkAlerts(selected, action);
        setSelected([]);
      }
      push(action === 'ack' ? 'هشدار بررسی‌شده علامت خورد' : 'هشدار رفع‌شده علامت خورد', 'success');
      refresh();
    } catch (e) {
      push((e as Error).message, 'error');
    } finally {
      setActing(false);
    }
  };

  const removeAlert = async (id: number) => {
    if (acting) return;
    if (!window.confirm('این هشدار حذف شود؟')) return;
    setActing(true);
    try {
      await api.bulkAlerts([id], 'delete');
      refresh();
    } catch (e) {
      push((e as Error).message, 'error');
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="هشدارهای فعال" value={fmtNumber(stats?.active ?? 0)} hint="نیازمند بررسی" tone="red" icon={<Bell size={20} />} />
        <StatCard label="بحرانی" value={fmtNumber(stats?.bySeverity?.critical ?? 0)} hint="اولویت بالا" tone="violet" icon={<TriangleAlert size={20} />} />
        <StatCard label="قطع‌های هم‌زمان" value={fmtNumber(sim?.overlapping ?? 0)} hint="بازه‌هایی با بیش از یک تجهیز قطع" tone="sun" icon={<Layers size={20} />} />
        <StatCard label="تجهیزات پرقطعی" value={fmtNumber(top?.items?.length ?? 0)} hint="دارای قطعی در ۷ روز گذشته" tone="brand" icon={<TrendingDown size={20} />} />
      </div>

      <Card padded={false} className="p-2">
        <div className="flex flex-wrap items-center gap-2">
          <Tabs
            value={section}
            onChange={(v) => setSection(v)}
            tabs={[
              { value: 'alerts', label: 'هشدارها', icon: <Bell size={14} />, count: stats?.active },
              { value: 'flaps', label: 'لاگ قطع و وصل', icon: <Activity size={14} /> },
              { value: 'simultaneous', label: 'قطعی‌های هم‌زمان', icon: <Layers size={14} /> },
              { value: 'timeline', label: 'خط زمانی قطعی', icon: <Clock size={14} /> },
              { value: 'top', label: 'تجهیزات پرقطعی', icon: <TrendingDown size={14} /> },
            ]}
          />
          {section !== 'alerts' && section !== 'top' ? (
            <Tabs
              size="sm"
              className="ms-auto"
              value={String(hours)}
              onChange={(v) => setHours(Number(v))}
              tabs={RANGE_TABS}
            />
          ) : null}
        </div>
      </Card>

      {section === 'alerts' ? (
        <>
          <Card padded={false} className="p-4">
            <div className="flex flex-wrap items-center gap-3">
              <Tabs
                value={status}
                onChange={(v) => {
                  setStatus(v);
                  setPage(1);
                }}
                tabs={STATUS_TABS.map((t) => ({
                  ...t,
                  count:
                    t.value === 'active'
                      ? stats?.active
                      : t.value === 'acknowledged'
                        ? stats?.acknowledged
                        : t.value === 'resolved'
                          ? stats?.resolved
                          : t.value === 'suppressed'
                            ? stats?.suppressed
                            : undefined,
                }))}
              />
              <div className="relative min-w-[180px] flex-1">
                <Search size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-400" />
                <input
                  className="field !rounded-pill pr-9"
                  placeholder="جست‌وجو در عنوان، پیام یا تجهیز…"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                />
              </div>
              <select className="field !w-auto !rounded-pill" value={severity} onChange={(e) => setSeverity(e.target.value)}>
                <option value="all">همه سطوح اهمیت</option>
                <option value="critical">بحرانی</option>
                <option value="warning">هشدار</option>
                <option value="info">اطلاع</option>
              </select>
              <select className="field !w-auto !rounded-pill" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="all">همه انواع</option>
                {Object.entries(ALERT_KIND_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              <button type="button" className="btn-ghost btn-xs" onClick={refresh}>
                <RefreshCw size={14} />
              </button>
              {canOperate ? (
                <button type="button" className="btn-soft btn-xs" onClick={() => setRulesOpen(true)}>
                  <Settings2 size={14} />
                  قوانین هشدار
                </button>
              ) : null}
            </div>
          </Card>

          {canOperate && selected.length > 0 ? (
            <div className="animate-fade-up rounded-card border border-brand-100 bg-white/95 p-3 shadow-pop">
              <div className="flex flex-wrap items-center gap-2">
                <span className="chip border-brand-200 bg-brand-50 text-brand-700">{faDigits(selected.length)} هشدار انتخاب شده</span>
                <button type="button" className="btn-ghost btn-xs" onClick={() => run('ack')}>
                  <Check size={13} />
                  بررسی‌شده
                </button>
                <button type="button" className="btn-ghost btn-xs" onClick={() => run('resolve')}>
                  <CheckCheck size={13} />
                  رفع‌شده
                </button>
                <button
                  type="button"
                  className="btn-danger btn-xs"
                  onClick={async () => {
                    if (!window.confirm(`حذف ${selected.length} هشدار؟`)) return;
                    await api.bulkAlerts(selected, 'delete');
                    setSelected([]);
                    refresh();
                  }}
                >
                  <Trash2 size={13} />
                  حذف
                </button>
                <button type="button" className="btn-ghost btn-xs ms-auto" onClick={() => setSelected([])}>
                  لغو انتخاب
                </button>
              </div>
            </div>
          ) : null}

          {loading && !data ? (
            <PageLoader label="در حال دریافت هشدارها…" />
          ) : error && !data ? (
            <ErrorState message={error} onRetry={refresh} />
          ) : !data?.items?.length ? (
            <EmptyState
              title="هشداری با این فیلترها یافت نشد"
              description="سیستم هشدار به‌صورت خودکار برای قطع و وصل شدن تجهیزات، تأخیر بالا و افت بسته هشدار ثبت می‌کند."
              icon={<ShieldCheck size={22} />}
            />
          ) : (
            <div className="space-y-3">
              {data.items.map((a) => (
                <AlertRow
                  key={a.id}
                  alert={a}
                  tzOffset={tzOffset}
                  selected={selected.includes(a.id)}
                  onSelect={(v) => setSelected((s) => (v ? [...s, a.id] : s.filter((x) => x !== a.id)))}
                  canOperate={canOperate}
                  onAck={() => run('ack', a.id)}
                  onResolve={() => run('resolve', a.id)}
                  onDelete={() => removeAlert(a.id)}
                />
              ))}
            </div>
          )}

          <Pagination page={data?.page ?? 1} pages={data?.pages ?? 1} total={data?.total ?? 0} pageSize={data?.pageSize ?? 25} onPage={setPage} />

          <Card>
            <CardHeader title="تنظیمات هشدار و سکوت" subtitle="پاسخ‌دهی به هشدارها و بازه‌های زمانی سکوت" icon={<BellOff size={18} />} />
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Toggle checked={!!settings?.alerting_enabled} onChange={(v) => saveSettings({ alerting_enabled: v })} label="سیستم هشدار فعال است" hint="در صورت غیرفعال بودن هیچ هشدار جدیدی ثبت نمی‌شود" />
              <Toggle checked={!!settings?.suppression_enabled} onChange={(v) => saveSettings({ suppression_enabled: v })} label="بازه سکوت فعال است" hint="قوانین با گزینه «سکوت در بازه» در این زمان ثبت نمی‌شوند" />
              <Field label="فاصله ضد تکرار (ثانیه)" hint="جلوگیری از ثبت هشدار تکراری برای یک تجهیز">
                <input type="number" dir="ltr" className="field num" value={settings?.alert_cooldown ?? 600} onChange={(e) => saveSettings({ alert_cooldown: Number(e.target.value) || 0 })} />
              </Field>
              <Field label="تأخیر ثبت هشدار (ثانیه)" hint="اگر وضعیت پیش از پایان این مدت عادی شود، هشدار ثبت نمی‌شود؛ اگر برای قانونی «مدت تداوم» بزرگ‌تری تنظیم شده باشد، همان اعمال می‌شود">
                <input type="number" min={0} dir="ltr" className="field num" value={settings?.alert_delay ?? 0} onChange={(e) => saveSettings({ alert_delay: Math.max(0, Number(e.target.value) || 0) })} />
              </Field>
              <Field label="شروع بازه سکوت">
                <input type="time" dir="ltr" className="field num" value={settings?.suppression_start ?? '23:00'} onChange={(e) => saveSettings({ suppression_start: e.target.value })} />
              </Field>
              <Field label="پایان بازه سکوت">
                <input type="time" dir="ltr" className="field num" value={settings?.suppression_end ?? '06:00'} onChange={(e) => saveSettings({ suppression_end: e.target.value })} />
              </Field>
            </div>
          </Card>
        </>
      ) : null}

      {section === 'flaps' ? (
        <>
          <Card>
            <CardHeader
              title="نمودار قطع و وصل شدن تجهیزات"
              subtitle={`تعداد قطع‌ها و بازگشت‌ها در بازه‌های زمانی — ${faDigits(flaps?.series?.length ?? 0)} بازه`}
              icon={<Activity size={18} />}
            />
            <div className="mt-3">
              {flaps?.series?.length ? (
                <FlapChart series={flaps.series} range={`${hours}h`} tzOffset={tzOffset} />
              ) : (
                <p className="py-10 text-center text-xs text-ink-400">{flapsLoading ? 'در حال محاسبه…' : 'رویدادی در این بازه ثبت نشده است'}</p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="لاگ قطع و وصل" subtitle="آخرین رویدادهای ثبت‌شده برای تجهیزات" icon={<Clock size={18} />} />
            <div className="mt-3">
              {!flaps?.items?.length ? (
                <EmptyState title="رویدادی در این بازه نیست" description="بازه زمانی دیگری را انتخاب کنید." icon={<Activity size={22} />} />
              ) : (
                <div className="max-h-[560px] overflow-y-auto">
                  <div className="space-y-1.5">
                    {flaps.items.map((ev) => (
                      <div key={ev.id} className="flex items-center gap-3 rounded-soft border border-ink-100 bg-white/70 px-3 py-2">
                        <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border ${ev.kind === 'down' ? 'border-red-200 bg-red-50 text-red-600' : 'border-emerald-200 bg-emerald-50 text-emerald-600'}`}>
                          {ev.kind === 'down' ? <WifiOff size={13} /> : <Wifi size={13} />}
                        </span>
                        <Link to={`/devices/${ev.deviceId}`} className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px] font-medium text-ink-700 hover:text-brand-700">{ev.deviceName}</span>
                          <span className="num block text-[10.5px] text-ink-400">{ev.deviceIp}</span>
                        </Link>
                        <span className="hidden text-[11px] text-ink-500 sm:block">{ev.cause}</span>
                        {ev.kind === 'up' && ev.durationSec != null ? <span className="num text-[11px] text-ink-400">مدت: {fmtDuration(ev.durationSec)}</span> : null}
                        <span className="num shrink-0 text-[11px] text-ink-400">{fmtDateTime(ev.ts, tzOffset)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Card>
        </>
      ) : null}

      {section === 'simultaneous' ? (
        <>
          <Card>
            <CardHeader
              title="نمودار قطعی‌های هم‌زمان"
              subtitle="تعداد تجهیزاتی که در هر بازه هم‌زمان قطع بوده‌اند — برای تشخیص مشکل مشترک"
              icon={<Layers size={18} />}
            />
            <div className="mt-3">
              {sim?.series?.length ? (
                <SimultaneousChart series={sim.series} range={`${hours}h`} tzOffset={tzOffset} />
              ) : (
                <p className="py-10 text-center text-xs text-ink-400">داده‌ای در این بازه وجود ندارد</p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="بازه‌های قطعی هم‌زمان" subtitle={`${faDigits(sim?.overlapping ?? 0)} بازه با بیش از یک تجهیز قطع`} icon={<Activity size={18} />} />
            <div className="mt-3 space-y-2">
              {!sim?.items?.length ? (
                <EmptyState title="قطعی هم‌زمانی یافت نشد" description="در این بازه هیچ دو تجهیزی هم‌زمان قطع نبوده‌اند." icon={<Layers size={22} />} />
              ) : (
                sim.items.map((c, i) => (
                  <div key={i} className="rounded-soft border border-ink-200 bg-white/70 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex items-center gap-2 text-[12.5px] font-semibold text-ink-700">
                        <span className="num rounded-pill bg-violet-50 px-2 py-0.5 text-[11px] text-violet-700">{faDigits(c.count)} تجهیز</span>
                        {fmtDateTime(c.start, tzOffset)}
                      </span>
                      <span className="num text-[11.5px] text-ink-500">مدت: {fmtDuration(c.durationSec)}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {c.devices.map((d) => (
                        <Link key={d.id} to={`/devices/${d.id}`} className="chip border-ink-200 bg-ink-50 text-ink-600 hover:border-brand-200">
                          {d.name}
                        </Link>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>
        </>
      ) : null}

      {section === 'timeline' ? (
        <Card>
          <CardHeader title="خط زمانی قطعی‌ها" subtitle={`${faDigits(timeline?.total ?? 0)} قطعی در بازه انتخابی`} icon={<Clock size={18} />} />
          <div className="mt-4">
            {!timeline?.devices?.length ? (
              <EmptyState title="قطعی‌ای در این بازه نیست" description="بازه زمانی دیگری را انتخاب کنید." icon={<Clock size={22} />} />
            ) : (
              <OutageGantt devices={timeline.devices} from={timeline.from} to={timeline.to} />
            )}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-ink-100 pt-3 text-[11px] text-ink-500">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-4 rounded-sm" style={{ background: '#f59e0b' }} />
              قطعی پایان‌یافته
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-4 rounded-sm" style={{ background: '#dc2626' }} />
              قطعی در جریان
            </span>
          </div>
        </Card>
      ) : null}

      {section === 'top' ? (
        <div className="grid gap-5 xl:grid-cols-2">
          <Card>
            <CardHeader title="تجهیزات با بیشترین تعداد قطعی" subtitle="۷ روز گذشته" icon={<TrendingDown size={18} />} />
            <div className="mt-3">
              <TopBarList
                items={(top?.items ?? []) as unknown as Record<string, unknown>[]}
                valueKey="outages"
                color="#dc2626"
                max={20}
                formatter={(v) => `${faDigits(v)} قطعی`}
              />
            </div>
          </Card>
          <Card>
            <CardHeader title="تجهیزات با بیشترین مدت قطعی" subtitle="مجموع مدت قطعی در ۷ روز گذشته" icon={<Clock size={18} />} />
            <div className="mt-3">
              <TopBarList
                items={[...(top?.items ?? [])].sort((a, b) => b.downtimeSec - a.downtimeSec) as unknown as Record<string, unknown>[]}
                valueKey="downtimeSec"
                color="#f59e0b"
                max={20}
                formatter={(v) => fmtDuration(v)}
              />
            </div>
          </Card>
          <Card className="xl:col-span-2">
            <CardHeader title="فهرست جزئیات" subtitle="تعداد قطعی، مدت قطعی و آخرین قطعی هر تجهیز" icon={<Activity size={18} />} />
            <div className="mt-3">
              {!top?.items?.length ? (
                <EmptyState title="قطعی‌ای ثبت نشده است" description="در ۷ روز گذشته هیچ قطعی‌ای برای تجهیزات ثبت نشده." icon={<ShieldCheck size={22} />} />
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>تجهیز</th>
                        <th>گروه</th>
                        <th>وضعیت</th>
                        <th>تعداد قطعی</th>
                        <th>مجموع مدت قطعی</th>
                        <th>آخرین قطعی</th>
                      </tr>
                    </thead>
                    <tbody>
                      {top.items.map((d) => (
                        <tr key={d.id}>
                          <td>
                            <Link to={`/devices/${d.id}`} className="font-medium text-ink-800 hover:text-brand-700">
                              {d.name}
                            </Link>
                            <span className="num block text-[10.5px] text-ink-400">{d.ip}</span>
                          </td>
                          <td>{d.groupName ? <span className="chip" style={{ borderColor: `${d.groupColor}44`, background: `${d.groupColor}12`, color: d.groupColor ?? undefined }}>{d.groupName}</span> : '—'}</td>
                          <td>
                            <span className={`chip ${statusMeta(d.status).bg} ${statusMeta(d.status).text} ${statusMeta(d.status).border}`}>{statusMeta(d.status).label}</span>
                          </td>
                          <td className="num font-semibold text-red-600">{fmtNumber(d.outages)}</td>
                          <td className="num">{fmtDuration(d.downtimeSec)}</td>
                          <td className="text-[11.5px] text-ink-500">{d.lastOutageAt ? fmtDateTime(d.lastOutageAt, tzOffset) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Card>
        </div>
      ) : null}

      <Modal
        open={rulesOpen}
        onClose={() => {
          setRulesOpen(false);
          setRuleEditing(null);
        }}
        size="lg"
        title="قوانین هشدار"
        subtitle="تعریف شرایط ایجاد هشدار، سطح اهمیت، تأخیر و ضد تکرار"
        footer={
          <button type="button" className="btn-ghost" onClick={() => setRulesOpen(false)}>
            بستن
          </button>
        }
      >
        <div className="space-y-3">
          <button
            type="button"
            className="btn-soft btn-xs"
            onClick={() =>
              setRuleEditing({
                id: 0,
                name: '',
                enabled: 1,
                metric: 'offline',
                comparator: 'gte',
                threshold: 1,
                duration_sec: 0,
                severity: 'critical',
                scope_group_id: null,
                cooldown_sec: 600,
                apply_to_unmon: 0,
                silent: 0,
              })
            }
          >
            <Plus size={13} />
            قانون جدید
          </button>

          {(rulesData?.items ?? []).map((r) => (
            <div key={r.id} className="rounded-soft border border-ink-200 bg-white/80 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[12.5px] font-semibold text-ink-700">{r.name}</p>
                  <p className="mt-1 text-[11px] text-ink-500">{ruleDescription(r)}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={r.severity === 'critical' ? 'red' : r.severity === 'warning' ? 'sun' : 'brand'}>{SEVERITY_META[r.severity].label}</Badge>
                  <Toggle
                    checked={!!r.enabled}
                    onChange={async (v) => {
                      await api.updateRule(r.id, { ...r, enabled: v ? 1 : 0 });
                      refreshRules();
                    }}
                    label={r.enabled ? 'فعال' : 'غیرفعال'}
                  />
                  <button type="button" className="btn-ghost btn-xs" onClick={() => setRuleEditing(r)}>
                    ویرایش
                  </button>
                  <button
                    type="button"
                    className="btn-danger btn-xs"
                    onClick={async () => {
                      if (!window.confirm(`حذف قانون «${r.name}»؟`)) return;
                      try {
                        await api.deleteRule(r.id);
                        refreshRules();
                      } catch (e) {
                        push((e as Error).message, 'error');
                      }
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Modal>

      {ruleEditing ? (
        <RuleForm
          rule={ruleEditing.id ? ruleEditing : null}
          draft={ruleEditing}
          groups={groups}
          onClose={() => setRuleEditing(null)}
          onSaved={() => {
            setRuleEditing(null);
            refreshRules();
          }}
        />
      ) : null}
    </div>
  );
}

function ruleDescription(r: AlertRule) {
  const metric = { offline: 'قطع دسترسی', latency: 'تأخیر', loss: 'افت بسته', recovery: 'بازگشت به حالت عادی' }[r.metric];
  const comparator = r.comparator === 'gte' ? 'بیشتر یا مساوی' : r.comparator === 'lte' ? 'کمتر یا مساوی' : 'برابر';
  const parts = [`متریک ${metric}`];
  if (r.metric !== 'offline' && r.metric !== 'recovery') parts.push(`${comparator} ${faDigits(r.threshold)}`);
  if (r.duration_sec) parts.push(`پس از ${faDigits(r.duration_sec)} ثانیه تداوم`);
  if (r.scope_group_id) parts.push(`فقط گروه ${r.groupName ?? r.scope_group_id}`);
  parts.push(`ضد تکرار ${faDigits(r.cooldown_sec)} ثانیه`);
  if (r.silent) parts.push('در بازه سکوت ثبت نشود');
  return parts.join(' · ');
}

function AlertRow({
  alert,
  tzOffset,
  selected,
  canOperate,
  onSelect,
  onAck,
  onResolve,
  onDelete,
}: {
  alert: Alert;
  tzOffset: number;
  selected: boolean;
  canOperate: boolean;
  onSelect: (v: boolean) => void;
  onAck: () => void;
  onResolve: () => void;
  onDelete: () => void;
}) {
  const sev = SEVERITY_META[alert.severity] ?? SEVERITY_META.info;
  const statusLabel: Record<string, string> = { active: 'فعال', acknowledged: 'بررسی‌شده', resolved: 'رفع‌شده', suppressed: 'سکوت‌شده' };
  return (
    <div className={`card p-4 transition-all ${selected ? 'ring-2 ring-brand-400/60' : ''}`}>
      <div className="flex items-start gap-3">
        {canOperate ? (
          <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} className="mt-1 accent-brand-600" />
        ) : null}
        <span className={`mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-soft border ${sev.bg} ${sev.border} ${sev.text}`}>
          {alert.kind === 'recovery' ? <ShieldCheck size={15} /> : alert.severity === 'info' ? <Info size={15} /> : <TriangleAlert size={15} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[13px] font-semibold text-ink-800">{alert.title}</p>
            <Badge className={`${sev.bg} ${sev.text} ${sev.border}`}>{sev.label}</Badge>
            <Badge tone="ink">{ALERT_KIND_LABEL[alert.kind] ?? alert.kind}</Badge>
            <Badge tone={alert.status === 'active' ? 'red' : alert.status === 'resolved' ? 'emerald' : 'sun'}>{statusLabel[alert.status] ?? alert.status}</Badge>
            {alert.ruleName ? <span className="text-[10.5px] text-ink-400">قانون: {alert.ruleName}</span> : null}
          </div>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-500">{alert.message}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] text-ink-400">
            <span className="inline-flex items-center gap-1">
              <Clock size={11} />
              {fmtDateTime(alert.createdAt, tzOffset)} ({fmtRelative(alert.createdAt)})
            </span>
            {alert.deviceId ? (
              <Link to={`/devices/${alert.deviceId}`} className="num text-brand-600 hover:underline">
                {alert.deviceName} — {alert.deviceIp}
              </Link>
            ) : null}
            {alert.acknowledgedAt ? <span>بررسی‌شده در {fmtDateTime(alert.acknowledgedAt, tzOffset)}</span> : null}
            {alert.resolvedAt ? <span>رفع‌شده در {fmtDateTime(alert.resolvedAt, tzOffset)}</span> : null}
          </div>
        </div>
        {canOperate ? (
          <div className="flex shrink-0 flex-col gap-1.5">
            {alert.status === 'active' ? (
              <button type="button" className="btn-ghost btn-xs" onClick={onAck}>
                <Check size={13} />
                بررسی‌شد
              </button>
            ) : null}
            {alert.status !== 'resolved' ? (
              <button type="button" className="btn-ghost btn-xs" onClick={onResolve}>
                <CheckCheck size={13} />
                رفع شد
              </button>
            ) : null}
            <button type="button" className="btn-ghost btn-xs" onClick={onDelete}>
              <Trash2 size={13} />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RuleForm({
  rule,
  draft,
  groups,
  onClose,
  onSaved,
}: {
  rule: AlertRule | null;
  draft: AlertRule;
  groups: { id: number; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { push } = useToast();
  const [form, setForm] = useState<AlertRule>(draft);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof AlertRule>(k: K, v: AlertRule[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!form.name.trim()) return setError('نام قانون الزامی است');
    try {
      if (rule) await api.updateRule(rule.id, form);
      else await api.createRule(form);
      push(rule ? 'قانون به‌روزرسانی شد' : 'قانون جدید ساخته شد', 'success');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={rule ? `ویرایش قانون — ${rule.name}` : 'قانون هشدار جدید'}
      subtitle="شرایط ایجاد هشدار و رفتار آن را مشخص کنید"
      footer={
        <>
          {error ? <p className="me-auto text-xs text-red-600">{error}</p> : null}
          <button type="button" className="btn-ghost" onClick={onClose}>
            انصراف
          </button>
          <button type="button" className="btn-primary" onClick={submit}>
            ذخیره قانون
          </button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="نام قانون" required className="sm:col-span-2">
          <input className="field" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="مثلاً قطع دسترسی تجهیز" />
        </Field>
        <Field label="متریک پایش">
          <select className="field" value={form.metric} onChange={(e) => set('metric', e.target.value as AlertRule['metric'])}>
            <option value="offline">قطع دسترسی تجهیز</option>
            <option value="latency">تأخیر (میلی‌ثانیه)</option>
            <option value="loss">افت بسته (٪)</option>
            <option value="recovery">بازگشت به حالت عادی</option>
          </select>
        </Field>
        <Field label="سطح اهمیت">
          <select className="field" value={form.severity} onChange={(e) => set('severity', e.target.value as AlertRule['severity'])}>
            <option value="critical">بحرانی</option>
            <option value="warning">هشدار</option>
            <option value="info">اطلاع</option>
          </select>
        </Field>
        <Field label="عملگر مقایسه">
          <select className="field" value={form.comparator} onChange={(e) => set('comparator', e.target.value)}>
            <option value="gte">بیشتر یا مساوی</option>
            <option value="lte">کمتر یا مساوی</option>
            <option value="eq">برابر</option>
          </select>
        </Field>
        <Field label="مقدار آستانه" hint="برای متریک قطع دسترسی، تعداد شکست متوالی">
          <input type="number" dir="ltr" className="field num" value={form.threshold} onChange={(e) => set('threshold', Number(e.target.value))} />
        </Field>
        <Field label="تأخیر قبل از ثبت هشدار (ثانیه)" hint="برای جلوگیری از هشدارهای زودگذر">
          <input type="number" dir="ltr" className="field num" value={form.duration_sec} onChange={(e) => set('duration_sec', Number(e.target.value))} />
        </Field>
        <Field label="فاصله ضد تکرار (ثانیه)">
          <input type="number" dir="ltr" className="field num" value={form.cooldown_sec} onChange={(e) => set('cooldown_sec', Number(e.target.value))} />
        </Field>
        <Field label="محدوده گروه" hint="خالی = همه گروه‌ها">
          <select className="field" value={form.scope_group_id ?? ''} onChange={(e) => set('scope_group_id', e.target.value ? Number(e.target.value) : null)}>
            <option value="">همه گروه‌ها</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="sm:col-span-2 grid gap-3 sm:grid-cols-2">
          <Toggle checked={!!form.enabled} onChange={(v) => set('enabled', v ? 1 : 0)} label="قانون فعال است" />
          <Toggle checked={!!form.silent} onChange={(v) => set('silent', v ? 1 : 0)} label="در بازه سکوت ثبت نشود" hint="هشدار با وضعیت سکوت‌شده ذخیره می‌شود" />
        </div>
      </div>
    </Modal>
  );
}
