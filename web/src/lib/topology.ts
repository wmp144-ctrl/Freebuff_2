/**
 * توابع خالص دیاگرام ارتباطات شبکه
 * ----------------------------------------------------------------
 * رندر، چیدمان و ریاضیات نما (Zoom/Pan) این‌جا و مستقل از React است تا
 * آزمون‌پذیر باشد. هیچ درخواست شبکه‌ای یا وابستگی خارجی ندارد.
 */
import type {
  TopoLink,
  TopoGraphPayload,
  TopoLinkKind,
  TopoSettings,
  TopoNode,
  TopoNodeKind,
  TopoViewport,
} from './types';

export const MIN_ZOOM = 0.12;
export const MAX_ZOOM = 2.5;
export const DEFAULT_ZOOM = 1;

export const DEFAULT_SETTINGS: Required<TopoSettings> = {
  showLabels: true,
  showIps: true,
  showNotes: false,
  showGrid: true,
  snapToGrid: false,
  gridSize: 20,
  edgeStyle: 'bezier',
  showLinkMetrics: true,
};

export const DEFAULT_SIZE: Record<TopoNodeKind, { width: number; height: number }> = {
  device: { width: 196, height: 74 },
  site: { width: 220, height: 76 },
  cloud: { width: 172, height: 68 },
  note: { width: 220, height: 116 },
  group: { width: 320, height: 200 },
};

export const LINK_META: Record<
  TopoLinkKind,
  { label: string; color: string; dash?: string }
> = {
  ethernet: { label: 'اترنت', color: '#64748b' },
  fiber: { label: 'فیبر نوری', color: '#f59e0b' },
  wireless: { label: 'بی‌سیم', color: '#8b5cf6', dash: '8 5' },
  vpn: { label: 'VPN', color: '#0ea5e9', dash: '2 5' },
  logical: { label: 'منطقی', color: '#94a3b8', dash: '5 5' },
};

export const LAYOUT_META = {
  'hierarchy-tb': 'سلسله‌مراتبی عمودی',
  'hierarchy-lr': 'سلسله‌مراتبی افقی',
  grid: 'شبکهٔ منظم',
  radial: 'دایرهٔ مرکزی',
} as const;

export function normalizeSettings(settings: TopoSettings | undefined): Required<TopoSettings> {
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return DEFAULT_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function screenToWorld(view: TopoViewport, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - view.x) / view.zoom, y: (sy - view.y) / view.zoom };
}

export function worldToScreen(view: TopoViewport, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * view.zoom + view.x, y: wy * view.zoom + view.y };
}

/** بزرگ‌نمایی حول نقطهٔ نشانگر (نقطهٔ زیر ماوس ثابت می‌ماند) */
export function zoomAt(view: TopoViewport, nextZoom: number, sx: number, sy: number): TopoViewport {
  const zoom = clampZoom(nextZoom);
  const ratio = zoom / (view.zoom || 1);
  return {
    zoom,
    x: sx - (sx - view.x) * ratio,
    y: sy - (sy - view.y) * ratio,
  };
}

export function panBy(view: TopoViewport, dx: number, dy: number): TopoViewport {
  return { ...view, x: view.x + dx, y: view.y + dy };
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function graphBounds(nodes: TopoNode[], padding = 60): Bounds {
  if (!nodes.length) return { x: 0, y: 0, width: 900, height: 600 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  return {
    x: minX - padding,
    y: minY - padding,
    width: Math.max(1, maxX - minX + padding * 2),
    height: Math.max(1, maxY - minY + padding * 2),
  };
}

/** نمای «جای‌گیری کامل» برای اندازهٔ فعلی بوم */
export function fitViewport(
  nodes: TopoNode[],
  width: number,
  height: number,
  padding = 48,
  maxZoom = 1.15
): TopoViewport {
  if (!nodes.length || width <= 0 || height <= 0) {
    return { x: width / 2, y: height / 2, zoom: 1 };
  }
  const b = graphBounds(nodes, padding);
  const zoom = clampZoom(Math.min(maxZoom, width / b.width, height / b.height));
  return {
    zoom,
    x: width / 2 - (b.x + b.width / 2) * zoom,
    y: height / 2 - (b.y + b.height / 2) * zoom,
  };
}

/** موقعیت گرهٔ تازه در وسط نمای فعلی، با کمی جابه‌جایی تا روی گرهٔ دیگر نیفتد */
export function nextNodePosition(nodes: TopoNode[], view: TopoViewport, width: number, height: number): { x: number; y: number } {
  const center = screenToWorld(view, width / 2, height / 2);
  const nodeW = DEFAULT_SIZE.device.width;
  const nodeH = DEFAULT_SIZE.device.height;
  const startX = Math.round(center.x - nodeW / 2);
  const startY = Math.round(center.y - nodeH / 2);
  const overlaps = (x: number, y: number) =>
    nodes.some(
      (n) => x < n.x + n.width + 24 && n.x < x + nodeW + 24 && y < n.y + n.height + 20 && n.y < y + nodeH + 20
    );
  // مارپیچ شبکه‌ای: نزدیک‌ترین جای خالی به مرکز نما، بدون هم‌پوشانی با گره‌های موجود
  for (let ring = 0; ring < 60; ring += 1) {
    for (let dy = -ring; dy <= ring; dy += 1) {
      for (let dx = -ring; dx <= ring; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = startX + dx * (nodeW + 36);
        const y = startY + dy * (nodeH + 30);
        if (!overlaps(x, y)) return { x, y };
      }
    }
  }
  return { x: startX, y: startY };
}

/* ------------------------------------------------------------------ */
/* چیدمان خودکار                                                       */
/* ------------------------------------------------------------------ */

interface LayoutOptions {
  hGap?: number;
  vGap?: number;
  componentGap?: number;
}

function buildAdjacency(nodes: TopoNode[], links: TopoLink[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const n of nodes) map.set(n.id, new Set());
  for (const l of links) {
    if (!map.has(l.from) || !map.has(l.to)) continue;
    map.get(l.from)!.add(l.to);
    map.get(l.to)!.add(l.from);
  }
  return map;
}

function connectedComponents(nodes: TopoNode[], adjacency: Map<string, Set<string>>): string[][] {
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    const queue = [n.id];
    seen.add(n.id);
    const group: string[] = [];
    while (queue.length) {
      const id = queue.shift()!;
      group.push(id);
      for (const next of adjacency.get(id) || []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    components.push(group);
  }
  return components.sort((a, b) => b.length - a.length);
}

function bfsLevels(
  ids: string[],
  adjacency: Map<string, Set<string>>,
  indegree: Map<string, number>
): string[][] {
  if (!ids.length) return [];
  const degree = (id: string) => adjacency.get(id)?.size ?? 0;
  // ریشه: گره‌ای که یال ورودی ندارد (هسته/لبهٔ بالادست)، سپس بیشترین درجه.
  const root = [...ids].sort(
    (a, b) =>
      (indegree.get(a) ?? 0) - (indegree.get(b) ?? 0) ||
      degree(b) - degree(a) ||
      a.localeCompare(b)
  )[0];
  const visited = new Set([root]);
  let frontier = [root];
  const levels: string[][] = [[root]];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of adjacency.get(id) || []) {
        if (!visited.has(child)) {
          visited.add(child);
          next.push(child);
        }
      }
    }
    if (!next.length) break;
    levels.push(next);
    frontier = next;
  }
  // گره‌های یک مؤلفهٔ ناهمبند (نباید رخ دهد) به سطح آخر می‌روند
  const leftover = ids.filter((id) => !visited.has(id));
  if (leftover.length) levels.push(leftover);
  return levels;
}

function placeHierarchy(
  ids: string[],
  adjacency: Map<string, Set<string>>,
  indegree: Map<string, number>,
  byId: Map<string, TopoNode>,
  horizontal: boolean,
  hGap: number,
  vGap: number
): Record<string, { x: number; y: number }> {
  const levels = bfsLevels(ids, adjacency, indegree);
  // مرتب‌سازی هر سطح بر پایهٔ میانگین جایگاه والدها برای کاهش تقاطع‌ها
  const order = new Map<string, number>();
  levels.forEach((level, li) => {
    if (li > 0) {
      level.sort((a, b) => {
        const parentAvg = (id: string) => {
          const parents = [...(adjacency.get(id) || [])].filter((p) => (order.get(p) ?? Infinity) < li);
          return parents.length ? parents.reduce((s, p) => s + (order.get(p) ?? 0), 0) / parents.length : Infinity;
        };
        return parentAvg(a) - parentAvg(b) || a.localeCompare(b);
      });
    }
    level.forEach((id, i) => order.set(id, i));
  });

  const measure = (id: string) => (horizontal ? byId.get(id)!.height : byId.get(id)!.width);
  const cross = (id: string) => (horizontal ? byId.get(id)!.width : byId.get(id)!.height);
  const levelCross = levels.map((level) => Math.max(0, ...level.map(cross)));
  const levelMain = levels.map((level) => level.reduce((sum, id) => sum + measure(id), 0) + Math.max(0, level.length - 1) * (horizontal ? vGap : hGap));
  const maxCross = Math.max(0, ...levelCross);
  const out: Record<string, { x: number; y: number }> = {};
  let cursor = 0;
  levels.forEach((level, li) => {
    let pos = -(levelMain[li] || 0) / 2;
    for (const id of level) {
      const node = byId.get(id)!;
      const crossOffset = (maxCross - levelCross[li]) / 2;
      if (horizontal) {
        out[id] = { x: cursor, y: crossOffset + pos };
        pos += node.height + vGap;
      } else {
        out[id] = { x: pos, y: cursor + crossOffset };
        pos += node.width + hGap;
      }
    }
    cursor += (horizontal ? levelCross[li] : levelCross[li]) + (horizontal ? hGap : vGap);
  });
  return out;
}

function placeRadial(
  ids: string[],
  adjacency: Map<string, Set<string>>,
  indegree: Map<string, number>,
  byId: Map<string, TopoNode>,
  gap: number
): Record<string, { x: number; y: number }> {
  const levels = bfsLevels(ids, adjacency, indegree);
  const out: Record<string, { x: number; y: number }> = {};
  const maxW = Math.max(80, ...ids.map((id) => byId.get(id)!.width));
  const ringStep = maxW + gap + 40;
  levels.forEach((level, li) => {
    if (li === 0) {
      for (const id of level) out[id] = { x: -byId.get(id)!.width / 2, y: -byId.get(id)!.height / 2 };
      return;
    }
    const radius = li * ringStep;
    const count = Math.max(1, level.length);
    const step = (Math.PI * 2) / count;
    const start = -Math.PI / 2 + (li % 2 === 0 ? step / 2 : 0);
    level.forEach((id, i) => {
      const angle = start + step * i;
      out[id] = {
        x: Math.cos(angle) * radius - byId.get(id)!.width / 2,
        y: Math.sin(angle) * radius - byId.get(id)!.height / 2,
      };
    });
  });
  return out;
}

function normalizeToOrigin(positions: Record<string, { x: number; y: number }>, ids: string[], byId: Map<string, TopoNode>) {
  let minX = Infinity;
  let minY = Infinity;
  for (const id of ids) {
    const p = positions[id];
    if (!p) continue;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
  }
  for (const id of ids) {
    const p = positions[id];
    if (!p) continue;
    p.x = Math.round(p.x - minX);
    p.y = Math.round(p.y - minY);
  }
  return {
    width: Math.max(0, ...ids.map((id) => (positions[id]?.x ?? 0) + byId.get(id)!.width)),
    height: Math.max(0, ...ids.map((id) => (positions[id]?.y ?? 0) + byId.get(id)!.height)),
  };
}

/**
 * چیدمان خودکار گره‌ها. خروجی فقط موقعیت است؛ ترتیب/شناسه‌ها تغییر نمی‌کند
 * و Undo/Redo می‌تواند آن را مثل هر ویرایش دیگری بازگرداند.
 */
export function layoutGraph(
  nodes: TopoNode[],
  links: TopoLink[],
  mode: 'hierarchy-tb' | 'hierarchy-lr' | 'grid' | 'radial',
  options: LayoutOptions = {}
): Record<string, { x: number; y: number }> {
  if (!nodes.length) return {};
  const hGap = options.hGap ?? 46;
  const vGap = options.vGap ?? 74;
  const componentGap = options.componentGap ?? 90;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adjacency = buildAdjacency(nodes, links);
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  for (const l of links) if (indegree.has(l.to)) indegree.set(l.to, (indegree.get(l.to) ?? 0) + 1);

  if (mode === 'grid') {
    const sorted = [...nodes].sort((a, b) => a.z - b.z || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    const cellW = Math.max(...nodes.map((n) => n.width)) + hGap;
    const cellH = Math.max(...nodes.map((n) => n.height)) + vGap;
    const columns = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));
    const out: Record<string, { x: number; y: number }> = {};
    sorted.forEach((n, i) => {
      out[n.id] = { x: (i % columns) * cellW, y: Math.floor(i / columns) * cellH };
    });
    return out;
  }

  const components = connectedComponents(nodes, adjacency);
  const positions: Record<string, { x: number; y: number }> = {};
  let offsetX = 0;
  let offsetY = 0;
  let rowHeight = 0;
  const maxRowWidth = Math.max(900, Math.sqrt(nodes.length) * 260);
  for (const ids of components) {
    const local =
      mode === 'radial'
        ? placeRadial(ids, adjacency, indegree, byId, hGap)
        : placeHierarchy(ids, adjacency, indegree, byId, mode === 'hierarchy-lr', hGap, vGap);
    const size = normalizeToOrigin(local, ids, byId);
    if (offsetX > 0 && offsetX + size.width > maxRowWidth) {
      offsetX = 0;
      offsetY += rowHeight + componentGap;
      rowHeight = 0;
    }
    for (const id of ids) {
      const p = local[id];
      if (p) positions[id] = { x: p.x + offsetX, y: p.y + offsetY };
    }
    offsetX += size.width + componentGap;
    rowHeight = Math.max(rowHeight, size.height);
  }
  return positions;
}

/* ------------------------------------------------------------------ */
/* هندسهٔ یال‌ها                                                        */
/* ------------------------------------------------------------------ */

function anchorOnRect(from: TopoNode, towardX: number, towardY: number) {
  const cx = from.x + from.width / 2;
  const cy = from.y + from.height / 2;
  const dx = towardX - cx;
  const dy = towardY - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const sx = dx === 0 ? Infinity : from.width / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : from.height / 2 / Math.abs(dy);
  const scale = Math.min(sx, sy);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

export interface EdgeGeometry {
  d: string;
  labelX: number;
  labelY: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

export function edgeGeometry(a: TopoNode, b: TopoNode, style: 'bezier' | 'orthogonal' = 'bezier'): EdgeGeometry {
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const s = anchorOnRect(a, bc.x, bc.y);
  const t = anchorOnRect(b, ac.x, ac.y);
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  let d: string;
  if (style === 'orthogonal') {
    if (horizontal) {
      const midX = s.x + dx / 2;
      d = `M ${s.x} ${s.y} H ${midX} V ${t.y} H ${t.x}`;
    } else {
      const midY = s.y + dy / 2;
      d = `M ${s.x} ${s.y} V ${midY} H ${t.x} V ${t.y}`;
    }
  } else {
    const k = Math.min(160, Math.max(40, Math.hypot(dx, dy) * 0.32));
    if (horizontal) {
      d = `M ${s.x} ${s.y} C ${s.x + (dx > 0 ? k : -k)} ${s.y}, ${t.x - (dx > 0 ? k : -k)} ${t.y}, ${t.x} ${t.y}`;
    } else {
      d = `M ${s.x} ${s.y} C ${s.x} ${s.y + (dy > 0 ? k : -k)}, ${t.x} ${t.y - (dy > 0 ? k : -k)}, ${t.x} ${t.y}`;
    }
  }
  return { d, labelX: (s.x + t.x) / 2, labelY: (s.y + t.y) / 2, from: s, to: t };
}

/* ------------------------------------------------------------------ */
/* جست‌وجو، فیلتر و کمک‌تابع‌ها                                          */
/* ------------------------------------------------------------------ */

export interface NodeFilter {
  query?: string;
  statuses?: string[];
  groupId?: number | null;
}

export function nodeSearchText(node: TopoNode): string {
  const parts: string[] = [node.label, node.notes];
  if (node.device) {
    parts.push(
      node.device.name,
      node.device.ip,
      node.device.deviceType,
      node.device.groupName || '',
      node.device.location
    );
  }
  if (node.site) parts.push(node.site.name, node.site.code);
  return parts.join(' ').toLowerCase();
}

/** آیا گره با جست‌وجو/فیلترها هم‌خوان است؟ (همهٔ واژه‌ها باید حاضر باشند) */
export function nodeMatches(node: TopoNode, filter: NodeFilter = {}): boolean {
  const tokens = String(filter.query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length) {
    const haystack = nodeSearchText(node);
    if (!tokens.every((token) => haystack.includes(token))) return false;
  }
  if (node.kind === 'device') {
    if (filter.statuses?.length) {
      const status = node.device?.status ?? (node.deviceId ? 'unknown' : 'removed');
      if (!filter.statuses.includes(status)) return false;
    }
    if (filter.groupId) {
      if (node.device?.groupId !== filter.groupId) return false;
    }
  }
  return true;
}

export function isFilterActive(filter: NodeFilter): boolean {
  return !!(String(filter.query || '').trim() || filter.statuses?.length || filter.groupId);
}

export function truncateText(value: string, max: number): string {
  const s = String(value ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function snap(value: number, size: number): number {
  if (!size || size < 2) return Math.round(value);
  return Math.round(value / size) * size;
}

export function snapshotGraph(nodes: TopoNode[], links: TopoLink[]): { nodes: TopoNode[]; links: TopoLink[] } {
  return {
    nodes: nodes.map((n) => ({ ...n, device: n.device ? { ...n.device } : null, site: n.site ? { ...n.site } : null })),
    links: links.map((l) => ({ ...l })),
  };
}

export function toGraphPayload(nodes: TopoNode[], links: TopoLink[]): Omit<TopoGraphPayload, 'revision'> {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      deviceId: n.deviceId,
      siteId: n.siteId,
      label: n.label,
      notes: n.notes,
      x: n.x,
      y: n.y,
      width: n.width,
      height: n.height,
      color: n.color,
      z: n.z,
      meta: n.meta || {},
    })),
    // فقط فیلدهای قابل‌ویرایش فرستاده می‌شوند؛ `live` خروجی محاسبه‌شدهٔ سرور
    // است و هرگز نباید در گراف ذخیره یا بازنویسی شود.
    links: links.map((l) => ({
      id: l.id,
      from: l.from,
      to: l.to,
      kind: l.kind,
      label: l.label,
      notes: l.notes,
      color: l.color,
      style: l.style,
      meta: l.meta || {},
      capacityMbps: l.capacityMbps ?? null,
      monitorDeviceId: l.monitorDeviceId ?? null,
      telemetry: l.telemetry ?? { enabled: false, agent: '', ifIndex: null },
    })),
  };
}

export function newId(): string {
  const cryptoApi = typeof crypto !== 'undefined' ? crypto : null;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  const rand = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${rand()}-${rand()}-${rand()}-${rand()}`;
}

/** مختصات رهاکردن یک آیتم روی بوم (با در نظر گرفتن Zoom/Pan) */
export function dropWorldPosition(view: TopoViewport, rect: DOMRect, clientX: number, clientY: number): { x: number; y: number } {
  return screenToWorld(view, clientX - rect.left, clientY - rect.top);
}
