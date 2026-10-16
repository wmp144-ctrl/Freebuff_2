import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDownUp,
  CalendarRange,
  Download,
  FileBarChart,
  Filter,
  Gauge,
  RefreshCw,
  Timer,
  TrendingDown,
  Trophy,
} from 'lucide-react';
import { api, downloadUrl } from '../lib/api';
import { useApp, useAsync } from '../lib/store';
import { faDigits, fmtDayLabel, fmtDuration, fmtMs, fmtNumber, fmtPct, statusMeta } from '../lib/format';
import { Badge, Card, CardHeader, EmptyState, ErrorState, Field, PageLoader, StatCard, StatusPill, Tabs } from '../components/ui';
import { DailyBars, TopBarList, TrendLineChart } from '../components/charts';
import type { ReportData } from '../lib/types';

type SortKey = 'availability' | 'avgRtt' | 'maxRtt' | 'lossPct' | 'outages' | 'downtimeSec' | 'checks' | 'alerts' | 'name';

export default function Reports() {
  const { meta, tzOffset } = useApp();
  const [range, setRange] = useState('7d');
  const [group, setGroup] = useState('');
  const [tag, setTag] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [sort, setSort] = useState<SortKey>('availability');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');

  const { data, loading, error, refresh } = useAsync<ReportData>(
    () => api.report({ range, group, tag, device: deviceId || undefined }),
    [range, group, tag, deviceId]
  );

  const rows = useMemo(() => {
    const items = [...(data?.items ?? [])];
    items.sort((a, b) => {
      if (sort === 'name') return order === 'asc' ? a.name.localeCompare(b.name, 'fa') : b.name.localeCompare(a.name, 'fa');
      const av = (a[sort] ?? 0) as number;
      const bv = (b[sort] ?? 0) as number;
      return order === 'asc' ? av - bv : bv - av;
    });
    return items;
  }, [data, sort, order]);

  const worstAvailability = useMemo(() => {
    const withData = (data?.items ?? []).filter((i) => i.availability != null);
    return [...withData].sort((a, b) => (a.availability ?? 0) - (b.availability ?? 0)).slice(0, 10);
  }, [data]);

  const exportUrl = (format: 'xlsx' | 'csv') => downloadUrl('/reports/export', { format, range, group, tag, device: deviceId || undefined });

  return (
    <div className="space-y-4">
      <Card padded={false} className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Tabs
            value={range}
            onChange={setRange}
            tabs={[
              { value: '24h', label: '۲۴ ساعت' },
              { value: '7d', label: '۷ روز' },
              { value: '30d', label: '۳۰ روز' },
              { value: '90d', label: '۹۰ روز' },
            ]}
          />
          <select className="field !w-auto !rounded-pill" value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">همه گروه‌ها</option>
            {(meta?.groups ?? []).map((g) => (
              <option key={g.id} value={g.name}>
                {g.name}
              </option>
            ))}
          </select>
          <select className="field !w-auto !rounded-pill" value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">همه تگ‌ها</option>
            {(meta?.tags ?? []).map((t) => (
              <option key={t.id} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
          <DeviceSelect value={deviceId} onChange={setDeviceId} />
          <div className="ms-auto flex items-center gap-2">
            <button type="button" className="btn-ghost btn-xs" onClick={refresh}>
              <RefreshCw size={14} />
              بروزرسانی
            </button>
            <a className="btn-ghost btn-xs" href={exportUrl('csv')}>
              <Download size={14} />
              CSV
            </a>
            <a className="btn-soft btn-xs" href={exportUrl('xlsx')}>
              <Download size={14} />
              خروجی Excel
            </a>
          </div>
        </div>
        {(group || tag || deviceId) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3 text-[11px] text-ink-500">
            <Filter size={12} />
            فیلترهای فعال روی گزارش اعمال شده است.
            <button
              type="button"
              className="text-brand-600 underline"
              onClick={() => {
                setGroup('');
                setTag('');
                setDeviceId('');
              }}
            >
              پاک کردن فیلترها
            </button>
          </div>
        )}
      </Card>

      {loading && !data ? (
        <PageLoader label="در حال محاسبه گزارش…" />
      ) : error && !data ? (
        <ErrorState message={error} onRetry={refresh} />
      ) : !data ? null : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <StatCard label="دسترس‌پذیری کل" value={fmtPct(data.totals.availability, 2)} hint={`${faDigits(data.totals.checks)} بررسی`} icon={<Gauge size={20} />} tone="emerald" />
            <StatCard label="میانگین تأخیر" value={fmtMs(data.totals.avgRtt)} hint={`بیشترین: ${fmtMs(data.totals.maxRtt)}`} icon={<Timer size={20} />} tone="brand" />
            <StatCard label="تعداد قطعی‌ها" value={fmtNumber(data.totals.outages)} hint={`مدت کل: ${fmtDuration(data.totals.downtimeSec)}`} icon={<TrendingDown size={20} />} tone="red" />
            <StatCard label="میانگین زمان رفع (MTTR)" value={fmtDuration(data.totals.mttrSec)} hint="میانگین مدت هر قطعی" icon={<Timer size={20} />} tone="sun" />
            <StatCard label="هشدارهای ثبت‌شده" value={fmtNumber(data.totals.alerts)} hint={`${faDigits(data.totals.devices)} تجهیز در گزارش`} icon={<FileBarChart size={20} />} tone="violet" />
          </div>

          <div className="grid gap-5 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader title="روند دسترس‌پذیری و تأخیر" subtitle={`${faDigits(data.days.length)} روز با داده ثبت‌شده`} icon={<Gauge size={18} />} />
              <div className="mt-3">
                {data.days.length ? (
                  <TrendLineChart
                    points={data.days.map((d) => ({ label: fmtDayLabel(d.day, tzOffset), availability: d.availability, avgRtt: d.avgRtt }))}
                    series={[
                      { key: 'availability', label: 'دسترس‌پذیری (٪)', color: '#16a34a' },
                      { key: 'avgRtt', label: 'میانگین تأخیر (ms)', color: '#2563eb' },
                    ]}
                    suffix=""
                    yDomain={[0, 100]}
                  />
                ) : (
                  <EmptyState title="داده‌ای در این بازه یافت نشد" description="بازه زمانی یا فیلترهای گزارش را تغییر دهید." />
                )}
              </div>
            </Card>
            <Card>
              <CardHeader title="قطعی‌ها به تفکیک روز" subtitle="تعداد رویدادهای قطعی در بازه گزارش" icon={<CalendarRange size={18} />} />
              <div className="mt-3">
                <DailyBars points={data.dailyOutages as unknown as Record<string, unknown>[]} tzOffset={tzOffset} />
              </div>
            </Card>
          </div>

          <div className="grid gap-5 xl:grid-cols-3">
            <Card>
              <CardHeader title="کمترین دسترس‌پذیری" subtitle="۱۰ تجهیز بحرانی در بازه گزارش" icon={<Trophy size={18} />} />
              <div className="mt-3">
                <TopBarList
                  items={worstAvailability as unknown as Record<string, unknown>[]}
                  valueKey="availability"
                  formatter={(v) => fmtPct(v, 2)}
                  color="#dc2626"
                />
              </div>
            </Card>
            <Card>
              <CardHeader title="علت‌های قطعی ثبت‌شده" subtitle="تفکیک علل بر اساس سوابق قطعی" icon={<TrendingDown size={18} />} />
              <div className="mt-3">
                <TopBarList items={data.causes as unknown as Record<string, unknown>[]} valueKey="count" color="#f59e0b" />
              </div>
            </Card>
            <Card>
              <CardHeader title="اقدامات نگهداری" subtitle="توزیع اقدامات ثبت‌شده در بازه" icon={<FileBarChart size={18} />} />
              <div className="mt-3">
                <TopBarList items={data.actions as unknown as Record<string, unknown>[]} valueKey="count" color="#7c3aed" />
              </div>
            </Card>
          </div>

          <Card padded={false} className="p-4">
            <CardHeader
              title="جدول تفصیلی گزارش تجهیزات"
              subtitle="برای مرتب‌سازی روی عنوان ستون‌ها کلیک کنید"
              icon={<FileBarChart size={18} />}
              action={
                <div className="flex items-center gap-2">
                  <select className="field !w-auto !py-1.5 text-xs" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                    <option value="availability">مرتب‌سازی: دسترس‌پذیری</option>
                    <option value="avgRtt">مرتب‌سازی: میانگین تأخیر</option>
                    <option value="maxRtt">مرتب‌سازی: بیشترین تأخیر</option>
                    <option value="lossPct">مرتب‌سازی: افت بسته</option>
                    <option value="outages">مرتب‌سازی: تعداد قطعی</option>
                    <option value="downtimeSec">مرتب‌سازی: مدت قطعی</option>
                    <option value="checks">مرتب‌سازی: تعداد بررسی</option>
                    <option value="alerts">مرتب‌سازی: هشدارها</option>
                    <option value="name">مرتب‌سازی: نام</option>
                  </select>
                  <button type="button" className="btn-ghost btn-xs" onClick={() => setOrder((o) => (o === 'asc' ? 'desc' : 'asc'))}>
                    <ArrowDownUp size={13} />
                    {order === 'asc' ? 'صعودی' : 'نزولی'}
                  </button>
                </div>
              }
            />
            <div className="mt-4 table-wrap max-h-[720px]">
              <table className="table">
                <thead>
                  <tr>
                    <th>نام تجهیز</th>
                    <th>گروه</th>
                    <th>وضعیت فعلی</th>
                    <th>تعداد بررسی</th>
                    <th>موفق / ناموفق</th>
                    <th>دسترس‌پذیری</th>
                    <th>میانگین تأخیر</th>
                    <th>بیشترین تأخیر</th>
                    <th>افت بسته</th>
                    <th>قطعی</th>
                    <th>مدت قطعی</th>
                    <th>MTTR</th>
                    <th>MTBF</th>
                    <th>هشدار</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link to={`/devices/${r.id}`} className="font-medium text-ink-800 hover:text-brand-700">
                          {r.name}
                        </Link>
                        <span className="num block text-[10.5px] text-ink-400">{r.ip}</span>
                      </td>
                      <td>
                        {r.groupName ? (
                          <span className="chip" style={{ borderColor: `${r.groupColor}44`, background: `${r.groupColor}12`, color: r.groupColor ?? undefined }}>
                            {r.groupName}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <StatusPill status={r.status} size="sm" showLabel={false} />
                        <span className={`ms-1.5 text-[10.5px] ${statusMeta(r.status).text}`}>{statusMeta(r.status).label}</span>
                      </td>
                      <td className="num">{fmtNumber(r.checks)}</td>
                      <td className="num">
                        <span className="text-emerald-600">{fmtNumber(r.okCount)}</span> / <span className="text-red-600">{fmtNumber(r.failed)}</span>
                      </td>
                      <td className="num">
                        <span className={(r.availability ?? 100) < 98 ? 'font-semibold text-red-600' : 'text-emerald-600'}>{fmtPct(r.availability, 2)}</span>
                      </td>
                      <td className="num">{fmtMs(r.avgRtt)}</td>
                      <td className="num">{fmtMs(r.maxRtt)}</td>
                      <td className="num">{fmtPct(r.lossPct, 2)}</td>
                      <td className="num">{fmtNumber(r.outages)}</td>
                      <td className="num">{fmtDuration(r.downtimeSec)}</td>
                      <td className="num">{r.mttrSec ? fmtDuration(r.mttrSec) : '—'}</td>
                      <td className="num">{r.mtbfSec ? fmtDuration(r.mtbfSec) : '—'}</td>
                      <td>
                        {r.alerts ? <Badge tone="sun">{fmtNumber(r.alerts)}</Badge> : <span className="text-ink-300">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length === 0 ? <EmptyState title="تجهیزی برای این گزارش یافت نشد" description="فیلترها را تغییر دهید." /> : null}
          </Card>

          <Card>
            <CardHeader title="گزارش‌های آماده" subtitle="خروجی‌های قابل استفاده برای مستندسازی و پیگیری مدیریتی" icon={<FileBarChart size={18} />} />
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <ReportPreset title="گزارش دسترس‌پذیری تجهیزات" desc="دسترس‌پذیری، تعداد قطعی و مدت قطعی هر تجهیز در بازه انتخاب‌شده" url={exportUrl('xlsx')} />
              <ReportPreset title="گزارش تأخیر و کیفیت ارتباط" desc="میانگین و بیشترین تأخیر، افت بسته و تعداد بررسی‌های موفق" url={downloadUrl('/reports/export', { format: 'csv', range })} />
              <ReportPreset title="گزارش مختصات تجهیزات" desc="فهرست موقعیت جغرافیایی تمام تجهیزات ثبت‌شده" url={downloadUrl('/devices/export/geo', { format: 'xlsx' })} />
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function ReportPreset({ title, desc, url }: { title: string; desc: string; url: string }) {
  return (
    <a href={url} className="group rounded-soft border border-ink-200/70 bg-white/70 p-4 transition hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-soft">
      <p className="text-[12.5px] font-semibold text-ink-700 group-hover:text-brand-700">{title}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-500">{desc}</p>
      <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-brand-600">
        <Download size={12} />
        دریافت فایل
      </p>
    </a>
  );
}

function DeviceSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data } = useAsync(() => api.devices({ pageSize: 500, sort: 'name' }), []);
  return (
    <Field className="!mb-0">
      <select className="field !w-auto !rounded-pill" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">همه تجهیزات</option>
        {(data?.items ?? []).map((d) => (
          <option key={d.id} value={d.id}>
            {d.name} — {d.ip}
          </option>
        ))}
      </select>
    </Field>
  );
}
