/**
 * پنل تاریخچه و گزارش‌های دیاگرام (مرحلهٔ ۴)
 * ----------------------------------------------------------------
 * • فهرست نسخه‌ها، جزئیات تغییرات و مقایسهٔ هر دو نسخه/وضعیت فعلی
 * • بازگردانی با تأیید صریح (وضعیت فعلی پیش از بازگردانی ثبت می‌شود)
 * • گزارش‌های ساختار، تجهیزات، مسیرها، لینک‌ها، ظرفیت و ریسک
 * • خروجی PDF و Excel از همان دادهٔ واقعی که در صفحه دیده می‌شود
 *
 * هیچ محاسبهٔ گزارشی در مرورگر انجام نمی‌شود؛ همهٔ اعداد از API آمده‌اند.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  Check,
  Download,
  FileBarChart,
  FileSpreadsheet,
  FileText,
  Gauge,
  GitCompare,
  History as HistoryIcon,
  Loader2,
  Network,
  RefreshCw,
  RotateCcw,
  Route as RouteIcon,
  ShieldAlert,
  User,
  X,
} from 'lucide-react';
import type {
  TopoChangeField,
  TopoChangeSet,
  TopoDiagram,
  TopoReport,
  TopoVersionDetail,
  TopoVersionSummary,
} from '../../lib/types';
import { api, isAbortError } from '../../lib/api';
import { faDigits, fmtRelative, statusMeta } from '../../lib/format';
import { LINK_STATUS_META } from '../../lib/topology-live';

type Tab = 'history' | 'reports';

interface Props {
  diagramId: number;
  revision: number;
  canWrite: boolean;
  locked: boolean;
  onClose: () => void;
  onRestore: (versionId: number) => Promise<TopoDiagram & { restoreWarnings?: string[] }>;
}

function fullDate(ts: number | null | undefined) {
  if (!ts) return '—';
  try {
    return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts));
  } catch {
    return '—';
  }
}

function formatBytes(bytes: number | null | undefined) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${faDigits(bytes)} بایت`;
  return `${faDigits(Math.round((bytes / 1024) * 10) / 10)} کیلوبایت`;
}

function fmtValue(value: unknown): string {
  if (value == null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'بله' : 'خیر';
  if (Array.isArray(value)) return value.length ? `${faDigits(value.length)} مورد` : 'خالی';
  if (typeof value === 'object') {
    const raw = JSON.stringify(value);
    return raw.length > 90 ? `${raw.slice(0, 87)}…` : raw;
  }
  return String(value);
}

function countTone(kind: 'added' | 'removed' | 'updated') {
  if (kind === 'added') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (kind === 'removed') return 'border-red-200 bg-red-50 text-red-700';
  return 'border-amber-200 bg-amber-50 text-amber-800';
}

function ChangeFields({ fields }: { fields: TopoChangeField[] }) {
  if (!fields.length) return null;
  return (
    <div className="mt-1 space-y-0.5">
      {fields.map((field, index) => (
        <div key={`${field.field}-${index}`} className="flex flex-wrap items-center gap-1 text-[10px] text-ink-500">
          <span className="font-medium text-ink-600">{field.label}:</span>
          <span className="rounded bg-red-50 px-1 text-red-700 line-through decoration-red-300">{fmtValue(field.before)}</span>
          <ArrowLeft size={9} className="text-ink-300" />
          <span className="rounded bg-emerald-50 px-1 text-emerald-700">{fmtValue(field.after)}</span>
        </div>
      ))}
    </div>
  );
}

function ChangeGroup({
  title,
  kind,
  items,
  total,
  truncated,
}: {
  title: string;
  kind: 'added' | 'removed' | 'updated';
  items: { id: string; label: string; fields?: TopoChangeField[] }[];
  total: number;
  truncated: boolean;
}) {
  if (!items.length) return null;
  const sign = kind === 'added' ? '+' : kind === 'removed' ? '−' : '✎';
  return (
    <section className="rounded-soft border border-ink-200 bg-white p-2.5">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className={`rounded-pill border px-1.5 py-0.5 text-[9px] ${countTone(kind)}`}>
          {sign} {faDigits(total)}
        </span>
        <p className="text-[11px] font-semibold text-ink-700">{title}</p>
        {truncated ? <span className="text-[9px] text-ink-400">فهرست محدود شده است</span> : null}
      </div>
      <div className="max-h-44 space-y-1.5 overflow-y-auto pe-1">
        {items.map((item) => (
          <div key={`${kind}-${item.id}`} className="rounded-lg border border-ink-100 bg-ink-50/40 px-2 py-1.5">
            <p className="truncate text-[10.5px] font-medium text-ink-700">{item.label}</p>
            {item.fields ? <ChangeFields fields={item.fields} /> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function ChangesView({ changes }: { changes: TopoChangeSet | null }) {
  if (!changes) return null;
  const s = changes.summary;
  if (!s.total) {
    return (
      <div className="rounded-soft border border-ink-200 bg-ink-50/50 p-4 text-center text-[11px] text-ink-500">
        تفاوت ساختاری بین این دو نسخه وجود ندارد.
      </div>
    );
  }
  return (
    <div className="space-y-2" data-testid="topology-version-changes">
      <div className="flex flex-wrap gap-1">
        {s.nodesAdded ? <span className={`chip ${countTone('added')}`}>+ {faDigits(s.nodesAdded)} گره</span> : null}
        {s.nodesRemoved ? <span className={`chip ${countTone('removed')}`}>− {faDigits(s.nodesRemoved)} گره</span> : null}
        {s.nodesUpdated ? <span className={`chip ${countTone('updated')}`}>✎ {faDigits(s.nodesUpdated)} گره</span> : null}
        {s.linksAdded ? <span className={`chip ${countTone('added')}`}>+ {faDigits(s.linksAdded)} لینک</span> : null}
        {s.linksRemoved ? <span className={`chip ${countTone('removed')}`}>− {faDigits(s.linksRemoved)} لینک</span> : null}
        {s.linksUpdated ? <span className={`chip ${countTone('updated')}`}>✎ {faDigits(s.linksUpdated)} لینک</span> : null}
        {s.pathsAdded ? <span className={`chip ${countTone('added')}`}>+ {faDigits(s.pathsAdded)} مسیر</span> : null}
        {s.pathsRemoved ? <span className={`chip ${countTone('removed')}`}>− {faDigits(s.pathsRemoved)} مسیر</span> : null}
        {s.pathsUpdated ? <span className={`chip ${countTone('updated')}`}>✎ {faDigits(s.pathsUpdated)} مسیر</span> : null}
        {s.metadataUpdated ? <span className={`chip ${countTone('updated')}`}>✎ {faDigits(s.metadataUpdated)} مشخصه</span> : null}
      </div>
      <div className="grid gap-2 lg:grid-cols-2">
        <ChangeGroup title="گره‌های افزوده‌شده" kind="added" items={changes.nodes.added.items} total={changes.nodes.added.total} truncated={changes.nodes.added.truncated} />
        <ChangeGroup title="گره‌های حذف‌شده" kind="removed" items={changes.nodes.removed.items} total={changes.nodes.removed.total} truncated={changes.nodes.removed.truncated} />
        <ChangeGroup title="گره‌های ویرایش‌شده" kind="updated" items={changes.nodes.updated.items} total={changes.nodes.updated.total} truncated={changes.nodes.updated.truncated} />
        <ChangeGroup title="لینک‌های افزوده‌شده" kind="added" items={changes.links.added.items} total={changes.links.added.total} truncated={changes.links.added.truncated} />
        <ChangeGroup title="لینک‌های حذف‌شده" kind="removed" items={changes.links.removed.items} total={changes.links.removed.total} truncated={changes.links.removed.truncated} />
        <ChangeGroup title="لینک‌های ویرایش‌شده" kind="updated" items={changes.links.updated.items} total={changes.links.updated.total} truncated={changes.links.updated.truncated} />
        <ChangeGroup title="مسیرهای افزوده‌شده" kind="added" items={changes.paths.added.items} total={changes.paths.added.total} truncated={changes.paths.added.truncated} />
        <ChangeGroup title="مسیرهای حذف‌شده" kind="removed" items={changes.paths.removed.items} total={changes.paths.removed.total} truncated={changes.paths.removed.truncated} />
        <ChangeGroup title="مسیرهای ویرایش‌شده" kind="updated" items={changes.paths.updated.items} total={changes.paths.updated.total} truncated={changes.paths.updated.truncated} />
      </div>
      {changes.meta.length ? (
        <section className="rounded-soft border border-ink-200 bg-white p-2.5">
          <p className="mb-1 text-[11px] font-semibold text-ink-700">مشخصات دیاگرام</p>
          <ChangeFields fields={changes.meta} />
        </section>
      ) : null}
    </div>
  );
}

function SectionTitle({ icon, title, hint }: { icon: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="mb-2 flex items-center gap-1.5">
      <span className="text-brand-600">{icon}</span>
      <p className="text-[12px] font-semibold text-ink-800">{title}</p>
      {hint ? <span className="text-[10px] text-ink-400">{hint}</span> : null}
    </div>
  );
}

function MiniStat({ label, value, hint, tone = 'ink' }: { label: string; value: string; hint?: string; tone?: 'ink' | 'emerald' | 'amber' | 'red' | 'violet' }) {
  const colors = {
    ink: 'text-ink-800',
    emerald: 'text-emerald-700',
    amber: 'text-amber-700',
    red: 'text-red-700',
    violet: 'text-violet-700',
  };
  return (
    <div className="rounded-soft border border-ink-200 bg-white/80 px-2.5 py-2">
      <p className="text-[9.5px] text-ink-400">{label}</p>
      <p className={`num mt-0.5 text-[16px] font-bold ${colors[tone]}`}>{value}</p>
      {hint ? <p className="truncate text-[9px] text-ink-400">{hint}</p> : null}
    </div>
  );
}

function ReportTable({ headers, rows }: { headers: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="table-wrap max-h-64">
      <table className="table text-[10.5px]">
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{cell}</td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={headers.length} className="text-center text-ink-400">
                داده‌ای ثبت نشده است.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ReportsView({ diagramId, revision }: { diagramId: number; revision: number }) {
  const [report, setReport] = useState<TopoReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      setError('');
      api
        .topologyReport(diagramId, signal)
        .then((data) => setReport(data))
        .catch((err) => {
          if (isAbortError(err)) return;
          setError(err instanceof Error ? err.message : 'تهیهٔ گزارش ناموفق بود.');
        })
        .finally(() => setLoading(false));
    },
    [diagramId]
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load, revision]);

  if (loading && !report) {
    return (
      <div className="flex h-48 items-center justify-center gap-2 text-[12px] text-ink-500">
        <Loader2 size={16} className="animate-spin" /> در حال تهیهٔ گزارش از دادهٔ واقعی…
      </div>
    );
  }
  if (error && !report) {
    return (
      <div className="rounded-soft border border-red-200 bg-red-50 p-4 text-[12px] text-red-700">
        <p>{error}</p>
        <button type="button" className="btn-ghost btn-xs mt-2" onClick={() => load()}>
          <RefreshCw size={12} /> تلاش دوباره
        </button>
      </div>
    );
  }
  if (!report) return null;

  const status = report.structure.statusCounts;
  const linkStatus = report.structure.linkStatusCounts;
  return (
    <div className="space-y-3" data-testid="topology-report-panel">
      <div className="flex flex-wrap items-center gap-2 rounded-soft border border-brand-100 bg-brand-50/50 px-3 py-2">
        <FileBarChart size={16} className="text-brand-600" />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold text-ink-800">گزارش ساختاریافتهٔ دیاگرام</p>
          <p className="text-[10px] text-ink-500">
            تولید {fmtRelative(report.generatedAt)} · ویرایش {faDigits(report.diagram.revision)} · همهٔ اعداد از دادهٔ ذخیره‌شده و وضعیت زندهٔ همین لحظه
          </p>
        </div>
        <button type="button" className="btn-ghost btn-xs" onClick={() => load()}>
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> به‌روزرسانی
        </button>
        <a className="btn-soft btn-xs" href={api.topologyReportUrl(diagramId, 'xlsx')}>
          <FileSpreadsheet size={13} /> Excel
        </a>
        <a className="btn-primary btn-xs" href={api.topologyReportUrl(diagramId, 'pdf')}>
          <FileText size={13} /> PDF
        </a>
      </div>

      {error ? <p className="rounded-lg bg-amber-50 px-2 py-1 text-[10.5px] text-amber-800">آخرین به‌روزرسانی ناموفق بود؛ گزارش قبلی نمایش داده می‌شود. {error}</p> : null}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <MiniStat label="تجهیزات" value={faDigits(report.structure.deviceNodeCount)} hint={`${faDigits(report.structure.nodeCount)} گره · ${faDigits(report.structure.connectedComponents)} مؤلفه`} />
        <MiniStat label="لینک‌ها" value={faDigits(report.structure.linkCount)} hint={`${faDigits(linkStatus.up)} سالم · ${faDigits(linkStatus.degraded)} اختلال · ${faDigits(linkStatus.down)} قطع`} tone={linkStatus.down ? 'red' : 'ink'} />
        <MiniStat label="مسیرهای پشتیبان" value={faDigits(report.pathCounts.backup)} hint={`${faDigits(report.pathCounts.withoutBackup)} گروه بدون پشتیبان`} tone={report.pathCounts.withoutBackup ? 'amber' : 'ink'} />
        <MiniStat label="نقاط بحرانی" value={faDigits(report.risks.criticalNodeCount)} hint={`${faDigits(report.risks.riskyLinkCount)} لینک تک‌مسیره`} tone={report.risks.criticalNodeCount ? 'red' : 'ink'} />
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <section className="rounded-soft border border-ink-200 bg-white p-3">
          <SectionTitle icon={<Network size={14} />} title="ساختار کلی شبکه و توپولوژی" />
          <div className="grid grid-cols-2 gap-1.5 text-[10.5px]">
            {[
              ['گره‌های دیاگرام', faDigits(report.structure.nodeCount)],
              ['تجهیزات واقعی', faDigits(report.structure.deviceNodeCount)],
              ['مراکز تجمع روی دیاگرام', faDigits(report.structure.siteNodeCount)],
              ['ابر / WAN', faDigits(report.structure.cloudNodeCount)],
              ['لینک‌ها', faDigits(report.structure.linkCount)],
              ['مؤلفه‌های همبند', faDigits(report.structure.connectedComponents)],
              ['گره‌های بدون اتصال', faDigits(report.structure.isolatedNodeCount)],
              ['میانگین درجه', report.structure.averageDegree == null ? '—' : faDigits(report.structure.averageDegree)],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between rounded-lg bg-ink-50/60 px-2 py-1">
                <span className="text-ink-500">{label}</span>
                <span className="num font-semibold text-ink-800">{value}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {report.structure.linkKinds.map((item) => (
              <span key={item.kind} className="chip">
                {item.label} <span className="num">{faDigits(item.count)}</span>
              </span>
            ))}
            {report.structure.roles.map((item) => (
              <span key={item.role} className="chip" title="نقش تجهیز">
                {item.label} <span className="num">{faDigits(item.count)}</span>
              </span>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-1 text-[10px]">
            <span className="rounded-pill border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-emerald-700">آنلاین {faDigits(status.online)}</span>
            <span className="rounded-pill border border-red-200 bg-red-50 px-2 py-0.5 text-red-700">آفلاین {faDigits(status.offline)}</span>
            <span className="rounded-pill border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-700">هشدار {faDigits(status.warning)}</span>
            <span className="rounded-pill border border-ink-200 bg-ink-50 px-2 py-0.5 text-ink-500">نامشخص {faDigits(status.unknown)}</span>
          </div>
        </section>

        <section className="rounded-soft border border-ink-200 bg-white p-3">
          <SectionTitle icon={<Gauge size={14} />} title="ظرفیت و میزان مصرف" hint="فقط لینک‌های دارای ظرفیت و سنجش تازه" />
          <div className="grid grid-cols-2 gap-2">
            <MiniStat label="ظرفیت اندازه‌گیری‌شده" value={report.capacity.totalCapacityMbps == null ? '—' : `${faDigits(report.capacity.totalCapacityMbps)} Mbps`} hint={`${faDigits(report.capacity.measuredCount)} لینک`} />
            <MiniStat label="میانگین وزنی مصرف" value={report.capacity.weightedUtilPct == null ? '—' : `${faDigits(report.capacity.weightedUtilPct)}٪`} hint={`دریافت ${report.capacity.totalRxMbps == null ? '—' : faDigits(report.capacity.totalRxMbps)} / ارسال ${report.capacity.totalTxMbps == null ? '—' : faDigits(report.capacity.totalTxMbps)} Mbps`} />
            <MiniStat label="پرترافیک" value={faDigits(report.capacity.highLoadCount)} hint="بالای آستانهٔ هشدار" tone={report.capacity.highLoadCount ? 'amber' : 'ink'} />
            <MiniStat label="بدون ظرفیت ثبت‌شده" value={faDigits(report.capacity.noCapacityCount)} hint={`${faDigits(report.capacity.unmeasuredCount)} لینک بدون سنجش`} tone={report.capacity.noCapacityCount ? 'amber' : 'ink'} />
          </div>
          <div className="mt-2 space-y-1">
            {report.links.filter((link) => link.capacityMbps != null).slice(0, 6).map((link) => (
              <div key={link.id} className="flex items-center gap-2 text-[10px]">
                <span className="min-w-0 flex-1 truncate text-ink-600">{link.label}</span>
                <span className="num shrink-0 text-ink-500">{faDigits(link.capacityMbps ?? 0)} Mbps</span>
                <span className={`num w-12 shrink-0 text-left font-semibold ${link.saturation === 'critical' ? 'text-red-700' : link.saturation === 'high' ? 'text-amber-700' : 'text-ink-700'}`}>
                  {link.utilPct == null ? '—' : `${faDigits(link.utilPct)}٪`}
                </span>
              </div>
            ))}
            {!report.links.some((link) => link.capacityMbps != null) ? <p className="text-[10px] text-ink-400">ظرفیتی برای لینک‌ها ثبت نشده است.</p> : null}
          </div>
        </section>
      </div>

      <section>
        <SectionTitle icon={<Network size={14} />} title="تجهیزات و مراکز تجمع" hint={`${faDigits(report.devices.length)} تجهیز · ${faDigits(report.sites.length)} مرکز`} />
        <ReportTable
          headers={['تجهیز', 'IP', 'نقش', 'وضعیت', 'مرکز / موقعیت', 'اتصال', 'گروه']}
          rows={report.devices.map((device) => [
            <span className="font-medium text-ink-700">{device.label}</span>,
            <span className="num">{device.ip || '—'}</span>,
            device.roleLabel,
            <span className={statusMeta(device.status).text}>{device.statusLabel}</span>,
            device.site || '—',
            <span className="num">{faDigits(device.degree)}</span>,
            device.group || '—',
          ])}
        />
      </section>

      <div className="grid gap-3 xl:grid-cols-2">
        <section>
          <SectionTitle icon={<Building2 size={14} />} title="مراکز تجمع" />
          <ReportTable
            headers={['نام', 'کد', 'تجهیزات', 'آنلاین', 'آفلاین', 'روی دیاگرام']}
            rows={report.sites.map((site) => [
              site.name,
              <span className="num">{site.code || '—'}</span>,
              <span className="num">{faDigits(site.deviceCount)}</span>,
              <span className="num text-emerald-700">{faDigits(site.onlineCount)}</span>,
              <span className="num text-red-700">{faDigits(site.offlineCount)}</span>,
              site.onDiagram ? 'بله' : 'خیر',
            ])}
          />
        </section>
        <section>
          <SectionTitle icon={<RouteIcon size={14} />} title="مسیرهای اصلی و پشتیبان" hint={`${faDigits(report.pathCounts.groups)} گروه`} />
          <ReportTable
            headers={['گروه', 'نقش', 'مبدأ → مقصد', 'گام', 'وضعیت', 'جاری']}
            rows={report.paths.flatMap((group) =>
              (['primary', 'backup'] as const)
                .map((role) => {
                  const leg = group[role];
                  if (!leg) return null;
                  return [
                    group.name,
                    role === 'primary' ? 'اصلی' : 'پشتیبان',
                    `${leg.from} → ${leg.to}`,
                    <span className="num">{faDigits(leg.hops)}</span>,
                    <span className={leg.status === 'up' ? 'text-emerald-700' : leg.status === 'down' ? 'text-red-700' : 'text-ink-500'}>{leg.statusLabel}</span>,
                    leg.active ? 'فعال' : 'غیرفعال',
                  ] as React.ReactNode[];
                })
                .filter((row): row is React.ReactNode[] => row !== null)
            )}
          />
        </section>
      </div>

      <section>
        <SectionTitle icon={<Network size={14} />} title="وضعیت لینک‌ها و اختلالات" hint={`${faDigits(report.links.length)} لینک`} />
        <ReportTable
          headers={['لینک', 'مبدأ', 'مقصد', 'نوع', 'وضعیت', 'تأخیر', 'افت', 'دلیل']}
          rows={report.links.map((link) => {
            const meta = LINK_STATUS_META[link.status as keyof typeof LINK_STATUS_META] ?? LINK_STATUS_META.unknown;
            return [
              <span className="font-medium text-ink-700">{link.label}</span>,
              link.from,
              link.to,
              link.kindLabel,
              <span className={`inline-flex items-center gap-1 rounded-pill border px-1.5 py-0.5 text-[9px] ${meta.border} ${meta.soft} ${meta.text}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} /> {link.statusLabel}
              </span>,
              link.latencyMs == null ? '—' : `${faDigits(link.latencyMs)} ms`,
              link.lossPct == null ? '—' : `${faDigits(link.lossPct)}٪`,
              <span className="block max-w-[260px] truncate text-ink-500" title={link.reason}>{link.reason || '—'}</span>,
            ];
          })}
        />
      </section>

      <section>
        <SectionTitle icon={<ShieldAlert size={14} />} title="نقاط بحرانی و وابستگی تجهیزات" hint={`${faDigits(report.risks.criticalNodeCount)} نقطه · ${faDigits(report.risks.riskyLinkCount)} لینک تک‌مسیره`} />
        <div className="grid gap-2 lg:grid-cols-2">
          <div className="rounded-soft border border-ink-200 bg-white p-2.5">
            <p className="mb-1 text-[10.5px] font-semibold text-ink-600">تجهیزات برشی</p>
            <div className="max-h-48 space-y-1 overflow-y-auto">
              {report.risks.criticalNodes.map((node) => (
                <div key={node.id} className="flex items-center gap-2 rounded-lg bg-ink-50/60 px-2 py-1 text-[10px]">
                  <span className="min-w-0 flex-1 truncate text-ink-700">{node.label}</span>
                  <span className="shrink-0 text-ink-400">{node.roleLabel}</span>
                  <span className="num shrink-0 text-red-700">{faDigits(node.dependentDeviceCount)} وابسته</span>
                  <span className="shrink-0 rounded-pill border border-red-200 bg-red-50 px-1 text-red-700">{node.severityLabel}</span>
                </div>
              ))}
              {!report.risks.criticalNodes.length ? <p className="text-[10px] text-ink-400">نقطهٔ بحرانی با تجهیز وابسته شناسایی نشد.</p> : null}
            </div>
          </div>
          <div className="rounded-soft border border-ink-200 bg-white p-2.5">
            <p className="mb-1 text-[10.5px] font-semibold text-ink-600">اختلالات فعال تا مرکز زیرساخت</p>
            <div className="max-h-48 space-y-1 overflow-y-auto">
              {report.risks.incidents.map((incident) => (
                <div key={`${incident.type}-${incident.id}`} className="rounded-lg bg-ink-50/60 px-2 py-1 text-[10px]">
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate font-medium text-ink-700">{incident.label}</span>
                    <span className="shrink-0 text-ink-400">{incident.typeLabel}</span>
                    <span className="num shrink-0 text-red-700">{faDigits(incident.affectedDeviceCount)} متأثر</span>
                  </div>
                  <p className="truncate text-[9.5px] text-ink-500">{incident.reason}</p>
                </div>
              ))}
              {!report.risks.incidents.length ? <p className="text-[10px] text-ink-400">اختلال فعالی از دادهٔ زنده گزارش نشده است.</p> : null}
            </div>
          </div>
        </div>
      </section>

      {report.warnings.length ? (
        <section className="rounded-soft border border-amber-200 bg-amber-50/60 p-2.5">
          <p className="mb-1 flex items-center gap-1 text-[10.5px] font-semibold text-amber-800">
            <AlertTriangle size={12} /> هشدارها و محدودیت‌های داده
          </p>
          <ul className="space-y-0.5 text-[10px] text-amber-800">
            {report.warnings.map((warning) => (
              <li key={warning}>• {warning}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="text-[9.5px] text-ink-400">
        خروجی PDF برای مرور و ارائه و Excel برای تحلیل کامل و استفاده خارج از نرم‌افزار است. هر دو فایل از همین دادهٔ گزارش ساخته می‌شوند.
      </p>
    </div>
  );
}

export default function HistoryPanel({ diagramId, revision, canWrite, locked, onClose, onRestore }: Props) {
  const [tab, setTab] = useState<Tab>('history');
  const [versions, setVersions] = useState<TopoVersionSummary[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<TopoVersionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [compareBase, setCompareBase] = useState<number | null>(null);
  const [compareTarget, setCompareTarget] = useState<number | 'current'>('current');
  const [compare, setCompare] = useState<TopoChangeSet | null>(null);
  const [compareInfo, setCompareInfo] = useState('');
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [compareError, setCompareError] = useState('');
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [restoreNotice, setRestoreNotice] = useState('');

  const loadVersions = useCallback(
    async (before?: number, signal?: AbortSignal) => {
      setLoading(true);
      setError('');
      try {
        const data = await api.topologyVersions(diagramId, { limit: 40, before }, signal);
        setVersions((prev) => {
          const merged = before ? [...prev, ...data.items] : data.items;
          const seen = new Set<number>();
          return merged.filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
          });
        });
        setNextBefore(data.nextBefore);
        const first = data.items[0];
        if (!before && first) {
          setSelectedId((current) => (current && data.items.some((item) => item.id === current) ? current : first.id));
          // پیش‌فرض مقایسه: نسخهٔ قبلی با وضعیت فعلی، تا تغییر آخر بلافاصله دیده شود.
          setCompareBase((current) =>
            current && data.items.some((item) => item.id === current)
              ? current
              : (data.items[1]?.id ?? first.id)
          );
        }
      } catch (err) {
        if (isAbortError(err)) return;
        setError(err instanceof Error ? err.message : 'دریافت تاریخچه ناموفق بود.');
      } finally {
        setLoading(false);
      }
    },
    [diagramId]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadVersions(undefined, controller.signal);
    return () => controller.abort();
  }, [loadVersions, revision]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError('');
    setCompare(null);
    setCompareError('');
    setConfirmRestore(false);
    setRestoreNotice('');
    api
      .topologyVersion(diagramId, selectedId, controller.signal)
      .then((data) => setDetail(data))
      .catch((err) => {
        if (isAbortError(err)) return;
        setDetailError(err instanceof Error ? err.message : 'دریافت جزئیات نسخه ناموفق بود.');
      })
      .finally(() => setDetailLoading(false));
    return () => controller.abort();
  }, [diagramId, selectedId]);

  const runCompare = async () => {
    if (!compareBase) return;
    setComparisonLoading(true);
    setCompareError('');
    setCompareInfo('');
    try {
      const result = await api.compareTopologyVersions(diagramId, compareBase, compareTarget);
      setCompare(result.changes);
      setCompareInfo(
        `${result.base.actionLabel} (ویرایش ${faDigits(result.base.revision)}) ← ${result.target.actionLabel} (ویرایش ${faDigits(result.target.revision)})`
      );
    } catch (err) {
      setCompareError(err instanceof Error ? err.message : 'مقایسهٔ نسخه‌ها ناموفق بود.');
      setCompare(null);
    } finally {
      setComparisonLoading(false);
    }
  };

  const doRestore = async () => {
    if (!detail) return;
    setRestoring(true);
    setRestoreError('');
    setRestoreNotice('');
    try {
      const restored = await onRestore(detail.id);
      setConfirmRestore(false);
      setRestoreNotice(
        restored.restoreWarnings?.length
          ? `دیاگرام بازگردانی شد؛ ${faDigits(restored.restoreWarnings.length)} هشدار دربارهٔ ارجاع‌های حذف‌شده ثبت شد.`
          : 'دیاگرام با موفقیت به این نسخه بازگردانی شد و وضعیت پیشین در تاریخچه باقی ماند.'
      );
      await loadVersions();
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : 'بازگردانی ناموفق بود.');
    } finally {
      setRestoring(false);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[1250] flex items-center justify-center bg-ink-900/45 p-2 backdrop-blur-sm sm:p-4" role="dialog" aria-modal="true" aria-label="تاریخچه و گزارش‌های دیاگرام">
      <div className="flex h-[94vh] w-full max-w-[1240px] flex-col overflow-hidden rounded-card border border-ink-200 bg-ink-50/95 shadow-pop">
        <header className="flex flex-wrap items-center gap-2 border-b border-ink-200 bg-white px-3 py-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-soft border border-brand-100 bg-brand-50 text-brand-600">
            <HistoryIcon size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-ink-800">تاریخچه و گزارش‌های دیاگرام</p>
            <p className="text-[10px] text-ink-400">نسخه‌های ساختاریافته، مقایسه، بازگردانی و خروجی مستندات شبکه</p>
          </div>
          <div className="flex items-center gap-1 rounded-soft border border-ink-200 bg-ink-50 p-0.5">
            <button
              type="button"
              className={`btn-xs ${tab === 'history' ? 'btn-primary' : 'btn-ghost !border-0'}`}
              onClick={() => setTab('history')}
            >
              <HistoryIcon size={13} /> نسخه‌ها
            </button>
            <button
              type="button"
              className={`btn-xs ${tab === 'reports' ? 'btn-primary' : 'btn-ghost !border-0'}`}
              onClick={() => setTab('reports')}
            >
              <FileBarChart size={13} /> گزارش‌ها
            </button>
          </div>
          <button type="button" className="btn-ghost btn-xs !px-2" onClick={onClose} aria-label="بستن">
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {tab === 'reports' ? (
            <ReportsView diagramId={diagramId} revision={revision} />
          ) : (
            <div className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
              <aside className="space-y-2">
                <div className="flex items-center gap-2">
                  <p className="flex-1 text-[11px] font-semibold text-ink-700">نسخه‌های ثبت‌شده</p>
                  <span className="chip">{faDigits(versions.length)}</span>
                  <button type="button" className="btn-ghost btn-xs !px-1.5" onClick={() => void loadVersions()} title="به‌روزرسانی فهرست" aria-label="به‌روزرسانی فهرست نسخه‌ها">
                    <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
                  </button>
                </div>
                {error ? <p className="rounded-lg bg-red-50 px-2 py-1 text-[10px] text-red-700">{error}</p> : null}
                <div className="max-h-[calc(94vh-190px)] space-y-1.5 overflow-y-auto pe-0.5">
                  {versions.map((item) => {
                    const selected = item.id === selectedId;
                    const change = item.changeSummary.total || 0;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setSelectedId(item.id)}
                        className={`w-full rounded-soft border px-2.5 py-2 text-right transition ${
                          selected ? 'border-brand-300 bg-brand-50/80 shadow-sm' : 'border-ink-200 bg-white hover:border-brand-200 hover:bg-brand-50/30'
                        }`}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className={`h-1.5 w-1.5 rounded-full ${item.action === 'restore' ? 'bg-violet-500' : item.action === 'create' ? 'bg-emerald-500' : item.action === 'paths' ? 'bg-sky-500' : 'bg-brand-400'}`} />
                          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-ink-800">{item.actionLabel}</span>
                          <span className="num shrink-0 rounded-pill bg-ink-100 px-1.5 text-[9px] text-ink-500">#{faDigits(item.id)}</span>
                        </div>
                        <p className="mt-0.5 truncate text-[9.5px] text-ink-500">{item.label || 'بدون توضیح'}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[9px] text-ink-400">
                          <span title={fullDate(item.createdAt)}>{fmtRelative(item.createdAt)}</span>
                          <span>·</span>
                          <span className="num">{faDigits(item.summary.nodes)} گره</span>
                          <span className="num">{faDigits(item.summary.links)} لینک</span>
                          {change ? <span className="rounded bg-amber-50 px-1 text-amber-700">{faDigits(change)} تغییر</span> : null}
                          {item.author ? (
                            <span className="inline-flex items-center gap-0.5">
                              <User size={8} /> {item.author}
                            </span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                  {!versions.length && !loading ? <p className="rounded-soft border border-ink-200 bg-white p-3 text-center text-[10.5px] text-ink-400">هنوز نسخه‌ای ثبت نشده است.</p> : null}
                  {loading ? (
                    <div className="flex justify-center py-3 text-ink-400">
                      <Loader2 size={16} className="animate-spin" />
                    </div>
                  ) : null}
                  {nextBefore ? (
                    <button type="button" className="btn-ghost btn-xs w-full justify-center" onClick={() => void loadVersions(nextBefore)} disabled={loading}>
                      نمایش نسخه‌های قدیمی‌تر
                    </button>
                  ) : null}
                </div>
                <p className="text-[9px] leading-4 text-ink-400">
                  حداکثر ۲۰۰ نسخهٔ آخر هر دیاگرام نگهداری می‌شود. هر ذخیرهٔ خودکار گراف، تغییر مسیرها و مشخصات، یک نسخهٔ قابل بازگردانی می‌سازد.
                </p>
              </aside>

              <section className="min-w-0 space-y-2.5">
                {detailLoading && !detail ? (
                  <div className="flex h-40 items-center justify-center gap-2 text-[11px] text-ink-500">
                    <Loader2 size={15} className="animate-spin" /> در حال خواندن نسخه…
                  </div>
                ) : detailError ? (
                  <p className="rounded-soft border border-red-200 bg-red-50 p-3 text-[11px] text-red-700">{detailError}</p>
                ) : detail ? (
                  <>
                    <div className="rounded-soft border border-ink-200 bg-white p-3">
                      <div className="flex flex-wrap items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <p className="text-[13px] font-semibold text-ink-800">{detail.actionLabel}</p>
                            <span className="chip num">نسخهٔ #{faDigits(detail.id)}</span>
                            <span className="chip num">گراف {faDigits(detail.revision)}</span>
                            {detail.restoredFrom ? <span className="chip border-violet-200 bg-violet-50 text-violet-700">از نسخهٔ #{faDigits(detail.restoredFrom)}</span> : null}
                          </div>
                          <p className="mt-0.5 text-[10.5px] text-ink-500">
                            {fullDate(detail.createdAt)} · {detail.author || 'کاربر نامشخص'} · {formatBytes(detail.sizeBytes)}
                          </p>
                          <p className="mt-1 text-[10.5px] text-ink-500">{detail.label || 'بدون توضیح'}</p>
                        </div>
                        {canWrite ? (
                          <button
                            type="button"
                            className="btn-warn btn-xs"
                            onClick={() => setConfirmRestore(true)}
                            disabled={locked || restoring}
                            title={locked ? 'برای بازگردانی ابتدا قفل دیاگرام را باز کنید' : 'بازگردانی دیاگرام به این نسخه'}
                          >
                            <RotateCcw size={13} /> بازگردانی این نسخه
                          </button>
                        ) : (
                          <span className="chip">فقط مشاهده</span>
                        )}
                      </div>

                      <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-5">
                        <MiniStat label="گره‌ها" value={faDigits(detail.summary.nodes)} />
                        <MiniStat label="لینک‌ها" value={faDigits(detail.summary.links)} />
                        <MiniStat label="مسیرها" value={faDigits(detail.summary.paths)} />
                        <MiniStat label="تجهیزات" value={faDigits(detail.summary.devices)} />
                        <MiniStat label="مراکز" value={faDigits(detail.summary.sites)} />
                      </div>

                      {restoreNotice ? (
                        <div className="mt-2 flex items-start gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-[10px] text-emerald-800">
                          <Check size={12} className="mt-0.5 shrink-0" /> {restoreNotice}
                        </div>
                      ) : null}
                      {restoreError ? (
                        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-2 py-1.5 text-[10px] text-red-700">{restoreError}</div>
                      ) : null}

                      {confirmRestore ? (
                        <div className="mt-2 rounded-soft border border-amber-200 bg-amber-50 p-2.5">
                          <p className="flex items-center gap-1 text-[11px] font-semibold text-amber-800">
                            <AlertTriangle size={13} /> بازگردانی دیاگرام به نسخهٔ #{faDigits(detail.id)}؟
                          </p>
                          <p className="mt-0.5 text-[10px] leading-5 text-amber-800">
                            گره‌ها، لینک‌ها و مسیرهای فعلی با محتوای این نسخه جایگزین می‌شوند. وضعیت فعلی پیش از بازگردانی
                            به‌صورت یک نسخهٔ جداگانه ثبت می‌شود؛ بنابراین این عمل قابل برگشت است.
                          </p>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            <button type="button" className="btn-primary btn-xs" onClick={() => void doRestore()} disabled={restoring}>
                              {restoring ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                              تأیید و بازگردانی
                            </button>
                            <button type="button" className="btn-ghost btn-xs" onClick={() => setConfirmRestore(false)} disabled={restoring}>
                              انصراف
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>

                    <div className="rounded-soft border border-ink-200 bg-white p-3">
                      <SectionTitle icon={<GitCompare size={14} />} title="مقایسهٔ نسخه‌ها" hint="هر دو نسخه یا وضعیت فعلی را انتخاب کنید" />
                      <div className="flex flex-wrap items-end gap-1.5">
                        <label className="block">
                          <span className="mb-0.5 block text-[9.5px] text-ink-400">از نسخه</span>
                          <select className="field !w-auto !py-1 text-[10.5px]" value={compareBase ?? ''} onChange={(event) => setCompareBase(Number(event.target.value) || null)}>
                            {versions.map((item) => (
                              <option key={item.id} value={item.id}>
                                #{item.id} — {item.actionLabel} — ویرایش {item.revision}
                              </option>
                            ))}
                          </select>
                        </label>
                        <ArrowLeft size={14} className="mb-1.5 text-ink-300" />
                        <label className="block">
                          <span className="mb-0.5 block text-[9.5px] text-ink-400">با</span>
                          <select className="field !w-auto !py-1 text-[10.5px]" value={compareTarget} onChange={(event) => setCompareTarget(event.target.value === 'current' ? 'current' : Number(event.target.value))}>
                            <option value="current">وضعیت فعلی</option>
                            {versions.map((item) => (
                              <option key={item.id} value={item.id}>
                                #{item.id} — {item.actionLabel} — ویرایش {item.revision}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button type="button" className="btn-soft btn-xs" onClick={() => void runCompare()} disabled={comparisonLoading || !compareBase}>
                          {comparisonLoading ? <Loader2 size={12} className="animate-spin" /> : <GitCompare size={12} />}
                          مقایسه
                        </button>
                      </div>
                      {compareInfo ? <p className="mt-2 text-[9.5px] text-ink-400">{compareInfo}</p> : null}
                      {compareError ? <p className="mt-2 rounded-lg bg-red-50 px-2 py-1 text-[10px] text-red-700">{compareError}</p> : null}
                    </div>

                    {compare ? <ChangesView changes={compare} /> : <ChangesView changes={detail.changes} />}
                  </>
                ) : null}
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
