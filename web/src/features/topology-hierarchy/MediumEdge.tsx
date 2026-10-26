/**
 * لینک بوم توپولوژی
 * ----------------------------------------------------------------
 * رسانهٔ انتقال، الگوی خط را تعیین می‌کند:
 *   فیبر نوری        → سبز آبی پیوسته
 *   بی‌سیم/رادیویی   → بنفش خط‌چین
 *   اترنت/مسی        → آبی نقطه‌چین
 *   VPN/تونل منطقی   → کهربایی نقطه‌خط
 * لینک قطع‌شده کم‌رنگ می‌شود و برچسب «قطع» می‌گیرد.
 */
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react';
import { MEDIA_META, type TopologyEdgeModel } from '../../lib/topology-hierarchy';
import { fmtBandwidth, fmtLatency } from './format';

export const MEDIUM_EDGE_TYPE = 'medium';

export type MediumEdgeData = {
  edge: TopologyEdgeModel;
  /** با جست‌وجو هم‌خوان نیست → محو می‌شود */
  dimmed?: boolean;
};

export type MediumFlowEdge = Edge<MediumEdgeData, typeof MEDIUM_EDGE_TYPE>;

export default function MediumEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
  markerEnd,
}: EdgeProps<MediumFlowEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 16,
    offset: 20,
  });

  const edge = data?.edge;
  const medium = edge ? MEDIA_META[edge.medium] : MEDIA_META.fiber;
  const down = edge?.state === 'down';
  const dimmed = Boolean(data?.dimmed);

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={22}
        style={{
          stroke: medium.color,
          strokeWidth: selected ? 2.8 : 1.7,
          strokeDasharray: medium.dash || undefined,
          strokeLinecap: 'round',
          opacity: dimmed ? 0.18 : down ? 0.5 : 0.95,
          transition: 'stroke-width 150ms ease, opacity 150ms ease',
        }}
      />

      {edge && (selected || down) ? (
        <EdgeLabelRenderer>
          <div
            dir="rtl"
            className={`nodrag nopan pointer-events-none absolute z-10 ${
              selected
                ? 'rounded-soft border border-white/80 bg-white/97 px-2.5 py-1.5 shadow-card'
                : 'rounded-pill border border-red-200 bg-red-50/95 px-2 py-0.5 text-[10px] font-medium text-red-600'
            }`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {selected ? (
              <div className="flex items-center gap-2 whitespace-nowrap">
                <span
                  className="inline-block h-4 w-6 shrink-0"
                  aria-hidden
                  style={{ borderTop: `2px ${medium.dash ? 'dashed' : 'solid'} ${medium.color}` }}
                />
                <span className="text-[10.5px] font-semibold text-ink-700">{medium.label}</span>
                {edge.capacityMbps ? (
                  <span className="text-[10px] text-ink-500">{fmtBandwidth(edge.capacityMbps)}</span>
                ) : null}
                {edge.latencyMs != null ? (
                  <span className="text-[10px] text-ink-400">{fmtLatency(edge.latencyMs)}</span>
                ) : null}
              </div>
            ) : (
              <span>
                قطع{edge.label ? ` · ${edge.label}` : ''}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
