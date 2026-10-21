/**
 * توابع خالص نمایش وضعیت زندهٔ دیاگرام (مرحلهٔ ۲)
 * ----------------------------------------------------------------
 * رنگ‌ها، قالب‌بندی متریک‌ها و ادغام Snapshot در گراف این‌جا نگه داشته
 * می‌شوند تا بوم و پنل بازرسی یک منبع حقیقت داشته باشند و آزمون‌پذیر باشند.
 * هیچ داده‌ای در این لایه ساخته نمی‌شود؛ فقط نمایش دادهٔ سرور است.
 */
import type {
  TopoLink,
  TopoLinkLive,
  TopoLinkStats,
  TopoLinkStatus,
  TopoNode,
  TopoSaturation,
  TopoStatusSnapshot,
} from './types';

// نسخهٔ محلی ارقام فارسی: این ماژول مستقل از فرمت‌کننده‌های صفحه است تا در
// آزمون‌های Node (بدون باندلر) هم بدون وابستگی اضافی بارگذاری شود.
const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
const faDigits = (value: string | number): string => String(value).replace(/\d/g, (d) => FA_DIGITS[Number(d)]);

export const LINK_STATUS_META: Record<
  TopoLinkStatus,
  { label: string; color: string; soft: string; text: string; border: string; dot: string }
> = {
  up: {
    label: 'ارتباط فعال',
    color: '#16a34a',
    soft: 'bg-emerald-50',
    text: 'text-emerald-700',
    border: 'border-emerald-200',
    dot: 'bg-emerald-500',
  },
  down: {
    label: 'ارتباط قطع',
    color: '#dc2626',
    soft: 'bg-red-50',
    text: 'text-red-700',
    border: 'border-red-200',
    dot: 'bg-red-500',
  },
  degraded: {
    label: 'دارای اختلال',
    color: '#f59e0b',
    soft: 'bg-amber-50',
    text: 'text-amber-700',
    border: 'border-amber-200',
    dot: 'bg-amber-500',
  },
  unknown: {
    label: 'وضعیت نامشخص',
    color: '#94a3b8',
    soft: 'bg-ink-100',
    text: 'text-ink-500',
    border: 'border-ink-200',
    dot: 'bg-ink-400',
  },
};

export const SATURATION_META: Record<TopoSaturation, { label: string; text: string; bar: string; soft: string }> = {
  ok: { label: 'عادی', text: 'text-emerald-700', bar: 'bg-emerald-500', soft: 'bg-emerald-50' },
  moderate: { label: 'متوسط', text: 'text-brand-700', bar: 'bg-brand-500', soft: 'bg-brand-50' },
  high: { label: 'پرترافیک', text: 'text-amber-700', bar: 'bg-amber-500', soft: 'bg-amber-50' },
  critical: { label: 'نزدیک اشباع', text: 'text-red-700', bar: 'bg-red-500', soft: 'bg-red-50' },
  unmeasured: { label: 'بدون سنجش', text: 'text-ink-400', bar: 'bg-ink-300', soft: 'bg-ink-50' },
};

export function linkStatus(link: TopoLink): TopoLinkStatus {
  return link.live?.status ?? 'unknown';
}

export function linkStatusMeta(link: TopoLink) {
  return LINK_STATUS_META[linkStatus(link)];
}

/** رنگ یال: در حالت زنده فقط رنگ وضعیت (سبز/قرمز/زرد/خاکستری) */
export function liveLinkColor(link: TopoLink, fallback: string): string {
  if (!link.live) return fallback;
  return LINK_STATUS_META[link.live.status]?.color ?? LINK_STATUS_META.unknown.color;
}

export function linkStrokeWidth(link: TopoLink, selected = false): number {
  if (selected) return 3.1;
  const util = link.live?.utilPct;
  if (util == null) return 1.7;
  return Math.min(3.6, 1.7 + Math.max(0, Math.min(100, util)) / 55);
}

/** پهنای باند اسمی به شکل خوانا (Mbps ورودی) */
export function fmtBandwidth(mbps: number | null | undefined): string {
  if (mbps == null || !Number.isFinite(Number(mbps)) || Number(mbps) <= 0) return 'نامشخص';
  const value = Number(mbps);
  if (value >= 1000000) return `${faDigits(trim(value / 1000000))} Tbps`;
  if (value >= 1000) return `${faDigits(trim(value / 1000))} Gbps`;
  return `${faDigits(trim(value))} Mbps`;
}

function trim(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function fmtMbps(mbps: number | null | undefined): string {
  if (mbps == null || !Number.isFinite(Number(mbps))) return '—';
  const value = Number(mbps);
  if (value >= 1000) return `${faDigits(trim(value / 1000))} Gbps`;
  if (value >= 1) return `${faDigits(trim(value))} Mbps`;
  return `${faDigits(Math.round(value * 1000))} kbps`;
}

export function fmtUtil(utilPct: number | null | undefined): string {
  if (utilPct == null || !Number.isFinite(Number(utilPct))) return '—';
  return `${faDigits(trim(Number(utilPct)))}٪`;
}

export function fmtLatency(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(Number(ms))) return '—';
  return `${faDigits(trim(Number(ms)))}ms`;
}

export function fmtLoss(lossPct: number | null | undefined): string {
  if (lossPct == null || !Number.isFinite(Number(lossPct))) return '—';
  return `${faDigits(trim(Number(lossPct)))}٪`;
}

/**
 * متن فشردهٔ روی یال. همیشه پهنای باند اسمی را (اگر ثبت شده باشد) نشان
 * می‌دهد؛ مصرف فقط اگر سنجش واقعی موجود باشد.
 */
export function linkMetricText(link: TopoLink): string {
  const live = link.live;
  if (!live) return '';
  const parts: string[] = [];
  const capacity = live.capacityMbps ?? link.capacityMbps ?? null;
  if (capacity) parts.push(fmtBandwidth(capacity));
  if (live.utilPct != null) parts.push(fmtUtil(live.utilPct));
  else if (live.capacityMbps) parts.push('بدون سنجش');
  if (live.latencyMs != null) parts.push(fmtLatency(live.latencyMs));
  return parts.join(' · ');
}

/** خط دوم متریک‌ها در بزرگ‌نمایی زیاد: افت و نوسان */
export function linkDetailText(link: TopoLink): string {
  const live = link.live;
  if (!live) return '';
  return `افت ${fmtLoss(live.lossPct)} · نوسان ${fmtLatency(live.jitterMs)}`;
}

/** توضیح کامل لینک برای Tooltip/دسترس‌پذیری */
export function linkTooltip(link: TopoLink): string {
  const live = link.live;
  if (!live) return link.label || 'لینک ارتباطی';
  const lines = [
    link.label || 'لینک ارتباطی',
    LINK_STATUS_META[live.status]?.label ?? 'نامشخص',
    live.reason,
    `پهنای باند اسمی: ${fmtBandwidth(live.capacityMbps)}`,
    `مصرف: ${live.rxMbps != null ? `${fmtMbps(live.rxMbps)} ↓` : '—'}${
      live.txMbps != null ? ` / ${fmtMbps(live.txMbps)} ↑` : ''
    } · اشغال: ${fmtUtil(live.utilPct)}`,
    `تأخیر: ${fmtLatency(live.latencyMs)} · افت: ${fmtLoss(live.lossPct)} · نوسان: ${fmtLatency(live.jitterMs)}`,
    live.telemetryError ? `خطای سنجش: ${live.telemetryError}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

export function summarizeLinks(links: TopoLink[]): TopoLinkStats {
  const stats: TopoLinkStats = { up: 0, down: 0, degraded: 0, unknown: 0, highLoad: 0, saturated: 0 };
  for (const link of links) {
    const status = link.live?.status ?? 'unknown';
    stats[status] += 1;
    if (link.live?.saturation === 'high') stats.highLoad += 1;
    if (link.live?.saturation === 'critical') stats.saturated += 1;
  }
  return stats;
}

/** لینک‌هایی که نیاز به توجه دارند، به ترتیب اهمیت */
export function attentionLinks(links: TopoLink[]): TopoLink[] {
  const rank: Record<TopoLinkStatus, number> = { down: 0, degraded: 1, unknown: 2, up: 3 };
  return links
    .filter((l) => l.live && l.live.status !== 'up')
    .sort((a, b) => {
      const diff = rank[a.live!.status] - rank[b.live!.status];
      if (diff) return diff;
      return (b.live!.utilPct ?? 0) - (a.live!.utilPct ?? 0);
    });
}

function sameLive(a: TopoLinkLive | null | undefined, b: TopoLinkLive | null | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.status === b.status &&
    a.reasonCode === b.reasonCode &&
    a.latencyMs === b.latencyMs &&
    a.lossPct === b.lossPct &&
    a.jitterMs === b.jitterMs &&
    a.utilPct === b.utilPct &&
    a.saturation === b.saturation &&
    a.telemetryAt === b.telemetryAt &&
    a.sourceCount === b.sourceCount
  );
}

/** ادغام Snapshot سرور در لینک‌ها؛ در نبود تغییر، همان آرایه برگردانده می‌شود */
export function applyLinkSnapshot(links: TopoLink[], snapshot: TopoStatusSnapshot): TopoLink[] {
  const byId = new Map(snapshot.links.map((item) => [item.id, item]));
  let changed = snapshot.links.length !== links.length;
  const next = links.map((link) => {
    const live = byId.get(link.id) ?? null;
    if (sameLive(link.live, live)) return link;
    changed = true;
    return { ...link, live };
  });
  return changed ? next : links;
}

/** ادغام وضعیت گره‌ها؛ بدون تغییر، همان آرایه */
export function applyNodeSnapshot(nodes: TopoNode[], snapshot: TopoStatusSnapshot): TopoNode[] {
  const byId = new Map(snapshot.nodes.map((item) => [item.id, item]));
  const sites = new Map(snapshot.sites.map((item) => [item.id, item]));
  let changed = false;
  const next = nodes.map((node) => {
    if (node.kind === 'site' && node.site && node.siteId) {
      const site = sites.get(node.siteId);
      if (site && (site.deviceCount !== node.site.deviceCount || site.onlineCount !== node.site.onlineCount)) {
        changed = true;
        return { ...node, site: { ...node.site, deviceCount: site.deviceCount, onlineCount: site.onlineCount } };
      }
      return node;
    }
    const live = byId.get(node.id);
    if (!live || !node.device) return node;
    if (
      node.device.status === live.status &&
      node.device.lastRtt === live.lastRtt &&
      node.device.lossPct === live.lossPct &&
      (node.device.jitterMs ?? null) === (live.jitterMs ?? null) &&
      node.device.lastCheckAt === live.lastCheckAt &&
      node.device.name === (live.name ?? node.device.name) &&
      node.device.statusReason === (live.statusReason ?? node.device.statusReason)
    ) {
      return node;
    }
    changed = true;
    return {
      ...node,
      device: {
        ...node.device,
        name: live.name ?? node.device.name,
        ip: live.ip ?? node.device.ip,
        status: live.status,
        statusReason: live.statusReason ?? node.device.statusReason,
        lastRtt: live.lastRtt,
        lossPct: live.lossPct,
        jitterMs: live.jitterMs ?? null,
        lastCheckAt: live.lastCheckAt,
      },
    };
  });
  return changed ? next : nodes;
}

/** درصد برای نوار اشغال (۰ تا ۱۰۰) */
export function utilBarPct(utilPct: number | null | undefined): number {
  if (utilPct == null || !Number.isFinite(Number(utilPct))) return 0;
  return Math.max(0, Math.min(100, Number(utilPct)));
}
