import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, isAbortError } from './api';
import { errorMessage, LatestRequestGate } from './async-gate';
import { LiveSampleBuffer, nextReconnectDelay, type LiveSample } from './live-core';
import type { Alert, AppSettings, EngineStatus, Group, MapLayer, Tag } from './types';

export type { LiveSample } from './live-core';

/* ------------------------------------------------------------------ */
/* useAsync                                                            */
/* ------------------------------------------------------------------ */
export interface AsyncOptions {
  interval?: number;
  enabled?: boolean;
}

/**
 * بارگذاری داده با محافظت کامل در برابر Race Condition.
 *
 * هر فراخوانی یک بلیت از دروازهٔ «آخرین درخواست» می‌گیرد. با تغییر وابستگی‌ها
 * درخواست قبلی هم لغو می‌شود و هم نتیجه‌اش (اگر دیر برسد) دور ریخته می‌شود.
 * در نتیجه پاسخ کندِ فیلتر قبلی نمی‌تواند دادهٔ فیلتر جدید را بازنویسی کند.
 */
export function useAsync<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  deps: unknown[],
  options: AsyncOptions = {}
) {
  const enabled = options.enabled !== false;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [reloading, setReloading] = useState(0);

  const fnRef = useRef(fn);
  fnRef.current = fn;
  const dataRef = useRef<T | null>(null);
  dataRef.current = data;
  const gateRef = useRef<LatestRequestGate | null>(null);
  if (!gateRef.current) gateRef.current = new LatestRequestGate();
  const inFlight = useRef(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    if (!enabled) return;
    const gate = gateRef.current!;
    // اگر درخواست قبلی هنوز در جریان است، عمداً لغو نمی‌شود؛ بلیت جدید در
    // begin() آن را لغو می‌کند. این‌جا فقط از انباشت درخواست تکراری جلوگیری می‌شود
    // مگر اینکه فراخوانی صریح (refresh) باشد.
    const ticket = gate.begin();
    inFlight.current = true;
    setRefreshing(true);
    if (!dataRef.current) setLoading(true);
    try {
      const result = await fnRef.current(ticket.signal);
      if (!ticket.isCurrent() || !mounted.current) return;
      setData(result);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (e) {
      if (!ticket.isCurrent() || !mounted.current || isAbortError(e)) return;
      setError(e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      if (ticket.isCurrent() && mounted.current) {
        inFlight.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [enabled]);

  useEffect(() => {
    mounted.current = true;
    const gate = gateRef.current!;
    if (!enabled) {
      setLoading(false);
      return () => gate.abort();
    }
    void load();
    return () => {
      // لغو واقعی درخواست در جریان + بی‌اعتبار کردن پاسخ دیررس
      gate.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, reloading, enabled]);

  // Unmount: دیگر هیچ setState یا نوشتن روی دادهٔ قدیمی رخ نمی‌دهد
  useEffect(() => {
    return () => {
      mounted.current = false;
      gateRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!options.interval || !enabled) return;
    const id = setInterval(() => {
      // در تب‌های پنهان، دریافت دوره‌ای داده بی‌فایده است و فقط سرور را مشغول می‌کند
      if (typeof document !== 'undefined' && document.hidden) return;
      if (inFlight.current) return;
      void load();
    }, options.interval);
    return () => clearInterval(id);
  }, [options.interval, load, enabled]);

  return {
    data,
    loading,
    refreshing,
    error,
    updatedAt,
    reload: () => setReloading((x) => x + 1),
    refresh: () => {
      void load();
    },
    setData,
  };
}

/* ------------------------------------------------------------------ */
/* Submit guard — جلوگیری از ثبت دوباره با کلیک مکرر                  */
/* ------------------------------------------------------------------ */
export function useSubmitGuard() {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  const run = useCallback(async <R,>(action: () => Promise<R>): Promise<R | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    setBusy(true);
    try {
      return await action();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);

  return { busy, run };
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */
type ToastKind = 'success' | 'error' | 'info' | 'warning';
interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}
interface ToastCtx {
  push: (message: string, kind?: ToastKind) => void;
}
const ToastContext = createContext<ToastCtx>({ push: () => {} });
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const timers = useRef<number[]>([]);

  // تایمرهای Toast هنگام Unmount پاک می‌شوند؛ پیش‌تر پس از بستن صفحه هم
  // setState روی کامپوننت جداشده اجرا می‌شد.
  useEffect(() => {
    return () => {
      for (const id of timers.current) window.clearTimeout(id);
      timers.current = [];
    };
  }, []);

  const push = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = Date.now() + Math.random();
    // حداکثر ۴ Toast هم‌زمان؛ قدیمی‌ترها کنار می‌روند
    setItems((prev) => [...prev.slice(-3), { id, kind, message }]);
    const timer = window.setTimeout(
      () => {
        setItems((prev) => prev.filter((t) => t.id !== id));
        timers.current = timers.current.filter((t) => t !== timer);
      },
      kind === 'error' ? 7000 : 4200
    );
    timers.current.push(timer);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-5 left-5 z-[1200] flex flex-col gap-2 pointer-events-none">
        {items.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto animate-fade-up rounded-soft px-4 py-3 text-sm shadow-pop border backdrop-blur-xl max-w-sm ${
              t.kind === 'success'
                ? 'bg-emerald-50/95 border-emerald-200 text-emerald-800'
                : t.kind === 'error'
                  ? 'bg-red-50/95 border-red-200 text-red-700'
                  : t.kind === 'warning'
                    ? 'bg-sun-50/95 border-sun-200 text-sun-800'
                    : 'bg-white/95 border-ink-200 text-ink-700'
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/* Settings + Meta                                                     */
/* ------------------------------------------------------------------ */
interface MetaData {
  groups: Group[];
  tags: Tag[];
  types: { value: string; count: number }[];
  locations: { value: string; count: number }[];
  vendors: { value: string; count: number }[];
  layers: MapLayer[];
  highLatency: number;
}

interface AppCtx {
  settings: AppSettings | null;
  meta: MetaData | null;
  engine: EngineStatus | null;
  tzOffset: number;
  refreshSettings: () => Promise<void>;
  refreshMeta: () => Promise<void>;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}

const AppContext = createContext<AppCtx>({
  settings: null,
  meta: null,
  engine: null,
  tzOffset: 210,
  refreshSettings: async () => {},
  refreshMeta: async () => {},
  saveSettings: async () => {},
});

export const useApp = () => useContext(AppContext);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [meta, setMeta] = useState<MetaData | null>(null);
  const [engine, setEngine] = useState<EngineStatus | null>(null);

  const refreshSettings = useCallback(async () => {
    try {
      const res = await api.settings();
      setSettings(res.settings);
      setEngine(res.engine);
    } catch {
      /* پوستهٔ برنامه نباید با خطای تنظیمات از کار بیفتد */
    }
  }, []);

  const refreshMeta = useCallback(async () => {
    try {
      const res = await api.deviceMeta();
      setMeta({
        groups: res.groups,
        tags: res.tags,
        types: res.types,
        locations: res.locations,
        vendors: res.vendors,
        layers: res.layers,
        highLatency: res.highLatency ?? 0,
      });
      setSettings((prev) => prev ?? res.settings);
    } catch {
      /* بی‌اثر */
    }
  }, []);

  const saveSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      const res = await api.saveSettings(patch);
      setSettings(res.settings);
      setEngine(res.engine);
    },
    []
  );

  useEffect(() => {
    void refreshSettings();
    void refreshMeta();
  }, [refreshSettings, refreshMeta]);

  const value = useMemo(
    () => ({
      settings,
      meta,
      engine,
      tzOffset: settings?.timezone_offset_minutes ?? 210,
      refreshSettings,
      refreshMeta,
      saveSettings,
    }),
    [settings, meta, engine, refreshSettings, refreshMeta, saveSettings]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

/* ------------------------------------------------------------------ */
/* Live (SSE)                                                          */
/* ------------------------------------------------------------------ */
interface LiveCtx {
  connected: boolean;
  connectionState: 'connecting' | 'live' | 'reconnecting' | 'offline';
  samples: Map<number, LiveSample>;
  alerts: Alert[];
  version: number;
  lastEventAt: number | null;
  reconnectAttempt: number;
}

const LiveContext = createContext<LiveCtx>({
  connected: false,
  connectionState: 'connecting',
  samples: new Map(),
  alerts: [],
  version: 0,
  lastEventAt: null,
  reconnectAttempt: 0,
});

export function useLive() {
  return useContext(LiveContext);
}

export function useDeviceLive(deviceId: number | string | undefined) {
  const { samples } = useLive();
  if (deviceId == null) return undefined;
  return samples.get(Number(deviceId));
}

const MAX_LIVE_ALERTS = 30;
const MAX_RECONNECT_MS = 30000;
/** اگر بیش از این مدت هیچ رویدادی نرسد، اتصال مرده تلقی و بازسازی می‌شود. */
const SILENCE_TIMEOUT_MS = 75000;

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<LiveCtx['connectionState']>('connecting');
  const [samples, setSamples] = useState<Map<number, LiveSample>>(() => new Map());
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [version, setVersion] = useState(0);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  // بافر محدود: هر تجهیز فقط آخرین نمونه را نگه می‌دارد (سقف سخت ۱۰٬۰۰۰)
  const buffer = useRef(new LiveSampleBuffer(10000));
  const flushTimer = useRef<number | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const lastEventRef = useRef<number>(Date.now());
  // وضعیت واقعی اتصال برای کلوزرهای داخل افکت با deps خالی
  const connectedRef = useRef(false);

  useEffect(() => {
    let source: EventSource | null = null;
    let closed = false;
    let attempt = 0;

    const clearFlush = () => {
      if (flushTimer.current != null) {
        window.clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
    };

    const flush = () => {
      flushTimer.current = null;
      const list = buffer.current.drain();
      if (!list.length) return;
      setSamples((prev) => {
        const next = new Map(prev);
        for (const s of list) next.set(s.deviceId, s);
        return next;
      });
      setVersion((v) => v + 1);
    };

    const scheduleFlush = (ms: number) => {
      if (flushTimer.current == null) flushTimer.current = window.setTimeout(flush, ms);
    };

    const markEvent = () => {
      lastEventRef.current = Date.now();
      setLastEventAt(lastEventRef.current);
    };

    const scheduleReconnect = (immediate = false) => {
      if (closed || reconnectTimer.current != null) return;
      const delay = immediate ? 0 : nextReconnectDelay(attempt, { maxMs: MAX_RECONNECT_MS });
      attempt += 1;
      setReconnectAttempt(attempt);
      setConnectionState('reconnecting');
      reconnectTimer.current = window.setTimeout(() => {
        reconnectTimer.current = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (closed) return;
      source?.close();
      setConnectionState((prev) => (prev === 'live' ? 'reconnecting' : 'connecting'));
      source = new EventSource('/api/events');

      source.addEventListener('hello', () => {
        attempt = 0;
        connectedRef.current = true;
        setReconnectAttempt(0);
        setConnected(true);
        setConnectionState('live');
        markEvent();
      });

      source.addEventListener('samples', (ev) => {
        try {
          const list = JSON.parse((ev as MessageEvent).data) as LiveSample[];
          buffer.current.push(list);
          scheduleFlush(500);
          markEvent();
        } catch {
          /* فریم خراب نادیده گرفته می‌شود؛ اتصال حفظ می‌شود */
        }
      });

      source.addEventListener('status', (ev) => {
        try {
          buffer.current.push([JSON.parse((ev as MessageEvent).data) as LiveSample]);
          scheduleFlush(300);
          markEvent();
        } catch {
          /* بی‌اثر */
        }
      });

      source.addEventListener('alert', (ev) => {
        try {
          const a = JSON.parse((ev as MessageEvent).data) as Alert;
          // سقف هشدارهای نگه‌داری‌شده در حافظه
          setAlerts((prev) => [a, ...prev].slice(0, MAX_LIVE_ALERTS));
          setVersion((v) => v + 1);
          markEvent();
        } catch {
          /* بی‌اثر */
        }
      });

      source.addEventListener('alerts-changed', () => {
        setVersion((v) => v + 1);
        markEvent();
      });
      source.addEventListener('engine', () => {
        setVersion((v) => v + 1);
        markEvent();
      });

      source.onopen = () => {
        connectedRef.current = true;
        setConnected(true);
        setConnectionState('live');
      };

      source.onerror = () => {
        // EventSource خودش تلاش می‌کند؛ ما آن را می‌بندیم تا Backoff خودمان
        // (نمایی + Jitter) اعمال شود و سرور با موج اتصال‌های تکراری غرق نشود.
        connectedRef.current = false;
        setConnected(false);
        source?.close();
        source = null;
        scheduleReconnect();
      };
    };

    const reconnectNow = () => {
      if (closed || connectedRef.current) return;
      if (reconnectTimer.current != null) {
        window.clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      scheduleReconnect(true);
    };

    // بازیابی سریع پس از بازگشت تب/شبکه: بدون این، یک تب خوابیده تا ۳۰ ثانیه
    // پس از بیدار شدن دادهٔ کهنه نشان می‌دهد.
    const onOnline = () => reconnectNow();
    const onVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden) reconnectNow();
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);

    // نگهبان سکوت: اتصالی که «باز» است اما هیچ فریمی نمی‌فرستد (پروکسی قطع‌شده)
    const watchdog = window.setInterval(() => {
      if (closed) return;
      if (Date.now() - lastEventRef.current < SILENCE_TIMEOUT_MS) return;
      if (!navigator.onLine) return;
      connectedRef.current = false;
      setConnected(false);
      source?.close();
      source = null;
      scheduleReconnect(true);
    }, 30000);

    connect();

    return () => {
      closed = true;
      clearFlush();
      if (reconnectTimer.current != null) window.clearTimeout(reconnectTimer.current);
      window.clearInterval(watchdog);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
      source?.close();
      source = null;
      buffer.current.clear();
    };
  }, []);

  const value = useMemo(
    () => ({ connected, connectionState, samples, alerts, version, lastEventAt, reconnectAttempt }),
    [connected, connectionState, samples, alerts, version, lastEventAt, reconnectAttempt]
  );
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}
