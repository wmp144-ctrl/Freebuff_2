import React, { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Upload, X } from 'lucide-react';
import { api, downloadUrl } from '../lib/api';
import { useToast } from '../lib/store';
import { faDigits } from '../lib/format';
import { Badge, Modal } from '../components/ui';

interface PreviewResult {
  fileName: string;
  totalRows: number;
  errors: { row: number; name: string; ip: string; issues: string[] }[];
  duplicates: { row: number; name: string; ip: string; issues: string[] }[];
  valid: unknown[];
  summary: { valid: number; invalid: number; duplicates: number; newGroups: string[]; newTags: string[] };
}

export default function ImportDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { push } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [onlyValid, setOnlyValid] = useState(true);
  const [result, setResult] = useState<{ inserted: number; skipped: number; failed: { name: string; ip: string; reason: string }[] } | null>(null);

  const reset = () => {
    setFile(null);
    setPreview(null);
    setResult(null);
    setBusy(false);
  };

  const pick = async (f: File) => {
    if (busy) return;
    setFile(f);
    setBusy(true);
    setResult(null);
    try {
      const res = await api.importPreview(f);
      setPreview(res);
      if (res.totalRows === 0) push('هیچ ردیف داده‌ای در فایل یافت نشد', 'warning');
    } catch (e) {
      push((e as Error).message, 'error');
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!file || busy) return;
    setBusy(true);
    try {
      const res = await api.importCommit(file, onlyValid);
      setResult(res);
      push(`${faDigits(res.inserted)} تجهیز با موفقیت افزوده شد`, 'success');
      onDone?.();
    } catch (e) {
      push((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      size="lg"
      title="ورود گروهی تجهیزات از فایل Excel / CSV"
      subtitle="فایل را انتخاب کنید؛ ابتدا اعتبارسنجی انجام می‌شود و سپس ثبت نهایی صورت می‌گیرد."
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={() => { reset(); onClose(); }}>
            بستن
          </button>
          {preview && !result ? (
            <button type="button" className="btn-primary" onClick={commit} disabled={busy || preview.summary.valid === 0}>
              <Upload size={15} />
              {busy ? 'در حال ثبت…' : `ثبت ${faDigits(preview.summary.valid)} تجهیز`}
            </button>
          ) : null}
        </>
      }
    >
      {!preview ? (
        <div className="space-y-4">
          <div
            className="flex flex-col items-center justify-center gap-3 rounded-card border-2 border-dashed border-brand-200 bg-brand-50/40 px-6 py-12 text-center transition hover:border-brand-300"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) pick(f);
            }}
          >
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-white text-brand-500 shadow-soft">
              <FileSpreadsheet size={26} />
            </span>
            <div>
              <p className="text-sm font-semibold text-ink-700">فایل Excel (xlsx/xls) یا CSV را اینجا رها کنید</p>
              <p className="mt-1 text-[11.5px] text-ink-500">
                ستون‌های پشتیبانی‌شده: نام تجهیز، آدرس IP، نوع، گروه، موقعیت، عرض/طول جغرافیایی، سازنده، اولویت، تگ‌ها و…
              </p>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) pick(f);
              }}
            />
            <button type="button" className="btn-primary" onClick={() => inputRef.current?.click()} disabled={busy}>
              <Upload size={15} />
              {busy ? 'در حال بررسی…' : 'انتخاب فایل'}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-soft border border-ink-200 bg-white/70 p-3">
            <span className="text-[11.5px] text-ink-500">فایل نمونه ندارید؟ از قالب آماده استفاده کنید:</span>
            <a className="btn-ghost btn-xs" href={downloadUrl('/devices/template', { format: 'xlsx' })}>
              <Download size={13} />
              قالب Excel
            </a>
            <a className="btn-ghost btn-xs" href={downloadUrl('/devices/template', { format: 'csv' })}>
              <Download size={13} />
              قالب CSV
            </a>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-soft border border-ink-200 bg-white/70 p-3">
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium text-ink-700">{preview.fileName}</p>
              <p className="mt-0.5 text-[11px] text-ink-500">{faDigits(preview.totalRows)} ردیف خوانده شد</p>
            </div>
            <button type="button" className="btn-ghost btn-xs" onClick={reset}>
              <X size={13} />
              انتخاب فایل دیگر
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryTile tone="emerald" label="معتبر" value={preview.summary.valid} icon={<CheckCircle2 size={16} />} />
            <SummaryTile tone="sun" label="دارای خطا" value={preview.summary.invalid} icon={<AlertTriangle size={16} />} />
            <SummaryTile tone="red" label="IP تکراری" value={preview.summary.duplicates} icon={<AlertTriangle size={16} />} />
          </div>

          {preview.summary.newGroups.length || preview.summary.newTags.length ? (
            <div className="rounded-soft border border-brand-100 bg-brand-50/60 p-3">
              <p className="text-[11.5px] font-medium text-brand-800">موارد جدیدی که ساخته خواهند شد:</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {preview.summary.newGroups.map((g) => (
                  <Badge key={g} tone="brand">
                    گروه: {g}
                  </Badge>
                ))}
                {preview.summary.newTags.map((t) => (
                  <Badge key={t} tone="sun">
                    تگ: {t}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}

          {preview.errors.length ? (
            <div className="rounded-soft border border-sun-200 bg-sun-50/50">
              <p className="border-b border-sun-100 px-3 py-2 text-[12px] font-medium text-sun-800">
                ردیف‌های دارای مشکل ({faDigits(preview.errors.length)})
              </p>
              <div className="max-h-56 overflow-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>ردیف</th>
                      <th>نام</th>
                      <th>IP</th>
                      <th>مشکل</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.errors.slice(0, 60).map((e) => (
                      <tr key={e.row}>
                        <td className="num">{faDigits(e.row)}</td>
                        <td>{e.name || '—'}</td>
                        <td className="num">{e.ip || '—'}</td>
                        <td className="text-red-600 text-[11.5px]">{e.issues.join(' · ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {!result ? (
            <label className="flex items-center gap-2 rounded-soft border border-ink-200 bg-white/70 p-3 text-[12px] text-ink-600">
              <input type="checkbox" checked={onlyValid} onChange={(e) => setOnlyValid(e.target.checked)} className="accent-brand-600" />
              فقط ردیف‌های معتبر ثبت شوند (ردیف‌های دارای خطا نادیده گرفته می‌شوند)
            </label>
          ) : (
            <div className="rounded-soft border border-emerald-200 bg-emerald-50/60 p-3">
              <p className="text-[12.5px] font-medium text-emerald-800">
                {faDigits(result.inserted)} تجهیز ثبت شد
                {result.skipped ? ` — ${faDigits(result.skipped)} ردیف نامعتبر رد شد` : ''}
                {result.failed.length ? ` — ${faDigits(result.failed.length)} ردیف ناموفق` : ''}
              </p>
              {result.failed.length ? (
                <ul className="mt-2 space-y-1 text-[11px] text-red-600">
                  {result.failed.slice(0, 8).map((f, i) => (
                    <li key={i} className="num">
                      {f.ip} — {f.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function SummaryTile({ tone, label, value, icon }: { tone: 'emerald' | 'sun' | 'red'; label: string; value: number; icon: React.ReactNode }) {
  const tones = {
    emerald: 'border-emerald-100 bg-emerald-50/70 text-emerald-700',
    sun: 'border-sun-100 bg-sun-50/70 text-sun-700',
    red: 'border-red-100 bg-red-50/70 text-red-600',
  };
  return (
    <div className={`rounded-soft border p-3 ${tones[tone]}`}>
      <div className="flex items-center gap-2 text-[11.5px] font-medium">
        {icon}
        {label}
      </div>
      <p className="num mt-1.5 text-xl font-bold">{faDigits(value)}</p>
    </div>
  );
}
