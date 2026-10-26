/**
 * توپولوژی سلسله‌مراتبی شبکه — مدل داده و توابع خالص
 * ----------------------------------------------------------------
 * این ماژول «مرحله ۱» ماژول توپولوژی است: سه سطح ناوبری (سراسری › شهر ›
 * جزئیات) بدون هیچ وابستگی به ذخیره‌سازی. همهٔ توابع اینجا خالص‌اند تا بدون
 * رندرکردن قابل آزمون باشند.
 *
 * سلسله‌مراتب با `parentId` بیان می‌شود (بدون بازگشت)؛ فهرست فرزندان در زمان
 * اجرا از روی همان ستون ساخته می‌شود تا هیچ داده‌ای دوبار ذخیره نشود:
 *
 *   شهر (ریشه) ── مرکز تجمع / ایستگاه ── تجهیز (روتر، سوئیچ، فایروال، …)
 *
 * لینک‌ها در کل درخت جست‌وجو می‌شوند و در هر سطح فقط همان‌هایی رسم می‌شوند که
 * دو سرعشان (یا یک سرشان و سرِ لنگرِ همان سطح) دیده می‌شود.
 */
import type { DeviceStatus, HierarchyConnection, HierarchyNode, HierarchyPayload } from './types';

/* ------------------------------------------------------------------ */
/* مدل‌ها                                                               */
/* ------------------------------------------------------------------ */

/** سطح ناوبری جاری */
export type TopologyLevel = 'global' | 'city' | 'detail';

/** نوع گره — گره‌های سلسله‌مراتبی و تجهیزات شبکه */
export type TopologyNodeKind =
  | 'city'
  | 'aggregation'
  | 'station'
  | 'router'
  | 'switch'
  | 'firewall'
  | 'access-point'
  | 'server'
  | 'other';

/** رسانهٔ انتقال — هر کدام الگوی خطِ متمایز خودش را دارد */
export type TransmissionMedium = 'fiber' | 'wireless' | 'ethernet' | 'vpn';

/** وضعیت لینک (بهره‌برداری) */
export type LinkState = 'up' | 'down' | 'degraded' | 'unknown';

/** مقدار فرعیِ سلسله‌مراتبی/تجهیز که برای نمایش در بازرس نگه داشته می‌شود */
export type TopologyMetaValue = string | number | boolean | null;

/** گره توپولوژی — یک شهر، مرکز تجمع، ایستگاه یا تجهیز شبکه */
export interface TopologyNodeModel {
  /** شناسهٔ یکتا و پایدار در کل دیتاست */
  id: string;
  kind: TopologyNodeKind;
  /** نام فارسی گره برای نمایش روی گره و در درخت */
  name: string;
  /** شناسهٔ والد؛ `null` یعنی ریشه (شهر در سطح سراسری) */
  parentId: string | null;
  /** شهرِ متعلق به گره — برای فیلتر و نان‌횡ریس */
  cityId?: string | null;
  /** آدرس IP — با قالب لاتین و خوانا نمایش داده می‌شود */
  ip?: string | null;
  /** نوع تجهیز برای نمایش (Router/Switch/Firewall/…) */
  deviceType?: string | null;
  /** سازنده و مدل — اختیاری */
  vendor?: string | null;
  model?: string | null;
  /** موقعیت فیزیکی یا توضیح کوتاه */
  location?: string | null;
  /** وضعیت زنده؛ `null` یعنی داده‌ای نداریم */
  status?: DeviceStatus | null;
  /** توضیح کوتاه و یادداشت آزاد */
  description?: string;
  notes?: string;
  /** مالکیت سازمانی — مستقل از ویژگی‌های فیزیکی/منطقی لینک‌ها */
  ownerGroupId?: number | null;
  ownerGroupName?: string | null;
  ownerGroupColor?: string | null;
  /** تعداد پورت‌های تجهیز */
  ports?: number | null;
  /** منبع داده؛ `demo` هرگز به‌عنوان دادهٔ واقعی نمایش داده نمی‌شود */
  origin?: 'user' | 'demo';
  /** موقعیت ذخیره‌شده روی سرور (اختیاری؛ دادهٔ نمونه ندارد) */
  x?: number;
  y?: number;
  /** اطلاعات تکمیلیِ نمایشی (پورت، پهنای باند روتینگ، …) */
  meta?: Record<string, TopologyMetaValue>;
}

/** لینک بین دو گره به‌همراه رسانهٔ انتقال */
export interface TopologyEdgeModel {
  id: string;
  /** شناسهٔ گره مبدأ */
  source: string;
  /** شناسهٔ گره مقصد */
  target: string;
  /** رسانهٔ انتقال — رنگ و الگوی خط را تعیین می‌کند */
  medium: TransmissionMedium;
  /** برچسب کوتاه (نام مدار، پورت، …) */
  label?: string | null;
  /** ظرفیت مگابیت بر ثانیه */
  capacityMbps?: number | null;
  /** تأخیر یک‌طرفه به میلی‌ثانیه */
  latencyMs?: number | null;
  /** وضعیت بهره‌برداری لینک */
  state?: LinkState;
  /** توضیح */
  description?: string | null;
  notes?: string;
  /** پورت دو سر لینک */
  sourcePort?: string;
  targetPort?: string;
  /** نقش مدار: اصلی یا پشتیبان */
  role?: 'primary' | 'backup';
  origin?: 'user' | 'demo';
  /** اطلاعات تکمیلی نمایشی */
  meta?: Record<string, TopologyMetaValue>;
}

/** کل دیتاست توپولوژی (نمونهٔ توسعه یا دادهٔ زنده در آینده) */
export interface TopologyDataset {
  nodes: TopologyNodeModel[];
  edges: TopologyEdgeModel[];
  /** از کجا آمده است؛ تا دادهٔ نمونه هرگز با دادهٔ واقعی قاطی نشود */
  source: 'sample' | 'live';
  /** دیتاست شامل ردیف‌های `origin='demo'` است (فقط توسعه) */
  demo?: boolean;
}

/* ------------------------------------------------------------------ */
/* نگاشت دادهٔ API به مدل نمایش                                          */
/* ------------------------------------------------------------------ */

/** ردیف API → گره مدل (بدون تغییر یا حذف هیچ فیلدی) */
export function nodeFromApi(row: HierarchyNode): TopologyNodeModel {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    parentId: row.parentId,
    cityId: row.cityId,
    ip: row.ip,
    deviceType: row.deviceType,
    vendor: row.vendor,
    model: row.model,
    location: row.location,
    status: row.status,
    description: row.description,
    notes: row.notes,
    ownerGroupId: row.ownerGroupId,
    ownerGroupName: row.ownerGroupName,
    ownerGroupColor: row.ownerGroupColor,
    ports: row.ports,
    origin: row.origin,
    x: row.x,
    y: row.y,
    meta: (row.meta ?? {}) as Record<string, TopologyMetaValue>,
  };
}

/** ردیف API → لینک مدل */
export function edgeFromApi(row: HierarchyConnection): TopologyEdgeModel {
  return {
    id: row.id,
    source: row.source,
    target: row.target,
    medium: row.medium,
    label: row.label,
    capacityMbps: row.capacityMbps,
    latencyMs: row.latencyMs,
    state: row.state,
    description: row.description,
    notes: row.notes,
    sourcePort: row.sourcePort,
    targetPort: row.targetPort,
    role: row.role,
    origin: row.origin,
    meta: (row.meta ?? {}) as Record<string, TopologyMetaValue>,
  };
}

/** بار دادهٔ پایدار → دیتاست نمایش؛ اگر هیچ ردیفی نمونه نباشد `demo` خاموش است */
export function datasetFromPayload(payload: Pick<HierarchyPayload, 'nodes' | 'connections'>): TopologyDataset {
  return {
    nodes: payload.nodes.map(nodeFromApi),
    edges: payload.connections.map(edgeFromApi),
    source: 'live',
    demo:
      payload.nodes.some((n) => n.origin === 'demo') || payload.connections.some((c) => c.origin === 'demo'),
  };
}

/**
 * دامنهٔ (scope) نمای جاری:
 *   global → کل کشور (شهرها و ارتباط‌های اصلی)
 *   city   → درون یک شهر (مراکز تجمع و ایستگاه‌ها)
 *   detail → درون یک مرکز تجمع یا ایستگاه (تجهیزات و شبکهٔ داخلی)
 */
export type TopologyScope =
  | { level: 'global' }
  | { level: 'city'; cityId: string }
  | { level: 'detail'; parentId: string };

/* ------------------------------------------------------------------ */
/* متادیتا (برچسب‌ها، رنگ‌ها، رسانه‌ها)                                  */
/* ------------------------------------------------------------------ */

export interface KindMeta {
  label: string;
  color: string;
  /** توضیح کوتاه برای راهنمای رنگ‌ها */
  hint: string;
}

export const KIND_META: Record<TopologyNodeKind, KindMeta> = {
  city: { label: 'شهر', color: '#2563eb', hint: 'شهر و ارتباط‌های بین‌شهری' },
  aggregation: { label: 'مرکز تجمع', color: '#7c3aed', hint: 'مرکز تجمع (Aggregation)' },
  station: { label: 'ایستگاه', color: '#0891b2', hint: 'ایستگاه یا ساختمان' },
  router: { label: 'روتر', color: '#2563eb', hint: 'روتر لایهٔ ۳' },
  switch: { label: 'سوئیچ', color: '#0d9488', hint: 'سوئیچ لایهٔ ۲' },
  firewall: { label: 'فایروال', color: '#dc2626', hint: 'فایروال / دروازهٔ امنیتی' },
  'access-point': { label: 'دسترسی بی‌سیم', color: '#9333ea', hint: 'نقطهٔ دسترسی بی‌سیم' },
  server: { label: 'سرور', color: '#475569', hint: 'سرور / سرویس‌دهنده' },
  other: { label: 'تجهیز دیگر', color: '#64748b', hint: 'سایر تجهیزات شبکه' },
};

export interface MediumMeta {
  label: string;
  /** رنگ خط */
  color: string;
  /**
   * الگوی خط؛ رشتهٔ خالی یعنی خط پیوسته (solid).
   * مقدارها در SVG با `stroke-dasharray` خوانده می‌شوند.
   */
  dash: string;
  /** توضیح برای راهنمای نقشه */
  hint: string;
}

/** رسانه‌های انتقال و نمای خطی آن‌ها (سبز آبی پیوسته، بنفش خط‌چین، …) */
export const MEDIA_META: Record<TransmissionMedium, MediumMeta> = {
  fiber: {
    label: 'فیبر نوری',
    color: '#0d9488',
    dash: '',
    hint: 'پیوسته — فیبر نوری',
  },
  wireless: {
    label: 'بی‌سیم / رادیویی',
    color: '#9333ea',
    dash: '10 7',
    hint: 'خط‌چین — پیوند بی‌سیم یا رادیویی',
  },
  ethernet: {
    label: 'اترنت / مسی',
    color: '#2563eb',
    dash: '2 6',
    hint: 'چین‌چین — کابل اترنت (مسی)',
  },
  vpn: {
    label: 'VPN / تونل منطقی',
    color: '#d97706',
    dash: '12 6 2 6',
    hint: 'نقطه‌چین‌و‌خط — تونل منطقی VPN',
  },
};

export const MEDIUM_ORDER: TransmissionMedium[] = ['fiber', 'wireless', 'ethernet', 'vpn'];

export const LINK_STATE_META: Record<LinkState, { label: string; color: string }> = {
  up: { label: 'فعال', color: '#059669' },
  down: { label: 'قطع', color: '#dc2626' },
  degraded: { label: 'کاهش‌یافته', color: '#d97706' },
  unknown: { label: 'نامشخص', color: '#64748b' },
};

export const LEVEL_META: Record<TopologyLevel, { label: string; hint: string }> = {
  global: { label: 'نمای سراسری', hint: 'شهرها و ارتباط‌های اصلی بین‌شهری' },
  city: { label: 'نمای شهر', hint: 'مراکز تجمع و ایستگاه‌های شهر' },
  detail: { label: 'نمای جزئیات', hint: 'تجهیزات و شبکهٔ داخلی مرکز/ایستگاه' },
};

/** آیا این نوع گره قابل «ورود» است (نمای جزئیات می‌سازد)؟ */
export function isDrillable(node: TopologyNodeModel): boolean {
  return node.kind === 'city' || node.kind === 'aggregation' || node.kind === 'station';
}

/** دامنهٔ بعدی هنگام دوبار کلیک/ورود به یک گره */
export function drillScope(node: TopologyNodeModel): TopologyScope | null {
  if (node.kind === 'city') return { level: 'city', cityId: node.id };
  if (node.kind === 'aggregation' || node.kind === 'station') return { level: 'detail', parentId: node.id };
  return null;
}

/* ------------------------------------------------------------------ */
/* ایندکس‌ها و پیمایش                                                   */
/* ------------------------------------------------------------------ */

export type NodeIndex = Map<string, TopologyNodeModel>;

/** ایندکس شناسه → گره */
export function indexNodes(nodes: TopologyNodeModel[]): NodeIndex {
  return new Map(nodes.map((n) => [n.id, n]));
}

/** فرزندان مستقیمِ یک گره (ترتیب ورودی حفظ می‌شود) */
export function childrenOf(nodes: TopologyNodeModel[], parentId: string | null): TopologyNodeModel[] {
  return nodes.filter((n) => n.parentId === parentId);
}

/** گره‌های ریشه (در سطح سراسری) */
export function rootNodes(nodes: TopologyNodeModel[]): TopologyNodeModel[] {
  return childrenOf(nodes, null);
}

/** زنجیرهٔ والدها از نزدیک‌ترین والد تا ریشه */
export function ancestorsOf(index: NodeIndex, id: string): TopologyNodeModel[] {
  const out: TopologyNodeModel[] = [];
  let node = index.get(id);
  let guard = 0;
  while (node?.parentId && guard++ < 64) {
    const parent = index.get(node.parentId);
    if (!parent) break;
    out.push(parent);
    node = parent;
  }
  return out;
}

/**
 * نان‌العریس مسیر ناوبری جاری؛ برای نمایش در بالای صفحه.
 * برای `global` فقط یک سطر دارد.
 */
export function breadcrumbFor(index: NodeIndex, scope: TopologyScope): { id: string; label: string; scope: TopologyScope }[] {
  if (scope.level === 'global') return [{ id: 'global', label: 'کل شبکه', scope }];
  const target = index.get(scope.level === 'city' ? scope.cityId : scope.parentId);
  if (!target) return [{ id: 'global', label: 'کل شبکه', scope: { level: 'global' } }];
  const trail = [target, ...ancestorsOf(index, target.id)].reverse();
  const crumbs = trail.map((n) => ({
    id: n.id,
    label: n.name,
    scope: drillScope(n) ?? { level: 'global' },
  }));
  return [{ id: 'global', label: 'کل شبکه', scope: { level: 'global' as const } }, ...crumbs];
}

/* ------------------------------------------------------------------ */
/* سطح نمایش                                                            */
/* ------------------------------------------------------------------ */

/** گره‌های قابل‌نمایش در یک دامنه */
export function nodesForScope(nodes: TopologyNodeModel[], scope: TopologyScope): TopologyNodeModel[] {
  if (scope.level === 'global') return rootNodes(nodes);
  const parentId = scope.level === 'city' ? scope.cityId : scope.parentId;
  return childrenOf(nodes, parentId);
}

/**
 * لنگر (anchor) یک سطح: والدی که خارج از مجموعهٔ دیده‌شده است اما لینک‌های
 * بالارونده به آن باید رسم شوند تا گره‌ها در شبکهٔ خودشان بی‌معنا بمانند.
 */
export function scopeAnchor(scope: TopologyScope): string | null {
  if (scope.level === 'city') return scope.cityId;
  if (scope.level === 'detail') return scope.parentId;
  return null;
}

/**
 * لینک‌های قابل‌نمایش در یک دامنه:
 *   • هر لینکی که دو سرّش در مجموعهٔ دیده‌شده باشد.
 *   • لینک بالارونده به لنگرِ سطح (مرکز تجمع ↔ شهر، تجهیز ↔ ایستگاه) تا
 *     گره‌های درونی از شبکهٔ بیرونی خودشان جدا دیده نشوند.
 */
export function edgesForScope(
  nodes: TopologyNodeModel[],
  edges: TopologyEdgeModel[],
  scope: TopologyScope
): TopologyEdgeModel[] {
  const visible = new Set(nodesForScope(nodes, scope).map((n) => n.id));
  if (!visible.size) return [];
  const anchor = scopeAnchor(scope);
  return edges.filter((e) => {
    const s = visible.has(e.source);
    const t = visible.has(e.target);
    if (s && t) return true;
    if (!anchor) return false;
    return (s && e.target === anchor) || (t && e.source === anchor);
  });
}

/* ------------------------------------------------------------------ */
/* جست‌وجو و درخت                                                       */
/* ------------------------------------------------------------------ */

/** نرمال‌سازی عبارت جست‌وجو (حروف کوچک، بی‌فضای اضافه) */
export function normalizeQuery(query: string): string {
  return String(query || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** آیا گره با عبارت جست‌وجو هم‌خوان است؟ (نام، IP، نوع، محل) */
export function nodeMatches(node: TopologyNodeModel, query: string): boolean {
  const q = normalizeQuery(query);
  if (!q) return true;
  const hay = [node.name, node.ip ?? '', node.deviceType ?? '', node.location ?? '', KIND_META[node.kind].label, node.model ?? '', node.vendor ?? '']
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

/**
 * گره‌هایی که باید در درخت دیده شوند: خودِ نتیجه + همهٔ والدهایش تا ریشه،
 * تا نتیجهٔ جست‌وجو هیچ‌وقت در شاخه‌ای بسته گم نشود.
 */
export function visibleTreeIds(nodes: TopologyNodeModel[], query: string): Set<string> {
  if (!normalizeQuery(query)) return new Set(nodes.map((n) => n.id));
  const index = indexNodes(nodes);
  const out = new Set<string>();
  for (const node of nodes) {
    if (!nodeMatches(node, query)) continue;
    out.add(node.id);
    for (const a of ancestorsOf(index, node.id)) out.add(a.id);
  }
  return out;
}

/** درخت سلسله‌مراتبی برای رندر درخت — فقط گره‌های قابل‌نمایش */
export interface TreeNode {
  node: TopologyNodeModel;
  children: TreeNode[];
  depth: number;
}

export function buildTree(nodes: TopologyNodeModel[], visibleIds?: Set<string>): TreeNode[] {
  const pool = visibleIds ? nodes.filter((n) => visibleIds.has(n.id)) : nodes;
  const byParent = new Map<string | null, TopologyNodeModel[]>();
  for (const n of pool) {
    const key = n.parentId && pool.some((p) => p.id === n.parentId) ? n.parentId : null;
    const list = byParent.get(key);
    if (list) list.push(n);
    else byParent.set(key, [n]);
  }
  const build = (parentId: string | null, depth: number): TreeNode[] =>
    (byParent.get(parentId) ?? []).map((node) => ({ node, children: build(node.id, depth + 1), depth }));
  return build(null, 0);
}

/** شمارش گره‌های زیرمجموعهٔ یک گره (برای نشان دادن در درخت) */
export function countDescendants(nodes: TopologyNodeModel[], id: string): number {
  let total = 0;
  const stack = [id];
  let guard = 0;
  while (stack.length && guard++ < 10000) {
    const current = stack.pop()!;
    for (const child of nodes) {
      if (child.parentId === current) {
        total += 1;
        stack.push(child.id);
      }
    }
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* آمار سطح                                                            */
/* ------------------------------------------------------------------ */

export interface ScopeStats {
  nodes: number;
  edges: number;
  online: number;
  offline: number;
  warning: number;
  unknown: number;
  byMedium: Record<TransmissionMedium, number>;
}

export function scopeStats(nodes: TopologyNodeModel[], edges: TopologyEdgeModel[]): ScopeStats {
  const stats: ScopeStats = {
    nodes: nodes.length,
    edges: edges.length,
    online: 0,
    offline: 0,
    warning: 0,
    unknown: 0,
    byMedium: { fiber: 0, wireless: 0, ethernet: 0, vpn: 0 },
  };
  for (const n of nodes) {
    if (n.status === 'online') stats.online += 1;
    else if (n.status === 'offline') stats.offline += 1;
    else if (n.status === 'warning') stats.warning += 1;
    else stats.unknown += 1;
  }
  for (const e of edges) {
    if (e.medium in stats.byMedium) stats.byMedium[e.medium] += 1;
  }
  return stats;
}

/* ------------------------------------------------------------------ */
/* چیدمان                                                              */
/* ------------------------------------------------------------------ */

export interface Point {
  x: number;
  y: number;
}

/** ترتیب کنار هم چیدن انواع گره در یک لایه (هسته ← لبه) */
const KIND_WEIGHT: Record<TopologyNodeKind, number> = {
  city: 0,
  aggregation: 1,
  station: 2,
  router: 3,
  firewall: 4,
  switch: 5,
  server: 6,
  'access-point': 7,
  other: 8,
};

export interface LayoutOptions {
  gapX?: number;
  gapY?: number;
  paddingX?: number;
  paddingY?: number;
  /** عرض/ارتفاع کادر مقصد (فقط برای چیدمان جغرافیایی) */
  width?: number;
  height?: number;
}

/** مختصات را طوری جابه‌جا می‌کند که گوشهٔ بالا-چپ با فاصلهٔ مشخص شروع شود */
function normalizePositions(positions: Record<string, Point>, paddingX: number, paddingY: number): Record<string, Point> {
  const points = Object.values(positions);
  if (!points.length) return positions;
  const minX = Math.min(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const out: Record<string, Point> = {};
  for (const [id, p] of Object.entries(positions)) {
    out[id] = { x: p.x - minX + paddingX, y: p.y - minY + paddingY };
  }
  return out;
}

/**
 * چیدمان لایه‌ای بر پایهٔ گراف (نه فقط parentId): ریشه‌ها در لایهٔ صفر و هر
 * لینک یک لایه پایین‌تر. برای نمای جزئیات که تجهیزات یک مرکز همه فرزند
 * مستقیم آن‌اند، این روش شبکهٔ داخلی را خوانا می‌چیند.
 */
export function layoutLayered(
  nodes: TopologyNodeModel[],
  edges: TopologyEdgeModel[],
  options: LayoutOptions = {}
): Record<string, Point> {
  const gapX = options.gapX ?? 232;
  const gapY = options.gapY ?? 168;
  const paddingX = options.paddingX ?? 80;
  const paddingY = options.paddingY ?? 50;
  if (!nodes.length) return {};

  const visible = new Set(nodes.map((n) => n.id));
  const adjacency = new Map<string, string[]>();
  for (const n of nodes) adjacency.set(n.id, []);
  for (const e of edges) {
    if (!visible.has(e.source) || !visible.has(e.target)) continue;
    adjacency.get(e.source)!.push(e.target);
    adjacency.get(e.target)!.push(e.source);
  }

  // ریشه = گره‌ای که والدش در همین مجموعه نیست (لنگر سطح یا شهرها)
  const roots = nodes.filter((n) => !n.parentId || !visible.has(n.parentId));
  const rank = new Map<string, number>();
  const queue: string[] = [];
  for (const root of roots) {
    rank.set(root.id, 0);
    queue.push(root.id);
  }
  for (let i = 0; i < queue.length; i += 1) {
    const current = rank.get(queue[i])!;
    for (const next of adjacency.get(queue[i]) ?? []) {
      if (rank.has(next)) continue;
      rank.set(next, current + 1);
      queue.push(next);
    }
  }

  // گره‌های بی‌ارتباط با ریشه‌ها در لایهٔ آخر
  const maxRank = Math.max(0, ...rank.values());
  for (const n of nodes) if (!rank.has(n.id)) rank.set(n.id, maxRank + 1);

  const rows = new Map<number, TopologyNodeModel[]>();
  for (const n of nodes) {
    const r = rank.get(n.id)!;
    const list = rows.get(r);
    if (list) list.push(n);
    else rows.set(r, [n]);
  }

  const positions: Record<string, Point> = {};
  for (const [r, row] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...row].sort(
      (a, b) => KIND_WEIGHT[a.kind] - KIND_WEIGHT[b.kind] || a.name.localeCompare(b.name, 'fa')
    );
    sorted.forEach((n, index) => {
      positions[n.id] = { x: (index - (sorted.length - 1) / 2) * gapX, y: r * gapY };
    });
  }
  return normalizePositions(positions, paddingX, paddingY);
}

/** چیدمان دایره‌ای؛ برای مجموعه‌های بدون سلسله‌مراتب یا بدون مختصات */
export function layoutCircle(nodes: TopologyNodeModel[], options: LayoutOptions = {}): Record<string, Point> {
  const paddingX = options.paddingX ?? 80;
  const paddingY = options.paddingY ?? 60;
  const radius = Math.max(230, nodes.length * 92);
  const positions: Record<string, Point> = {};
  nodes.forEach((node, index) => {
    const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2 - Math.PI / 2;
    positions[node.id] = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  });
  return normalizePositions(positions, paddingX + radius, paddingY + radius);
}

/**
 * چیدمان جغرافیایی شهرها بر پایهٔ مختصات `meta.lat`/`meta.lng` تا نمای
 * سراسری شبیه نقشهٔ کشور شود، نه یک ردیف تخت. اگر همهٔ گره‌ها مختصات
 * معتبر نداشته باشند `null` برمی‌گردد.
 */
export function layoutGeo(nodes: TopologyNodeModel[], options: LayoutOptions = {}): Record<string, Point> | null {
  if (!nodes.length) return null;
  const coords = nodes.map((node) => ({
    id: node.id,
    lat: Number(node.meta?.lat),
    lng: Number(node.meta?.lng),
  }));
  if (coords.some((c) => !Number.isFinite(c.lat) || !Number.isFinite(c.lng))) return null;

  const paddingX = options.paddingX ?? 70;
  const paddingY = options.paddingY ?? 50;
  const width = options.width ?? 980;
  const height = options.height ?? 560;
  const meanLat = coords.reduce((sum, c) => sum + c.lat, 0) / coords.length;
  // تصحیح طول جغرافیایی با عرض؛ وگرنه ایران کشیده و بی‌تناسب دیده می‌شود
  const k = Math.max(0.2, Math.cos((meanLat * Math.PI) / 180));
  const xs = coords.map((c) => c.lng * k);
  const ys = coords.map((c) => -c.lat);
  const spanX = Math.max(...xs) - Math.min(...xs) || 1;
  const spanY = Math.max(...ys) - Math.min(...ys) || 1;
  const scale = Math.min((width - paddingX * 2) / spanX, (height - paddingY * 2) / spanY);
  const offsetX = paddingX + (width - paddingX * 2 - spanX * scale) / 2;
  const offsetY = paddingY + (height - paddingY * 2 - spanY * scale) / 2;
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const positions: Record<string, Point> = {};
  coords.forEach((c, index) => {
    positions[c.id] = { x: (xs[index] - minX) * scale + offsetX, y: (ys[index] - minY) * scale + offsetY };
  });
  return positions;
}

/**
 * چیدمان متناسب با سطح: سراسری = جغرافیایی (یا دایره‌ای) و بقیه = لایه‌ای.
 * چیدمان دستی (کشیدن گره در حالت ویرایش) همیشه بر این نتیجه مقدم است.
 */
export function layoutScope(
  nodes: TopologyNodeModel[],
  edges: TopologyEdgeModel[],
  level: TopologyLevel,
  options: LayoutOptions = {}
): Record<string, Point> {
  if (level === 'global') return layoutGeo(nodes, options) ?? layoutCircle(nodes, options);
  return layoutLayered(nodes, edges, options);
}

/* ------------------------------------------------------------------ */
/* پیش‌نویس فرم‌ها و اعتبارسنجی سمت کلاینت                              */
/* ------------------------------------------------------------------ */

/**
 * پیش‌نویس ویرایش گره. مقادیر عددی به‌صورت رشته نگه داشته می‌شوند تا کاربر
 * بتواند ورودی ناتمام تایپ کند؛ تبدیل و اعتبارسنجی در زمان ارسال انجام می‌شود.
 */
export interface NodeDraft {
  name: string;
  description: string;
  notes: string;
  location: string;
  ip: string;
  deviceType: string;
  vendor: string;
  model: string;
  ports: string;
  status: DeviceStatus;
  ownerGroupId: string;
}

export type DraftErrors<T> = Partial<Record<keyof T, string>>;

export function nodeDraftFrom(node: TopologyNodeModel): NodeDraft {
  return {
    name: node.name,
    description: node.description ?? '',
    notes: node.notes ?? '',
    location: node.location ?? '',
    ip: node.ip ?? '',
    deviceType: node.deviceType ?? '',
    vendor: node.vendor ?? '',
    model: node.model ?? '',
    ports: node.ports == null ? '' : String(node.ports),
    status: (node.status ?? 'unknown') as DeviceStatus,
    ownerGroupId: node.ownerGroupId == null ? '' : String(node.ownerGroupId),
  };
}

/** آی‌پی معتبر یا نام میزبان — سرور باز هم مرجع نهایی است */
export function isLikelyHost(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  const octets = /^\d+(\.\d+){3}$/.test(v) ? v.split('.').map(Number) : null;
  if (octets) return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  if (v.includes(':')) return /^[0-9a-fA-F:]+$/.test(v);
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(v);
}

export function validateNodeDraft(draft: NodeDraft): DraftErrors<NodeDraft> {
  const errors: DraftErrors<NodeDraft> = {};
  const name = draft.name.trim();
  if (!name) errors.name = 'نام الزامی است.';
  else if (name.length > 120) errors.name = 'نام حداکثر ۱۲۰ نویسه است.';
  if (draft.description.length > 2000) errors.description = 'توضیح حداکثر ۲۰۰۰ نویسه است.';
  if (draft.notes.length > 4000) errors.notes = 'یادداشت حداکثر ۴۰۰۰ نویسه است.';
  if (draft.location.length > 160) errors.location = 'موقعیت حداکثر ۱۶۰ نویسه است.';
  if (draft.ip.trim() && !isLikelyHost(draft.ip)) errors.ip = 'آدرس IP یا نام میزبان معتبر نیست.';
  if (draft.deviceType.length > 60) errors.deviceType = 'نوع تجهیز حداکثر ۶۰ نویسه است.';
  if (draft.vendor.length > 120) errors.vendor = 'سازنده حداکثر ۱۲۰ نویسه است.';
  if (draft.model.length > 120) errors.model = 'مدل حداکثر ۱۲۰ نویسه است.';
  if (draft.ports.trim()) {
    const ports = Number(draft.ports);
    if (!Number.isInteger(ports) || ports < 0 || ports > 4096) errors.ports = 'تعداد پورت بین ۰ و ۴۰۹۶ باشد.';
  }
  return errors;
}

/** فقط فیلدهای همین فرم ارسال می‌شوند تا ویرایش، فیلدهای دیگر را بازنویسی نکند */
export function nodeBodyFromDraft(draft: NodeDraft): Record<string, unknown> {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    notes: draft.notes.trim(),
    location: draft.location.trim(),
    ip: draft.ip.trim(),
    deviceType: draft.deviceType.trim(),
    vendor: draft.vendor.trim(),
    model: draft.model.trim(),
    ports: draft.ports.trim() === '' ? null : Number(draft.ports),
    status: draft.status,
    ownerGroupId: draft.ownerGroupId === '' ? null : Number(draft.ownerGroupId),
  };
}

/** پیش‌نویس ویرایش لینک */
export interface ConnectionDraft {
  medium: TransmissionMedium;
  capacityMbps: string;
  latencyMs: string;
  sourcePort: string;
  targetPort: string;
  role: 'primary' | 'backup';
  label: string;
  description: string;
  notes: string;
  state: LinkState;
}

export function connectionDraftFrom(edge: TopologyEdgeModel): ConnectionDraft {
  return {
    medium: edge.medium,
    capacityMbps: edge.capacityMbps == null ? '' : String(edge.capacityMbps),
    latencyMs: edge.latencyMs == null ? '' : String(edge.latencyMs),
    sourcePort: edge.sourcePort ?? '',
    targetPort: edge.targetPort ?? '',
    role: edge.role ?? 'primary',
    label: edge.label ?? '',
    description: edge.description ?? '',
    notes: edge.notes ?? '',
    state: edge.state ?? 'unknown',
  };
}

export function validateConnectionDraft(draft: ConnectionDraft): DraftErrors<ConnectionDraft> {
  const errors: DraftErrors<ConnectionDraft> = {};
  if (draft.capacityMbps.trim()) {
    const value = Number(draft.capacityMbps);
    if (!Number.isFinite(value) || value <= 0 || value > 1000000) {
      errors.capacityMbps = 'ظرفیت باید عددی مثبت و کمتر از ۱٬۰۰۰٬۰۰۰ مگابیت باشد.';
    }
  }
  if (draft.latencyMs.trim()) {
    const value = Number(draft.latencyMs);
    if (!Number.isFinite(value) || value < 0 || value > 100000) errors.latencyMs = 'تأخیر معتبر نیست.';
  }
  if (draft.label.length > 160) errors.label = 'برچسب حداکثر ۱۶۰ نویسه است.';
  if (draft.description.length > 2000) errors.description = 'توضیح حداکثر ۲۰۰۰ نویسه است.';
  if (draft.notes.length > 4000) errors.notes = 'یادداشت حداکثر ۴۰۰۰ نویسه است.';
  if (draft.sourcePort.length > 48) errors.sourcePort = 'نام پورت حداکثر ۴۸ نویسه است.';
  if (draft.targetPort.length > 48) errors.targetPort = 'نام پورت حداکثر ۴۸ نویسه است.';
  return errors;
}

export function connectionBodyFromDraft(draft: ConnectionDraft): Record<string, unknown> {
  return {
    medium: draft.medium,
    capacityMbps: draft.capacityMbps.trim() === '' ? null : Number(draft.capacityMbps),
    latencyMs: draft.latencyMs.trim() === '' ? null : Number(draft.latencyMs),
    sourcePort: draft.sourcePort.trim(),
    targetPort: draft.targetPort.trim(),
    role: draft.role,
    label: draft.label.trim(),
    description: draft.description.trim(),
    notes: draft.notes.trim(),
    state: draft.state,
  };
}

/** والدهای مجاز برای هر نوع گرهٔ تازه */
export function parentCandidates(nodes: TopologyNodeModel[], kind: TopologyNodeKind): TopologyNodeModel[] {
  if (kind === 'city') return [];
  if (kind === 'aggregation' || kind === 'station') return nodes.filter((n) => n.kind === 'city');
  return nodes.filter((n) => n.kind === 'aggregation' || n.kind === 'station');
}

export function validateCreateNode(
  nodes: TopologyNodeModel[],
  draft: { kind: TopologyNodeKind; name: string; parentId: string }
): { name?: string; parentId?: string } {
  const errors: { name?: string; parentId?: string } = {};
  if (!draft.name.trim()) errors.name = 'نام الزامی است.';
  else if (draft.name.trim().length > 120) errors.name = 'نام حداکثر ۱۲۰ نویسه است.';
  if (draft.kind !== 'city') {
    const parent = nodes.find((n) => n.id === draft.parentId);
    if (!draft.parentId) errors.parentId = 'والد را انتخاب کنید.';
    else if (!parent) errors.parentId = 'والد انتخاب‌شده وجود ندارد.';
    else if (!parentCandidates(nodes, draft.kind).some((n) => n.id === parent.id)) {
      errors.parentId = 'والد انتخابی با این نوع گره هم‌خوان نیست.';
    }
  }
  if (!errors.name) {
    const parentId = draft.kind === 'city' ? null : draft.parentId || '';
    const name = draft.name.trim().toLowerCase();
    if (nodes.some((n) => n.parentId === parentId && n.name.trim().toLowerCase() === name)) {
      errors.name = 'گره‌ای با این نام در همین شاخه وجود دارد.';
    }
  }
  return errors;
}

/**
 * پیش‌بررسی اتصال، هم‌سو با قواعد سرور. سرور همچنان مرجع نهایی است؛ این تابع
 * فقط رفت‌وبرگشت بی‌فایده و خطاهای قابل‌پیش‌گیری را کم می‌کند.
 */
export function connectionCreateError(
  nodes: TopologyNodeModel[],
  edges: TopologyEdgeModel[],
  sourceId: string,
  targetId: string,
  role: 'primary' | 'backup'
): string | null {
  if (!sourceId || !targetId) return 'دو سر لینک را انتخاب کنید.';
  if (sourceId === targetId) return 'لینک نمی‌تواند یک گره را به خودش وصل کند.';
  const source = nodes.find((n) => n.id === sourceId);
  const target = nodes.find((n) => n.id === targetId);
  if (!source || !target) return 'یکی از گره‌های انتخاب‌شده وجود ندارد.';
  const sourceCity = source.kind === 'city';
  const targetCity = target.kind === 'city';
  if (!sourceCity && !targetCity) {
    if ((source.cityId || source.id) !== (target.cityId || target.id)) {
      return 'اتصال بین دو گره از شهرهای مختلف مجاز نیست.';
    }
  } else if (sourceCity !== targetCity) {
    const other = sourceCity ? target : source;
    if (other.kind !== 'aggregation' && other.kind !== 'station') {
      return 'اتصال مستقیم شهر به تجهیز مجاز نیست؛ تجهیز را به مرکز یا ایستگاه وصل کنید.';
    }
  }
  const duplicate = edges.some(
    (e) =>
      (e.role ?? 'primary') === role &&
      ((e.source === sourceId && e.target === targetId) || (e.source === targetId && e.target === sourceId))
  );
  if (duplicate) return 'لینکی با این نقش بین این دو گره از قبل وجود دارد.';
  return null;
}
