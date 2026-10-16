import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from './api';
import type { Alert, AppSettings, EngineStatus, Group, MapLayer, Tag } from './types';

/* ------------------------------------------------------------------ */
/* useAsync                                                            */
/* ------------------------------------------------------------------ */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[],
  options: { interval?: number; enabled?: boolean } = {}
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const enabled = options.enabled !== false;

  const load = useCallback(async () => {
    try {
      setError(null);
      const result = await fnRef.current();
      setData(result);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message || 'خطای نامشخص');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    (async () => {
      try {
        const result = await fnRef.current();
        if (alive) {
          setData(result);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof ApiError ? e.message : (e as Error).message || 'خطای نامشخص');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, reloading, enabled]);

  useEffect(() => {
    if (!options.interval || !enabled) return;
    const id = setInterval(() => {
      // در تب‌های پنهان، دریافت دوره‌ای داده بی‌فایده است و فقط سرور را مشغول می‌کند
      if (typeof document !== 'undefined' && document.hidden) return;
      load();
    }, options.interval);
    return () => clearInterval(id);
  }, [options.interval, load, enabled]);

  return { data, loading, error, reload: () => setReloading((x) => x + 1), setData, refresh: load };
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
  const push = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev.slice(-3), { id, kind, message }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 4200);
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
      /* بی‌اثر */
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
    refreshSettings();
    refreshMeta();
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
export interface LiveSample {
  deviceId: number;
  ts: number;
  status: string;
  rtt: number | null;
  lossPct: number;
  ok: boolean;
  mode: string;
}

interface LiveCtx {
  connected: boolean;
  samples: Map<number, LiveSample>;
  alerts: Alert[];
  version: number;
  lastEventAt: number | null;
}

const LiveContext = createContext<LiveCtx>({ connected: false, samples: new Map(), alerts: [], version: 0, lastEventAt: null });

export function useLive() {
  return useContext(LiveContext);
}

export function useDeviceLive(deviceId: number | string | undefined) {
  const { samples } = useLive();
  if (deviceId == null) return undefined;
  return samples.get(Number(deviceId));
}

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [samples, setSamples] = useState<Map<number, LiveSample>>(() => new Map());
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [version, setVersion] = useState(0);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const pending = useRef<LiveSample[]>([]);
  const timer = useRef<number | null>(null);
  const reconnect = useRef<number | null>(null);

  useEffect(() => {
    let source: EventSource | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      source = new EventSource('/api/events');

      source.addEventListener('hello', () => setConnected(true));

      const flush = () => {
        setSamples((prev) => {
          const next = new Map(prev);
          for (const s of pending.current) next.set(s.deviceId, s);
          return next;
        });
        if (pending.current.length) {
          setVersion((v) => v + 1);
          setLastEventAt(Date.now());
        }
        pending.current = [];
        timer.current = null;
      };

      source.addEventListener('samples', (ev) => {
        try {
          const list = JSON.parse((ev as MessageEvent).data) as LiveSample[];
          pending.current.push(...list);
          if (timer.current == null) timer.current = window.setTimeout(flush, 500);
        } catch {
          /* بی‌اثر */
        }
      });

      source.addEventListener('status', (ev) => {
        try {
          const s = JSON.parse((ev as MessageEvent).data) as LiveSample;
          pending.current.push(s);
          if (timer.current == null) timer.current = window.setTimeout(flush, 300);
        } catch {
          /* بی‌اثر */
        }
      });

      source.addEventListener('alert', (ev) => {
        try {
          const a = JSON.parse((ev as MessageEvent).data) as Alert;
          setAlerts((prev) => [a, ...prev].slice(0, 20));
          setVersion((v) => v + 1);
          setConnected(true);
          setLastEventAt(Date.now());
        } catch {
          /* بی‌اثر */
        }
      });

      source.addEventListener('alerts-changed', () => setVersion((v) => v + 1));
      source.addEventListener('engine', () => setVersion((v) => v + 1));

      source.onopen = () => setConnected(true);
      source.onerror = () => {
        setConnected(false);
        source?.close();
        // زمان‌بندی اتصال مجدد فقط یک‌بار و با شناسهٔ قابل‌پاک‌سازی ثبت می‌شود
        if (!closed && reconnect.current == null) {
          reconnect.current = window.setTimeout(() => {
            reconnect.current = null;
            connect();
          }, 4000);
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (timer.current) window.clearTimeout(timer.current);
      if (reconnect.current) window.clearTimeout(reconnect.current);
      source?.close();
    };
  }, []);

  const value = useMemo(() => ({ connected, samples, alerts, version, lastEventAt }), [connected, samples, alerts, version, lastEventAt]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

