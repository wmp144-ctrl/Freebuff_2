import React, { useEffect, useState } from 'react';
import { Save, Wrench } from 'lucide-react';
import { api } from '../lib/api';
import { useApp, useToast } from '../lib/store';
import { Field, Modal } from '../components/ui';
import type { MaintenanceRecord } from '../lib/types';

function toLocalInput(ts: number | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function MaintenanceForm({
  open,
  onClose,
  record,
  deviceId,
  outageId,
  defaults,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  record?: MaintenanceRecord | null;
  deviceId?: number | null;
  outageId?: number | null;
  defaults?: { cause?: string; startedAt?: number };
  onSaved?: () => void;
}) {
  const { settings } = useApp();
  const { push } = useToast();
  const devicesList = useDeviceOptions(open);

  const [form, setForm] = useState({
    device_id: '',
    title: '',
    cause: 'سایر',
    action: 'سایر',
    started_at: toLocalInput(Date.now()),
    ended_at: '',
    technician: '',
    cost: '',
    description: '',
    notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (record) {
      setForm({
        device_id: String(record.deviceId),
        title: record.title,
        cause: record.cause,
        action: record.action,
        started_at: toLocalInput(record.startedAt),
        ended_at: toLocalInput(record.endedAt),
        technician: record.technician,
        cost: record.cost ? String(record.cost) : '',
        description: record.description,
        notes: record.notes,
      });
    } else {
      setForm({
        device_id: deviceId ? String(deviceId) : '',
        title: '',
        cause: defaults?.cause ?? settings?.repair_causes?.[0] ?? 'سایر',
        action: settings?.repair_actions?.[0] ?? 'سایر',
        started_at: toLocalInput(defaults?.startedAt ?? Date.now()),
        ended_at: '',
        technician: '',
        cost: '',
        description: '',
        notes: '',
      });
    }
  }, [open, record, deviceId, defaults?.cause, defaults?.startedAt, settings?.repair_causes, settings?.repair_actions]);

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (saving) return;
    if (!form.device_id) return setError('انتخاب تجهیز الزامی است');
    setSaving(true);
    setError(null);
    const payload: Record<string, unknown> = {
      device_id: Number(form.device_id),
      outage_id: outageId ?? record?.outageId ?? null,
      title: form.title || `سابقه تعمیرات — ${form.action}`,
      cause: form.cause,
      action: form.action,
      started_at: form.started_at ? new Date(form.started_at).getTime() : Date.now(),
      ended_at: form.ended_at ? new Date(form.ended_at).getTime() : null,
      technician: form.technician,
      cost: form.cost === '' ? 0 : Number(form.cost),
      description: form.description,
      notes: form.notes,
    };
    try {
      if (record) await api.updateMaintenance(record.id, payload);
      else await api.createMaintenance(payload);
      push(record ? 'سابقه تعمیرات به‌روزرسانی شد' : 'سابقه تعمیرات ثبت شد', 'success');
      onSaved?.();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={record ? 'ویرایش سابقه تعمیرات' : 'ثبت سابقه تعمیرات و نگهداری'}
      subtitle="علت خرابی، اقدام انجام‌شده و توضیحات تکمیلی را ثبت کنید."
      footer={
        <>
          {error ? <p className="me-auto text-xs text-red-600">{error}</p> : null}
          <button type="button" className="btn-ghost" onClick={onClose}>
            انصراف
          </button>
          <button type="button" className="btn-primary" onClick={submit} disabled={saving}>
            <Save size={15} />
            {saving ? 'در حال ذخیره…' : 'ذخیره سابقه'}
          </button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="تجهیز" required className="sm:col-span-2">
          <select className="field" value={form.device_id} onChange={(e) => set('device_id', e.target.value)} disabled={!!deviceId || !!record}>
            <option value="">انتخاب تجهیز…</option>
            {devicesList.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} — {d.ip}
              </option>
            ))}
          </select>
        </Field>
        <Field label="عنوان سابقه">
          <input className="field" value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="مثلاً تعویض ماژول فیبر" />
        </Field>
        <Field label="علت خرابی / قطعی" required>
          <select className="field" value={form.cause} onChange={(e) => set('cause', e.target.value)}>
            {(settings?.repair_causes ?? ['سایر']).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="اقدام انجام‌شده" required>
          <select className="field" value={form.action} onChange={(e) => set('action', e.target.value)}>
            {(settings?.repair_actions ?? ['سایر']).map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </Field>
        <Field label="تکنسین / مسئول">
          <input className="field" value={form.technician} onChange={(e) => set('technician', e.target.value)} placeholder="مثلاً م. رضایی" />
        </Field>
        <Field label="زمان شروع" required>
          <input type="datetime-local" dir="ltr" className="field num" value={form.started_at} onChange={(e) => set('started_at', e.target.value)} />
        </Field>
        <Field label="زمان پایان" hint="خالی بگذارید اگر تعمیر در جریان است">
          <input type="datetime-local" dir="ltr" className="field num" value={form.ended_at} onChange={(e) => set('ended_at', e.target.value)} />
        </Field>
        <Field label="هزینه (ریال)" hint="اختیاری">
          <input type="number" dir="ltr" className="field num" value={form.cost} onChange={(e) => set('cost', e.target.value)} />
        </Field>
        <Field label="شرح اقدامات انجام‌شده" className="sm:col-span-2">
          <textarea className="field min-h-[80px]" value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="جزئیات اقدامات صورت‌گرفته…" />
        </Field>
        <Field label="توضیحات تکمیلی" className="sm:col-span-2">
          <textarea className="field min-h-[64px]" value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </Field>
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-[11px] text-ink-400">
        <Wrench size={12} />
        فهرست علت‌ها و اقدامات از بخش «تنظیمات ← تعمیرات» قابل ویرایش است.
      </p>
    </Modal>
  );
}

function useDeviceOptions(open: boolean) {
  const [items, setItems] = useState<{ id: number; name: string; ip: string }[]>([]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api
      .devices({ pageSize: 500, sort: 'name' })
      .then((res) => {
        if (alive) setItems(res.items.map((d) => ({ id: d.id, name: d.name, ip: d.ip })));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open]);
  return items;
}
