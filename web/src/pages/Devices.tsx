import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Activity,
  ArrowUpDown,
  Download,
  Edit3,
  Eye,
  Filter,
  Grid2X2,
  Layers,
  List,
  MapPin,
  PanelLeftClose,
  PanelLeftOpen,
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
import { useApp, useAsync, useDeviceLive, useLive, useToast } from '../lib/store';
import { useAuth } from '../lib/auth';
import { DataFreshness } from '../components/Freshness';
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
import { LatencySpark } from '../components/charts';
import { useLivePing } from '../components/LivePing';
import DeviceForm from '../features/DeviceForm';
import ImportDialog from '../features/ImportDialog';
import type { Device, Paged, Priority } from '../lib/types';

type ViewMode = 'cards' | 'table';

// فیلتر وضعیت به‌صورت سه بخش کنار هم: وصل / قطع / همه
const STATUS_SEGMENTS = [
  { value: 'online', label: 'وصل' },
  { value: 'warning', label: 'دارای اختلال' },
  { value: 'offline', label: 'قطع' },
  { value: '', label: 'همه' },
] as const;

const STATUS_LABELS: Record<string, string> = {
  online: 'وصل',
  offline: 'قطع',
  warning: 'دارای اختلال',
  maintenance: 'در تعمیرات',
  unknown: 'نامشخص',
  high_latency: 'پینگ بالا',
};

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

/**
 * ترجیح نمایش (کارت/جدول) در حافظهٔ مرورگر نگه داشته می‌شود؛ در حالت مرور خصوصی یا
 * وقتی ذخیره‌سازی مرورگر غیرفعال است، دسترسی به localStorage استثنا می‌دهد و پیش‌تر
 * همین یک خط باعث از کار افتادن کل صفحه می‌شد.
 */
function readViewPreference(): ViewMode {
  try {
    return (localStorage.getItem('nw.view') as ViewMode) || 'cards';
  } catch {
    return 'cards';
  }
}

function saveViewPreference(view: ViewMode) {
  try {
    localStorage.setItem('nw.view', view);
  } catch {
    /* ذخیره‌سازی مرورگر در دسترس نیست */
  }
}

/** تعداد کارت‌های هر ردیف (۱ تا ۸) */
function readColsPreference(): number {
  try {
    const n = Number(localStorage.getItem('nw.cols'));
    return n >= 1 && n <= 8 ? n : 4;
  } catch {
    return 4;
  }
}

function saveColsPreference(cols: number) {
  try {
    localStorage.setItem('nw.cols', String(cols));
  } catch {
    /* ذخیره‌سازی مرورگر در دسترس نیست */
  }
}

export default function Devices() {
  const [params, setParams] = useSearchParams();
  const { meta, refreshMeta, settings } = useApp();
  const { push } = useToast();
  const navigate = useNavigate();
  const live = useLive();
  const { can } = useAuth();
  // عملیات غیرمجاز از همان ابتدا پنهان می‌شود؛ سرور نیز مستقل از UI آن را رد می‌کند.
  const canWrite = can('devices:write');
  const canProbe = can('probe:run');

  const [view, setView] = useState<ViewMode>(readViewPreference);
  const [cols, setCols] = useState<number>(readColsPreference);
  // در موبایل/تبلت منوی گروه‌ها بسته شروع می‌شود تا فهرست تجهیزات زیر چند
  // صفحه گروه پنهان نشود؛ در دسکتاپ باز است.
  const [groupsOpen, setGroupsOpen] = useState<boolean>(() => {
    try {
      return window.matchMedia('(min-width: 1280px)').matches;
    } catch {
      return true;
    }
  });
  const [exportOpen, setExportOpen] = useState(false);
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

  const { data, loading, error, refresh, updatedAt, refreshing } = useAsync<Paged<Device>>(
    (signal) => api.devices(query as unknown as Record<string, string | number>, signal),
    [JSON.stringify(query)],
    { interval: 30000 }
  );

  const devices = data?.items ?? [];

  // اتصال مجدد SSE → Snapshot تازه فهرست، تا وضعیت‌های ازدست‌رفته با داده قبلی
  // اشتباه گرفته نشوند.
  const syncToken = live.syncToken;
  const seenSync = useRef(syncToken);
  useEffect(() => {
    if (syncToken === seenSync.current) return;
    seenSync.current = syncToken;
    refresh();
  }, [syncToken, refresh]);

  // آمار گروه‌ها برای منوی کناری (تعداد کل، وصل و قطع هر گروه)
  const { data: groupsData } = useAsync((signal) => api.groups(signal), [], { interval: 30000 });
  const groups = groupsData?.items ?? meta?.groups ?? [];

  useEffect(() => {
    saveViewPreference(view);
  }, [view]);

  useEffect(() => {
    saveColsPreference(cols);
  }, [cols]);

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
  // شناسه‌های بارگیری‌شده نگه داشته می‌شوند تا با رفتن به صفحهٔ بعد، نمودار
  // تجهیزات تازه هم گرفته شود (پیش‌تر فقط وجود نمودار اولین کارت بررسی می‌شد و
  // کارت‌های صفحه‌های بعد خالی می‌ماندند).
  const loadedSparks = useRef(0);
  useEffect(() => {
    if (!deviceIds || view !== 'cards') return;
    const ids = deviceIds.split(',').map(Number);
    if (loadedSparks.current === sparkTick && ids.every((id) => sparks[id])) return;
    let alive = true;
    api
      .sparklines(ids, '1h')
      .then((res) => {
        if (!alive) return;
        loadedSparks.current = sparkTick;
        setSparks((prev) => ({ ...prev, ...res.series }));
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

  const highLatency = meta?.highLatency ?? 0;

  const activeFilters = [
    query.status ? { key: 'status', label: STATUS_LABELS[query.status] ?? query.status } : null,
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
    if (!selected.length || busy) return;
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
    if (busy) return;
    setBusy(true);
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
    } finally {
      setBusy(false);
    }
  };

  const removeDevice = async (device: Device) => {
    if (busy) return;
    if (!window.confirm(`تجهیز «${device.name}» حذف شود؟ تمام تاریخچه و سوابق آن نیز حذف خواهد شد.`)) return;
    setBusy(true);
    try {
      await api.deleteDevice(device.id);
      push('تجهیز حذف شد', 'success');
      refresh();
      refreshMeta();
    } catch (e) {
      push((e as Error).message, 'error');
    } finally {
      setBusy(false);
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
            {/* فیلتر وضعیت: سه بخش کنار هم + «پینگ بالا» در صورت وجود */}
            <div className="inline-flex items-center rounded-pill border border-ink-200 bg-white/70 p-0.5">
              {STATUS_SEGMENTS.map((s) => (
                <button
                  key={s.value || 'all'}
                  type="button"
                  onClick={() => setParam('status', s.value)}
                  className={`rounded-pill px-3 py-1.5 text-[12px] font-medium transition ${
                    query.status === s.value
                      ? s.value === 'online'
                        ? 'bg-emerald-500 text-white'
                        : s.value === 'offline'
                          ? 'bg-red-500 text-white'
                          : s.value === 'warning'
                            ? 'bg-sun-500 text-white'
                            : 'bg-brand-500 text-white'
                      : 'text-ink-500 hover:text-ink-700'
                  }`}
                >
                  {s.label}
                </button>
              ))}
              {highLatency > 0 ? (
                <button
                  type="button"
                  onClick={() => setParam('status', 'high_latency')}
                  className={`inline-flex items-center gap-1 rounded-pill px-3 py-1.5 text-[12px] font-medium transition ${
                    query.status === 'high_latency' ? 'bg-sun-500 text-white' : 'text-sun-600 hover:text-sun-700'
                  }`}
                >
                  <Activity size={12} />
                  پینگ بالا
                  <span className="num">{faDigits(highLatency)}</span>
                </button>
              ) : null}
            </div>
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
            {view === 'cards' ? (
              <div className="inline-flex items-center gap-0.5 rounded-soft border border-ink-200 bg-white/70 px-1.5 py-1" title="تعداد کارت‌های هر ردیف">
                <Grid2X2 size={13} className="ms-0.5 me-1 text-ink-400" />
                {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setCols(n)}
                    className={`num h-6 w-6 rounded-md text-[11px] font-medium transition ${
                      cols === n ? 'bg-brand-500 text-white' : 'text-ink-500 hover:bg-ink-100'
                    }`}
                  >
                    {faDigits(n)}
                  </button>
                ))}
              </div>
            ) : null}
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
            {canWrite ? (
              <button type="button" className="btn-ghost btn-xs" onClick={() => setImportOpen(true)}>
                <Upload size={14} />
                ورود گروهی
              </button>
            ) : null}
            <div className="relative">
              <button
                type="button"
                className="btn-ghost btn-xs"
                onClick={() => setExportOpen((v) => !v)}
                aria-expanded={exportOpen}
                aria-haspopup="menu"
              >
                <Download size={14} />
                خروجی
              </button>
              {exportOpen ? <button type="button" className="fixed inset-0 z-20 cursor-default" aria-label="بستن منوی خروجی" onClick={() => setExportOpen(false)} /> : null}
              <div className={exportOpen ? 'absolute left-0 z-30 mt-1 w-52 rounded-soft border border-ink-200 bg-white p-1.5 shadow-pop' : 'hidden'}>
                <a className="block rounded-lg px-3 py-2 text-[12px] text-ink-600 hover:bg-brand-50" href={downloadUrl('/devices/export', { format: 'xlsx' })} onClick={() => setExportOpen(false)}>
                  خروجی Excel از تجهیزات
                </a>
                <a className="block rounded-lg px-3 py-2 text-[12px] text-ink-600 hover:bg-brand-50" href={downloadUrl('/devices/export', { format: 'csv' })} onClick={() => setExportOpen(false)}>
                  خروجی CSV از تجهیزات
                </a>
                <a className="block rounded-lg px-3 py-2 text-[12px] text-ink-600 hover:bg-brand-50" href={downloadUrl('/devices/export/geo', { format: 'xlsx' })} onClick={() => setExportOpen(false)}>
                  خروجی مختصات جغرافیایی
                </a>
              </div>
            </div>
            {canWrite ? (
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
            ) : null}
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
              {updatedAt ? ` · آخرین به‌روزرسانی ${fmtRelative(updatedAt)}` : ''}
              {refreshing ? ' · در حال به‌روزرسانی…' : ''}
            </span>
          </div>
        )}
      </Card>

      <DataFreshness updatedAt={updatedAt} intervalMs={30000} onRefresh={refresh} />

      {/* نوار عملیات گروهی */}
      {canWrite && selected.length > 0 ? (
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

      {/* چیدمان: محتوا (راست) · منوی گروه‌ها (چپ) — دکمهٔ باز/بسته بالای خود گروه‌ها */}
      <div className="flex flex-col gap-4 xl:flex-row-reverse xl:items-start">
        <div className={`shrink-0 ${groupsOpen ? 'xl:w-[250px]' : 'xl:w-auto'}`}>
          <div className="mb-2 flex items-center gap-2">
            <button
              type="button"
              className="btn-ghost btn-xs"
              onClick={() => setGroupsOpen((v) => !v)}
              aria-expanded={groupsOpen}
              aria-controls="device-groups"
              title={groupsOpen ? 'بستن منوی گروه‌ها' : 'نمایش منوی گروه‌ها'}
              aria-label={groupsOpen ? 'بستن منوی گروه‌ها' : 'نمایش منوی گروه‌ها'}
            >
              {groupsOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
              {groupsOpen ? 'بستن گروه‌ها' : 'گروه‌ها'}
            </button>
          </div>
          {groupsOpen ? (
            <GroupSidebar
              groups={groups.map((g) => ({
                id: g.id,
                name: g.name,
                color: g.color,
                total: g.device_count ?? 0,
                online: g.online ?? 0,
                offline: g.offline ?? 0,
              }))}
              selected={query.group}
              onSelect={(name) => setParam('group', name)}
            />
          ) : null}
        </div>
        <div className="min-w-0 flex-1 space-y-4">
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
            canWrite ? (
              <div className="flex gap-2">
                <button type="button" className="btn-primary btn-xs" onClick={() => { setEditing(null); setFormOpen(true); }}>
                  افزودن تجهیز
                </button>
                <button type="button" className="btn-ghost btn-xs" onClick={() => setImportOpen(true)}>
                  ورود گروهی از فایل
                </button>
              </div>
            ) : undefined
          }
        />
      ) : view === 'cards' ? (
        <div
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:[grid-template-columns:repeat(var(--nw-cols),minmax(0,1fr))]"
          style={{ '--nw-cols': cols } as React.CSSProperties}
        >
          {devices.map((d, i) => (
            <DeviceCard
              key={d.id}
              device={d}
              spark={sparks[d.id] ?? []}
              threshold={d.latencyThreshold ?? settings?.latency_threshold ?? 150}
              selected={selected.includes(d.id)}
              selectable={canWrite}
              canProbe={canProbe}
              canWrite={canWrite}
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
          selectable={canWrite}
          canProbe={canProbe}
          canWrite={canWrite}
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

        </div>
      </div>

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

/* ------------------------------ منوی کناری گروه‌ها ------------------------------ */
function GroupSidebar({
  groups,
  selected,
  onSelect,
}: {
  groups: { id: number; name: string; color: string; total: number; online: number; offline: number }[];
  selected: string;
  onSelect: (name: string) => void;
}) {
  const totals = groups.reduce(
    (acc, g) => ({ total: acc.total + g.total, online: acc.online + g.online, offline: acc.offline + g.offline }),
    { total: 0, online: 0, offline: 0 }
  );
  return (
    <Card id="device-groups">
      <div className="flex items-center gap-2">
        <Layers size={16} className="text-brand-500" />
        <h3 className="text-[14px] font-semibold text-ink-800">گروه‌های تجهیزات</h3>
      </div>
      <div className="mt-3 space-y-1.5">
        <GroupRow
          name="همه گروه‌ها"
          color="#2563eb"
          total={totals.total}
          online={totals.online}
          offline={totals.offline}
          active={!selected}
          onClick={() => onSelect('')}
        />
        {groups.map((g) => (
          <GroupRow
            key={g.id}
            name={g.name}
            color={g.color}
            total={g.total}
            online={g.online}
            offline={g.offline}
            active={selected === g.name}
            onClick={() => onSelect(selected === g.name ? '' : g.name)}
          />
        ))}
        {groups.length === 0 ? <p className="py-4 text-center text-[11px] text-ink-400">گروهی تعریف نشده است</p> : null}
      </div>
    </Card>
  );
}

function GroupRow({
  name,
  color,
  total,
  online,
  offline,
  active,
  onClick,
}: {
  name: string;
  color: string;
  total: number;
  online: number;
  offline: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-soft border px-2.5 py-2 text-right transition ${
        active ? 'border-brand-300 bg-brand-50/70' : 'border-ink-100 bg-white/70 hover:border-brand-200'
      }`}
    >
      <span className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink-700">{name}</span>
      </span>
      <span className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10.5px]">
        <span className="text-ink-400">
          کل: <span className="num font-medium text-ink-600">{faDigits(total)}</span>
        </span>
        <span className="text-emerald-600">
          وصل: <span className="num font-medium">{faDigits(online)}</span>
        </span>
        <span className="text-red-600">
          قطع: <span className="num font-medium">{faDigits(offline)}</span>
        </span>
        <span className="text-ink-400">
          غیرفعال: <span className="num font-medium text-ink-500">{faDigits(Math.max(0, total - online - offline))}</span>
        </span>
      </span>
    </button>
  );
}

/* ------------------------------- Device card ------------------------------- */
function DeviceCard({
  device,
  spark,
  threshold,
  selected,
  selectable,
  canProbe,
  canWrite,
  onSelect,
  onPing,
  onEdit,
  onDelete,
  delay,
}: {
  device: Device;
  spark: { t: number; rtt: number | null; loss: number }[];
  threshold: number;
  selected: boolean;
  selectable: boolean;
  canProbe: boolean;
  canWrite: boolean;
  onSelect: () => void;
  onPing: () => void;
  onEdit: () => void;
  onDelete: () => void;
  delay: number;
}) {
  const liveSample = useDeviceLive(device.id);
  const livePing = useLivePing();
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
      className={`card device-card group relative animate-fade-up p-4 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-pop ${
        selected ? 'ring-2 ring-brand-400/70' : ''
      } ${!device.enabled ? 'opacity-70' : ''}`}
    >
      <div className="device-card__head flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {selectable ? (
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
          ) : null}
          <div className="min-w-0">
            <button type="button" onClick={() => navigate(`/devices/${device.id}`)} className="block truncate text-right text-[13.5px] font-semibold text-ink-800 hover:text-brand-700">
              {device.name}
            </button>
            <p className="num mt-0.5 text-[11px] text-ink-400">{device.ip}</p>
            {device.statusReason && status !== 'online' ? (
              <p className="mt-1 line-clamp-2 text-[10.5px] leading-relaxed text-sun-700" title={device.statusReason}>
                {device.statusReason}
              </p>
            ) : null}
          </div>
        </div>
        <span className="device-card__status shrink-0">
          <StatusPill status={status} size="sm" />
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {device.groupName ? (
          <span
            className="chip max-w-full border-ink-200 bg-ink-50 text-ink-600"
            style={{ borderColor: `${device.groupColor}55`, background: `${device.groupColor}12`, color: device.groupColor ?? undefined }}
          >
            <Layers size={11} className="shrink-0" />
            <span className="truncate">{device.groupName}</span>
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
          <LatencySpark points={points} threshold={threshold} height={52} />
        ) : (
          <div className="flex h-[52px] items-center justify-center px-1 text-center text-[11px] leading-tight text-ink-400">داده‌ای در یک ساعت گذشته ثبت نشده</div>
        )}
        <div className="device-card__legend mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[10px] text-ink-400">
          <span className="device-card__chart-caption">نمودار تأخیر — یک ساعت گذشته</span>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span className="inline-flex h-0.5 w-4 rounded" style={{ background: '#f97316' }} />
            آستانه <span className="num">{faDigits(threshold)} ms</span>
          </span>
        </div>
      </div>

      <div className="device-card__metrics mt-3 grid grid-cols-3 gap-2">
        <Metric label="تأخیر" value={fmtMs(rtt)} tone={rtt != null && rtt > (device.latencyThreshold ?? 150) ? 'text-sun-600' : 'text-ink-700'} />
        <Metric label="افت بسته" value={fmtPct(loss)} tone={loss > 5 ? 'text-sun-600' : 'text-ink-700'} />
        <Metric label="دسترس‌پذیری" value={fmtPct(device.uptimePct, 2)} tone={(device.uptimePct ?? 100) < 98 ? 'text-red-600' : 'text-emerald-600'} />
      </div>

      <div className="device-card__footer mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-ink-100 pt-3">
        <span className="device-card__time text-[10.5px] text-ink-400">آخرین بررسی: {fmtRelative(liveSample?.ts ?? device.lastCheckAt)}</span>
        <div className="device-card__actions flex flex-wrap items-center justify-end gap-1.5">
          {canProbe ? (
            <>
              <button
                type="button"
                className={`btn-xs ${livePing.has(device.id) ? 'btn-soft' : 'btn-ghost'}`}
                onClick={() => livePing.toggle({ id: device.id, name: device.name, ip: device.ip, status })}
                title="پنجرهٔ پینگ زنده (هر ثانیه)"
              >
                <Activity size={13} />
              </button>
              <button type="button" className="btn-ghost btn-xs" onClick={onPing} title="ارسال Ping لحظه‌ای">
                <Wifi size={13} />
              </button>
            </>
          ) : null}
          {canWrite ? (
            <>
              <button type="button" className="btn-ghost btn-xs" onClick={onEdit} title="ویرایش">
                <Edit3 size={13} />
              </button>
              <button type="button" className="btn-ghost btn-xs" onClick={onDelete} title="حذف">
                <Trash2 size={13} />
              </button>
            </>
          ) : null}
          <Link to={`/devices/${device.id}`} className="btn-soft btn-xs" title="جزئیات تجهیز">
            <Eye size={13} />
            <span className="device-card__details-label">جزئیات</span>
          </Link>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="device-card__metric min-w-0 rounded-soft bg-ink-50/70 px-2 py-1.5 text-center">
      <p className="text-[10px] text-ink-400">{label}</p>
      <p className={`num mt-0.5 truncate text-[12px] font-semibold ${tone}`} title={value}>
        {value}
      </p>
    </div>
  );
}

/* ------------------------------- Device table ------------------------------- */
function DeviceTable({
  devices,
  selected,
  allSelected,
  selectable,
  canProbe,
  canWrite,
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
  selectable: boolean;
  canProbe: boolean;
  canWrite: boolean;
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
  const livePing = useLivePing();
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
            {selectable ? (
              <th className="w-10">
                <input type="checkbox" checked={allSelected} onChange={onToggleAll} className="accent-brand-600" aria-label="انتخاب همه" />
              </th>
            ) : null}
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
              {selectable ? (
                <td onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={selected.includes(d.id)} onChange={() => onToggle(d.id)} className="accent-brand-600" />
                </td>
              ) : null}
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
                {d.statusReason && d.status !== 'online' ? (
                  <span className="mt-0.5 block max-w-[220px] truncate text-[10px] text-ink-400" title={d.statusReason}>
                    {d.statusReason}
                  </span>
                ) : null}
              </td>
              <td className="num">{fmtMs(d.lastRtt)}</td>
              <td className="num">{fmtPct(d.lossPct)}</td>
              <td className="num">{fmtPct(d.uptimePct, 2)}</td>
              <td className="text-[11px] text-ink-500">{fmtRelative(d.lastCheckAt)}</td>
              <td className="num">{fmtNumber(d.outageCount ?? 0)}</td>
              <td onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-center gap-1">
                  {canProbe ? (
                    <>
                      <button
                        type="button"
                        className={`btn-xs ${livePing.has(d.id) ? 'btn-soft' : 'btn-ghost'}`}
                        title="پینگ زنده (هر ثانیه)"
                        onClick={() => livePing.toggle({ id: d.id, name: d.name, ip: d.ip, status: d.status })}
                      >
                        <Activity size={13} />
                      </button>
                      <button type="button" className="btn-ghost btn-xs" title="Ping" onClick={() => onPing(d)}>
                        <Wifi size={13} />
                      </button>
                    </>
                  ) : null}
                  {canWrite ? (
                    <>
                      <button type="button" className="btn-ghost btn-xs" title="ویرایش" onClick={() => onEdit(d)}>
                        <Edit3 size={13} />
                      </button>
                      <button type="button" className="btn-ghost btn-xs" title="حذف" onClick={() => onDelete(d)}>
                        <Trash2 size={13} />
                      </button>
                    </>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
