/**
 * NetWatch — مدل، فهرست و کمکی‌های دیاگرام شبکه
 * ----------------------------------------------------------------
 * این فایل تنها داده و توابع خالص دارد تا بوم، پنل مشخصات و ذخیره‌سازی
 * دقیقاً یک منبع حقیقت داشته باشند. هر دیاگرام مجموعهٔ مستقل خودش را دارد و
 * هیچ شناسه‌ای بین دیاگرام‌ها مشترک نیست.
 */
import type { Edge, Node } from '@xyflow/react';
import type {
  Device,
  DiagramConnectionKind,
  DiagramEdge,
  DiagramEdgeData,
  DiagramNode,
  DiagramNodeData,
  DiagramNodeType,
  DiagramShape,
} from './types';

export type DiagramFlowNode = Node<DiagramNodeData, DiagramNodeType>;
export type DiagramFlowEdge = Edge<DiagramEdgeData, 'diagram'>;

export interface DeviceType {
  key: string;
  label: string;
  icon: string;
  color: string;
}

/** فهرست تجهیزات قابل افزودن به بوم؛ آیکون و رنگ پیش‌فرض هر نوع */
export const DEVICE_CATALOG: DeviceType[] = [
  { key: 'switch', label: 'سوئیچ', icon: 'switch', color: '#2563eb' },
  { key: 'hub', label: 'هاب', icon: 'hub', color: '#0891b2' },
  { key: 'media-converter', label: 'مدیاکانورتر', icon: 'converter', color: '#7c3aed' },
  { key: 'camera', label: 'دوربین', icon: 'camera', color: '#db2777' },
  { key: 'router', label: 'روتر', icon: 'router', color: '#ea580c' },
  { key: 'firewall', label: 'فایروال', icon: 'firewall', color: '#dc2626' },
  { key: 'access-point', label: 'اکسس‌پوینت', icon: 'wifi', color: '#0d9488' },
  { key: 'server', label: 'سرور', icon: 'server', color: '#4f46e5' },
  { key: 'patch-panel', label: 'پچ‌پنل', icon: 'panel', color: '#64748b' },
  { key: 'onu', label: 'ONU', icon: 'onu', color: '#059669' },
  { key: 'other', label: 'سایر تجهیزات', icon: 'box', color: '#475569' },
];

export function deviceType(key: string | undefined): DeviceType {
  return DEVICE_CATALOG.find((d) => d.key === key) ?? DEVICE_CATALOG[DEVICE_CATALOG.length - 1];
}

/** تبدیل نوع تجهیز فارسی (مانند «دوربین IP») به کلید فهرست بوم */
export function deviceCatalogKey(deviceType: string | undefined): string {
  const value = String(deviceType ?? '').trim();
  const map: Record<string, string> = {
    'روتر': 'router',
    'سوئیچ': 'switch',
    'فایروال': 'firewall',
    'سرور': 'server',
    'دوربین IP': 'camera',
    'دوربین': 'camera',
    'اکسس‌پوینت': 'access-point',
    'مودم': 'other',
    'NVR': 'server',
    'UPS شبکه': 'other',
    'کنترلر': 'other',
  };
  const key = map[value];
  if (key) return key;
  return DEVICE_CATALOG.some((d) => d.key === value) ? value : 'other';
}

export interface ConnectionType {
  kind: DiagramConnectionKind;
  label: string;
  color: string;
  /** الگوی خط‌چین؛ خالی یعنی خط ممتد */
  dash: string;
  width: number;
}

/** پنج نوع ارتباط؛ رنگ، ضخامت و الگوی خط هر نوع را از هم جدا می‌کند. */
export const CONNECTION_TYPES: ConnectionType[] = [
  { kind: 'fiber', label: 'فیبر نوری', color: '#d97706', dash: '', width: 2.5 },
  { kind: 'copper', label: 'کابل شبکه', color: '#2563eb', dash: '', width: 2.5 },
  { kind: 'bandwidth', label: 'پهنای باند', color: '#7c3aed', dash: '', width: 4 },
  { kind: 'radio', label: 'رادیو', color: '#0d9488', dash: '8 6', width: 2.5 },
  { kind: 'modem', label: 'مودم', color: '#db2777', dash: '1 6', width: 3 },
];

export function connectionType(kind: DiagramConnectionKind | undefined): ConnectionType {
  return CONNECTION_TYPES.find((c) => c.kind === kind) ?? CONNECTION_TYPES[1];
}

export const HANDLE_SIDES = ['top', 'right', 'bottom', 'left'] as const;
export type HandleSide = (typeof HANDLE_SIDES)[number];

const SHAPE_SIZES: Record<DiagramShape, { width: number; height: number }> = {
  rect: { width: 180, height: 110 },
  circle: { width: 140, height: 140 },
};

/** رنگ پیش‌فرض کادر گروه؛ کم‌رنگ و متمایز از تجهیزات */
export const GROUP_DEFAULT_COLOR = '#60a5fa';

export function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }
}

export function createDeviceNode(deviceKey: string, position: { x: number; y: number }): DiagramFlowNode {
  const type = deviceType(deviceKey);
  const width = 190;
  const height = 86;
  return {
    id: newId(),
    type: 'device',
    position: { x: position.x - width / 2, y: position.y - height / 2 },
    width,
    height,
    data: {
      label: type.label,
      deviceType: type.key,
      color: type.color,
      model: '',
      serial: '',
      assetTag: '',
      description: '',
    },
  };
}

export function createShapeNode(shape: DiagramShape, position: { x: number; y: number }): DiagramFlowNode {
  const size = SHAPE_SIZES[shape];
  return {
    id: newId(),
    type: 'shape',
    position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
    width: size.width,
    height: size.height,
    data: { label: '', shape, text: '', color: shape === 'circle' ? '#bfdbfe' : '#dbeafe' },
  };
}

export function createGroupNode(position: { x: number; y: number }): DiagramFlowNode {
  const width = 360;
  const height = 260;
  return {
    id: newId(),
    type: 'group',
    position: { x: position.x - width / 2, y: position.y - height / 2 },
    width,
    height,
    // گروه پشت همهٔ اجزا و ارتباط‌ها می‌نشیند تا دسته‌بندی دیده شود.
    zIndex: -1,
    data: { label: 'گروه', text: '', color: GROUP_DEFAULT_COLOR },
  };
}

/** اندازهٔ شبکهٔ چسبندگی و گام جابه‌جایی با کلیدهای جهت */
export const GRID_SIZE = 10;

/** تصویر/لوگو روی بوم — نشانی فایل از سامانهٔ پیوست‌های همان دیاگرام می‌آید */
export function createImageNode(
  position: { x: number; y: number },
  image: { src: string; attachmentId?: number; caption?: string; width?: number; height?: number }
): DiagramFlowNode {
  const width = image.width ?? 280;
  const height = image.height ?? 180;
  return {
    id: newId(),
    type: 'image',
    position: { x: position.x - width / 2, y: position.y - height / 2 },
    width,
    height,
    data: {
      label: image.caption ?? 'تصویر',
      src: image.src,
      ...(image.attachmentId ? { attachmentId: image.attachmentId } : {}),
      ...(image.caption ? { caption: image.caption } : {}),
    },
  };
}

export function createNoteNode(position: { x: number; y: number }): DiagramFlowNode {
  const width = 220;
  const height = 140;
  return {
    id: newId(),
    type: 'note',
    position: { x: position.x - width / 2, y: position.y - height / 2 },
    width,
    height,
    data: { label: 'یادداشت', text: '', color: '#fef08a' },
  };
}

export function toFlowNode(node: DiagramNode): DiagramFlowNode {
  return {
    id: node.id,
    type: node.type,
    position: node.position,
    ...(node.width ? { width: node.width } : {}),
    ...(node.height ? { height: node.height } : {}),
    ...(node.type === 'group' ? { zIndex: -1 } : {}),
    data: { ...node.data },
  };
}

export function toFlowEdge(edge: DiagramEdge): DiagramFlowEdge {
  return {
    id: edge.id,
    type: 'diagram',
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle || 'right',
    targetHandle: edge.targetHandle || 'left',
    data: { kind: edge.kind, label: edge.label },
  };
}

export function serializeNodes(nodes: DiagramFlowNode[]): DiagramNode[] {
  return nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
    width: Math.round(node.width ?? node.measured?.width ?? 0) || undefined,
    height: Math.round(node.height ?? node.measured?.height ?? 0) || undefined,
    data: {
      label: String(node.data.label ?? ''),
      ...(node.data.deviceId ? { deviceId: Number(node.data.deviceId) } : {}),
      ...(node.data.deviceType ? { deviceType: node.data.deviceType } : {}),
      ...(node.data.color ? { color: node.data.color } : {}),
      ...(node.data.model ? { model: node.data.model } : {}),
      ...(node.data.serial ? { serial: node.data.serial } : {}),
      ...(node.data.assetTag ? { assetTag: node.data.assetTag } : {}),
      ...(node.data.description ? { description: node.data.description } : {}),
      ...(node.data.shape ? { shape: node.data.shape } : {}),
      ...(node.data.text ? { text: node.data.text } : {}),
      ...(node.data.ip ? { ip: node.data.ip } : {}),
      ...(node.data.syncedAt ? { syncedAt: node.data.syncedAt } : {}),
      ...(node.data.src ? { src: node.data.src } : {}),
      ...(node.data.attachmentId ? { attachmentId: node.data.attachmentId } : {}),
      ...(node.data.caption ? { caption: node.data.caption } : {}),
    },
  }));
}

export function serializeEdges(edges: DiagramFlowEdge[]): DiagramEdge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? 'right',
    targetHandle: edge.targetHandle ?? 'left',
    kind: edge.data?.kind ?? 'copper',
    label: String(edge.data?.label ?? ''),
  }));
}

/* ------------------------------------------------------------------ */
/* کلیپ‌بورد — کپی/برش/چسباندن در همین دیاگرام یا دیاگرام دیگر        */
/* ------------------------------------------------------------------ */
/* کلیپ‌بورد در حافظهٔ ماژول نگه داشته می‌شود: بین دو دیاگرام یک صفحه هم
   کار می‌کند و دادهٔ کاربر در localStorage یا سرور ذخیره نمی‌شود. حداکثر
   عمر آن یک ساعت است تا محتوای قدیمی ناخواسته چسبانده نشود. */

interface DiagramClipboard {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  at: number;
}

let clipboard: DiagramClipboard | null = null;
const CLIPBOARD_TTL_MS = 60 * 60 * 1000;
const CLIPBOARD_KEY = 'nw.diagrams.clipboard';

/**
 * کلیپ‌بورد علاوه بر حافظهٔ ماژول در sessionStorage هم نگه داشته می‌شود تا
 * با بازخوانی صفحه یا رفتن به دیاگرام دیگر (بارگذاری کامل) از دست نرود.
 * حجم آن محدود است؛ اگر بیش از حد بزرگ شود بی‌صدا کنار گذاشته می‌شود.
 */
function readClipboard(): DiagramClipboard | null {
  if (clipboard) return clipboard;
  try {
    const raw = sessionStorage.getItem(CLIPBOARD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DiagramClipboard;
    if (!Array.isArray(parsed?.nodes) || !parsed.nodes.length) return null;
    if (Date.now() - Number(parsed.at) > CLIPBOARD_TTL_MS) return null;
    clipboard = parsed;
    return clipboard;
  } catch {
    return null;
  }
}

export function copyToClipboard(nodes: DiagramFlowNode[], edges: DiagramFlowEdge[]): number {
  const ids = new Set(nodes.map((node) => node.id));
  if (!ids.size) return 0;
  const payload: DiagramClipboard = {
    nodes: serializeNodes(nodes),
    // فقط ارتباط‌هایی که دو سرشان در انتخاب هستند.
    edges: serializeEdges(edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))),
    at: Date.now(),
  };
  clipboard = payload;
  try {
    const encoded = JSON.stringify(payload);
    if (encoded.length < 200_000) sessionStorage.setItem(CLIPBOARD_KEY, encoded);
  } catch {
    /* حافظهٔ مرورگر در دسترس نیست؛ کلیپ‌بورد فقط در همین صفحه کار می‌کند */
  }
  return payload.nodes.length;
}

export function clipboardCount(): number {
  const current = readClipboard();
  if (!current || Date.now() - current.at > CLIPBOARD_TTL_MS) return 0;
  return current.nodes.length;
}

/** چسباندن با شناسه‌های تازه و جابه‌جایی جزئی تا روی نسخهٔ اصلی بیفتد */
export function pasteFromClipboard(offset = 28): { nodes: DiagramFlowNode[]; edges: DiagramFlowEdge[] } | null {
  if (!clipboard) clipboard = readClipboard();
  if (!clipboard || Date.now() - clipboard.at > CLIPBOARD_TTL_MS) return null;
  const idMap = new Map<string, string>();
  const nodes = clipboard.nodes.map((node) => {
    const id = newId();
    idMap.set(node.id, id);
    return {
      id,
      type: node.type,
      position: { x: node.position.x + offset, y: node.position.y + offset },
      ...(node.width ? { width: node.width } : {}),
      ...(node.height ? { height: node.height } : {}),
      ...(node.type === 'group' ? { zIndex: -1 } : {}),
      data: { ...node.data },
      selected: true,
    } as DiagramFlowNode;
  });
  const edges = clipboard.edges.map((edge) => ({
    id: newId(),
    type: 'diagram' as const,
    source: idMap.get(edge.source) as string,
    target: idMap.get(edge.target) as string,
    sourceHandle: edge.sourceHandle || 'right',
    targetHandle: edge.targetHandle || 'left',
    data: { kind: edge.kind, label: edge.label },
  }));
  return { nodes, edges };
}

/* ------------------------------------------------------------------ */
/* همگام‌سازی با رکورد تجهیز مانیتورینگ                                 */
/* ------------------------------------------------------------------ */
/**
 * دادهٔ تازهٔ گرهٔ تجهیز از رکورد واقعی آن.
 *
 * نام، نوع، مدل، سریال و IP از تجهیز گرفته می‌شود؛ رنگ فقط اگر کاربر رنگ
 * پیش‌فرض نوع قبلی را نگه داشته باشد با نوع تازه عوض می‌شود تا انتخاب دستی
 * رنگ از بین نرود.
 */
export function deviceNodeSyncPatch(
  current: DiagramNodeData,
  device: Device
): Partial<DiagramNodeData> {
  const nextKey = deviceCatalogKey(device.deviceType);
  const nextMeta = deviceType(nextKey);
  const prevMeta = deviceType(current.deviceType);
  const patch: Partial<DiagramNodeData> = {
    label: device.name,
    deviceType: nextKey,
    ip: device.ip,
    model: device.model || current.model || '',
    serial: device.serial || current.serial || '',
    syncedAt: Date.now(),
  };
  if (!current.color || current.color === prevMeta.color) patch.color = nextMeta.color;
  return patch;
}

/** آیا دادهٔ گره با رکورد تجهیز اختلاف دارد؟ (برای همگام‌سازی خودکار بی‌صدا) */
export function deviceNodeNeedsSync(current: DiagramNodeData, device: Device): boolean {
  const patch = deviceNodeSyncPatch(current, device);
  return (
    patch.label !== current.label ||
    patch.deviceType !== current.deviceType ||
    patch.ip !== current.ip ||
    (!!patch.model && patch.model !== current.model)
  );
}

/* ------------------------------------------------------------------ */
/* تراز و توزیع انتخاب چندگانه                                        */
/* ------------------------------------------------------------------ */
export type AlignMode = 'left' | 'right' | 'center-x' | 'top' | 'bottom' | 'center-y';

function nodeSize(node: DiagramFlowNode): { width: number; height: number } {
  return {
    width: node.width ?? node.measured?.width ?? 190,
    height: node.height ?? node.measured?.height ?? 86,
  };
}

/** تراز کردن اجزای انتخاب‌شده نسبت به لبهٔ مشترک (بر اساس کادر محدودکننده) */
export function alignNodes(nodes: DiagramFlowNode[], mode: AlignMode): DiagramFlowNode[] {
  const selected = nodes.filter((node) => node.selected);
  if (selected.length < 2) return nodes;
  const boxes = selected.map((node) => ({ node, ...nodeSize(node) }));
  const minX = Math.min(...boxes.map((b) => b.node.position.x));
  const maxX = Math.max(...boxes.map((b) => b.node.position.x + b.width));
  const minY = Math.min(...boxes.map((b) => b.node.position.y));
  const maxY = Math.max(...boxes.map((b) => b.node.position.y + b.height));

  const next = new Map<string, { x: number; y: number }>();
  for (const box of boxes) {
    let { x, y } = box.node.position;
    if (mode === 'left') x = minX;
    else if (mode === 'right') x = maxX - box.width;
    else if (mode === 'center-x') x = Math.round((minX + maxX) / 2 - box.width / 2);
    else if (mode === 'top') y = minY;
    else if (mode === 'bottom') y = maxY - box.height;
    else if (mode === 'center-y') y = Math.round((minY + maxY) / 2 - box.height / 2);
    next.set(box.node.id, { x: Math.round(x), y: Math.round(y) });
  }
  return nodes.map((node) => (next.has(node.id) ? { ...node, position: next.get(node.id)! } : node));
}

/** توزیع یکنواخت فاصلهٔ اجزای انتخاب‌شده در محور افقی یا عمودی */
export function distributeNodes(nodes: DiagramFlowNode[], axis: 'x' | 'y'): DiagramFlowNode[] {
  const selected = nodes.filter((node) => node.selected);
  if (selected.length < 3) return nodes;
  const boxes = selected
    .map((node) => ({ node, ...nodeSize(node) }))
    .sort((a, b) =>
      axis === 'x'
        ? a.node.position.x + a.width / 2 - (b.node.position.x + b.width / 2)
        : a.node.position.y + a.height / 2 - (b.node.position.y + b.height / 2)
    );
  const first = boxes[0];
  const last = boxes[boxes.length - 1];
  const startCenter = axis === 'x' ? first.node.position.x + first.width / 2 : first.node.position.y + first.height / 2;
  const endCenter = axis === 'x' ? last.node.position.x + last.width / 2 : last.node.position.y + last.height / 2;
  const step = (endCenter - startCenter) / (boxes.length - 1);

  const next = new Map<string, { x: number; y: number }>();
  boxes.forEach((box, index) => {
    if (index === 0 || index === boxes.length - 1) return;
    const center = startCenter + step * index;
    next.set(
      box.node.id,
      axis === 'x'
        ? { x: Math.round(center - box.width / 2), y: box.node.position.y }
        : { x: box.node.position.x, y: Math.round(center - box.height / 2) }
    );
  });
  return nodes.map((node) => (next.has(node.id) ? { ...node, position: next.get(node.id)! } : node));
}

/** رنگ متن متناسب با روشنایی پس‌زمینه (برای خوانایی متن داخل شکل) */
export function contrastText(hex: string | undefined): string {
  const value = String(hex ?? '').replace('#', '');
  if (value.length !== 6) return '#0f172a';
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? '#0f172a' : '#f8fafc';
}
