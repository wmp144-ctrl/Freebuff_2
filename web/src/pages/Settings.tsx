import React, { useEffect, useState } from 'react';
import {
  Activity,
  Database,
  Gamepad2,
  Layers,
  LayoutGrid,
  Map as MapIcon,
  MonitorSmartphone,
  Palette,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  Settings2,
  Tag as TagIcon,
  Trash2,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { api } from '../lib/api';
import { MODE_LABEL } from '../components/Layout';
import { useApp, useAsync, useToast } from '../lib/store';
import { faDigits, fmtDateTime, fmtNumber, fmtRelative } from '../lib/format';
import { Badge, Card, CardHeader, EmptyState, Field, Modal, PageLoader, Toggle } from '../components/ui';
import { WidgetVisibilityRow, useWidgetLayout } from '../components/widgets';
import { DETAIL_WIDGETS, DASHBOARD_WIDGETS } from '../lib/widgetdefs';
import type { AppSettings } from '../lib/types';

type TabKey = 'general' | 'engine' | 'display' | 'groups' | 'tags' | 'layers' | 'widgets' | 'repair' | 'data';

export default function Settings() {
  const { settings, saveSettings, refreshSettings, meta, refreshMeta, engine } = useApp();
  const { push } = useToast();
  const [tab, setTab] = useState<TabKey>('general');
  const [local, setLocal] = useState<AppSettings | null>(settings);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings) setLocal(settings);
  }, [settings]);

  const { data: engineData, refresh: refreshEngine } = useAsync((signal) => api.engineStatus(signal), [], { interval: 15000 });
  const { data: layersData, refresh: refreshLayers } = useAsync((signal) => api.layers(signal), []);
  const { data: retentionData, refresh: refreshRetention } = useAsync(
    (signal) => api.retentionStatus(signal),
    [],
    { interval: 15000 }
  );
  const { data: backupData, refresh: refreshBackup } = useAsync(
    (signal) => api.backupStatus(signal),
    [],
    { interval: 30000 }
  );

  if (!local) return <PageLoader label="در حال دریافت تنظیمات…" />;

  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => setLocal((s) => (s ? { ...s, [k]: v } : s));

  const persist = async (patch?: Partial<AppSettings>) => {
    // ذخیرهٔ مکرر تنظیمات با کلیک سریع، چند PUT پشت‌سرهم می‌فرستاد
    if (saving) return;
    setSaving(true);
    try {
      await saveSettings(patch ?? local);
      push('تنظیمات ذخیره شد', 'success');
      refreshEngine();
    } catch (e) {
      push((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const tabs: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: 'general', label: 'عمومی', icon: <Settings2 size={14} /> },
    { key: 'engine', label: 'موتور مانیتورینگ', icon: <Activity size={14} /> },
    { key: 'display', label: 'نمایش و نقشه', icon: <Palette size={14} /> },
    { key: 'groups', label: 'گروه‌ها', icon: <Layers size={14} /> },
    { key: 'tags', label: 'تگ‌ها', icon: <TagIcon size={14} /> },
    { key: 'layers', label: 'لایه‌های نقشه', icon: <MapIcon size={14} /> },
    { key: 'widgets', label: 'چیدمان ویجت‌ها', icon: <LayoutGrid size={14} /> },
    { key: 'repair', label: 'علت‌ها و اقدامات', icon: <Wrench size={14} /> },
    { key: 'data', label: 'داده‌ها و نگهداری', icon: <Database size={14} /> },
  ];

  return (
    <div className="space-y-4">
      <Card padded={false} className="p-2">
        <div className="flex flex-wrap items-center gap-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-1.5 rounded-soft px-3.5 py-2 text-[12.5px] font-medium transition ${
                tab === t.key ? 'bg-brand-50 text-brand-700 border border-brand-100' : 'text-ink-500 hover:bg-ink-50'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
          <button type="button" className="btn-primary btn-xs ms-auto" onClick={() => persist()} disabled={saving}>
            <Save size={14} />
            {saving ? 'در حال ذخیره…' : 'ذخیره تنظیمات'}
          </button>
        </div>
      </Card>

      {tab === 'general' ? (
        <div className="grid gap-5 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader title="تنظیمات عمومی" subtitle="نام سامانه و قالب نمایش تاریخ" icon={<Settings2 size={18} />} />
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="نام سامانه / مرکز پایش">
                <input className="field" value={local.site_name} onChange={(e) => set('site_name', e.target.value)} />
              </Field>
              <Field label="قالب تقویم">
                <select className="field" value={local.calendar} onChange={(e) => set('calendar', e.target.value as AppSettings['calendar'])}>
                  <option value="jalali">شمسی (هجری خورشیدی)</option>
                  <option value="gregorian">میلادی</option>
                </select>
              </Field>
              <Field label="اختلاف زمانی نمایش (دقیقه)" hint="برای منطقه زمانی ایران: ۲۱۰ دقیقه">
                <input type="number" dir="ltr" className="field num" value={local.timezone_offset_minutes} onChange={(e) => set('timezone_offset_minutes', Number(e.target.value) || 0)} />
              </Field>
              <Field label="بازه پیش‌فرض نمودارها">
                <select className="field" value={local.chart_default_range} onChange={(e) => set('chart_default_range', e.target.value as AppSettings['chart_default_range'])}>
                  <option value="15m">۱۵ دقیقه</option>
                  <option value="1h">۱ ساعت</option>
                  <option value="6h">۶ ساعت</option>
                  <option value="24h">۲۴ ساعت</option>
                  <option value="7d">۷ روز</option>
                </select>
              </Field>
              <div className="sm:col-span-2 grid gap-3 sm:grid-cols-2">
                <Toggle checked={local.notify_browser} onChange={(v) => set('notify_browser', v)} label="نمایش اعلان هشدارها در رابط کاربری" hint="هشدارهای جدید به‌صورت پیام کوتاه نمایش داده می‌شوند" />
                <Toggle checked={local.engine_enabled} onChange={(v) => set('engine_enabled', v)} label="موتور مانیتورینگ فعال باشد" hint="غیرفعال کردن، بررسی خودکار تجهیزات را متوقف می‌کند" />
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="وضعیت موتور مانیتورینگ" subtitle="کنترل اجرای مستقل موتور" icon={<Activity size={18} />} />
            <div className="mt-4 space-y-3">
              <div className="flex items-center justify-between rounded-soft bg-ink-50 px-3 py-2.5">
                <span className="text-[12px] text-ink-500">وضعیت</span>
                <Badge tone={engineData?.running ? 'emerald' : 'red'}>{engineData?.running ? 'در حال اجرا' : 'متوقف'}</Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11.5px]">
                <InfoCell label="حالت" value={MODE_LABEL[engineData?.mode ?? ''] ?? '—'} />
                <InfoCell label="بازه بررسی" value={`${faDigits(engineData?.interval ?? 0)} ثانیه`} />
                <InfoCell label="چرخه‌ها" value={fmtNumber(engineData?.cycles ?? 0)} />
                <InfoCell label="بررسی‌ها" value={fmtNumber(engineData?.checksRun ?? 0)} />
                <InfoCell label="همزمانی" value={fmtNumber(engineData?.maxWorkers ?? 0)} />
                <InfoCell label="در حال اجرا" value={fmtNumber(engineData?.inflight ?? 0)} />
                <InfoCell label="رد شده" value={fmtNumber(engineData?.skipped ?? 0)} />
                <InfoCell label="خطاها" value={fmtNumber(engineData?.errors ?? 0)} />
              </div>
              <div className="rounded-soft border border-ink-200 bg-white/70 p-3 text-[11px] text-ink-500">
                <p className="flex items-center justify-between">
                  <span>دسترسی ICMP</span>
                  <Badge tone={engineData?.icmpAvailable ? 'emerald' : 'sun'}>{engineData?.icmpAvailable ? 'فعال' : 'در دسترس نیست'}</Badge>
                </p>
                <p className="mt-2 leading-relaxed">
                  در صورت در دسترس نبودن ICMP (نبود مجوز RAW socket)، بررسی‌ها روی TCP انجام می‌شود. برای ICMP واقعی، برنامه را با دسترسی مناسب اجرا کنید.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-soft btn-xs" onClick={async () => { await api.engineControl('restart'); push('موتور بازراه‌اندازی شد', 'success'); refreshEngine(); }}>
                  <RotateCcw size={13} />
                  بازراه‌اندازی
                </button>
                <button type="button" className="btn-ghost btn-xs" onClick={async () => { await api.engineControl('start'); refreshEngine(); }}>
                  <Play size={13} />
                  شروع
                </button>
                <button type="button" className="btn-ghost btn-xs" onClick={async () => { await api.engineControl('stop'); refreshEngine(); }}>
                  <Pause size={13} />
                  توقف
                </button>
                <button type="button" className="btn-ghost btn-xs" onClick={async () => { const r = await api.checkAll(); push(`بررسی همه تجهیزات آغاز شد (${faDigits(r.queued)} تجهیز)`, 'success'); refreshEngine(); }}>
                  <RefreshCw size={13} />
                  بررسی همه تجهیزات
                </button>
              </div>
            </div>
          </Card>
        </div>
      ) : null}

      {tab === 'engine' ? (
        <div className="grid gap-5 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader title="تنظیمات موتور مانیتورینگ" subtitle="کنترل بازه‌ها، آستانه‌ها و تشخیص وضعیت" icon={<Activity size={18} />} />
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="حالت بررسی" hint="auto: ICMP و در صورت نبود مجوز TCP؛ simulate: داده نمونه">
                <select className="field" value={local.engine_mode} onChange={(e) => set('engine_mode', e.target.value as AppSettings['engine_mode'])}>
                  <option value="auto">خودکار (ICMP/TCP)</option>
                  <option value="icmp">فقط ICMP</option>
                  <option value="tcp">فقط TCP</option>
                  <option value="simulate">شبیه‌سازی (دمو)</option>
                </select>
              </Field>
              <Field label="بازه پیش‌فرض Ping (ثانیه)">
                <input type="number" min={5} dir="ltr" className="field num" value={local.ping_interval} onChange={(e) => set('ping_interval', Number(e.target.value) || 30)} />
              </Field>
              <Field label="زمان انتظار پاسخ (ms)">
                <input type="number" min={100} dir="ltr" className="field num" value={local.timeout_ms} onChange={(e) => set('timeout_ms', Number(e.target.value) || 1200)} />
              </Field>
              <Field label="تعداد تلاش مجدد">
                <input type="number" min={0} max={5} dir="ltr" className="field num" value={local.retries} onChange={(e) => set('retries', Number(e.target.value) || 0)} />
              </Field>
              <Field label="تعداد Packet در هر بررسی">
                <input type="number" min={1} max={10} dir="ltr" className="field num" value={local.packet_count} onChange={(e) => set('packet_count', Number(e.target.value) || 1)} />
              </Field>
              <Field label="حداکثر همزمانی (تجهیز)">
                <input type="number" min={1} max={512} dir="ltr" className="field num" value={local.max_workers} onChange={(e) => set('max_workers', Number(e.target.value) || 64)} />
              </Field>
              <Field label="آستانه مجاز تأخیر (ms)">
                <input type="number" min={1} dir="ltr" className="field num" value={local.latency_threshold} onChange={(e) => set('latency_threshold', Number(e.target.value) || 150)} />
              </Field>
              <Field label="آستانه مجاز افت بسته (٪)">
                <input type="number" min={0} max={100} dir="ltr" className="field num" value={local.loss_threshold} onChange={(e) => set('loss_threshold', Number(e.target.value) || 10)} />
              </Field>
              <Field label="شکست متوالی برای Offline">
                <input type="number" min={1} dir="ltr" className="field num" value={local.failures_for_offline} onChange={(e) => set('failures_for_offline', Number(e.target.value) || 3)} />
              </Field>
              <Field label="پاسخ موفق متوالی برای Recovery">
                <input type="number" min={1} dir="ltr" className="field num" value={local.successes_for_online} onChange={(e) => set('successes_for_online', Number(e.target.value) || 2)} />
              </Field>
              <Field label="پورت بررسی TCP">
                <input type="number" min={1} max={65535} dir="ltr" className="field num" value={local.tcp_port} onChange={(e) => set('tcp_port', Number(e.target.value) || 80)} />
              </Field>
            </div>
            <p className="mt-4 rounded-soft border border-brand-100 bg-brand-50/60 p-3 text-[11.5px] leading-relaxed text-brand-800">
              بازه بررسی را می‌توان برای هر گروه یا هر تجهیز به‌صورت مستقل تعیین کرد (از صفحه ویرایش تجهیز یا ویرایش گروهی). مقدار تعریف‌شده در تجهیز، بر مقدار عمومی اولویت دارد.
            </p>
          </Card>

          <Card>
            <CardHeader title="آخرین رویدادهای موتور" subtitle="گزارش فعالیت و خطاها" icon={<MonitorSmartphone size={18} />} action={<button type="button" className="btn-ghost btn-xs" onClick={refreshEngine}><RefreshCw size={13} /></button>} />
            <div className="mt-3 max-h-[460px] space-y-2 overflow-y-auto">
              {(engineData?.lastLogs ?? []).map((l, i) => (
                <div key={i} className="rounded-soft border border-ink-100 bg-white/70 px-3 py-2">
                  <p className="text-[11.5px] text-ink-600">{l.message}</p>
                  <p className="mt-0.5 text-[10px] text-ink-400">
                    {fmtDateTime(l.ts, local.timezone_offset_minutes)} · {l.level}
                  </p>
                </div>
              ))}
              {(engineData?.lastLogs ?? []).length === 0 ? <EmptyState title="رویدادی ثبت نشده" /> : null}
            </div>
          </Card>
        </div>
      ) : null}

      {tab === 'display' ? (
        <Card>
          <CardHeader title="نمایش، نقشه و تجربه کاربری" subtitle="تنظیمات ظاهری و پیش‌فرض‌های نقشه" icon={<Palette size={18} />} />
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="عرض جغرافیایی مرکز نقشه">
              <input dir="ltr" className="field num" value={local.map_default_center?.[0] ?? 35.6892} onChange={(e) => set('map_default_center', [Number(e.target.value) || 0, local.map_default_center?.[1] ?? 51.389])} />
            </Field>
            <Field label="طول جغرافیایی مرکز نقشه">
              <input dir="ltr" className="field num" value={local.map_default_center?.[1] ?? 51.389} onChange={(e) => set('map_default_center', [local.map_default_center?.[0] ?? 35.6892, Number(e.target.value) || 0])} />
            </Field>
            <Field label="زوم پیش‌فرض نقشه">
              <input type="number" min={2} max={18} dir="ltr" className="field num" value={local.map_default_zoom} onChange={(e) => set('map_default_zoom', Number(e.target.value) || 6)} />
            </Field>
            <div className="sm:col-span-2 lg:col-span-3">
              <Toggle checked={local.map_show_labels} onChange={(v) => set('map_show_labels', v)} label="نمایش برچسب تگ‌ها روی نشانگرهای نقشه" hint="تگ‌هایی که گزینه نمایش روی نقشه دارند به‌صورت برچسب کنار نشانگر نمایش داده می‌شوند" />
            </div>
          </div>
        </Card>
      ) : null}

      {tab === 'groups' ? <GroupsTab /> : null}
      {tab === 'tags' ? <TagsTab /> : null}
      {tab === 'layers' ? <LayersTab /> : null}
      {tab === 'widgets' ? <WidgetLayoutTab /> : null}
      {tab === 'repair' ? <RepairTab local={local} set={set} persist={persist} saving={saving} /> : null}

      {tab === 'data' ? (
        <div className="grid gap-5 xl:grid-cols-2">
          <Card>
            <CardHeader title="سیاست نگهداری داده" subtitle="Data Retention Policy — قابل تنظیم و ثبت‌شده در Audit Log" icon={<Database size={18} />} />
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2 space-y-2">
                <Toggle checked={local.retention_enabled} onChange={(v) => set('retention_enabled', v)} label="اجرای خودکار Retention فعال باشد" hint="با غیرفعال‌کردن، هیچ حذف خودکاری انجام نمی‌شود (اجرای دستی مدیر همچنان ممکن است)" />
                <Toggle checked={local.retention_legal_hold} onChange={(v) => set('retention_legal_hold', v)} label="الزام قانونی نگهداری (Legal Hold)" hint="در صورت فعال‌بودن، هیچ داده‌ای حذف نمی‌شود تا مدیر سیاست را آگاهانه تغییر دهد" />
              </div>
              <Field label="زمان اجرای روزانه" hint="به وقت محلی تنظیمات (HH:MM)">
                <input dir="ltr" className="field num" value={local.retention_run_time} onChange={(e) => set('retention_run_time', e.target.value)} />
              </Field>
              <Field label="حداقل فاصلهٔ اجرا (دقیقه)">
                <input type="number" min={15} dir="ltr" className="field num" value={local.retention_interval_minutes} onChange={(e) => set('retention_interval_minutes', Number(e.target.value) || 1440)} />
              </Field>
              <Field label="اندازهٔ هر Batch (رکورد)">
                <input type="number" min={100} max={50000} dir="ltr" className="field num" value={local.retention_batch_size} onChange={(e) => set('retention_batch_size', Number(e.target.value) || 5000)} />
              </Field>
              <Field label="سقف رکورد در هر اجرا">
                <input type="number" min={1000} dir="ltr" className="field num" value={local.retention_max_rows_per_run} onChange={(e) => set('retention_max_rows_per_run', Number(e.target.value) || 100000)} />
              </Field>
              <Field label="نمونه‌های خام (روز)" hint="پیش از حذف، آمار روزانه تثبیت می‌شود">
                <input type="number" min={1} max={3650} dir="ltr" className="field num" value={local.samples_retention_days} onChange={(e) => set('samples_retention_days', Number(e.target.value) || 90)} />
              </Field>
              <Field label="آمار روزانه (روز)" hint="حداقل ۳۶۵ روز">
                <input type="number" min={365} dir="ltr" className="field num" value={local.daily_stats_retention_days} onChange={(e) => set('daily_stats_retention_days', Number(e.target.value) || 365)} />
              </Field>
              <Field label="قطعی‌ها (روز)" hint="حداقل ۳۶۵ روز؛ قطعی باز هرگز حذف نمی‌شود">
                <input type="number" min={365} dir="ltr" className="field num" value={local.outages_retention_days} onChange={(e) => set('outages_retention_days', Number(e.target.value) || 365)} />
              </Field>
              <Field label="هشدارها (روز)" hint="هشدار حل‌نشده هرگز حذف نمی‌شود">
                <input type="number" min={30} dir="ltr" className="field num" value={local.alerts_retention_days} onChange={(e) => set('alerts_retention_days', Number(e.target.value) || 180)} />
              </Field>
              <Field label="گزارش حسابرسی (روز)" hint="حداقل ۳۶۵ روز">
                <input type="number" min={365} dir="ltr" className="field num" value={local.audit_retention_days} onChange={(e) => set('audit_retention_days', Number(e.target.value) || 365)} />
              </Field>
              <Field label="لاگ موتور (روز)">
                <input type="number" min={7} dir="ltr" className="field num" value={local.engine_log_retention_days} onChange={(e) => set('engine_log_retention_days', Number(e.target.value) || 30)} />
              </Field>
              <div className="sm:col-span-2">
                <Toggle checked={local.retention_prune_backups} onChange={(v) => set('retention_prune_backups', v)} label="Retention فایل‌های پشتیبان را هم هرس کند" hint="پیش‌فرض خاموش است؛ هرس پشتیبان با سیاست مستقل ۷ روزانه + ۴ هفتگی انجام می‌شود" />
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="وضعیت Retention Engine"
              subtitle={`آخرین اجرا: ${retentionData?.lastRun ? fmtDateTime(retentionData.lastRun.startedAt, local.timezone_offset_minutes) : '—'}`}
              icon={<Activity size={18} />}
              action={<button type="button" className="btn-ghost btn-xs" onClick={refreshRetention}><RefreshCw size={13} /></button>}
            />
            <div className="mt-4 space-y-3">
              <div className="flex items-center justify-between rounded-soft bg-ink-50 px-3 py-2.5">
                <span className="text-[12px] text-ink-500">وضعیت</span>
                <Badge tone={retentionData?.running ? 'sun' : retentionData?.lastRun?.status === 'failed' ? 'red' : 'emerald'}>
                  {retentionData?.running ? 'در حال اجرا' : retentionData?.lastRun?.status ?? 'بدون اجرا'}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11.5px]">
                <InfoCell label="اجرای بعدی" value={retentionData ? fmtDateTime(retentionData.nextRunAt, local.timezone_offset_minutes) : '—'} />
                <InfoCell label="قفل" value={retentionData?.lock?.owner ? (retentionData.lock.heldByThisProcess ? 'این نمونه' : 'نمونهٔ دیگر') : 'آزاد'} />
                <InfoCell label="رکورد حذف‌شده (آخرین)" value={fmtNumber(retentionData?.lastRun?.deletedRows ?? 0)} />
                <InfoCell label="فضای آزادشده" value={fmtNumber(Math.round((retentionData?.lastRun?.freedBytes ?? 0) / 1024)) + ' KB'} />
                <InfoCell label="حجم پایگاه‌داده" value={fmtNumber(Math.round((retentionData?.storage?.dbBytes ?? 0) / 1024 / 1024)) + ' MB'} />
                <InfoCell label="WAL" value={fmtNumber(Math.round((retentionData?.storage?.walBytes ?? 0) / 1024)) + ' KB'} />
              </div>
              {retentionData?.lastRun?.error ? (
                <p className="rounded-soft border border-red-100 bg-red-50/60 p-2 text-[11px] text-red-700">{retentionData.lastRun.error}</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-soft btn-xs"
                  onClick={async () => {
                    try {
                      const r = await api.runRetention(true);
                      push(`Dry-Run: ${faDigits(r.deletedRows)} رکورد قابل حذف است`, 'success');
                      refreshRetention();
                    } catch (e) {
                      push((e as Error).message, 'error');
                    }
                  }}
                >
                  Dry-Run
                </button>
                <button
                  type="button"
                  className="btn-primary btn-xs"
                  onClick={async () => {
                    if (!window.confirm('اجرای Retention اکنون انجام شود؟')) return;
                    try {
                      const r = await api.runRetention(false);
                      push(`Retention: ${faDigits(r.deletedRows)} رکورد حذف شد`, 'success');
                      refreshRetention();
                    } catch (e) {
                      push((e as Error).message, 'error');
                    }
                  }}
                >
                  <Play size={13} />
                  اجرای دستی
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-xs"
                  onClick={async () => {
                    try {
                      await api.stopRetention();
                      push('درخواست توقف ثبت شد', 'success');
                      refreshRetention();
                    } catch (e) {
                      push((e as Error).message, 'error');
                    }
                  }}
                >
                  <Pause size={13} />
                  توقف
                </button>
              </div>
              <div className="rounded-soft border border-ink-200 bg-white/70 p-3 text-[11px] leading-relaxed text-ink-500">
                هر Batch در تراکنش مستقل اجرا می‌شود؛ پیش از حذف نمونه‌ها، آمار روزانه تثبیت می‌شود و داده‌های دارای قطعی باز یا هشدار حل‌نشده حفظ می‌شوند.
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="پشتیبان‌گیری" subtitle="نسخه‌های معتبر با Manifest و Checksum" icon={<Server size={18} />} />
            <div className="mt-4 space-y-3">
              <div className="grid grid-cols-2 gap-2 text-[11.5px]">
                <InfoCell label="تعداد نسخه‌ها" value={fmtNumber(backupData?.status?.count ?? 0)} />
                <InfoCell label="آخرین نسخه" value={backupData?.status?.lastBackupAt ? fmtRelative(backupData.status.lastBackupAt) : '—'} />
                <InfoCell label="نسخهٔ برنامه" value={backupData?.status?.appVersion ?? '—'} />
                <InfoCell label="نسخهٔ Schema" value={faDigits(backupData?.status?.schemaVersion ?? 0)} />
                <InfoCell label="وضعیت Restore" value={backupData?.status?.restore?.status ?? 'never'} />
                <InfoCell label="فضای آزاد دیسک" value={fmtNumber(Math.round((backupData?.status?.freeBytes ?? 0) / 1024 / 1024)) + ' MB'} />
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="نسخهٔ روزانه">
                  <input type="number" min={1} max={60} dir="ltr" className="field num" value={local.backup_daily_keep} onChange={(e) => set('backup_daily_keep', Number(e.target.value) || 7)} />
                </Field>
                <Field label="نسخهٔ هفتگی">
                  <input type="number" min={0} max={52} dir="ltr" className="field num" value={local.backup_weekly_keep} onChange={(e) => set('backup_weekly_keep', Number(e.target.value) || 0)} />
                </Field>
                <Field label="فاصلهٔ پشتیبان (ساعت)">
                  <input type="number" min={1} max={168} dir="ltr" className="field num" value={local.backup_interval_hours} onChange={(e) => set('backup_interval_hours', Number(e.target.value) || 24)} />
                </Field>
              </div>
              <div className="space-y-2">
                <Toggle checked={local.backup_enabled} onChange={(v) => set('backup_enabled', v)} label="پشتیبان‌گیری خودکار فعال باشد" />
                <Toggle checked={local.backup_prune_enabled} onChange={(v) => set('backup_prune_enabled', v)} label="هرس خودکار نسخه‌های قدیمی (۷ روزانه + ۴ هفتگی)" />
              </div>
              <button
                type="button"
                className="btn-soft btn-xs"
                onClick={async () => {
                  try {
                    const r = await api.createBackup();
                    push(`پشتیبان «${r.name}» ساخته شد`, 'success');
                    refreshBackup();
                  } catch (e) {
                    push((e as Error).message, 'error');
                  }
                }}
              >
                <Database size={13} />
                ساخت پشتیبان اکنون
              </button>
              <p className="text-[11px] leading-relaxed text-ink-400">
                مسیر داده‌ها: <span className="num" dir="ltr">data/netwatch.db</span> — هر مجموعهٔ پشتیبان شامل Manifest با زمان، نسخهٔ برنامه، نسخهٔ Schema، اندازه و SHA-256 است. پیش از بازیابی، Checksum و Integrity بررسی و از نسخهٔ فعلی یک نسخهٔ ایمنی ساخته می‌شود.
              </p>
            </div>
          </Card>

          <Card>
            <CardHeader title="بازنشانی داده‌های نمونه" subtitle="بازگرداندن سامانه به داده‌های نمایشی اولیه" icon={<TriangleAlert size={18} />} />
            <div className="mt-4 space-y-3">
              <div className="rounded-soft border border-red-100 bg-red-50/60 p-3 text-[11.5px] leading-relaxed text-red-700">
                هشدار: با بازنشانی، تمام تجهیزات، سوابق قطعی، هشدارها و سوابق تعمیرات فعلی حذف و داده‌های نمونه جایگزین می‌شوند. این عملیات بازگشت‌پذیر نیست؛ پیش از آن پشتیبان بگیرید.
              </div>
              <button
                type="button"
                className="btn-danger btn-xs"
                onClick={async () => {
                  if (!window.confirm('همه داده‌های فعلی حذف و داده‌های نمونه بازنشانی شود؟')) return;
                  if (!window.confirm('تأیید نهایی: این عملیات غیرقابل بازگشت است.')) return;
                  try {
                    await api.resetDemo();
                    push('داده‌های نمونه بازنشانی شد — موتور در حال راه‌اندازی مجدد است', 'success');
                    await refreshSettings();
                    await refreshMeta();
                    refreshLayers();
                  } catch (e) {
                    push((e as Error).message, 'error');
                  }
                }}
              >
                <Trash2 size={13} />
                بازنشانی کامل داده‌ها
              </button>
              <div className="flex items-center gap-2 text-[11px] text-ink-400">
                <Gamepad2 size={13} />
                حالت فعلی بررسی: {MODE_LABEL[local.engine_mode] ?? local.engine_mode}
                {local.engine_mode === 'simulate' ? ' — داده‌ها شبیه‌سازی می‌شوند (مناسب دمو)' : ' — بررسی واقعی تجهیزات انجام می‌شود'}
              </div>
            </div>
          </Card>
        </div>
      ) : null}

      <div className="flex items-center justify-between rounded-card border border-white/70 bg-white/80 px-4 py-3 text-[11.5px] text-ink-500">
        <span className="inline-flex items-center gap-1.5">
          <Server size={13} />
          {engine?.running ? 'موتور مانیتورینگ در حال اجرا است' : 'موتور مانیتورینگ متوقف است'}
        </span>
        <span className="text-ink-400">آخرین بروزرسانی: {fmtRelative(engineData?.lastRunAt ?? null)}</span>
      </div>
    </div>
  );
}

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-soft border border-ink-200 bg-white/70 px-2.5 py-2">
      <p className="text-[10.5px] text-ink-400">{label}</p>
      <p className="num mt-0.5 text-[12px] font-semibold text-ink-700">{value}</p>
    </div>
  );
}

/* ------------------------------- Groups ------------------------------- */
function GroupsTab() {
  const { push } = useToast();
  const { refreshMeta } = useApp();
  const { data, refresh } = useAsync((signal) => api.groups(signal), []);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{ id: number; name: string; description: string; color: string } | null>(null);

  const save = async () => {
    if (!editing) return;
    try {
      if (editing.id) await api.updateGroup(editing.id, editing);
      else await api.createGroup(editing);
      push('گروه ذخیره شد', 'success');
      setOpen(false);
      setEditing(null);
      refresh();
      refreshMeta();
    } catch (e) {
      push((e as Error).message, 'error');
    }
  };

  return (
    <Card>
      <CardHeader
        title="مدیریت گروه‌های تجهیزات"
        subtitle="دسته‌بندی تجهیزات در گروه‌های مختلف و تعیین بازه بررسی مستقل"
        icon={<Layers size={18} />}
        action={
          <button type="button" className="btn-soft btn-xs" onClick={() => { setEditing({ id: 0, name: '', description: '', color: '#2563eb' }); setOpen(true); }}>
            <Plus size={13} />
            گروه جدید
          </button>
        }
      />
      <div className="mt-4 space-y-3">
        {(data?.items ?? []).map((g) => (
          <div key={g.id} className="flex flex-wrap items-center justify-between gap-3 rounded-soft border border-ink-200 bg-white/70 p-3">
            <div className="flex items-center gap-3">
              <span className="h-8 w-8 rounded-soft" style={{ background: `${g.color}22`, border: `1px solid ${g.color}55` }} />
              <div>
                <p className="text-[12.5px] font-semibold text-ink-700">{g.name}</p>
                <p className="mt-0.5 text-[11px] text-ink-500">{g.description || '—'}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink-500">
              <span className="num">{faDigits(g.device_count ?? 0)} تجهیز</span>
              <span className="num text-emerald-600">{faDigits(g.online ?? 0)} در دسترس</span>
              <span className="num text-sun-600">{faDigits(g.warning ?? 0)} اختلال</span>
              <span className="num text-red-600">{faDigits(g.offline ?? 0)} قطع</span>
              <button type="button" className="btn-ghost btn-xs" onClick={() => { setEditing({ id: g.id, name: g.name, description: g.description, color: g.color }); setOpen(true); }}>
                ویرایش
              </button>
              <button
                type="button"
                className="btn-danger btn-xs"
                onClick={async () => {
                  if (!window.confirm(`حذف گروه «${g.name}»؟ تجهیزات این گروه بدون گروه خواهند شد.`)) return;
                  try {
                    await api.deleteGroup(g.id);
                    refresh();
                    refreshMeta();
                  } catch (e) {
                    push((e as Error).message, 'error');
                  }
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}
        {(data?.items ?? []).length === 0 ? <EmptyState title="گروهی تعریف نشده است" /> : null}
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing?.id ? 'ویرایش گروه' : 'افزودن گروه جدید'}
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              انصراف
            </button>
            <button type="button" className="btn-primary" onClick={save}>
              ذخیره
            </button>
          </>
        }
      >
        {editing ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="نام گروه" required>
              <input className="field" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label="رنگ گروه">
              <input type="color" className="field h-10 p-1" value={editing.color} onChange={(e) => setEditing({ ...editing, color: e.target.value })} />
            </Field>
            <Field label="توضیحات" className="sm:col-span-2">
              <textarea className="field min-h-[70px]" value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </Field>
          </div>
        ) : null}
      </Modal>
    </Card>
  );
}

/* -------------------------------- Tags -------------------------------- */
function TagsTab() {
  const { push } = useToast();
  const { refreshMeta } = useApp();
  const { data, refresh } = useAsync((signal) => api.tags(signal), []);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{ id: number; name: string; color: string; show_on_map: number } | null>(null);

  const save = async () => {
    if (!editing) return;
    try {
      if (editing.id) await api.updateTag(editing.id, editing);
      else await api.createTag(editing);
      push('تگ ذخیره شد', 'success');
      setOpen(false);
      refresh();
      refreshMeta();
    } catch (e) {
      push((e as Error).message, 'error');
    }
  };

  return (
    <Card>
      <CardHeader
        title="مدیریت تگ‌ها"
        subtitle="تگ‌گذاری تجهیزات و کنترل نمایش آن‌ها روی نقشه"
        icon={<TagIcon size={18} />}
        action={
          <button type="button" className="btn-soft btn-xs" onClick={() => { setEditing({ id: 0, name: '', color: '#f59e0b', show_on_map: 1 }); setOpen(true); }}>
            <Plus size={13} />
            تگ جدید
          </button>
        }
      />
      <div className="mt-4 flex flex-wrap gap-2">
        {(data?.items ?? []).map((t) => (
          <div key={t.id} className="flex items-center gap-2 rounded-soft border border-ink-200 bg-white/70 px-3 py-2">
            <span className="chip" style={{ borderColor: `${t.color}44`, background: `${t.color}12`, color: t.color }}>
              {t.name}
            </span>
            <span className="num text-[10.5px] text-ink-400">{faDigits(t.device_count ?? 0)} تجهیز</span>
            {t.show_on_map ? <Badge tone="brand">روی نقشه</Badge> : null}
            <button type="button" className="btn-ghost btn-xs" onClick={() => { setEditing({ id: t.id, name: t.name, color: t.color, show_on_map: t.show_on_map ? 1 : 0 }); setOpen(true); }}>
              ویرایش
            </button>
            <button
              type="button"
              className="btn-danger btn-xs"
              onClick={async () => {
                if (!window.confirm(`حذف تگ «${t.name}»؟`)) return;
                try {
                  await api.deleteTag(t.id);
                  refresh();
                  refreshMeta();
                } catch (e) {
                  push((e as Error).message, 'error');
                }
              }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {(data?.items ?? []).length === 0 ? <EmptyState title="تگی تعریف نشده است" /> : null}
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing?.id ? 'ویرایش تگ' : 'افزودن تگ جدید'}
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              انصراف
            </button>
            <button type="button" className="btn-primary" onClick={save}>
              ذخیره
            </button>
          </>
        }
      >
        {editing ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="نام تگ" required>
              <input className="field" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label="رنگ تگ">
              <input type="color" className="field h-10 p-1" value={editing.color} onChange={(e) => setEditing({ ...editing, color: e.target.value })} />
            </Field>
            <div className="sm:col-span-2">
              <Toggle checked={!!editing.show_on_map} onChange={(v) => setEditing({ ...editing, show_on_map: v ? 1 : 0 })} label="نمایش این تگ روی نقشه" hint="برچسب تگ کنار نشانگر تجهیز روی نقشه نمایش داده می‌شود" />
            </div>
          </div>
        ) : null}
      </Modal>
    </Card>
  );
}

/* ------------------------------- Layers ------------------------------- */
function LayersTab() {
  const { push } = useToast();
  const { refreshMeta } = useApp();
  const { data, refresh } = useAsync((signal) => api.layers(signal), []);
  return (
    <Card>
      <CardHeader
        title="لایه‌های نقشه"
        subtitle="مدیریت لایه‌های آفلاین؛ بارگذاری فایل MBTiles از صفحه نقشه انجام می‌شود"
        icon={<MapIcon size={18} />}
        action={
          <button type="button" className="btn-ghost btn-xs" onClick={refresh}>
            <RefreshCw size={13} />
            بروزرسانی
          </button>
        }
      />
      <div className="mt-4 space-y-3">
        {(data?.items ?? []).map((l) => (
          <div key={l.id} className="flex flex-wrap items-center justify-between gap-3 rounded-soft border border-ink-200 bg-white/70 p-3">
            <div>
              <p className="text-[12.5px] font-semibold text-ink-700">
                {l.name} {l.is_default ? <Badge tone="brand">پیش‌فرض</Badge> : null}
              </p>
              <p className="num mt-1 text-[11px] text-ink-500">
                {l.kind === 'mbtiles' ? l.file_name : l.kind === 'builtin' ? 'لایه داخلی آفلاین' : 'لایه خالی'} · {faDigits(l.tile_count ?? 0)} کاشی
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Toggle checked={!!l.visible} onChange={async (v) => { await api.updateLayer(l.id, { visible: v ? 1 : 0 }); refresh(); }} label={l.visible ? 'نمایش' : 'مخفی'} />
              <button
                type="button"
                className="btn-danger btn-xs"
                onClick={async () => {
                  if (!window.confirm(`حذف لایه «${l.name}»؟`)) return;
                  await api.deleteLayer(l.id, true);
                  refresh();
                  refreshMeta();
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 rounded-soft border border-ink-200 bg-white/70 p-3 text-[11.5px] leading-relaxed text-ink-500">
        فایل‌های <span className="num" dir="ltr">.mbtiles</span> در پوشه <span className="num" dir="ltr">data/mbtiles</span> نگهداری و کاشی‌ها از طریق مسیر{' '}
        <span className="num" dir="ltr">/api/tiles/&lt;layerId&gt;/z/x/y</span> سرو می‌شوند؛ بدون نیاز به هیچ سرویس نقشه آنلاین.
      </p>
    </Card>
  );
}

/* ------------------------------- Widget layouts ------------------------------- */
function WidgetLayoutTab() {
  const detail = useWidgetLayout('device_detail_widgets', DETAIL_WIDGETS);
  const dash = useWidgetLayout('dashboard_widgets', DASHBOARD_WIDGETS);
  const { push } = useToast();

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="چیدمان صفحه جزئیات تجهیزات"
          subtitle="ترتیب، اندازه و نمایش/مخفی بودن بخش‌های مختلف صفحه جزئیات تجهیز را تعیین کنید"
          icon={<LayoutGrid size={18} />}
          action={
            <button type="button" className="btn-ghost btn-xs" onClick={() => { detail.reset(); push('چیدمان پیش‌فرض بازنشانی شد', 'success'); }}>
              <RotateCcw size={13} />
              بازنشانی
            </button>
          }
        />
        <div className="mt-4 space-y-2">
          {detail.layout.map((item, idx) => {
            const def = DETAIL_WIDGETS.find((d) => d.id === item.id);
            if (!def) return null;
            return (
              <WidgetVisibilityRow
                key={item.id}
                def={def}
                item={item}
                onVisible={(v) => detail.setVisible(item.id, v)}
                onSize={(s) => detail.setSize(item.id, s)}
                onUp={() => idx > 0 && detail.move(item.id, detail.layout[idx - 1].id)}
                onDown={() => idx < detail.layout.length - 1 && detail.move(item.id, detail.layout[idx + 1].id)}
              />
            );
          })}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="چیدمان داشبورد"
          subtitle="ترتیب، اندازه و نمایش/مخفی بودن ویجت‌های داشبورد را تعیین کنید"
          icon={<LayoutGrid size={18} />}
          action={
            <button type="button" className="btn-ghost btn-xs" onClick={() => { dash.reset(); push('چیدمان پیش‌فرض بازنشانی شد', 'success'); }}>
              <RotateCcw size={13} />
              بازنشانی
            </button>
          }
        />
        <div className="mt-4 space-y-2">
          {dash.layout.map((item, idx) => {
            const def = DASHBOARD_WIDGETS.find((d) => d.id === item.id);
            if (!def) return null;
            return (
              <WidgetVisibilityRow
                key={item.id}
                def={def}
                item={item}
                onVisible={(v) => dash.setVisible(item.id, v)}
                onSize={(s) => dash.setSize(item.id, s)}
                onUp={() => idx > 0 && dash.move(item.id, dash.layout[idx - 1].id)}
                onDown={() => idx < dash.layout.length - 1 && dash.move(item.id, dash.layout[idx + 1].id)}
              />
            );
          })}
        </div>
      </Card>

      <p className="rounded-soft border border-ink-200 bg-white/70 p-3 text-[11.5px] leading-relaxed text-ink-500">
        تغییرات بلافاصله ذخیره می‌شوند. در صفحه داشبورد و جزئیات تجهیز می‌توانید با دکمهٔ «چیدمان» ویجت‌ها را روی خود صفحه هم جابه‌جا، تغییر اندازه، حذف یا اضافه کنید.
      </p>
    </div>
  );
}

/* ------------------------------- Repair catalog ------------------------------- */
function RepairTab({
  local,
  set,
  persist,
  saving,
}: {
  local: AppSettings;
  set: <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => void;
  persist: (patch?: Partial<AppSettings>) => Promise<void>;
  saving: boolean;
}) {
  const [cause, setCause] = useState('');
  const [action, setAction] = useState('');
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card>
        <CardHeader title="علت‌های خرابی و قطعی" subtitle="این فهرست در فرم ثبت سوابق تعمیرات استفاده می‌شود" icon={<Wrench size={18} />} />
        <div className="mt-4 space-y-3">
          <div className="flex gap-2">
            <input className="field" placeholder="افزودن علت جدید…" value={cause} onChange={(e) => setCause(e.target.value)} />
            <button
              type="button"
              className="btn-soft btn-xs"
              onClick={() => {
                if (!cause.trim()) return;
                set('repair_causes', [...new Set([...local.repair_causes, cause.trim()])]);
                setCause('');
              }}
            >
              <Plus size={13} />
              افزودن
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {local.repair_causes.map((c) => (
              <span key={c} className="chip border-ink-200 bg-white text-ink-600">
                {c}
                <button type="button" className="text-ink-400 hover:text-red-500" onClick={() => set('repair_causes', local.repair_causes.filter((x) => x !== c))}>
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="اقدامات انجام‌شده" subtitle="فهرست اقدامات قابل ثبت در سوابق نگهداری" icon={<Wrench size={18} />} />
        <div className="mt-4 space-y-3">
          <div className="flex gap-2">
            <input className="field" placeholder="افزودن اقدام جدید…" value={action} onChange={(e) => setAction(e.target.value)} />
            <button
              type="button"
              className="btn-soft btn-xs"
              onClick={() => {
                if (!action.trim()) return;
                set('repair_actions', [...new Set([...local.repair_actions, action.trim()])]);
                setAction('');
              }}
            >
              <Plus size={13} />
              افزودن
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {local.repair_actions.map((a) => (
              <span key={a} className="chip border-ink-200 bg-white text-ink-600">
                {a}
                <button type="button" className="text-ink-400 hover:text-red-500" onClick={() => set('repair_actions', local.repair_actions.filter((x) => x !== a))}>
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      </Card>

      <div className="xl:col-span-2">
        <button type="button" className="btn-primary btn-xs" disabled={saving} onClick={() => persist()}>
          <Save size={13} />
          ذخیره فهرست‌ها
        </button>
      </div>
    </div>
  );
}
