/**
 * دیاگرام ارتباطات شبکه (Topology)
 * ----------------------------------------------------------------
 * ماژول مستقل اما یکپارچه با NetWatch:
 *   • گره‌ها به تجهیزات واقعی یا مراکز تجمع متصل‌اند و وضعیت زنده را نشان می‌دهند.
 *   • گراف در پایگاه‌داده ذخیره می‌شود (نه تصویر) و ویرایشگر آن را می‌سازد.
 *   • ذخیرهٔ خودکار با revision، Undo/Redo، قفل، الگو، تکثیر و خروجی آفلاین.
 *   • برای شبکه‌های بزرگ: جست‌وجوی سمت سرور، Culling در بوم و LOD.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Building2,
  Check,
  ChevronDown,
  Cloud,
  Copy,
  CopyPlus,
  Download,
  Eye,
  EyeOff,
  LayoutTemplate,
  Link2,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  Network,
  Plus,
  Redo2,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  StickyNote,
  Trash2,
  Undo2,
  Unlock,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type {
  TopoAnalysis,
  TopoCatalogItem,
  TopoDiagram,
  TopoDiagramStats,
  TopoDiagramSummary,
  TopoDeviceInfo,
  TopoImpact,
  TopoLink,
  TopoSite,
  TopoSiteRef,
  TopoNode,
  TopoPathDefinition,
  TopoSettings,
  TopoViewport,
} from '../lib/types';
import { useApp, useAsync, useLiveState, useToast } from '../lib/store';
import { useAuth } from '../lib/auth';
import { faDigits, fmtRelative } from '../lib/format';
import {
  DEFAULT_SETTINGS,
  LAYOUT_META,
  isFilterActive,
  layoutGraph,
  newId,
  nextNodePosition,
  nodeMatches,
  normalizeSettings,
  snapshotGraph,
  toGraphPayload,
} from '../lib/topology';
import {
  LINK_STATUS_META,
  applyLinkSnapshot,
  applyNodeSnapshot,
  attentionLinks,
  fmtBandwidth,
  fmtLatency,
  fmtLoss,
  fmtUtil,
  summarizeLinks,
} from '../lib/topology-live';
import { buildTopologyOverlay } from '../lib/topology-analysis';
import { LiveBadge } from '../components/Freshness';
import AnalysisPanel from '../features/topology/AnalysisPanel';
import DiagramCanvas, { type DiagramCanvasHandle } from '../features/topology/DiagramCanvas';
import DevicePalette from '../features/topology/DevicePalette';
import Inspector from '../features/topology/Inspector';
import {
  ConfirmDialog,
  ExportDialog,
  NewDiagramDialog,
  RenameDialog,
  SitesDialog,
  TemplatesDialog,
} from '../features/topology/TopologyDialogs';
import { Badge, Card, EmptyState, ErrorState, PageLoader, Spinner } from '../components/ui';

/* ------------------------------------------------------------------ */
/* کمک‌تابع‌ها                                                          */
/* ------------------------------------------------------------------ */

function statsFor(nodes: TopoNode[]): TopoDiagramStats {
  const stats: TopoDiagramStats = { online: 0, offline: 0, warning: 0, unknown: 0, maintenance: 0, placeholders: 0 };
  for (const node of nodes) {
    if (node.device) {
      const key = (node.device.status in stats ? node.device.status : 'unknown') as keyof TopoDiagramStats;
      stats[key] += 1;
    } else if ((node.kind === 'device' && !node.device) || (node.kind === 'site' && !node.site)) {
      stats.placeholders += 1;
    }
  }
  return stats;
}

function deviceInfo(item: TopoCatalogItem): TopoDeviceInfo {
  return {
    id: item.id,
    name: item.name,
    ip: item.ip,
    deviceType: item.deviceType,
    status: item.status,
    lastRtt: item.lastRtt,
    lossPct: item.lossPct,
    lastCheckAt: item.lastCheckAt,
    location: item.location,
    hostname: item.hostname,
    statusReason: item.statusReason,
    building: item.building,
    rack: item.rack,
    vendor: item.vendor,
    model: item.model,
    serial: item.serial,
    firmware: item.firmware,
    uptimePct: item.uptimePct ?? null,
    monitoringEnabled: item.monitoringEnabled,
    groupId: item.groupId,
    groupName: item.groupName,
    groupColor: item.groupColor,
    priority: item.priority,
  };
}

function siteRef(site: TopoSite): TopoSiteRef {
  return {
    id: site.id,
    name: site.name,
    code: site.code,
    color: site.color,
    deviceCount: site.deviceCount,
    onlineCount: site.onlineCount,
  };
}

function deviceNode(item: TopoCatalogItem, x: number, y: number): TopoNode {
  return {
    id: newId(),
    kind: 'device',
    deviceId: item.id,
    siteId: item.siteId,
    label: '',
    notes: '',
    x,
    y,
    width: 196,
    height: 74,
    color: '',
    z: 0,
    meta: {},
    device: deviceInfo(item),
    site: null,
  };
}

function siteNode(site: TopoSite, x: number, y: number): TopoNode {
  return {
    id: newId(),
    kind: 'site',
    deviceId: null,
    siteId: site.id,
    label: '',
    notes: '',
    x,
    y,
    width: 220,
    height: 76,
    color: '',
    z: 0,
    meta: {},
    device: null,
    site: siteRef(site),
  };
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function safeName(value: string): string {
  return (value || 'topology').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'topology';
}

function typingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return !!el.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]');
}

const AUTOSAVE_DELAY = 850;

/* ------------------------------------------------------------------ */
/* صفحه                                                                */
/* ------------------------------------------------------------------ */

type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';
type FilterStatus = 'online' | 'offline' | 'warning' | 'unknown' | 'maintenance';

export default function Topology() {
  const { push } = useToast();
  const { can } = useAuth();
  const { meta } = useApp();
  const canWrite = can('topology:write');
  const groups = meta?.groups ?? [];

  const overview = useAsync((signal) => api.topologyOverview(signal), []);
  const [diagramId, setDiagramId] = useState<number | null>(null);
  const [diagram, setDiagram] = useState<TopoDiagram | null>(null);
  const [nodes, setNodes] = useState<TopoNode[]>([]);
  const [links, setLinks] = useState<TopoLink[]>([]);
  const [revision, setRevision] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState('');
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedLinkIds, setSelectedLinkIds] = useState<string[]>([]);
  const [linkMode, setLinkMode] = useState(false);
  const [fitToken, setFitToken] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [statuses, setStatuses] = useState<FilterStatus[]>([]);
  const [groupFilter, setGroupFilter] = useState<number | null>(null);
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [paletteRefresh, setPaletteRefresh] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newBusy, setNewBusy] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const [sitesOpen, setSitesOpen] = useState(false);
  const [siteFocus, setSiteFocus] = useState<number | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState('');
  const [renameMode, setRenameMode] = useState<'duplicate' | 'template' | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [historyVersion, setHistoryVersion] = useState(0);
  const [liveAt, setLiveAt] = useState<number | null>(null);
  const [liveError, setLiveError] = useState('');
  const [telemetryPolling, setTelemetryPolling] = useState(false);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [analysis, setAnalysis] = useState<TopoAnalysis | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState('');
  const [impact, setImpact] = useState<TopoImpact | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [savingPaths, setSavingPaths] = useState(false);
  const [activeGroupName, setActiveGroupName] = useState('');
  const live = useLiveState();

  const canvasRef = useRef<DiagramCanvasHandle>(null);
  const nodesRef = useRef<TopoNode[]>([]);
  const linksRef = useRef<TopoLink[]>([]);
  const revisionRef = useRef(1);
  const diagramIdRef = useRef<number | null>(null);
  const lockedRef = useRef(false);
  const canWriteRef = useRef(canWrite);
  canWriteRef.current = canWrite;
  lockedRef.current = !!diagram?.locked;

  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const seqRef = useRef(0);
  const conflictsRef = useRef(false);
  const failureRef = useRef(0);
  const saveTimerRef = useRef<number | null>(null);
  const scheduleRef = useRef<(delay?: number) => void>(() => {});
  const historyRef = useRef<{ undo: { nodes: TopoNode[]; links: TopoLink[] }[]; redo: { nodes: TopoNode[]; links: TopoLink[] }[] }>({
    undo: [],
    redo: [],
  });
  const coalesceRef = useRef<{ key: string; at: number } | null>(null);
  const clipboardRef = useRef<{ nodes: TopoNode[]; links: TopoLink[] } | null>(null);
  const pasteCountRef = useRef(0);
  const viewportTimerRef = useRef<number | null>(null);
  const metaTimerRef = useRef<number | null>(null);
  const lastLiveRefreshRef = useRef(0);
  const pendingMetaRef = useRef<Record<string, unknown>>({});
  const initializedRef = useRef(false);
  const analysisAbortRef = useRef<AbortController | null>(null);
  const analysisSeqRef = useRef(0);
  const impactAbortRef = useRef<AbortController | null>(null);
  const impactSeqRef = useRef(0);
  const dismissedGroupRef = useRef('');

  const readOnly = !canWrite || !!diagram?.locked || loading;

  /* --------------------------- بارگذاری --------------------------- */

  const applyLoaded = useCallback((loaded: TopoDiagram, { fit = true } = {}) => {
    nodesRef.current = loaded.nodes;
    linksRef.current = loaded.links;
    revisionRef.current = loaded.revision;
    diagramIdRef.current = loaded.id;
    setNodes(loaded.nodes);
    setLinks(loaded.links);
    setDiagram(loaded);
    setRevision(loaded.revision);
    setDiagramId(loaded.id);
    setSelectedNodeIds([]);
    setSelectedLinkIds([]);
    setLinkMode(false);
    setInspectorOpen(false);
    setSaveState('saved');
    setSaveError('');
    setLiveAt(loaded.liveGeneratedAt ?? null);
    setLiveError('');
    setAnalysis(null);
    setAnalysisError('');
    setImpact(null);
    setActiveGroupName('');
    dismissedGroupRef.current = '';
    dirtyRef.current = false;
    conflictsRef.current = false;
    failureRef.current = 0;
    historyRef.current = { undo: [], redo: [] };
    setHistoryVersion((v) => v + 1);
    try {
      localStorage.setItem('nw.topology.diagram', String(loaded.id));
    } catch {
      /* حافظهٔ مرورگر در دسترس نیست */
    }
    const viewport = loaded.viewport as TopoViewport;
    if (fit && viewport && Number.isFinite(viewport.zoom) && Number.isFinite(viewport.x) && Number.isFinite(viewport.y)) {
      window.setTimeout(() => canvasRef.current?.setView(viewport), 120);
    } else if (fit) {
      setFitToken((v) => v + 1);
    }
  }, []);

  const openDiagram = useCallback(
    async (id: number, { fit = true } = {}) => {
      setLoading(true);
      setLoadError('');
      try {
        const loaded = await api.topologyDiagram(id);
        applyLoaded(loaded, { fit });
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : 'بارگذاری دیاگرام ناموفق بود.');
      } finally {
        setLoading(false);
      }
    },
    [applyLoaded]
  );

  useEffect(() => {
    if (initializedRef.current || !overview.data) return;
    initializedRef.current = true;
    const list = overview.data.diagrams;
    let remembered = 0;
    try {
      remembered = Number(localStorage.getItem('nw.topology.diagram')) || 0;
    } catch {
      remembered = 0;
    }
    const first = list.find((d) => d.id === remembered) ?? list[0];
    if (first) void openDiagram(first.id);
  }, [overview.data, openDiagram]);

  /* --------------------------- ذخیره --------------------------- */

  const flushSave = useCallback(async (): Promise<boolean> => {
    const id = diagramIdRef.current;
    if (!id || !dirtyRef.current) return true;
    if (conflictsRef.current || lockedRef.current) return false;
    if (savingRef.current) return false;
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    savingRef.current = true;
    const seq = seqRef.current;
    setSaveState('saving');
    setSaveError('');
    try {
      const payload = { revision: revisionRef.current, ...toGraphPayload(nodesRef.current, linksRef.current) };
      const saved = await api.saveTopologyGraph(id, payload);
      revisionRef.current = saved.revision;
      setRevision(saved.revision);
      setDiagram((prev) =>
        prev
          ? {
              ...prev,
              revision: saved.revision,
              updatedAt: saved.updatedAt,
              nodeCount: saved.nodeCount,
              linkCount: saved.linkCount,
              deviceCount: saved.deviceCount,
              offlineCount: saved.offlineCount,
              viewport: saved.viewport,
              settings: saved.settings,
            }
          : prev
      );
      if (seq === seqRef.current) {
        dirtyRef.current = false;
        nodesRef.current = saved.nodes;
        linksRef.current = saved.links;
        setNodes(saved.nodes);
        setLinks(saved.links);
        setSaveState('saved');
        failureRef.current = 0;
      } else {
        setSaveState('dirty');
      }
      return true;
    } catch (error) {
      const apiError = error as ApiError;
      failureRef.current += 1;
      if (apiError?.status === 409) {
        conflictsRef.current = true;
        setSaveState('conflict');
        setSaveError('نسخهٔ جدیدتری از این دیاگرام در سرور ثبت شده است.');
        push('نسخهٔ دیاگرام در جای دیگری تغییر کرده است؛ برای همگام‌سازی نسخهٔ سرور را بارگذاری کنید.', 'error');
      } else if (apiError?.status === 423) {
        setSaveState('error');
        setSaveError('دیاگرام قفل است.');
        push('این دیاگرام قفل است و تغییرها ذخیره نشدند.', 'warning');
      } else {
        setSaveState('error');
        setSaveError(apiError?.message || 'ذخیرهٔ خودکار ناموفق بود.');
        if (failureRef.current <= 1) push(apiError?.message || 'ذخیرهٔ خودکار ناموفق بود؛ اتصال به سرور را بررسی کنید.', 'error');
      }
      return false;
    } finally {
      savingRef.current = false;
      if (dirtyRef.current && !conflictsRef.current) {
        scheduleRef.current(Math.min(15000, 1200 * 2 ** Math.min(4, failureRef.current)));
      }
    }
  }, [push]);

  const scheduleSave = useCallback(
    (delay = AUTOSAVE_DELAY) => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void flushSave();
      }, delay);
    },
    [flushSave]
  );

  useEffect(() => {
    scheduleRef.current = scheduleSave;
  }, [scheduleSave]);

  const markDirty = useCallback(() => {
    if (!canWriteRef.current || lockedRef.current) return;
    dirtyRef.current = true;
    seqRef.current += 1;
    setSaveState('dirty');
    scheduleRef.current(AUTOSAVE_DELAY);
  }, []);

  /* --------------------------- تاریخچه --------------------------- */

  const pushHistory = useCallback(() => {
    const snapshot = snapshotGraph(nodesRef.current, linksRef.current);
    historyRef.current.undo.push(snapshot);
    if (historyRef.current.undo.length > 60) historyRef.current.undo.shift();
    historyRef.current.redo = [];
    setHistoryVersion((v) => v + 1);
  }, []);

  const commit = useCallback(
    (nextNodes: TopoNode[], nextLinks: TopoLink[], options: { history?: boolean } = {}) => {
      if (!canWriteRef.current || lockedRef.current) return false;
      if (options.history !== false) pushHistory();
      nodesRef.current = nextNodes;
      linksRef.current = nextLinks;
      setNodes(nextNodes);
      setLinks(nextLinks);
      markDirty();
      return true;
    },
    [markDirty, pushHistory]
  );

  const undo = useCallback(() => {
    if (readOnly) return;
    const previous = historyRef.current.undo.pop();
    if (!previous) return;
    historyRef.current.redo.push(snapshotGraph(nodesRef.current, linksRef.current));
    nodesRef.current = previous.nodes;
    linksRef.current = previous.links;
    setNodes(previous.nodes);
    setLinks(previous.links);
    setSelectedNodeIds([]);
    setSelectedLinkIds([]);
    setHistoryVersion((v) => v + 1);
    dirtyRef.current = true;
    seqRef.current += 1;
    setSaveState('dirty');
    scheduleRef.current(AUTOSAVE_DELAY);
  }, [readOnly, scheduleSave]);

  const redo = useCallback(() => {
    if (readOnly) return;
    const next = historyRef.current.redo.pop();
    if (!next) return;
    historyRef.current.undo.push(snapshotGraph(nodesRef.current, linksRef.current));
    nodesRef.current = next.nodes;
    linksRef.current = next.links;
    setNodes(next.nodes);
    setLinks(next.links);
    setSelectedNodeIds([]);
    setSelectedLinkIds([]);
    setHistoryVersion((v) => v + 1);
    dirtyRef.current = true;
    seqRef.current += 1;
    setSaveState('dirty');
    scheduleRef.current(AUTOSAVE_DELAY);
  }, [readOnly, scheduleSave]);

  const canUndo = historyRef.current.undo.length > 0;
  const canRedo = historyRef.current.redo.length > 0;
  void historyVersion;

  /* --------------------------- ویرایش گراف --------------------------- */

  const updateNode = useCallback(
    (id: string, patch: Partial<TopoNode>) => {
      if (readOnly) return;
      const key = `node:${id}:${Object.keys(patch).sort().join(',')}`;
      const now = Date.now();
      const last = coalesceRef.current;
      const history = !last || last.key !== key || now - last.at > 1400;
      coalesceRef.current = { key, at: now };
      const next = nodesRef.current.map((node) => (node.id === id ? { ...node, ...patch } : node));
      if (!commit(next, linksRef.current, { history })) return;
    },
    [commit, readOnly]
  );

  const updateLink = useCallback(
    (id: string, patch: Partial<TopoLink>) => {
      if (readOnly) return;
      const key = `link:${id}:${Object.keys(patch).sort().join(',')}`;
      const now = Date.now();
      const last = coalesceRef.current;
      const history = !last || last.key !== key || now - last.at > 1400;
      coalesceRef.current = { key, at: now };
      const next = linksRef.current.map((link) => (link.id === id ? { ...link, ...patch } : link));
      if (!commit(nodesRef.current, next, { history })) return;
    },
    [commit, readOnly]
  );

  const updateDiagramMeta = useCallback(
    (patch: { name?: string; description?: string; settings?: TopoSettings; layout?: string }) => {
      if (readOnly || !diagramId) return;
      if (patch.name !== undefined && !patch.name.trim()) return;
      setDiagram((prev) =>
        prev
          ? {
              ...prev,
              ...patch,
              layout: (patch.layout as TopoDiagram['layout']) ?? prev.layout,
            }
          : prev
      );
      Object.assign(pendingMetaRef.current, patch);
      if (metaTimerRef.current) window.clearTimeout(metaTimerRef.current);
      metaTimerRef.current = window.setTimeout(async () => {
        const id = diagramIdRef.current;
        const payload = pendingMetaRef.current;
        pendingMetaRef.current = {};
        if (!id || !Object.keys(payload).length) return;
        try {
          const saved = await api.updateTopologyDiagram(id, payload as Parameters<typeof api.updateTopologyDiagram>[1]);
          setDiagram((prev) => (prev ? { ...prev, name: saved.name, description: saved.description, layout: saved.layout, settings: saved.settings, updatedAt: saved.updatedAt } : prev));
          overview.refresh();
        } catch (error) {
          push(error instanceof Error ? error.message : 'ذخیرهٔ تنظیمات دیاگرام ناموفق بود.', 'error');
        }
      }, 650);
    },
    [diagramId, overview, push, readOnly]
  );

  const moveNodes = useCallback(
    (updates: { id: string; x: number; y: number }[]) => {
      if (readOnly) return;
      const map = new Map(updates.map((u) => [u.id, u]));
      const next = nodesRef.current.map((node) => {
        const update = map.get(node.id);
        return update ? { ...node, x: update.x, y: update.y } : node;
      });
      nodesRef.current = next;
      setNodes(next);
      markDirty();
    },
    [markDirty, readOnly]
  );

  const addNode = useCallback(
    (node: TopoNode) => {
      const maxZ = Math.max(0, ...nodesRef.current.map((n) => n.z));
      const withZ = { ...node, z: maxZ + 1 };
      const wasEmpty = nodesRef.current.length === 0;
      if (commit([...nodesRef.current, withZ], linksRef.current)) {
        setSelectedNodeIds([withZ.id]);
        setSelectedLinkIds([]);
        const view = canvasRef.current?.getView();
        const size = canvasRef.current?.getSize();
        let outside = wasEmpty;
        if (view && size) {
          const x1 = -view.x / view.zoom;
          const y1 = -view.y / view.zoom;
          const x2 = (size.width - view.x) / view.zoom;
          const y2 = (size.height - view.y) / view.zoom;
          outside = withZ.x < x1 + 20 || withZ.y < y1 + 20 || withZ.x + withZ.width > x2 - 20 || withZ.y + withZ.height > y2 - 20;
        }
        if (outside) setFitToken((v) => v + 1);
      }
    },
    [commit]
  );

  const addDevice = useCallback(
    (item: TopoCatalogItem, position?: { x: number; y: number }) => {
      const existing = nodesRef.current.find((n) => n.deviceId === item.id);
      if (existing) {
        setSelectedNodeIds([existing.id]);
        setSelectedLinkIds([]);
        canvasRef.current?.focusNode(existing.id);
        push('این تجهیز از قبل روی دیاگرام است.', 'info');
        return;
      }
      const view = canvasRef.current?.getView();
      const size = canvasRef.current?.getSize();
      const pos = position ?? (view && size ? nextNodePosition(nodesRef.current, view, size.width, size.height) : { x: 40, y: 40 });
      addNode(deviceNode(item, pos.x, pos.y));
    },
    [addNode, push]
  );

  const addSite = useCallback(
    (site: TopoSite, position?: { x: number; y: number }) => {
      const existing = nodesRef.current.find((n) => n.siteId === site.id);
      if (existing) {
        setSelectedNodeIds([existing.id]);
        setSelectedLinkIds([]);
        canvasRef.current?.focusNode(existing.id);
        push('این مرکز تجمع از قبل روی دیاگرام است.', 'info');
        return;
      }
      const view = canvasRef.current?.getView();
      const size = canvasRef.current?.getSize();
      const pos = position ?? (view && size ? nextNodePosition(nodesRef.current, view, size.width, size.height) : { x: 40, y: 40 });
      addNode(siteNode(site, pos.x, pos.y));
    },
    [addNode, push]
  );

  const addFreeNode = useCallback(
    (kind: 'note' | 'cloud') => {
      const view = canvasRef.current?.getView();
      const size = canvasRef.current?.getSize();
      const pos = view && size ? nextNodePosition(nodesRef.current, view, size.width, size.height) : { x: 60, y: 60 };
      const node: TopoNode = {
        id: newId(),
        kind,
        deviceId: null,
        siteId: null,
        label: kind === 'cloud' ? 'اینترنت / WAN' : 'یادداشت',
        notes: '',
        x: pos.x,
        y: pos.y,
        width: kind === 'cloud' ? 172 : 220,
        height: kind === 'cloud' ? 68 : 116,
        color: '',
        z: 0,
        meta: kind === 'note' ? { text: '' } : {},
        device: null,
        site: null,
      };
      addNode(node);
    },
    [addNode]
  );

  const createLink = useCallback(
    (from: string, to: string) => {
      if (readOnly || from === to) return;
      const duplicate = linksRef.current.find(
        (l) => (l.from === from && l.to === to) || (l.from === to && l.to === from)
      );
      if (duplicate) {
        push('بین این دو گره از قبل یک لینک وجود دارد.', 'warning');
        return;
      }
      const link: TopoLink = {
        id: newId(),
        from,
        to,
        kind: 'ethernet',
        label: '',
        notes: '',
        color: '',
        style: 'solid',
        meta: {},
        capacityMbps: null,
        monitorDeviceId: null,
        telemetry: { enabled: false, agent: '', ifIndex: null },
      };
      if (commit(nodesRef.current, [...linksRef.current, link])) {
        setSelectedNodeIds([]);
        setSelectedLinkIds([link.id]);
      }
    },
    [commit, push, readOnly]
  );

  const deleteSelection = useCallback(() => {
    if (readOnly || (!selectedNodeIds.length && !selectedLinkIds.length)) return;
    const nodeSet = new Set(selectedNodeIds);
    const linkSet = new Set(selectedLinkIds);
    const nextNodes = nodesRef.current.filter((n) => !nodeSet.has(n.id));
    const nextLinks = linksRef.current.filter((l) => !linkSet.has(l.id) && !nodeSet.has(l.from) && !nodeSet.has(l.to));
    if (commit(nextNodes, nextLinks)) {
      setSelectedNodeIds([]);
      setSelectedLinkIds([]);
      setInspectorOpen(false);
    }
  }, [commit, readOnly, selectedLinkIds, selectedNodeIds]);

  const duplicateSelection = useCallback(
    (offset = 32) => {
      if (readOnly) return;
      const selected = new Set(selectedNodeIds);
      const source = nodesRef.current.filter((n) => selected.has(n.id));
      if (!source.length) {
        push('برای تکثیر، ابتدا گره‌هایی به‌جز تجهیز را انتخاب کنید.', 'info');
        return;
      }
      // تجهیز واقعی فقط یک گره در هر دیاگرام دارد؛ تکثیر آن با داده‌های مانیتورینگ
      // ناسازگار می‌شد. سایر گره‌ها (مرکز، یادداشت، ابر) آزادانه تکثیر می‌شوند.
      const copyable = source.filter((n) => !(n.kind === 'device' && n.deviceId));
      const skipped = source.length - copyable.length;
      if (!copyable.length) {
        push('تجهیزات واقعی تکثیر نمی‌شوند؛ برای چیدمان از «الگو» یا تکثیر خود دیاگرام استفاده کنید.', 'info');
        return;
      }
      const map = new Map<string, string>();
      const clones = copyable.map((n) => {
        const id = newId();
        map.set(n.id, id);
        return { ...n, id, x: n.x + offset, y: n.y + offset, z: n.z + 1, device: n.device ? { ...n.device } : null, site: n.site ? { ...n.site } : null };
      });
      const cloneLinks = linksRef.current
        .filter((l) => map.has(l.from) && map.has(l.to))
        .map((l) => ({ ...l, id: newId(), from: map.get(l.from)!, to: map.get(l.to)! }));
      if (commit([...nodesRef.current, ...clones], [...linksRef.current, ...cloneLinks])) {
        setSelectedNodeIds(clones.map((n) => n.id));
        setSelectedLinkIds([]);
        if (skipped) push(`${faDigits(skipped)} تجهیز واقعی تکثیر نشد.`, 'info');
      }
    },
    [commit, push, readOnly, selectedNodeIds]
  );

  const copySelection = useCallback(() => {
    if (!selectedNodeIds.length) return;
    const selected = new Set(selectedNodeIds);
    const picked = nodesRef.current.filter((n) => selected.has(n.id));
    const internal = linksRef.current.filter((l) => selected.has(l.from) && selected.has(l.to));
    clipboardRef.current = snapshotGraph(picked, internal);
    pasteCountRef.current = 0;
    push(`${faDigits(picked.length)} گره کپی شد.`, 'success');
  }, [push, selectedNodeIds]);

  const pasteClipboard = useCallback(() => {
    const clip = clipboardRef.current;
    if (!clip || readOnly) return;
    pasteCountRef.current += 1;
    const offset = 32 * pasteCountRef.current;
    const copyable = clip.nodes.filter((n) => !(n.kind === 'device' && n.deviceId));
    const skipped = clip.nodes.length - copyable.length;
    if (!copyable.length) {
      push('در حافظه فقط تجهیز واقعی است؛ تکثیر تجهیز مجاز نیست.', 'info');
      return;
    }
    const map = new Map<string, string>();
    const clones = copyable.map((n) => {
      const id = newId();
      map.set(n.id, id);
      return { ...n, id, x: n.x + offset, y: n.y + offset, z: n.z + 1, device: n.device ? { ...n.device } : null, site: n.site ? { ...n.site } : null };
    });
    const cloneLinks = clip.links.filter((l) => map.has(l.from) && map.has(l.to)).map((l) => ({ ...l, id: newId(), from: map.get(l.from)!, to: map.get(l.to)! }));
    if (commit([...nodesRef.current, ...clones], [...linksRef.current, ...cloneLinks])) {
      setSelectedNodeIds(clones.map((n) => n.id));
      setSelectedLinkIds([]);
      setInspectorOpen(true);
      if (skipped) push(`${faDigits(skipped)} تجهیز واقعی در کپی نادیده گرفته شد.`, 'info');
    }
  }, [commit, push, readOnly]);

  const reorderNode = useCallback(
    (id: string, action: 'front' | 'back') => {
      const values = nodesRef.current.map((n) => n.z);
      const z = action === 'front' ? Math.max(0, ...values) + 1 : Math.min(0, ...values) - 1;
      updateNode(id, { z });
    },
    [updateNode]
  );

  const reverseLink = useCallback(
    (id: string) => {
      const link = linksRef.current.find((l) => l.id === id);
      if (!link) return;
      updateLink(id, { from: link.to, to: link.from });
    },
    [updateLink]
  );

  /* --------------------------- چیدمان --------------------------- */

  const applyLayout = useCallback(
    (mode: string = diagram?.layout || 'hierarchy-tb', { announce = true } = {}) => {
      if (readOnly || !nodesRef.current.length) return;
      const allowed = ['hierarchy-tb', 'hierarchy-lr', 'grid', 'radial'] as const;
      const selected = (allowed as readonly string[]).includes(mode) ? (mode as (typeof allowed)[number]) : 'hierarchy-tb';
      const positions = layoutGraph(nodesRef.current, linksRef.current, selected);
      const next = nodesRef.current.map((node) => {
        const p = positions[node.id];
        return p ? { ...node, x: Math.round(p.x + 40), y: Math.round(p.y + 40) } : node;
      });
      if (commit(next, linksRef.current)) {
        setFitToken((v) => v + 1);
        updateDiagramMeta({ layout: selected });
        if (announce) push(`چیدمان «${LAYOUT_META[selected]}» اعمال شد.`, 'success');
      }
    },
    [commit, diagram?.layout, push, readOnly, updateDiagramMeta]
  );

  /* --------------------------- viewport --------------------------- */

  const onViewportChange = useCallback(
    (view: TopoViewport) => {
      if (!canWriteRef.current || lockedRef.current || !diagramIdRef.current) return;
      if (viewportTimerRef.current) window.clearTimeout(viewportTimerRef.current);
      viewportTimerRef.current = window.setTimeout(async () => {
        const id = diagramIdRef.current;
        if (!id || !canWriteRef.current || lockedRef.current) return;
        try {
          await api.updateTopologyDiagram(id, { viewport: view });
        } catch {
          /* ذخیرهٔ نما اختیاری است */
        }
      }, 1800);
    },
    []
  );

  /* --------------------------- وضعیت زنده --------------------------- */

  /**
   * Snapshot را در گره‌ها/لینک‌ها ادغام می‌کند. این مسیر هیچ تغییری در
   * دادهٔ ذخیره‌شده ایجاد نمی‌کند و بنابراین Autosave/Undo را آلوده نمی‌کند.
   */
  const applyLiveSnapshot = useCallback((snapshot: Awaited<ReturnType<typeof api.topologyStatus>>) => {
    setNodes((prev) => {
      const next = applyNodeSnapshot(prev, snapshot);
      if (next !== prev) nodesRef.current = next;
      return next;
    });
    setLinks((prev) => {
      const next = applyLinkSnapshot(prev, snapshot);
      if (next !== prev) linksRef.current = next;
      return next;
    });
    setLiveAt(snapshot.generatedAt);
    setLiveError('');
  }, []);

  const loadAnalysis = useCallback(async (id: number, { quiet = false } = {}) => {
    const seq = analysisSeqRef.current + 1;
    analysisSeqRef.current = seq;
    analysisAbortRef.current?.abort();
    const controller = new AbortController();
    analysisAbortRef.current = controller;
    if (!quiet) setAnalysisLoading(true);
    try {
      const data = await api.topologyAnalysis(id, controller.signal);
      if (seq !== analysisSeqRef.current || id !== diagramIdRef.current) return;
      setAnalysis(data);
      setAnalysisError('');
      setActiveGroupName((name) => {
        if (name && data.redundancy.groups.some((group) => group.name === name)) return name;
        // اگر مسیر اصلی قطع شده باشد، گروه دچار failover به‌صورت خودکار روی
        // بوم نمایش داده می‌شود تا مسیر پشتیبانِ فعال بی‌درنگ دیده شود؛ مگر
        // اینکه کاربر همان گروه را دستی پنهان کرده باشد.
        const failover = data.redundancy.groups.find((group) => group.failover)?.name || '';
        return failover && failover !== dismissedGroupRef.current ? failover : '';
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (seq !== analysisSeqRef.current) return;
      setAnalysisError(error instanceof Error ? error.message : 'تحلیل شبکه ناموفق بود.');
    } finally {
      if (seq === analysisSeqRef.current) setAnalysisLoading(false);
    }
  }, []);

  const runImpact = useCallback(async (target: { linkId?: string; nodeId?: string }) => {
    const id = diagramIdRef.current;
    if (!id) return;
    const seq = impactSeqRef.current + 1;
    impactSeqRef.current = seq;
    impactAbortRef.current?.abort();
    const controller = new AbortController();
    impactAbortRef.current = controller;
    setImpactLoading(true);
    try {
      const result = await api.topologyImpact(id, target, controller.signal);
      if (seq !== impactSeqRef.current || id !== diagramIdRef.current) return;
      setImpact(result);
      setAnalysisOpen(true);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (seq !== impactSeqRef.current) return;
      push(error instanceof Error ? error.message : 'شبیه‌سازی اثر قطع ناموفق بود.', 'error');
    } finally {
      if (seq === impactSeqRef.current) setImpactLoading(false);
    }
  }, [push]);

  const savePaths = useCallback(
    async (paths: TopoPathDefinition[]): Promise<boolean> => {
      const id = diagramIdRef.current;
      if (!id) return false;
      setSavingPaths(true);
      try {
        const saved = await api.saveTopologyPaths(id, paths);
        setAnalysis((prev) => (prev ? { ...prev, paths: saved.items } : prev));
        push('مسیرهای اصلی و پشتیبان ذخیره شدند.', 'success');
        void loadAnalysis(id, { quiet: true });
        return true;
      } catch (error) {
        push(error instanceof Error ? error.message : 'ذخیرهٔ مسیرها ناموفق بود.', 'error');
        return false;
      } finally {
        setSavingPaths(false);
      }
    },
    [loadAnalysis, push]
  );

  const refreshLive = useCallback(
    async (fresh = false) => {
      const id = diagramIdRef.current;
      if (!id) return;
      try {
        const snapshot = await api.topologyStatus(id, undefined, { fresh });
        if (id !== diagramIdRef.current) return;
        applyLiveSnapshot(snapshot);
        // تحلیل با هر بازخوانی دستی/بازگشت به تب تازه می‌شود؛ بازهٔ خودکار آن
        // جداگانه است تا در شبکه‌های بزرگ هر ۱۰ ثانیه گراف دوباره پیمایش نشود.
        if (fresh) void loadAnalysis(id, { quiet: true });
      } catch (error) {
        if (id !== diagramIdRef.current) return;
        setLiveError(error instanceof Error ? error.message : 'دریافت وضعیت زنده ناموفق بود.');
      }
    },
    [applyLiveSnapshot, loadAnalysis]
  );

  // بازهٔ تازه‌سازی ۱۰ ثانیه است؛ رویدادهای SSE (در صورت اتصال) فقط زودتر
  // همان درخواست را Trigger می‌کنند تا نمایش با تغییر واقعی شبکه هم‌زمان شود.
  useEffect(() => {
    if (!diagramId) return;
    diagramIdRef.current = diagramId;
    void refreshLive(true);
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void refreshLive(false);
    }, 10000);
    const onVisible = () => {
      if (!document.hidden) void refreshLive(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [diagramId, refreshLive]);

  useEffect(() => {
    if (!diagramId || !live.lastEventAt) return;
    const now = Date.now();
    if (now - lastLiveRefreshRef.current < 4000) return;
    lastLiveRefreshRef.current = now;
    if (typeof document === 'undefined' || !document.hidden) void refreshLive(false);
  }, [diagramId, live.lastEventAt, refreshLive]);

  // تحلیل هر ۳۰ ثانیه تازه می‌شود تا فعال‌شدن مسیر پشتیبان و تغییر محل قطع
  // بدون دخالت دستی دیده شود. این بازه از وضعیت زندهٔ ۱۰ ثانیه‌ای جدا است.
  useEffect(() => {
    if (!diagramId) return;
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void loadAnalysis(diagramId, { quiet: true });
    }, 30000);
    return () => window.clearInterval(timer);
  }, [diagramId, loadAnalysis]);

  // هر ذخیرهٔ گراف revision را جلو می‌برد؛ تحلیل باید با ساختار تازه هم‌گام شود.
  useEffect(() => {
    // فقط وقتی نسخهٔ محلی از تحلیل جلوتر است (پس از ذخیرهٔ گراف) تحلیل را
    // تازه می‌کنیم. اگر تحلیل از نسخهٔ محلی جدیدتر باشد، یعنی نسخهٔ دیگری
    // ذخیره شده است و بازخوانی خودکار فقط حلقهٔ درخواست می‌ساخت.
    if (!diagramId || !analysis || analysis.revision >= revision) return;
    setImpact(null);
    void loadAnalysis(diagramId, { quiet: true });
  }, [analysis, diagramId, loadAnalysis, revision]);

  // با انتخاب یک لینک/گره روی بوم، اگر پنل تحلیل باز باشد اثر قطع همان مورد
  // شبیه‌سازی می‌شود. انتخاب چندگانه (برای ساخت مسیر) شبیه‌سازی را تغییر نمی‌دهد.
  useEffect(() => {
    if (!analysisOpen || !diagramId) return;
    const linkId = selectedLinkIds.length === 1 && !selectedNodeIds.length ? selectedLinkIds[0] : '';
    const nodeId = selectedNodeIds.length === 1 && !selectedLinkIds.length ? selectedNodeIds[0] : '';
    if (!linkId && !nodeId) return;
    const timer = window.setTimeout(() => {
      void runImpact(linkId ? { linkId } : { nodeId });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [analysisOpen, diagramId, selectedLinkIds, selectedNodeIds, runImpact]);

  useEffect(
    () => () => {
      analysisAbortRef.current?.abort();
      impactAbortRef.current?.abort();
    },
    []
  );

  const pollTelemetry = useCallback(async () => {
    const id = diagramIdRef.current;
    if (!id || telemetryPolling) return;
    setTelemetryPolling(true);
    try {
      const result = await api.pollTopologyTelemetry(id);
      if (result.snapshot) applyLiveSnapshot(result.snapshot);
      if (result.failed) {
        push(`${faDigits(result.failed)} لینک در سنجش ترافیک خطا داد؛ جزئیات در پنل لینک دیده می‌شود.`, 'warning');
      } else if (result.checked === 0) {
        push('هیچ لینکی برای سنجش ترافیک فعال نیست.', 'info');
      } else {
        push(`سنجش ترافیک ${faDigits(result.checked)} لینک انجام شد.`, 'success');
      }
    } catch (error) {
      push(error instanceof Error ? error.message : 'سنجش ترافیک ناموفق بود.', 'error');
    } finally {
      setTelemetryPolling(false);
    }
  }, [applyLiveSnapshot, push, telemetryPolling]);

  /* --------------------------- فیلتر --------------------------- */

  const filter = useMemo(
    () => ({ query, statuses: statuses as string[], groupId: groupFilter }),
    [query, statuses, groupFilter]
  );
  const filterActive = isFilterActive(filter);
  const activeIds = useMemo(() => {
    if (!filterActive) return null;
    return new Set(nodes.filter((node) => nodeMatches(node, filter)).map((node) => node.id));
  }, [nodes, filter, filterActive]);

  const displayNodes = useMemo(() => {
    if (!onlyMatches || !activeIds) return nodes;
    return nodes.filter((node) => activeIds.has(node.id));
  }, [nodes, onlyMatches, activeIds]);
  const displayNodeIds = useMemo(() => new Set(displayNodes.map((n) => n.id)), [displayNodes]);
  const displayLinks = useMemo(
    () => (onlyMatches ? links.filter((l) => displayNodeIds.has(l.from) && displayNodeIds.has(l.to)) : links),
    [links, onlyMatches, displayNodeIds]
  );

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const overlay = useMemo(
    () => buildTopologyOverlay(analysis, impact, { showCritical: analysisOpen, activeGroupName }),
    [analysis, impact, analysisOpen, activeGroupName]
  );

  const selectedNodes = useMemo(() => {
    const set = new Set(selectedNodeIds);
    return nodes.filter((n) => set.has(n.id));
  }, [nodes, selectedNodeIds]);
  const selectedLinks = useMemo(() => {
    const set = new Set(selectedLinkIds);
    return links.filter((l) => set.has(l.id));
  }, [links, selectedLinkIds]);

  const linkStats = useMemo(() => summarizeLinks(links), [links]);
  const attention = useMemo(() => attentionLinks(links), [links]);

  const diagramView = useMemo<TopoDiagram | null>(() => {
    if (!diagram) return null;
    return {
      ...diagram,
      nodes,
      links,
      nodeCount: nodes.length,
      linkCount: links.length,
      deviceCount: nodes.filter((n) => n.deviceId).length,
      stats: statsFor(nodes),
      linkStats,
      liveGeneratedAt: liveAt ?? diagram.liveGeneratedAt ?? null,
    };
  }, [diagram, nodes, links, linkStats, liveAt]);

  const settings = useMemo(() => normalizeSettings(diagram?.settings), [diagram?.settings]);

  /* --------------------------- انتخاب‌ها --------------------------- */

  const onSelectionChange = useCallback((nodeIds: string[], linkIds: string[]) => {
    setSelectedNodeIds(nodeIds);
    setSelectedLinkIds(linkIds);
    if (nodeIds.length || linkIds.length) setInspectorOpen(true);
  }, []);


  /* --------------------------- عملیات دیاگرام --------------------------- */

  const createDiagram = async (body: { name: string; description: string; layout: string; fromTemplateId: number | null }) => {
    setNewBusy(true);
    setDialogError('');
    try {
      return await api.createTopologyDiagram(body);
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : 'ساخت دیاگرام ناموفق بود.');
      return null;
    } finally {
      setNewBusy(false);
    }
  };

  const autoBuild = async () => {
    setNewBusy(true);
    setDialogError('');
    try {
      const [catalog, siteCatalog] = await Promise.all([
        api.topologyCatalog({ limit: 300 }),
        api.topologySites(),
      ]);
      const created = await api.createTopologyDiagram({
        name: 'توپولوژی شبکه',
        description: 'ساخته‌شده به‌صورت خودکار از تجهیزات موجود — لینک‌ها را دستی رسم کنید',
        layout: 'grid',
      });
      const temp: TopoNode[] = [
        ...siteCatalog.items.map((site) => siteNode(site, 0, 0)),
        ...catalog.items.map((item) => deviceNode(item, 0, 0)),
      ];
      const positions = layoutGraph(temp, [], 'grid');
      const withPositions = temp.map((node) => {
        const p = positions[node.id];
        return p ? { ...node, x: Math.round(p.x + 40), y: Math.round(p.y + 40) } : node;
      });
      const saved = await api.saveTopologyGraph(created.id, {
        revision: 1,
        ...toGraphPayload(withPositions, []),
      });
      applyLoaded(saved);
      setNewOpen(false);
      overview.refresh();
      push(`دیاگرام با ${faDigits(withPositions.length)} گره ساخته شد؛ برای ارتباط‌ها لینک رسم کنید.`, 'success');
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : 'ساخت خودکار دیاگرام ناموفق بود.');
    } finally {
      setNewBusy(false);
    }
  };

  const duplicateDiagram = async (name: string) => {
    if (!diagram) return;
    setActionBusy(true);
    try {
      const copy = await api.duplicateTopologyDiagram(diagram.id, { name });
      applyLoaded(copy);
      setRenameMode(null);
      overview.refresh();
      push('نسخهٔ تازهٔ دیاگرام ساخته شد.', 'success');
    } catch (error) {
      push(error instanceof Error ? error.message : 'تکثیر دیاگرام ناموفق بود.', 'error');
    } finally {
      setActionBusy(false);
    }
  };

  const saveAsTemplate = async (name: string) => {
    if (!diagram) return;
    setActionBusy(true);
    try {
      const template = await api.templateTopologyDiagram(diagram.id, { name });
      setRenameMode(null);
      overview.refresh();
      push(`الگوی «${template.name}» ذخیره شد.`, 'success');
    } catch (error) {
      push(error instanceof Error ? error.message : 'ذخیرهٔ الگو ناموفق بود.', 'error');
    } finally {
      setActionBusy(false);
    }
  };

  const useTemplate = async (template: TopoDiagramSummary) => {
    setBusyAction(`template-${template.id}`);
    try {
      const created = await api.createTopologyDiagram({ name: `${template.name} — نمونه`, fromTemplateId: template.id });
      applyLoaded(created);
      setTemplatesOpen(false);
      overview.refresh();
      push('دیاگرام تازه از الگو ساخته شد.', 'success');
    } catch (error) {
      push(error instanceof Error ? error.message : 'ساخت از الگو ناموفق بود.', 'error');
    } finally {
      setBusyAction('');
    }
  };

  const deleteTemplate = async (template: TopoDiagramSummary) => {
    setBusyAction(`template-${template.id}`);
    try {
      await api.deleteTopologyDiagram(template.id);
      overview.refresh();
      push('الگو حذف شد.', 'success');
    } catch (error) {
      push(error instanceof Error ? error.message : 'حذف الگو ناموفق بود.', 'error');
    } finally {
      setBusyAction('');
    }
  };

  const deleteDiagram = async () => {
    if (!diagram) return;
    setActionBusy(true);
    try {
      await api.deleteTopologyDiagram(diagram.id);
      setConfirmDelete(false);
      setDiagram(null);
      setDiagramId(null);
      diagramIdRef.current = null;
      setNodes([]);
      setLinks([]);
      nodesRef.current = [];
      linksRef.current = [];
      dirtyRef.current = false;
      const fresh = await api.topologyOverview();
      overview.setData?.(fresh);
      const next = fresh.diagrams[0];
      if (next) await openDiagram(next.id);
      push('دیاگرام حذف شد.', 'success');
    } catch (error) {
      push(error instanceof Error ? error.message : 'حذف دیاگرام ناموفق بود.', 'error');
    } finally {
      setActionBusy(false);
    }
  };

  const toggleLock = async () => {
    if (!diagram) return;
    if (!diagram.locked && dirtyRef.current) await flushSave();
    setActionBusy(true);
    try {
      const summary = await api.lockTopologyDiagram(diagram.id, !diagram.locked);
      setDiagram((prev) => (prev ? { ...prev, locked: summary.locked } : prev));
      lockedRef.current = summary.locked;
      if (summary.locked) setLinkMode(false);
      overview.refresh();
      push(summary.locked ? 'دیاگرام قفل شد؛ ویرایش تا بازکردن قفل ممکن نیست.' : 'قفل دیاگرام باز شد.', summary.locked ? 'success' : 'info');
    } catch (error) {
      push(error instanceof Error ? error.message : 'تغییر قفل ناموفق بود.', 'error');
    } finally {
      setActionBusy(false);
    }
  };

  const reloadDiagram = async () => {
    if (!diagramId) return;
    await openDiagram(diagramId, { fit: false });
  };

  const toggleFullscreen = useCallback(() => {
    setFullscreen((value) => !value);
    // پس از تغییر اندازهٔ بوم، نما دوباره جای‌گیری می‌شود تا کل گراف دیده شود.
    window.setTimeout(() => canvasRef.current?.fit(), 120);
  }, []);

  const openSites = useCallback((siteId?: number) => {
    setSiteFocus(typeof siteId === 'number' ? siteId : null);
    setSitesOpen(true);
  }, []);

  const onSitesChanged = useCallback(
    async (siteId?: number) => {
      overview.refresh();
      setPaletteRefresh((v) => v + 1);
      if (siteId) setSiteFocus(siteId);
      if (diagramIdRef.current) {
        if (dirtyRef.current) await flushSave();
        await openDiagram(diagramIdRef.current, { fit: false });
      }
    },
    [flushSave, openDiagram, overview]
  );

  const addCloudOrNote = (kind: 'note' | 'cloud') => addFreeNode(kind);

  /* --------------------------- خروجی --------------------------- */

  const exportSvg = () => {
    const svg = canvasRef.current?.getExportSvg();
    if (!svg) {
      push('بوم آمادهٔ خروجی نیست.', 'error');
      return;
    }
    downloadBlob(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), `${safeName(diagram?.name || 'topology')}.svg`);
    push('فایل SVG ساخته شد.', 'success');
  };

  const exportPng = async () => {
    const svg = canvasRef.current?.getExportSvg();
    if (!svg) {
      push('بوم آمادهٔ خروجی نیست.', 'error');
      return;
    }
    setExportBusy('png');
    try {
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      await new Promise<void>((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          try {
            const scale = Math.min(2, 7000 / Math.max(image.width, image.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(image.width * scale));
            canvas.height = Math.max(1, Math.round(image.height * scale));
            const context = canvas.getContext('2d');
            if (!context) throw new Error('بوم تصویر در دسترس نیست');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            canvas.toBlob((png) => {
              if (png) downloadBlob(png, `${safeName(diagram?.name || 'topology')}.png`);
              resolve();
            }, 'image/png');
          } catch (error) {
            reject(error);
          } finally {
            URL.revokeObjectURL(url);
          }
        };
        image.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('تبدیل تصویر ناموفق بود'));
        };
        image.src = url;
      });
      push('فایل PNG ساخته شد.', 'success');
    } catch (error) {
      push(error instanceof Error ? error.message : 'خروجی PNG ناموفق بود.', 'error');
    } finally {
      setExportBusy('');
    }
  };

  const exportJson = () => {
    if (!diagramId) return;
    window.location.assign(api.topologyExportUrl(diagramId));
  };

  /* --------------------------- میان‌برهای صفحه‌کلید --------------------------- */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (typingTarget(event.target)) return;
      const meta = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (key === 'escape') {
        if (fullscreen) setFullscreen(false);
        setLinkMode(false);
        setMoreOpen(false);
        return;
      }
      if (meta && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (meta && (key === 'y' || (key === 'z' && event.shiftKey))) {
        event.preventDefault();
        redo();
        return;
      }
      if (meta && key === 'c') {
        event.preventDefault();
        copySelection();
        return;
      }
      if (meta && key === 'v') {
        event.preventDefault();
        pasteClipboard();
        return;
      }
      if (meta && key === 'd') {
        event.preventDefault();
        duplicateSelection();
        return;
      }
      if (meta && key === 's') {
        event.preventDefault();
        void flushSave();
        return;
      }
      if (key === 'delete' || key === 'backspace') {
        if (selectedNodeIds.length || selectedLinkIds.length) {
          event.preventDefault();
          deleteSelection();
        }
        return;
      }
      if (key === 'f' && !meta) {
        canvasRef.current?.fit();
        return;
      }
      if (key === 'l' && !meta) {
        setLinkMode((v) => !v);
        return;
      }
      if (key === '?') {
        setInspectorOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    copySelection,
    deleteSelection,
    duplicateSelection,
    flushSave,
    fullscreen,
    pasteClipboard,
    redo,
    selectedLinkIds.length,
    selectedNodeIds.length,
    undo,
  ]);

  // خروج از صفحه یا پنهان‌شدن تب: آخرین تغییرها ذخیره شوند.
  useEffect(() => {
    const onHidden = () => {
      if (document.hidden && dirtyRef.current) void flushSave();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      if (dirtyRef.current) void flushSave();
      if (metaTimerRef.current) window.clearTimeout(metaTimerRef.current);
      if (viewportTimerRef.current) window.clearTimeout(viewportTimerRef.current);
    };
  }, [flushSave]);

  /* --------------------------- نمایش --------------------------- */

  const saveBadge = (() => {
    if (saveState === 'saving') {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-pill border border-brand-100 bg-brand-50 px-2.5 py-1 text-[10.5px] text-brand-700">
          <Loader2 size={11} className="animate-spin" /> در حال ذخیره…
        </span>
      );
    }
    if (saveState === 'dirty') {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-pill border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10.5px] text-amber-700">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> ذخیرهٔ خودکار…
        </span>
      );
    }
    if (saveState === 'conflict') {
      return (
        <button type="button" onClick={() => void reloadDiagram()} className="inline-flex items-center gap-1.5 rounded-pill border border-red-200 bg-red-50 px-2.5 py-1 text-[10.5px] text-red-700">
          <AlertTriangle size={11} /> بارگذاری نسخهٔ سرور
        </button>
      );
    }
    if (saveState === 'error') {
      return (
        <button type="button" onClick={() => void flushSave()} className="inline-flex items-center gap-1.5 rounded-pill border border-red-200 bg-red-50 px-2.5 py-1 text-[10.5px] text-red-700" title={saveError}>
          <RefreshCw size={11} /> تلاش دوبارهٔ ذخیره
        </button>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 rounded-pill border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10.5px] text-emerald-700" title="آخرین تغییر ذخیره شده است">
        <Check size={11} /> ذخیره شد
      </span>
    );
  })();

  const stats = diagramView?.stats ?? { online: 0, offline: 0, warning: 0, unknown: 0, maintenance: 0, placeholders: 0 };
  const statusOptions: { value: FilterStatus; label: string; count: number; dot: string }[] = [
    { value: 'online', label: 'در دسترس', count: stats.online, dot: 'bg-emerald-500' },
    { value: 'offline', label: 'قطع', count: stats.offline, dot: 'bg-red-500' },
    { value: 'warning', label: 'اختلال', count: stats.warning, dot: 'bg-amber-500' },
  ];
  const matchCount = activeIds ? activeIds.size : nodes.length;

  if (overview.loading && !overview.data) {
    return <PageLoader label="در حال بارگذاری دیاگرام‌ها…" />;
  }
  if (overview.error && !overview.data) {
    return <ErrorState message={overview.error} onRetry={overview.reload} />;
  }

  return (
    <div className="space-y-3">
      {!diagram && !loading ? (
        <Card className="overflow-hidden !p-0">
          <div className="grid gap-0 lg:grid-cols-[1.25fr_1fr]">
            <div className="p-6 sm:p-8">
              <div className="flex items-center gap-3">
                <span className="grid h-12 w-12 place-items-center rounded-2xl border border-brand-100 bg-brand-50 text-brand-600 shadow-glow">
                  <Network size={23} />
                </span>
                <div>
                  <h2 className="text-lg font-bold text-ink-800">دیاگرام ارتباطات شبکه</h2>
                  <p className="mt-0.5 text-[11.5px] text-ink-500">توپولوژی زنده، قابل ویرایش و مبتنی بر تجهیزات واقعی</p>
                </div>
              </div>
              <p className="mt-4 max-w-lg text-[12px] leading-6 text-ink-500">
                دیاگرام‌ها تصویر ثابت نیستند: هر گره به یک تجهیز واقعی یا مرکز تجمع متصل است و رنگ و وضعیت آن از
                مانیتورینگ می‌آید. ساختار گرافیکی، لینک‌ها و یادداشت‌ها در پایگاه‌داده ذخیره می‌شوند و ویرایش،
                Undo/Redo و ذخیرهٔ خودکار کاملاً آفلاین کار می‌کنند.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <button type="button" className="btn-primary" onClick={() => setNewOpen(true)}>
                  <Plus size={15} /> ساخت دیاگرام
                </button>
                <button type="button" className="btn-ghost" onClick={() => void autoBuild()} disabled={newBusy}>
                  {newBusy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} ساخت خودکار از تجهیزات
                </button>
                <button type="button" className="btn-ghost" onClick={() => openSites()}>
                  <Building2 size={14} /> مراکز تجمع
                </button>
              </div>
              {dialogError ? <p className="mt-3 text-xs text-red-600">{dialogError}</p> : null}
            </div>
            <div className="border-t border-ink-100 bg-ink-50/50 p-5 lg:border-s lg:border-t-0">
              <p className="text-[11px] font-semibold text-ink-600">شروع سریع</p>
              <ol className="mt-2 space-y-2 text-[11.5px] leading-5 text-ink-500">
                <li className="flex gap-2">
                  <span className="num grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white text-[10px] font-semibold text-brand-600">۱</span>
                  یک دیاگرام خالی بسازید یا از الگو شروع کنید.
                </li>
                <li className="flex gap-2">
                  <span className="num grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white text-[10px] font-semibold text-brand-600">۲</span>
                  تجهیزات و مراکز را از پالت بکشید و روی بوم رها کنید.
                </li>
                <li className="flex gap-2">
                  <span className="num grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white text-[10px] font-semibold text-brand-600">۳</span>
                  با ابزار «افزودن لینک» ارتباط‌ها را رسم و یادداشت ثبت کنید.
                </li>
              </ol>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <div className="rounded-soft border border-white bg-white/80 p-2 text-center">
                  <p className="num text-lg font-bold text-ink-800">{faDigits(overview.data?.stats.deviceTotal ?? 0)}</p>
                  <p className="text-[10px] text-ink-400">تجهیز موجود</p>
                </div>
                <div className="rounded-soft border border-white bg-white/80 p-2 text-center">
                  <p className="num text-lg font-bold text-ink-800">{faDigits(overview.data?.stats.siteTotal ?? 0)}</p>
                  <p className="text-[10px] text-ink-400">مرکز تجمع</p>
                </div>
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      {loading && !diagram ? <PageLoader label="در حال بارگذاری دیاگرام…" /> : null}

      {loadError ? (
        <div className="flex items-center justify-between gap-3 rounded-card border border-red-100 bg-red-50/70 p-4">
          <p className="text-[12px] text-red-700">{loadError}</p>
          <button type="button" className="btn-ghost btn-xs" onClick={() => (diagramId ? void openDiagram(diagramId) : overview.reload())}>
            تلاش دوباره
          </button>
        </div>
      ) : null}

      {diagram ? (
        <>
          <Card className="relative z-20 !p-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-soft border border-brand-100 bg-brand-50 text-brand-600">
                  <Network size={17} />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-semibold text-ink-800">{diagram.name}</p>
                  <p className="truncate text-[10.5px] text-ink-400">
                    {diagram.locked ? 'قفل‌شده — ' : ''}
                    {faDigits(nodes.length)} گره · {faDigits(links.length)} لینک · ویرایش {diagram.updatedAt ? new Date(diagram.updatedAt).toLocaleDateString('fa-IR') : '—'}
                  </p>
                </div>
              </div>

              <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1.5">
                {saveBadge}
                <select
                  value={diagramId ?? ''}
                  onChange={(event) => {
                    const id = Number(event.target.value);
                    if (id && id !== diagramId) void openDiagram(id);
                  }}
                  className="field !w-auto !max-w-[220px] !py-1.5 text-[11.5px]"
                  aria-label="انتخاب دیاگرام"
                >
                  {(overview.data?.diagrams ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                      {item.locked ? ' 🔒' : ''}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn-primary btn-xs" onClick={() => setNewOpen(true)}>
                  <Plus size={13} /> دیاگرام تازه
                </button>
                <button type="button" className="btn-ghost btn-xs" onClick={() => openSites()} title="مراکز تجمع">
                  <Building2 size={14} />
                  <span className="hidden sm:inline">مراکز</span>
                </button>
                <button
                  type="button"
                  className={`btn-xs ${diagram.locked ? 'btn-warn' : 'btn-ghost'}`}
                  onClick={() => void toggleLock()}
                  disabled={actionBusy || !canWrite}
                  title={diagram.locked ? 'بازکردن قفل ویرایش' : 'قفل کردن برای جلوگیری از ویرایش ناخواسته'}
                >
                  {diagram.locked ? <Unlock size={13} /> : <Lock size={13} />}
                  <span className="hidden md:inline">{diagram.locked ? 'بازکردن قفل' : 'قفل'}</span>
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-xs"
                  onClick={toggleFullscreen}
                  title={fullscreen ? 'خروج از تمام‌صفحه' : 'تمام‌صفحه'}
                  aria-label="تمام‌صفحه"
                >
                  {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                </button>
                <div className="relative">
                  <button type="button" className="btn-ghost btn-xs" onClick={() => setMoreOpen((v) => !v)} aria-expanded={moreOpen}>
                    بیشتر <ChevronDown size={13} />
                  </button>
                  {moreOpen ? (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setMoreOpen(false)} aria-hidden />
                      <div className="absolute left-0 top-full z-50 mt-1 w-52 animate-fade-up overflow-hidden rounded-soft border border-ink-200 bg-white p-1 shadow-pop">
                        <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[11.5px] text-ink-600 hover:bg-ink-50" onClick={() => { setMoreOpen(false); setRenameMode('duplicate'); }} disabled={!canWrite}>
                          <Copy size={13} /> تکثیر دیاگرام
                        </button>
                        <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[11.5px] text-ink-600 hover:bg-ink-50" onClick={() => { setMoreOpen(false); setRenameMode('template'); }} disabled={!canWrite}>
                          <LayoutTemplate size={13} /> ذخیره به‌عنوان الگو
                        </button>
                        <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[11.5px] text-ink-600 hover:bg-ink-50" onClick={() => { setMoreOpen(false); setTemplatesOpen(true); }}>
                          <LayoutTemplate size={13} /> گالری الگوها
                        </button>
                        <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[11.5px] text-ink-600 hover:bg-ink-50" onClick={() => { setMoreOpen(false); setExportOpen(true); }}>
                          <Download size={13} /> خروجی SVG / PNG / JSON
                        </button>
                        <div className="my-1 h-px bg-ink-100" />
                        <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[11.5px] text-red-600 hover:bg-red-50" onClick={() => { setMoreOpen(false); setConfirmDelete(true); }} disabled={!canWrite || actionBusy}>
                          <Trash2 size={13} /> حذف دیاگرام
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          </Card>

          {/* نوار وضعیت زندهٔ ارتباطات — رنگ‌ها فقط از دادهٔ واقعی می‌آیند */}
          <Card className="!p-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="flex items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-soft border border-emerald-100 bg-emerald-50 text-emerald-600">
                  <Activity size={14} />
                </span>
                <div className="leading-tight">
                  <p className="text-[11.5px] font-semibold text-ink-700">وضعیت زندهٔ ارتباطات</p>
                  <p className="text-[10px] text-ink-400">
                    {liveAt ? `به‌روزرسانی ${fmtRelative(liveAt)}` : 'در انتظار داده…'}
                    {liveError ? ' · خطا در دریافت' : ''}
                  </p>
                </div>
                <LiveBadge compact />
              </div>

              <div className="flex flex-wrap items-center gap-1.5" data-testid="link-status-summary">
                {(['up', 'down', 'degraded', 'unknown'] as const).map((status) => (
                  <span
                    key={status}
                    className={`inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-[10px] ${LINK_STATUS_META[status].border} ${LINK_STATUS_META[status].soft} ${LINK_STATUS_META[status].text}`}
                    title={LINK_STATUS_META[status].label}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${LINK_STATUS_META[status].dot}`} />
                    <span className="num font-semibold">{faDigits(linkStats[status])}</span>
                    <span className="hidden sm:inline">{LINK_STATUS_META[status].label}</span>
                  </span>
                ))}
              </div>

              {linkStats.highLoad || linkStats.saturated ? (
                <span className="inline-flex items-center gap-1 rounded-pill border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] text-amber-800">
                  <AlertTriangle size={10} />
                  <span className="num">{faDigits(linkStats.saturated)}</span> نزدیک اشباع
                  <span className="text-amber-500">·</span>
                  <span className="num">{faDigits(linkStats.highLoad)}</span> پرترافیک
                </span>
              ) : null}

              <div className="ms-auto flex items-center gap-1.5">
                <button
                  type="button"
                  className={`btn-ghost btn-xs ${analysisOpen ? '!bg-violet-50 !text-violet-700' : ''}`}
                  onClick={() => setAnalysisOpen((v) => !v)}
                  title="تحلیل وابستگی، نقاط بحرانی و مسیرهای پشتیبان"
                  aria-expanded={analysisOpen}
                >
                  <ShieldAlert size={12} className={analysisOpen ? 'text-violet-600' : 'text-ink-500'} />
                  <span className="hidden sm:inline">تحلیل شبکه</span>
                  {analysis?.summary.activeBackupCount ? (
                    <span className="rounded-pill bg-violet-100 px-1.5 text-[9px] text-violet-700">
                      {faDigits(analysis.summary.activeBackupCount)} پشتیبان فعال
                    </span>
                  ) : null}
                </button>
                {attention.length ? (
                  <button
                    type="button"
                    className={`btn-ghost btn-xs ${attentionOpen ? '!bg-ink-100' : ''}`}
                    onClick={() => setAttentionOpen((v) => !v)}
                    aria-expanded={attentionOpen}
                  >
                    <AlertTriangle size={12} className="text-amber-600" />
                    <span className="num">{faDigits(attention.length)}</span> نیازمند توجه
                    <ChevronDown size={12} className={attentionOpen ? 'rotate-180' : ''} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn-ghost btn-xs"
                  onClick={() => void refreshLive(true)}
                  title="بازخوانی وضعیت از موتور مانیتورینگ"
                >
                  <RefreshCw size={12} /> <span className="hidden sm:inline">به‌روزرسانی</span>
                </button>
              </div>
            </div>

            {liveError ? (
              <p className="mt-2 rounded-lg bg-red-50 px-2.5 py-1.5 text-[10.5px] text-red-700">{liveError}</p>
            ) : null}

            {attentionOpen && attention.length ? (
              <div className="mt-2 max-h-64 space-y-1 overflow-y-auto border-t border-ink-100 pt-2" data-testid="attention-links">
                {attention.map((link) => {
                  const meta = LINK_STATUS_META[link.live!.status];
                  const from = nodeById.get(link.from);
                  const to = nodeById.get(link.to);
                  const title =
                    link.label ||
                    `${from?.label || from?.device?.name || from?.site?.name || 'گره'} ↔ ${to?.label || to?.device?.name || to?.site?.name || 'گره'}`;
                  return (
                    <button
                      key={link.id}
                      type="button"
                      className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-right text-[10.5px] hover:border-ink-200 hover:bg-ink-50"
                      onClick={() => {
                        setSelectedNodeIds([]);
                        setSelectedLinkIds([link.id]);
                        setInspectorOpen(true);
                        const anchor = from ?? to;
                        if (anchor) canvasRef.current?.focusNode(anchor.id);
                      }}
                    >
                      <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
                      <span className="min-w-0 flex-1 truncate font-medium text-ink-700">{title}</span>
                      <span className={`shrink-0 rounded-pill px-1.5 py-0.5 ${meta.soft} ${meta.text}`}>{meta.label}</span>
                      <span className="num shrink-0 text-ink-500">
                        {fmtBandwidth(link.live?.capacityMbps)} · {fmtUtil(link.live?.utilPct)} · {fmtLatency(link.live?.latencyMs)} · افت {fmtLoss(link.live?.lossPct)}
                      </span>
                      <span className="min-w-0 basis-full truncate text-[10px] text-ink-400">{link.live?.reason}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </Card>

          <div className={`grid gap-3 ${fullscreen ? '' : 'lg:h-[calc(100dvh-300px)] lg:min-h-[560px] lg:grid-cols-[288px_minmax(0,1fr)]'}`}>
            {!fullscreen ? (
              <DevicePalette
                diagramId={diagramId}
                sites={overview.data?.sites ?? []}
                placedDeviceIds={new Set(nodes.map((n) => n.deviceId).filter((v): v is number => v != null))}
                placedSiteIds={new Set(nodes.map((n) => n.siteId).filter((v): v is number => v != null))}
                refreshToken={paletteRefresh}
                disabled={readOnly}
                onAddDevice={(item) => addDevice(item)}
                onAddSite={(site) => addSite(site)}
                onFocusNode={(nodeId) => {
                  setSelectedNodeIds([nodeId]);
                  setSelectedLinkIds([]);
                  canvasRef.current?.focusNode(nodeId);
                  setInspectorOpen(true);
                }}
                onManageSites={(siteId) => openSites(siteId)}
              />
            ) : null}

            <div className={fullscreen ? 'fixed inset-0 z-[1200] flex flex-col gap-2 bg-ink-100/95 p-3 backdrop-blur' : 'flex h-[560px] min-h-0 flex-col lg:h-full'}>
              <Card className="flex min-h-0 flex-1 flex-col overflow-hidden !p-0">
                <div className="flex flex-wrap items-center gap-1.5 border-b border-ink-100 bg-white/70 p-2">
                  <div className="flex items-center gap-1 rounded-soft border border-ink-200 bg-white p-0.5">
                    <button type="button" className="btn-ghost btn-xs !border-0 !px-2" onClick={undo} disabled={!canUndo || readOnly} title="واگرد (Ctrl+Z)" aria-label="واگرد">
                      <Undo2 size={14} />
                    </button>
                    <button type="button" className="btn-ghost btn-xs !border-0 !px-2" onClick={redo} disabled={!canRedo || readOnly} title="ازنو (Ctrl+Shift+Z)" aria-label="ازنو">
                      <Redo2 size={14} />
                    </button>
                  </div>

                  <span className="mx-0.5 h-5 w-px bg-ink-200" aria-hidden />

                  <button
                    type="button"
                    className={`btn-xs ${linkMode ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setLinkMode((v) => !v)}
                    disabled={readOnly}
                    title="افزودن لینک (L)"
                  >
                    <Link2 size={13} /> <span className="hidden sm:inline">افزودن لینک</span>
                  </button>
                  <button type="button" className="btn-ghost btn-xs" onClick={() => addCloudOrNote('note')} disabled={readOnly} title="افزودن یادداشت">
                    <StickyNote size={13} /> <span className="hidden xl:inline">یادداشت</span>
                  </button>
                  <button type="button" className="btn-ghost btn-xs" onClick={() => addCloudOrNote('cloud')} disabled={readOnly} title="افزودن ابر / WAN">
                    <Cloud size={13} /> <span className="hidden xl:inline">ابر</span>
                  </button>

                  <span className="mx-0.5 h-5 w-px bg-ink-200" aria-hidden />

                  <select
                    className="field !w-auto !py-1 text-[11px]"
                    value={diagram.layout}
                    onChange={(event) => applyLayout(event.target.value)}
                    disabled={readOnly || !nodes.length}
                    title="چیدمان خودکار"
                    aria-label="چیدمان خودکار"
                  >
                    <option value="hierarchy-tb">سلسله‌مراتبی عمودی</option>
                    <option value="hierarchy-lr">سلسله‌مراتبی افقی</option>
                    <option value="grid">شبکهٔ منظم</option>
                    <option value="radial">دایرهٔ مرکزی</option>
                  </select>
                  <button type="button" className="btn-ghost btn-xs" onClick={() => applyLayout()} disabled={readOnly || !nodes.length} title="اعمال چیدمان خودکار">
                    <RefreshCw size={13} /> <span className="hidden lg:inline">چیدمان</span>
                  </button>

                  <div className="ms-auto flex min-w-[130px] flex-1 items-center sm:max-w-[230px]">
                    <div className="relative w-full">
                      <Search size={13} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
                      <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="جست‌وجوی گره، IP یا یادداشت…"
                        className="field !py-1.5 pr-8 text-[11.5px]"
                        aria-label="جست‌وجو در دیاگرام"
                      />
                    </div>
                  </div>

                  <button
                    type="button"
                    className={`btn-ghost btn-xs ${inspectorOpen ? '!bg-brand-50 !text-brand-700' : ''}`}
                    onClick={() => setInspectorOpen((v) => !v)}
                    title="پنل تنظیمات و جزئیات"
                    aria-label="پنل تنظیمات و جزئیات"
                  >
                    <Settings2 size={14} />
                  </button>

                  <button type="button" className="btn-ghost btn-xs" onClick={() => setExportOpen(true)} title="خروجی" aria-label="خروجی">
                    <Download size={14} />
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 border-b border-ink-100 bg-white/45 px-2 py-1">
                  <span className="text-[10px] font-medium text-ink-400">وضعیت</span>
                  <div className="flex items-center gap-0.5 rounded-soft border border-ink-200 bg-white p-0.5">
                    {statusOptions.map((option) => {
                      const active = statuses.includes(option.value);
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() =>
                            setStatuses((prev) => (prev.includes(option.value) ? prev.filter((s) => s !== option.value) : [...prev, option.value]))
                          }
                          className={`inline-flex items-center gap-1 rounded-lg px-1.5 py-1 text-[10px] transition ${
                            active ? 'bg-ink-100 font-medium text-ink-700' : 'text-ink-500 hover:bg-ink-50'
                          }`}
                          title={`فیلتر ${option.label}`}
                        >
                          <span className={`h-1.5 w-1.5 rounded-full ${option.dot}`} />
                          <span className="num">{faDigits(option.count)}</span>
                        </button>
                      );
                    })}
                  </div>

                  <select
                    value={groupFilter ?? ''}
                    onChange={(event) => setGroupFilter(event.target.value ? Number(event.target.value) : null)}
                    className="field !w-auto !py-0.5 text-[10.5px]"
                    aria-label="فیلتر گروه"
                  >
                    <option value="">همه گروه‌ها</option>
                    {groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>

                  {filterActive ? (
                    <button
                      type="button"
                      className={`btn-xs ${onlyMatches ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => setOnlyMatches((v) => !v)}
                      title={onlyMatches ? 'نمایش همهٔ گره‌ها' : 'نمایش فقط نتیجه‌های جست‌وجو'}
                    >
                      {onlyMatches ? <EyeOff size={13} /> : <Eye size={13} />}
                      <span className="num text-[10px]">{faDigits(matchCount)}</span>
                    </button>
                  ) : (
                    <span className="text-[10px] text-ink-400">
                      {faDigits(nodes.length)} گره · {faDigits(links.length)} لینک · Shift+کلیک = انتخاب چندگانه
                    </span>
                  )}
                </div>

                <div className="relative min-h-0 flex-1">
                  <DiagramCanvas
                    ref={canvasRef}
                    nodes={displayNodes}
                    links={displayLinks}
                    settings={settings}
                    selectedNodeIds={selectedNodeIds}
                    selectedLinkIds={selectedLinkIds}
                    readOnly={readOnly}
                    linkMode={linkMode}
                    activeIds={activeIds}
                    overlay={overlay}
                    fitToken={fitToken}
                    onSelectionChange={onSelectionChange}
                    onMoveStart={pushHistory}
                    onMove={moveNodes}
                    onCreateLink={createLink}
                    onDropDevice={(deviceId, x, y) => {
                      void api.topologyCatalog({ id: deviceId, limit: 1 }).then((res) => {
                        const found = res.items[0];
                        if (found) addDevice(found, { x, y });
                      });
                    }}
                    onDropSite={(siteId, x, y) => {
                      const site = (overview.data?.sites ?? []).find((s) => s.id === siteId);
                      if (site) addSite(site, { x, y });
                    }}
                    onViewportChange={onViewportChange}
                    onToggleFullscreen={toggleFullscreen}
                  />
                  {analysisOpen ? (
                    <AnalysisPanel
                      analysis={analysis}
                      loading={analysisLoading}
                      error={analysisError}
                      impact={impact}
                      impactLoading={impactLoading}
                      nodeById={nodeById}
                      selectedNodeIds={selectedNodeIds}
                      readOnly={readOnly}
                      activeGroupName={activeGroupName}
                      savingPaths={savingPaths}
                      onClose={() => setAnalysisOpen(false)}
                      onRefresh={() => {
                        if (diagramId) void loadAnalysis(diagramId);
                      }}
                      onSimulateLink={(id) => void runImpact({ linkId: id })}
                      onSimulateNode={(id) => void runImpact({ nodeId: id })}
                      onClearImpact={() => setImpact(null)}
                      onShowGroup={(name) => {
                        if (!name) dismissedGroupRef.current = activeGroupName;
                        else dismissedGroupRef.current = '';
                        setActiveGroupName(name);
                      }}
                      onSavePaths={savePaths}
                    />
                  ) : null}
                  {inspectorOpen && diagramView ? (
                    <Inspector
                      selectedNodes={selectedNodes}
                      selectedLinks={selectedLinks}
                      nodeById={nodeById}
                      diagram={diagramView}
                      readOnly={readOnly}
                      onClose={() => setInspectorOpen(false)}
                      onChangeNode={updateNode}
                      onChangeLink={updateLink}
                      onDeleteSelection={deleteSelection}
                      onDuplicateSelection={() => duplicateSelection()}
                      onReorderNode={reorderNode}
                      onReverseLink={reverseLink}
                      onDiagramChange={updateDiagramMeta}
                      onManageSite={(siteId) => openSites(siteId)}
                      diagramNodes={nodes}
                      onPollTelemetry={() => void pollTelemetry()}
                      pollingTelemetry={telemetryPolling}
                    />
                  ) : null}
                  {readOnly && diagram.locked ? (
                    <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-1.5 rounded-pill border border-amber-200 bg-amber-50/95 px-2.5 py-1 text-[10.5px] text-amber-700 shadow-soft">
                      <Lock size={11} /> دیاگرام قفل است
                    </div>
                  ) : null}
                  {!canWrite && !diagram.locked ? (
                    <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-1.5 rounded-pill border border-ink-200 bg-white/95 px-2.5 py-1 text-[10.5px] text-ink-500 shadow-soft">
                      <Eye size={11} /> دسترسی فقط‌خواندنی
                    </div>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 bg-white/70 px-3 py-1.5 text-[10.5px] text-ink-500">
                  <span className="inline-flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> <span className="num">{faDigits(stats.online)}</span> در دسترس
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-red-500" /> <span className="num">{faDigits(stats.offline)}</span> قطع
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> <span className="num">{faDigits(stats.warning)}</span> اختلال
                  </span>
                  {stats.placeholders ? (
                    <span className="inline-flex items-center gap-1 text-red-500">
                      <AlertTriangle size={10} /> <span className="num">{faDigits(stats.placeholders)}</span> مرجع حذف‌شده
                    </span>
                  ) : null}
                  <span className="mx-1 h-4 w-px bg-ink-200" aria-hidden />
                  <span className="text-[10px] text-ink-400">لینک:</span>
                  {(['up', 'degraded', 'down', 'unknown'] as const).map((status) => (
                    <span key={status} className="inline-flex items-center gap-1" title={LINK_STATUS_META[status].label}>
                      <span className={`h-1.5 w-1.5 rounded-full ${LINK_STATUS_META[status].dot}`} />
                      <span className="num">{faDigits(linkStats[status])}</span>
                    </span>
                  ))}
                  {selectedNodeIds.length || selectedLinkIds.length ? (
                    <span className="ms-auto inline-flex items-center gap-1.5">
                      <span className="num">{faDigits(selectedNodeIds.length)}</span> گره و <span className="num">{faDigits(selectedLinkIds.length)}</span> لینک انتخاب‌شده
                      <button type="button" className="text-brand-600 hover:underline" onClick={copySelection} disabled={!selectedNodeIds.length}>
                        کپی
                      </button>
                      <button type="button" className="text-brand-600 hover:underline" onClick={() => duplicateSelection()} disabled={readOnly}>
                        تکثیر
                      </button>
                      <button type="button" className="text-red-600 hover:underline" onClick={deleteSelection} disabled={readOnly}>
                        حذف
                      </button>
                    </span>
                  ) : (
                    <span className="ms-auto hidden items-center gap-1 sm:inline-flex">
                      <span>ذخیره در پایگاه‌دادهٔ محلی</span> · <span className="num">{faDigits(revision)}</span> نسخه
                    </span>
                  )}
                </div>
              </Card>
            </div>
          </div>
        </>
      ) : null}

      {/* --------------------------- پنجره‌ها --------------------------- */}
      <NewDiagramDialog
        open={newOpen}
        onClose={() => {
          setNewOpen(false);
          setDialogError('');
        }}
        onCreated={(created) => {
          applyLoaded(created);
          setNewOpen(false);
          overview.refresh();
          push('دیاگرام تازه ساخته شد.', 'success');
        }}
        templates={overview.data?.templates ?? []}
        busy={newBusy || loading}
        error={dialogError}
        onCreate={async (body) => {
          try {
            return await createDiagram(body);
          } catch {
            return null;
          }
        }}
      />

      <SitesDialog open={sitesOpen} sites={overview.data?.sites ?? []} focusSiteId={siteFocus} onClose={() => setSitesOpen(false)} onChanged={(siteId) => void onSitesChanged(siteId)} />

      <TemplatesDialog
        open={templatesOpen}
        templates={overview.data?.templates ?? []}
        busyId={busyAction.startsWith('template-') ? Number(busyAction.split('-')[1]) : null}
        onClose={() => setTemplatesOpen(false)}
        onUse={(template) => void useTemplate(template)}
        onDelete={(template) => void deleteTemplate(template)}
      />

      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        onExportSvg={exportSvg}
        onExportPng={() => void exportPng()}
        onExportJson={() => {
          exportJson();
          setExportOpen(false);
        }}
        busy={exportBusy}
        nodeCount={nodes.length}
      />

      <RenameDialog
        open={renameMode !== null}
        title={renameMode === 'template' ? 'ذخیره به‌عنوان الگو' : 'تکثیر دیاگرام'}
        label="نام"
        initial={renameMode === 'template' ? `${diagram?.name || 'دیاگرام'} (الگو)` : `${diagram?.name || 'دیاگرام'} (کپی)`}
        confirmLabel={renameMode === 'template' ? 'ذخیرهٔ الگو' : 'ساخت تکثیر'}
        busy={actionBusy}
        onClose={() => setRenameMode(null)}
        onConfirm={(name) => {
          if (renameMode === 'template') void saveAsTemplate(name);
          else void duplicateDiagram(name);
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        title="حذف دیاگرام"
        message={`دیاگرام «${diagram?.name || ''}» و همهٔ گره‌ها، لینک‌ها و یادداشت‌های آن حذف می‌شود. تجهیزات و داده‌های مانیتورینگ دست‌نخورده می‌مانند. این عملیات قابل بازگشت نیست.`}
        confirmLabel="حذف دیاگرام"
        busy={actionBusy}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void deleteDiagram()}
      />
    </div>
  );
}

