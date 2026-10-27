/**
 * درخت سلسله‌مراتبی شبکه
 * ----------------------------------------------------------------
 * شهرها ریشه‌اند و مراکز/ایستگاه‌ها و تجهیزات زیر آن‌ها باز می‌شوند.
 * کلیک روی هر ردیف یا نمای مربوط به آن را باز می‌کند (گرهٔ قابل ورود) یا
 * تجهیز را در بوم انتخاب می‌کند. جست‌وجوی سراسری، شاخهٔ نتیجه را خودکار
 * باز نگه می‌دارد تا نتیجه هیچ‌وقت در شاخهٔ بسته گم نشود.
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronLeft, ListTree, Minus, Plus, X } from 'lucide-react';
import {
  KIND_META,
  ancestorsOf,
  buildTree,
  indexNodes,
  isDrillable,
  visibleTreeIds,
  type TopologyNodeModel,
  type TopologyScope,
  type TreeNode,
} from '../../lib/topology-hierarchy';
import { faDigits, statusMeta } from '../../lib/format';
import { KIND_ICONS } from './HierarchyNode';

interface Props {
  nodes: TopologyNodeModel[];
  scope: TopologyScope;
  selectedId: string | null;
  query: string;
  /** گره‌هایی که با فیلترهای فعلی هم‌خوان نیستند و کم‌رنگ می‌شوند */
  dimmedIds?: Set<string> | null;
  onSelect: (node: TopologyNodeModel) => void;
  onClose?: () => void;
  className?: string;
}

export default function NetworkTree({
  nodes,
  scope,
  selectedId,
  query,
  dimmedIds,
  onSelect,
  onClose,
  className = '',
}: Props) {
  const activeId = scope.level === 'city' ? scope.cityId : scope.level === 'detail' ? scope.parentId : null;
  const index = useMemo(() => indexNodes(nodes), [nodes]);
  const visibleIds = useMemo(() => visibleTreeIds(nodes, query), [nodes, query]);
  const tree = useMemo(() => buildTree(nodes, visibleIds), [nodes, visibleIds]);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(nodes.filter((n) => n.kind === 'city').map((n) => n.id)));

  // مسیر دامنهٔ جاری (و گرهٔ انتخاب‌شده) همیشه باز باشد
  useEffect(() => {
    const target = activeId ?? selectedId;
    if (!target) return;
    const ids = [target, ...ancestorsOf(index, target).map((n) => n.id)].filter((id) => index.has(id));
    setExpanded((prev) => {
      const missing = ids.filter((id) => !prev.has(id));
      if (!missing.length) return prev;
      return new Set([...prev, ...missing]);
    });
  }, [activeId, selectedId, index]);

  // هنگام جست‌وجو، همهٔ شاخه‌های نتیجه باز شوند
  useEffect(() => {
    if (!query.trim()) return;
    setExpanded((prev) => new Set([...prev, ...visibleIds]));
  }, [query, visibleIds]);

  const expandAll = () => setExpanded(new Set(nodes.map((n) => n.id)));
  const collapseAll = () => setExpanded(new Set());

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderRow = (item: TreeNode) => {
    const { node, children, depth } = item;
    const hasChildren = children.length > 0;
    const isOpen = expanded.has(node.id);
    const isSelected = node.id === selectedId;
    const isActive = node.id === activeId;
    const Icon = KIND_ICONS[node.kind] ?? KIND_ICONS.other;
    const status = statusMeta(node.status ?? 'unknown');

    return (
      <div key={node.id} className={dimmedIds && !dimmedIds.has(node.id) ? 'opacity-40 transition-opacity' : 'transition-opacity'}>
        <div
          className={`flex items-center gap-1 rounded-xl pe-1 transition-colors ${
            isSelected ? 'bg-brand-50/90 ring-1 ring-brand-100' : isActive ? 'bg-ink-50' : 'hover:bg-ink-50/70'
          }`}
          style={{ paddingInlineStart: `${4 + depth * 11}px` }}
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={() => toggle(node.id)}
              className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-ink-400 transition hover:bg-white hover:text-ink-700"
              aria-label={isOpen ? `بستن ${node.name}` : `باز کردن ${node.name}`}
              aria-expanded={isOpen}
            >
              {isOpen ? <ChevronDown size={12} /> : <ChevronLeft size={12} />}
            </button>
          ) : (
            <span className="h-5 w-5 shrink-0" aria-hidden />
          )}

          <button
            type="button"
            onClick={() => onSelect(node)}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-start"
            title={isDrillable(node) ? `باز کردن نمای ${node.name}` : node.name}
          >
            <Icon size={12} className="shrink-0" style={{ color: KIND_META[node.kind].color }} />
            <span className={`truncate text-[12px] ${isSelected ? 'font-semibold text-brand-700' : 'text-ink-700'}`}>
              {node.name}
            </span>
            {hasChildren ? (
              <span className="num me-1 ms-auto shrink-0 text-[9.5px] text-ink-400">{faDigits(children.length)}</span>
            ) : null}
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.dot} ${hasChildren ? '' : 'ms-auto'}`}
              title={status.label}
            />
          </button>
        </div>

        {isOpen && hasChildren ? <div>{children.map((child) => renderRow(child))}</div> : null}
      </div>
    );
  };

  return (
    <div className={`card flex h-full flex-col overflow-hidden ${className}`}>
      <div className="flex shrink-0 items-center gap-2 border-b border-ink-100 px-3 py-2.5">
        <span className="grid h-7 w-7 place-items-center rounded-lg border border-brand-100 bg-brand-50 text-brand-600">
          <ListTree size={14} />
        </span>
        <div className="min-w-0">
          <p className="text-[12.5px] font-semibold text-ink-800">درخت شبکه</p>
          <p className="text-[10px] text-ink-400">
            {faDigits(nodes.length)} گره · {faDigits(nodes.filter((n) => n.kind === 'city').length)} شهر
          </p>
        </div>
        <div className="ms-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={expandAll}
            className="grid h-7 w-7 place-items-center rounded-lg text-ink-400 transition hover:bg-ink-50 hover:text-ink-700"
            title="باز کردن همهٔ شاخه‌ها"
            aria-label="باز کردن همه"
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            onClick={collapseAll}
            className="grid h-7 w-7 place-items-center rounded-lg text-ink-400 transition hover:bg-ink-50 hover:text-ink-700"
            title="بستن همهٔ شاخه‌ها"
            aria-label="بستن همه"
          >
            <Minus size={14} />
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="grid h-7 w-7 place-items-center rounded-lg text-ink-400 transition hover:bg-ink-50 hover:text-ink-700"
              title="بستن درخت"
              aria-label="بستن درخت"
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {tree.length === 0 ? (
          <p className="px-3 py-8 text-center text-[11.5px] text-ink-400">موردی با این جست‌وجو پیدا نشد.</p>
        ) : (
          tree.map((item) => renderRow(item))
        )}
      </div>
    </div>
  );
}
