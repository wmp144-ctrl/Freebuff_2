/**
 * پنجره‌های ماژول دیاگرام
 * ----------------------------------------------------------------
 * ایجاد دیاگرام، مدیریت مراکز تجمع و تخصیص تجهیزات، گالری الگوها، خروجی و
 * تأیید عملیات حساس. همهٔ درخواست‌ها از `api` می‌آیند و پس از موفقیت، دادهٔ
 * صفحه بازخوانی می‌شود؛ هیچ وضعیت محلی به‌عنوان منبع حقیقت نگه داشته نمی‌شود.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Building2,
  Check,
  Copy,
  Download,
  FileJson,
  Image as ImageIcon,
  LayoutTemplate,
  Loader2,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import type { TopoDiagram, TopoDiagramSummary, TopoSite, TopoCatalogItem } from '../../lib/types';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/store';
import { faDigits } from '../../lib/format';
import { Badge, EmptyState, ErrorState, Field, Modal, Spinner } from '../../components/ui';
import { LAYOUT_META, DEFAULT_SIZE } from '../../lib/topology';

/* ------------------------------------------------------------------ */
/* ایجاد / نام‌گذاری                                                    */
/* ------------------------------------------------------------------ */

export function NewDiagramDialog({
  open,
  onClose,
  onCreated,
  templates,
  busy,
  error,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (diagram: TopoDiagram) => void;
  templates: TopoDiagramSummary[];
  busy: boolean;
  error: string;
  onCreate: (body: { name: string; description: string; layout: string; fromTemplateId: number | null }) => Promise<TopoDiagram | null>;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [layout, setLayout] = useState('hierarchy-tb');
  const [templateId, setTemplateId] = useState('');
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    if (!open) return;
    setName('');
    setDescription('');
    setLayout('hierarchy-tb');
    setTemplateId('');
    setLocalError('');
  }, [open]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setLocalError('نام دیاگرام را وارد کنید.');
      return;
    }
    setLocalError('');
    const diagram = await onCreate({
      name: name.trim(),
      description: description.trim(),
      layout,
      fromTemplateId: templateId ? Number(templateId) : null,
    });
    if (diagram) onCreated(diagram);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="دیاگرام تازه"
      subtitle="یک بوم خالی یا نسخه‌ای از یک الگوی آماده بسازید."
      size="md"
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            انصراف
          </button>
          <button type="submit" form="new-diagram-form" className="btn-primary" disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} ساخت دیاگرام
          </button>
        </>
      }
    >
      <form id="new-diagram-form" onSubmit={submit} className="space-y-4">
        <Field label="نام دیاگرام" required>
          <input
            autoFocus
            className="field"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            placeholder="مثلاً توپولوژی ستاد مرکزی"
          />
        </Field>
        <Field label="توضیحات" hint="اختیاری — برای مستندسازی بعدی">
          <textarea
            className="field min-h-[70px] text-[12.5px]"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={500}
            placeholder="محدودهٔ شبکه، مسئول، تاریخ به‌روزرسانی…"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="چیدمان پیش‌فرض">
            <select className="field" value={layout} onChange={(event) => setLayout(event.target.value)}>
              {Object.entries(LAYOUT_META).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="شروع از الگو" hint={templates.length ? `${faDigits(templates.length)} الگو در دسترس` : 'هنوز الگویی ذخیره نشده است'}>
            <select className="field" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
              <option value="">بوم خالی</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({faDigits(t.nodeCount)} گره)
                </option>
              ))}
            </select>
          </Field>
        </div>
        {localError || error ? <p className="text-xs text-red-600">{localError || error}</p> : null}
        {templateId ? (
          <p className="rounded-soft border border-brand-100 bg-brand-50/60 p-2.5 text-[11px] leading-5 text-brand-700">
            ساختار گره‌ها، لینک‌ها و یادداشت‌ها از الگو کپی می‌شود؛ شناسه‌ها تازه‌اند و مرجع تجهیزات حذف‌شده حفظ نمی‌شود.
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

export function RenameDialog({
  open,
  title,
  label,
  initial,
  confirmLabel,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  label: string;
  initial: string;
  confirmLabel: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (name: string) => void;
}) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            انصراف
          </button>
          <button type="button" className="btn-primary" onClick={() => onConfirm(value.trim())} disabled={busy || !value.trim()}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />} {confirmLabel}
          </button>
        </>
      }
    >
      <Field label={label} required>
        <input autoFocus className="field" value={value} maxLength={120} onChange={(event) => setValue(event.target.value)} />
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* مدیریت مراکز تجمع                                                   */
/* ------------------------------------------------------------------ */

const EMPTY_FORM = {
  name: '',
  code: '',
  address: '',
  color: '#6366f1',
  notes: '',
};

export function SitesDialog({
  open,
  sites,
  focusSiteId,
  onClose,
  onChanged,
}: {
  open: boolean;
  sites: TopoSite[];
  focusSiteId: number | null;
  onClose: () => void;
  onChanged: (siteId?: number) => void;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [rowBusy, setRowBusy] = useState<number | null>(null);
  const [deleteArm, setDeleteArm] = useState(false);

  useEffect(() => {
    if (!open) return;
    const id = focusSiteId ?? sites[0]?.id ?? null;
    setSelectedId(id);
    setDeleteArm(false);
    setError('');
    setSearch('');
  }, [open, focusSiteId]); // عمداً به sites وابسته نیست تا با هر refresh انتخاب از دست نرود

  useEffect(() => {
    if (!open) return;
    const site = sites.find((s) => s.id === selectedId);
    if (site) {
      setForm({ name: site.name, code: site.code, address: site.address, color: site.color, notes: site.notes });
    } else {
      setForm({ ...EMPTY_FORM });
    }
  }, [selectedId, sites, open]);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(search.trim()), 280);
    return () => window.clearTimeout(id);
  }, [search]);

  const assigned = useAsync(
    (signal) =>
      selectedId
        ? api.topologyCatalog({ siteId: selectedId, limit: 1000 }, signal)
        : Promise.resolve({ items: [], total: 0, returned: 0, hasMore: false, generatedAt: Date.now() }),
    [selectedId, refresh]
  );

  const candidates = useAsync(
    (signal) => api.topologyCatalog({ search: debounced || undefined, limit: 200 }, signal),
    [debounced, refresh]
  );

  const assignedIds = useMemo(() => new Set((assigned.data?.items ?? []).map((d) => d.id)), [assigned.data]);

  const save = async () => {
    if (!form.name.trim()) {
      setError('نام مرکز تجمع الزامی است.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (selectedId) {
        const updated = await api.updateTopologySite(selectedId, { ...form, name: form.name.trim() });
        onChanged(updated.id);
      } else {
        const created = await api.createTopologySite({ ...form, name: form.name.trim() });
        setSelectedId(created.id);
        onChanged(created.id);
      }
      setRefresh((x) => x + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ذخیرهٔ مرکز تجمع ناموفق بود.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selectedId) return;
    if (!deleteArm) {
      setDeleteArm(true);
      return;
    }
    setBusy(true);
    try {
      await api.deleteTopologySite(selectedId);
      setSelectedId(null);
      setDeleteArm(false);
      onChanged();
      setRefresh((x) => x + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'حذف مرکز ناموفق بود.');
    } finally {
      setBusy(false);
    }
  };

  const toggleDevice = async (item: TopoCatalogItem, checked: boolean) => {
    if (!selectedId) {
      setError('ابتدا مرکز تجمع را ذخیره یا انتخاب کنید.');
      return;
    }
    setRowBusy(item.id);
    setError('');
    try {
      await api.assignTopologySiteDevices(selectedId, [item.id], checked ? 'assign' : 'remove');
      setRefresh((x) => x + 1);
      onChanged(selectedId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تخصیص تجهیز ناموفق بود.');
    } finally {
      setRowBusy(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="مراکز تجمع و تخصیص تجهیزات" subtitle="هر تجهیز حداکثر در یک مرکز تجمع قرار می‌گیرد؛ تخصیص تازه، عضویت قبلی را جابه‌جا می‌کند." size="xl">
      <div className="grid min-h-[440px] gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col rounded-soft border border-ink-100">
          <div className="flex items-center justify-between border-b border-ink-100 px-3 py-2">
            <p className="text-[11.5px] font-semibold text-ink-600">مراکز ({faDigits(sites.length)})</p>
            <button
              type="button"
              className="btn-soft btn-xs !px-2"
              onClick={() => {
                setSelectedId(null);
                setForm({ ...EMPTY_FORM });
                setDeleteArm(false);
                setError('');
              }}
            >
              <Plus size={12} /> جدید
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {sites.length === 0 ? (
              <p className="px-2 py-6 text-center text-[11px] text-ink-400">هنوز مرکزی تعریف نشده است.</p>
            ) : (
              sites.map((site) => (
                <button
                  key={site.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(site.id);
                    setDeleteArm(false);
                  }}
                  className={`mb-1 flex w-full items-center gap-2 rounded-soft px-2 py-2 text-right transition ${
                    selectedId === site.id ? 'bg-brand-50 ring-1 ring-brand-200' : 'hover:bg-ink-50'
                  }`}
                >
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg" style={{ background: `${site.color}18`, color: site.color }}>
                    <Building2 size={13} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11.5px] font-medium text-ink-700">{site.name}</span>
                    <span className="block text-[10px] text-ink-400">{faDigits(site.deviceCount)} تجهیز</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-soft border border-ink-100 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[12px] font-semibold text-ink-700">{selectedId ? 'ویرایش مرکز' : 'مرکز تجمع تازه'}</p>
              {selectedId ? (
                <Badge tone="ink">شناسه {faDigits(selectedId)}</Badge>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="نام" required className="sm:col-span-1">
                <input className="field text-[12px]" value={form.name} maxLength={100} onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))} />
              </Field>
              <Field label="کد">
                <input className="field num text-[12px]" value={form.code} maxLength={40} onChange={(event) => setForm((f) => ({ ...f, code: event.target.value }))} />
              </Field>
              <Field label="رنگ">
                <div className="flex items-center gap-1.5">
                  <input
                    type="color"
                    className="h-9 w-12 cursor-pointer rounded-soft border border-ink-200 bg-white"
                    value={form.color}
                    onChange={(event) => setForm((f) => ({ ...f, color: event.target.value }))}
                    aria-label="رنگ مرکز"
                  />
                  <input className="field num text-[11px]" value={form.color} maxLength={7} onChange={(event) => setForm((f) => ({ ...f, color: event.target.value }))} />
                </div>
              </Field>
              <Field label="نشانی" className="sm:col-span-2">
                <input className="field text-[12px]" value={form.address} maxLength={240} onChange={(event) => setForm((f) => ({ ...f, address: event.target.value }))} />
              </Field>
              <Field label="یادداشت">
                <input className="field text-[12px]" value={form.notes} maxLength={4000} onChange={(event) => setForm((f) => ({ ...f, notes: event.target.value }))} />
              </Field>
            </div>
            {error ? <p className="mt-2 rounded-soft bg-red-50 px-2 py-1.5 text-[11px] text-red-600">{error}</p> : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" className="btn-primary btn-xs" onClick={() => void save()} disabled={busy}>
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} ذخیرهٔ مرکز
              </button>
              {selectedId ? (
                <button type="button" className="btn-danger btn-xs" onClick={() => void remove()} disabled={busy}>
                  <Trash2 size={12} /> {deleteArm ? 'تأیید حذف؟ تجهیزات آزاد می‌شوند' : 'حذف مرکز'}
                </button>
              ) : null}
              {deleteArm ? (
                <button type="button" className="btn-ghost btn-xs" onClick={() => setDeleteArm(false)}>
                  انصراف
                </button>
              ) : null}
            </div>
          </div>

          <div className="rounded-soft border border-ink-100">
            <div className="border-b border-ink-100 px-3 py-2">
              <p className="text-[12px] font-semibold text-ink-700">
                تجهیزات این مرکز {selectedId ? `(${faDigits(assigned.data?.total ?? 0)})` : ''}
              </p>
            </div>
            <div className="max-h-40 overflow-y-auto p-2">
              {!selectedId ? (
                <p className="px-2 py-4 text-center text-[11px] text-ink-400">برای تخصیص تجهیز، ابتدا مرکز را ذخیره کنید.</p>
              ) : assigned.loading && !assigned.data ? (
                <div className="grid place-items-center py-6">
                  <Spinner />
                </div>
              ) : (assigned.data?.items.length ?? 0) === 0 ? (
                <p className="px-2 py-4 text-center text-[11px] text-ink-400">تجهیزی به این مرکز تخصیص نیافته است.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {assigned.data!.items.map((item) => (
                    <span key={item.id} className="inline-flex items-center gap-1 rounded-pill border border-ink-200 bg-white px-2 py-0.5 text-[10.5px] text-ink-600">
                      {item.name}
                      <button
                        type="button"
                        className="text-red-500 hover:text-red-700 disabled:opacity-50"
                        onClick={() => void toggleDevice(item, false)}
                        disabled={rowBusy === item.id}
                        aria-label={`حذف ${item.name} از مرکز`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="rounded-soft border border-ink-100">
            <div className="border-b border-ink-100 p-2.5">
              <div className="relative">
                <Search size={13} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-400" />
                <input
                  className="field !py-1.5 pr-8 text-[11.5px]"
                  placeholder="جست‌وجوی تجهیز برای تخصیص…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
            </div>
            <div className="max-h-48 overflow-y-auto p-1.5">
              {candidates.error ? (
                <ErrorState message={candidates.error} onRetry={candidates.reload} />
              ) : (candidates.data?.items ?? []).length === 0 ? (
                <p className="px-2 py-4 text-center text-[11px] text-ink-400">تجهیزی پیدا نشد.</p>
              ) : (
                candidates.data!.items.map((item) => {
                  const checked = assignedIds.has(item.id);
                  return (
                    <label
                      key={item.id}
                      className={`mb-0.5 flex cursor-pointer items-center gap-2 rounded-soft px-2 py-1.5 text-[11.5px] transition hover:bg-ink-50 ${
                        item.siteId && item.siteId !== selectedId ? 'opacity-70' : ''
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!selectedId || rowBusy === item.id}
                        onChange={(event) => void toggleDevice(item, event.target.checked)}
                        className="h-3.5 w-3.5 accent-brand-600"
                      />
                      <span className="min-w-0 flex-1 truncate text-ink-700">{item.name}</span>
                      <span className="num shrink-0 text-[10px] text-ink-400">{item.ip}</span>
                      {item.siteId && item.siteId !== selectedId ? (
                        <span className="shrink-0 text-[9px] text-amber-600" title={`اکنون در ${item.siteName || 'مرکز دیگر'}`}>
                          انتقال
                        </span>
                      ) : null}
                      {rowBusy === item.id ? <Loader2 size={11} className="animate-spin text-brand-500" /> : null}
                    </label>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* گالری الگوها                                                        */
/* ------------------------------------------------------------------ */

export function TemplatesDialog({
  open,
  templates,
  busyId,
  onClose,
  onUse,
  onDelete,
}: {
  open: boolean;
  templates: TopoDiagramSummary[];
  busyId: number | null;
  onClose: () => void;
  onUse: (template: TopoDiagramSummary) => void;
  onDelete: (template: TopoDiagramSummary) => void;
}) {
  const [arm, setArm] = useState<number | null>(null);
  return (
    <Modal open={open} onClose={onClose} title="الگوهای دیاگرام" subtitle="ساختار آماده را با یک کلیک به دیاگرام تازه تبدیل کنید." size="lg">
      {templates.length === 0 ? (
        <EmptyState
          icon={<LayoutTemplate size={22} />}
          title="هنوز الگویی ذخیره نشده است"
          description="از منوی دیاگرام، گزینهٔ «ذخیره به‌عنوان الگو» را بزنید تا ساختار فعلی برای استفادهٔ بعدی نگه داشته شود."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {templates.map((t) => (
            <div key={t.id} className="flex flex-col rounded-soft border border-ink-100 bg-white p-3.5">
              <div className="flex items-start gap-2">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-soft border border-violet-100 bg-violet-50 text-violet-600">
                  <LayoutTemplate size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] font-semibold text-ink-800">{t.name}</p>
                  <p className="mt-0.5 line-clamp-2 text-[10.5px] text-ink-400">{t.description || 'بدون توضیح'}</p>
                </div>
              </div>
              <div className="mt-2.5 flex flex-wrap gap-1.5 text-[10px]">
                <Badge tone="ink">{faDigits(t.nodeCount)} گره</Badge>
                <Badge tone="ink">{faDigits(t.linkCount)} لینک</Badge>
                {t.deviceCount ? <Badge tone="brand">{faDigits(t.deviceCount)} تجهیز</Badge> : null}
              </div>
              <div className="mt-3 flex items-center gap-1.5">
                <button type="button" className="btn-primary btn-xs flex-1" onClick={() => onUse(t)} disabled={busyId === t.id}>
                  {busyId === t.id ? <Loader2 size={12} className="animate-spin" /> : <Copy size={12} />} استفاده
                </button>
                <button
                  type="button"
                  className={`btn-xs ${arm === t.id ? 'btn-danger' : 'btn-ghost'}`}
                  onClick={() => {
                    if (arm === t.id) {
                      onDelete(t);
                      setArm(null);
                    } else {
                      setArm(t.id);
                    }
                  }}
                  disabled={busyId === t.id}
                >
                  <Trash2 size={12} /> {arm === t.id ? 'تأیید' : ''}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* خروجی                                                               */
/* ------------------------------------------------------------------ */

export function ExportDialog({
  open,
  onClose,
  onExportSvg,
  onExportPng,
  onExportJson,
  busy,
  nodeCount,
}: {
  open: boolean;
  onClose: () => void;
  onExportSvg: () => void;
  onExportPng: () => void;
  onExportJson: () => void;
  busy: string;
  nodeCount: number;
}) {
  return (
    <Modal open={open} onClose={onClose} title="خروجی دیاگرام" subtitle="همهٔ خروجی‌ها محلی ساخته می‌شوند و به اینترنت نیازی ندارند." size="md">
      <div className="grid gap-2.5 sm:grid-cols-3">
        {[
          {
            key: 'svg',
            icon: <Download size={18} />,
            title: 'SVG',
            hint: 'برداری، قابل ویرایش',
            action: onExportSvg,
          },
          {
            key: 'png',
            icon: <ImageIcon size={18} />,
            title: 'PNG',
            hint: 'تصویر با کیفیت بالا',
            action: onExportPng,
          },
          {
            key: 'json',
            icon: <FileJson size={18} />,
            title: 'JSON',
            hint: 'دادهٔ ساختاریافته',
            action: onExportJson,
          },
        ].map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={item.action}
            disabled={!!busy}
            className="group rounded-soft border border-ink-200 bg-white p-3 text-right transition hover:border-brand-300 hover:bg-brand-50/40 disabled:opacity-60"
          >
            <span className="mb-2 grid h-9 w-9 place-items-center rounded-soft border border-brand-100 bg-brand-50 text-brand-600 group-hover:border-brand-200">
              {busy === item.key ? <Loader2 size={17} className="animate-spin" /> : item.icon}
            </span>
            <span className="block text-[12px] font-semibold text-ink-700">{item.title}</span>
            <span className="mt-0.5 block text-[10.5px] text-ink-400">{item.hint}</span>
          </button>
        ))}
      </div>
      <p className="mt-3 rounded-soft bg-ink-50 p-2.5 text-[10.5px] leading-5 text-ink-500">
        تصویر شامل {faDigits(nodeCount)} گره و همهٔ لینک‌ها با رنگ وضعیت لحظه‌ای است. برای شبکه‌های بزرگ، PNG ممکن است چند لحظه طول بکشد.
      </p>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* تأیید                                                               */
/* ------------------------------------------------------------------ */

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'تأیید',
  tone = 'danger',
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            انصراف
          </button>
          <button type="button" className={tone === 'danger' ? 'btn-danger' : 'btn-primary'} onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-[12.5px] leading-6 text-ink-600">{message}</p>
    </Modal>
  );
}

export const NODE_DEFAULT_SIZE = DEFAULT_SIZE;
