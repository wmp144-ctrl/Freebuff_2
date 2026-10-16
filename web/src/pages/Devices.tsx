import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowUpDown,
  Download,
  Edit3,
  Eye,
  Filter,
  Grid2X2,
  Layers,
  List,
  MapPin,
  Power,
  RefreshCw,
  Search,
  Server,
  Tag as TagIcon,
  Trash2,
  Upload,
  Wifi,
  X,
} from 'lucide-react';
import { api, downloadUrl } from '../lib/api';
import { useApp, useAsync, useDeviceLive, useToast } from '../lib/store';
import { faDigits, fmtMs, fmtNumber, fmtPct, fmtRelative, PRIORITY_META, statusMeta } from '../lib/format';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  PageLoader,
  Pagination,
  StatusPill,
} from '../components/ui';
import { MiniSpark } from '../components/charts';
import DeviceForm from '../features/DeviceForm';
import ImportDialog from '../features/ImportDialog';
import type { Device, Paged, Priority } from '../lib/types';

type ViewMode = 'cards' | 'table';

const STATUS_OPTIONS = [
  { value: '', label: 'همه وضعیت‌ها' },
  { value: 'online', label: 'در دسترس' },
  { value: 'warning', label: 'دارای اختلال' },
  { value: 'offline', label: 'قطع‌شده' },
  { value: 'maintenance', label: 'در تعمیرات' },
  { value: 'unknown', label: 'نامشخص' },
];

const SORT_OPTIONS = [
  { value: 'name', label: 'نام' },
  { value: 'status', label: 'وضعیت' },
  { value: 'latency', label: 'آخرین تأخیر' },
  { value: 'avg_latency', label: 'میانگین تأخیر' },
  { value: 'loss', label: 'افت بسته' },
  { value: 'uptime', label: 'دسترس‌پذیری' },
  { value: 'last_check', label: 'آخرین بررسی' },
  { value: 'outages', label: 'تعداد قطعی' },
  { value: 'ip', label: 'آدرس IP' },
];

export default function Devices() {
  const [params, setParams] = useSearchParams();
  const { meta, refreshMeta } = useApp();
  const { push } = useToast();
  const navigate = useNavigate();

  const [view, setView] = useState<ViewMode>(() => (localStorage.getItem('nw.view') as ViewMode) || 'cards');
  const [selected, setSelected] = useState<number[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Device | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sparks, setSparks] = useState<Record<number, { t: number; rtt: number | null; loss: number }[]>>({});

  const query = useMemo(
    () => ({
      search: params.get('search') ?? '',
      group: params.get('group') ?? '',
      tag: params.get('tag') ?? '',
      status: params.get('status') ?? '',
      type: params.get('type') ?? '',
      priority: params.get('priority') ?? '',
      enabled: params.get('enabled') ?? '',
      sort: params.get('sort') ?? 'name',
      order: params.get('order') ?? 'asc',
      page: Number(params.get('page') ?? 1),
      pageSize: Number(params.get('pageSize') ?? (view === 'table' ? 25 : 12)),
      geo: params.get('geo') ?? '',
    }),
    [params, view]
  );

  const { data, loading, error, refresh } = useAsync<Paged<Device>>(
    () => api.devices(query as unknown as Record<string, string | number>),
    [JSON.stringify(query)],
    { interval: 30000 }
  );

  const devices = data?.items ?? [];

  useEffect(() => {
    localStorage.setItem('nw.view', view);
  }, [view]);

  useEffect(() => {
    setSelected([]);
  }, [JSON.stringify(query)]);

  // نمودار کوچک کارت‌ها: یک بار در هر دقیقه بازخوانی می‌شود
  const [sparkTick, setSparkTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSparkTick((t) => t + 1), 60000);
    return () => clearInterval(id);
  }, []);

  const deviceIds = devices.map((d) => d.id).join(',');
  useEffect(() => {
    if (!deviceIds || view !== 'cards') return;
    if (sparks[Number(deviceIds.split(',')[0])] && sparkTick === 0) return;
    let alive = true;
    api
      .sparklines(deviceIds.split(',').map(Number), '1h')
      .then((res) => {
        if (alive) setSparks(res.series);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceIds, view, sparkTick]);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  const activeFilters = [
    query.status ? { key: 'status', label: STATUS_OPTIONS.find((s) => s.value === query.status)?.label ?? query.status } : null,
    query.group ? { key: 'group', label: `گروه: ${query.group}` } : null,
    query.tag ? { key: 'tag', label: `تگ: ${query.tag}` } : null,
    query.type ? { key: 'type', label: `نوع: ${query.type}` } : null,
    query.priority ? { key: 'priority', label: `اولویت: ${PRIORITY_META[query.priority as Priority]?.label ?? query.priority}` } : null,
    query.enabled !== '' ? { key: 'enabled', label: query.enabled === '0' ? 'غیرفعال' : 'فعال' } : null,
    query.geo ? { key: 'geo', label: query.geo === 'with' ? 'دارای موقعیت' : 'بدون موقعیت' } : null,
  ].filter(Boolean) as { key: string; label: string }[];

  const toggleSelect = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const allSelected = devices.length > 0 && selected.length === devices.length;

  const runBulk = async (action: string, payload: Record<string, unknown> = {}, message?: string) => {
    if (!selected.length) return;
    setBusy(true);
    try {
      const res = await api.bulk(selected, action, payload);
      push(message ?? `${faDigits(res.affected ?? selected.length)} تجهیز به‌روزرسانی شد`, 'success');
      setSelected([]);
      refresh();
      refreshMeta();
    } catch (e) {
      push((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const quickPing = async (device: Device) => {
    try {
      const res = await api.pingDevice(device.id);
      const r = res.result;
      push(
        r.ok ? `${device.name} — پاسخ در ${fmtMs(r.rtt)} (${r.mode})` : `${device.name} — پاسخ نداد (${r.error ?? 'بدون پاسخ'})`,
        r.ok ? 'success' : 'error'
      );
      refresh();
    } catch (e) {
      push((e as Error).message, 'error');
    }
  };

  const removeDevice = async (device: Device) => {
    if (!window.confirm(`تجهیز «${device.name}» حذف شود؟ تمام تاریخچه و سوابق آن نیز حذف خواهد شد.`)) return;
    try {
      await api.deleteDevice(device.id);
      push('تجهیز حذف شد', 'success');
      refresh();
      refreshMeta();
    } catch (e) {
      push((e as Error).message, 'error');
    }
  };

  return (
    <div className="space-y-4">
      {/* نوار ابزار */}
      <Card padded={false} className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[210px] flex-1">
            <Search size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-400" />
            <input
              className="field !rounded-pill pr-9"
              placeholder="جست‌وجو در نام، IP، موقعیت، سازنده…"
              value={query.search}
              onChange={(e) => setParam('search', e.target.value)}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select className="field !w-auto !rounded-pill" value={query.status} onChange={(e) => setParam('status', e.target.value)}>
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <select className="field !w-auto !rounded-pill" value={query.group} onChange={(e) => setParam('group', e.target.value)}>
              <option value="">همه گروه‌ها</option>
              {(meta?.groups ?? []).map((g) => (
                <option key={g.id} value={g.name}>
                  {g.name}
                </option>
              ))}
            </select>
            <select className="field !w-auto !rounded-pill" value={query.tag} onChange={(e) => setParam('tag', e.target.value)}>
              <option value="">همه تگ‌ها</option>
              {(meta?.tags ?? []).map((t) => (
                <option key={t.id} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
            <select className="field !w-auto !rounded-pill" value={query.type} onChange={(e) => setParam('type', e.target.value)}>
              <option value="">همه انواع</option>
              {(meta?.types ?? []).map((t) => (
                <option key={t.value} value={t.value}>
                  {t.value} ({faDigits(t.count)})
                </option>
              ))}
            </select>
            <select className="field !w-auto !rounded-pill" value={query.priority} onChange={(e) => setParam('priority', e.target.value)}>
              <option value="">همه اولویت‌ها</option>
              {Object.entries(PRIORITY_META).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
            <select className="field !w-auto !rounded-pill" value={query.sort} onChange={(e) => setParam('sort', e.target.value)}>
              {SORT_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  مرتب‌سازی: {s.label}
                </option>
              ))}
            </select>
            <button type="button" className="btn-ghost btn-xs" onClick={() => setParam('order', query.order === 'asc' ? 'desc' : 'asc')}>
              <ArrowUpDown size={14} />
              {query.order === 'asc' ? 'صعودی' : 'نزولی'}
            </button>
          </div>

          <div className="ms-auto flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-soft bg-ink-100/70 p-1">
              <button
                type="button"
                onClick={() => setView('cards')}
                className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12px] font-medium transition ${
                  view === 'cards' ? 'bg-white text-brand-700 shadow-soft' : 'text-ink-500'
                }`}
              >
                <Grid2X2 size={14} />
                کارت
              </button>
              <button
                type="button"
                onClick={() => setView('table')}
                className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12px] font-medium transition ${
                  view === 'table' ? 'bg-white text-brand-700 shadow-soft' : 'text-ink-500'
                }`}
              >
                <List size={14} />
                جدول
              </button>
            </div>
            <button type="button" className="btn-ghost btn-xs" onClick={() => setImportOpen(true)}>
              <Upload size={14} />
              ورود گروهی
            </button>
            <div className="group relative">
              <button type="button" className="btn-ghost btn-xs">
                <Download size={14} />
                خروجی
              </button>
              <div className="invisible absolute left-0 z-30 mt-1 w-52 rounded-soft border border-ink-200 bg-white p-1.5 opacity-0 shadow-pop transition group-hover:visible group-hover:opacity-100">
                <a className="block rounded-lg px-3 py-2 text-[12px] text-ink-600 hover:bg-brand-50" href={downloadUrl('/devices/export', { format: 'xlsx' })}>
                  خروجی Excel از تجهیزات
                </a>
                <a className="block rounded-lg px-3 py-2 text-[12px] text-ink-600 hover:bg-brand-50" href={downloadUrl('/devices/export', { format: 'csv' })}>
                  خروجی CSV از تجهیزات
                </a>
                <a className="block rounded-lg px-3 py-2 text-[12px] text-ink-600 hover:bg-brand-50" href={downloadUrl('/devices/export/geo', { format: 'xlsx' })}>
                  خروجی مختصات جغرافیایی
                </a>
              </div>
            </div>
            <button
              type="button"
              className="btn-primary btn-xs"
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              <Server size={14} />
              افزودن تجهیز
            </button>
          </div>
        </div>

        {(activeFilters.length > 0 || query.search) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3">
            <span className="inline-flex items-center gap-1 text-[11px] text-ink-400">
              <Filter size={12} />
              فیلترهای فعال:
            </span>
            {activeFilters.map((f) => (
              <button key={f.key} type="button" className="chip border-brand-200 bg-brand-50 text-brand-700" onClick={() => setParam(f.key, '')}>
                {f.label}
                <X size={11} />
              </button>
            ))}
            <button
              type="button"
              className="text-[11px] text-ink-400 underline hover:text-red-500"
              onClick={() => setParams(new URLSearchParams(), { replace: true })}
            >
              پاک کردن همه
            </button>
            <span className="ms-auto text-[11px] text-ink-400">
              {faDigits(data?.total ?? 0)} تجهیز یافت شد
            </span>
          </div>
        )}
      </Card>

      {/* نوار عملیات گروهی */}
      {selected.length > 0 ? (
        <div className="sticky top-[68px] z-[700] animate-fade-up rounded-card border border-brand-100 bg-white/95 p-3 shadow-pop backdrop-blur">
          <div className="flex flex-wrap items-center gap-2">
            <span className="chip border-brand-200 bg-brand-50 text-brand-700">
              {faDigits(selected.length)} تجهیز انتخاب شده
            </span>
            <button type="button" className="btn-ghost btn-xs" disabled={busy} onClick={() => runBulk('ping', {}, 'Ping برای تجهیزات انتخاب‌شده در صف قرار گرفت')}>
              <Wifi size={13} />
              Ping
            </button>
            <button type="button" className="btn-ghost btn-xs" disabled={busy} onClick={() => runBulk('monitoring_on', {}, 'پایش تجهیزات فعال شد')}>
              <Power size={13} />
              فعال‌سازی پایش
            </button>
            <button type="button" className="btn-ghost btn-xs" disabled={busy} onClick={() => runBulk('monitoring_off', {}, 'پایش تجهیزات غیرفعال شد')}>
              <Power size={13} />
              غیرفعال‌سازی پایش
            </button>
            <button type="button" className="btn-ghost btn-xs" disabled={busy} onClick={() => runBulk('enable', {}, 'تجهیزات فعال شدند')}>
              فعال‌سازی تجهیز
            </button>
            <button type="button" className="btn-ghost btn-xs" disabled={busy} onClick={() => runBulk('disable', {}, 'تجهیزات غیرفعال شدند')}>
              غیرفعال‌سازی تجهیز
            </button>
            <select
              className="field !w-auto !py-1.5 text-xs"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) runBulk('group', { group: e.target.value }, 'گروه تجهیزات تغییر کرد');
                e.currentTarget.value = '';
              }}
            >
              <option value="">انتقال به گروه…</option>
              {(meta?.groups ?? []).map((g) => (
                <option key={g.id} value={g.name}>
                  {g.name}
                </option>
              ))}
            </select>
            <select
              className="field !w-auto !py-1.5 text-xs"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) runBulk('interval', { interval: e.target.value }, 'بازه بررسی به‌روزرسانی شد');
                e.currentTarget.value = '';
              }}
            >
              <option value="">بازه بررسی…</option>
              {[15, 30, 60, 120, 300, 600].map((i) => (
                <option key={i} value={i}>
                  {faDigits(i)} ثانیه
                </option>
              ))}
              <option value="">مقدار عمومی</option>
            </select>
            <button
              type="button"
              className="btn-danger btn-xs"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`حذف ${selected.length} تجهیز انتخاب‌شده؟ این عملیات بازگشت‌پذیر نیست.`)) runBulk('delete', {}, 'تجهیزات حذف شدند');
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

      {/* محتوا */}
      {loading && !data ? (
        <PageLoader label="در حال دریافت تجهیزات…" />
      ) : error && !data ? (
        <ErrorState message={error} onRetry={refresh} />
      ) : devices.length === 0 ? (
        <EmptyState
          title="تجهیزی با این فیلترها یافت نشد"
          description="فیلترها را تغییر دهید یا تجهیز جدیدی اضافه کنید. برای ورود گروهی می‌توانید از فایل Excel استفاده کنید."
          icon={<Server size={22} />}
          action={
            <div className="flex gap-2">
              <button type="button" className="btn-primary btn-xs" onClick={() => { setEditing(null); setFormOpen(true); }}>
                افزودن تجهیز
              </button>
              <button type="button" className="btn-ghost btn-xs" onClick={() => setImportOpen(true)}>
                ورود گروهی از فایل
              </button>
            </div>
          }
        />
      ) : view === 'cards' ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {devices.map((d, i) => (
            <DeviceCard
              key={d.id}
              device={d}
              spark={sparks[d.id] ?? []}
              selected={selected.includes(d.id)}
              onSelect={() => toggleSelect(d.id)}
              onPing={() => quickPing(d)}
              onEdit={() => {
                setEditing(d);
                setFormOpen(true);
              }}
              onDelete={() => removeDevice(d)}
              delay={i * 25}
            />
          ))}
        </div>
      ) : (
        <DeviceTable
          devices={devices}
          selected={selected}
          allSelected={allSelected}
          onToggleAll={() => setSelected(allSelected ? [] : devices.map((d) => d.id))}
          onToggle={toggleSelect}
          onPing={quickPing}
          onEdit={(d) => {
            setEditing(d);
            setFormOpen(true);
          }}
          onDelete={removeDevice}
          sort={query.sort}
          order={query.order}
          onSort={(key) => setParam('sort', key)}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <select
          className="field !w-auto !rounded-pill"
          value={String(query.pageSize)}
          onChange={(e) => setParam('pageSize', e.target.value)}
        >
          {[12, 24, 48, 96].map((n) => (
            <option key={n} value={n}>
              نمایش {faDigits(n)} مورد
            </option>
          ))}
        </select>
        <button type="button" className="btn-ghost btn-xs" onClick={refresh}>
          <RefreshCw size={13} />
          بروزرسانی فهرست
        </button>
      </div>

      <Pagination
        page={data?.page ?? 1}
        pages={data?.pages ?? 1}
        total={data?.total ?? 0}
        pageSize={data?.pageSize ?? query.pageSize}
        onPage={(p) => setParam('page', String(p))}
      />

      <DeviceForm
        open={formOpen}
        device={editing}
        onClose={() => setFormOpen(false)}
        onSaved={() => {
          refresh();
          refreshMeta();
        }}
      />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onDone={() => { refresh(); refreshMeta(); }} />
    </div>
  );
}

/* ------------------------------- Device card ------------------------------- */
function DeviceCard({
  device,
  spark,
  selected,
  onSelect,
  onPing,
  onEdit,
  onDelete,
  delay,
}: {
  device: Device;
  spark: { t: number; rtt: number | null; loss: number }[];
  selected: boolean;
  onSelect: () => void;
  onPing: () => void;
  onEdit: () => void;
  onDelete: () => void;
  delay: number;
}) {
  const liveSample = useDeviceLive(device.id);
  const status = liveSample?.status ?? device.status;
  const rtt = liveSample?.rtt ?? device.lastRtt;
  const loss = liveSample?.lossPct ?? device.lossPct;
  const meta = statusMeta(status);
  const navigate = useNavigate();

  const points = useMemo(() => {
    if (!spark.length) return [];
    const withLive = [...spark];
    if (liveSample?.rtt != null) withLive.push({ t: liveSample.ts, rtt: liveSample.rtt, loss: liveSample.lossPct });
    return withLive;
  }, [spark, liveSample]);

  return (
    <div
      style={{ animationDelay: `${delay}ms` }}
      className={`card group relative animate-fade-up p-4 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-pop ${
        selected ? 'ring-2 ring-brand-400/70' : ''
      } ${!device.enabled ? 'opacity-70' : ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <button
            type="button"
            onClick={onSelect}
            className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border transition ${
              selected ? 'border-brand-500 bg-brand-500 text-white' : 'border-ink-300 bg-white text-transparent hover:border-brand-300'
            }`}
            aria-label="انتخاب"
          >
            ✓
          </button>
          <div className="min-w-0">
            <button type="button" onClick={() => navigate(`/devices/${device.id}`)} className="block truncate text-right text-[13.5px] font-semibold text-ink-800 hover:text-brand-700">
              {device.name}
            </button>
            <p className="num mt-0.5 text-[11px] text-ink-400">{device.ip}</p>
          </div>
        </div>
        <StatusPill status={status} size="sm" />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {device.groupName ? (
          <span className="chip border-ink-200 bg-ink-50 text-ink-600" style={{ borderColor: `${device.groupColor}55`, background: `${device.groupColor}12`, color: device.groupColor ?? undefined }}>
            <Layers size={11} />
            {device.groupName}
          </span>
        ) : null}
        <Badge className={PRIORITY_META[device.priority]?.className}>{PRIORITY_META[device.priority]?.label}</Badge>
        {!device.monitoringEnabled ? <Badge tone="ink">پایش غیرفعال</Badge> : null}
        {device.latitude != null ? (
          <Badge tone="brand">
            <MapPin size={11} /> دارای موقعیت
          </Badge>
        ) : null}
        {(device.tags || []).slice(0, 2).map((t) => (
          <span key={t.id} className="chip" style={{ borderColor: `${t.color}44`, background: `${t.color}12`, color: t.color }}>
            <TagIcon size={10} />
            {t.name}
          </span>
        ))}
      </div>

      <div className="mt-3 rounded-soft bg-gradient-to-b from-ink-50/70 to-white p-2">
        {points.length ? (
          <MiniSpark points={points} color={meta.chart} height={52} />
        ) : (
          <div className="flex h-[52px] items-center justify-center text-[11px] text-ink-400">داده‌ای در یک ساعت گذشته ثبت نشده</div>
        )}
        <div className="mt-1 flex items-center justify-between text-[10px] text-ink-400">
          <span>نمودار تأخیر — یک ساعت گذشته</span>
          <span className="num">{faDigits(points.length)} نمونه</span>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <Metric label="تأخیر" value={fmtMs(rtt)} tone={rtt != null && rtt > (device.latencyThreshold ?? 150) ? 'text-sun-600' : 'text-ink-700'} />
        <Metric label="افت بسته" value={fmtPct(loss)} tone={loss > 5 ? 'text-sun-600' : 'text-ink-700'} />
        <Metric label="دسترس‌پذیری" value={fmtPct(device.uptimePct, 2)} tone={(device.uptimePct ?? 100) < 98 ? 'text-red-600' : 'text-emerald-600'} />
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-ink-100 pt-3">
        <span className="text-[10.5px] text-ink-400">آخرین بررسی: {fmtRelative(liveSample?.ts ?? device.lastCheckAt)}</span>
        <div className="flex items-center gap-1.5">
          <button type="button" className="btn-ghost btn-xs" onClick={onPing} title="ارسال Ping لحظه‌ای">
            <Wifi size={13} />
          </button>
          <button type="button" className="btn-ghost btn-xs" onClick={onEdit} title="ویرایش">
            <Edit3 size={13} />
          </button>
          <button type="button" className="btn-ghost btn-xs" onClick={onDelete} title="حذف">
            <Trash2 size={13} />
          </button>
          <Link to={`/devices/${device.id}`} className="btn-soft btn-xs">
            <Eye size={13} />
            جزئیات
          </Link>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-soft bg-ink-50/70 px-2 py-1.5 text-center">
      <p className="text-[10px] text-ink-400">{label}</p>
      <p className={`num mt-0.5 text-[12px] font-semibold ${tone}`}>{value}</p>
    </div>
  );
}

/* ------------------------------- Device table ------------------------------- */
function DeviceTable({
  devices,
  selected,
  allSelected,
  onToggleAll,
  onToggle,
  onPing,
  onEdit,
  onDelete,
  sort,
  order,
  onSort,
}: {
  devices: Device[];
  selected: number[];
  allSelected: boolean;
  onToggleAll: () => void;
  onToggle: (id: number) => void;
  onPing: (d: Device) => void;
  onEdit: (d: Device) => void;
  onDelete: (d: Device) => void;
  sort: string;
  order: string;
  onSort: (key: string) => void;
}) {
  const navigate = useNavigate();
  const columns: { key: string; label: string; sortable?: boolean; className?: string }[] = [
    { key: 'name', label: 'نام تجهیز', sortable: true },
    { key: 'ip', label: 'آدرس IP', sortable: true },
    { key: 'type', label: 'نوع' },
    { key: 'group', label: 'گروه', sortable: true },
    { key: 'status', label: 'وضعیت', sortable: true },
    { key: 'latency', label: 'تأخیر', sortable: true },
    { key: 'loss', label: 'افت بسته', sortable: true },
    { key: 'uptime', label: 'دسترس‌پذیری', sortable: true },
    { key: 'last_check', label: 'آخرین بررسی', sortable: true },
    { key: 'outages', label: 'قطعی', sortable: true },
    { key: 'actions', label: 'عملیات', className: 'text-center' },
  ];
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th className="w-10">
              <input type="checkbox" checked={allSelected} onChange={onToggleAll} className="accent-brand-600" aria-label="انتخاب همه" />
            </th>
            {columns.map((c) => (
              <th key={c.key} className={c.className}>
                {c.sortable ? (
                  <button type="button" className="inline-flex items-center gap-1 hover:text-brand-600" onClick={() => onSort(c.key)}>
                    {c.label}
                    <ArrowUpDown size={11} className={sort === c.key ? 'text-brand-500' : 'text-ink-300'} />
                    {sort === c.key ? <span className="text-[9px] text-brand-500">{order === 'asc' ? '▲' : '▼'}</span> : null}
                  </button>
                ) : (
                  c.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => (
            <tr key={d.id} className="cursor-pointer" onClick={() => navigate(`/devices/${d.id}`)}>
              <td onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={selected.includes(d.id)} onChange={() => onToggle(d.id)} className="accent-brand-600" />
              </td>
              <td>
                <span className="block font-medium text-ink-800">{d.name}</span>
                {d.location ? <span className="block text-[10.5px] text-ink-400">{d.location}</span> : null}
              </td>
              <td className="num">{d.ip}</td>
              <td>{d.deviceType}</td>
              <td>
                {d.groupName ? (
                  <span className="chip" style={{ borderColor: `${d.groupColor}44`, background: `${d.groupColor}12`, color: d.groupColor ?? undefined }}>
                    {d.groupName}
                  </span>
                ) : (
                  '—'
                )}
              </td>
              <td>
                <StatusPill status={d.status} size="sm" />
              </td>
              <td className="num">{fmtMs(d.lastRtt)}</td>
              <td className="num">{fmtPct(d.lossPct)}</td>
              <td className="num">{fmtPct(d.uptimePct, 2)}</td>
              <td className="text-[11px] text-ink-500">{fmtRelative(d.lastCheckAt)}</td>
              <td className="num">{fmtNumber(d.outageCount ?? 0)}</td>
              <td onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-center gap-1">
                  <button type="button" className="btn-ghost btn-xs" title="Ping" onClick={() => onPing(d)}>
                    <Wifi size={13} />
                  </button>
                  <button type="button" className="btn-ghost btn-xs" title="ویرایش" onClick={() => onEdit(d)}>
                    <Edit3 size={13} />
                  </button>
                  <button type="button" className="btn-ghost btn-xs" title="حذف" onClick={() => onDelete(d)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
