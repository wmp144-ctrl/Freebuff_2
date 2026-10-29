/**
 * وضعیت بوم + تاریخچهٔ واگرد/ازنو.
 *
 * همهٔ تغییرات از یک نقطه عبور می‌کنند تا هر عملیات (افزودن، حذف، جابه‌جایی،
 * تراز، چسباندن و همگام‌سازی) یک گام واگرد داشته باشد. تغییرهای پیوسته
 * (کشیدن/تغییر اندازه) با `beginGesture` فقط یک گام ثبت می‌کنند.
 *
 * `stateRef` هم‌زمان با `setState` به‌روز می‌شود تا چند تغییر در یک تیک
 * (مثلاً تراز + رنگ) روی وضعیت تازه سوار شوند نه وضعیت کهنه.
 */
import { useCallback, useRef, useState } from 'react';
import type { DiagramFlowEdge, DiagramFlowNode } from '../../lib/diagrams';

export interface CanvasSnapshot {
  nodes: DiagramFlowNode[];
  edges: DiagramFlowEdge[];
}

export interface CanvasHistory {
  nodes: DiagramFlowNode[];
  edges: DiagramFlowEdge[];
  canUndo: boolean;
  canRedo: boolean;
  snapshot: () => CanvasSnapshot;
  /** جایگزینی کامل (بارگذاری دیاگرام)؛ تاریخچه پاک می‌شود */
  replace: (next: CanvasSnapshot) => void;
  /** تغییر عادی؛ یک گام واگرد ثبت می‌کند. خروجی: آیا تغییری رخ داد؟ */
  apply: (updater: (prev: CanvasSnapshot) => CanvasSnapshot, record?: boolean) => boolean;
  /** ثبت وضعیت پیش از یک حرکت پیوسته (کشیدن/تغییر اندازه) */
  pushSnapshot: (snap: CanvasSnapshot) => void;
  undo: () => boolean;
  redo: () => boolean;
  /** پاک کردن تاریخچه بدون تغییر محتوا (مثلاً پس از ذخیره) */
  clear: () => void;
}

const LIMIT = 80;

export function useCanvasHistory(initial: CanvasSnapshot = { nodes: [], edges: [] }): CanvasHistory {
  const [state, setState] = useState<CanvasSnapshot>(initial);
  const stateRef = useRef(state);
  const [history, setHistory] = useState<{ past: CanvasSnapshot[]; future: CanvasSnapshot[] }>({
    past: [],
    future: [],
  });
  const historyRef = useRef(history);

  const commitHistory = useCallback((next: { past: CanvasSnapshot[]; future: CanvasSnapshot[] }) => {
    historyRef.current = next;
    setHistory(next);
  }, []);

  const replace = useCallback(
    (next: CanvasSnapshot) => {
      stateRef.current = next;
      setState(next);
      commitHistory({ past: [], future: [] });
    },
    [commitHistory]
  );

  const apply = useCallback(
    (updater: (prev: CanvasSnapshot) => CanvasSnapshot, record = true) => {
      const prev = stateRef.current;
      const next = updater(prev);
      if (next === prev) return false;
      stateRef.current = next;
      setState(next);
      if (record) {
        commitHistory({ past: [...historyRef.current.past, prev].slice(-LIMIT), future: [] });
      }
      return true;
    },
    [commitHistory]
  );

  const pushSnapshot = useCallback(
    (snap: CanvasSnapshot) => {
      commitHistory({ past: [...historyRef.current.past, snap].slice(-LIMIT), future: [] });
    },
    [commitHistory]
  );

  const undo = useCallback(() => {
    const { past, future } = historyRef.current;
    if (!past.length) return false;
    const previous = past[past.length - 1];
    commitHistory({ past: past.slice(0, -1), future: [stateRef.current, ...future].slice(0, LIMIT) });
    stateRef.current = previous;
    setState(previous);
    return true;
  }, [commitHistory]);

  const redo = useCallback(() => {
    const { past, future } = historyRef.current;
    if (!future.length) return false;
    const next = future[0];
    commitHistory({ past: [...past, stateRef.current].slice(-LIMIT), future: future.slice(1) });
    stateRef.current = next;
    setState(next);
    return true;
  }, [commitHistory]);

  const clear = useCallback(() => commitHistory({ past: [], future: [] }), [commitHistory]);

  const snapshot = useCallback(() => stateRef.current, []);

  return {
    nodes: state.nodes,
    edges: state.edges,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    snapshot,
    replace,
    apply,
    pushSnapshot,
    undo,
    redo,
    clear,
  };
}
