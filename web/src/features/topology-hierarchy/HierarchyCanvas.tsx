/**
 * بوم تعاملی توپولوژی
 * ----------------------------------------------------------------
 * `@xyflow/react` با گره‌های سفارشی و لینک‌های رسانه‌محور. جابه‌جایی،
 * بزرگ‌نمایی، جا‌زدن در کادر و انتخاب در همین بوم انجام می‌شود؛ جهت بوم
 * عمداً LTR است تا مختصات و کنترل‌ها رفتار استاندارد داشته باشند، اما
 * محتوای گره‌ها و برچسب‌ها راست‌به‌چپ است.
 */
import { useEffect } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  useReactFlow,
  type EdgeMouseHandler,
  type EdgeTypes,
  type NodeMouseHandler,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { faDigits } from '../../lib/format';
import type { Point } from '../../lib/topology-hierarchy';
import HierarchyNodeCard, { HIERARCHY_NODE_TYPE, type HierarchyFlowNode } from './HierarchyNode';
import MediumEdge, { MEDIUM_EDGE_TYPE, type MediumFlowEdge } from './MediumEdge';
import { MediaLegend } from './MediaLegend';

const nodeTypes = { [HIERARCHY_NODE_TYPE]: HierarchyNodeCard } as unknown as NodeTypes;
const edgeTypes = { [MEDIUM_EDGE_TYPE]: MediumEdge } as unknown as EdgeTypes;

interface Props {
  nodes: HierarchyFlowNode[];
  edges: MediumFlowEdge[];
  edit: boolean;
  fitToken: number;
  focus: { id: string; token: number } | null;
  scopeTitle: string;
  scopeHint: string;
  visibleCount: number;
  linkCount: number;
  onNodeSelect: (id: string) => void;
  onEdgeSelect: (id: string) => void;
  onDrill: (id: string) => void;
  onPaneClick: () => void;
  onNodeDragStop: (id: string, position: Point) => void;
  emptyLabel?: string;
  className?: string;
}

export default function HierarchyCanvas({
  nodes,
  edges,
  edit,
  fitToken,
  focus,
  scopeTitle,
  scopeHint,
  visibleCount,
  linkCount,
  onNodeSelect,
  onEdgeSelect,
  onDrill,
  onPaneClick,
  onNodeDragStop,
  emptyLabel,
  className = '',
}: Props) {
  const instance = useReactFlow();

  useEffect(() => {
    if (!fitToken) return;
    const timer = window.setTimeout(() => {
      void instance.fitView({ padding: 0.18, duration: 420 });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [fitToken, instance]);

  useEffect(() => {
    if (!focus) return;
    const timer = window.setTimeout(() => {
      const node = instance.getNode(focus.id);
      if (!node) return;
      const width = node.measured?.width ?? 196;
      const height = node.measured?.height ?? 92;
      void instance.setCenter(node.position.x + width / 2, node.position.y + height / 2, {
        zoom: 1.2,
        duration: 420,
      });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [focus, instance, nodes]);

  const handleNodeClick: NodeMouseHandler<HierarchyFlowNode> = (_event, node) => onNodeSelect(node.id);
  const handleNodeDoubleClick: NodeMouseHandler<HierarchyFlowNode> = (_event, node) => onDrill(node.id);
  const handleEdgeClick: EdgeMouseHandler<MediumFlowEdge> = (_event, edge) => onEdgeSelect(edge.id);

  return (
    <div
      className={`relative overflow-hidden rounded-card border border-ink-200/70 bg-white shadow-soft ${className}`}
    >
      <div dir="ltr" className="h-full w-full">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.2}
          maxZoom={1.8}
          nodesDraggable={edit}
          nodesConnectable={false}
          elementsSelectable
          zoomOnDoubleClick={false}
          onlyRenderVisibleElements
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={handleNodeDoubleClick}
          onEdgeClick={handleEdgeClick}
          onPaneClick={onPaneClick}
          onNodeDragStop={(_event, node) => onNodeDragStop(node.id, node.position)}
          className="nw-topology-flow"
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} color="#cbd5e1" />
          <Controls
            showInteractive={false}
            className="!rounded-soft !border !border-ink-200 !bg-white/95 !shadow-soft"
          />
        </ReactFlow>
      </div>

      {/* عنوان دامنهٔ جاری */}
      <div
        dir="rtl"
        className="pointer-events-none absolute right-3 top-3 z-10 max-w-[250px] rounded-soft border border-white/70 bg-white/92 px-3 py-2 shadow-soft backdrop-blur-xl"
      >
        <p className="truncate text-[11.5px] font-semibold text-ink-800">{scopeTitle}</p>
        <p className="mt-0.5 text-[10px] leading-4 text-ink-500">{scopeHint}</p>
        <p className="num mt-1 text-[9.5px] text-ink-400">
          {faDigits(visibleCount)} گره · {faDigits(linkCount)} لینک
        </p>
      </div>

      <MediaLegend className="pointer-events-none absolute left-3 top-3 z-10 hidden md:block" />

      {edit ? (
        <div
          dir="rtl"
          className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-pill border border-sun-200 bg-sun-50/95 px-3 py-1 text-[10px] font-medium text-sun-700 shadow-soft"
        >
          حالت ویرایش — جابه‌جایی گره‌ها فقط در همین نشست می‌ماند و ذخیره نمی‌شود
        </div>
      ) : null}

      {nodes.length === 0 ? (
        <div dir="rtl" className="absolute inset-0 z-10 grid place-items-center bg-white/75 p-6 text-center">
          <p className="max-w-xs text-[12px] leading-6 text-ink-500">
            {emptyLabel ?? 'در این سطح گره‌ای برای نمایش نیست.'}
          </p>
        </div>
      ) : null}
    </div>
  );
}
