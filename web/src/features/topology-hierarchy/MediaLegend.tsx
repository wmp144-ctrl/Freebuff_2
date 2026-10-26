/**
 * راهنمای رسانهٔ انتقال (نمونهٔ خط)
 * ----------------------------------------------------------------
 * الگوی هر رسانه همان چیزی است که در بوم رسم می‌شود؛ تغییر رنگ/الگو در
 * `MEDIA_META` خودکار در بوم، راهنما و بازرس دیده می‌شود.
 */
import { MEDIA_META, MEDIUM_ORDER, type TransmissionMedium } from '../../lib/topology-hierarchy';

export function MediaSample({ medium, width = 30 }: { medium: TransmissionMedium; width?: number }) {
  const meta = MEDIA_META[medium];
  return (
    <svg width={width} height="8" aria-hidden className="shrink-0">
      <line
        x1="2"
        y1="4"
        x2={width - 2}
        y2="4"
        stroke={meta.color}
        strokeWidth="2"
        strokeDasharray={meta.dash || undefined}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function MediaLegend({ className = '' }: { className?: string }) {
  return (
    <div
      dir="rtl"
      className={`rounded-soft border border-white/70 bg-white/92 px-2.5 py-2 shadow-soft backdrop-blur-xl ${className}`}
    >
      <p className="mb-1.5 text-[10px] font-semibold text-ink-500">رسانهٔ انتقال</p>
      <ul className="space-y-1">
        {MEDIUM_ORDER.map((medium) => (
          <li key={medium} className="flex items-center gap-1.5">
            <MediaSample medium={medium} />
            <span className="text-[10px] text-ink-600">{MEDIA_META[medium].label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
