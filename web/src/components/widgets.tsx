import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, GripVertical, LayoutGrid, Plus, RotateCcw, X } from 'lucide-react';
import { useApp } from '../lib/store';
import { faDigits } from '../lib/format';
import { Modal } from './ui';
import type { WidgetConfig, WidgetSize } from '../lib/types';

export interface WidgetDef {
  id: string;
  title: string;
  defaultSize: WidgetSize;
  description?: string;
}

export interface LayoutItem {
  id: string;
  visible: boolean;
  size: WidgetSize;
  order: number;
}

const SIZE_CLASS: Record<WidgetSize, string> = {
  sm: 'xl:col-span-2',
  md: 'xl:col-span-3',
  lg: 'xl:col-span-4',
  full: 'xl:col-span-6',
};

export const SIZE_LABEL: Record<WidgetSize, string> = {
  sm: 'کوچک',
  md: 'متوسط',
  lg: 'بزرگ',
  full: 'تمام‌عرض',
};

const SIZES: WidgetSize[] = ['sm', 'md', 'lg', 'full'];

/**
 * چیدمان ویجت‌ها را از تنظیمات می‌خواند، مقادیر پیش‌فرض را با مقادیر ذخیره‌شده
 * ترکیب می‌کند و عملیات جابه‌جایی، تغییر اندازه، مخفی/نمایش و افزودن را می‌دهد.
 */
export function useWidgetLayout(key: 'device_detail_widgets' | 'dashboard_widgets', defs: WidgetDef[]) {
  const { settings, saveSettings } = useApp();
  const [editMode, setEditMode] = useState(false);

  const stored = (settings?.[key] as WidgetConfig[] | undefined) ?? [];

  const layout: LayoutItem[] = useMemo(() => {
    const byId = new Map(stored.map((w) => [w.id, w]));
    const merged = defs.map((d, i) => {
      const s = byId.get(d.id);
      return {
        id: d.id,
        visible: s ? Number(s.visible) !== 0 : true,
        size: (s?.size as WidgetSize) ?? d.defaultSize,
        order: s?.order ?? i,
      } as LayoutItem;
    });
    const index = new Map(defs.map((d, i) => [d.id, i]));
    return merged.sort((a, b) => a.order - b.order || (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0));
  }, [stored, defs]);

  const persist = useCallback(
    async (next: LayoutItem[]) => {
      const payload: WidgetConfig[] = next.map((w, i) => ({ id: w.id, visible: w.visible ? 1 : 0, size: w.size, order: i }));
      await saveSettings({ [key]: payload });
    },
    [key, saveSettings]
  );

  const move = useCallback(
    (id: string, targetId: string) => {
      if (id === targetId) return;
      const list = [...layout];
      const from = list.findIndex((w) => w.id === id);
      const to = list.findIndex((w) => w.id === targetId);
      if (from < 0 || to < 0) return;
      list.splice(to, 0, ...list.splice(from, 1));
      persist(list);
    },
    [layout, persist]
  );

  const setSize = useCallback(
    (id: string, size: WidgetSize) => persist(layout.map((w) => (w.id === id ? { ...w, size } : w))),
    [layout, persist]
  );

  const setVisible = useCallback(
    (id: string, visible: boolean) => persist(layout.map((w) => (w.id === id ? { ...w, visible } : w))),
    [layout, persist]
  );

  const reset = useCallback(() => persist(defs.map((d, i) => ({ id: d.id, visible: true, size: d.defaultSize, order: i }))), [defs, persist]);

  return { layout, editMode, setEditMode, move, setSize, setVisible, reset };
}

/** پوستهٔ هر ویجت: در حالت چیدمان، دستگیرهٔ جابه‌جایی، اندازه و مخفی‌سازی نشان می‌دهد */
export function WidgetShell({
  item,
  def,
  editMode,
  dragging,
  onDragStart,
  onDragEnd,
  onDropOn,
  onSize,
  onHide,
  children,
}: {
  item: LayoutItem;
  def: WidgetDef;
  editMode: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropOn: () => void;
  onSize: (s: WidgetSize) => void;
  onHide: () => void;
  children: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`min-w-0 ${SIZE_CLASS[item.size]} ${dragging ? 'opacity-40' : ''} ${over && editMode ? 'ring-2 ring-brand-400/70 rounded-card' : ''}`}
      draggable={editMode}
      onDragStart={(e) => {
        if (!editMode) return;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/nw-widget', item.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        if (!editMode) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!editMode) return;
        e.preventDefault();
        setOver(false);
        onDropOn();
      }}
    >
      {editMode ? (
        <div className="mb-1 flex flex-wrap items-center gap-1.5 rounded-soft border border-dashed border-brand-300 bg-brand-50/70 px-2 py-1.5">
          <GripVertical size={14} className="cursor-grab text-brand-500" />
          <span className="text-[11.5px] font-medium text-brand-800">{def.title}</span>
          <span className="ms-auto flex items-center gap-1">
            {SIZES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onSize(s)}
                className={`rounded-md px-1.5 py-0.5 text-[10px] transition ${item.size === s ? 'bg-brand-500 text-white' : 'bg-white text-ink-500 hover:text-ink-700'}`}
              >
                {SIZE_LABEL[s]}
              </button>
            ))}
            <button type="button" onClick={onHide} className="rounded-md bg-white px-1.5 py-0.5 text-[10px] text-red-500 hover:bg-red-50" title="حذف از نمایش">
              <X size={11} />
            </button>
          </span>
        </div>
      ) : null}
      <div className={editMode ? 'pointer-events-none select-none' : ''}>{children}</div>
    </div>
  );
}

/** نوار ابزار ویرایش چیدمان: دکمهٔ چیدمان، افزودن ویجت و بازنشانی */
export function LayoutToolbar({
  editMode,
  setEditMode,
  layout,
  defs,
  onAdd,
  onReset,
}: {
  editMode: boolean;
  setEditMode: (v: boolean) => void;
  layout: LayoutItem[];
  defs: WidgetDef[];
  onAdd: (id: string) => void;
  onReset: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const hidden = defs.filter((d) => !layout.find((w) => w.id === d.id)?.visible);
  return (
    <>
      <button type="button" className={`btn-xs ${editMode ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setEditMode(!editMode)}>
        <LayoutGrid size={14} />
        {editMode ? 'پایان چیدمان' : 'چیدمان'}
      </button>
      {editMode ? (
        <button type="button" className="btn-ghost btn-xs" onClick={() => setPickerOpen(true)}>
          <Plus size={13} />
          افزودن ویجت
          {hidden.length ? <span className="num rounded-pill bg-brand-50 px-1.5 text-[10px] text-brand-700">{faDigits(hidden.length)}</span> : null}
        </button>
      ) : null}
      {editMode ? (
        <button type="button" className="btn-ghost btn-xs" onClick={onReset}>
          <RotateCcw size={13} />
          بازنشانی چیدمان
        </button>
      ) : null}

      <Modal open={pickerOpen} onClose={() => setPickerOpen(false)} title="افزودن ویجت" subtitle="ویجت‌های مخفی‌شده را برگردانید" size="sm">
        {hidden.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-ink-400">همه ویجت‌ها در حال نمایش هستند</p>
        ) : (
          <div className="space-y-2">
            {hidden.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => onAdd(d.id)}
                className="flex w-full items-center justify-between gap-2 rounded-soft border border-ink-200 bg-white/80 px-3 py-2 text-right transition hover:border-brand-300 hover:bg-brand-50/50"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-medium text-ink-700">{d.title}</span>
                  {d.description ? <span className="block text-[10.5px] text-ink-400">{d.description}</span> : null}
                </span>
                <span className="inline-flex items-center gap-1 text-[11px] text-brand-600">
                  <Plus size={12} />
                  افزودن
                </span>
              </button>
            ))}
          </div>
        )}
      </Modal>
    </>
  );
}

/** فهرست کوچک نمایش/مخفی‌سازی سریع (برای تنظیمات) */
export function WidgetVisibilityRow({
  def,
  item,
  onVisible,
  onSize,
  onUp,
  onDown,
}: {
  def: WidgetDef;
  item: LayoutItem;
  onVisible: (v: boolean) => void;
  onSize: (s: WidgetSize) => void;
  onUp: () => void;
  onDown: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-soft border border-ink-200 bg-white/70 p-3">
      <div className="min-w-0">
        <p className="truncate text-[12.5px] font-medium text-ink-700">{def.title}</p>
        {def.description ? <p className="mt-0.5 text-[10.5px] text-ink-400">{def.description}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select className="field !w-auto !py-1.5 text-[12px]" value={item.size} onChange={(e) => onSize(e.target.value as WidgetSize)}>
          {SIZES.map((s) => (
            <option key={s} value={s}>
              {SIZE_LABEL[s]}
            </option>
          ))}
        </select>
        <button type="button" className="btn-ghost btn-xs" onClick={onUp} title="بالا">
          ↑
        </button>
        <button type="button" className="btn-ghost btn-xs" onClick={onDown} title="پایین">
          ↓
        </button>
        <button type="button" className={`btn-xs ${item.visible ? 'btn-soft' : 'btn-ghost'}`} onClick={() => onVisible(!item.visible)}>
          {item.visible ? <Eye size={13} /> : <EyeOff size={13} />}
          {item.visible ? 'نمایش' : 'مخفی'}
        </button>
      </div>
    </div>
  );
}

/** مرتب‌سازی بر اساس ترتیب ذخیره‌شده */
export function orderByLayout<T extends { id: string }>(items: T[], layout: LayoutItem[]): T[] {
  const order = new Map(layout.map((w, i) => [w.id, i]));
  return [...items].sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
}

/** رفرنس کمکی برای نگه‌داشتن شناسهٔ ویجت در حال جابه‌جایی */
export function useDragRef() {
  return useRef<string | null>(null);
}
