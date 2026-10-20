import React from 'react';
import { Activity, AlertTriangle, Database, HardDrive, Radio, RefreshCw, Server, ShieldCheck, Signal, Timer, Wifi, WifiOff } from 'lucide-react';
import type { DashboardData, StatusData } from '../lib/types';
import { faDigits, fmtDateTime, fmtMs, fmtNumber, fmtPct, fmtRelative, fmtTimezone, healthTone } from '../lib/format';
import { Card, CardHeader, Progress } from './ui';
import { LiveBadge } from './Freshness';

type Tone = 'ok' | 'warn' | 'down' | 'wait';

const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-emerald-700',
  warn: 'text-sun-700',
  down: 'text-red-600',
  wait: 'text-ink-500',
};
const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-sun-500',
  down: 'bg-red-500',
  wait: 'bg-ink-300',
};

function Metric({
  label,
  value,
  hint,
  tone = 'ink',
  icon,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: 'ink' | 'emerald' | 'red' | 'sun' | 'brand';
  icon?: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    ink: 'text-ink-800',
    emerald: 'text-emerald-600',
    red: 'text-red-600',
    sun: 'text-sun-600',
    brand: 'text-brand-600',
  };
  return (
    <div className="rounded-soft border border-ink-100 bg-white/70 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-ink-500">{label}</p>
        {icon ? <span className="text-ink-300">{icon}</span> : null}
      </div>
      <p className={`num mt-1 text-xl font-bold ${tones[tone]}`}>{value}</p>
      {hint ? <p className="mt-0.5 truncate text-[10.5px] text-ink-400" title={typeof hint === 'string' ? hint : undefined}>{hint}</p> : null}
    </div>
  );
}

/**
 * بخش مستقل «سلامت شبکه».
 * فقط از دادهٔ داشبورد استفاده می‌کند (هیچ درخواست اضافه‌ای نمی‌فرستد) و سلامت
 * تجهیزات/دسترسی را از سلامت برنامه جدا نگه می‌دارد.
 */
export function NetworkHealthSection({ data, tzOffset }: { data: DashboardData; tzOffset: number }) {
  const { kpis, health } = data;
  const tone = healthTone(health.score);
  const availability = health.availability;

  return (
    <Card className="h-full" data-testid="network-health">
      <CardHeader
        title="سلامت شبکه"
        subtitle="وضعیت تجهیزات، قطعی‌ها و کیفیت اتصال"
        icon={<Wifi size={18} />}
        action={
          <span className={`chip border-0 bg-transparent px-0 text-[12px] font-semibold ${tone.text}`} data-testid="network-grade">
            <ShieldCheck size={14} />
            {health.grade.label} · <span className="num">{fmtNumber(health.score, 1)}</span> از ۱۰۰
          </span>
        }
      />

      <div className="mt-3 grid grid-cols-2 gap-2.5 md:grid-cols-3">
        <Metric label="کل تجهیزات" value={fmtNumber(kpis.total)} hint={`${faDigits(kpis.monitoring)} تحت پایش`} icon={<Server size={14} />} />
        <Metric
          label="Online"
          value={fmtNumber(kpis.up)}
          hint={`${faDigits(kpis.online)} سالم · ${faDigits(kpis.warning)} دارای اختلال`}
          tone="emerald"
          icon={<Wifi size={14} />}
        />
        <Metric label="Offline" value={fmtNumber(kpis.offline)} hint="نیازمند بررسی" tone="red" icon={<WifiOff size={14} />} />
        <Metric label="Degraded" value={fmtNumber(kpis.warning)} hint="از تجهیزات در دسترس" tone="sun" icon={<AlertTriangle size={14} />} />
        <Metric
          label="قطعی‌های فعال"
          value={fmtNumber(kpis.openOutages ?? 0)}
          hint={(kpis.openOutages ?? 0) > 0 ? 'قطعی باز در جریان است' : 'قطعی بازی وجود ندارد'}
          tone={(kpis.openOutages ?? 0) > 0 ? 'red' : 'ink'}
          icon={<Activity size={14} />}
        />
        <Metric label="غیرفعال" value={fmtNumber(kpis.inactive)} hint="خارج از چرخهٔ پایش" icon={<Signal size={14} />} />
      </div>

      <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
        <div className="rounded-soft border border-ink-100 bg-white/70 p-3">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-ink-500">میانگین تأخیر (۲۴ ساعت)</span>
            <span className="num font-semibold text-ink-700">{fmtMs(health.avgRtt)}</span>
          </div>
          <div className="mt-2">
            <Progress value={Math.min(100, (health.avgRtt ?? 0) / 2)} color="#2563eb" />
          </div>
        </div>
        <div className="rounded-soft border border-ink-100 bg-white/70 p-3">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-ink-500">میانگین افت بسته</span>
            <span className="num font-semibold text-ink-700">{fmtPct(health.lossAvg, 2)}</span>
          </div>
          <div className="mt-2">
            <Progress value={Math.min(100, (health.lossAvg ?? 0) * 4)} color="#f59e0b" />
          </div>
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-soft bg-ink-50/80 px-3 py-2 text-[11px]">
        <span className="inline-flex items-center gap-1.5 text-ink-500">
          <Timer size={13} />
          آخرین تغییر وضعیت
        </span>
        <span className="text-ink-600">
          {data.lastStatusChangeAt ? (
            <>
              <span className="num">{fmtDateTime(data.lastStatusChangeAt, tzOffset)}</span>
              <span className="text-ink-400"> · {fmtRelative(data.lastStatusChangeAt)}</span>
            </>
          ) : (
            'ثبت نشده'
          )}
        </span>
      </div>
      <p className="mt-2 text-[10.5px] text-ink-400">
        دسترس‌پذیری ۲۴ ساعت: <span className="num font-medium text-ink-600">{fmtPct(availability, 2)}</span> ·{' '}
        <span className="num">{faDigits(health.checks24h)}</span> بررسی · زمان‌ها به وقت {fmtTimezone(tzOffset)}
      </p>
    </Card>
  );
}

function HealthRow({ label, tone, value, hint, icon }: { label: string; tone: Tone; value: React.ReactNode; hint?: string; icon: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-soft border border-ink-100 bg-white/70 px-3 py-2" title={hint}>
      <span className="flex min-w-0 items-center gap-2 text-[11.5px] text-ink-500">
        <span className={`h-2 w-2 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
        <span className="shrink-0 text-ink-400">{icon}</span>
        <span className="truncate">{label}</span>
      </span>
      <span className={`num shrink-0 text-[11.5px] font-semibold ${TONE_TEXT[tone]}`}>{value}</span>
    </div>
  );
}

/**
 * بخش مستقل «سلامت برنامه».
 * API، پایگاه‌داده، موتور، SSE، پشتیبان‌گیری، دیسک و آخرین Probe موفق.
 * دادهٔ سرور از AppProvider می‌آید؛ وضعیت اتصال SSE همان اتصال همین مرورگر است.
 */
export function ApplicationHealthSection({
  status,
  error,
  onRefresh,
}: {
  status: StatusData | null;
  error: string | null;
  onRefresh: () => void;
}) {
  const app = status?.app;
  const engine = status?.engine;

  const apiTone: Tone = error ? 'down' : status?.server.ok ? 'ok' : 'wait';
  const dbTone: Tone = !app ? 'wait' : app.db.ok ? 'ok' : 'down';
  const engineTone: Tone = !engine
    ? 'wait'
    : !engine.running || engine.stale
      ? 'down'
      : engine.leader === false
        ? 'warn'
        : 'ok';
  const backup = app?.backup;
  const backupTone: Tone = !backup
    ? 'wait'
    : backup.running || backup.restoring
      ? 'warn'
      : backup.ok && backup.lastBackupAt
        ? 'ok'
        : backup.enabled
          ? 'warn'
          : 'wait';
  const diskTone: Tone = !app?.disk ? 'wait' : app.disk.ok ? 'ok' : 'down';
  const sseTone: Tone = error ? 'down' : 'ok';

  const engineText = !engine
    ? '—'
    : !engine.running
      ? 'متوقف'
      : engine.stale
        ? 'چرخه کهنه'
        : engine.leader === false
          ? 'Standby'
          : 'در حال اجرا';

  return (
    <Card className="h-full" data-testid="app-health">
      <CardHeader
        title="سلامت برنامه"
        subtitle="مستقل از سلامت شبکه — سرور، داده، موتور و زیرساخت اجرا"
        icon={<ShieldCheck size={18} />}
        action={
          <button type="button" className="btn-ghost btn-xs" onClick={onRefresh} aria-label="به‌روزرسانی سلامت برنامه">
            <RefreshCw size={13} />
            بروزرسانی
          </button>
        }
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <LiveBadge showAttempt />
        <span className="text-[10.5px] text-ink-400">
          {status ? `آخرین بررسی ${fmtRelative(status.generatedAt)}` : 'در حال دریافت وضعیت…'}
        </span>
      </div>

      {error ? (
        <p className="mt-2 rounded-soft border border-red-100 bg-red-50/70 px-3 py-2 text-[11px] text-red-700" role="alert">
          وضعیت سرور دریافت نشد: {error}
        </p>
      ) : null}

      <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
        <HealthRow
          label="API"
          tone={apiTone}
          value={error ? 'بی‌پاسخ' : status?.server.ok ? 'سالم' : '—'}
          hint={status ? `Uptime ${fmtUptime(status.server.uptime)}` : undefined}
          icon={<Server size={12} />}
        />
        <HealthRow
          label="پایگاه‌داده"
          tone={dbTone}
          value={!app ? '—' : app.db.ok ? (app.db.sizeBytes != null ? fmtBytes(app.db.sizeBytes) : 'سالم') : 'خطا'}
          hint="وضعیت اتصال و حجم فایل پایگاه‌داده"
          icon={<Database size={12} />}
        />
        <HealthRow
          label="موتور پایش"
          tone={engineTone}
          value={engineText}
          hint={engine ? `حالت ${engine.mode} · بازه ${faDigits(engine.interval)} ثانیه` : undefined}
          icon={<Activity size={12} />}
        />
        <HealthRow
          label="SSE (کلاینت سرور)"
          tone={sseTone}
          value={status ? `${faDigits(status.app?.sse.clients ?? 0)} اتصال` : '—'}
          hint="تعداد اتصال‌های زنده روی سرور؛ وضعیت همین مرورگر در نشان بالا آمده است"
          icon={<Radio size={12} />}
        />
        <HealthRow
          label="پشتیبان‌گیری"
          tone={backupTone}
          value={
            !backup
              ? '—'
              : backup.restoring
                ? 'بازیابی'
                : backup.running
                  ? 'در حال اجرا'
                  : backup.lastBackupAt
                    ? fmtRelative(backup.lastBackupAt)
                    : backup.enabled
                      ? 'بدون نسخه'
                      : 'غیرفعال'
          }
          hint={backup ? `${faDigits(backup.count)} نسخه ذخیره‌شده` : undefined}
          icon={<ShieldCheck size={12} />}
        />
        <HealthRow
          label="فضای دیسک"
          tone={diskTone}
          value={app?.disk.freeBytes != null ? fmtBytes(app.disk.freeBytes) : '—'}
          hint={app?.disk ? `حداقل مجاز ${fmtBytes(app.disk.minFreeBytes)}` : undefined}
          icon={<HardDrive size={12} />}
        />
        <HealthRow
          label="آخرین Probe موفق"
          tone={app?.probe.lastSuccessAt ? 'ok' : 'wait'}
          value={fmtRelative(app?.probe.lastSuccessAt)}
          hint={app?.probe.lastSuccessAt ? fmtDateTime(app.probe.lastSuccessAt) : undefined}
          icon={<Wifi size={12} />}
        />

      </div>

      {engine?.stale ? (
        <p className="mt-2 rounded-soft border border-sun-200 bg-sun-50/80 px-3 py-2 text-[11px] text-sun-800" role="status">
          چرخهٔ موتور از بازهٔ مورد انتظار عقب است؛ داده‌های تجهیزات ممکن است قدیمی باشند.
        </p>
      ) : null}
    </Card>
  );
}

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${faDigits((mb / 1024).toFixed(1))} GB`;
  return `${faDigits(Math.round(mb).toLocaleString('en-US'))} MB`;
}

function fmtUptime(sec: number): string {
  const s = Math.max(0, Math.round(sec || 0));
  if (s < 3600) return `${faDigits(Math.floor(s / 60))} دقیقه`;
  if (s < 86400) return `${faDigits(Math.floor(s / 3600))} ساعت`;
  return `${faDigits(Math.floor(s / 86400))} روز`;
}
