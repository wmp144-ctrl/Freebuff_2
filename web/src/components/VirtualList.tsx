import React, { useEffect, useRef, useState } from 'react';

/**
 * فهرست مجازی سبک بدون وابستگی بیرونی.
 *
 * برای فهرست‌های بزرگ (هزاران تجهیز/علامت) فقط ردیف‌های داخل نمای فعلی رندر
 * می‌شوند؛ گره‌های DOM و حافظه با تعداد آیتم‌ها رشد نمی‌کند. ارتفاع ردیف باید
 * ثابت باشد تا محاسبهٔ پنجره دقیق بماند. Overscan کمی رندر می‌کند تا اسکرول
 * سریع، فضای خالی نشان ندهد.
 */
export function VirtualList<T>({
  items,
  itemHeight,
  render,
  keyOf,
  overscan = 6,
  className = '',
  empty,
}: {
  items: T[];
  itemHeight: number;
  render: (item: T, index: number) => React.ReactNode;
  keyOf: (item: T, index: number) => React.Key;
  overscan?: number;
  className?: string;
  empty?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(320);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight || 320);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!items.length && empty) return <>{empty}</>;

  const total = items.length * itemHeight;
  const start = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const end = Math.min(items.length, Math.ceil((scrollTop + viewport) / itemHeight) + overscan);
  const slice = items.slice(start, end);

  return (
    <div
      ref={ref}
      className={`min-h-0 overflow-y-auto pe-1 ${className}`}
      onScroll={(e) => setScrollTop((e.currentTarget as HTMLDivElement).scrollTop)}
      data-virtualized="true"
      data-total={items.length}
      data-rendered={slice.length}
    >
      <div style={{ height: total, position: 'relative' }}>
        <div style={{ position: 'absolute', top: start * itemHeight, left: 0, right: 0 }}>
          {slice.map((item, i) => (
            <div key={keyOf(item, start + i)} style={{ height: itemHeight }}>
              {render(item, start + i)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default VirtualList;
