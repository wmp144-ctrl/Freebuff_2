/**
 * توپولوژی شبکه — مرحله ۲: CRUD پایدار روی سرور
 * ----------------------------------------------------------------
 *   • نمای سراسری: شهرها و ارتباط‌های بین‌شهری
 *   • نمای شهر: مراکز تجمع و ایستگاه‌ها
 *   • نمای جزئیات: تجهیزات و شبکهٔ داخلی یک مرکز/ایستگاه
 *
 * همهٔ داده‌ها از `/api/topology/hierarchy` خوانده و با همان API نوشته
 * می‌شوند؛ هیچ تغییر محلی به‌عنوان «ذخیره‌شده» نمایش داده نمی‌شود. موقعیت
 * گره‌ها پس از کشیدن ذخیره می‌شود و در بارگذاری بعدی بازمی‌گردد.
 *
 * دادهٔ نمونه فقط در سرور توسعه (یا با پرچم صریح) و تنها روی پایگاه‌دادهٔ
 * خالی و با کلیک کاربر بارگذاری می‌شود؛ برچسب «دادهٔ نمونه» همیشه دیده
 * می‌شود تا با دادهٔ واقعی اشتباه نشود.
 */
import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { MarkerType, ReactFlowProvider } from '@xyflow/react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  Database,
  Eye,
  EyeOff,
  Filter,
  Keyboard,
  LayoutGrid,
  Link2,
  ListTree,
  Loader2,
  Maximize2,
  MousePointer2,
  Network,
  PencilRuler,
  Plus,
  Redo2,
  RefreshCw,
  Search,
  Undo2,
  X,
} from 'lucide-react';
import { Badge, Card, EmptyState, ErrorState, Modal, PageLoader, Spinner } from '../components/ui';
import { useAuth } from '../lib/auth';
import { ApiError, api, isAbortError } from '../lib/api';
import { faDigits } from '../lib/format';
import type { DeviceStatus, HierarchyPayload } from '../lib/types';
import {
  KIND_META,
  LEVEL_META,
  MEDIA_META,
  MEDIUM_ORDER,
  ancestorsOf,
  applyTopologyFilters,
  breadcrumbFor,
  connectionBodyFromModel,
  countDescendants,
  datasetFromPayload,
  drillScope,
  edgesForScope,
  entityKindOf,
  indexNodes,
  isDrillable,
  layoutScope,
  nodeBodyFromModel,
  nodeFromApi,
  nodesForScope,
  scopeAnchor,
  scopeStats,
  searchTopology,
  subtreeSnapshot,
  topologyFiltersActive,
  type EntityKindFilter,
  type Point,
  type TopologyDataset,
  type TopologyEdgeModel,
  type TopologyFilters,
  type TopologyNodeKind,
  type TopologyNodeModel,
  type TopologyScope,
  type TransmissionMedium,
} from '../lib/topology-hierarchy';
import { EditHistory, type EditCommand } from '../lib/topology-edits';
import { KIND_ICONS, type HierarchyFlowNode } from '../features/topology-hierarchy/HierarchyNode';
import type { MediumFlowEdge } from '../features/topology-hierarchy/MediumEdge';
import HierarchyCanvas from '../features/topology-hierarchy/HierarchyCanvas';
import NetworkTree from '../features/topology-hierarchy/NetworkTree';
import HierarchyInspector from '../features/topology-hierarchy/HierarchyInspector';
import { CreateConnectionDialog, CreateNodeDialog } from '../features/topology-hierarchy/HierarchyForms';

/** دامنه‌ای که یک گره در آن دیده می‌شود (برای پرش از جست‌وجو یا پس از ساخت) */
function scopeForNode(node: TopologyNodeModel): TopologyScope {
  if (node.kind === 'city') return { level: 'city', cityId: node.id };
  if (node.kind === 'aggregation' || node.kind === 'station') return { level: 'detail', parentId: node.id };
  if (node.parentId) return { level: 'detail', parentId: node.parentId };
  return { level: 'global' };
}

/** دامنه‌ای که یک لینک در آن دیده می‌شود (برای پرش از نتیجهٔ جست‌وجو) */
function scopeForEdge(edge: TopologyEdgeModel, index: Map<string, TopologyNodeModel>): TopologyScope {
  const source = index.get(edge.source);
  const target = index.get(edge.target);
  if (source?.kind === 'city' && target?.kind === 'city') return { level: 'global' };
  const preferred = source && source.kind !== 'city' ? source : (target && target.kind !== 'city' ? target : source ?? target);
  return preferred ? scopeForNode(preferred) : { level: 'global' };
}

/** فقط فیلدهای فرم گره — Undo نباید موقعیت/والد/فراداده را بازنویسی کند */
function nodeEditableBody(node: TopologyNodeModel): Record<string, unknown> {
  return {
    name: node.name,
    description: node.description ?? '',
    notes: node.notes ?? '',
    location: node.location ?? '',
    ip: node.ip ?? '',
    deviceType: node.deviceType ?? '',
    vendor: node.vendor ?? '',
    model: node.model ?? '',
    ports: node.ports ?? null,
    status: node.status ?? 'unknown',
    ownerGroupId: node.ownerGroupId ?? null,
  };
}

/** فقط فیلدهای فرم لینک — دو سر لینک و شناسه دست‌نخورده می‌مانند */
function edgeEditableBody(edge: TopologyEdgeModel): Record<string, unknown> {
  return {
    medium: edge.medium,
    capacityMbps: edge.capacityMbps ?? null,
    latencyMs: edge.latencyMs ?? null,
    sourcePort: edge.sourcePort ?? '',
    targetPort: edge.targetPort ?? '',
    role: edge.role ?? 'primary',
    label: edge.label ?? '',
    description: edge.description ?? '',
    notes: edge.notes ?? '',
    state: edge.state ?? 'unknown',
  };
}

function sameBody(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
  return true;
}

const KIND_FILTER_OPTIONS: { value: EntityKindFilter; label: string }[] = [
  { value: 'city', label: 'شهر' },
  { value: 'aggregation', label: 'مرکز تجمع' },
  { value: 'station', label: 'ایستگاه' },
  { value: 'device', label: 'تجهیز' },
];

const STATUS_FILTER_OPTIONS: { value: DeviceStatus; label: string }[] = [
  { value: 'online', label: 'سالم' },
  { value: 'warning', label: 'هشدار' },
  { value: 'offline', label: 'قطع' },
  { value: 'maintenance', label: 'تعمیرات' },
  { value: 'unknown', label: 'نامشخص' },
];

const ROLE_FILTER_OPTIONS: { value: 'primary' | 'backup'; label: string }[] = [
  { value: 'primary', label: 'اصلی' },
  { value: 'backup', label: 'پشتیبان' },
];

function FilterChip({
  active,
  label,
  onClick,
  title,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  title?: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title ?? label}
      className={`inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-[10.5px] transition ${
        active
          ? 'border-brand-300 bg-brand-50 font-medium text-brand-700'
          : 'border-ink-200 bg-white text-ink-500 hover:border-ink-300 hover:text-ink-700'
      }`}
    >
      {children}
      {label}
    </button>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <span className="shrink-0 text-[10px] text-ink-400">{label}:</span>
      {children}
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'عملیات ناموفق بود. دوباره تلاش کنید.';
}

type ModalState = { type: 'node' } | { type: 'edge'; sourceId: string | null } | null;
type ConfirmState = { kind: 'node' | 'edge'; id: string; name: string; detail: string } | null;
type Flash = { tone: 'ok' | 'error'; text: string } | null;

function ModeSwitch({
  edit,
  canEdit,
  onChange,
}: {
  edit: boolean;
  canEdit: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-pill border border-ink-200 bg-white/80 p-0.5"
      role="group"
      aria-label="حالت نمایش یا ویرایش"
    >
      <button
        type="button"
        onClick={() => onChange(false)}
        aria-pressed={!edit}
        className={`inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-[11px] font-medium transition ${
          !edit ? 'bg-white text-ink-800 shadow-soft' : 'text-ink-500 hover:text-ink-700'
        }`}
      >
        <MousePointer2 size={12} />
        نمایش
      </button>
      <button
        type="button"
        onClick={() => onChange(true)}
        disabled={!canEdit}
        aria-pressed={edit}
        title={canEdit ? 'ویرایش و ذخیره در سرور' : 'برای ویرایش، مجوز topology:write لازم است'}
        className={`inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-50 ${
          edit ? 'bg-white text-ink-800 shadow-soft' : 'text-ink-500 hover:text-ink-700'
        }`}
      >
        <PencilRuler size={12} />
        ویرایش
      </button>
    </div>
  );
}

/** ساخت بارِ نمونه برای بارگذاری صریح در حالت توسعه */
async function buildDemoSeed() {
  const { buildSampleTopology } = await import('../lib/topology-sample');
  const sample = buildSampleTopology();
  return {
    nodes: sample.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      name: node.name,
      parentId: node.parentId ?? undefined,
      ip: node.ip ?? '',
      deviceType: node.deviceType ?? '',
      vendor: node.vendor ?? '',
      model: node.model ?? '',
      location: node.location ?? '',
      status: node.status ?? 'unknown',
      meta: node.meta ?? {},
    })),
    connections: sample.edges.map((edge) => ({
      id: edge.id,
      sourceId: edge.source,
      targetId: edge.target,
      medium: edge.medium,
      capacityMbps: edge.capacityMbps ?? null,
      latencyMs: edge.latencyMs ?? null,
      label: edge.label ?? '',
      state: edge.state ?? 'up',
      role: edge.role ?? 'primary',
    })),
  };
}

export default function TopologyHierarchy() {
  const { can } = useAuth();
  const canWrite = can('topology:write');

  const [payload, setPayload] = useState<HierarchyPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  const [scope, setScope] = useState<TopologyScope>({ level: 'global' });
  const [selected, setSelected] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [edit, setEdit] = useState(false);
  const [treeOpen, setTreeOpen] = useState(() => (typeof window === 'undefined' ? true : window.innerWidth >= 1280));
  const [fitToken, setFitToken] = useState(0);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);

  const [modal, setModal] = useState<ModalState>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [flash, setFlash] = useState<Flash>(null);
  const [dirty, setDirty] = useState(false);
  const [positionState, setPositionState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [positionError, setPositionError] = useState('');

  /* مرحلهٔ ۳: فیلترها، تاریخچهٔ ویرایش و میان‌برها */
  const [kinds, setKinds] = useState<EntityKindFilter[]>([]);
  const [media, setMedia] = useState<TransmissionMedium[]>([]);
  const [statuses, setStatuses] = useState<DeviceStatus[]>([]);
  const [roles, setRoles] = useState<('primary' | 'backup')[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [searchIndex, setSearchIndex] = useState(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [formResetToken, setFormResetToken] = useState(0);
  const [staleNotice, setStaleNotice] = useState('');

  const dirtyRef = useRef(false);
  const busyRef = useRef(false);
  const pendingLayouts = useRef(0);
  const historyRef = useRef(new EditHistory(40));
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), 5000);
    return () => window.clearTimeout(timer);
  }, [flash]);

  /* ---------------- بارگذاری داده از سرور ---------------- */
  const loadPayload = useCallback(async (mode: 'initial' | 'quiet' = 'quiet') => {
    if (mode === 'initial') {
      setLoading(true);
      setLoadError('');
    }
    try {
      const data = await api.topologyHierarchy();
      setPayload(data);
      setLoadError('');
    } catch (error) {
      if (!isAbortError(error)) setLoadError(errorMessage(error));
    } finally {
      if (mode === 'initial') setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPayload('initial');
  }, [loadPayload, reloadToken]);

  // اگر گرهٔ دامنهٔ جاری (مثلاً پس از حذف) وجود نداشته باشد، به نمای سراسری برگرد
  useEffect(() => {
    if (!payload || scope.level === 'global') return;
    const id = scope.level === 'city' ? scope.cityId : scope.parentId;
    if (!payload.nodes.some((node) => node.id === id)) {
      setScope({ level: 'global' });
      setSelected(null);
    }
  }, [payload, scope]);

  // هشدار مرورگر برای تغییرات ذخیره‌نشدهٔ فرم
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const dataset: TopologyDataset = useMemo(
    () => (payload ? datasetFromPayload(payload) : { nodes: [], edges: [], source: 'live' }),
    [payload]
  );
  const groups = payload?.groups ?? [];

  const index = useMemo(() => indexNodes(dataset.nodes), [dataset]);
  const visibleNodes = useMemo(() => nodesForScope(dataset.nodes, scope), [dataset, scope]);
  const anchorId = scopeAnchor(scope);
  const anchorNode = anchorId ? (index.get(anchorId) ?? null) : null;
  const graphNodes = useMemo(() => {
    if (!anchorNode) return visibleNodes;
    return visibleNodes.some((n) => n.id === anchorNode.id) ? visibleNodes : [anchorNode, ...visibleNodes];
  }, [visibleNodes, anchorNode]);
  const graphEdges = useMemo(
    () => edgesForScope(dataset.nodes, dataset.edges, scope),
    [dataset, scope]
  );

  const generatedLayout = useMemo(
    () => layoutScope(graphNodes, graphEdges, scope.level),
    [graphNodes, graphEdges, scope.level]
  );
  const positions = useMemo(() => {
    const out: Record<string, Point> = {};
    for (const node of graphNodes) {
      if (node.x || node.y) out[node.id] = { x: node.x ?? 0, y: node.y ?? 0 };
      else out[node.id] = generatedLayout[node.id] ?? { x: 0, y: 0 };
    }
    return out;
  }, [graphNodes, generatedLayout]);

  const stats = useMemo(() => scopeStats(visibleNodes, graphEdges), [visibleNodes, graphEdges]);
  const trimmedQuery = query.trim();
  const deferredQuery = useDeferredValue(query);

  const filters = useMemo<TopologyFilters>(
    () => ({ query: deferredQuery.trim(), kinds, media, statuses, roles }),
    [deferredQuery, kinds, media, statuses, roles]
  );
  const filterActive = topologyFiltersActive(filters);
  const activeFilterCount = kinds.length + media.length + statuses.length + roles.length;
  const filterResult = useMemo(
    () => applyTopologyFilters(dataset.nodes, dataset.edges, filters, index),
    [dataset, filters, index]
  );
  const filterCount = useMemo(() => {
    if (!filterActive) return { nodes: 0, edges: 0 };
    const nodeIds = filterResult.nodeIds;
    return {
      nodes: graphNodes.filter((node) => nodeIds.has(node.id)).length,
      edges: graphEdges.filter((edge) => filterResult.edgeIds.has(edge.id)).length,
    };
  }, [filterActive, filterResult, graphNodes, graphEdges]);

  /** آخرین دادهٔ بارگذاری‌شده برای گارد Undo و پرش از نتیجهٔ جست‌وجو */
  const datasetRef = useRef(dataset);
  datasetRef.current = dataset;

  const selectedNode = selected?.kind === 'node' ? (index.get(selected.id) ?? null) : null;
  const selectedEdge = useMemo(
    () => (selected?.kind === 'edge' ? (dataset.edges.find((e) => e.id === selected.id) ?? null) : null),
    [selected, dataset]
  );

  const focus = useMemo(() => (focusId ? { id: focusId, token: focusTick } : null), [focusId, focusTick]);
  const crumbs = useMemo(() => breadcrumbFor(index, scope), [index, scope]);
  const scopeNode = scope.level === 'global' ? null : index.get(scope.level === 'city' ? scope.cityId : scope.parentId);
  const scopeTitle = scopeNode?.name ?? 'کل شبکه';
  const scopeHint = LEVEL_META[scope.level].hint;

  const searchHits = useMemo(
    () => searchTopology(dataset.nodes, dataset.edges, index, trimmedQuery, 12),
    [dataset, index, trimmedQuery]
  );

  const pathOf = useCallback(
    (node: TopologyNodeModel) =>
      [...ancestorsOf(index, node.id)]
        .reverse()
        .map((n) => n.name)
        .join(' › '),
    [index]
  );

  /** فهرست یکتای نتیجه‌ها برای پیمایش با کلیدهای بالا/پایین */
  const resultItems = useMemo(
    () => [
      ...searchHits.nodes.map((node) => ({
        key: `node:${node.id}`,
        type: 'node' as const,
        id: node.id,
        title: node.name,
        subtitle: pathOf(node) || 'کل شبکه',
        tag: KIND_META[node.kind].label,
        icon: KIND_ICONS[node.kind] ?? KIND_ICONS.other,
      })),
      ...searchHits.edges.map((edge) => ({
        key: `edge:${edge.id}`,
        type: 'edge' as const,
        id: edge.id,
        title: edge.label || 'لینک بدون برچسب',
        subtitle: `${index.get(edge.source)?.name ?? edge.source} ↔ ${index.get(edge.target)?.name ?? edge.target}`,
        tag: MEDIA_META[edge.medium].label,
        icon: Link2,
      })),
    ],
    [searchHits, pathOf, index]
  );

  useEffect(() => {
    setSearchIndex(0);
  }, [trimmedQuery]);

  /* ---------------- محافظت از تغییرات ذخیره‌نشده ---------------- */
  const confirmDiscard = useCallback(() => {
    if (!dirtyRef.current) return true;
    return window.confirm('تغییرات ذخیره‌نشده از بین می‌رود. ادامه می‌دهید؟');
  }, []);

  const goScope = useCallback(
    (next: TopologyScope) => {
      if (!confirmDiscard()) return;
      setScope(next);
      setSelected(null);
      setFormError('');
      setFitToken((t) => t + 1);
    },
    [confirmDiscard]
  );

  const selectNode = useCallback(
    (id: string) => {
      if (!confirmDiscard()) return;
      setSelected({ kind: 'node', id });
      setFormError('');
    },
    [confirmDiscard]
  );

  const selectEdge = useCallback(
    (id: string) => {
      if (!confirmDiscard()) return;
      setSelected({ kind: 'edge', id });
      setFormError('');
    },
    [confirmDiscard]
  );

  const drillToNode = useCallback(
    (id: string) => {
      if (!confirmDiscard()) return;
      const node = index.get(id);
      if (!node) return;
      const next = drillScope(node);
      if (!next) return;
      setScope(next);
      setSelected({ kind: 'node', id });
      setFormError('');
      setFitToken((t) => t + 1);
    },
    [index, confirmDiscard]
  );

  const jumpToNode = useCallback(
    (id: string) => {
      if (!confirmDiscard()) return;
      const node = index.get(id);
      if (!node) return;
      setScope(scopeForNode(node));
      setSelected({ kind: 'node', id });
      setFocusId(id);
      setFocusTick((t) => t + 1);
      setSearchOpen(false);
      setFormError('');
    },
    [index, confirmDiscard]
  );

  const jumpToEdge = useCallback(
    (id: string) => {
      if (!confirmDiscard()) return;
      const edge = datasetRef.current.edges.find((item) => item.id === id);
      if (!edge) return;
      setScope(scopeForEdge(edge, index));
      setSelected({ kind: 'edge', id });
      setFocusId(edge.source);
      setFocusTick((t) => t + 1);
      setSearchOpen(false);
      setFormError('');
    },
    [index, confirmDiscard]
  );

  const handleTreeSelect = useCallback(
    (node: TopologyNodeModel) => {
      if (isDrillable(node)) drillToNode(node.id);
      else jumpToNode(node.id);
    },
    [drillToNode, jumpToNode]
  );

  /* ---------------- Undo/Redo ---------------- */

  const pushEdit = useCallback((command: EditCommand) => {
    historyRef.current.push(command);
    setHistoryVersion((v) => v + 1);
  }, []);

  const runHistory = useCallback(
    async (direction: 'undo' | 'redo') => {
      if (!canWrite || !edit || busyRef.current) return;
      if (
        dirtyRef.current &&
        !window.confirm('تغییرات ذخیره‌نشدهٔ فرم از بین می‌رود. ادامه می‌دهید؟')
      ) {
        return;
      }
      setUndoBusy(true);
      setFlash(null);
      try {
        const label =
          direction === 'undo' ? await historyRef.current.undo() : await historyRef.current.redo();
        await loadPayload('quiet');
        setDirty(false);
        dirtyRef.current = false;
        setFormResetToken((token) => token + 1);
        setStaleNotice('');
        setFlash({ tone: 'ok', text: `${direction === 'undo' ? 'واگرد' : 'ازنو'}: ${label}` });
      } catch (error) {
        setFlash({
          tone: 'error',
          text: `${direction === 'undo' ? 'واگرد' : 'ازنو'} انجام نشد: ${errorMessage(error)}`,
        });
        if (error instanceof ApiError && error.details?.code === 'stale') {
          setStaleNotice(error.message);
          await loadPayload('quiet');
        }
      } finally {
        setUndoBusy(false);
        setHistoryVersion((v) => v + 1);
      }
    },
    [canWrite, edit, loadPayload]
  );

  void historyVersion;
  const canUndo = canWrite && edit && historyRef.current.canUndo;
  const canRedo = canWrite && edit && historyRef.current.canRedo;
  const undoLabel = historyRef.current.undoLabel;
  const redoLabel = historyRef.current.redoLabel;

  const handleModeChange = useCallback(
    (next: boolean) => {
      if (!next && !confirmDiscard()) return;
      setEdit(next);
      setFormError('');
    },
    [confirmDiscard]
  );

  /* ---------------- میان‌برهای صفحه‌کلید ---------------- */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && !typing && key === 'z') {
        event.preventDefault();
        void runHistory(event.shiftKey ? 'redo' : 'undo');
        return;
      }
      if (mod && !typing && key === 'y') {
        event.preventDefault();
        void runHistory('redo');
        return;
      }
      if (mod && key === 'k') {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (typing) return;
      if (event.key === '/') {
        event.preventDefault();
        searchInputRef.current?.focus();
      } else if (event.key === '?') {
        event.preventDefault();
        setShortcutsOpen(true);
      } else if (key === 'f') {
        setFitToken((t) => t + 1);
      } else if (event.key === 'Escape') {
        setShortcutsOpen(false);
        setFilterOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runHistory]);

  /* ---------------- ذخیرهٔ موقعیت ---------------- */
  const persistPositions = useCallback(
    async (items: { id: string; x: number; y: number }[]): Promise<boolean> => {
      if (!items.length) return true;
      pendingLayouts.current += 1;
      setPositionState('saving');
      setPositionError('');
      let failed = false;
      try {
        await api.saveHierarchyLayout(items);
      } catch (error) {
        failed = true;
        if (!isAbortError(error)) setPositionError(errorMessage(error));
      } finally {
        pendingLayouts.current = Math.max(0, pendingLayouts.current - 1);
        if (pendingLayouts.current === 0) setPositionState(failed ? 'error' : 'saved');
      }
      return !failed;
    },
    []
  );

  const applyLocalPositions = useCallback((items: { id: string; x: number; y: number }[]) => {
    if (!items.length) return;
    const byId = new Map(items.map((item) => [item.id, item]));
    setPayload((prev) =>
      prev
        ? {
            ...prev,
            nodes: prev.nodes.map((node) => {
              const position = byId.get(node.id);
              return position ? { ...node, x: position.x, y: position.y } : node;
            }),
          }
        : prev
    );
  }, []);

  const handleDragStop = useCallback(
    (id: string, position: Point) => {
      if (!canWrite) return;
      const node = datasetRef.current.nodes.find((item) => item.id === id);
      const before = { x: node?.x ?? 0, y: node?.y ?? 0 };
      applyLocalPositions([{ id, x: position.x, y: position.y }]);
      void persistPositions([{ id, x: position.x, y: position.y }]).then((ok) => {
        if (!ok || !node || (before.x === position.x && before.y === position.y)) return;
        pushEdit({
          label: `جابه‌جایی «${node.name}»`,
          undo: async () => {
            await api.saveHierarchyLayout([{ id, x: before.x, y: before.y }]);
          },
          redo: async () => {
            await api.saveHierarchyLayout([{ id, x: position.x, y: position.y }]);
          },
        });
      });
    },
    [applyLocalPositions, canWrite, persistPositions, pushEdit]
  );

  const relayout = useCallback(async () => {
    const before = graphNodes.map((node) => ({ id: node.id, x: positions[node.id]?.x ?? 0, y: positions[node.id]?.y ?? 0 }));
    const next = layoutScope(graphNodes, graphEdges, scope.level);
    const after = graphNodes.map((node) => ({
      id: node.id,
      x: next[node.id]?.x ?? 0,
      y: next[node.id]?.y ?? 0,
    }));
    applyLocalPositions(after);
    setFitToken((t) => t + 1);
    const ok = await persistPositions(after);
    if (!ok) return;
    pushEdit({
      label: 'چیدمان خودکار',
      undo: async () => {
        await api.saveHierarchyLayout(before);
      },
      redo: async () => {
        await api.saveHierarchyLayout(after);
      },
    });
  }, [applyLocalPositions, graphEdges, graphNodes, persistPositions, positions, pushEdit, scope.level]);

  /* ---------------- عملیات CRUD ---------------- */
  const createNode = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy('create-node');
    setDialogError('');
    try {
      const created = await api.createHierarchyNode(body);
      const model = nodeFromApi(created);
      const redoBody = {
        ...body,
        id: model.id,
        parentId: model.parentId ?? undefined,
        x: model.x ?? 0,
        y: model.y ?? 0,
      };
      pushEdit({
        label: `ساخت «${model.name}»`,
        undo: async () => {
          const current = datasetRef.current;
          const hasChildren = current.nodes.some((node) => node.parentId === model.id);
          const hasLinks = current.edges.some((edge) => edge.source === model.id || edge.target === model.id);
          if (hasChildren || hasLinks) {
            throw new Error('این گره اکنون زیرمجموعه یا لینک دارد؛ اول آن‌ها را حذف کنید.');
          }
          await api.deleteHierarchyNode(model.id);
        },
        redo: async () => {
          await api.createHierarchyNode(redoBody);
        },
      });
      await loadPayload('quiet');
      setModal(null);
      setScope(scopeForNode(model));
      setSelected({ kind: 'node', id: model.id });
      setFocusId(model.id);
      setFocusTick((t) => t + 1);
      setFlash({ tone: 'ok', text: `«${model.name}» ساخته شد.` });
      return true;
    } catch (error) {
      setDialogError(errorMessage(error));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }, [loadPayload, pushEdit]);

  const createConnection = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy('create-edge');
    setDialogError('');
    try {
      const created = await api.createHierarchyConnection(body);
      const redoBody = { ...body, id: created.id };
      pushEdit({
        label: 'ساخت لینک',
        undo: async () => {
          await api.deleteHierarchyConnection(created.id);
        },
        redo: async () => {
          await api.createHierarchyConnection(redoBody);
        },
      });
      await loadPayload('quiet');
      setModal(null);
      setSelected({ kind: 'edge', id: created.id });
      setFlash({ tone: 'ok', text: 'لینک ساخته شد.' });
      return true;
    } catch (error) {
      setDialogError(errorMessage(error));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }, [loadPayload, pushEdit]);

  const saveNode = useCallback(
    async (body: Record<string, unknown>): Promise<boolean> => {
      if (!selectedNode || busyRef.current) return false;
      const before = selectedNode;
      const beforeBody = nodeEditableBody(before);
      busyRef.current = true;
      setBusy('node');
      setFormError('');
      try {
        await api.updateHierarchyNode(before.id, body, before.updatedAt);
        if (!sameBody(beforeBody, body)) {
          pushEdit({
            label: `ویرایش «${before.name}»`,
            undo: async () => {
              await api.updateHierarchyNode(before.id, beforeBody);
            },
            redo: async () => {
              await api.updateHierarchyNode(before.id, body);
            },
          });
        }
        await loadPayload('quiet');
        setStaleNotice('');
        setDirty(false);
        setFlash({ tone: 'ok', text: 'تغییرات گره ذخیره شد.' });
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.details?.code === 'stale') {
          setStaleNotice(error.message);
          await loadPayload('quiet');
        }
        setFormError(errorMessage(error));
        return false;
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [selectedNode, loadPayload, pushEdit]
  );

  const saveEdge = useCallback(
    async (body: Record<string, unknown>): Promise<boolean> => {
      if (!selectedEdge || busyRef.current) return false;
      const before = selectedEdge;
      const beforeBody = edgeEditableBody(before);
      busyRef.current = true;
      setBusy('edge');
      setFormError('');
      try {
        await api.updateHierarchyConnection(before.id, body, before.updatedAt);
        if (!sameBody(beforeBody, body)) {
          pushEdit({
            label: `ویرایش لینک ${before.label || before.id.slice(0, 6)}`,
            undo: async () => {
              await api.updateHierarchyConnection(before.id, beforeBody);
            },
            redo: async () => {
              await api.updateHierarchyConnection(before.id, body);
            },
          });
        }
        await loadPayload('quiet');
        setStaleNotice('');
        setDirty(false);
        setFlash({ tone: 'ok', text: 'تغییرات لینک ذخیره شد.' });
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.details?.code === 'stale') {
          setStaleNotice(error.message);
          await loadPayload('quiet');
        }
        setFormError(errorMessage(error));
        return false;
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [selectedEdge, loadPayload, pushEdit]
  );

  const requestDeleteNode = useCallback(() => {
    if (!selectedNode) return;
    const impacted = dataset.edges.filter(
      (edge) => edge.source === selectedNode.id || edge.target === selectedNode.id
    ).length;
    const children = countDescendants(dataset.nodes, selectedNode.id);
    setConfirm({
      kind: 'node',
      id: selectedNode.id,
      name: selectedNode.name,
      detail:
        children > 0 || impacted > 0
          ? `${faDigits(children)} زیرمجموعه و ${faDigits(impacted)} لینک نیز حذف می‌شوند. این کار برگشت‌پذیر نیست.`
          : 'این گره حذف می‌شود. این کار برگشت‌پذیر نیست.',
    });
  }, [selectedNode, dataset]);

  const requestDeleteEdge = useCallback(() => {
    if (!selectedEdge) return;
    setConfirm({
      kind: 'edge',
      id: selectedEdge.id,
      name: selectedEdge.label || 'لینک بدون برچسب',
      detail: 'این لینک حذف می‌شود. گره‌های دو سر آن دست‌نخورده می‌مانند.',
    });
  }, [selectedEdge]);

  const runDelete = useCallback(async () => {
    if (!confirm || busyRef.current || !canWrite) return;
    const target = confirm;
    const current = datasetRef.current;
    busyRef.current = true;
    setBusy('delete');
    setFormError('');
    try {
      if (target.kind === 'node') {
        const node = current.nodes.find((item) => item.id === target.id);
        const snapshot = subtreeSnapshot(current.nodes, current.edges, target.id);
        await api.deleteHierarchyNode(target.id, node?.updatedAt);
        pushEdit({
          label: `حذف «${target.name}»`,
          undo: async () => {
            for (const item of snapshot.nodes) await api.createHierarchyNode(nodeBodyFromModel(item));
            for (const edge of snapshot.edges) await api.createHierarchyConnection(connectionBodyFromModel(edge));
          },
          redo: async () => {
            await api.deleteHierarchyNode(target.id);
          },
        });
      } else {
        const edge = current.edges.find((item) => item.id === target.id);
        await api.deleteHierarchyConnection(target.id, edge?.updatedAt);
        if (edge) {
          const body = connectionBodyFromModel(edge);
          pushEdit({
            label: `حذف لینک ${target.name}`,
            undo: async () => {
              await api.createHierarchyConnection(body);
            },
            redo: async () => {
              await api.deleteHierarchyConnection(edge.id);
            },
          });
        }
      }
      if (selected?.id === target.id) setSelected(null);
      dirtyRef.current = false;
      setDirty(false);
      setConfirm(null);
      setStaleNotice('');
      await loadPayload('quiet');
      setFlash({ tone: 'ok', text: 'حذف انجام شد.' });
    } catch (error) {
      if (error instanceof ApiError && error.details?.code === 'stale') {
        setStaleNotice(error.message);
        await loadPayload('quiet');
      }
      setFormError(errorMessage(error));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }, [confirm, canWrite, selected, loadPayload, pushEdit]);

  const seedDemo = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy('demo');
    setLoadError('');
    try {
      const body = await buildDemoSeed();
      await api.seedHierarchyDemo(body);
      setPayload(await api.topologyHierarchy());
      setEdit(false);
      setScope({ level: 'global' });
      setSelected(null);
      setFlash({ tone: 'ok', text: 'دادهٔ نمونه در حالت توسعه بارگذاری شد.' });
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }, []);

  /* ---------------- ساخت گراف بوم ---------------- */
  const displayedNodes = useMemo(
    () => (filterActive && onlyMatches ? graphNodes.filter((node) => filterResult.nodeIds.has(node.id)) : graphNodes),
    [graphNodes, filterActive, onlyMatches, filterResult]
  );
  const displayedNodeIds = useMemo(() => new Set(displayedNodes.map((node) => node.id)), [displayedNodes]);
  const displayedEdges = useMemo(
    () =>
      (filterActive && onlyMatches
        ? graphEdges.filter((edge) => filterResult.edgeIds.has(edge.id))
        : graphEdges
      ).filter((edge) => displayedNodeIds.has(edge.source) && displayedNodeIds.has(edge.target)),
    [graphEdges, filterActive, onlyMatches, filterResult, displayedNodeIds]
  );

  const flowNodes = useMemo<HierarchyFlowNode[]>(() => {
    return displayedNodes.map((node) => ({
      id: node.id,
      type: 'hierarchy',
      position: positions[node.id] ?? { x: 0, y: 0 },
      draggable: edit && canWrite && anchorId !== node.id,
      selected: selected?.kind === 'node' && selected.id === node.id,
      data: {
        node,
        childCount: countDescendants(dataset.nodes, node.id),
        dimmed: filterActive && !filterResult.nodeIds.has(node.id),
        context: anchorId === node.id,
        edit,
        onDrill: drillToNode,
      },
    }));
  }, [displayedNodes, positions, edit, canWrite, anchorId, selected, dataset.nodes, filterActive, filterResult, drillToNode]);

  const flowEdges = useMemo<MediumFlowEdge[]>(
    () =>
      displayedEdges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'medium',
        selected: selected?.kind === 'edge' && selected.id === edge.id,
        data: { edge, dimmed: filterActive && !filterResult.edgeIds.has(edge.id) },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color: MEDIA_META[edge.medium].color,
        },
      })),
    [displayedEdges, selected, filterActive, filterResult]
  );

  const createParentId = scope.level === 'global' ? null : scope.level === 'city' ? scope.cityId : scope.parentId;
  const createKind: TopologyNodeKind =
    scope.level === 'global' ? 'city' : scope.level === 'city' ? 'aggregation' : 'router';
  const hasData = Boolean(payload && payload.nodes.length > 0);

  return (
    <div className="space-y-3">
      {/* z-30 تا فهرست جست‌وجو روی کارت‌های بدنه (که blur/stacking خودشان را دارند) بیفتد */}
      <Card padded={false} className="relative z-30 overflow-visible">
        <div className="flex flex-wrap items-start gap-3 p-4 pb-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-brand-100 bg-gradient-to-br from-brand-50 to-white text-brand-600 shadow-soft">
            <Network size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h1 className="text-[17px] font-bold leading-6 text-ink-800">توپولوژی شبکه</h1>
              <Badge tone="brand">مرحلهٔ ۲</Badge>
              {payload?.demo ? <Badge tone="violet">دادهٔ نمونه</Badge> : null}
              {edit ? (
                <Badge tone="sun">حالت ویرایش</Badge>
              ) : (
                <Badge tone="ink">فقط نمایش</Badge>
              )}
            </div>
            <p className="mt-1 text-[11.5px] text-ink-500">
              {LEVEL_META[scope.level].hint}
              {hasData ? (
                <span className="num">
                  {' '}
                  · {faDigits(graphNodes.length)} گره · {faDigits(graphEdges.length)} لینک
                </span>
              ) : null}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <ModeSwitch edit={edit} canEdit={canWrite && hasData} onChange={handleModeChange} />
            {edit && canWrite ? (
              <div className="inline-flex items-center gap-0.5 rounded-soft border border-ink-200 bg-white p-0.5">
                <button
                  type="button"
                  className="btn-ghost btn-xs !border-0 !px-2"
                  onClick={() => void runHistory('undo')}
                  disabled={!canUndo || undoBusy}
                  title={undoLabel ? `واگرد: ${undoLabel} (Ctrl+Z)` : 'واگرد (Ctrl+Z)'}
                  aria-label={undoLabel ? `واگرد ${undoLabel}` : 'واگرد'}
                >
                  {undoBusy ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={14} />}
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-xs !border-0 !px-2"
                  onClick={() => void runHistory('redo')}
                  disabled={!canRedo || undoBusy}
                  title={redoLabel ? `ازنو: ${redoLabel} (Ctrl+Shift+Z)` : 'ازنو (Ctrl+Shift+Z)'}
                  aria-label={redoLabel ? `ازنو ${redoLabel}` : 'ازنو'}
                >
                  <Redo2 size={14} />
                </button>
              </div>
            ) : null}
            {edit && canWrite ? (
              <>
                <button
                  type="button"
                  className="btn-soft btn-xs"
                  onClick={() => {
                    setDialogError('');
                    setModal({ type: 'node' });
                  }}
                  disabled={Boolean(busy)}
                  title="افزودن شهر، مرکز تجمع، ایستگاه یا تجهیز"
                >
                  <Plus size={13} />
                  <span className="hidden sm:inline">گره</span>
                </button>
                <button
                  type="button"
                  className="btn-soft btn-xs"
                  onClick={() => {
                    setDialogError('');
                    setModal({ type: 'edge', sourceId: selectedNode?.id ?? null });
                  }}
                  disabled={Boolean(busy) || !hasData}
                  title="افزودن لینک بین دو گره"
                >
                  <Link2 size={13} />
                  <span className="hidden sm:inline">لینک</span>
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="btn-ghost btn-xs"
              onClick={() => setFitToken((t) => t + 1)}
              disabled={!hasData}
              title="جا دادن همهٔ گره‌ها در کادر"
            >
              <Maximize2 size={13} />
              <span className="hidden sm:inline">نمای کامل</span>
            </button>
            {edit ? (
              <button type="button" className="btn-ghost btn-xs" onClick={relayout} title="چیدمان خودکار و ذخیرهٔ موقعیت‌ها">
                <LayoutGrid size={13} />
                <span className="hidden sm:inline">چیدمان مجدد</span>
              </button>
            ) : null}
            <button
              type="button"
              className={`btn-ghost btn-xs ${treeOpen ? '!border-brand-200 !bg-brand-50 !text-brand-700' : ''}`}
              onClick={() => setTreeOpen((v) => !v)}
              aria-pressed={treeOpen}
              title={treeOpen ? 'پنهان کردن درخت' : 'نمایش درخت'}
            >
              <ListTree size={13} />
              <span className="hidden sm:inline">درخت</span>
            </button>
            <button
              type="button"
              className="btn-ghost btn-xs"
              onClick={() => setShortcutsOpen(true)}
              title="میان‌برهای صفحه‌کلید"
              aria-label="میان‌برهای صفحه‌کلید"
            >
              <Keyboard size={14} />
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 px-4 py-2.5">
          <nav className="flex min-w-0 flex-wrap items-center gap-1" aria-label="مسیر ناوبری">
            {crumbs.map((crumb, i) => (
              <React.Fragment key={`${crumb.id}-${i}`}>
                {i > 0 ? <ChevronLeft size={12} className="shrink-0 text-ink-300" /> : null}
                {i === crumbs.length - 1 ? (
                  <span className="max-w-[180px] truncate text-[11.5px] font-semibold text-ink-700">{crumb.label}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => goScope(crumb.scope)}
                    className="max-w-[180px] truncate rounded-md px-1 py-0.5 text-[11.5px] text-ink-500 transition hover:bg-ink-50 hover:text-brand-600"
                  >
                    {crumb.label}
                  </button>
                )}
              </React.Fragment>
            ))}
          </nav>

          <div className="ms-auto flex w-full items-center gap-1.5 sm:w-auto">
            <button
              type="button"
              className={`btn-xs shrink-0 ${filterOpen || activeFilterCount ? 'btn-soft' : 'btn-ghost'}`}
              onClick={() => setFilterOpen((v) => !v)}
              aria-expanded={filterOpen}
              aria-controls="topology-filter-panel"
              title="فیلتر نوع، رسانه، وضعیت و نقش لینک"
            >
              <Filter size={13} />
              <span className="hidden sm:inline">فیلتر</span>
              {activeFilterCount ? (
                <span className="num rounded-pill bg-brand-600 px-1.5 text-[9px] text-white">
                  {faDigits(activeFilterCount)}
                </span>
              ) : null}
            </button>
            <div className="relative min-w-0 flex-1 sm:w-80">
              <Search size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-400" />
              <input
                ref={searchInputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSearchOpen(true);
                }}
                onFocus={() => setSearchOpen(true)}
                onBlur={() => setSearchOpen(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const item = resultItems[searchIndex] ?? resultItems[0];
                    if (!item) return;
                    e.preventDefault();
                    if (item.type === 'node') jumpToNode(item.id);
                    else jumpToEdge(item.id);
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setSearchIndex((index) => Math.min(resultItems.length - 1, index + 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setSearchIndex((index) => Math.max(0, index - 1));
                  } else if (e.key === 'Escape') {
                    setQuery('');
                    setSearchOpen(false);
                  }
                }}
                className="field !rounded-pill !py-1.5 pr-9 pl-3 text-[12px]"
                placeholder="جست‌وجو: شهر، مرکز، ایستگاه، تجهیز، IP یا لینک…"
                aria-label="جست‌وجوی سراسری توپولوژی"
                aria-controls="topology-search-results"
                aria-autocomplete="list"
                aria-expanded={searchOpen && Boolean(trimmedQuery)}
                role="combobox"
              />
              {searchOpen && trimmedQuery ? (
                <div
                  id="topology-search-results"
                  role="listbox"
                  className="absolute inset-x-0 top-full z-[70] mt-1 max-h-80 overflow-y-auto rounded-soft border border-ink-200 bg-white p-1 shadow-pop"
                >
                  {resultItems.length === 0 ? (
                    <p className="px-3 py-4 text-center text-[11px] text-ink-400">نتیجه‌ای پیدا نشد.</p>
                  ) : (
                    resultItems.map((item, index) => {
                      const Icon = item.icon;
                      return (
                        <button
                          key={item.key}
                          type="button"
                          role="option"
                          aria-selected={index === searchIndex}
                          onMouseDown={(e) => e.preventDefault()}
                          onMouseEnter={() => setSearchIndex(index)}
                          onClick={() => (item.type === 'node' ? jumpToNode(item.id) : jumpToEdge(item.id))}
                          className={`flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-start transition ${
                            index === searchIndex ? 'bg-brand-50' : 'hover:bg-ink-50'
                          }`}
                        >
                          <Icon size={13} className="shrink-0" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12px] text-ink-700">{item.title}</span>
                            <span className="block truncate text-[10px] text-ink-400">{item.subtitle}</span>
                          </span>
                          <span className={`shrink-0 text-[9.5px] ${item.type === 'edge' ? 'text-brand-600' : 'text-ink-400'}`}>
                            {item.type === 'edge' ? 'لینک · ' : ''}
                            {item.tag}
                          </span>
                        </button>
                      );
                    })
                  )}
                  <p className="border-t border-ink-100 px-2 py-1 text-[9px] text-ink-400">
                    ↑↓ برای انتخاب · Enter برای رفتن · Esc برای بستن
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {filterOpen ? (
          <div
            id="topology-filter-panel"
            className="border-t border-ink-100 bg-ink-50/40 px-4 py-2.5"
            role="region"
            aria-label="فیلترهای توپولوژی"
          >
            <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
              <FilterGroup label="نوع">
                {KIND_FILTER_OPTIONS.map((option) => (
                  <FilterChip
                    key={option.value}
                    label={option.label}
                    active={kinds.includes(option.value)}
                    onClick={() =>
                      setKinds((prev) =>
                        prev.includes(option.value) ? prev.filter((v) => v !== option.value) : [...prev, option.value]
                      )
                    }
                  />
                ))}
              </FilterGroup>

              <FilterGroup label="وضعیت">
                {STATUS_FILTER_OPTIONS.map((option) => (
                  <FilterChip
                    key={option.value}
                    label={option.label}
                    active={statuses.includes(option.value)}
                    onClick={() =>
                      setStatuses((prev) =>
                        prev.includes(option.value) ? prev.filter((v) => v !== option.value) : [...prev, option.value]
                      )
                    }
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        option.value === 'online'
                          ? 'bg-emerald-500'
                          : option.value === 'offline'
                            ? 'bg-red-500'
                            : option.value === 'warning'
                              ? 'bg-amber-500'
                              : option.value === 'maintenance'
                                ? 'bg-violet-500'
                                : 'bg-ink-400'
                      }`}
                    />
                  </FilterChip>
                ))}
              </FilterGroup>

              <FilterGroup label="رسانه">
                {MEDIUM_ORDER.map((value) => (
                  <FilterChip
                    key={value}
                    label={MEDIA_META[value].label}
                    active={media.includes(value)}
                    title={MEDIA_META[value].hint}
                    onClick={() =>
                      setMedia((prev) =>
                        prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]
                      )
                    }
                  >
                    <span
                      className="inline-block h-3 w-5"
                      aria-hidden
                      style={{
                        borderTop: `2px ${MEDIA_META[value].dash ? 'dashed' : 'solid'} ${MEDIA_META[value].color}`,
                      }}
                    />
                  </FilterChip>
                ))}
              </FilterGroup>

              <FilterGroup label="نقش لینک">
                {ROLE_FILTER_OPTIONS.map((option) => (
                  <FilterChip
                    key={option.value}
                    label={option.label}
                    active={roles.includes(option.value)}
                    onClick={() =>
                      setRoles((prev) =>
                        prev.includes(option.value) ? prev.filter((v) => v !== option.value) : [...prev, option.value]
                      )
                    }
                  />
                ))}
              </FilterGroup>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-ink-500">
              <button
                type="button"
                className={`btn-xs ${onlyMatches ? 'btn-soft' : 'btn-ghost'}`}
                onClick={() => setOnlyMatches((v) => !v)}
                disabled={!filterActive}
                aria-pressed={onlyMatches}
                title="پنهان‌کردن گره‌ها و لینک‌های ناهم‌خوان"
              >
                {onlyMatches ? <EyeOff size={12} /> : <Eye size={12} />}
                فقط نتیجه‌ها
              </button>
              <span className="num">
                {filterActive
                  ? `${faDigits(filterCount.nodes)} گره و ${faDigits(filterCount.edges)} لینک هم‌خوان`
                  : 'همهٔ گره‌ها و لینک‌ها'}
              </span>
              {filterActive ? (
                <button
                  type="button"
                  className="ms-auto inline-flex items-center gap-1 text-red-600 hover:underline"
                  onClick={() => {
                    setQuery('');
                    setKinds([]);
                    setMedia([]);
                    setStatuses([]);
                    setRoles([]);
                    setOnlyMatches(false);
                  }}
                >
                  <X size={11} /> پاک‌کردن فیلترها
                </button>
              ) : null}
              <span className="hidden sm:inline text-ink-400">
                رنگ خط فقط رسانهٔ انتقال را نشان می‌دهد؛ وضعیت زندهٔ لینک جداگانه است.
              </span>
            </div>
          </div>
        ) : null}

        {staleNotice ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-sun-200 bg-sun-50 px-4 py-2 text-[11px] text-sun-800">
            <AlertTriangle size={13} />
            <span className="min-w-0 flex-1">{staleNotice}</span>
            <button type="button" className="btn-ghost btn-xs" onClick={() => setStaleNotice('')}>
              بستن
            </button>
          </div>
        ) : null}

        {flash || positionError || positionState !== 'idle' ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 px-4 py-1.5 text-[10.5px]">
            {flash ? (
              <span
                className={`inline-flex items-center gap-1 ${
                  flash.tone === 'ok' ? 'text-emerald-700' : 'text-red-600'
                }`}
                role="status"
              >
                {flash.tone === 'ok' ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
                {flash.text}
              </span>
            ) : null}
            {positionState === 'saving' ? (
              <span className="inline-flex items-center gap-1 text-ink-500">
                <Loader2 size={12} className="animate-spin" />
                در حال ذخیرهٔ موقعیت…
              </span>
            ) : positionState === 'saved' ? (
              <span className="inline-flex items-center gap-1 text-ink-400">
                <Database size={12} />
                موقعیت‌ها ذخیره شد
              </span>
            ) : null}
            {positionError ? (
              <span className="inline-flex items-center gap-1 text-red-600">
                <AlertTriangle size={12} />
                ذخیرهٔ موقعیت ناموفق بود: {positionError}
              </span>
            ) : null}
          </div>
        ) : null}
      </Card>

      {loading ? (
        <Card className="!py-16">
          <PageLoader label="در حال بارگذاری توپولوژی از سرور…" />
        </Card>
      ) : loadError && !payload ? (
        <Card>
          <ErrorState message={loadError} onRetry={() => setReloadToken((t) => t + 1)} />
        </Card>
      ) : !payload || payload.nodes.length === 0 ? (
        <Card className="!py-6">
          <EmptyState
            icon={<Network size={22} />}
            title="توپولوژی هنوز گره‌ای ندارد"
            description={
              payload?.demoAvailable
                ? 'با ساخت اولین شهر شروع کنید، یا دادهٔ نمونهٔ توسعه را بارگذاری کنید. دادهٔ نمونه فقط روی پایگاه‌دادهٔ خالی و با برچسب مشخص بارگذاری می‌شود.'
                : 'با ساخت اولین شهر شروع کنید؛ مرکز تجمع و ایستگاه زیر شهر و تجهیزات زیر آن‌ها ساخته می‌شوند.'
            }
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  className="btn-primary btn-xs"
                  onClick={() => {
                    setDialogError('');
                    setModal({ type: 'node' });
                  }}
                  disabled={!canWrite || Boolean(busy)}
                >
                  <Plus size={13} />
                  ساخت اولین شهر
                </button>
                {payload?.demoAvailable ? (
                  <button
                    type="button"
                    className="btn-ghost btn-xs"
                    onClick={() => void seedDemo()}
                    disabled={Boolean(busy)}
                  >
                    {busy === 'demo' ? <Spinner className="!h-3.5 !w-3.5" /> : <Database size={13} />}
                    بارگذاری دادهٔ نمونه
                  </button>
                ) : null}
                {loadError ? (
                  <button type="button" className="btn-ghost btn-xs" onClick={() => setReloadToken((t) => t + 1)}>
                    <RefreshCw size={13} />
                    تلاش دوباره
                  </button>
                ) : null}
              </div>
            }
          />
        </Card>
      ) : (
        <>
          {loadError ? (
            <div className="flex items-center gap-2 rounded-soft border border-sun-200 bg-sun-50 px-3 py-2 text-[11px] text-sun-700">
              <AlertTriangle size={13} />
              {loadError}
              <button type="button" className="ms-auto underline" onClick={() => setReloadToken((t) => t + 1)}>
                تلاش دوباره
              </button>
            </div>
          ) : null}
          {payload.demo ? (
            <div className="flex items-center gap-2 rounded-soft border border-violet-200 bg-violet-50 px-3 py-2 text-[11px] text-violet-700">
              <Database size={13} />
              این ردیف‌ها دادهٔ نمونهٔ توسعه‌اند (`origin=demo`) و دادهٔ واقعی شبکه نیستند.
            </div>
          ) : null}

          <div className="flex flex-col gap-3 xl:flex-row xl:items-start">
            {treeOpen ? (
              <div className="order-1 h-[340px] min-w-0 xl:order-3 xl:h-[calc(100dvh-380px)] xl:min-h-[440px] xl:max-h-[860px] xl:w-[286px] xl:shrink-0">
                <NetworkTree
                  nodes={dataset.nodes}
                  scope={scope}
                  selectedId={selectedNode?.id ?? null}
                  query={query}
                  dimmedIds={filterActive ? filterResult.nodeIds : null}
                  onSelect={handleTreeSelect}
                  onClose={() => setTreeOpen(false)}
                  className="h-full"
                />
              </div>
            ) : null}

            <div className="order-2 min-w-0 flex-1 xl:order-2">
              <ReactFlowProvider>
                <HierarchyCanvas
                  nodes={flowNodes}
                  edges={flowEdges}
                  edit={edit}
                  fitToken={fitToken}
                  focus={focus}
                  scopeTitle={scopeTitle}
                  scopeHint={scopeHint}
                  visibleCount={displayedNodes.length}
                  linkCount={displayedEdges.length}
                  filterActive={filterActive}
                  onNodeSelect={selectNode}
                  onEdgeSelect={selectEdge}
                  onDrill={drillToNode}
                  onPaneClick={() => {
                    if (!confirmDiscard()) return;
                    setSelected(null);
                  }}
                  onNodeDragStop={handleDragStop}
                  emptyLabel={
                    edit && canWrite
                      ? 'این مرکز یا ایستگاه هنوز تجهیزی ندارد؛ با «گره» تجهیز تازه بسازید.'
                      : 'این مرکز یا ایستگاه هنوز تجهیزی ندارد.'
                  }
                  className="h-[440px] xl:h-[calc(100dvh-380px)] xl:min-h-[440px] xl:max-h-[860px]"
                />
              </ReactFlowProvider>
            </div>

            <div className="order-3 h-[560px] min-w-0 xl:order-1 xl:h-[calc(100dvh-380px)] xl:min-h-[440px] xl:max-h-[860px] xl:w-[352px] xl:shrink-0">
              <HierarchyInspector
                scopeTitle={scopeTitle}
                scopeHint={scopeHint}
                allNodes={dataset.nodes}
                allEdges={dataset.edges}
                stats={stats}
                selectedNode={selectedNode}
                selectedEdge={selectedEdge}
                edit={edit && canWrite}
                groups={groups}
                saving={Boolean(busy)}
                formError={formError}
                onSaveNode={saveNode}
                onSaveEdge={saveEdge}
                onDeleteNode={requestDeleteNode}
                onDeleteEdge={requestDeleteEdge}
                onAddConnection={() => {
                  setDialogError('');
                  setModal({ type: 'edge', sourceId: selectedNode?.id ?? null });
                }}
                onDirtyChange={setDirty}
                resetToken={formResetToken}
                onDrill={(node) => drillToNode(node.id)}
                onJumpToNode={jumpToNode}
                onSelectEdge={selectEdge}
                onClear={() => {
                  if (!confirmDiscard()) return;
                  setSelected(null);
                }}
                className="h-full"
              />
            </div>
          </div>
        </>
      )}

      {modal?.type === 'node' ? (
        <CreateNodeDialog
          nodes={dataset.nodes}
          initialParentId={createParentId}
          initialKind={createKind}
          saving={busy === 'create-node'}
          error={dialogError}
          onClose={() => setModal(null)}
          onCreate={createNode}
        />
      ) : null}

      {modal?.type === 'edge' ? (
        <CreateConnectionDialog
          nodes={dataset.nodes}
          edges={dataset.edges}
          initialSourceId={modal.sourceId}
          saving={busy === 'create-edge'}
          error={dialogError}
          onClose={() => setModal(null)}
          onCreate={createConnection}
        />
      ) : null}

      <Modal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        title="میان‌برهای صفحه‌کلید"
        subtitle="برای ویرایش سریع توپولوژی"
        size="sm"
        footer={
          <button type="button" className="btn-ghost btn-xs" onClick={() => setShortcutsOpen(false)}>
            بستن
          </button>
        }
      >
        <dl className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 text-[11.5px] text-ink-600">
          {[
            ['واگرد آخرین ویرایش', 'Ctrl + Z'],
            ['ازنو', 'Ctrl + Shift + Z'],
            ['جست‌وجوی سراسری', '/ یا Ctrl + K'],
            ['جا دادن همهٔ گره‌ها', 'F'],
            ['بستن پنجره/پاک‌کردن فیلتر', 'Esc'],
            ['راهنمای میان‌برها', '?'],
          ].map(([label, keys]) => (
            <React.Fragment key={label}>
              <dt>{label}</dt>
              <dd className="text-end">
                <kbd dir="ltr" className="rounded border border-ink-200 bg-ink-50 px-1.5 py-0.5 font-mono text-[10px] text-ink-600">
                  {keys}
                </kbd>
              </dd>
            </React.Fragment>
          ))}
        </dl>
        <p className="mt-3 text-[10.5px] leading-5 text-ink-400">
          میان‌برها وقتی داخل ورودی‌ها تایپ می‌کنید غیرفعال‌اند تا متن شما دست‌نخورده بماند. ویرایش‌های واگردپذیر فقط در حالت
          «ویرایش» فعال است.
        </p>
      </Modal>

      {confirm ? (
        <Modal
          open
          onClose={() => setConfirm(null)}
          title={`حذف ${confirm.kind === 'node' ? 'گره' : 'لینک'}`}
          subtitle={confirm.name}
          size="sm"
          footer={
            <>
              <button type="button" className="btn-ghost btn-xs" onClick={() => setConfirm(null)} disabled={busy === 'delete'}>
                انصراف
              </button>
              <button type="button" className="btn-danger btn-xs" onClick={() => void runDelete()} disabled={busy === 'delete'}>
                {busy === 'delete' ? <Spinner className="!h-3.5 !w-3.5" /> : null}
                حذف قطعی
              </button>
            </>
          }
        >
          <div className="space-y-2 text-[12px] leading-6 text-ink-600">
            <p className="flex items-start gap-2 rounded-soft border border-red-200 bg-red-50 px-3 py-2 text-red-700">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              {confirm.detail}
            </p>
            {formError ? <p className="text-[11px] text-red-600">{formError}</p> : null}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
