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
  ClipboardList,
  CalendarClock,
  Wrench,
} from 'lucide-react';
import { api, downloadUrl } from '../lib/api';
import { useApp, useAsync } from '../lib/store';
import { faDigits, fmtDateTime, fmtDayLabel, fmtDuration, fmtMs, fmtNumber, fmtPct, fmtRelative, statusMeta } from '../lib/format';
import JalaliDateInput from '../components/JalaliDateInput';
import { jalaliDateRange } from '../lib/jalali';
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
  // بازهٔ سفارشی شمسی برای گزارش اصلی (اختیاری).
  const [fromIso, setFromIso] = useState('');
  const [toIso, setToIso] = useState('');
  const [installedFrom, setInstalledFrom] = useState(() => jalaliDateRange(3).from);
  const [installedTo, setInstalledTo] = useState(() => jalaliDateRange(3).to);

  const customFrom = fromIso ? Date.parse(`${fromIso}T00:00:00Z`) - tzOffset * 60000 : undefined;
  const customTo = toIso ? Date.parse(`${toIso}T23:59:59Z`) - tzOffset * 60000 : undefined;

  const { data, loading, error, refresh, updatedAt } = useAsync<ReportData>(
    (signal) =>
      api.report(
        {
          range,
          group,
          tag,
          device: deviceId || undefined,
          from: customFrom,
          to: customTo,
        },
        signal
      ),
    [range, group, tag, deviceId, customFrom, customTo]
  );

  const installations = useAsync(
    (signal) => api.installations({ from: installedFrom || undefined, to: installedTo || undefined, group, months: 3 }, signal),
    [installedFrom, installedTo, group]
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

  const exportUrl = (format: 'xlsx' | 'csv') =>
    downloadUrl('/reports/export', { format, range, group, tag, device: deviceId || undefined, from: customFrom, to: customTo });

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
          <div className="flex items-center gap-1.5">
            <div className="w-[150px]">
              <JalaliDateInput value={fromIso} onChange={setFromIso} placeholder="از تاریخ" ariaLabel="گزارش از تاریخ" />
            </div>
            <span className="text-[11px] text-ink-400">تا</span>
            <div className="w-[150px]">
              <JalaliDateInput value={toIso} onChange={setToIso} placeholder="تا تاریخ" ariaLabel="گزارش تا تاریخ" />
            </div>
          </div>
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

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-400">
        <span>
          {updatedAt ? `آخرین به‌روزرسانی گزارش: ${fmtRelative(updatedAt)}` : 'در حال آماده‌سازی گزارش…'}
        </span>
        {error ? <span className="text-sun-700">خطای به‌روزرسانی: {error} — دادهٔ قبلی نمایش داده می‌شود.</span> : null}
      </div>

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
            <StatCard
              label="میانگین زمان رفع (MTTR)"
              value={data.mttr?.avgSec != null ? fmtDuration(data.mttr.avgSec) : '—'}
              hint={`بر پایهٔ ${faDigits(data.mttr?.count ?? 0)} رخداد دارای تعمیر`}
              icon={<Timer size={20} />}
              tone="sun"
            />
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

          <Card padded={false} className="p-4">
            <CardHeader
              title="جزئیات MTTR"
              subtitle={data.mttr?.criteria ?? 'فقط قطعی‌های دارای تعمیر ثبت‌شده'}
              icon={<Timer size={18} />}
              action={<Badge tone="sun">{faDigits(data.mttr?.count ?? 0)} رخداد مبنا</Badge>}
            />
            <div className="mt-3 grid gap-2 sm:grid-cols-4">
              <div className="rounded-soft border border-ink-200 bg-white/70 px-3 py-2">
                <p className="text-[10px] text-ink-400">میانگین</p>
                <p className="num mt-0.5 text-[14px] font-semibold text-ink-800">{data.mttr?.avgSec != null ? fmtDuration(data.mttr.avgSec) : '—'}</p>
              </div>
              <div className="rounded-soft border border-ink-200 bg-white/70 px-3 py-2">
                <p className="text-[10px] text-ink-400">کوتاه‌ترین / بلندترین</p>
                <p className="num mt-0.5 text-[12px] font-semibold text-ink-800">
                  {data.mttr?.minSec != null ? fmtDuration(data.mttr.minSec) : '—'} / {data.mttr?.maxSec != null ? fmtDuration(data.mttr.maxSec) : '—'}
                </p>
              </div>
              <div className="rounded-soft border border-ink-200 bg-white/70 px-3 py-2">
                <p className="text-[10px] text-ink-400">قطعی‌های حذف‌شده (بدون تعمیر)</p>
                <p className="num mt-0.5 text-[14px] font-semibold text-sun-700">{faDigits(data.mttr?.excluded ?? 0)}</p>
              </div>
              <div className="rounded-soft border border-ink-200 bg-white/70 px-3 py-2">
                <p className="text-[10px] text-ink-400">کل قطعی‌های بسته‌شده در بازه</p>
                <p className="num mt-0.5 text-[14px] font-semibold text-ink-800">{faDigits(data.mttr?.totalOutages ?? 0)}</p>
              </div>
            </div>
            {(data.mttr?.events ?? []).length ? (
              <div className="mt-3 table-wrap max-h-[340px]">
                <table className="table">
                  <thead>
                    <tr>
                      <th>تجهیز</th>
                      <th>شروع قطعی</th>
                      <th>وصل مجدد</th>
                      <th>مدت (MTTR)</th>
                      <th>اقدام تعمیر</th>
                      <th>تکنسین</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.mttr?.events ?? []).slice(0, 100).map((e) => (
                      <tr key={e.outageId}>
                        <td>
                          <Link to={`/devices/${e.deviceId}`} className="font-medium text-ink-800 hover:text-brand-700">
                            {e.deviceName}
                          </Link>
                          <span className="num block text-[10px] text-ink-400">{e.ip}</span>
                        </td>
                        <td className="text-[11px]">{fmtDateTime(e.startedAt, tzOffset)}</td>
                        <td className="text-[11px]">{fmtDateTime(e.endedAt, tzOffset)}</td>
                        <td className="num">{fmtDuration(e.durationSec)}</td>
                        <td className="text-[11px]">{e.action || '—'}</td>
                        <td className="text-[11px]">{e.technician || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState
                title="رخداد تعمیرشده‌ای در بازه نیست"
                description="MTTR فقط قطعی‌هایی را حساب می‌کند که تعمیر به آن‌ها متصل شده باشد؛ از صفحهٔ تعمیرات، رکورد تعمیر را به قطعی مرتبط کنید."
                icon={<Wrench size={20} />}
              />
            )}
            {data.mttr?.eventsTruncated ? <p className="mt-2 text-[10px] text-ink-400">برای عملکرد بهتر، فهرست نمایش محدود شده است؛ میانگین بر همهٔ رخدادها محاسبه شده است.</p> : null}
          </Card>

          <Card padded={false} className="p-4">
            <CardHeader
              title="گزارش تجهیزات بر اساس تاریخ نصب"
              subtitle={`${faDigits(installations.data?.total ?? 0)} تجهیز در بازه — پیش‌فرض سه ماه اخیر (شمسی)`}
              icon={<CalendarClock size={18} />}
              action={
                <a
                  className="btn-ghost btn-xs"
                  href={downloadUrl('/reports/installations/export', {
                    format: 'xlsx',
                    from: installedFrom || undefined,
                    to: installedTo || undefined,
                    group,
                    months: 3,
                  })}
                >
                  <Download size={13} /> خروجی Excel
                </a>
              }
            />
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <div className="w-[170px]">
                <JalaliDateInput value={installedFrom} onChange={setInstalledFrom} placeholder="از تاریخ نصب" ariaLabel="نصب از تاریخ" />
              </div>
              <span className="mb-2 text-[11px] text-ink-400">تا</span>
              <div className="w-[170px]">
                <JalaliDateInput value={installedTo} onChange={setInstalledTo} placeholder="تا تاریخ نصب" ariaLabel="نصب تا تاریخ" />
              </div>
              <button
                type="button"
                className="btn-ghost btn-xs mb-1"
                onClick={() => {
                  const r = jalaliDateRange(3);
                  setInstalledFrom(r.from);
                  setInstalledTo(r.to);
                }}
              >
                سه ماه اخیر
              </button>
            </div>
            {(installations.data?.items ?? []).length ? (
              <div className="mt-3 table-wrap max-h-[360px]">
                <table className="table">
                  <thead>
                    <tr>
                      <th>تجهیز</th>
                      <th>نوع</th>
                      <th>گروه</th>
                      <th>محل</th>
                      <th>تاریخ نصب (شمسی)</th>
                      <th>وضعیت</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(installations.data?.items ?? []).map((r) => (
                      <tr key={r.id}>
                        <td>
                          <Link to={`/devices/${r.id}`} className="font-medium text-ink-800 hover:text-brand-700">
                            {r.name}
                          </Link>
                          <span className="num block text-[10px] text-ink-400">{r.ip}</span>
                        </td>
                        <td className="text-[11px]">{r.deviceType}</td>
                        <td className="text-[11px]">{r.groupName ?? '—'}</td>
                        <td className="text-[11px]">{r.location || '—'}</td>
                        <td className="num">{faDigits(r.installedAtLabel)}</td>
                        <td>
                          <StatusPill status={r.status} size="sm" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState
                title="تجهیزی در این بازه نصب نشده"
                description="تاریخ نصب را در فرم هر تجهیز ثبت کنید تا در این گزارش لحاظ شود."
                icon={<ClipboardList size={20} />}
              />
            )}
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
  const { data } = useAsync((signal) => api.devices({ pageSize: 500, sort: 'name' }, signal), []);
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
