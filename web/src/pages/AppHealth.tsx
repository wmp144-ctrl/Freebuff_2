import React, { useMemo } from 'react';
import {
  Activity,
  Cpu,
  Database,
  HardDrive,
  Radio,
  RefreshCw,
  Server,
  Timer,
  Users,
} from 'lucide-react';
import { Card, CardHeader, ErrorState, PageLoader, Progress, StatCard } from '../components/ui';
import { TrendLineChart } from '../components/charts';
import { useApp, useAsync } from '../lib/store';
import { api } from '../lib/api';
import { faDigits, fmtClock, fmtDateTime, fmtDuration, fmtMs, fmtNumber, fmtRelative, fmtPct } from '../lib/format';

function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, Number(bytes));
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${fmtNumber(value, value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** رنگ نشانگر بر پایهٔ آستانه؛ فقط برای خوانایی، تصمیم سلامت در سرور گرفته می‌شود. */
function tone(value: number, warn: number, down: number): 'ok' | 'warn' | 'down' {
  if (value >= down) return 'down';
  if (value >= warn) return 'warn';
  return 'ok';
}

const TONE_TEXT = { ok: 'text-emerald-600', warn: 'text-sun-600', down: 'text-red-600' } as const;

export default function AppHealth() {
  const { tzOffset } = useApp();
  const { data, loading, error, refresh, updatedAt } = useAsync((signal) => api.appHealth(signal), [], { interval: 5000 });

  const history = data?.history ?? [];
  const points = useMemo(
    () =>
      history.map((h) => ({
        label: fmtClock(h.t, tzOffset),
        cpu: h.cpuPct,
        rss: h.rssMb,
        heap: h.heapMb,
        eld: h.eldP99,
        api: h.apiP95,
        db: h.dbP95,
      })),
    [history, tzOffset]
  );

  if (loading && !data) return <PageLoader label="در حال خواندن سنجه‌های برنامه…" />;
  if (error && !data) return <ErrorState message={error} onRetry={refresh} />;
  if (!data) return null;

  const p = data.process;
  const el = p.eventLoop;
  const memoryPct = p.memory.heapTotalBytes > 0 ? (p.memory.heapUsedBytes / p.memory.heapTotalBytes) * 100 : 0;
  const sysMemPct = p.memory.rssMb > 0 ? Math.min(100, (p.memory.rssMb / 4096) * 100) : 0;
  const eldTone = tone(el.p99, 100, 400);
  const cpuTone = tone(p.cpu.processPct, 70, 140);
  const apiP95 = data.api.overall.p95;
  const dbP95 = data.db.queries.overall.p95;
  const engine = data.engine;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="سلامت برنامه"
          subtitle="سنجه‌های داخلی سرور، پایگاه‌داده، موتور و اتصال‌های زنده — مستقل از سلامت تجهیزات"
          icon={<Activity size={18} />}
          action={
            <button type="button" className="btn-ghost btn-xs" onClick={refresh} aria-label="به‌روزرسانی سنجه‌ها">
              <RefreshCw size={13} />
              بروزرسانی
            </button>
          }
        />
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="CPU فرآیند"
            value={`${fmtNumber(p.cpu.processPct, 1)}٪`}
            hint={`${faDigits(p.cpu.cores)} هسته · Load ${p.cpu.loadAvg.map((n) => fmtNumber(n, 2)).join(' / ')}`}
            icon={<Cpu size={20} />}
            tone={cpuTone === 'ok' ? 'emerald' : cpuTone === 'warn' ? 'sun' : 'red'}
          />
          <StatCard
            label="حافظه (RSS)"
            value={`${fmtNumber(p.memory.rssMb, 1)} MB`}
            hint={`Heap ${fmtNumber(p.memory.heapUsedMb, 1)} از ${fmtNumber(p.memory.heapTotalMb, 1)} MB`}
            icon={<HardDrive size={20} />}
            tone={sysMemPct > 85 ? 'red' : sysMemPct > 65 ? 'sun' : 'violet'}
          />
          <StatCard
            label="تأخیر حلقهٔ رویداد p99"
            value={fmtMs(el.p99)}
            hint={`میانگین ${fmtMs(el.mean)} · بیشینه ${fmtMs(el.max)}`}
            icon={<Timer size={20} />}
            tone={eldTone === 'ok' ? 'emerald' : eldTone === 'warn' ? 'sun' : 'red'}
          />
          <StatCard
            label="صف و پروب فعال"
            value={`${faDigits(engine.activeProbes)} / ${faDigits(engine.maxWorkers)}`}
            hint={`عمق صف ${faDigits(engine.queueDepth)} · معوق ${faDigits(engine.backlog)}`}
            icon={<Radio size={20} />}
            tone={engine.queueDepth > engine.maxWorkers * 10 ? 'sun' : 'brand'}
          />
          <StatCard
            label="اتصال‌های SSE"
            value={faDigits(data.sse.clients)}
            hint={`اوج ${faDigits(data.sse.peak)} · فریم‌های حذف‌شده ${faDigits(data.sse.skippedFrames)}`}
            icon={<Users size={20} />}
            tone={data.sse.clients >= data.sse.peak && data.sse.clients > 20 ? 'sun' : 'emerald'}
          />
          <StatCard
            label="پایگاه‌داده"
            value={fmtBytes(data.db.sizeBytes)}
            hint={`WAL ${fmtBytes(data.db.walBytes)} · Query p95 ${fmtMs(dbP95)}`}
            icon={<Database size={20} />}
            tone={dbP95 > 50 ? 'red' : dbP95 > 15 ? 'sun' : 'emerald'}
          />
          <StatCard
            label="API p95"
            value={fmtMs(apiP95)}
            hint={`${faDigits(data.api.count)} درخواست · خطای 5xx ${faDigits(data.api.serverErrors)}`}
            icon={<Server size={20} />}
            tone={apiP95 > 300 ? 'red' : apiP95 > 100 ? 'sun' : 'emerald'}
          />
          <StatCard
            label="آخرین چرخهٔ موتور"
            value={engine.lastCycleAt ? fmtRelative(engine.lastCycleAt) : '—'}
            hint={`${faDigits(engine.checksRun)} بررسی · چرخه ${fmtMs(engine.lastCycleMs)}`}
            icon={<Activity size={20} />}
            tone={!engine.running || engine.stalled ? 'red' : engine.leader ? 'emerald' : 'sun'}
          />
        </div>

        {!data.ok ? (
          <p className="mt-3 rounded-soft border border-sun-200 bg-sun-50/70 px-3 py-2 text-[12px] text-sun-800" role="status">
            یکی از آستانه‌های سلامت برنامه رد شده است؛ جزئیات در جدول‌های پایین آمده است.
          </p>
        ) : null}
        <p className="mt-2 text-[10.5px] text-ink-400">
          آخرین به‌روزرسانی {updatedAt ? fmtRelative(updatedAt) : '—'} · زمان سرور {fmtDateTime(data.generatedAt, tzOffset)} · Uptime{' '}
          {fmtDuration(p.uptimeSec)}
        </p>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="CPU و حافظه" subtitle="یک ساعت گذشته، نمونه هر ۵ ثانیه" icon={<Cpu size={16} />} />
          <div className="mt-3">
            {points.length >= 2 ? (
              <TrendLineChart
                points={points}
                height={200}
                suffix=""
                tzOffset={tzOffset}
                series={[
                  { key: 'cpu', label: 'CPU فرآیند (٪)', color: '#2563eb' },
                  { key: 'rss', label: 'RSS (MB)', color: '#7c3aed' },
                ]}
              />
            ) : (
              <p className="py-10 text-center text-xs text-ink-400">در حال جمع‌آوری نمونه…</p>
            )}
          </div>
          <div className="mt-3 space-y-2">
            <div className="flex items-center justify-between text-[11px] text-ink-500">
              <span>Heap مصرف‌شده</span>
              <span className="num">
                {fmtNumber(p.memory.heapUsedMb, 1)} / {fmtNumber(p.memory.heapTotalMb, 1)} MB
              </span>
            </div>
            <Progress value={memoryPct} color={memoryPct > 85 ? '#dc2626' : '#2563eb'} />
            <div className="flex items-center justify-between text-[11px] text-ink-500">
              <span>External / ArrayBuffers</span>
              <span className="num">
                {fmtBytes(p.memory.externalBytes)} / {fmtBytes(p.memory.arrayBuffersBytes)}
              </span>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="تأخیر حلقهٔ رویداد و API" subtitle="p99 حلقهٔ رویداد در برابر p95 درخواست‌ها" icon={<Timer size={16} />} />
          <div className="mt-3">
            {points.length >= 2 ? (
              <TrendLineChart
                points={points}
                height={200}
                suffix=" ms"
                tzOffset={tzOffset}
                series={[
                  { key: 'eld', label: 'ELD p99', color: '#f59e0b' },
                  { key: 'api', label: 'API p95', color: '#10b981' },
                  { key: 'db', label: 'DB p95', color: '#ef4444' },
                ]}
              />
            ) : (
              <p className="py-10 text-center text-xs text-ink-400">در حال جمع‌آوری نمونه…</p>
            )}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            {[
              { label: 'p50', value: el.p50 },
              { label: 'p95', value: el.p95 },
              { label: 'p99', value: el.p99 },
            ].map((x) => (
              <div key={x.label} className="rounded-soft border border-ink-100 bg-ink-50/50 px-2 py-1.5">
                <p className="text-[10px] text-ink-400">ELD {x.label}</p>
                <p className={`num text-sm font-semibold ${TONE_TEXT[eldTone]}`}>{fmtMs(x.value)}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="تأخیر API به تفکیک مسیر" subtitle="p50 / p95 / p99 از آخرین درخواست‌ها" icon={<Server size={16} />} />
          <div className="table-wrap mt-3">
            <table className="table">
              <thead>
                <tr>
                  <th>مسیر</th>
                  <th>تعداد</th>
                  <th>p50</th>
                  <th>p95</th>
                  <th>p99</th>
                  <th>بیشینه</th>
                </tr>
              </thead>
              <tbody>
                {data.api.routes.length ? (
                  data.api.routes.map((r) => (
                    <tr key={r.route}>
                      <td className="max-w-[240px] truncate font-mono text-[11px]" title={r.route}>
                        {r.route}
                      </td>
                      <td className="num">{faDigits(r.count)}</td>
                      <td className="num">{fmtMs(r.p50)}</td>
                      <td className={`num ${r.p95 > 300 ? 'text-red-600' : r.p95 > 100 ? 'text-sun-600' : ''}`}>{fmtMs(r.p95)}</td>
                      <td className="num">{fmtMs(r.p99)}</td>
                      <td className="num">{fmtMs(r.max)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-xs text-ink-400">
                      هنوز درخواستی ثبت نشده است.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="بهینه‌سازی Query"
            subtitle={`${faDigits(data.db.queries.count)} اجرا · کند (>${faDigits(data.db.queries.slow.thresholdMs)}ms): ${faDigits(data.db.queries.slow.count)}`}
            icon={<Database size={16} />}
          />
          <div className="table-wrap mt-3">
            <table className="table">
              <thead>
                <tr>
                  <th>Query (نرمال‌شده)</th>
                  <th>تعداد</th>
                  <th>میانگین</th>
                  <th>بیشینه</th>
                </tr>
              </thead>
              <tbody>
                {data.db.queries.top.length ? (
                  data.db.queries.top.map((q, i) => (
                    <tr key={`${q.sql}-${i}`}>
                      <td className="max-w-[320px] truncate font-mono text-[10.5px]" title={q.sql}>
                        {q.sql}
                      </td>
                      <td className="num">{faDigits(q.count)}</td>
                      <td className="num">{fmtMs(q.avgMs)}</td>
                      <td className={`num ${q.maxMs > 100 ? 'text-red-600' : ''}`}>{fmtMs(q.maxMs)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-xs text-ink-400">
                      هنوز Queryای ثبت نشده است.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="چرخه‌های نگهداری و پشتیبان" subtitle="آخرین اجرای موفق، وضعیت WAL و صف کارها" icon={<GaugeIcon />} />
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-soft border border-ink-100 bg-white p-3">
            <p className="text-[11px] text-ink-500">آخرین پشتیبان موفق</p>
            <p className="num mt-1 text-sm font-semibold text-ink-800">
              {data.backup?.lastBackupAt ? fmtRelative(data.backup.lastBackupAt) : '—'}
            </p>
            <p className="mt-1 text-[10.5px] text-ink-400">
              {data.backup?.enabled ? `هر ${faDigits(data.backup.intervalHours ?? 0)} ساعت · ${faDigits(data.backup.count)} نسخه` : 'غیرفعال'}
            </p>
          </div>
          <div className="rounded-soft border border-ink-100 bg-white p-3">
            <p className="text-[11px] text-ink-500">آخرین Retention</p>
            <p className="num mt-1 text-sm font-semibold text-ink-800">
              {data.retention?.lastFinishedAt ? fmtRelative(data.retention.lastFinishedAt) : data.retention?.lastStatus ?? '—'}
            </p>
            <p className="mt-1 text-[10.5px] text-ink-400">
              {faDigits(data.retention?.lastDeletedRows ?? 0)} ردیف حذف‌شده · وضعیت {data.retention?.lastStatus ?? '—'}
            </p>
          </div>
          <div className="rounded-soft border border-ink-100 bg-white p-3">
            <p className="text-[11px] text-ink-500">WAL</p>
            <p className="num mt-1 text-sm font-semibold text-ink-800">{fmtBytes(data.db.walBytes)}</p>
            <p className="mt-1 text-[10.5px] text-ink-400">Checkpoint خودکار فعال · بدون قفل باقی‌مانده</p>
          </div>
          <div className="rounded-soft border border-ink-100 bg-white p-3">
            <p className="text-[11px] text-ink-500">کارهای پس‌زمینه</p>
            <p className="num mt-1 text-sm font-semibold text-ink-800">
              {faDigits(data.jobs.queued)} در صف · {faDigits(data.jobs.running)} در اجرا
            </p>
            <p className="mt-1 text-[10.5px] text-ink-400">
              Worker فعال {faDigits(data.jobs.activeWorkers)} از {faDigits(data.jobs.maxConcurrency)} · ردشده {faDigits(data.jobs.rejected)}
            </p>
          </div>
        </div>
        <p className="mt-3 text-[10.5px] text-ink-400">
          وضعیت موتور: {engine.mode} {engine.simulation ? '(شبیه‌سازی)' : ''} · رهبر: {engine.leader ? 'بله' : 'خیر'} · آخرین tick{' '}
          {fmtMs(engine.lastTickMs)} · شروع‌شده در آخرین چرخه {faDigits(engine.lastTickLaunched)} از {faDigits(engine.lastTickReady)} آماده ·
          نسبت بارگذاری{' '}
          {p.cpu.processPct > 0 ? fmtPct(Math.min(100, (engine.activeProbes / Math.max(1, engine.maxWorkers)) * 100), 0) : '—'}
        </p>
      </Card>
    </div>
  );
}

function GaugeIcon() {
  return <Activity size={16} />;
}
