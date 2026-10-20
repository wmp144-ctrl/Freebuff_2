import type { DeviceStatus, Priority, Severity } from './types';

const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

export function faDigits(value: string | number): string {
  return String(value).replace(/\d/g, (d) => FA_DIGITS[Number(d)]);
}

function shifted(ts: number, offsetMin = 210) {
  return new Date(ts + offsetMin * 60000);
}

// ساخت Intl.DateTimeFormat گران است و در نمودارها برای هر تیک و راهنمای ابزار
// فراخوانی می‌شود؛ نمونه‌ها یک‌بار ساخته و دوباره استفاده می‌شوند.
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function faFormatter(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(opts);
  let f = FORMATTERS.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'UTC', ...opts });
    FORMATTERS.set(key, f);
  }
  return f;
}

export function fmtDate(ts: number | null | undefined, offsetMin = 210): string {
  if (!ts) return '—';
  return faFormatter({ year: 'numeric', month: '2-digit', day: '2-digit' }).format(shifted(ts, offsetMin));
}

export function fmtClock(ts: number | null | undefined, offsetMin = 210): string {
  if (!ts) return '—';
  return faFormatter({ hour: '2-digit', minute: '2-digit', hour12: false }).format(shifted(ts, offsetMin));
}

export function fmtDateTime(ts: number | null | undefined, offsetMin = 210): string {
  if (!ts) return '—';
  return `${fmtDate(ts, offsetMin)} — ${fmtClock(ts, offsetMin)}`;
}

export function fmtDayLabel(day: string, offsetMin = 210): string {
  if (!day) return '—';
  const ts = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(ts)) return day;
  return faFormatter({ month: 'short', day: 'numeric' }).format(shifted(ts + 43200000, offsetMin));
}

export function fmtRangeLabel(t: number, range: string, offsetMin = 210): string {
  if (range === '1h' || range === '15m' || range === '6h') return fmtClock(t, offsetMin);
  if (range === '24h') return fmtClock(t, offsetMin);
  return faFormatter({ month: 'short', day: 'numeric' }).format(shifted(t, offsetMin));
}

/* ---------------------------------------------------------------- */
/* منطقهٔ زمانی                                                       */
/* ---------------------------------------------------------------- */

/**
 * برچسب منطقهٔ زمانی تنظیم‌شده (مثلاً UTC+۰۳:۳۰).
 * زمان‌ها در سراسر برنامه با همین اختلاف نمایش داده می‌شوند؛ نشان‌دادن برچسب
 * از تفسیر نادرست زمان ذخیره‌شده به وقت محلی مرورگر جلوگیری می‌کند.
 */
export function fmtTimezone(offsetMin: number | null | undefined): string {
  const total = Number.isFinite(offsetMin as number) ? Number(offsetMin) : 0;
  const sign = total < 0 ? '−' : '+';
  const abs = Math.abs(Math.round(total));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${faDigits(String(h).padStart(2, '0'))}:${faDigits(String(m).padStart(2, '0'))}`;
}

export function fmtRelative(ts: number | null | undefined): string {
  if (!ts) return '—';
  const diff = Math.max(0, Date.now() - ts) / 1000;
  if (diff < 45) return 'لحظاتی پیش';
  if (diff < 90) return '۱ دقیقه پیش';
  if (diff < 3600) return `${faDigits(Math.round(diff / 60))} دقیقه پیش`;
  if (diff < 86400) return `${faDigits(Math.round(diff / 3600))} ساعت پیش`;
  const d = Math.round(diff / 86400);
  if (d === 1) return 'دیروز';
  return `${faDigits(d)} روز پیش`;
}

export function fmtDuration(sec: number | null | undefined, style: 'long' | 'short' = 'long'): string {
  if (sec == null || Number.isNaN(sec)) return '—';
  const s = Math.max(0, Math.round(sec));
  if (style === 'short') {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return faDigits(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`);
  }
  if (s < 60) return `${faDigits(s)} ثانیه`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 2 && m < 10 ? `${faDigits(m)} دقیقه و ${faDigits(rem)} ثانیه` : `${faDigits(m)} دقیقه`;
  }
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m ? `${faDigits(h)} ساعت و ${faDigits(m)} دقیقه` : `${faDigits(h)} ساعت`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.round((s % 86400) / 3600);
  return h ? `${faDigits(d)} روز و ${faDigits(h)} ساعت` : `${faDigits(d)} روز`;
}

export function fmtNumber(value: number | null | undefined, digits = 0): string {
  if (value == null || Number.isNaN(value)) return '—';
  return faDigits(value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
}

export function fmtMs(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  const digits = value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${faDigits(value.toFixed(digits))} ms`;
}

export function fmtPct(value: number | null | undefined, digits = 1): string {
  if (value == null || Number.isNaN(value)) return '—';
  return `${faDigits(value.toFixed(digits))}٪`;
}

export interface StatusMeta {
  label: string;
  text: string;
  bg: string;
  border: string;
  dot: string;
  chart: string;
}

export const STATUS_META: Record<DeviceStatus, StatusMeta> = {
  online: {
    label: 'در دسترس',
    text: 'text-emerald-700',
    bg: 'bg-emerald-50',
    border: 'border-emerald-200',
    dot: 'bg-emerald-500',
    chart: '#16a34a',
  },
  warning: {
    label: 'دارای اختلال',
    text: 'text-sun-700',
    bg: 'bg-sun-50',
    border: 'border-sun-200',
    dot: 'bg-sun-500',
    chart: '#f59e0b',
  },
  offline: {
    label: 'قطع‌شده',
    text: 'text-red-700',
    bg: 'bg-red-50',
    border: 'border-red-200',
    dot: 'bg-red-500',
    chart: '#dc2626',
  },
  maintenance: {
    label: 'در تعمیرات',
    text: 'text-violet-700',
    bg: 'bg-violet-50',
    border: 'border-violet-200',
    dot: 'bg-violet-500',
    chart: '#7c3aed',
  },
  unknown: {
    label: 'نامشخص',
    text: 'text-ink-500',
    bg: 'bg-ink-100',
    border: 'border-ink-200',
    dot: 'bg-ink-400',
    chart: '#94a3b8',
  },
};

export function statusMeta(status: DeviceStatus | string | undefined): StatusMeta {
  return STATUS_META[(status as DeviceStatus) ?? 'unknown'] ?? STATUS_META.unknown;
}

export const SEVERITY_META: Record<Severity, { label: string; text: string; bg: string; border: string; dot: string }> = {
  info: { label: 'اطلاع', text: 'text-brand-700', bg: 'bg-brand-50', border: 'border-brand-200', dot: 'bg-brand-500' },
  warning: { label: 'هشدار', text: 'text-sun-700', bg: 'bg-sun-50', border: 'border-sun-200', dot: 'bg-sun-500' },
  critical: { label: 'بحرانی', text: 'text-red-700', bg: 'bg-red-50', border: 'border-red-200', dot: 'bg-red-500' },
};

export const PRIORITY_META: Record<Priority, { label: string; className: string }> = {
  low: { label: 'کم', className: 'text-ink-500 bg-ink-100 border-ink-200' },
  normal: { label: 'عادی', className: 'text-brand-700 bg-brand-50 border-brand-200' },
  high: { label: 'بالا', className: 'text-sun-700 bg-sun-50 border-sun-200' },
  critical: { label: 'بحرانی', className: 'text-red-700 bg-red-50 border-red-200' },
};

export const ALERT_KIND_LABEL: Record<string, string> = {
  offline: 'قطع دسترسی',
  latency: 'تأخیر بالا',
  loss: 'افت بسته',
  recovery: 'بازگشت به حالت عادی',
  maintenance: 'تعمیرات',
};

export const DEVICE_TYPES = [
  'روتر',
  'سوئیچ',
  'فایروال',
  'سرور',
  'دوربین IP',
  'اکسس‌پوینت',
  'UPS شبکه',
  'مودم',
  'NVR',
  'کنترلر',
  'سایر',
];

export function healthTone(score: number) {
  if (score >= 92) return { text: 'text-emerald-600', ring: '#10b981', bg: 'from-emerald-50 to-emerald-100/40' };
  if (score >= 80) return { text: 'text-brand-600', ring: '#2563eb', bg: 'from-brand-50 to-brand-100/40' };
  if (score >= 65) return { text: 'text-sun-600', ring: '#f59e0b', bg: 'from-sun-50 to-sun-100/40' };
  if (score >= 45) return { text: 'text-orange-600', ring: '#f97316', bg: 'from-orange-50 to-orange-100/40' };
  return { text: 'text-red-600', ring: '#dc2626', bg: 'from-red-50 to-red-100/40' };
}
