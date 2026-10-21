import React, { useMemo, useState } from 'react';
import { AlertTriangle, Check, Edit3, LayoutTemplate, Plus, RefreshCw, Search, Server, Trash2, Wand2 } from 'lucide-react';
import { api } from '../lib/api';
import { useAsync, useApp, useToast } from '../lib/store';
import { useAuth } from '../lib/auth';
import { faDigits } from '../lib/format';
import { Badge, Card, CardHeader, EmptyState, ErrorState, Field, Modal, PageLoader, Toggle } from '../components/ui';
import type { Device, DeviceTemplate, TemplateField } from '../lib/types';

const NUMERIC_FIELDS = new Set(['ping_interval', 'timeout_ms', 'packet_count', 'retries', 'latency_threshold', 'loss_threshold']);

function toForm(settings: Record<string, unknown>, fields: TemplateField[]) {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = settings[f.key];
    if (v === undefined || v === null) out[f.key] = '';
    else if (f.key === 'monitoring_enabled') out[f.key] = Number(v) ? '1' : '0';
    else out[f.key] = String(v);
  }
  return out;
}

function toSettings(form: Record<string, string>) {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(form)) {
    if (raw === '' || raw === undefined) continue;
    if (key === 'monitoring_enabled') out[key] = raw === '1' ? 1 : 0;
    else if (NUMERIC_FIELDS.has(key)) {
      const n = Number(raw);
      if (Number.isFinite(n)) out[key] = n;
    } else out[key] = raw;
  }
  return out;
}

export default function Templates() {
  const { push } = useToast();
  const { meta } = useApp();
  const { can } = useAuth();
  const canWrite = can('devices:write');

  const templates = useAsync((signal) => api.templates(signal), []);
  const devices = useAsync((signal) => api.devices({ pageSize: 500, sort: 'name' }, signal), []);

  const [editing, setEditing] = useState<DeviceTemplate | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [form, setForm] = useState<Record<string, string>>({});
  const [applyOpen, setApplyOpen] = useState(false);
  const [applyTemplate, setApplyTemplate] = useState<DeviceTemplate | null>(null);
  const [deviceSearch, setDeviceSearch] = useState('');
  const [selectedDevices, setSelectedDevices] = useState<number[]>([]);
  const [selectedFields, setSelectedFields] = useState<string[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);

  const fields = templates.data?.fields ?? [];
  const list = templates.data?.items ?? [];
  const devicesList = devices.data?.items ?? [];

  const openCreate = () => {
    setEditing(null);
    setName('');
    setDescription('');
    setForm(toForm({}, fields));
    setFormOpen(true);
  };

  const openEdit = (t: DeviceTemplate) => {
    setEditing(t);
    setName(t.name);
    setDescription(t.description);
    setForm(toForm(t.settings, fields));
    setFormOpen(true);
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const body = { name, description, settings: toSettings(form) };
      if (editing) await api.updateTemplate(editing.id, body);
      else await api.createTemplate(body);
      push(editing ? 'قالب به‌روزرسانی شد' : 'قالب جدید ساخته شد', 'success');
      setFormOpen(false);
      templates.refresh();
    } catch (e) {
      push((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (t: DeviceTemplate) => {
    if (!window.confirm(`قالب «${t.name}» حذف شود؟ تجهیزات تغییری نمی‌کنند.`)) return;
    try {
      await api.deleteTemplate(t.id);
      push('قالب حذف شد', 'success');
      templates.refresh();
    } catch (e) {
      push((e as Error).message, 'error');
    }
  };

  const openApply = (t: DeviceTemplate) => {
    setApplyTemplate(t);
    setSelectedDevices([]);
    setSelectedFields(Object.keys(t.settings));
    setOverwrite(false);
    setDeviceSearch('');
    setApplyOpen(true);
  };

  const apply = async () => {
    if (!applyTemplate || busy) return;
    if (!selectedDevices.length) return push('حداقل یک تجهیز انتخاب کنید', 'error');
    if (!selectedFields.length) return push('حداقل یک فیلد انتخاب کنید', 'error');
    if (overwrite && !window.confirm('با فعال بودن «بازنویسی»، مقادیر اختصاصی تجهیزات انتخاب‌شده جایگزین می‌شوند. ادامه می‌دهید؟')) return;
    setBusy(true);
    try {
      const res = await api.applyTemplate(applyTemplate.id, { deviceIds: selectedDevices, fields: selectedFields, overwrite });
      push(`${faDigits(res.updated)} تجهیز به‌روزرسانی شد (${faDigits(res.skipped)} بدون تغییر)`, 'success');
      setApplyOpen(false);
      devices.refresh();
    } catch (e) {
      push((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const filteredDevices = useMemo(() => {
    const q = deviceSearch.trim().toLowerCase();
    if (!q) return devicesList;
    return devicesList.filter((d) => d.name.toLowerCase().includes(q) || d.ip.includes(q));
  }, [devicesList, deviceSearch]);

  if (templates.loading && !templates.data) return <PageLoader label="در حال دریافت قالب‌ها…" />;
  if (templates.error && !templates.data) return <ErrorState message={templates.error} onRetry={templates.refresh} />;

  return (
    <div className="space-y-4">
      <Card padded={false} className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-soft border border-brand-100 bg-brand-50 text-brand-600">
            <LayoutTemplate size={19} />
          </span>
          <div>
            <p className="text-[13px] font-semibold text-ink-800">قالب‌های تجهیز</p>
            <p className="text-[10.5px] text-ink-400">تنظیمات مشترک را یک‌بار تعریف و روی تجهیزات هم‌نوع اعمال کنید.</p>
          </div>
          <div className="ms-auto flex gap-2">
            <button type="button" className="btn-ghost btn-xs" onClick={() => templates.refresh()} disabled={templates.refreshing}>
              <RefreshCw size={14} className={templates.refreshing ? 'animate-spin' : ''} />
              بروزرسانی
            </button>
            {canWrite ? (
              <button type="button" className="btn-primary btn-xs" onClick={openCreate}>
                <Plus size={14} />
                قالب جدید
              </button>
            ) : null}
          </div>
        </div>
        <p className="mt-3 rounded-soft border border-sun-200 bg-sun-50/50 p-3 text-[10.5px] leading-relaxed text-sun-800">
          <AlertTriangle size={12} className="inline" /> اعمال قالب به‌صورت پیش‌فرض فقط فیلدهای خالی را پر می‌کند. بازنویسی تنظیمات اختصاصی فقط با فعال‌کردن صریح «بازنویسی» و تأیید دوباره انجام می‌شود.
        </p>
      </Card>

      {list.length === 0 ? (
        <Card>
          <EmptyState title="هنوز قالبی ساخته نشده" description="برای تجهیزات هم‌نوع (مثلاً همهٔ سوئیچ‌های دسترسی) یک قالب با بازهٔ پایش و آستانه‌های مشترک بسازید." />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.map((t) => (
            <Card key={t.id}>
              <CardHeader
                title={t.name}
                subtitle={t.description || 'بدون توضیح'}
                icon={<LayoutTemplate size={18} />}
                action={
                  canWrite ? (
                    <div className="flex gap-1">
                      <button type="button" className="btn-ghost btn-xs" onClick={() => openEdit(t)} aria-label="ویرایش قالب">
                        <Edit3 size={13} />
                      </button>
                      <button type="button" className="btn-ghost btn-xs text-red-600" onClick={() => remove(t)} aria-label="حذف قالب">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ) : null
                }
              />
              <div className="mt-3 flex flex-wrap gap-1.5">
                {Object.entries(t.settings).map(([key, value]) => (
                  <span key={key} className="chip border-ink-200 bg-white/80 text-[10.5px] text-ink-600">
                    {fields.find((f) => f.key === key)?.label ?? key}: <b className="num">{String(value)}</b>
                  </span>
                ))}
              </div>
              <p className="mt-3 text-[10.5px] text-ink-400">
                سازنده: {t.createdBy || '—'} · {faDigits(Object.keys(t.settings).length)} تنظیم
              </p>
              {canWrite ? (
                <button type="button" className="btn-soft btn-xs mt-3 w-full justify-center" onClick={() => openApply(t)}>
                  <Wand2 size={13} />
                  اعمال روی تجهیزات
                </button>
              ) : null}
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        size="lg"
        title={editing ? `ویرایش قالب — ${editing.name}` : 'قالب تجهیز جدید'}
        subtitle="فقط تنظیمات مشترک را انتخاب کنید؛ نام، IP و یادداشت اختصاصی هر تجهیز است."
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={() => setFormOpen(false)}>
              انصراف
            </button>
            <button type="button" className="btn-primary" onClick={save} disabled={busy}>
              <Check size={15} />
              {busy ? 'در حال ذخیره…' : 'ذخیرهٔ قالب'}
            </button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="نام قالب" required>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً سوئیچ دسترسی سیسکو" />
          </Field>
          <Field label="توضیح">
            <input className="field" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <div className="sm:col-span-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {fields.map((f) => (
              <Field key={f.key} label={f.label}>
                {f.key === 'monitoring_enabled' ? (
                  <select className="field" value={form[f.key] ?? ''} onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}>
                    <option value="">(خالی)</option>
                    <option value="1">فعال</option>
                    <option value="0">غیرفعال</option>
                  </select>
                ) : f.key === 'priority' ? (
                  <select className="field" value={form[f.key] ?? ''} onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}>
                    <option value="">(خالی)</option>
                    <option value="low">کم</option>
                    <option value="normal">عادی</option>
                    <option value="high">بالا</option>
                    <option value="critical">بحرانی</option>
                  </select>
                ) : f.key === 'device_type' ? (
                  <select className="field" value={form[f.key] ?? ''} onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}>
                    <option value="">(خالی)</option>
                    {(meta?.types ?? []).map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.value}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    dir={NUMERIC_FIELDS.has(f.key) ? 'ltr' : undefined}
                    className={`field ${NUMERIC_FIELDS.has(f.key) ? 'num' : ''}`}
                    type={NUMERIC_FIELDS.has(f.key) ? 'number' : 'text'}
                    value={form[f.key] ?? ''}
                    onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                  />
                )}
              </Field>
            ))}
          </div>
        </div>
      </Modal>

      <Modal
        open={applyOpen}
        onClose={() => setApplyOpen(false)}
        size="xl"
        title={`اعمال قالب — ${applyTemplate?.name ?? ''}`}
        subtitle="فیلدهای موردنظر و تجهیزات مقصد را انتخاب کنید."
        footer={
          <>
            {overwrite ? <p className="me-auto text-[10.5px] text-red-600">حالت بازنویسی فعال است؛ مقادیر اختصاصی جایگزین می‌شوند.</p> : null}
            <button type="button" className="btn-ghost" onClick={() => setApplyOpen(false)}>
              انصراف
            </button>
            <button type="button" className="btn-primary" onClick={apply} disabled={busy}>
              <Wand2 size={15} />
              {busy ? 'در حال اعمال…' : 'اعمال قالب'}
            </button>
          </>
        }
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <p className="mb-2 text-[11.5px] font-semibold text-ink-700">فیلدهای قابل اعمال</p>
            <div className="space-y-1.5 rounded-soft border border-ink-200 p-3">
              {Object.keys(applyTemplate?.settings ?? {}).map((key) => (
                <label key={key} className="flex cursor-pointer items-center gap-2 text-[11.5px] text-ink-600">
                  <input
                    type="checkbox"
                    className="accent-brand-600"
                    checked={selectedFields.includes(key)}
                    onChange={(e) => setSelectedFields((s) => (e.target.checked ? [...s, key] : s.filter((x) => x !== key)))}
                  />
                  {fields.find((f) => f.key === key)?.label ?? key}
                </label>
              ))}
            </div>
            <div className="mt-3">
              <Toggle
                checked={overwrite}
                onChange={setOverwrite}
                label="بازنویسی تنظیمات اختصاصی تجهیزات"
                hint="در حالت خاموش فقط فیلدهای خالی پر می‌شوند."
              />
            </div>
          </div>
          <div>
            <div className="mb-2 flex items-center gap-2">
              <p className="text-[11.5px] font-semibold text-ink-700">تجهیزات مقصد</p>
              <span className="text-[10px] text-ink-400">{faDigits(selectedDevices.length)} انتخاب‌شده</span>
              <button
                type="button"
                className="btn-ghost btn-xs ms-auto"
                onClick={() => setSelectedDevices(selectedDevices.length === filteredDevices.length ? [] : filteredDevices.map((d) => d.id))}
              >
                {selectedDevices.length === filteredDevices.length && filteredDevices.length ? 'لغو' : 'همه'}
              </button>
            </div>
            <div className="relative mb-2">
              <Search size={13} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-400" />
              <input className="field !py-1.5 !pr-8 text-[11.5px]" placeholder="جست‌وجوی نام یا IP…" value={deviceSearch} onChange={(e) => setDeviceSearch(e.target.value)} />
            </div>
            <div className="max-h-[300px] space-y-1 overflow-auto rounded-soft border border-ink-200 p-2">
              {filteredDevices.length === 0 ? (
                <p className="p-2 text-[11px] text-ink-400">تجهیزی یافت نشد.</p>
              ) : (
                filteredDevices.map((d: Device) => (
                  <label key={d.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[11.5px] hover:bg-ink-50">
                    <input
                      type="checkbox"
                      className="accent-brand-600"
                      checked={selectedDevices.includes(d.id)}
                      onChange={(e) => setSelectedDevices((s) => (e.target.checked ? [...s, d.id] : s.filter((x) => x !== d.id)))}
                    />
                    <Server size={12} className="text-ink-400" />
                    <span className="truncate text-ink-700">{d.name}</span>
                    <span className="num ms-auto text-[10px] text-ink-400" dir="ltr">
                      {d.ip}
                    </span>
                    {d.deviceType ? <Badge tone="ink">{d.deviceType}</Badge> : null}
                  </label>
                ))
              )}
            </div>
          </div>
        </div>
        {applyTemplate ? (
          <p className="mt-4 rounded-soft border border-ink-200 bg-ink-50/60 p-3 text-[10.5px] text-ink-500">
            این قالب {faDigits(Object.keys(applyTemplate.settings).length)} تنظیم مشترک دارد. تغییر قالب هیچ‌گاه به‌تنهایی روی تجهیزات اعمال نمی‌شود؛ اعمال فقط با دکمهٔ همین پنجره انجام می‌گیرد.
          </p>
        ) : null}
      </Modal>
    </div>
  );
}
