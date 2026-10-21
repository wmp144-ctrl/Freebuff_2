import React from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Info, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { useAsync } from '../lib/store';
import { faDigits, fmtRelative } from '../lib/format';
import { Badge, Card, CardHeader, EmptyState, ErrorState, PageLoader } from '../components/ui';
import type { ConflictItem } from '../lib/types';

const TYPE_LABELS: Record<string, string> = {
  duplicate_serial: 'شماره سریال تکراری',
  duplicate_hostname: 'نام هاست تکراری',
  discovery_conflict: 'تلاقی IP با نتایج کشف',
  discovery_duplicate_hostname: 'نام هاست تکراری در کشف',
};

const CONFIDENCE_LABELS: Record<string, string> = {
  low: 'شاهد ضعیف',
  medium: 'شاهد متوسط',
  high: 'شاهد قوی',
};

export default function Conflicts() {
  const { data, loading, error, refresh, refreshing, updatedAt } = useAsync((signal) => api.conflicts(signal), [], { interval: 60000 });

  if (loading && !data) return <PageLoader label="در حال بررسی شواهد تعارض…" />;
  if (error && !data) return <ErrorState message={error} onRetry={refresh} />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <Card padded={false} className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-soft border border-sun-200 bg-sun-50 text-sun-700">
            <ShieldAlert size={19} />
          </span>
          <div>
            <p className="text-[13px] font-semibold text-ink-800">تشخیص تعارض IP</p>
            <p className="text-[10.5px] text-ink-400">
              بررسی {faDigits(data.checkedDevices)} تجهیز · آخرین بررسی {updatedAt ? fmtRelative(updatedAt) : '—'}
            </p>
          </div>
          <div className="ms-auto flex items-center gap-2">
            <Badge tone="sun">{faDigits(data.summary.total)} مورد مشکوک</Badge>
            <button type="button" className="btn-ghost btn-xs" onClick={refresh} disabled={refreshing}>
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              بررسی مجدد
            </button>
          </div>
        </div>
        <div className="mt-3 flex items-start gap-2 rounded-soft border border-brand-100 bg-brand-50/50 p-3 text-[10.5px] leading-relaxed text-brand-800">
          <Info size={14} className="mt-0.5 shrink-0" />
          <p>
            {data.note} قید یکتای IP در پایگاه‌داده مانع ثبت دو تجهیز با یک IP می‌شود؛ بنابراین این صفحه فقط «موارد مشکوک با شاهد» (سریال/نام هاست تکراری یا تلاقی با نتایج کشف) را نشان می‌دهد و هیچ تعارضی را بدون تأیید مدیر قطعی اعلام نمی‌کند.
          </p>
        </div>
      </Card>

      {data.items.length === 0 ? (
        <Card>
          <EmptyState
            title="مورد مشکوکی یافت نشد"
            description="هیچ شاهد تکراری‌بودن (سریال/نام هاست) در تجهیزات ثبت‌شده دیده نمی‌شود."
          />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {data.items.map((item) => (
            <ConflictCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function ConflictCard({ item }: { item: ConflictItem }) {
  const tone = item.severity === 'warning' ? 'sun' : 'brand';
  return (
    <Card className="border-sun-200/70">
      <CardHeader
        title={item.title}
        subtitle={TYPE_LABELS[item.type] ?? item.type}
        icon={<AlertTriangle size={18} />}
        action={
          <div className="flex flex-col items-end gap-1">
            <Badge tone={tone}>{CONFIDENCE_LABELS[item.confidence] ?? item.confidence}</Badge>
            <span className="text-[9.5px] text-ink-400">غیرقطعی — نیازمند تأیید</span>
          </div>
        }
      />
      <p className="mt-3 text-[11.5px] leading-relaxed text-ink-600">{item.detail}</p>
      {item.ip ? (
        <p className="mt-2 inline-flex items-center gap-1 rounded bg-ink-100 px-2 py-1 text-[11px] text-ink-700">
          IP: <span className="num font-semibold" dir="ltr">{item.ip}</span>
        </p>
      ) : null}
      <div className="mt-3">
        <p className="mb-1.5 flex items-center gap-1 text-[10.5px] font-semibold text-ink-600">
          <ShieldCheck size={12} /> شواهد
        </p>
        <ul className="space-y-1 rounded-soft border border-ink-200 bg-ink-50/50 p-2.5 text-[10.5px] text-ink-600">
          {item.evidence.map((e) => (
            <li key={e} className="list-inside list-disc">
              {e}
            </li>
          ))}
        </ul>
      </div>
      {item.devices.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {item.devices.map((d) => (
            <Link key={d.id} to={`/devices/${d.id}`} className="chip border-brand-200 bg-brand-50 text-[10.5px] text-brand-700 hover:border-brand-300">
              {d.name} <span className="num text-brand-500" dir="ltr">{d.ip}</span>
            </Link>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
