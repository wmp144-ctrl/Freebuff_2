import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarClock,
  Clock,
  Coins,
  Download,
  Edit3,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Wrench,
} from 'lucide-react';
import { api, downloadUrl } from '../lib/api';
import { useApp, useAsync, useToast } from '../lib/store';
import { faDigits, fmtDateTime, fmtDuration, fmtNumber } from '../lib/format';
import { Badge, Card, CardHeader, EmptyState, ErrorState, Field, PageLoader, Pagination, StatCard, Tabs } from '../components/ui';
import { TopBarList } from '../components/charts';
import MaintenanceForm from '../features/MaintenanceForm';
import type { MaintenanceRecord } from '../lib/types';

export default function Maintenance() {
  const { settings, meta, tzOffset } = useApp();
  const { push } = useToast();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [cause, setCause] = useState('');
  const [action, setAction] = useState('');
  const [status, setStatus] = useState('');
  const [range, setRange] = useState('all');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MaintenanceRecord | null>(null);

  const from = useMemo(() => {
    if (range === 'all') return undefined;
    const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
    return Date.now() - days * 86400000;
  }, [range]);

  const { data, loading, error, refresh } = useAsync(
    () => api.maintenance({ page, pageSize: 25, search, cause, action, status, from }),
    [page, search, cause, action, status, from]
  );

  const { data: windows, refresh: refreshWindows } = useAsync(() => api.windows(), []);
  const { data: ruleMeta } = useAsync(() => api.alertRules(), []);

  const totals = useMemo(() => {
    const items = data?.items ?? [];
    return {
      count: data?.total ?? 0,
      open: items.filter((i) => i.status === 'open').length,
      downtime: items.reduce((a, b) => a + (b.downtimeSec || 0), 0),
      cost: items.reduce((a, b) => a + (b.cost || 0), 0),
    };
  }, [data]);

  const byCause = useMemo(() => {
    const map = new Map<string, number>();
    (data?.items ?? []).forEach((i) => map.set(i.cause, (map.get(i.cause) ?? 0) + 1));
    return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }, [data]);

  const byAction = useMemo(() => {
    const map = new Map<string, number>();
    (data?.items ?? []).forEach((i) => map.set(i.action, (map.get(i.action) ?? 0) + 1));
    return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }, [data]);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="کل سوابق ثبت‌شده" value={fmtNumber(totals.count)} hint="در بازه فیلتر فعلی" icon={<Wrench size={20} />} tone="brand" />
        <StatCard label="تعمیرات در جریان" value={fmtNumber(totals.open)} hint="بدون زمان پایان" icon={<Clock size={20} />} tone="sun" />
        <StatCard label="مجموع مدت قطعی" value={fmtDuration(totals.downtime)} hint="بر اساس سوابق همین صفحه" icon={<CalendarClock size={20} />} tone="violet" />
        <StatCard label="هزینه ثبت‌شده" value={fmtNumber(totals.cost)} hint="ریال — بر اساس همین صفحه" icon={<Coins size={20} />} tone="emerald" />
      </div>

      <Card padded={false} className="p-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[220px] flex-1">
              <Search size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-400" />
              <input
                className="field !rounded-pill pr-9"
                placeholder="جست‌وجو در عنوان، توضیحات، تجهیز یا تکنسین…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <Tabs
              size="sm"
              value={range}
              onChange={(v) => {
                setRange(v);
                setPage(1);
              }}
              tabs={[
                { value: 'all', label: 'همه' },
                { value: '7d', label: '۷ روز' },
                { value: '30d', label: '۳۰ روز' },
                { value: '90d', label: '۹۰ روز' },
              ]}
            />
            <button
              type="button"
              className="btn-primary btn-xs ms-auto"
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              <Plus size={14} />
              ثبت سابقه جدید
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3">
            <select className="field !w-auto !rounded-pill" value={cause} onChange={(e) => { setCause(e.target.value); setPage(1); }}>
              <option value="">همه علت‌ها</option>
              {(settings?.repair_causes ?? []).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select className="field !w-auto !rounded-pill" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}>
              <option value="">همه اقدامات</option>
              {(settings?.repair_actions ?? []).map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <select className="field !w-auto !rounded-pill" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">همه وضعیت‌ها</option>
              <option value="open">در جریان</option>
              <option value="closed">پایان‌یافته</option>
            </select>
            <span className="ms-auto flex items-center gap-2">
              <button type="button" className="btn-ghost btn-xs" onClick={refresh}>
                <RefreshCw size={14} />
                بروزرسانی
              </button>
              <a className="btn-ghost btn-xs" href={downloadUrl('/reports/export', { format: 'xlsx', from: from ?? '' })}>
                <Download size={14} />
                خروجی گزارش
              </a>
            </span>
          </div>
        </div>
      </Card>

      <div className="grid gap-5 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="سوابق تعمیرات و خرابی‌ها" subtitle="علت خرابی، اقدام انجام‌شده و مدت قطعی هر رویداد" icon={<Wrench size={18} />} />
          <div className="mt-4">
            {loading && !data ? (
              <PageLoader label="در حال دریافت سوابق…" />
            ) : error && !data ? (
              <ErrorState message={error} onRetry={refresh} />
            ) : !data?.items?.length ? (
              <EmptyState
                title="سابقه‌ای با این فیلترها یافت نشد"
                description="سوابق تعمیرات، خرابی‌ها و اقدامات انجام‌شده را ثبت کنید تا تاریخچه نگهداری تجهیزات کامل شود."
                icon={<Wrench size={22} />}
                action={
                  <button type="button" className="btn-primary btn-xs" onClick={() => setFormOpen(true)}>
                    ثبت سابقه جدید
                  </button>
                }
              />
            ) : (
              <div className="table-wrap max-h-[640px]">
                <table className="table">
                  <thead>
                    <tr>
                      <th>تجهیز</th>
                      <th>عنوان</th>
                      <th>علت خرابی</th>
                      <th>اقدام انجام‌شده</th>
                      <th>شروع</th>
                      <th>مدت قطعی</th>
                      <th>تکنسین</th>
                      <th>وضعیت</th>
                      <th className="text-center">عملیات</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <Link to={`/devices/${m.deviceId}`} className="block font-medium text-ink-800 hover:text-brand-700">
                            {m.deviceName}
                          </Link>
                          <span className="num block text-[10.5px] text-ink-400">{m.deviceIp}</span>
                        </td>
                        <td className="max-w-[220px] truncate">{m.title || '—'}</td>
                        <td>
                          <Badge tone="sun">{m.cause}</Badge>
                        </td>
                        <td>
                          <Badge tone="brand">{m.action}</Badge>
                        </td>
                        <td className="num text-[11.5px]">{fmtDateTime(m.startedAt, tzOffset)}</td>
                        <td className="num">{m.endedAt ? fmtDuration(m.downtimeSec) : <span className="text-red-600">در جریان</span>}</td>
                        <td>{m.technician || '—'}</td>
                        <td>{m.status === 'open' ? <Badge tone="red">باز</Badge> : <Badge tone="emerald">بسته‌شده</Badge>}</td>
                        <td>
                          <div className="flex items-center justify-center gap-1">
                            <button
                              type="button"
                              className="btn-ghost btn-xs"
                              onClick={() => {
                                setEditing(m);
                                setFormOpen(true);
                              }}
                            >
                              <Edit3 size={13} />
                            </button>
                            <button
                              type="button"
                              className="btn-danger btn-xs"
                              onClick={async () => {
                                if (!window.confirm('این سابقه حذف شود؟')) return;
                                await api.deleteMaintenance(m.id);
                                push('سابقه حذف شد', 'success');
                                refresh();
                              }}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <Pagination page={data?.page ?? 1} pages={data?.pages ?? 1} total={data?.total ?? 0} pageSize={data?.pageSize ?? 25} onPage={setPage} />
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader title="علت‌های خرابی" subtitle="بر اساس سوابق همین صفحه" icon={<Wrench size={18} />} />
            <div className="mt-3">
              <TopBarList items={byCause} valueKey="count" color="#f59e0b" />
            </div>
          </Card>
          <Card>
            <CardHeader title="اقدامات انجام‌شده" subtitle="توزیع اقدامات ثبت‌شده" icon={<Wrench size={18} />} />
            <div className="mt-3">
              <TopBarList items={byAction} valueKey="count" color="#2563eb" />
            </div>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader
          title="پنجره‌های تعمیر و نگهداری"
          subtitle="در این بازه‌ها موتور مانیتورینگ بررسی تجهیزات را متوقف می‌کند و هشدار ثبت نمی‌شود"
          icon={<CalendarClock size={18} />}
          action={
            <button
              type="button"
              className="btn-soft btn-xs"
              onClick={async () => {
                const title = window.prompt('عنوان پنجره تعمیرات:', 'پنجره تعمیرات');
                if (!title) return;
                await api.createWindow({ title, days: '0,1,2,3,4,5,6', start_time: '01:00', end_time: '03:00', enabled: 1 });
                refreshWindows();
                push('پنجره تعمیرات ساخته شد', 'success');
              }}
            >
              <Plus size={13} />
              پنجره جدید
            </button>
          }
        />
        <div className="mt-4 space-y-3">
          {(windows?.items ?? []).length === 0 ? (
            <EmptyState title="پنجره تعمیراتی تعریف نشده" description="پنجره تعمیرات از ثبت هشدار در زمان انجام سرویس جلوگیری می‌کند." icon={<CalendarClock size={22} />} />
          ) : (
            (windows?.items ?? []).map((w) => (
              <div key={w.id} className="flex flex-wrap items-center justify-between gap-3 rounded-soft border border-ink-200 bg-white/70 p-3">
                <div className="min-w-0">
                  <p className="text-[12.5px] font-semibold text-ink-700">{w.title}</p>
                  <p className="num mt-1 text-[11px] text-ink-500">
                    {w.start_time} تا {w.end_time} — {w.device_id ? `تجهیز: ${w.deviceName ?? w.device_id}` : 'سراسری'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={w.enabled ? 'emerald' : 'ink'}>{w.enabled ? 'فعال' : 'غیرفعال'}</Badge>
                  <button
                    type="button"
                    className="btn-ghost btn-xs"
                    onClick={async () => {
                      await api.updateWindow(w.id, { ...w, enabled: w.enabled ? 0 : 1 });
                      refreshWindows();
                    }}
                  >
                    {w.enabled ? 'غیرفعال‌سازی' : 'فعال‌سازی'}
                  </button>
                  <button
                    type="button"
                    className="btn-danger btn-xs"
                    onClick={async () => {
                      if (!window.confirm('این پنجره حذف شود؟')) return;
                      await api.deleteWindow(w.id);
                      refreshWindows();
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="راهنمای ثبت صحیح سوابق" subtitle="الزامات سند برای سوابق نگهداری" icon={<Wrench size={18} />} />
        <div className="mt-3 grid gap-3 md:grid-cols-3 text-[11.5px] leading-relaxed text-ink-600">
          <div className="rounded-soft border border-ink-200 bg-white/70 p-3">
            <p className="mb-1 font-semibold text-ink-700">علت خرابی</p>
            <p>مشکلات زیرساخت فیبر نوری، مشکلات شبکه، قطعی برق، هنگ کردن سوئیچ، سوختن یا خرابی تجهیز و سایر دلایل قابل تعریف توسط کاربر.</p>
          </div>
          <div className="rounded-soft border border-ink-200 bg-white/70 p-3">
            <p className="mb-1 font-semibold text-ink-700">اقدام انجام‌شده</p>
            <p>تعویض تجهیز، تعمیر تجهیز، تعویض قطعه، اصلاح زیرساخت، رفع مشکل شبکه و سایر اقدامات قابل ثبت.</p>
          </div>
          <div className="rounded-soft border border-ink-200 bg-white/70 p-3">
            <p className="mb-1 font-semibold text-ink-700">اطلاعات تکمیلی</p>
            <p>تاریخ و زمان شروع و پایان، مدت قطعی، تکنسین مسئول، هزینه و توضیحات تکمیلی برای هر سابقه.</p>
          </div>
        </div>
        <p className="mt-3 text-[11px] text-ink-400">
          در این بخش فقط سوابقی نمایش داده می‌شود که کاربر ثبت کرده است؛ قطعی‌های شناسایی‌شده توسط موتور به‌صورت خودکار سابقه تعمیرات نمی‌سازند.
          {ruleMeta ? ` · تعداد قوانین هشدار فعال: ${faDigits((ruleMeta.items ?? []).filter((r) => r.enabled).length)}` : ''}
          {meta ? ` · تعداد گروه‌های تجهیزات: ${faDigits(meta.groups.length)}` : ''}
        </p>
      </Card>

      <MaintenanceForm
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
        record={editing}
        onSaved={refresh}
      />
    </div>
  );
}
