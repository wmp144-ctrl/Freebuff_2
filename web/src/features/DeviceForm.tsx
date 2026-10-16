import React, { useEffect, useMemo, useState } from 'react';
import { Check, MapPin, Save, Server, SlidersHorizontal, Tag as TagIcon } from 'lucide-react';
import { api } from '../lib/api';
import { useApp, useToast } from '../lib/store';
import { DEVICE_TYPES, PRIORITY_META } from '../lib/format';
import { Field, Modal, Toggle } from '../components/ui';
import type { Device, Priority } from '../lib/types';

interface FormState {
  name: string;
  ip: string;
  hostname: string;
  device_type: string;
  group: string;
  location: string;
  building: string;
  rack: string;
  latitude: string;
  longitude: string;
  vendor: string;
  model: string;
  serial: string;
  owner: string;
  notes: string;
  priority: Priority;
  enabled: boolean;
  monitoring_enabled: boolean;
  ping_interval: string;
  timeout_ms: string;
  packet_count: string;
  retries: string;
  latency_threshold: string;
  loss_threshold: string;
  tags: string[];
}

const empty: FormState = {
  name: '',
  ip: '',
  hostname: '',
  device_type: 'سوئیچ',
  group: '',
  location: '',
  building: '',
  rack: '',
  latitude: '',
  longitude: '',
  vendor: '',
  model: '',
  serial: '',
  owner: '',
  notes: '',
  priority: 'normal',
  enabled: true,
  monitoring_enabled: true,
  ping_interval: '',
  timeout_ms: '',
  packet_count: '',
  retries: '',
  latency_threshold: '',
  loss_threshold: '',
  tags: [],
};

export default function DeviceForm({
  open,
  onClose,
  device,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  device?: Device | null;
  onSaved?: (d: Device) => void;
}) {
  const { meta, refreshMeta, settings } = useApp();
  const { push } = useToast();
  const [form, setForm] = useState<FormState>(empty);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'general' | 'monitoring' | 'geo'>('general');

  useEffect(() => {
    if (!open) return;
    setError(null);
    setTab('general');
    if (device) {
      setForm({
        name: device.name,
        ip: device.ip,
        hostname: device.hostname,
        device_type: device.deviceType,
        group: device.groupName ?? '',
        location: device.location,
        building: device.building,
        rack: device.rack,
        latitude: device.latitude == null ? '' : String(device.latitude),
        longitude: device.longitude == null ? '' : String(device.longitude),
        vendor: device.vendor,
        model: device.model,
        serial: device.serial,
        owner: device.owner,
        notes: device.notes,
        priority: device.priority,
        enabled: device.enabled,
        monitoring_enabled: device.monitoringEnabled,
        ping_interval: device.pingInterval == null ? '' : String(device.pingInterval),
        timeout_ms: device.timeoutMs == null ? '' : String(device.timeoutMs),
        packet_count: device.packetCount == null ? '' : String(device.packetCount),
        retries: device.retries == null ? '' : String(device.retries),
        latency_threshold: device.latencyThreshold == null ? '' : String(device.latencyThreshold),
        loss_threshold: device.lossThreshold == null ? '' : String(device.lossThreshold),
        tags: (device.tags || []).map((t) => t.name),
      });
    } else {
      setForm({ ...empty, group: meta?.groups?.[0]?.name ?? '' });
    }
  }, [open, device, meta?.groups]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const ipValid = useMemo(() => {
    if (!form.ip.trim()) return false;
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(form.ip.trim()) || /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(form.ip.trim());
  }, [form.ip]);

  const submit = async () => {
    setError(null);
    if (!form.name.trim()) return setError('نام تجهیز را وارد کنید');
    if (!ipValid) return setError('آدرس IP یا نام هاست معتبر نیست');
    const num = (v: string) => (v.trim() === '' ? null : Number(v));
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      ip: form.ip.trim(),
      hostname: form.hostname.trim(),
      device_type: form.device_type,
      group: form.group.trim(),
      location: form.location.trim(),
      building: form.building.trim(),
      rack: form.rack.trim(),
      latitude: form.latitude === '' ? null : Number(form.latitude),
      longitude: form.longitude === '' ? null : Number(form.longitude),
      vendor: form.vendor.trim(),
      model: form.model.trim(),
      serial: form.serial.trim(),
      owner: form.owner.trim(),
      notes: form.notes.trim(),
      priority: form.priority,
      enabled: form.enabled ? 1 : 0,
      monitoring_enabled: form.monitoring_enabled ? 1 : 0,
      ping_interval: num(form.ping_interval),
      timeout_ms: num(form.timeout_ms),
      packet_count: num(form.packet_count),
      retries: num(form.retries),
      latency_threshold: num(form.latency_threshold),
      loss_threshold: num(form.loss_threshold),
      tagNames: form.tags,
    };
    if (payload.latitude != null && (Number.isNaN(payload.latitude) || Math.abs(Number(payload.latitude)) > 90)) return setError('عرض جغرافیایی نامعتبر است');
    if (payload.longitude != null && (Number.isNaN(payload.longitude) || Math.abs(Number(payload.longitude)) > 180)) return setError('طول جغرافیایی نامعتبر است');

    setSaving(true);
    try {
      const saved = device ? await api.updateDevice(device.id, payload) : await api.createDevice(payload as never);
      push(device ? 'تغییرات تجهیز ذخیره شد' : 'تجهیز جدید افزوده شد', 'success');
      await refreshMeta();
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const tabs = [
    { key: 'general' as const, label: 'اطلاعات عمومی', icon: <Server size={14} /> },
    { key: 'monitoring' as const, label: 'تنظیمات پایش', icon: <SlidersHorizontal size={14} /> },
    { key: 'geo' as const, label: 'موقعیت و تگ', icon: <MapPin size={14} /> },
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={device ? `ویرایش تجهیز — ${device.name}` : 'افزودن تجهیز جدید'}
      subtitle="اطلاعات تجهیز را وارد کنید. فیلدهای ستاره‌دار الزامی هستند."
      footer={
        <>
          {error ? <p className="me-auto text-xs text-red-600">{error}</p> : null}
          <button type="button" className="btn-ghost" onClick={onClose}>
            انصراف
          </button>
          <button type="button" className="btn-primary" onClick={submit} disabled={saving}>
            <Save size={15} />
            {saving ? 'در حال ذخیره…' : 'ذخیره'}
          </button>
        </>
      }
    >
      <div className="mb-4 flex flex-wrap gap-1 rounded-soft bg-ink-100/70 p-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-[12.5px] font-medium transition ${
              tab === t.key ? 'bg-white text-brand-700 shadow-soft' : 'text-ink-500 hover:text-ink-700'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'general' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="نام تجهیز" required>
            <input className="field" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="مثلاً سوئیچ دسترسی طبقه ۳" />
          </Field>
          <Field label="آدرس IP" required error={form.ip && !ipValid ? 'آدرس IP نامعتبر است' : undefined}>
            <input dir="ltr" className="field num" value={form.ip} onChange={(e) => set('ip', e.target.value)} placeholder="192.168.1.10" />
          </Field>
          <Field label="نام هاست">
            <input dir="ltr" className="field num" value={form.hostname} onChange={(e) => set('hostname', e.target.value)} placeholder="sw-floor3.local" />
          </Field>
          <Field label="نوع تجهیز">
            <select className="field" value={form.device_type} onChange={(e) => set('device_type', e.target.value)}>
              {DEVICE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          <Field label="گروه" hint="در صورت نبود، گروه جدید ساخته می‌شود">
            <input className="field" value={form.group} onChange={(e) => set('group', e.target.value)} list="groups-list" placeholder="سوئیچ‌های دسترسی" />
            <datalist id="groups-list">
              {(meta?.groups ?? []).map((g) => (
                <option key={g.id} value={g.name} />
              ))}
            </datalist>
          </Field>
          <Field label="محل استقرار">
            <input className="field" value={form.location} onChange={(e) => set('location', e.target.value)} placeholder="تهران — ساختمان اداری" />
          </Field>
          <Field label="ساختمان">
            <input className="field" value={form.building} onChange={(e) => set('building', e.target.value)} />
          </Field>
          <Field label="رک / موقعیت فیزیکی">
            <input className="field" value={form.rack} onChange={(e) => set('rack', e.target.value)} placeholder="R12-U4" />
          </Field>
          <Field label="سازنده">
            <input className="field" value={form.vendor} onChange={(e) => set('vendor', e.target.value)} placeholder="Cisco" />
          </Field>
          <Field label="مدل">
            <input className="field" value={form.model} onChange={(e) => set('model', e.target.value)} />
          </Field>
          <Field label="شماره سریال">
            <input dir="ltr" className="field num" value={form.serial} onChange={(e) => set('serial', e.target.value)} />
          </Field>
          <Field label="مسئول / تیم">
            <input className="field" value={form.owner} onChange={(e) => set('owner', e.target.value)} placeholder="تیم شبکه" />
          </Field>
          <Field label="اولویت پایش">
            <select className="field" value={form.priority} onChange={(e) => set('priority', e.target.value as Priority)}>
              {(Object.keys(PRIORITY_META) as Priority[]).map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_META[p].label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="توضیحات" className="sm:col-span-2">
            <textarea className="field min-h-[76px]" value={form.notes} onChange={(e) => set('notes', e.target.value)} />
          </Field>
          <div className="sm:col-span-2 grid gap-3 sm:grid-cols-2">
            <Toggle checked={form.enabled} onChange={(v) => set('enabled', v)} label="تجهیز فعال است" hint="تجهیزات غیرفعال در گزارش‌ها و داشبورد لحاظ نمی‌شوند" />
            <Toggle
              checked={form.monitoring_enabled}
              onChange={(v) => set('monitoring_enabled', v)}
              label="پایش خودکار فعال باشد"
              hint="در صورت غیرفعال بودن، موتور مانیتورینگ برای این تجهیز Ping ارسال نمی‌کند"
            />
          </div>
        </div>
      ) : null}

      {tab === 'monitoring' ? (
        <div className="space-y-4">
          <p className="rounded-soft border border-brand-100 bg-brand-50/60 p-3 text-[11.5px] leading-relaxed text-brand-800">
            در صورت خالی گذاشتن هر فیلد، مقدار عمومی تنظیمات برنامه استفاده می‌شود. مقادیر فعلی عمومی: بازه{' '}
            <span className="num font-semibold">{settings?.ping_interval ?? 30}</span> ثانیه، زمان انتظار{' '}
            <span className="num font-semibold">{settings?.timeout_ms ?? 1200}</span> میلی‌ثانیه، Packet{' '}
            <span className="num font-semibold">{settings?.packet_count ?? 3}</span>، تلاش مجدد{' '}
            <span className="num font-semibold">{settings?.retries ?? 1}</span>.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="بازه ارسال Ping (ثانیه)" hint="اولویت در موتور مانیتورینگ">
              <input type="number" min={5} dir="ltr" className="field num" value={form.ping_interval} onChange={(e) => set('ping_interval', e.target.value)} />
            </Field>
            <Field label="زمان انتظار پاسخ (ms)">
              <input type="number" min={100} dir="ltr" className="field num" value={form.timeout_ms} onChange={(e) => set('timeout_ms', e.target.value)} />
            </Field>
            <Field label="تعداد Packet در هر بررسی">
              <input type="number" min={1} max={10} dir="ltr" className="field num" value={form.packet_count} onChange={(e) => set('packet_count', e.target.value)} />
            </Field>
            <Field label="تعداد تلاش مجدد">
              <input type="number" min={0} max={5} dir="ltr" className="field num" value={form.retries} onChange={(e) => set('retries', e.target.value)} />
            </Field>
            <Field label="آستانه مجاز تأخیر (ms)">
              <input type="number" min={1} dir="ltr" className="field num" value={form.latency_threshold} onChange={(e) => set('latency_threshold', e.target.value)} />
            </Field>
            <Field label="آستانه مجاز افت بسته (٪)">
              <input type="number" min={0} max={100} dir="ltr" className="field num" value={form.loss_threshold} onChange={(e) => set('loss_threshold', e.target.value)} />
            </Field>
          </div>
        </div>
      ) : null}

      {tab === 'geo' ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="عرض جغرافیایی (Latitude)" hint="بین ۹۰- و ۹۰">
              <input dir="ltr" className="field num" value={form.latitude} onChange={(e) => set('latitude', e.target.value)} placeholder="35.6892" />
            </Field>
            <Field label="طول جغرافیایی (Longitude)" hint="بین ۱۸۰- و ۱۸۰">
              <input dir="ltr" className="field num" value={form.longitude} onChange={(e) => set('longitude', e.target.value)} placeholder="51.3890" />
            </Field>
          </div>
          <Field label="تگ‌ها" hint="با Enter یا کاما جدا کنید — تگ‌های جدید به‌صورت خودکار ساخته می‌شوند">
            <TagPicker value={form.tags} onChange={(tags) => set('tags', tags)} suggestions={(meta?.tags ?? []).map((t) => t.name)} />
          </Field>
        </div>
      ) : null}
    </Modal>
  );
}

function TagPicker({
  value,
  onChange,
  suggestions,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  suggestions: string[];
}) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const parts = raw
      .split(/[,،]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) return;
    onChange([...new Set([...value, ...parts])]);
    setDraft('');
  };
  return (
    <div className="rounded-soft border border-ink-200 bg-white/90 p-2.5">
      <div className="mb-2 flex flex-wrap gap-1.5">
        {value.length === 0 ? <span className="text-[11px] text-ink-400">تگی انتخاب نشده است</span> : null}
        {value.map((t) => (
          <span key={t} className="chip border-brand-200 bg-brand-50 px-2 py-0.5 text-[11px] text-brand-700">
            <TagIcon size={11} />
            {t}
            <button type="button" className="text-brand-400 hover:text-red-500" onClick={() => onChange(value.filter((x) => x !== t))}>
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          className="field !py-1.5 text-[12px]"
          value={draft}
          list="tag-suggestions"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(draft);
            }
          }}
          placeholder="نام تگ…"
        />
        <datalist id="tag-suggestions">
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <button type="button" className="btn-soft btn-xs" onClick={() => add(draft)}>
          <Check size={13} />
          افزودن
        </button>
      </div>
    </div>
  );
}
