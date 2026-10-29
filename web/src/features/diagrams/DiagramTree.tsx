/**
 * درخت دیاگرام‌ها — هر دیاگرام می‌تواند چند زیرمجموعه داشته باشد.
 * ساختار از `parentId` ساخته می‌شود و همهٔ دیاگرام‌ها مستقل‌اند.
 */
import React, { useMemo, useState } from 'react';
import { ChevronLeft, ChevronDown, Pencil, Plus, RefreshCw, Trash, Workflow } from 'lucide-react';
import { faDigits } from '../../lib/format';
import type { DiagramSummary } from '../../lib/types';

interface TreeNode extends DiagramSummary {
  children: TreeNode[];
}

function buildTree(items: DiagramSummary[]): TreeNode[] {
  const map = new Map<number, TreeNode>();
  for (const item of items) map.set(item.id, { ...item, children: [] });
  const roots: TreeNode[] = [];
  for (const node of map.values()) {
    const parent = node.parentId != null ? map.get(node.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (list: TreeNode[]) => {
    list.sort((a, b) => a.name.localeCompare(b.name, 'fa'));
    list.forEach((child) => sort(child.children));
  };
  sort(roots);
  return roots;
}

export interface DiagramTreeProps {
  items: DiagramSummary[];
  currentId: number | null;
  loading: boolean;
  onOpen: (id: number) => void;
  onCreate: (parentId: number | null) => void;
  onEdit: (diagram: DiagramSummary) => void;
  onDelete: (diagram: DiagramSummary) => void;
  onRefresh: () => void;
}

export default function DiagramTree({
  items,
  currentId,
  loading,
  onOpen,
  onCreate,
  onEdit,
  onDelete,
  onRefresh,
}: DiagramTreeProps) {
  const tree = useMemo(() => buildTree(items), [items]);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const toggle = (id: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const hasChildren = node.children.length > 0;
    const isCollapsed = collapsed.has(node.id);
    const active = node.id === currentId;
    return (
      <li key={node.id}>
        <div
          className={`group flex items-center gap-1 rounded-lg pr-1 transition ${
            active ? 'bg-brand-50 text-brand-800 ring-1 ring-brand-100' : 'text-ink-600 hover:bg-ink-50'
          }`}
          style={{ paddingInlineStart: 4 + depth * 12 }}
        >
          <button
            type="button"
            className={`grid h-5 w-4 shrink-0 place-items-center rounded text-ink-400 ${hasChildren ? '' : 'invisible'}`}
            onClick={() => toggle(node.id)}
            aria-label={isCollapsed ? 'باز کردن زیرمجموعه‌ها' : 'بستن زیرمجموعه‌ها'}
          >
            {isCollapsed ? <ChevronLeft size={13} /> : <ChevronDown size={13} />}
          </button>
          <button
            type="button"
            onClick={() => onOpen(node.id)}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-right"
            title={node.name}
          >
            <Workflow size={13} className={active ? 'text-brand-600' : 'text-ink-400'} />
            <span className={`min-w-0 flex-1 truncate text-[12px] ${active ? 'font-semibold' : 'font-medium'}`}>
              {node.name}
            </span>
            <span className="num shrink-0 rounded bg-white/70 px-1 text-[9px] text-ink-400 ring-1 ring-ink-100">
              {faDigits(node.nodeCount)}
            </span>
          </button>
          <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition group-hover:opacity-100">
            <button
              type="button"
              className="grid h-6 w-6 place-items-center rounded-md text-ink-400 hover:bg-white hover:text-brand-600"
              onClick={() => onCreate(node.id)}
              title="افزودن زیرمجموعه"
              aria-label="افزودن زیرمجموعه"
            >
              <Plus size={12} />
            </button>
            <button
              type="button"
              className="grid h-6 w-6 place-items-center rounded-md text-ink-400 hover:bg-white hover:text-ink-700"
              onClick={() => onEdit(node)}
              title="ویرایش نام"
              aria-label="ویرایش نام"
            >
              <Pencil size={11} />
            </button>
            <button
              type="button"
              className="grid h-6 w-6 place-items-center rounded-md text-ink-400 hover:bg-white hover:text-red-600"
              onClick={() => onDelete(node)}
              title="حذف دیاگرام"
              aria-label="حذف دیاگرام"
            >
              <Trash size={11} />
            </button>
          </div>
        </div>
        {hasChildren && !isCollapsed ? <ul className="space-y-0.5">{node.children.map((child) => renderNode(child, depth + 1))}</ul> : null}
      </li>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-ink-100 px-2 py-1.5">
        <button type="button" className="btn-ghost btn-xs" onClick={() => onCreate(null)} title="دیاگرام ریشه">
          <Plus size={13} />
          دیاگرام جدید
        </button>
        <span className="ms-auto text-[10px] text-ink-400">{faDigits(items.length)} دیاگرام</span>
        <button
          type="button"
          className="grid h-6 w-6 place-items-center rounded-md text-ink-400 hover:bg-ink-50 hover:text-ink-700"
          onClick={onRefresh}
          title="بازخوانی فهرست"
          aria-label="بازخوانی فهرست"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {tree.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] leading-5 text-ink-400">
            {loading ? 'در حال بارگذاری…' : 'هنوز دیاگرامی ساخته نشده است.'}
          </p>
        ) : (
          <ul className="space-y-0.5">{tree.map((node) => renderNode(node, 0))}</ul>
        )}
      </div>
    </div>
  );
}
