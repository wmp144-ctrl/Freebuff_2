/**
 * دیاگرام‌های شبکه — هر دیاگرام یک فایل مستقل با بوم اختصاصی است.
 *
 * چیدمان: نوار بالای صفحه (نام، حالت نمایش/ویرایش، خروجی، ذخیره)، نوار
 * ابزار بوم (فقط در ویرایش) و پنل کناری تاشو (دیاگرام‌ها / تجهیزات /
 * مشخصات انتخاب). بوم بیشترین فضا را می‌گیرد و دکمهٔ بستن پنل روی خود پنل
 * است؛ پس از بسته شدن، دکمهٔ باز کردن در نوار بالا ظاهر می‌شود.
 *
 * ویرایش: همهٔ تغییرات از `useCanvasHistory` عبور می‌کنند تا واگرد/ازنو داشته
 * باشند؛ کشیدن و تغییر اندازه یک گام می‌سازند. ذخیرهٔ خودکار با تأخیر کوتاه
 * انجام می‌شود و ذخیرهٔ دستی (Ctrl+S) همیشه در دسترس است.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { applyEdgeChanges, applyNodeChanges, ReactFlowProvider } from '@xyflow/react';
import type { Connection, EdgeChange, NodeChange } from '@xyflow/react';
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  FileText,
  Image as ImageIcon,
  Info,
  Pencil,
  PanelLeftOpen,
  RefreshCw,
  Save,
  Workflow,
  X,
} from 'lucide-react';
import { api, ApiError, isAbortError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApp, useAsync, useToast } from '../lib/store';
import { faDigits } from '../lib/format';
import {
  alignNodes,
  clipboardCount,
  copyToClipboard,
  createDeviceNode,
  createGroupNode,
  createImageNode,
  createNoteNode,
  createShapeNode,
  deviceCatalogKey,
  deviceNodeNeedsSync,
  deviceNodeSyncPatch,
  distributeNodes,
  newId,
  pasteFromClipboard,
  serializeEdges,
  serializeNodes,
  toFlowEdge,
  toFlowNode,
} from '../lib/diagrams';
import type { AlignMode, DiagramFlowEdge, DiagramFlowNode } from '../lib/diagrams';
import type {
  Device,
  DiagramConnectionKind,
  DiagramDetail,
  DiagramEdgeData,
  DiagramNodeData,
  DiagramShape,
  DiagramSummary,
} from '../lib/types';
import { EmptyState, Field, Modal, PageLoader } from '../components/ui';
import { useLivePing } from '../components/LivePing';
import DiagramCanvas from '../features/diagrams/DiagramCanvas';
import type { DiagramCanvasHandle, DiagramExportFormat } from '../features/diagrams/DiagramCanvas';
import DiagramDevicePalette from '../features/diagrams/DiagramDevicePalette';
import DiagramToolbar from '../features/diagrams/DiagramToolbar';
import type { CanvasTool, PendingTool } from '../features/diagrams/DiagramToolbar';
import DiagramInspector from '../features/diagrams/DiagramInspector';
import DiagramTree from '../features/diagrams/DiagramTree';
import { useCanvasHistory } from '../features/diagrams/useCanvasHistory';

type Mode = 'view' | 'edit';
type PanelTab = 'tree' | 'devices' | 'inspector';

function readPanelOpen(): boolean {
  try {
    return localStorage.getItem('nw.diagrams.panel') !== 'closed';
  } catch {
    return true;
  }
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value == null ? fallback : value === 'on';
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? 'on' : 'off');
  } catch {
    /* بی‌اثر */
  }
}

/** فوکوس داخل فیلدهای متنی نباید میان‌برهای بوم را بگیرد */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

interface EditorDialog {
  mode: 'create' | 'edit';
  parentId?: number | null;
  diagram?: DiagramSummary;
}

export default function Diagrams() {
  const params = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const { push } = useToast();
  const { settings } = useApp();
  const livePing = useLivePing();
  const canWrite = can('diagrams:write');

  const idParam = Number(params.id);
  const currentId = Number.isInteger(idParam) && idParam > 0 ? idParam : null;

  const canvas = useCanvasHistory();
  const { nodes, edges } = canvas;

  const [list, setList] = useState<DiagramSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [detail, setDetail] = useState<DiagramDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<Mode>('view');
  const [panelOpen, setPanelOpen] = useState(readPanelOpen);
  const [panelTab, setPanelTab] = useState<PanelTab>('tree');
  const [tool, setTool] = useState<CanvasTool>('select');
  const [pending, setPending] = useState<PendingTool>(null);
  const [connectionKind, setConnectionKind] = useState<DiagramConnectionKind>('fiber');
  const [dialog, setDialog] = useState<EditorDialog | null>(null);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState<DiagramExportFormat | null>(null);
  const [snapToGrid, setSnapToGrid] = useState(() => readFlag('nw.diagrams.snap', false));
  const [titleBlock, setTitleBlock] = useState(() => readFlag('nw.diagrams.titleblock', true));
  const [autoSave, setAutoSave] = useState(() => readFlag('nw.diagrams.autosave', true));
  const [syncing, setSyncing] = useState(false);
  // هنگام کشیدن، ذخیرهٔ خودکار موقتاً متوقف می‌شود تا وسط حرکت اجرا نشود.
  const [dragging, setDragging] = useState(false);
  const [clipCount, setClipCount] = useState(() => clipboardCount());
  const [uploadingImage, setUploadingImage] = useState(false);
  const listGate = useRef(0);
  const canvasRef = useRef<DiagramCanvasHandle | null>(null);
  const revisionRef = useRef(0);
  const savingRef = useRef(false);
  const autoSaveBlocked = useRef(false);
  const mutationSeq = useRef(0);
  // نوع ارتباط در ref هم نگه داشته می‌شود تا حتی اگر کاربر بدون فاصله بعد از
  // انتخاب نوع، اتصال را بکشد، ارتباط با همان نوع تازه ساخته شود.
  const connectionKindRef = useRef<DiagramConnectionKind>('fiber');
  const dragSnapshot = useRef<ReturnType<typeof canvas.snapshot> | null>(null);
  const resizeRecorded = useRef(false);
  const nudgeSnapshot = useRef<ReturnType<typeof canvas.snapshot> | null>(null);
  const nudgeTimer = useRef<number | null>(null);
  const autoSyncedFor = useRef<number | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const imageTargetNode = useRef<string | null>(null);

  const editing = mode === 'edit' && canWrite;

  /** هر تغییر کاربر: علامت «ذخیره‌نشده» + شمارندهٔ تغییر برای ذخیرهٔ خودکار */
  const markDirty = useCallback(() => {
    mutationSeq.current += 1;
    setDirty(true);
  }, []);

  /** تغییر قابل‌واگرد؛ در صورت تغییر واقعی، کثیف هم می‌شود */
  const applyCanvas = useCallback(
    (updater: (prev: { nodes: DiagramFlowNode[]; edges: DiagramFlowEdge[] }) => {
      nodes: DiagramFlowNode[];
      edges: DiagramFlowEdge[];
    }) => {
      const changed = canvas.apply(updater);
      if (changed) markDirty();
      return changed;
    },
    [canvas, markDirty]
  );

  const loadList = useCallback(async () => {
    const gate = ++listGate.current;
    setListLoading(true);
    try {
      const res = await api.diagrams();
      if (gate === listGate.current) setList(res.items);
    } catch (e) {
      if (!isAbortError(e)) push(e instanceof ApiError ? e.message : 'دریافت فهرست دیاگرام‌ها ناموفق بود.', 'error');
    } finally {
      if (gate === listGate.current) setListLoading(false);
    }
  }, [push]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // تجهیزات مانیتورینگ برای وضعیت زندهٔ گره‌ها، تب «تجهیزات» و همگام‌سازی
  const devicesAsync = useAsync(
    (signal) => api.devices({ pageSize: 500, sort: 'name', order: 'asc' }, signal),
    [],
    { interval: 15000 }
  );
  const devicesById = useMemo(() => {
    const map = new Map<number, Device>();
    for (const device of devicesAsync.data?.items ?? []) map.set(device.id, device);
    return map;
  }, [devicesAsync.data]);

  // انتخاب خودکار نخستین دیاگرام وقتی آدرس شناسه ندارد
  useEffect(() => {
    if (currentId || !list.length) return;
    navigate(`/diagrams/${list[0].id}`, { replace: true });
  }, [currentId, list, navigate]);

  // بارگذاری محتوای دیاگرام انتخاب‌شده
  useEffect(() => {
    if (!currentId) {
      setDetail(null);
      canvas.replace({ nodes: [], edges: [] });
      setRevision(0);
      revisionRef.current = 0;
      setDirty(false);
      return;
    }
    let alive = true;
    const controller = new AbortController();
    setDetailLoading(true);
    setError(null);
    autoSaveBlocked.current = false;
    api
      .diagram(currentId, controller.signal)
      .then((data) => {
        if (!alive) return;
        setDetail(data);
        canvas.replace({ nodes: data.nodes.map(toFlowNode), edges: data.edges.map(toFlowEdge) });
        setRevision(data.revision);
        revisionRef.current = data.revision;
        setDirty(false);
        autoSyncedFor.current = null;
      })
      .catch((e) => {
        if (!alive || isAbortError(e)) return;
        setError(e instanceof ApiError ? e.message : 'دریافت دیاگرام ناموفق بود.');
        setDetail(null);
      })
      .finally(() => {
        if (alive) setDetailLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
    // canvas پایدار است (useCallback)، پس وابستگی فقط شناسهٔ دیاگرام است.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  useEffect(() => {
    try {
      localStorage.setItem('nw.diagrams.panel', panelOpen ? 'open' : 'closed');
    } catch {
      /* بی‌اثر */
    }
  }, [panelOpen]);

  useEffect(() => {
    writeFlag('nw.diagrams.snap', snapToGrid);
  }, [snapToGrid]);

  useEffect(() => {
    writeFlag('nw.diagrams.titleblock', titleBlock);
  }, [titleBlock]);

  useEffect(() => {
    writeFlag('nw.diagrams.autosave', autoSave);
  }, [autoSave]);

  useEffect(
    () => () => {
      if (nudgeTimer.current != null) window.clearTimeout(nudgeTimer.current);
    },
    []
  );

  const openPanel = useCallback((tab: PanelTab) => {
    setPanelOpen(true);
    setPanelTab(tab);
  }, []);

  /** افزودن تجهیز واقعی مانیتورینگ به بوم (انتخاب از تب «تجهیزات») */
  const pickDeviceFromList = useCallback((device: Device) => {
    setPending({
      kind: 'device',
      deviceKey: deviceCatalogKey(device.deviceType),
      deviceId: device.id,
      label: device.name,
      model: device.model,
    });
    setTool('select');
  }, []);

  /* ---------------------------------------------------------------- */
  /* همگام‌سازی با تجهیزات واقعی                                      */
  /* ---------------------------------------------------------------- */

  /** یک گره را با رکورد تجهیز همراهش به‌روز می‌کند؛ خروجی: تغییر کرد؟ */
  const syncNodeWithDevice = useCallback(
    (nodeId: string): boolean => {
      const node = canvas.snapshot().nodes.find((item) => item.id === nodeId);
      const device = node?.data.deviceId ? devicesById.get(Number(node.data.deviceId)) : null;
      if (!node || !device) return false;
      const patch = deviceNodeSyncPatch(node.data, device);
      return applyCanvas((prev) => ({
        ...prev,
        nodes: prev.nodes.map((item) => (item.id === nodeId ? { ...item, data: { ...item.data, ...patch } } : item)),
      }));
    },
    [applyCanvas, canvas, devicesById]
  );

  /** همگام‌سازی همهٔ تجهیزات بوم با رکوردهای مانیتورینگ */
  const syncAllDevices = useCallback(() => {
    const current = canvas.snapshot().nodes;
    let updated = 0;
    const next = current.map((node) => {
      const device = node.data.deviceId ? devicesById.get(Number(node.data.deviceId)) : null;
      if (!device || !deviceNodeNeedsSync(node.data, device)) return node;
      updated += 1;
      return { ...node, data: { ...node.data, ...deviceNodeSyncPatch(node.data, device) } };
    });
    if (!updated) {
      push('همهٔ تجهیزات بوم با رکورد مانیتورینگ همگام هستند.', 'info');
      return;
    }
    setSyncing(true);
    applyCanvas((prev) => ({ ...prev, nodes: next }));
    setSyncing(false);
    push(`نام، نوع و مشخصات ${faDigits(updated)} تجهیز همگام شد.`, 'success');
  }, [applyCanvas, canvas, devicesById, push]);

  // همگام‌سازی خودکار یک‌بار پس از باز شدن هر دیاگرام (تغییر قابل‌واگرد و
  // قابل‌ذخیره است؛ اگر چیزی عوض نشود هیچ گامی ساخته نمی‌شود).
  useEffect(() => {
    if (!detail || !devicesById.size) return;
    if (autoSyncedFor.current === detail.id) return;
    autoSyncedFor.current = detail.id;
    const current = canvas.snapshot().nodes;
    const needs = current.some((node) => {
      const device = node.data.deviceId ? devicesById.get(Number(node.data.deviceId)) : null;
      return !!device && deviceNodeNeedsSync(node.data, device);
    });
    if (!needs) return;
    applyCanvas((prev) => ({
      ...prev,
      nodes: prev.nodes.map((node) => {
        const device = node.data.deviceId ? devicesById.get(Number(node.data.deviceId)) : null;
        if (!device) return node;
        return { ...node, data: { ...node.data, ...deviceNodeSyncPatch(node.data, device) } };
      }),
    }));
  }, [applyCanvas, canvas, detail, devicesById]);

  const openDevicePage = useCallback(
    (deviceId: number) => {
      navigate(`/devices/${deviceId}`);
    },
    [navigate]
  );

  const pingDevice = useCallback(
    (deviceId: number) => {
      const device = devicesById.get(deviceId);
      if (!device) return;
      livePing.open({ id: device.id, name: device.name, ip: device.ip, status: device.status });
    },
    [devicesById, livePing]
  );

  /* ---------------------------------------------------------------- */
  /* تغییرات بوم                                                      */
  /* ---------------------------------------------------------------- */

  const handleNodesChange = useCallback(
    (changes: NodeChange<DiagramFlowNode>[]) => {
      const resizing = changes.some((change) => change.type === 'dimensions' && change.resizing === true);
      const resizeSettled = changes.some((change) => change.type === 'dimensions' && change.resizing !== true);
      const structural = changes.some(
        (change) => change.type === 'remove' || change.type === 'add' || change.type === 'replace'
      );
      // تغییر اندازه پیوسته است؛ وضعیت پیش از آن یک‌بار ثبت می‌شود.
      if (resizing && !resizeRecorded.current) {
        resizeRecorded.current = true;
        canvas.pushSnapshot(canvas.snapshot());
      }
      if (resizeSettled && resizeRecorded.current) resizeRecorded.current = false;

      canvas.apply((prev) => {
        const next = applyNodeChanges(changes, prev.nodes);
        return next === prev.nodes ? prev : { ...prev, nodes: next };
      }, structural);

      const meaningful = changes.some((change) => {
        if (change.type === 'select') return false;
        if (change.type === 'dimensions') {
          return (
            change.resizing === true ||
            change.setAttributes === true ||
            change.setAttributes === 'width' ||
            change.setAttributes === 'height'
          );
        }
        return true;
      });
      if (meaningful) markDirty();
    },
    [canvas, markDirty]
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<DiagramFlowEdge>[]) => {
      const structural = changes.some(
        (change) => change.type === 'remove' || change.type === 'add' || change.type === 'replace'
      );
      canvas.apply((prev) => {
        const next = applyEdgeChanges(changes, prev.edges);
        return next === prev.edges ? prev : { ...prev, edges: next };
      }, structural);
      if (changes.some((change) => change.type !== 'select')) markDirty();
    },
    [canvas, markDirty]
  );

  const changeConnectionKind = useCallback((kind: DiagramConnectionKind) => {
    connectionKindRef.current = kind;
    setConnectionKind(kind);
    // اگر ابزار اتصال فعال است، فعال می‌ماند و نوع تازه بلافاصله روی ارتباط
    // بعدی اعمال می‌شود؛ در حالت انتخاب هم ابزار عوض نمی‌شود تا انتخاب/جابه‌جایی
    // ناخواسته به رسم ارتباط تبدیل نشود.
  }, []);

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return;
      const sourceHandle = connection.sourceHandle ?? 'right';
      const targetHandle = connection.targetHandle ?? 'left';
      applyCanvas((prev) => {
        if (
          prev.edges.some(
            (edge) =>
              edge.source === connection.source &&
              edge.target === connection.target &&
              edge.sourceHandle === sourceHandle &&
              edge.targetHandle === targetHandle
          )
        ) {
          return prev;
        }
        return {
          ...prev,
          edges: [
            ...prev.edges,
            {
              id: newId(),
              type: 'diagram',
              source: connection.source as string,
              target: connection.target as string,
              sourceHandle,
              targetHandle,
              data: { kind: connectionKindRef.current, label: '' },
            },
          ],
        };
      });
    },
    [applyCanvas]
  );

  const handleNodesDelete = useCallback(
    (deleted: DiagramFlowNode[]) => {
      const ids = new Set(deleted.map((node) => node.id));
      canvas.apply((prev) => {
        const nextEdges = prev.edges.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target));
        return nextEdges.length === prev.edges.length ? prev : { ...prev, edges: nextEdges };
      });
      markDirty();
    },
    [canvas, markDirty]
  );

  const handleEdgesDelete = useCallback(() => {
    markDirty();
  }, [markDirty]);

  const addAt = useCallback(
    (position: { x: number; y: number }) => {
      if (!pending || !editing) return;
      const node =
        pending.kind === 'device'
          ? (() => {
              const created = createDeviceNode(pending.deviceKey, position);
              // تجهیزی که از فهرست مانیتورینگ اضافه می‌شود، نام/مدل/IP و شناسهٔ
              // همان تجهیز را با خود می‌برد تا وضعیت زنده و همگام‌سازی ممکن باشد.
              const device = pending.deviceId ? devicesById.get(pending.deviceId) : null;
              return {
                ...created,
                data: {
                  ...created.data,
                  ...(pending.label ? { label: pending.label } : {}),
                  ...(pending.model ? { model: pending.model } : {}),
                  ...(pending.deviceId ? { deviceId: pending.deviceId } : {}),
                  ...(device
                    ? { ip: device.ip, syncedAt: Date.now(), serial: device.serial || created.data.serial }
                    : {}),
                },
              };
            })()
          : pending.kind === 'shape'
            ? createShapeNode(pending.shape, position)
            : pending.kind === 'group'
              ? createGroupNode(position)
              : pending.kind === 'image'
                ? createImageNode(position, { src: pending.src, attachmentId: pending.attachmentId })
                : createNoteNode(position);
      applyCanvas((prev) => ({
        ...prev,
        nodes: [...prev.nodes.map((item) => ({ ...item, selected: false })), { ...node, selected: true }],
      }));
      setPending(null);
      setTool('select');
    },
    [applyCanvas, devicesById, editing, pending]
  );

  const patchNodeData = useCallback(
    (nodeId: string, patch: Partial<DiagramNodeData>) => {
      applyCanvas((prev) => ({
        ...prev,
        nodes: prev.nodes.map((node) => (node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node)),
      }));
    },
    [applyCanvas]
  );

  const patchNodeSize = useCallback(
    (nodeId: string, patch: { width?: number; height?: number }) => {
      applyCanvas((prev) => ({
        ...prev,
        nodes: prev.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
      }));
    },
    [applyCanvas]
  );

  const patchEdge = useCallback(
    (edgeId: string, patch: Partial<DiagramEdgeData>) => {
      applyCanvas((prev) => ({
        ...prev,
        edges: prev.edges.map((edge) =>
          edge.id === edgeId ? { ...edge, data: { ...(edge.data ?? { kind: 'copper', label: '' }), ...patch } } : edge
        ),
      }));
    },
    [applyCanvas]
  );

  const removeNode = useCallback(
    (nodeId: string) => {
      applyCanvas((prev) => ({
        nodes: prev.nodes.filter((node) => node.id !== nodeId),
        edges: prev.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
      }));
    },
    [applyCanvas]
  );

  const removeEdge = useCallback(
    (edgeId: string) => {
      applyCanvas((prev) => ({ ...prev, edges: prev.edges.filter((edge) => edge.id !== edgeId) }));
    },
    [applyCanvas]
  );

  const selectedNodes = useMemo(() => nodes.filter((node) => node.selected), [nodes]);
  const selectedEdges = useMemo(() => edges.filter((edge) => edge.selected), [edges]);
  const selectedNode = selectedNodes[0] ?? null;
  const selectedEdge = edges.find((edge) => edge.selected) ?? null;
  const selectedColor = selectedNode ? String(selectedNode.data.color ?? '#2563eb') : null;
  const hasSelection = selectedNodes.length > 0 || selectedEdges.length > 0;

  const deleteSelection = useCallback(() => {
    const nodeIds = new Set(canvas.snapshot().nodes.filter((node) => node.selected).map((node) => node.id));
    const edgeIds = new Set(canvas.snapshot().edges.filter((edge) => edge.selected).map((edge) => edge.id));
    if (!nodeIds.size && !edgeIds.size) return;
    applyCanvas((prev) => ({
      nodes: prev.nodes.filter((node) => !nodeIds.has(node.id)),
      edges: prev.edges.filter(
        (edge) => !edgeIds.has(edge.id) && !nodeIds.has(edge.source) && !nodeIds.has(edge.target)
      ),
    }));
  }, [applyCanvas, canvas]);

  /* ---------- تراز، توزیع و رنگ گروهی ---------- */

  const alignSelection = useCallback(
    (mode: AlignMode) => {
      const changed = applyCanvas((prev) => ({ ...prev, nodes: alignNodes(prev.nodes, mode) }));
      if (!changed) push('برای تراز، حداقل دو جزء را انتخاب کنید.', 'info');
    },
    [applyCanvas, push]
  );

  const distributeSelection = useCallback(
    (axis: 'x' | 'y') => {
      const changed = applyCanvas((prev) => ({ ...prev, nodes: distributeNodes(prev.nodes, axis) }));
      if (!changed) push('برای توزیع، حداقل سه جزء را انتخاب کنید.', 'info');
    },
    [applyCanvas, push]
  );

  const recolorSelection = useCallback(
    (color: string) => {
      applyCanvas((prev) => ({
        ...prev,
        nodes: prev.nodes.map((node) => (node.selected ? { ...node, data: { ...node.data, color } } : node)),
      }));
    },
    [applyCanvas]
  );

  /* ---------- کلیپ‌بورد ---------- */

  const copySelection = useCallback(() => {
    const snapshot = canvas.snapshot();
    const count = copyToClipboard(
      snapshot.nodes.filter((node) => node.selected),
      snapshot.edges
    );
    setClipCount(clipboardCount());
    if (!count) {
      push('برای کپی، ابتدا یک یا چند جزء را انتخاب کنید.', 'info');
      return;
    }
    push(`${faDigits(count)} جزء کپی شد.`, 'success');
  }, [canvas, push]);

  const pasteClipboard = useCallback(() => {
    const pasted = pasteFromClipboard();
    if (!pasted) {
      push('چیزی برای چسباندن نیست (یا کلیپ‌بورد منقضی شده است).', 'info');
      return;
    }
    applyCanvas((prev) => ({
      nodes: [...prev.nodes.map((node) => ({ ...node, selected: false })), ...pasted.nodes],
      edges: [...prev.edges.map((edge) => ({ ...edge, selected: false })), ...pasted.edges],
    }));
    push(`${faDigits(pasted.nodes.length)} جزء چسبانده شد.`, 'success');
  }, [applyCanvas, push]);

  const cutSelection = useCallback(() => {
    const snapshot = canvas.snapshot();
    const count = copyToClipboard(
      snapshot.nodes.filter((node) => node.selected),
      snapshot.edges
    );
    if (!count) return;
    setClipCount(clipboardCount());
    deleteSelection();
    push(`${faDigits(count)} جزء بریده شد.`, 'success');
  }, [canvas, deleteSelection, push]);

  const duplicateSelection = useCallback(() => {
    const snapshot = canvas.snapshot();
    const count = copyToClipboard(
      snapshot.nodes.filter((node) => node.selected),
      snapshot.edges
    );
    if (!count) {
      push('برای تکثیر، ابتدا یک یا چند جزء را انتخاب کنید.', 'info');
      return;
    }
    setClipCount(clipboardCount());
    const pasted = pasteFromClipboard(24);
    if (!pasted) return;
    applyCanvas((prev) => ({
      nodes: [...prev.nodes.map((node) => ({ ...node, selected: false })), ...pasted.nodes],
      edges: [...prev.edges.map((edge) => ({ ...edge, selected: false })), ...pasted.edges],
    }));
  }, [applyCanvas, canvas, push]);

  /* ---------- جابه‌جایی دقیق ---------- */

  const nudgeSelection = useCallback(
    (dx: number, dy: number) => {
      const snapshot = canvas.snapshot();
      if (!snapshot.nodes.some((node) => node.selected)) return;
      if (!nudgeSnapshot.current) {
        nudgeSnapshot.current = snapshot;
        canvas.pushSnapshot(snapshot);
      }
      if (nudgeTimer.current != null) window.clearTimeout(nudgeTimer.current);
      nudgeTimer.current = window.setTimeout(() => {
        nudgeSnapshot.current = null;
      }, 700);
      const round = (value: number) => (snapToGrid ? Math.round(value / 10) * 10 : value);
      // گام واگرد یک‌بار در آغاز رشتهٔ کلیدها ثبت شد؛ ادامهٔ حرکت گام تازه نمی‌سازد.
      const changed = canvas.apply(
        (prev) => ({
          ...prev,
          nodes: prev.nodes.map((node) =>
            node.selected
              ? { ...node, position: { x: round(node.position.x + dx), y: round(node.position.y + dy) } }
              : node
          ),
        }),
        false
      );
      if (changed) markDirty();
    },
    [canvas, markDirty, snapToGrid]
  );

  /* ---------------------------------------------------------------- */
  /* ذخیره                                                            */
  /* ---------------------------------------------------------------- */

  const save = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!detail || !canWrite || !editing || savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      const seq = mutationSeq.current;
      const snap = canvas.snapshot();
      try {
        const updated = await api.saveDiagramContent(detail.id, {
          revision: revisionRef.current,
          nodes: serializeNodes(snap.nodes),
          edges: serializeEdges(snap.edges),
        });
        setRevision(updated.revision);
        revisionRef.current = updated.revision;
        setDetail(updated);
        autoSaveBlocked.current = false;
        // اگر در فاصلهٔ درخواست تغییری رخ داده، دیاگرام همچنان «ذخیره‌نشده»
        // می‌ماند تا ذخیرهٔ بعدی آن را بفرستد.
        if (mutationSeq.current === seq) setDirty(false);
        if (!options.silent) push('دیاگرام ذخیره شد.', 'success');
        void loadList();
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          autoSaveBlocked.current = true;
          push('این دیاگرام در جای دیگری تغییر کرده است. با «بازخوانی» نسخهٔ تازه را بارگذاری کنید.', 'error');
        } else if (!options.silent) {
          push(e instanceof ApiError ? e.message : 'ذخیرهٔ دیاگرام ناموفق بود.', 'error');
        } else {
          push(e instanceof ApiError ? e.message : 'ذخیرهٔ خودکار ناموفق بود.', 'error');
        }
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [canvas, canWrite, detail, editing, loadList, push]
  );

  // ذخیرهٔ خودکار با تأخیر کوتاه پس از آخرین تغییر
  useEffect(() => {
    if (!editing || !dirty || !autoSave || dragging || autoSaveBlocked.current || saving) return;
    const timer = window.setTimeout(() => {
      void save({ silent: true });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [autoSave, dirty, dragging, editing, nodes, edges, save, saving]);

  const reload = useCallback(() => {
    if (!currentId) return;
    if (dirty && !window.confirm('تغییرات ذخیره‌نشده از دست می‌رود. نسخهٔ تازه بارگذاری شود؟')) return;
    api
      .diagram(currentId)
      .then((data) => {
        setDetail(data);
        canvas.replace({ nodes: data.nodes.map(toFlowNode), edges: data.edges.map(toFlowEdge) });
        setRevision(data.revision);
        revisionRef.current = data.revision;
        setDirty(false);
        autoSaveBlocked.current = false;
        push('نسخهٔ تازهٔ دیاگرام بارگذاری شد.', 'info');
      })
      .catch((e) => push(e instanceof ApiError ? e.message : 'بارگذاری مجدد ناموفق بود.', 'error'));
  }, [canvas, currentId, dirty, push]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  /* ---------------------------------------------------------------- */
  /* میان‌برهای صفحه‌کلید                                              */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = isTypingTarget(event.target);
      if (event.key === 'Escape') {
        setPending(null);
        setTool('select');
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
        return;
      }
      if (typing || !editing) return;
      const key = event.key.toLowerCase();
      if (mod && key === 'z' && !event.shiftKey) {
        event.preventDefault();
        if (canvas.undo()) markDirty();
        return;
      }
      if (mod && (key === 'y' || (key === 'z' && event.shiftKey))) {
        event.preventDefault();
        if (canvas.redo()) markDirty();
        return;
      }
      if (mod && key === 'c') {
        event.preventDefault();
        copySelection();
        return;
      }
      if (mod && key === 'x') {
        event.preventDefault();
        cutSelection();
        return;
      }
      if (mod && key === 'v') {
        event.preventDefault();
        pasteClipboard();
        return;
      }
      if (mod && key === 'd') {
        event.preventDefault();
        duplicateSelection();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canvas, copySelection, cutSelection, duplicateSelection, editing, markDirty, pasteClipboard, save]);

  // جابه‌جایی با کلیدهای جهت.
  //
  // React Flow خودش نیز با کلیدهای جهت، انتخاب را ۵ پیکسل (یا اندازهٔ شبکه)
  // جابه‌جا می‌کند و آن حرکت در تاریخچهٔ واگرد ثبت نمی‌شود. این شنونده در فاز
  // Capture اجرا می‌شود و رویداد را می‌بلعد تا فقط حرکت دقیق ۱/۱۰ پیکسلی خودمان
  // (با گام واگرد) اعمال شود.
  useEffect(() => {
    const onArrow = (event: KeyboardEvent) => {
      if (!event.key.startsWith('Arrow')) return;
      if (!editing || isTypingTarget(event.target)) return;
      if (!canvas.snapshot().nodes.some((node) => node.selected)) return;
      event.preventDefault();
      event.stopPropagation();
      const step = event.shiftKey ? 10 : 1;
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
      nudgeSelection(dx, dy);
    };
    window.addEventListener('keydown', onArrow, true);
    return () => window.removeEventListener('keydown', onArrow, true);
  }, [canvas, editing, nudgeSelection]);

  // با خروج از حالت ویرایش، ابزار مسلح و نقاط اتصال غیرفعال می‌شوند.
  useEffect(() => {
    if (!editing) {
      setPending(null);
      setTool('select');
    }
  }, [editing]);

  /* ---------------------------------------------------------------- */
  /* تصویر                                                            */
  /* ---------------------------------------------------------------- */

  const pickImage = useCallback(
    (nodeId?: string) => {
      if (!currentId) return;
      imageTargetNode.current = nodeId ?? null;
      imageInput.current?.click();
    },
    [currentId]
  );

  const onImageSelected = useCallback(
    async (file: File | null) => {
      if (!file || !currentId) return;
      if (!file.type.startsWith('image/')) {
        push('فقط فایل تصویری (PNG/JPEG/GIF/WebP) مجاز است.', 'warning');
        return;
      }
      setUploadingImage(true);
      try {
        const attachment = await api.uploadDiagramAttachment(currentId, file);
        const target = imageTargetNode.current;
        imageTargetNode.current = null;
        if (target) {
          patchNodeData(target, {
            src: attachment.downloadUrl,
            attachmentId: attachment.id,
            ...(file.name ? { caption: file.name.replace(/\.[^.]+$/, '') } : {}),
          });
          push('تصویر جایگزین شد.', 'success');
        } else {
          setPending({ kind: 'image', src: attachment.downloadUrl, attachmentId: attachment.id });
          push('روی بوم کلیک کنید تا تصویر قرار گیرد.', 'info');
        }
      } catch (e) {
        push(e instanceof ApiError ? e.message : 'بارگذاری تصویر ناموفق بود.', 'error');
      } finally {
        setUploadingImage(false);
      }
    },
    [currentId, patchNodeData, push]
  );

  /* ---------------------------------------------------------------- */
  /* خروجی                                                            */
  /* ---------------------------------------------------------------- */

  /** خروجی تصویر/PDF از کل بوم دیاگرام */
  const exportDiagram = useCallback(
    async (format: DiagramExportFormat) => {
      if (!canvasRef.current || exporting) return;
      setExporting(format);
      try {
        await canvasRef.current.exportImage(format);
        push(format === 'png' ? 'تصویر دیاگرام دانلود شد.' : 'خروجی PDF دیاگرام دانلود شد.', 'success');
      } catch (e) {
        push(e instanceof Error ? e.message : 'خروجی گرفتن ناموفق بود.', 'error');
      } finally {
        setExporting(null);
      }
    },
    [exporting, push]
  );

  const exportMeta = useMemo(
    () => ({
      name: detail?.name ?? 'دیاگرام شبکه',
      description: detail?.description ?? '',
      revision: detail?.revision ?? revision,
      updatedAt: detail?.updatedAt ?? Date.now(),
      createdBy: detail?.createdBy ?? '',
      siteName: settings?.site_name ?? 'NetWatch',
      timezoneOffset: settings?.timezone_offset_minutes ?? 210,
    }),
    [detail, revision, settings?.site_name, settings?.timezone_offset_minutes]
  );

  /* ---------------------------------------------------------------- */
  /* دیاگرام‌ها                                                        */
  /* ---------------------------------------------------------------- */

  const openDiagram = useCallback(
    (nextId: number) => {
      if (nextId === currentId) return;
      if (dirty && !window.confirm('تغییرات این دیاگرام ذخیره نشده است. بدون ذخیره ادامه می‌دهید؟')) return;
      setDirty(false);
      navigate(`/diagrams/${nextId}`);
    },
    [currentId, dirty, navigate]
  );

  const startCreate = useCallback((parentId: number | null) => {
    setDialog({ mode: 'create', parentId });
    setFormName('');
    setFormDescription('');
  }, []);

  const startEdit = useCallback((diagram: DiagramSummary) => {
    setDialog({ mode: 'edit', diagram });
    setFormName(diagram.name);
    setFormDescription(diagram.description);
  }, []);

  const submitDialog = useCallback(async () => {
    if (!dialog || busy) return;
    const name = formName.trim();
    if (!name) {
      push('نام دیاگرام را وارد کنید.', 'warning');
      return;
    }
    setBusy(true);
    try {
      if (dialog.mode === 'create') {
        const created = await api.createDiagram({ name, description: formDescription, parentId: dialog.parentId ?? null });
        setDialog(null);
        await loadList();
        navigate(`/diagrams/${created.id}`);
        push('دیاگرام ساخته شد.', 'success');
      } else if (dialog.diagram) {
        const updated = await api.updateDiagram(dialog.diagram.id, { name, description: formDescription });
        setDialog(null);
        await loadList();
        if (detail?.id === updated.id) setDetail((prev) => (prev ? { ...prev, name: updated.name, description: updated.description } : prev));
        push('اطلاعات دیاگرام به‌روزرسانی شد.', 'success');
      }
    } catch (e) {
      push(e instanceof ApiError ? e.message : 'عملیات ناموفق بود.', 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, detail?.id, dialog, formDescription, formName, loadList, navigate, push]);

  const confirmDelete = useCallback(
    async (diagram: DiagramSummary) => {
      const descendants = (() => {
        const ids = new Set<number>([diagram.id]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const item of list) {
            if (item.parentId != null && ids.has(item.parentId) && !ids.has(item.id)) {
              ids.add(item.id);
              grew = true;
            }
          }
        }
        return ids.size - 1;
      })();
      const message =
        descendants > 0
          ? `دیاگرام «${diagram.name}» و ${faDigits(descendants)} زیرمجموعهٔ آن حذف شوند؟ این عملیات بازگشت‌پذیر نیست.`
          : `دیاگرام «${diagram.name}» حذف شود؟ این عملیات بازگشت‌پذیر نیست.`;
      if (!window.confirm(message)) return;
      try {
        await api.deleteDiagram(diagram.id);
        setList((current) => current.filter((item) => !(item.id === diagram.id || item.parentId === diagram.id)));
        push('دیاگرام حذف شد.', 'success');
        const fresh = await api.diagrams();
        setList(fresh.items);
        if (currentId === diagram.id || !fresh.items.some((item) => item.id === currentId)) {
          if (fresh.items.length) navigate(`/diagrams/${fresh.items[0].id}`, { replace: true });
          else navigate('/diagrams', { replace: true });
        }
      } catch (e) {
        push(e instanceof ApiError ? e.message : 'حذف دیاگرام ناموفق بود.', 'error');
      }
    },
    [currentId, list, navigate, push]
  );

  const pendingHint = !pending
    ? null
    : pending.kind === 'device'
      ? pending.label
        ? `روی بوم کلیک کنید تا «${pending.label}» اضافه شود.`
        : 'روی بوم کلیک کنید تا تجهیز اضافه شود.'
      : pending.kind === 'group'
        ? 'روی بوم کلیک کنید تا کادر گروه اضافه شود.'
        : pending.kind === 'shape'
          ? pending.shape === 'circle'
            ? 'روی بوم کلیک کنید تا دایره اضافه شود.'
            : 'روی بوم کلیک کنید تا مستطیل اضافه شود.'
          : pending.kind === 'image'
            ? 'روی بوم کلیک کنید تا تصویر اضافه شود.'
            : 'روی بوم کلیک کنید تا یادداشت اضافه شود.';

  const selectedDevice = useMemo(() => {
    const deviceId = selectedNode?.data.deviceId ? Number(selectedNode.data.deviceId) : null;
    return deviceId ? devicesById.get(deviceId) ?? null : null;
  }, [devicesById, selectedNode]);

  return (
    <div>
      <input
        ref={imageInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0] ?? null;
          e.target.value = '';
          void onImageSelected(file);
        }}
      />

      {/* نوار بالای صفحه: نام، حالت، ذخیره و پنل */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {/* بستن پنل روی خود پنل است؛ این دکمه فقط پس از بستن پنل ظاهر می‌شود. */}
        {!panelOpen ? (
          <button
            type="button"
            className="btn-ghost btn-xs"
            onClick={() => setPanelOpen(true)}
            title="باز کردن پنل کناری"
            aria-label="باز کردن پنل کناری"
            aria-expanded={false}
          >
            <PanelLeftOpen size={15} />
          </button>
        ) : null}

        <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-50 text-brand-600">
          <Workflow size={15} />
        </span>
        <div className="min-w-0">
          <h2 className="truncate text-[13.5px] font-semibold text-ink-800">{detail?.name ?? 'دیاگرام شبکه'}</h2>
          <p className="text-[10px] text-ink-400">
            {detail ? `${faDigits(nodes.length)} جزء · ${faDigits(edges.length)} ارتباط` : 'دیاگرام مستقل با بوم اختصاصی'}
            {dirty ? ' · تغییرات ذخیره‌نشده' : ''}
            {!dirty && detail && editing ? ' · ذخیره‌شده' : ''}
          </p>
        </div>

        <div className="ms-auto flex items-center gap-1">
          {canWrite ? (
            <div className="flex items-center rounded-pill border border-ink-200 bg-white/80 p-0.5" role="group" aria-label="حالت نمایش">
              <button
                type="button"
                className={`inline-flex items-center gap-1 rounded-pill px-2 py-1 text-[11px] font-medium transition ${
                  mode === 'view' ? 'bg-white text-brand-700 shadow-soft' : 'text-ink-500'
                }`}
                onClick={() => setMode('view')}
                aria-pressed={mode === 'view'}
              >
                <Eye size={12} />
                نمایش
              </button>
              <button
                type="button"
                className={`inline-flex items-center gap-1 rounded-pill px-2 py-1 text-[11px] font-medium transition ${
                  mode === 'edit' ? 'bg-white text-brand-700 shadow-soft' : 'text-ink-500'
                }`}
                onClick={() => setMode('edit')}
                aria-pressed={mode === 'edit'}
              >
                <Pencil size={12} />
                ویرایش
              </button>
            </div>
          ) : null}

          <button
            type="button"
            className={`btn-ghost btn-xs ${titleBlock ? '!border-brand-300 !bg-brand-50 !text-brand-700' : ''}`}
            onClick={() => setTitleBlock((value) => !value)}
            aria-pressed={titleBlock}
            title="درج کادر عنوان و متادیتا در تصویر و PDF"
          >
            <Info size={14} />
            <span className="hidden lg:inline">کادر عنوان</span>
          </button>
          <button
            type="button"
            className="btn-ghost btn-xs"
            onClick={() => void exportDiagram('png')}
            disabled={!detail || !nodes.length || exporting !== null}
            title="دانلود تصویر PNG از دیاگرام"
            aria-label="خروجی تصویر"
          >
            <ImageIcon size={14} />
            <span className="hidden md:inline">{exporting === 'png' ? 'در حال ساخت…' : 'تصویر'}</span>
          </button>
          <button
            type="button"
            className="btn-ghost btn-xs"
            onClick={() => void exportDiagram('pdf')}
            disabled={!detail || !nodes.length || exporting !== null}
            title="دانلود خروجی PDF از دیاگرام"
            aria-label="خروجی PDF"
          >
            <FileText size={14} />
            <span className="hidden md:inline">{exporting === 'pdf' ? 'در حال ساخت…' : 'PDF'}</span>
          </button>
          <button type="button" className="btn-ghost btn-xs" onClick={reload} disabled={!currentId} title="بازخوانی دیاگرام">
            <RefreshCw size={14} />
          </button>
          {editing ? (
            <>
              <button
                type="button"
                className={`btn-ghost btn-xs ${autoSave ? '!text-emerald-700' : ''}`}
                onClick={() => setAutoSave((value) => !value)}
                aria-pressed={autoSave}
                title={autoSave ? 'ذخیرهٔ خودکار روشن است' : 'ذخیرهٔ خودکار خاموش است'}
              >
                <CheckCircle2 size={14} />
                <span className="hidden lg:inline">{autoSave ? 'ذخیرهٔ خودکار' : 'ذخیرهٔ دستی'}</span>
              </button>
              <button type="button" className="btn-primary btn-xs" onClick={() => void save()} disabled={saving || !dirty}>
                <Save size={14} />
                {saving ? 'در حال ذخیره…' : 'ذخیره'}
              </button>
            </>
          ) : null}
        </div>
      </div>

      <div className="diagram-workspace relative flex gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {editing ? (
            <DiagramToolbar
              tool={tool}
              pending={pending}
              connectionKind={connectionKind}
              selectedColor={selectedColor}
              hasSelection={hasSelection}
              selectedCount={selectedNodes.length}
              canUndo={canvas.canUndo}
              canRedo={canvas.canRedo}
              snapToGrid={snapToGrid}
              clipboardCount={clipCount}
              onSelectTool={() => {
                setTool('select');
                setPending(null);
              }}
              onConnectTool={() => {
                setTool('connect');
                setPending(null);
              }}
              onPickDevice={(key) => {
                setPending({ kind: 'device', deviceKey: key });
                setTool('select');
              }}
              onPickShape={(shape: DiagramShape) => {
                setPending({ kind: 'shape', shape });
                setTool('select');
              }}
              onPickNote={() => {
                setPending({ kind: 'note' });
                setTool('select');
              }}
              onPickGroup={() => {
                setPending({ kind: 'group' });
                setTool('select');
              }}
              onPickImage={() => pickImage()}
              onConnectionKind={changeConnectionKind}
              onColor={(color) => {
                if (selectedNode) patchNodeData(selectedNode.id, { color });
              }}
              onGroupColor={recolorSelection}
              onDelete={deleteSelection}
              onUndo={() => {
                if (canvas.undo()) markDirty();
              }}
              onRedo={() => {
                if (canvas.redo()) markDirty();
              }}
              onToggleSnap={() => setSnapToGrid((value) => !value)}
              onSyncDevices={syncAllDevices}
              syncing={syncing || devicesAsync.loading}
              onCopy={copySelection}
              onPaste={pasteClipboard}
              onDuplicate={duplicateSelection}
              onAlign={alignSelection}
              onDistribute={distributeSelection}
            />
          ) : null}

          <div className="min-h-0 flex-1">
            {detailLoading && !detail ? (
              <div className="grid h-full place-items-center rounded-2xl border border-ink-200/70 bg-white">
                <PageLoader label="در حال باز کردن دیاگرام…" />
              </div>
            ) : error ? (
              <div className="grid h-full place-items-center rounded-2xl border border-ink-200/70 bg-white p-6">
                <div className="text-center">
                  <AlertCircle size={26} className="mx-auto text-red-500" />
                  <p className="mt-2 text-[12.5px] text-ink-600">{error}</p>
                  <button type="button" className="btn-ghost btn-xs mt-3" onClick={reload}>
                    تلاش دوباره
                  </button>
                </div>
              </div>
            ) : currentId && detail ? (
              <ReactFlowProvider key={detail.id}>
                <DiagramCanvas
                  ref={canvasRef}
                  diagramName={detail.name}
                  placing={!!pending}
                  nodes={nodes}
                  edges={edges}
                  editing={editing}
                  connectable={tool === 'connect'}
                  onNodesChange={handleNodesChange}
                  onEdgesChange={handleEdgesChange}
                  onConnect={handleConnect}
                  onNodesDelete={handleNodesDelete}
                  onEdgesDelete={handleEdgesDelete}
                  onPaneClick={addAt}
                  onInspect={() => openPanel('inspector')}
                  onEdgeInspect={() => openPanel('inspector')}
                  pendingHint={pendingHint}
                  onCancelPending={() => {
                    setPending(null);
                    setTool('select');
                  }}
                  devices={devicesById}
                  onOpenDevice={openDevicePage}
                  exportMeta={exportMeta}
                  titleBlock={titleBlock}
                  snapToGrid={snapToGrid}
                  onDragStart={() => {
                    dragSnapshot.current = canvas.snapshot();
                    setDragging(true);
                  }}
                  onDragStop={() => {
                    setDragging(false);
                    const before = dragSnapshot.current;
                    dragSnapshot.current = null;
                    if (!before) return;
                    // فقط اگر موقعیت واقعاً عوض شده باشد یک گام واگرد ثبت می‌شود.
                    const after = canvas.snapshot();
                    if (before.nodes !== after.nodes) canvas.pushSnapshot(before);
                  }}
                />
              </ReactFlowProvider>
            ) : (
              <div className="grid h-full place-items-center rounded-2xl border border-ink-200/70 bg-white p-6">
                <EmptyState
                  title="دیاگرامی انتخاب نشده است"
                  description="از پنل کناری یک دیاگرام بسازید یا انتخاب کنید. هر دیاگرام بوم و اجزای مستقل خودش را دارد."
                  action={
                    <button type="button" className="btn-primary btn-xs" onClick={() => startCreate(null)}>
                      ساخت نخستین دیاگرام
                    </button>
                  }
                />
              </div>
            )}
          </div>
        </div>

        <aside
          className={`shrink-0 overflow-hidden transition-[width] duration-300 max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-20 ${
            panelOpen ? 'w-[300px] max-md:shadow-pop' : 'w-0'
          }`}
          aria-hidden={!panelOpen}
        >
          <div className="flex h-full w-[300px] flex-col overflow-hidden rounded-2xl border border-ink-200/70 bg-white/90 shadow-soft">
            <div className="flex shrink-0 items-center gap-1 border-b border-ink-100 px-2 py-1.5">
              <button
                type="button"
                className={`rounded-lg px-2 py-1 text-[11.5px] font-medium transition ${
                  panelTab === 'tree' ? 'bg-brand-50 text-brand-700' : 'text-ink-500 hover:bg-ink-50'
                }`}
                onClick={() => setPanelTab('tree')}
              >
                دیاگرام‌ها
              </button>
              <button
                type="button"
                className={`rounded-lg px-2 py-1 text-[11.5px] font-medium transition ${
                  panelTab === 'devices' ? 'bg-brand-50 text-brand-700' : 'text-ink-500 hover:bg-ink-50'
                }`}
                onClick={() => setPanelTab('devices')}
              >
                تجهیزات
              </button>
              <button
                type="button"
                className={`rounded-lg px-2 py-1 text-[11.5px] font-medium transition ${
                  panelTab === 'inspector' ? 'bg-brand-50 text-brand-700' : 'text-ink-500 hover:bg-ink-50'
                }`}
                onClick={() => setPanelTab('inspector')}
              >
                مشخصات
              </button>
              <button
                type="button"
                className="ms-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10.5px] text-ink-400 transition hover:bg-ink-50 hover:text-ink-700"
                onClick={() => setPanelOpen(false)}
                title="بستن پنل کناری"
                aria-label="بستن پنل کناری"
              >
                <X size={13} />
                بستن
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {panelTab === 'tree' ? (
                <DiagramTree
                  items={list}
                  currentId={currentId}
                  loading={listLoading}
                  onOpen={openDiagram}
                  onCreate={startCreate}
                  onEdit={startEdit}
                  onDelete={(diagram) => void confirmDelete(diagram)}
                  onRefresh={() => void loadList()}
                />
              ) : panelTab === 'devices' ? (
                <DiagramDevicePalette editing={editing} onPick={pickDeviceFromList} />
              ) : detail ? (
                <DiagramInspector
                  editing={editing}
                  diagram={detail}
                  nodes={nodes}
                  edges={edges}
                  node={selectedNode}
                  edge={selectedEdge}
                  onPatchData={patchNodeData}
                  onPatchNode={patchNodeSize}
                  onPatchEdge={patchEdge}
                  onDeleteNode={removeNode}
                  onDeleteEdge={removeEdge}
                  device={selectedDevice}
                  onSyncDevice={syncNodeWithDevice}
                  onOpenDevice={openDevicePage}
                  onPingDevice={pingDevice}
                  onReplaceImage={(nodeId) => pickImage(nodeId)}
                />
              ) : (
                <p className="p-4 text-center text-[11px] text-ink-400">دیاگرامی انتخاب نشده است.</p>
              )}
            </div>
          </div>
        </aside>
      </div>

      {uploadingImage ? (
        <div className="pointer-events-none fixed bottom-4 right-4 z-[1000] rounded-pill border border-ink-200 bg-white/95 px-3 py-1.5 text-[11.5px] text-ink-600 shadow-pop">
          در حال بارگذاری تصویر…
        </div>
      ) : null}

      <Modal
        open={!!dialog}
        onClose={() => setDialog(null)}
        title={dialog?.mode === 'create' ? 'دیاگرام جدید' : 'ویرایش اطلاعات دیاگرام'}
        subtitle={
          dialog?.mode === 'create'
            ? dialog.parentId
              ? 'این دیاگرام به‌عنوان زیرمجموعهٔ دیاگرام فعلی ساخته می‌شود و بوم مستقل دارد.'
              : 'یک دیاگرام ریشه با بوم خالی ساخته می‌شود.'
            : 'نام و توضیح دیاگرام را تغییر دهید.'
        }
        size="sm"
        footer={
          <>
            <button type="button" className="btn-ghost btn-xs" onClick={() => setDialog(null)} disabled={busy}>
              انصراف
            </button>
            <button type="button" className="btn-primary btn-xs" onClick={() => void submitDialog()} disabled={busy}>
              {busy ? 'در حال ذخیره…' : dialog?.mode === 'create' ? 'ساخت دیاگرام' : 'ذخیره'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="نام دیاگرام" required>
            <input
              className="field"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="مثلاً شبکهٔ شهر تهران"
              autoFocus
              maxLength={120}
            />
          </Field>
          <Field label="توضیحات" hint="اختیاری — برای یادآوری محدوده و هدف این دیاگرام">
            <textarea
              className="field min-h-20 resize-y"
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              maxLength={2000}
            />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
