/**
 * کارت گره در بوم توپولوژی
 * ----------------------------------------------------------------
 * گره‌ها با نوع خودشان (شهر، مرکز تجمع، ایستگاه، روتر، سوئیچ، فایروال، …)
 * آیکون و رنگ می‌گیرند؛ وضعیت با نقطهٔ رنگی و IP با قالب لاتین خوانده می‌شود.
 * گره‌های قابل ورود (شهر/مرکز/ایستگاه) دکمهٔ «ورود» دارند و دوبار کلیک هم
 * همین کار را می‌کند.
 */
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import {
  Boxes,
  Building2,
  ChevronLeft,
  Layers,
  ListTree,
  Network,
  Radio,
  Router,
  Server,
  Shield,
  Wifi,
} from 'lucide-react';
import { KIND_META, isDrillable, type TopologyNodeKind, type TopologyNodeModel } from '../../lib/topology-hierarchy';
import { faDigits, statusMeta } from '../../lib/format';

export const HIERARCHY_NODE_TYPE = 'hierarchy';

export type HierarchyNodeData = {
  node: TopologyNodeModel;
  /** تعداد همهٔ گره‌های زیرمجموعه (برای نشان دادن در کارت) */
  childCount: number;
  /** با جست‌وجو هم‌خوان نیست → محو می‌شود */
  dimmed: boolean;
  /** لنگر سطح جاری (والدِ گره‌های دیده‌شده) */
  context: boolean;
  edit: boolean;
  onDrill?: (id: string) => void;
};

export type HierarchyFlowNode = Node<HierarchyNodeData, typeof HIERARCHY_NODE_TYPE>;

export const KIND_ICONS: Record<TopologyNodeKind, typeof Boxes> = {
  city: Building2,
  aggregation: Layers,
  station: Radio,
  router: Router,
  switch: Network,
  firewall: Shield,
  'access-point': Wifi,
  server: Server,
  other: Boxes,
};

export default function HierarchyNodeCard({ data, selected }: NodeProps<HierarchyFlowNode>) {
  const { node, childCount, dimmed, context, edit, onDrill } = data;
  const kind = KIND_META[node.kind];
  const Icon = KIND_ICONS[node.kind] ?? Boxes;
  const status = statusMeta(node.status ?? 'unknown');
  const drillable = isDrillable(node);

  return (
    <div
      dir="rtl"
      className={`relative w-[196px] rounded-soft border bg-white px-3 pb-2 pt-2.5 shadow-soft transition-all duration-200 ${
        selected
          ? 'border-brand-400 ring-2 ring-brand-500/25'
          : context
            ? 'border-dashed border-ink-300 bg-ink-50/80'
            : 'border-ink-200'
      } ${dimmed ? 'opacity-35' : ''} ${edit ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}`}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!h-1.5 !w-1.5 !min-h-0 !min-w-0 !border-0 !bg-ink-300"
      />

      <div className="flex items-start gap-2">
        <span
          className="grid h-8 w-8 shrink-0 place-items-center rounded-xl border"
          style={{ backgroundColor: `${kind.color}14`, borderColor: `${kind.color}33`, color: kind.color }}
        >
          <Icon size={16} />
        </span>
        <div className="min-w-0 flex-1 pe-4">
          <p className="truncate text-[12.5px] font-semibold leading-5 text-ink-800" title={node.name}>
            {node.name}
          </p>
          <p className="mt-0.5 flex items-center gap-1 text-[10.5px] text-ink-500">
            <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${status.dot}`} />
            <span className="truncate" title={status.label}>
              {node.deviceType || kind.label}
            </span>
          </p>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 border-t border-ink-100 pt-1.5">
        <span className="num ltr text-[10.5px] text-ink-500" title="آدرس IP">
          {node.ip || '—'}
        </span>
        {childCount > 0 ? (
          <span
            className="inline-flex items-center gap-1 rounded-pill border border-ink-200 bg-ink-50 px-1.5 py-0.5 text-[9.5px] text-ink-500"
            title={`${faDigits(childCount)} گره زیرمجموعه`}
          >
            <ListTree size={9} />
            {faDigits(childCount)}
          </span>
        ) : context ? (
          <span className="text-[9px] text-ink-400">زمینه</span>
        ) : null}
      </div>

      {drillable ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDrill?.(node.id);
          }}
          className="nodrag absolute left-1 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full border border-ink-200 bg-white/95 text-ink-400 shadow-xs transition hover:border-brand-200 hover:text-brand-600"
          title={`ورود به ${node.name}`}
          aria-label={`ورود به ${node.name}`}
        >
          <ChevronLeft size={12} />
        </button>
      ) : null}

      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-1.5 !w-1.5 !min-h-0 !min-w-0 !border-0 !bg-ink-300"
      />
    </div>
  );
}
