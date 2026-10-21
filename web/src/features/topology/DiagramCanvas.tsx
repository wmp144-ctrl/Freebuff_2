/**
 * بوم دیاگرام ارتباطات شبکه
 * ----------------------------------------------------------------
 * همه چیز با SVG رسم می‌شود تا خروجی تصویری بدون وابستگی به کتابخانهٔ خارجی
 * و کاملاً آفلاین باشد. لایهٔ گراف با یک transform مشترک (Zoom/Pan) جابه‌جا
 * می‌شود؛ مختصات گره‌ها همیشه در فضای «جهان» ذخیره می‌شوند و به Zoom وابسته
 * نیستند. برای شبکه‌های بزرگ، گره‌های بیرون از نما با Culling حذف می‌شوند و
 * جزئیات در بزرگ‌نمایی کم (LOD) پنهان می‌ماند.
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertTriangle,
  Building2,
  Cloud,
  Lock,
  Network,
  Router,
  Server,
  Shield,
  StickyNote,
  Wifi,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Expand,
} from 'lucide-react';
import type { TopoLink, TopoNode, TopoNodeKind, TopoViewport, TopoSettings } from '../../lib/types';
import {
  LINK_META,
  clampZoom,
  edgeGeometry,
  fitViewport,
  graphBounds,
  panBy,
  screenToWorld,
  snap,
  truncateText,
  zoomAt,
} from '../../lib/topology';
import { faDigits } from '../../lib/format';

export interface DiagramCanvasHandle {
  fit: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  focusNode: (id: string) => void;
  getView: () => TopoViewport;
  getSize: () => { width: number; height: number };
  setView: (view: TopoViewport) => void;
  /** SVG خودکفا و فقط شامل گراف (برای خروجی تصویری) */
  getExportSvg: () => string | null;
}

interface Props {
  nodes: TopoNode[];
  links: TopoLink[];
  settings: Required<TopoSettings>;
  selectedNodeIds: string[];
  selectedLinkIds: string[];
  readOnly: boolean;
  linkMode: boolean;
  activeIds: Set<string> | null;
  fitToken: number;
  onSelectionChange: (nodeIds: string[], linkIds: string[]) => void;
  onMoveStart: () => void;
  onMove: (updates: { id: string; x: number; y: number }[]) => void;
  onCreateLink: (from: string, to: string) => void;
  onDropDevice: (deviceId: number, x: number, y: number) => void;
  onDropSite: (siteId: number, x: number, y: number) => void;
  onViewportChange?: (view: TopoViewport) => void;
  onToggleFullscreen?: () => void;
}

const STATUS_COLOR: Record<string, string> = {
  online: '#16a34a',
  warning: '#f59e0b',
  offline: '#dc2626',
  maintenance: '#7c3aed',
  unknown: '#94a3b8',
  removed: '#ef4444',
};

const NODE_ACCENT: Record<TopoNodeKind, string> = {
  device: '#3b82f6',
  site: '#6366f1',
  cloud: '#0ea5e9',
  note: '#f59e0b',
  group: '#8b5cf6',
};

const DEFAULT_W = 196;
const DEFAULT_H = 74;

function statusOf(node: TopoNode): string {
  if (node.kind === 'device' && !node.device) return 'removed';
  return node.device?.status || 'unknown';
}

function nodeOpacity(node: TopoNode, activeIds: Set<string> | null): number {
  if (!activeIds) return 1;
  return activeIds.has(node.id) ? 1 : 0.16;
}

function deviceIcon(deviceType: string | undefined, size: number, color: string) {
  const t = String(deviceType || '').toLowerCase();
  const common = { width: size, height: size, color, strokeWidth: 1.7 } as const;
  if (/روتر|router|gateway|دروازه/.test(t)) return <Router {...common} />;
  if (/فایروال|firewall|security|امنیت/.test(t)) return <Shield {...common} />;
  if (/سرور|server|host/.test(t)) return <Server {...common} />;
  if (/بی.?سیم|wireless|ap|اکسس|access/.test(t)) return <Wifi {...common} />;
  if (/سوئیچ|switch/.test(t)) return <Network {...common} />;
  return <Network {...common} />;
}

function kindIcon(node: TopoNode, size: number, color: string) {
  if (node.kind === 'device') {
    if (!node.device) return <AlertTriangle width={size} height={size} color={color} strokeWidth={1.7} />;
    return deviceIcon(node.device.deviceType, size, color);
  }
  if (node.kind === 'site') return <Building2 width={size} height={size} color={color} strokeWidth={1.7} />;
  if (node.kind === 'cloud') return <Cloud width={size} height={size} color={color} strokeWidth={1.7} />;
  if (node.kind === 'note') return <StickyNote width={size} height={size} color={color} strokeWidth={1.7} />;
  return <Network width={size} height={size} color={color} strokeWidth={1.7} />;
}

function nodeTitle(node: TopoNode): string {
  if (node.label) return node.label;
  if (node.kind === 'device') return node.device?.name || 'تجهیز حذف‌شده';
  if (node.kind === 'site') return node.site?.name || 'مرکز حذف‌شده';
  if (node.kind === 'cloud') return 'شبکهٔ بیرونی';
  if (node.kind === 'note') return 'یادداشت';
  return 'گروه';
}

function nodeSubtitle(node: TopoNode): string {
  if (node.kind === 'device') {
    if (!node.device) return 'مرجع تجهیز حذف شده است';
    return node.device.ip;
  }
  if (node.kind === 'site') {
    if (!node.site) return 'مرکز تجمع حذف شده است';
    return `${faDigits(node.site.deviceCount)} تجهیز · ${faDigits(node.site.onlineCount)} در دسترس`;
  }
  return '';
}

/** شکستن متن یادداشت به سطرهای کوتاه، بدون وابستگی به موتور متن مرورگر */
function wrapLines(value: string, maxChars: number, maxLines: number): string[] {
  const words = String(value ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  if (lines.length <= maxLines) return lines;
  const clipped = lines.slice(0, maxLines);
  clipped[maxLines - 1] = truncateText(
    `${clipped[maxLines - 1]} ${lines.slice(maxLines).join(' ')}`,
    maxChars
  );
  return clipped;
}

function nodeFill(node: TopoNode): { fill: string; stroke: string; dash?: string } {
  if (node.color) return { fill: '#ffffff', stroke: node.color };
  if (node.kind === 'site') return { fill: `${node.site?.color || '#6366f1'}14`, stroke: `${node.site?.color || '#6366f1'}66`, dash: '7 5' };
  if (node.kind === 'note') return { fill: '#fffbeb', stroke: '#fcd34d' };
  if (node.kind === 'cloud') return { fill: '#f0f9ff', stroke: '#7dd3fc' };
  if (node.kind === 'device' && !node.device) return { fill: '#fef2f2', stroke: '#fca5a5', dash: '6 4' };
  return { fill: '#ffffff', stroke: '#dbe3ee' };
}

/** رنگ یال: رنگ سفارشی، وگرنه رنگ نوع لینک */
export function linkColor(link: TopoLink): string {
  return link.color || LINK_META[link.kind]?.color || '#64748b';
}

export function linkDash(link: TopoLink): string | undefined {
  if (link.style === 'dashed') return '9 6';
  if (link.style === 'dotted') return '2 6';
  return LINK_META[link.kind]?.dash;
}

const DiagramCanvas = forwardRef<DiagramCanvasHandle, Props>(function DiagramCanvas(
  {
    nodes,
    links,
    settings,
    selectedNodeIds,
    selectedLinkIds,
    readOnly,
    linkMode,
    activeIds,
    fitToken,
    onSelectionChange,
    onMoveStart,
    onMove,
    onCreateLink,
    onDropDevice,
    onDropSite,
    onViewportChange,
    onToggleFullscreen,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 960, height: 560 });
  const [view, setView] = useState<TopoViewport>({ x: 60, y: 60, zoom: 1 });
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [linkSource, setLinkSource] = useState<string | null>(null);
  const [cursorWorld, setCursorWorld] = useState<{ x: number; y: number } | null>(null);
  const [dropActive, setDropActive] = useState(false);

  const viewRef = useRef(view);
  viewRef.current = view;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const selectedRef = useRef(selectedNodeIds);
  selectedRef.current = selectedNodeIds;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  const panRef = useRef<{ startX: number; startY: number; view: TopoViewport } | null>(null);
  const dragRef = useRef<{
    ids: string[];
    startX: number;
    startY: number;
    origin: Map<string, { x: number; y: number }>;
    moved: boolean;
    started: boolean;
  } | null>(null);

  /* ---------------------- اندازهٔ بوم ---------------------- */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const apply = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setSize((prev) =>
          Math.abs(prev.width - rect.width) < 1 && Math.abs(prev.height - rect.height) < 1
            ? prev
            : { width: rect.width, height: rect.height }
        );
      }
    };
    apply();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', apply);
      return () => window.removeEventListener('resize', apply);
    }
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /* ---------------------- نما ---------------------- */
  const fit = useCallback(() => {
    setView(fitViewport(nodesRef.current, sizeRef.current.width, sizeRef.current.height));
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const { width, height } = sizeRef.current;
    setView((current) => zoomAt(current, current.zoom * factor, width / 2, height / 2));
  }, []);

  const resetZoom = useCallback(() => {
    const { width, height } = sizeRef.current;
    setView((current) => zoomAt(current, 1, width / 2, height / 2));
  }, []);

  const focusNode = useCallback((id: string) => {
    const node = nodesRef.current.find((n) => n.id === id);
    if (!node) return;
    const { width, height } = sizeRef.current;
    const zoom = Math.max(viewRef.current.zoom, 0.85);
    setView({
      zoom,
      x: width / 2 - (node.x + node.width / 2) * zoom,
      y: height / 2 - (node.y + node.height / 2) * zoom,
    });
  }, []);

  const getExportSvg = useCallback((): string | null => {
    const svg = svgRef.current;
    const graph = svg?.querySelector('[data-topology-graph]');
    if (!svg || !graph) return null;
    const b = graphBounds(nodesRef.current, 40);
    const clone = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(Math.ceil(b.width)));
    clone.setAttribute('height', String(Math.ceil(b.height)));
    clone.setAttribute('viewBox', `${b.x} ${b.y} ${b.width} ${b.height}`);
    clone.setAttribute('style', 'background:#ffffff;font-family:Vazirmatn,Tahoma,"Segoe UI",sans-serif');
    const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    background.setAttribute('x', String(b.x));
    background.setAttribute('y', String(b.y));
    background.setAttribute('width', String(b.width));
    background.setAttribute('height', String(b.height));
    background.setAttribute('fill', '#ffffff');
    clone.appendChild(background);
    const group = graph.cloneNode(true) as SVGGElement;
    group.removeAttribute('transform');
    group.querySelectorAll('[data-export="ignore"]').forEach((node) => node.remove());
    clone.appendChild(group);
    return new XMLSerializer().serializeToString(clone);
  }, []);

  useImperativeHandle(ref, () => ({
    fit,
    zoomIn: () => zoomBy(1.25),
    zoomOut: () => zoomBy(0.8),
    resetZoom,
    focusNode,
    getView: () => viewRef.current,
    getSize: () => sizeRef.current,
    setView: (next) => setView({ ...next, zoom: clampZoom(next.zoom) }),
    getExportSvg,
  }));

  useEffect(() => {
    if (fitToken > 0) fit();
  }, [fitToken, fit]);

  // نخستین بار که اندازهٔ واقعی بوم مشخص شد، نمای جای‌گیری اعمال شود.
  const initialFit = useRef(false);
  useEffect(() => {
    if (initialFit.current || !nodes.length || size.width < 10) return;
    initialFit.current = true;
    setView(fitViewport(nodes, size.width, size.height));
  }, [nodes, size.width, size.height]);

  useEffect(() => {
    onViewportChange?.(view);
  }, [view, onViewportChange]);

  /* ---------------------- چرخ ماوس = بزرگ‌نمایی ---------------------- */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      setView((current) => zoomAt(current, current.zoom * Math.exp(-event.deltaY * 0.0016), sx, sy));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /* ---------------------- Escape = لغو حالت لینک ---------------------- */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLinkSource(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toLocal = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  const beginCapture = (event: React.PointerEvent) => {
    try {
      svgRef.current?.setPointerCapture(event.pointerId);
    } catch {
      /* pointer capture در برخی مرورگرها برای SVG در دسترس نیست */
    }
  };

  /* ---------------------- کلیک زمینه ---------------------- */
  const onBackgroundPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    if (linkMode) {
      setLinkSource(null);
      return;
    }
    onSelectionChange([], []);
    beginCapture(event);
    panRef.current = { startX: event.clientX, startY: event.clientY, view: viewRef.current };
  };

  /* ---------------------- کلیک گره ---------------------- */
  const onNodePointerDown = (event: React.PointerEvent<SVGGElement>, node: TopoNode) => {
    event.stopPropagation();
    if (event.button !== 0) return;

    if (linkMode) {
      // در حالت رسم لینک، انتخاب گره پنل بازرسی را باز نمی‌کند تا بوم پوشیده نشود.
      if (!linkSource) {
        setLinkSource(node.id);
      } else if (linkSource === node.id) {
        setLinkSource(null);
      } else {
        onCreateLink(linkSource, node.id);
        setLinkSource(null);
      }
      return;
    }

    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    let next = selectedRef.current;
    if (!next.includes(node.id)) {
      next = additive ? [...next, node.id] : [node.id];
      onSelectionChange(next, []);
    } else if (additive) {
      next = next.filter((id) => id !== node.id);
      onSelectionChange(next, []);
      return;
    }

    if (readOnlyRef.current) return;
    beginCapture(event);
    const ids = next.length ? next : [node.id];
    const origin = new Map<string, { x: number; y: number }>();
    for (const item of nodesRef.current) {
      if (ids.includes(item.id)) origin.set(item.id, { x: item.x, y: item.y });
    }
    dragRef.current = {
      ids,
      startX: event.clientX,
      startY: event.clientY,
      origin,
      moved: false,
      started: false,
    };
  };

  /* ---------------------- حرکت/رهاسازی ---------------------- */
  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (panRef.current) {
      const dx = event.clientX - panRef.current.startX;
      const dy = event.clientY - panRef.current.startY;
      setView(panBy(panRef.current.view, dx, dy));
      return;
    }

    if (dragRef.current) {
      const drag = dragRef.current;
      const dxScreen = event.clientX - drag.startX;
      const dyScreen = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dxScreen, dyScreen) < 3) return;
      if (!drag.moved) {
        drag.moved = true;
        if (!drag.started) {
          drag.started = true;
          onMoveStart();
        }
      }
      const zoom = viewRef.current.zoom || 1;
      const grid = settingsRef.current.snapToGrid ? settingsRef.current.gridSize : 0;
      const updates = drag.ids
        .map((id) => {
          const start = drag.origin.get(id);
          if (!start) return null;
          return {
            id,
            x: grid ? snap(start.x + dxScreen / zoom, grid) : Math.round(start.x + dxScreen / zoom),
            y: grid ? snap(start.y + dyScreen / zoom, grid) : Math.round(start.y + dyScreen / zoom),
          };
        })
        .filter((x): x is { id: string; x: number; y: number } => !!x);
      if (updates.length) onMove(updates);
      return;
    }

    if (linkMode) {
      const local = toLocal(event.clientX, event.clientY);
      setCursorWorld(screenToWorld(viewRef.current, local.x, local.y));
    }
  };

  const endPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    if (panRef.current) panRef.current = null;
    if (dragRef.current) {
      dragRef.current = null;
    }
    try {
      svgRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      /* بی‌اثر */
    }
  };

  const onLinkClick = (event: React.PointerEvent<SVGPathElement>, link: TopoLink) => {
    event.stopPropagation();
    onSelectionChange([], [link.id]);
  };

  /* ---------------------- Drag & Drop از پالت ---------------------- */
  const readDrop = (event: React.DragEvent): { kind: string; id: number } | null => {
    const raw = event.dataTransfer.getData('application/x-netwatch-topology');
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { kind?: string; id?: number };
        if (parsed?.kind && Number(parsed.id) > 0) return { kind: parsed.kind, id: Number(parsed.id) };
      } catch {
        /* دادهٔ نامعتبر */
      }
    }
    const device = event.dataTransfer.getData('text/x-netwatch-device');
    if (device && Number(device) > 0) return { kind: 'device', id: Number(device) };
    return null;
  };

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropActive(false);
    if (readOnly) return;
    const item = readDrop(event);
    const rect = containerRef.current?.getBoundingClientRect();
    if (!item || !rect) return;
    const world = screenToWorld(viewRef.current, event.clientX - rect.left, event.clientY - rect.top);
    const x = Math.round(world.x - DEFAULT_W / 2);
    const y = Math.round(world.y - DEFAULT_H / 2);
    if (item.kind === 'site') onDropSite(item.id, x, y);
    else onDropDevice(item.id, x, y);
  };

  /* ---------------------- Culling ---------------------- */
  const visibleNodes = useMemo(() => {
    if (nodes.length <= 320) return nodes;
    const margin = 160;
    const x1 = (-view.x) / view.zoom - margin;
    const y1 = (-view.y) / view.zoom - margin;
    const x2 = (size.width - view.x) / view.zoom + margin;
    const y2 = (size.height - view.y) / view.zoom + margin;
    return nodes.filter((n) => n.x + n.width >= x1 && n.x <= x2 && n.y + n.height >= y1 && n.y <= y2);
  }, [nodes, view, size.width, size.height]);

  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);
  const visibleLinks = useMemo(
    () => links.filter((l) => visibleNodeIds.has(l.from) && visibleNodeIds.has(l.to)),
    [links, visibleNodeIds]
  );
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const selectedNodes = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds]);
  const selectedLinks = useMemo(() => new Set(selectedLinkIds), [selectedLinkIds]);

  const zoom = view.zoom;
  const showLabels = settings.showLabels && zoom >= 0.42;
  const showIps = settings.showIps && zoom >= 0.6;
  const showSecondary = zoom >= 0.55;
  const linkLabelVisible = zoom >= 0.58;
  const linkSourceNode = linkSource ? nodeById.get(linkSource) : null;

  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full overflow-hidden rounded-card border bg-[#fbfcfe] ${
        dropActive ? 'border-brand-400 ring-4 ring-brand-500/10' : 'border-ink-200/70'
      } ${linkMode ? 'cursor-crosshair' : ''}`}
      onDragOver={(event) => {
        if (readOnly) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDropActive(true);
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={onDrop}
    >
      <svg
        ref={svgRef}
        width={size.width}
        height={size.height}
        role="application"
        aria-label="بوم دیاگرام ارتباطات شبکه"
        className={`block select-none touch-none ${linkMode ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'}`}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onContextMenu={(event) => event.preventDefault()}
      >
        <defs>
          <pattern id="topo-dot-grid" width="22" height="22" patternUnits="userSpaceOnUse">
            <circle cx="1.4" cy="1.4" r="1.1" fill="#dbe3ee" />
          </pattern>
          <filter id="topo-node-shadow" x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="1.5" stdDeviation="2.2" floodColor="#0f172a" floodOpacity="0.08" />
          </filter>
        </defs>

        <rect width={size.width} height={size.height} fill={settings.showGrid ? 'url(#topo-dot-grid)' : '#fbfcfe'} />

        <g data-topology-graph transform={`translate(${view.x} ${view.y}) scale(${zoom})`}>
          {/* یال‌ها زیر گره‌ها */}
          <g aria-label="لینک‌های ارتباطی">
            {visibleLinks.map((link) => {
              const a = nodeById.get(link.from);
              const b = nodeById.get(link.to);
              if (!a || !b) return null;
              const geo = edgeGeometry(a, b, settings.edgeStyle);
              const active =
                !activeIds || (activeIds.has(link.from) && activeIds.has(link.to));
              const selected = selectedLinks.has(link.id);
              const color = linkColor(link);
              const dimmed = !active;
              return (
                <g key={link.id} opacity={dimmed ? 0.2 : 1}>
                  <path
                    d={geo.d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={16 / Math.max(0.35, zoom)}
                    className="cursor-pointer"
                    onPointerDown={(event) => onLinkClick(event, link)}
                  />
                  <path
                    d={geo.d}
                    fill="none"
                    stroke={selected ? '#2563eb' : color}
                    strokeWidth={selected ? 2.8 : 1.7}
                    strokeDasharray={linkDash(link)}
                    strokeLinecap="round"
                    pointerEvents="none"
                  />
                  <circle cx={geo.to.x} cy={geo.to.y} r={3} fill={selected ? '#2563eb' : color} pointerEvents="none" />
                  {link.label && linkLabelVisible ? (
                    <g pointerEvents="none">
                      <text
                        x={geo.labelX}
                        y={geo.labelY - 6}
                        textAnchor="middle"
                        fontSize={10.5}
                        fill={selected ? '#1d4ed8' : '#475569'}
                        stroke="#fbfcfe"
                        strokeWidth={3.4}
                        paintOrder="stroke"
                        direction="rtl"
                      >
                        {truncateText(link.label, 40)}
                      </text>
                    </g>
                  ) : null}
                  {selected ? (
                    <circle cx={geo.labelX} cy={geo.labelY + 3} r={2.4} fill="#2563eb" pointerEvents="none" />
                  ) : null}
                  {link.notes && showSecondary ? (
                    <g transform={`translate(${geo.labelX + 10} ${geo.labelY - 14})`} pointerEvents="none">
                      <title>{truncateText(link.notes, 180)}</title>
                      <StickyNote width={11} height={11} color="#d97706" strokeWidth={1.8} />
                    </g>
                  ) : null}
                </g>
              );
            })}
          </g>

          {/* گره‌ها */}
          <g aria-label="گره‌های دیاگرام">
            {visibleNodes.map((node) => {
              const selected = selectedNodes.has(node.id);
              const hovered = hoverNode === node.id;
              const w = node.width || DEFAULT_W;
              const h = node.height || DEFAULT_H;
              const status = statusOf(node);
              const statusColor = STATUS_COLOR[status] ?? STATUS_COLOR.unknown;
              const palette = nodeFill(node);
              const opacity = nodeOpacity(node, activeIds);
              const title = truncateText(nodeTitle(node), Math.max(10, Math.floor((w - 64) / 6.6)));
              const subtitle = truncateText(nodeSubtitle(node), Math.max(12, Math.floor((w - 64) / 5.8)));
              const accent = node.color || NODE_ACCENT[node.kind];
              const isNote = node.kind === 'note';
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x} ${node.y})`}
                  opacity={opacity}
                  className={readOnly || linkMode ? '' : 'cursor-move'}
                  onPointerDown={(event) => onNodePointerDown(event, node)}
                  onPointerEnter={() => setHoverNode(node.id)}
                  onPointerLeave={() => setHoverNode((prev) => (prev === node.id ? null : prev))}
                  onDoubleClick={() => focusNode(node.id)}
                >
                  <rect
                    x={0}
                    y={0}
                    width={w}
                    height={h}
                    rx={14}
                    fill={palette.fill}
                    stroke={selected ? '#2563eb' : palette.stroke}
                    strokeWidth={selected ? 2.4 : 1.1}
                    strokeDasharray={palette.dash}
                    filter={hovered && !selected ? 'url(#topo-node-shadow)' : undefined}
                  />
                  {/* نوار رنگی لبه (سمت راست در چیدمان RTL) */}
                  <rect x={w - 4.5} y={10} width={3} height={Math.max(10, h - 20)} rx={2} fill={accent} opacity={0.85} />

                  {isNote ? (
                    <>
                      <g transform="translate(12 12)" pointerEvents="none">
                        <StickyNote width={13} height={13} color="#d97706" strokeWidth={1.7} />
                      </g>
                      <text
                        x={w - 12}
                        y={25}
                        textAnchor="start"
                        fontSize={11}
                        fill="#92400e"
                        direction="rtl"
                        fontWeight={600}
                        pointerEvents="none"
                      >
                        {truncateText(title, Math.max(10, Math.floor((w - 38) / 6)))}
                      </text>
                      {node.notes ? (
                        wrapLines(node.notes, Math.max(16, Math.floor((w - 30) / 5.6)), 3).map((line, index) => (
                          <text
                            key={index}
                            x={w - 12}
                            y={46 + index * 16}
                            textAnchor="start"
                            fontSize={10.5}
                            fill="#a16207"
                            direction="rtl"
                            pointerEvents="none"
                          >
                            {line}
                          </text>
                        ))
                      ) : (
                        <text x={w - 12} y={46} textAnchor="start" fontSize={10.5} fill="#ca8a04" direction="rtl" pointerEvents="none">
                          (برای دیدن متن، یادداشت‌ها را نمایش دهید)
                        </text>
                      )}
                    </>
                  ) : (
                    <>
                      <g transform={`translate(${w - 36} ${12})`} pointerEvents="none">
                        {kindIcon(node, 19, accent)}
                      </g>
                      {showLabels ? (
                        <text
                          x={w - 48}
                          y={27}
                          textAnchor="start"
                          fontSize={12}
                          fontWeight={600}
                          fill="#1e293b"
                          direction="rtl"
                          pointerEvents="none"
                        >
                          {title}
                        </text>
                      ) : null}
                      {showIps && subtitle ? (
                        <text
                          x={w - 48}
                          y={46}
                          textAnchor="start"
                          fontSize={10.5}
                          fill="#64748b"
                          direction="rtl"
                          pointerEvents="none"
                          className="num"
                        >
                          {subtitle}
                        </text>
                      ) : null}
                      {showSecondary && node.kind === 'device' && node.device ? (
                        <text
                          x={12}
                          y={h - 12}
                          fontSize={9.5}
                          fill={node.device.status === 'offline' ? '#dc2626' : node.device.status === 'warning' ? '#d97706' : '#94a3b8'}
                          pointerEvents="none"
                          className="num"
                        >
                          {node.device.lastRtt != null ? `${Math.round(node.device.lastRtt)}ms` : '—'}
                        </text>
                      ) : null}
                      <circle cx={w - 17} cy={h - 17} r={4.2} fill={statusColor} pointerEvents="none">
                        {status === 'offline' ? (
                          <>
                            <animate attributeName="opacity" values="1;0.35;1" dur="1.8s" repeatCount="indefinite" />
                          </>
                        ) : null}
                      </circle>
                      {status === 'offline' ? (
                        <circle cx={w - 17} cy={h - 17} r={8} fill="none" stroke={statusColor} strokeOpacity={0.35} strokeWidth={1.2} pointerEvents="none" />
                      ) : null}
                    </>
                  )}

                  {node.notes && !isNote && settings.showNotes && showLabels ? (
                    <g transform="translate(12 13)" pointerEvents="none">
                      <title>یادداشت دارد</title>
                      <StickyNote width={12} height={12} color="#d97706" strokeWidth={1.8} />
                    </g>
                  ) : null}

                  {selected ? (
                    <>
                      <circle cx={0} cy={0} r={3.2} fill="#2563eb" />
                      <circle cx={w} cy={0} r={3.2} fill="#2563eb" />
                      <circle cx={0} cy={h} r={3.2} fill="#2563eb" />
                      <circle cx={w} cy={h} r={3.2} fill="#2563eb" />
                    </>
                  ) : null}
                </g>
              );
            })}
          </g>

          {/* پیش‌نمایش لینک در حال ساخت */}
          {linkMode && linkSourceNode && cursorWorld ? (
            <g pointerEvents="none" data-export="ignore">
              <line
                x1={linkSourceNode.x + linkSourceNode.width / 2}
                y1={linkSourceNode.y + linkSourceNode.height / 2}
                x2={cursorWorld.x}
                y2={cursorWorld.y}
                stroke="#2563eb"
                strokeWidth={2 / Math.max(0.4, zoom)}
                strokeDasharray="7 5"
              />
              <circle cx={cursorWorld.x} cy={cursorWorld.y} r={4 / Math.max(0.4, zoom)} fill="#2563eb" opacity={0.7} />
            </g>
          ) : null}
        </g>
      </svg>

      {nodes.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="max-w-sm rounded-card border border-dashed border-ink-300 bg-white/85 px-6 py-5 text-center shadow-soft backdrop-blur">
            <Network size={28} className="mx-auto mb-2 text-brand-500" />
            <p className="text-sm font-semibold text-ink-700">دیاگرام هنوز گره‌ای ندارد</p>
            <p className="mt-1 text-[11.5px] leading-6 text-ink-500">
              از پالت کنار، تجهیز یا مرکز تجمع را بکشید و روی بوم رها کنید؛ یا با «چیدمان خودکار از تجهیزات» شروع کنید.
            </p>
          </div>
        </div>
      ) : null}

      {/* کنترل‌های شناور بزرگ‌نمایی */}
      <div className="absolute bottom-3 left-3 flex items-center gap-1 rounded-pill border border-ink-200/80 bg-white/92 p-1 shadow-card backdrop-blur">
        <button type="button" className="btn-ghost btn-xs !rounded-full !border-0 !px-2" onClick={() => zoomBy(0.8)} aria-label="کوچک‌نمایی">
          <ZoomOut size={15} />
        </button>
        <button
          type="button"
          onClick={resetZoom}
          className="num min-w-[46px] rounded-full px-1 text-[11px] font-semibold text-ink-600 hover:text-brand-600"
          title="بازنشانی بزرگ‌نمایی به ۱۰۰٪"
        >
          {faDigits(Math.round(zoom * 100))}٪
        </button>
        <button type="button" className="btn-ghost btn-xs !rounded-full !border-0 !px-2" onClick={() => zoomBy(1.25)} aria-label="بزرگ‌نمایی">
          <ZoomIn size={15} />
        </button>
        <span className="mx-0.5 h-4 w-px bg-ink-200" aria-hidden />
        <button type="button" className="btn-ghost btn-xs !rounded-full !border-0 !px-2" onClick={fit} title="جای‌گیری کامل (F)" aria-label="جای‌گیری کامل">
          <Maximize2 size={14} />
        </button>
        {onToggleFullscreen ? (
          <button
            type="button"
            className="btn-ghost btn-xs !rounded-full !border-0 !px-2"
            onClick={onToggleFullscreen}
            title="تمام‌صفحه"
            aria-label="تمام‌صفحه"
          >
            <Expand size={13} />
          </button>
        ) : null}
      </div>

      {/* راهنما */}
      <div className="pointer-events-none absolute bottom-3 right-3 hidden items-center gap-2 rounded-pill border border-ink-200/70 bg-white/85 px-3 py-1.5 text-[10px] text-ink-500 backdrop-blur sm:flex">
        {readOnly ? (
          <>
            <Lock size={11} /> فقط‌خواندنی
          </>
        ) : (
          <>
            کشیدن زمینه = جابه‌جایی · چرخ ماوس = بزرگ‌نمایی · Shift+کلیک = انتخاب چندگانه
          </>
        )}
      </div>

      {dropActive ? (
        <div className="pointer-events-none absolute inset-2 rounded-card border-2 border-dashed border-brand-400/70 bg-brand-500/5" />
      ) : null}

      {linkMode ? (
        <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-pill bg-brand-600 px-3 py-1.5 text-[11px] font-medium text-white shadow-glow">
          {linkSource ? 'گرهٔ مقصد را انتخاب کنید — Esc برای لغو' : 'گرهٔ مبدأ لینک را انتخاب کنید'}
        </div>
      ) : null}

    </div>
  );
});

export default DiagramCanvas;
