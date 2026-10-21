/**
 * کمک‌تابع‌های نمایش تحلیل مرحلهٔ ۳
 * ----------------------------------------------------------------
 * این ماژول هیچ محاسبهٔ وابستگی انجام نمی‌دهد؛ فقط خروجی سرور را به رنگ،
 * برچسب و مجموعه‌های ساده برای بوم تبدیل می‌کند تا منطق نمایش در یک جا باشد
 * و مستقل از React آزمون شود.
 */
import type {
  TopoAnalysis,
  TopoImpact,
  TopoNodeRole,
  TopoRedundancyGroup,
  TopoRiskSeverity,
  TopoRouteStatus,
} from './types';

export const TOPO_ROLE_LABEL: Record<TopoNodeRole, string> = {
  gateway: 'دروازه',
  router: 'روتر',
  switch: 'سوئیچ',
  firewall: 'فایروال',
  core: 'هسته',
  access: 'دسترسی',
  server: 'سرور',
  site: 'مرکز تجمع',
  cloud: 'شبکهٔ بیرونی',
  device: 'تجهیز',
  group: 'گروه',
};

export const SEVERITY_META: Record<
  TopoRiskSeverity,
  { label: string; text: string; soft: string; border: string; dot: string }
> = {
  critical: {
    label: 'بحرانی',
    text: 'text-red-700',
    soft: 'bg-red-50',
    border: 'border-red-200',
    dot: 'bg-red-500',
  },
  high: {
    label: 'زیاد',
    text: 'text-orange-700',
    soft: 'bg-orange-50',
    border: 'border-orange-200',
    dot: 'bg-orange-500',
  },
  medium: {
    label: 'متوسط',
    text: 'text-amber-700',
    soft: 'bg-amber-50',
    border: 'border-amber-200',
    dot: 'bg-amber-500',
  },
  low: {
    label: 'کم',
    text: 'text-ink-500',
    soft: 'bg-ink-50',
    border: 'border-ink-200',
    dot: 'bg-ink-400',
  },
};

export const ROUTE_STATUS_META: Record<
  TopoRouteStatus,
  { label: string; text: string; soft: string; border: string; dot: string }
> = {
  up: { label: 'سالم', text: 'text-emerald-700', soft: 'bg-emerald-50', border: 'border-emerald-200', dot: 'bg-emerald-500' },
  down: { label: 'قطع', text: 'text-red-700', soft: 'bg-red-50', border: 'border-red-200', dot: 'bg-red-500' },
  degraded: { label: 'دارای اختلال', text: 'text-amber-700', soft: 'bg-amber-50', border: 'border-amber-200', dot: 'bg-amber-500' },
  unknown: { label: 'نامشخص', text: 'text-ink-500', soft: 'bg-ink-50', border: 'border-ink-200', dot: 'bg-ink-400' },
};

export const GROUP_STATUS_META: Record<
  TopoRedundancyGroup['status'],
  { label: string; text: string; soft: string; border: string }
> = {
  normal: { label: 'مسیر اصلی سالم', text: 'text-emerald-700', soft: 'bg-emerald-50', border: 'border-emerald-200' },
  failover: { label: 'پشتیبان فعال شد', text: 'text-violet-700', soft: 'bg-violet-50', border: 'border-violet-200' },
  critical: { label: 'هر دو مسیر قطع', text: 'text-red-700', soft: 'bg-red-50', border: 'border-red-200' },
  degraded: { label: 'مسیر دارای اختلال', text: 'text-amber-700', soft: 'bg-amber-50', border: 'border-amber-200' },
  unknown: { label: 'وضعیت نامشخص', text: 'text-ink-500', soft: 'bg-ink-50', border: 'border-ink-200' },
};

export interface TopologyOverlay {
  criticalNodeIds: Set<string>;
  affectedNodeIds: Set<string>;
  affectedLinkIds: Set<string>;
  problemPathLinkIds: Set<string>;
  primaryPathLinkIds: Set<string>;
  backupPathLinkIds: Set<string>;
}

/**
 * مجموعه‌های نمایش روی بوم.
 *   • گره‌های بحرانی فقط وقتی پنل تحلیل باز است (برای جلوگیری از شلوغی).
 *   • مسیر مشکل‌دار و اثر شبیه‌سازی همیشه دیده می‌شوند.
 *   • مسیر اصلی/پشتیبان فقط برای گروه انتخاب‌شده نمایش داده می‌شود.
 */
export function buildTopologyOverlay(
  analysis: TopoAnalysis | null,
  impact: TopoImpact | null,
  { showCritical = true, activeGroupName = '' }: { showCritical?: boolean; activeGroupName?: string } = {}
): TopologyOverlay {
  const criticalNodeIds = new Set<string>();
  const affectedNodeIds = new Set<string>();
  const affectedLinkIds = new Set<string>();
  const problemPathLinkIds = new Set<string>();
  const primaryPathLinkIds = new Set<string>();
  const backupPathLinkIds = new Set<string>();

  if (analysis) {
    if (showCritical) for (const node of analysis.criticalNodes) criticalNodeIds.add(node.id);
    for (const id of analysis.live.affectedNodeIds) affectedNodeIds.add(id);
    for (const id of analysis.live.problemLinkIds) affectedLinkIds.add(id);
    for (const id of analysis.live.degradedLinkIds) affectedLinkIds.add(id);
    for (const id of analysis.live.problemPathLinkIds) problemPathLinkIds.add(id);
    if (activeGroupName) {
      const group = analysis.redundancy.groups.find((item) => item.name === activeGroupName);
      if (group) {
        for (const id of group.primary?.linkIds ?? []) primaryPathLinkIds.add(id);
        for (const id of group.backup?.linkIds ?? []) backupPathLinkIds.add(id);
      }
    }
  }

  if (impact) {
    for (const id of impact.affected.nodeIds) affectedNodeIds.add(id);
    for (const id of impact.pathLinkIds) affectedLinkIds.add(id);
    for (const id of impact.pathLinkIds) problemPathLinkIds.add(id);
    if (impact.target.type === 'link') affectedLinkIds.add(impact.target.id);
  }

  return {
    criticalNodeIds,
    affectedNodeIds,
    affectedLinkIds,
    problemPathLinkIds,
    primaryPathLinkIds,
    backupPathLinkIds,
  };
}

/** مسیر انتخاب‌شده روی بوم، به ترتیب کلیک، برای ساخت مسیر اصلی/پشتیبان. */
export function selectedNodePath(nodes: { id: string; label?: string; device?: { name: string } | null; site?: { name: string } | null; kind: string }[], ids: string[]): { id: string; label: string }[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return ids
    .map((id) => byId.get(id))
    .filter((node): node is NonNullable<typeof node> => !!node)
    .map((node) => ({
      id: node.id,
      label:
        node.label ||
        node.device?.name ||
        node.site?.name ||
        (node.kind === 'cloud' ? 'شبکهٔ بیرونی' : node.kind === 'site' ? 'مرکز تجمع' : 'گره'),
    }));
}

/**
 * افزودن/جایگزینی یک مسیر در فهرست مسیرها؛ همان نقش در همان گروه جایگزین
 * می‌شود تا PUT سمت سرور با قید «یک اصلی و یک پشتیبان» سازگار باشد.
 */
export function upsertPath(
  paths: Array<{ id: string; name: string; role: 'primary' | 'backup'; nodeIds: string[]; linkIds: string[] }>,
  next: { name: string; role: 'primary' | 'backup'; nodeIds: string[] }
) {
  const name = next.name.trim();
  return [
    ...paths
      .filter((path) => !(path.name.toLocaleLowerCase('fa') === name.toLocaleLowerCase('fa') && path.role === next.role))
      .map((path) => ({ id: path.id, name: path.name, role: path.role, nodeIds: path.nodeIds, linkIds: path.linkIds })),
    { id: '', name, role: next.role, nodeIds: next.nodeIds, linkIds: [] },
  ];
}

/** حذف کل گروه اصلی/پشتیبان با یک نام */
export function removePathGroup(
  paths: Array<{ id: string; name: string; role: 'primary' | 'backup'; nodeIds: string[]; linkIds: string[] }>,
  name: string
) {
  return paths
    .filter((path) => path.name.toLocaleLowerCase('fa') !== name.toLocaleLowerCase('fa'))
    .map((path) => ({ id: path.id, name: path.name, role: path.role, nodeIds: path.nodeIds, linkIds: path.linkIds }));
}

export function pathEndpoints(path: { fromLabel: string; toLabel: string }): string {
  return `${path.fromLabel} ↔ ${path.toLabel}`;
}

export function impactSeverityText(count: number): string {
  if (count <= 0) return 'هیچ تجهیزی از دسترس خارج نمی‌شود';
  if (count === 1) return '۱ تجهیز از دسترس خارج می‌شود';
  return `${count} تجهیز از دسترس خارج می‌شود`;
}
