import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Eye, EyeOff, GripHorizontal, GripVertical, LayoutGrid, Plus, RotateCcw, X } from 'lucide-react';
import { useApp } from '../lib/store';
import { faDigits } from '../lib/format';
import { Modal } from './ui';
import type { WidgetConfig, WidgetHeight, WidgetSize } from '../lib/types';

export interface WidgetDef {
  id: string;
  title: string;
  defaultSize: WidgetSize;
  /** ارتفاع پیش‌فرض ویجت در چیدمان تازه (پیش‌فرض: md) */
  defaultHeight?: WidgetHeight;
  description?: string;
}

export interface LayoutItem {
  id: string;
  visible: boolean;
  size: WidgetSize;
  /** ارتفاع دقیق ویجت به پیکسل */
  heightPx: number;
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

/** مرزهای ارتفاع دلخواه؛ همان مرزها در سرور هم اعمال می‌شوند */
export const WIDGET_MIN_HEIGHT = 180;
export const WIDGET_MAX_HEIGHT = 1400;

/** ارتفاع چهار سطح آماده — فقط برای مقدار پیش‌فرض و سازگاری با تنظیمات قدیمی */
export const WIDGET_HEIGHT_PX: Record<WidgetHeight, number> = {
  sm: 240,
  md: 340,
  lg: 480,
  xl: 720,
};

export function clampWidgetHeight(value: number): number {
  if (!Number.isFinite(value)) return WIDGET_HEIGHT_PX.md;
  return Math.round(Math.min(WIDGET_MAX_HEIGHT, Math.max(WIDGET_MIN_HEIGHT, value)));
}

/** نزدیک‌ترین سطح قدیمی؛ برای ذخیرهٔ سازگار با نسخه‌های قبلی */
export function heightPresetFor(px: number): WidgetHeight {
  const target = clampWidgetHeight(px);
  let best: WidgetHeight = 'md';
  let distance = Infinity;
  for (const level of HEIGHTS) {
    const d = Math.abs(WIDGET_HEIGHT_PX[level] - target);
    if (d < distance) {
      best = level;
      distance = d;
    }
  }
  return best;
}

const HEIGHTS: WidgetHeight[] = ['sm', 'md', 'lg', 'xl'];
const DEFAULT_HEIGHT: WidgetHeight = 'md';

/**
 * چیدمان ویجت‌ها را از تنظیمات می‌خواند، مقادیر پیش‌فرض را با مقادیر ذخیره‌شده
 * ترکیب می‌کند و عملیات جابه‌جایی، تغییر اندازه، مخفی/نمایش و افزودن را می‌دهد.
 */
function layoutSignature(items: LayoutItem[]): string {
  return items.map((w) => `${w.id}:${w.visible ? 1 : 0}:${w.size}:${w.heightPx}:${w.order}`).join('|');
}

export function useWidgetLayout(key: 'device_detail_widgets' | 'dashboard_widgets', defs: WidgetDef[]) {
  const { settings, saveSettings } = useApp();
  const [editMode, setEditMode] = useState(false);

  const stored = useMemo(() => (settings?.[key] as WidgetConfig[] | undefined) ?? [], [settings, key]);

  const storedLayout: LayoutItem[] = useMemo(() => {
    const byId = new Map(stored.map((w) => [w.id, w]));
    const merged = defs.map((d, i) => {
      const s = byId.get(d.id);
      const storedPx = Number(s?.heightPx);
      const legacyHeight = HEIGHTS.includes(s?.height as WidgetHeight) ? (s?.height as WidgetHeight) : (d.defaultHeight ?? DEFAULT_HEIGHT);
      return {
        id: d.id,
        visible: s ? Number(s.visible) !== 0 : true,
        size: (s?.size as WidgetSize) ?? d.defaultSize,
        // ارتفاع پیکسلی مرجع است؛ برای چیدمان‌های قدیمی که فقط height دارند،
        // همان سطح آماده به پیکسل تبدیل می‌شود.
        heightPx: Number.isFinite(storedPx) && storedPx > 0 ? clampWidgetHeight(storedPx) : WIDGET_HEIGHT_PX[legacyHeight],
        order: s?.order ?? i,
      } as LayoutItem;
    });
    const index = new Map(defs.map((d, i) => [d.id, i]));
    return merged.sort((a, b) => a.order - b.order || (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0));
  }, [stored, defs]);

  // تغییرات (خصوصاً کشیدن ارتفاع) بلافاصله محلی اعمال می‌شوند تا دو تغییر پشت‌سرهم
  // با پاسخ دیررس سرور یکدیگر را بازنویسی نکنند. پس از رسیدن پاسخ، اگر تنظیمات
  // سرور با حالت محلی یکی شده باشد، لایهٔ محلی پاک می‌شود.
  const [localLayout, setLocalLayout] = useState<LayoutItem[] | null>(null);
  const layout = localLayout ?? storedLayout;

  useEffect(() => {
    if (!localLayout) return;
    if (layoutSignature(storedLayout) === layoutSignature(localLayout)) setLocalLayout(null);
  }, [storedLayout, localLayout]);

  const persist = useCallback(
    async (next: LayoutItem[]) => {
      setLocalLayout(next);
      const payload: WidgetConfig[] = next.map((w, i) => ({
        id: w.id,
        visible: w.visible ? 1 : 0,
        size: w.size,
        height: heightPresetFor(w.heightPx),
        heightPx: Math.round(w.heightPx),
        order: i,
      }));
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

  const setHeight = useCallback(
    (id: string, heightPx: number) => persist(layout.map((w) => (w.id === id ? { ...w, heightPx: clampWidgetHeight(heightPx) } : w))),
    [layout, persist]
  );

  const setVisible = useCallback(
    (id: string, visible: boolean) => persist(layout.map((w) => (w.id === id ? { ...w, visible } : w))),
    [layout, persist]
  );

  const reset = useCallback(
    () =>
      persist(
        defs.map((d, i) => ({
          id: d.id,
          visible: true,
          size: d.defaultSize,
          heightPx: WIDGET_HEIGHT_PX[d.defaultHeight ?? DEFAULT_HEIGHT],
          order: i,
        }))
      ),
    [defs, persist]
  );

  return { layout, editMode, setEditMode, move, setSize, setHeight, setVisible, reset };
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
  onHeight,
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
  onHeight: (heightPx: number) => void;
  onHide: () => void;
  children: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [liveHeight, setLiveHeight] = useState(() => clampWidgetHeight(item.heightPx));
  const resizeRef = useRef<{ pointerId: number; startY: number; startHeight: number; lastHeight: number; moved: boolean } | null>(null);

  // پس از ذخیره یا بازنشانی چیدمان، ارتفاع نمایشی با مقدار ذخیره‌شده هم‌گام می‌شود.
  useEffect(() => {
    if (!resizeRef.current) setLiveHeight(clampWidgetHeight(item.heightPx));
  }, [item.heightPx]);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!editMode || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { pointerId: e.pointerId, startY: e.clientY, startHeight: liveHeight, lastHeight: liveHeight, moved: false };
    setResizing(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* مرورگرهای بدون Pointer Capture از رویدادهای پنجره استفاده نمی‌کنند */
    }
  };

  const moveResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = resizeRef.current;
    if (!state || state.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    const next = clampWidgetHeight(state.startHeight + (e.clientY - state.startY));
    if (next === state.lastHeight) return;
    state.moved = true;
    state.lastHeight = next;
    setLiveHeight(next);
  };

  const endResize = (e: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
    const state = resizeRef.current;
    if (!state || state.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* رهاسازی Pointer Capture اختیاری است */
    }
    resizeRef.current = null;
    setResizing(false);
    if (commit) {
      if (state.moved && state.lastHeight !== item.heightPx) onHeight(state.lastHeight);
    } else {
      setLiveHeight(clampWidgetHeight(item.heightPx));
    }
  };

  return (
    <div
      data-widget-id={item.id}
      className={`relative min-w-0 ${SIZE_CLASS[item.size]} ${dragging ? 'opacity-40' : ''} ${
        resizing ? 'z-20' : ''
      } ${over && editMode ? 'ring-2 ring-brand-400/70 rounded-card' : ''}`}
      draggable={editMode && !resizing}
      onDragStart={(e) => {
        if (!editMode || resizeRef.current) {
          e.preventDefault();
          return;
        }
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
            <span className="mx-0.5 h-4 w-px bg-brand-200" aria-hidden />
            <span className="num inline-flex items-center gap-1 rounded-md bg-white px-1.5 py-0.5 text-[10px] text-brand-700" title="ارتفاع فعلی؛ برای تغییر، لبهٔ پایین ویجت را بکشید">
              <GripHorizontal size={11} />
              {faDigits(liveHeight)} px
            </span>
            <button type="button" onClick={onHide} className="rounded-md bg-white px-1.5 py-0.5 text-[10px] text-red-500 hover:bg-red-50" title="حذف از نمایش">
              <X size={11} />
            </button>
          </span>
        </div>
      ) : null}
      {/*
       * ارتفاع ویجت دقیقاً همان مقداری است که انتخاب شده — نه یک «حداقل».
       * پیش‌تر فقط min-height اعمال می‌شد و محتوای بلند (نمودارها، فهرست‌ها)
       * ارتفاع را بالا می‌برد؛ در نتیجه کم‌کردن ارتفاع هیچ اثری نداشت و ویجت‌ها
       * با هم هم‌اندازه نبودند. اکنون ارتفاع قطعی است و محتوای بیشتر از آن،
       * داخل خودِ ویجت اسکرول می‌شود.
       */}
      <div
        className={`widget-body ${editMode ? 'pointer-events-none select-none' : ''} flex min-h-0 flex-col overflow-y-auto overflow-x-hidden`}
        style={{ height: liveHeight }}
      >
        {children}
      </div>
      {editMode ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={`تغییر ارتفاع ${def.title}`}
          aria-valuemin={WIDGET_MIN_HEIGHT}
          aria-valuemax={WIDGET_MAX_HEIGHT}
          aria-valuenow={liveHeight}
          title="برای تغییر ارتفاع، این لبه را به بالا یا پایین بکشید"
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={(e) => endResize(e, true)}
          onPointerCancel={(e) => endResize(e, false)}
          className={`group absolute inset-x-0 -bottom-2 z-20 flex h-6 touch-none cursor-ns-resize items-center justify-center ${
            resizing ? 'select-none' : ''
          }`}
        >
          <span
            className={`pointer-events-none flex h-4 items-center gap-1 rounded-pill border px-2 text-[10px] shadow-soft transition ${
              resizing ? 'border-brand-400 bg-brand-500 text-white' : 'border-brand-200 bg-white/95 text-brand-600 group-hover:bg-brand-50'
            }`}
          >
            <GripHorizontal size={12} />
          </span>
        </div>
      ) : null}
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
  onHeight,
  onUp,
  onDown,
}: {
  def: WidgetDef;
  item: LayoutItem;
  onVisible: (v: boolean) => void;
  onSize: (s: WidgetSize) => void;
  onHeight: (heightPx: number) => void;
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
        <select className="field !w-auto !py-1.5 text-[12px]" value={item.size} onChange={(e) => onSize(e.target.value as WidgetSize)} title="عرض ویجت">
          {SIZES.map((s) => (
            <option key={s} value={s}>
              {SIZE_LABEL[s]}
            </option>
          ))}
        </select>
        <WidgetHeightInput value={item.heightPx} onChange={onHeight} />
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

/** ورودی عددی ارتفاع با اعتبارسنجی و ذخیره در پایان تایپ */
function WidgetHeightInput({ value, onChange }: { value: number; onChange: (px: number) => void }) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    const next = clampWidgetHeight(n);
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <label className="flex items-center gap-1 text-[10.5px] text-ink-500">
      <span>ارتفاع</span>
      <input
        type="number"
        min={WIDGET_MIN_HEIGHT}
        max={WIDGET_MAX_HEIGHT}
        step={10}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        className="field num !w-[82px] !py-1.5 text-[12px]"
        aria-label="ارتفاع ویجت به پیکسل"
      />
      <span>px</span>
    </label>
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
