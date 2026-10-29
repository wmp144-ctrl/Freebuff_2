/**
 * بوم دیاگرام — React Flow با گره‌های تجهیز/شکل/یادداشت و یال‌های نوع‌دار.
 *
 * • در هر چهار سمت هر جزء نقطهٔ اتصال وجود دارد؛ با ConnectionMode.Loose
 *   می‌توان از هر سمت به هر سمت دیگر کشید.
 * • یال به شناسهٔ نقطهٔ اتصال بسته است، پس با جابه‌جایی یا تغییر اندازهٔ
 *   تجهیز، ارتباط خودبه‌خود روی همان نقطه می‌ماند.
 * • در حالت نمایش، جابه‌جایی و نقاط اتصال غیرفعال‌اند و فقط انتخاب/مشاهده
 *   انجام می‌شود.
 * • «گروه» کادر کم‌رنگ پشت همهٔ اجزاست و نقطهٔ اتصال ندارد؛ هنگام افزودن
 *   جزء تازه، کلیک از روی گروه عبور می‌کند تا افزودن روی بوم مختل نشود.
 * • خروجی تصویر/PDF از نمای بوم با همان چیدمان و ظاهر گرفته می‌شود.
 */
import React, { createContext, forwardRef, useCallback, useContext, useImperativeHandle, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  ConnectionMode,
  Controls,
  EdgeLabelRenderer,
  Handle,
  NodeResizer,
  Position,
  ReactFlow,
  getNodesBounds,
  getSmoothStepPath,
  useReactFlow,
} from '@xyflow/react';
import type {
  Connection,
  EdgeProps,
  EdgeTypes,
  NodeProps,
  NodeTypes,
  OnEdgesChange,
  OnNodesChange,
} from '@xyflow/react';
import { ImageOff, Link2, StickyNote } from 'lucide-react';
import { toPng } from 'html-to-image';
import '@xyflow/react/dist/style.css';
import { GRID_SIZE, GROUP_DEFAULT_COLOR, HANDLE_SIDES, connectionType, contrastText, deviceType } from '../../lib/diagrams';
import { composeExportSheet, downloadDataUrl, downloadDiagramPdf, safeFileName } from '../../lib/diagram-export';
import type { ExportMeta } from '../../lib/diagram-export';
import type { DiagramFlowEdge, DiagramFlowNode, HandleSide } from '../../lib/diagrams';
import type { Device, DiagramConnectionKind } from '../../lib/types';
import { fmtMs, fmtPct, fmtRelative, statusMeta } from '../../lib/format';
import { useDeviceLive } from '../../lib/store';
import { DeviceGlyph } from './DeviceGlyph';

const EMPTY_DEVICES = new Map<number, Device>();

const TOOL_CONTEXT = createContext({
  editing: false,
  connectable: false,
  placing: false,
  exporting: false,
  devices: EMPTY_DEVICES,
  onOpenDevice: (_id: number) => {},
});

const POSITIONS: Record<HandleSide, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

function SideHandles({ color }: { color: string }) {
  const { connectable, exporting } = useContext(TOOL_CONTEXT);
  // نقاط اتصال در خروجی تصویر دیده نمی‌شوند.
  if (exporting) return null;
  return (
    <>
      {HANDLE_SIDES.map((side) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={POSITIONS[side]}
          isConnectable={connectable}
          className={`diagram-handle ${connectable ? 'is-active' : ''}`}
          style={{ borderColor: color }}
        />
      ))}
    </>
  );
}

const nodeFrame = 'relative h-full w-full';

function DeviceNode({ data, selected }: NodeProps<DiagramFlowNode>) {
  const { editing, exporting, devices, onOpenDevice } = useContext(TOOL_CONTEXT);
  const meta = deviceType(data.deviceType);
  const color = data.color || meta.color;
  const active = editing && selected && !exporting;
  const deviceId = data.deviceId ? Number(data.deviceId) : null;
  const device = deviceId ? devices.get(deviceId) ?? null : null;
  // نمونهٔ زنده فقط برای تجهیزات متصل به مانیتورینگ؛ هر گره خودش مشترک می‌شود
  // و سرور نمونهٔ همان تجهیز را می‌فرستد.
  const sample = useDeviceLive(deviceId ?? undefined);
  const status = sample?.status ?? device?.status ?? null;
  const statusInfo = status ? statusMeta(status) : null;
  const rtt = sample?.rtt ?? device?.lastRtt ?? null;
  const loss = sample?.lossPct ?? device?.lossPct ?? null;
  const lastCheck = sample?.ts ?? device?.lastCheckAt ?? null;
  const ring = statusInfo && status !== 'unknown' ? statusInfo.chart : null;

  return (
    <div className={nodeFrame} dir="rtl">
      <NodeResizer
        isVisible={!!active}
        minWidth={110}
        minHeight={64}
        color={color}
        lineClassName="diagram-resize-line"
        handleClassName="diagram-resize-handle"
      />
      <SideHandles color={color} />
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded-2xl border bg-white px-2 py-1 text-center shadow-soft transition-shadow"
        style={{
          borderColor: active ? color : ring ? `${ring}99` : '#e2e8f0',
          boxShadow: active
            ? `0 0 0 2px ${color}33`
            : ring
              ? `0 0 0 2px ${ring}33`
              : undefined,
        }}
        onDoubleClick={() => {
          if (deviceId && !exporting) onOpenDevice(deviceId);
        }}
        title={
          deviceId
            ? `${data.label}${data.ip ? ` · ${data.ip}` : ''}${
                statusInfo ? ` · ${statusInfo.label}` : ''
              }${lastCheck ? ` · آخرین بررسی ${fmtRelative(lastCheck)}` : ''}`
            : undefined
        }
      >
        <span
          className="grid place-items-center rounded-lg p-1"
          style={{ background: `${color}18`, color }}
        >
          <DeviceGlyph icon={meta.icon} size={16} />
        </span>
        <p className="max-w-full truncate text-[12px] font-semibold leading-4 text-ink-800">
          {data.label || meta.label}
        </p>
        {deviceId && statusInfo ? (
          <span className="flex max-w-full items-center gap-1 text-[9.5px] leading-3">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusInfo.dot}`} aria-hidden />
            <span className={`truncate font-medium ${statusInfo.text}`}>{statusInfo.label}</span>
            {rtt != null ? <span className="num truncate text-ink-400">· {fmtMs(rtt)}</span> : null}
            {loss != null && loss > 0 ? <span className="num truncate text-ink-400">· {fmtPct(loss, 0)}</span> : null}
          </span>
        ) : (
          <p className="max-w-full truncate text-[9.5px] leading-3 text-ink-400">
            {data.model ? data.model : meta.label}
          </p>
        )}
      </div>
    </div>
  );
}

/** تصویر/لوگوی پیوست‌شده؛ در حالت نمایش فقط نمایش داده می‌شود. */
function ImageNode({ data, selected }: NodeProps<DiagramFlowNode>) {
  const { editing, exporting } = useContext(TOOL_CONTEXT);
  const active = editing && selected && !exporting;
  const src = typeof data.src === 'string' ? data.src : '';
  return (
    <div className={nodeFrame} dir="rtl">
      <NodeResizer
        isVisible={!!active}
        minWidth={80}
        minHeight={60}
        color="#0ea5e9"
        lineClassName="diagram-resize-line"
        handleClassName="diagram-resize-handle"
      />
      <div
        className="flex h-full w-full flex-col overflow-hidden rounded-xl border bg-white shadow-soft"
        style={{
          borderColor: active ? '#0ea5e9' : '#e2e8f0',
          boxShadow: active ? '0 0 0 2px #0ea5e933' : undefined,
        }}
      >
        {src ? (
          <img
            src={src}
            alt={String(data.caption || data.label || 'تصویر دیاگرام')}
            className="min-h-0 w-full flex-1 object-contain"
            draggable={false}
          />
        ) : (
          <div className="grid min-h-0 flex-1 place-items-center bg-ink-50 text-ink-300">
            <ImageOff size={22} />
          </div>
        )}
        {data.caption ? (
          <p className="shrink-0 truncate border-t border-ink-100 px-1.5 py-1 text-center text-[9.5px] text-ink-500">
            {String(data.caption)}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * کادر گروه: مستطیل رنگی کم‌رنگ و خط‌چین که پشت سایر اجزا می‌نشیند.
 * برچسب گروه در بالای کادر و توضیح اختیاری زیر آن نمایش داده می‌شود.
 */
function GroupNode({ data, selected }: NodeProps<DiagramFlowNode>) {
  const { editing, placing, exporting } = useContext(TOOL_CONTEXT);
  const color = String(data.color || GROUP_DEFAULT_COLOR);
  const active = editing && selected && !exporting;
  return (
    <div className={`${nodeFrame} ${placing ? 'pointer-events-none' : ''}`} dir="rtl">
      <NodeResizer
        isVisible={!!active}
        minWidth={160}
        minHeight={120}
        color={color}
        lineClassName="diagram-resize-line"
        handleClassName="diagram-resize-handle"
      />
      <div
        className="flex h-full w-full flex-col overflow-hidden rounded-xl border-2 border-dashed"
        style={{
          background: `${color}14`,
          borderColor: `${color}aa`,
          boxShadow: active ? `0 0 0 2px ${color}55` : undefined,
        }}
      >
        <div className="flex shrink-0 items-center gap-1.5 px-2.5 pt-1.5">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
          <span className="truncate text-[11.5px] font-semibold text-ink-700">{data.label || 'گروه'}</span>
        </div>
        {data.text ? (
          <p className="shrink-0 whitespace-pre-wrap break-words px-2.5 pt-0.5 text-[10px] leading-4 text-ink-500">
            {String(data.text)}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ShapeNode({ data, selected }: NodeProps<DiagramFlowNode>) {
  const { editing, exporting } = useContext(TOOL_CONTEXT);
  const color = data.color || '#dbeafe';
  const circle = data.shape === 'circle';
  const text = String(data.text ?? '');
  const active = selected && !exporting;
  return (
    <div className={nodeFrame} dir="rtl">
      <NodeResizer
        isVisible={editing && !!active}
        minWidth={60}
        minHeight={60}
        color="#64748b"
        lineClassName="diagram-resize-line"
        handleClassName="diagram-resize-handle"
      />
      <SideHandles color="#64748b" />
      <div
        className={`flex h-full w-full items-center justify-center overflow-hidden border border-black/10 px-2 text-center ${
          circle ? 'rounded-full' : 'rounded-soft'
        }`}
        style={{
          background: color,
          color: contrastText(color),
          boxShadow: active ? '0 0 0 2px rgba(37,99,235,0.35)' : undefined,
          paddingInline: circle ? '18%' : undefined,
        }}
      >
        <span className="whitespace-pre-wrap break-words text-[12px] font-medium leading-5">
          {text || (circle ? 'دایره' : 'مستطیل')}
        </span>
      </div>
    </div>
  );
}

function NoteNode({ data, selected }: NodeProps<DiagramFlowNode>) {
  const { editing, exporting } = useContext(TOOL_CONTEXT);
  const color = data.color || '#fef08a';
  const active = editing && selected && !exporting;
  return (
    <div className={nodeFrame} dir="rtl">
      <NodeResizer
        isVisible={!!active}
        minWidth={120}
        minHeight={80}
        color="#ca8a04"
        lineClassName="diagram-resize-line"
        handleClassName="diagram-resize-handle"
      />
      <SideHandles color="#ca8a04" />
      <div
        className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-amber-300/80 p-2 text-right shadow-soft"
        style={{ background: color, boxShadow: active ? '0 0 0 2px rgba(202,138,4,0.35)' : undefined }}
      >
        <span className="mb-1 flex shrink-0 items-center gap-1 text-[10px] font-medium text-ink-500">
          <StickyNote size={11} />
          <span className="truncate">{data.label || 'یادداشت'}</span>
        </span>
        <p className="min-h-0 flex-1 overflow-hidden whitespace-pre-wrap break-words text-[12px] leading-5 text-ink-700">
          {String(data.text ?? '') || 'متن یادداشت…'}
        </p>
      </div>
    </div>
  );
}

function ConnectionEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<DiagramFlowEdge>) {
  const { exporting } = useContext(TOOL_CONTEXT);
  const active = selected && !exporting;
  const meta = connectionType(data?.kind as DiagramConnectionKind | undefined);
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 14,
    offset: 18,
  });
  const label = data?.label || meta.label;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: meta.color,
          strokeWidth: active ? meta.width + 1.5 : meta.width,
          strokeDasharray: meta.dash || undefined,
          filter: active ? `drop-shadow(0 0 3px ${meta.color}66)` : undefined,
        }}
      />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-none absolute"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          dir="rtl"
        >
          <span
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-pill border bg-white/95 px-1.5 py-0.5 text-[9.5px] font-medium shadow-xs"
            style={{ borderColor: `${meta.color}66`, color: meta.color }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />
            {label}
          </span>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = {
  device: DeviceNode,
  shape: ShapeNode,
  note: NoteNode,
  group: GroupNode,
  image: ImageNode,
} satisfies NodeTypes;

const edgeTypes = {
  diagram: ConnectionEdge,
} satisfies EdgeTypes;

export type DiagramExportFormat = 'png' | 'pdf';

export interface DiagramCanvasHandle {
  /** خروجی گرفتن از کل بوم (همهٔ اجزا، نه فقط بخش دیده‌شده) */
  exportImage: (format: DiagramExportFormat) => Promise<void>;
}

export interface DiagramCanvasProps {
  nodes: DiagramFlowNode[];
  edges: DiagramFlowEdge[];
  editing: boolean;
  connectable: boolean;
  /** نام دیاگرام برای نام فایل خروجی */
  diagramName: string;
  /** جزئی برای افزودن روی بوم مسلح شده است (گروه‌ها کلیک را نمی‌گیرند) */
  placing?: boolean;
  onNodesChange: OnNodesChange<DiagramFlowNode>;
  onEdgesChange: OnEdgesChange<DiagramFlowEdge>;
  onConnect: (connection: Connection) => void;
  onNodesDelete: (nodes: DiagramFlowNode[]) => void;
  onEdgesDelete: (edges: DiagramFlowEdge[]) => void;
  onPaneClick: (position: { x: number; y: number }) => void;
  onInspect: () => void;
  onEdgeInspect: () => void;
  pendingHint: string | null;
  onCancelPending: () => void;
  /** تجهیزات مانیتورینگ برای نمایش وضعیت زنده روی گره‌ها */
  devices?: Map<number, Device>;
  /** باز کردن صفحهٔ تجهیز با دوبار کلیک روی گره */
  onOpenDevice?: (deviceId: number) => void;
  /** فرادادهٔ کادر عنوان در خروجی */
  exportMeta: Omit<ExportMeta, 'nodeCount' | 'edgeCount'>;
  /** درج کادر عنوان/متادیتا در تصویر و PDF */
  titleBlock?: boolean;
  /** چسبیدن به شبکه */
  snapToGrid?: boolean;
  onDragStart?: () => void;
  onDragStop?: () => void;
}

const DiagramCanvas = forwardRef<DiagramCanvasHandle, DiagramCanvasProps>(function DiagramCanvas({
  nodes,
  edges,
  editing,
  connectable,
  diagramName,
  placing = false,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodesDelete,
  onEdgesDelete,
  onPaneClick,
  onInspect,
  onEdgeInspect,
  pendingHint,
  onCancelPending,
  devices,
  onOpenDevice,
  exportMeta,
  titleBlock = true,
  snapToGrid = false,
  onDragStart,
  onDragStop,
}: DiagramCanvasProps, ref) {
  const { screenToFlowPosition, flowToScreenPosition, getNodes } = useReactFlow();
  const hostRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  const [guides, setGuides] = useState<{ v: number[]; h: number[] }>({ v: [], h: [] });

  /**
   * خطوط راهنمای تراز: اگر لبه/مرکز جزء در حرکت با لبه/مرکز جزء دیگری در
   * فاصلهٔ کمتر از ۶ پیکسل باشد، خط راهنما نمایش داده می‌شود.
   */
  const computeGuides = useCallback(
    (dragged: DiagramFlowNode) => {
      const width = dragged.width ?? dragged.measured?.width ?? 190;
      const height = dragged.height ?? dragged.measured?.height ?? 86;
      const tolerance = 6;
      const vertical: number[] = [];
      const horizontal: number[] = [];
      const mineX = [dragged.position.x, dragged.position.x + width / 2, dragged.position.x + width];
      const mineY = [dragged.position.y, dragged.position.y + height / 2, dragged.position.y + height];
      for (const other of getNodes()) {
        if (other.id === dragged.id) continue;
        const ow = other.width ?? other.measured?.width ?? 190;
        const oh = other.height ?? other.measured?.height ?? 86;
        const otherX = [other.position.x, other.position.x + ow / 2, other.position.x + ow];
        const otherY = [other.position.y, other.position.y + oh / 2, other.position.y + oh];
        for (const edge of otherX) {
          if (mineX.some((value) => Math.abs(value - edge) <= tolerance) && !vertical.includes(edge)) {
            vertical.push(edge);
          }
        }
        for (const edge of otherY) {
          if (mineY.some((value) => Math.abs(value - edge) <= tolerance) && !horizontal.includes(edge)) {
            horizontal.push(edge);
          }
        }
      }
      setGuides({ v: vertical, h: horizontal });
    },
    [getNodes]
  );

  // برای گرفتن خروجی، همهٔ اجزا باید در DOM باشند؛ در حالت عادی فقط اجزای
  // دیدنی رندر می‌شوند. یک تیک صبر می‌کنیم تا رندر کامل شود و بعد عکس می‌گیریم.
  const exportImage = useCallback(
    async (format: DiagramExportFormat) => {
      const host = hostRef.current;
      if (!host) throw new Error('بوم دیاگرام در دسترس نیست.');
      setExporting(true);
      try {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        await new Promise((resolve) => setTimeout(resolve, 120));
        const current = getNodes();
        if (!current.length) throw new Error('این دیاگرام هیچ جزئی برای خروجی ندارد.');
        const viewport = host.querySelector<HTMLElement>('.react-flow__viewport');
        if (!viewport) throw new Error('نمای بوم پیدا نشد.');

        const bounds = getNodesBounds(current);
        const padding = 48;
        const width = Math.max(360, Math.ceil(bounds.width + padding * 2));
        const height = Math.max(240, Math.ceil(bounds.height + padding * 2));
        const longest = Math.max(width, height);
        // برای بوم‌های بزرگ، مقیاس را پایین می‌آوریم تا حجم تصویر مهار شود.
        const pixelRatio = Math.min(2, Math.max(0.6, 2600 / longest));

        const png = await toPng(viewport, {
          width,
          height,
          backgroundColor: '#ffffff',
          pixelRatio,
          style: {
            width: `${width}px`,
            height: `${height}px`,
            transform: `translate(${(-bounds.x + padding).toFixed(2)}px, ${(-bounds.y + padding).toFixed(2)}px) scale(1)`,
            transformOrigin: '0 0',
          },
        });

        // کادر عنوان/متادیتا در یک برگهٔ واحد با تصویر ترکیب می‌شود تا خروجی
        // برای چاپ و بایگانی شناسنامه داشته باشد.
        const sheet = titleBlock
          ? await composeExportSheet(png, {
              ...exportMeta,
              nodeCount: current.length,
              edgeCount: edges.length,
            })
          : png;

        if (format === 'png') downloadDataUrl(sheet, safeFileName(diagramName, 'png'));
        else await downloadDiagramPdf(sheet, safeFileName(diagramName, 'pdf'));
      } finally {
        setExporting(false);
      }
    },
    [diagramName, edges.length, exportMeta, getNodes, titleBlock]
  );

  useImperativeHandle(ref, () => ({ exportImage }), [exportImage]);

  return (
    <TOOL_CONTEXT.Provider
      value={{ editing, connectable, placing, exporting, devices: devices ?? EMPTY_DEVICES, onOpenDevice: onOpenDevice ?? (() => {}) }}
    >
      <div ref={hostRef} className="relative h-full w-full overflow-hidden rounded-2xl border border-ink-200/70 bg-white" dir="ltr">
        <ReactFlow<DiagramFlowNode, DiagramFlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodesDelete={onNodesDelete}
          onEdgesDelete={onEdgesDelete}
          onNodeClick={onInspect}
          onEdgeClick={onEdgeInspect}
          onNodeDragStart={() => {
            onDragStart?.();
          }}
          onNodeDrag={(_event, node) => {
            if (editing) computeGuides(node);
          }}
          onNodeDragStop={() => {
            setGuides({ v: [], h: [] });
            onDragStop?.();
          }}
          snapToGrid={snapToGrid}
          snapGrid={[GRID_SIZE, GRID_SIZE]}
          onPaneClick={(event) => {
            if (!editing) return;
            const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
            if (position) onPaneClick(position);
          }}
          nodesDraggable={editing}
          nodesConnectable={editing && connectable}
          // انتخاب یک جزء نباید ترتیب لایه‌ها را عوض کند؛ وگرنه گروه انتخاب‌شده
          // روی تجهیزات می‌آید و کلیک آن‌ها را می‌گیرد.
          elevateNodesOnSelect={false}
          elementsSelectable
          connectionMode={ConnectionMode.Loose}
          deleteKeyCode={editing ? ['Backspace', 'Delete'] : null}
          multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
          zoomOnDoubleClick={false}
          minZoom={0.2}
          maxZoom={2.5}
          fitView
          fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
          onlyRenderVisibleElements={!exporting}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#cbd5e1" />
          <Controls position="bottom-left" showInteractive={false} />
        </ReactFlow>

        {/* خطوط راهنمای تراز (فقط زمان جابه‌جایی) */}
        {editing && (guides.v.length > 0 || guides.h.length > 0) ? (
          <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" dir="ltr" aria-hidden>
            {guides.v.map((x) => {
              const screen = flowToScreenPosition({ x, y: 0 });
              return (
                <span
                  key={`v-${x}`}
                  className="absolute top-0 h-full w-px bg-brand-400/80"
                  style={{ left: Math.round(screen.x) }}
                />
              );
            })}
            {guides.h.map((y) => {
              const screen = flowToScreenPosition({ x: 0, y });
              return (
                <span
                  key={`h-${y}`}
                  className="absolute start-0 w-full h-px bg-brand-400/80"
                  style={{ top: Math.round(screen.y) }}
                />
              );
            })}
          </div>
        ) : null}

        {pendingHint ? (
          <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2" dir="rtl">
            <div className="pointer-events-auto flex items-center gap-2 rounded-pill border border-brand-200 bg-white/95 px-3 py-1.5 text-[11.5px] font-medium text-brand-700 shadow-pop">
              <Link2 size={13} />
              {pendingHint}
              <button type="button" className="btn-ghost btn-xs" onClick={onCancelPending}>
                لغو
              </button>
            </div>
          </div>
        ) : null}

        {!nodes.length ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center p-6" dir="rtl">
            <div className="max-w-sm rounded-2xl border border-dashed border-ink-200 bg-white/80 px-6 py-5 text-center backdrop-blur">
              <p className="text-sm font-semibold text-ink-700">بوم این دیاگرام خالی است</p>
              <p className="mt-1 text-[11.5px] leading-5 text-ink-500">
                {editing
                  ? 'از نوار ابزار، تجهیز یا شکل اضافه کنید؛ سپس با ابزار اتصال، نقاط کنار اجزا را به هم وصل کنید.'
                  : 'برای افزودن تجهیز و ارتباط، حالت ویرایش را فعال کنید.'}
              </p>
            </div>
          </div>
        ) : null}

        {editing && connectable ? (
          <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-pill border border-ink-200 bg-white/95 px-3 py-1 text-[10.5px] text-ink-500 shadow-soft" dir="rtl">
            از نقطهٔ اتصال یک جزء بکشید و روی نقطهٔ اتصال جزء دیگر رها کنید.
          </div>
        ) : null}
      </div>
    </TOOL_CONTEXT.Provider>
  );
});

export default DiagramCanvas;
