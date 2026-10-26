/**
 * قالب‌بندی مقادیر فنی توپولوژی
 * ----------------------------------------------------------------
 * ارقام فارسی برای خوانایی، اما IP و شناسه‌ها همیشه لاتین و LTR می‌مانند.
 */
import { faDigits } from '../../lib/format';

/** ظرفیت لینک: مگابیت یا گیگابیت */
export function fmtBandwidth(mbps?: number | null): string {
  if (mbps == null || !Number.isFinite(mbps)) return '—';
  if (mbps >= 1000) {
    const gbps = mbps / 1000;
    const text = Number.isInteger(gbps) ? String(gbps) : gbps.toFixed(1);
    return `${faDigits(text)} گیگابیت`;
  }
  return `${faDigits(mbps)} مگابیت`;
}

/** تأخیر یک‌طرفه */
export function fmtLatency(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const text = Number.isInteger(ms) ? String(ms) : ms.toFixed(1);
  return `${faDigits(text)} میلی‌ثانیه`;
}

/** تعداد با جداکنندهٔ هزارگان */
export function fmtCount(value: number): string {
  return faDigits(String(value));
}
