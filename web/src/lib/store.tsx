import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, isAbortError } from './api';
import { errorMessage, LatestRequestGate } from './async-gate';
import { LiveSampleBuffer, nextReconnectDelay, shouldApplySample, type LiveSample } from './live-core';
import type { Alert, AppSettings, EngineStatus, Group, MapLayer, StatusData, Tag } from './types';

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
  /** وضعیت سرور/موتور/سلامت برنامه — یک منبع مشترک برای نوار وضعیت و داشبورد */
  status: StatusData | null;
  statusError: string | null;
  tzOffset: number;
  refreshSettings: () => Promise<void>;
  refreshMeta: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}

const AppContext = createContext<AppCtx>({
  settings: null,
  meta: null,
  engine: null,
  status: null,
  statusError: null,
  tzOffset: 210,
  refreshSettings: async () => {},
  refreshMeta: async () => {},
  refreshStatus: async () => {},
  saveSettings: async () => {},
});

export const useApp = () => useContext(AppContext);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [meta, setMeta] = useState<MetaData | null>(null);
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [status, setStatus] = useState<StatusData | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

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

  // وضعیت سامانه یک‌بار در همین Provider دریافت می‌شود؛ پیش‌تر فقط نوار وضعیت
  // آن را می‌گرفت و افزودن کارت سلامت برنامه به داشبورد، درخواست را دو برابر
  // می‌کرد. در تب پنهان هم درخواستی ارسال نمی‌شود.
  const refreshStatus = useCallback(async () => {
    try {
      const res = await api.status();
      setStatus(res);
      setStatusError(null);
    } catch (e) {
      setStatusError(e instanceof ApiError ? e.message : errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void refreshSettings();
    void refreshMeta();
    void refreshStatus();
  }, [refreshSettings, refreshMeta, refreshStatus]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void refreshStatus();
    }, 15000);
    return () => window.clearInterval(id);
  }, [refreshStatus]);

  const value = useMemo(
    () => ({
      settings,
      meta,
      engine,
      status,
      statusError,
      tzOffset: settings?.timezone_offset_minutes ?? 210,
      refreshSettings,
      refreshMeta,
      refreshStatus,
      saveSettings,
    }),
    [settings, meta, engine, status, statusError, refreshSettings, refreshMeta, refreshStatus, saveSettings]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

/* ------------------------------------------------------------------ */
/* Live (SSE)                                                          */
/* ------------------------------------------------------------------ */
/** وضعیت اتصال/هشدارها — بدون نگاشت نمونه‌ها تا تغییر هر نمونه، کل صفحه را رندر نکند */
interface LiveStateCtx {
  connected: boolean;
  connectionState: 'connecting' | 'live' | 'reconnecting' | 'offline';
  alerts: Alert[];
  /** نسخهٔ رویدادهای معنایی (هشدار/وضعیت/موتور)، نه هر دستهٔ نمونه */
  version: number;
  /** نسخهٔ نمونه‌ها؛ فقط مصرف‌کنندگان دادهٔ زندهٔ تجهیز به آن وابسته‌اند */
  sampleVersion: number;
  lastEventAt: number | null;
  reconnectAttempt: number;
  /** پس از اتصال مجدد افزایش می‌یابد تا صفحه‌ها Snapshot تازه بگیرند */
  syncToken: number;
  /** ثبت/حذف اشتراک نمونه‌های یک تجهیز (سرور فقط همان‌ها را می‌فرستد) */
  watchDevice: (deviceId: number) => void;
  unwatchDevice: (deviceId: number) => void;
}

interface LiveCtx extends LiveStateCtx {
  samples: Map<number, LiveSample>;
}

const EMPTY_SAMPLES = new Map<number, LiveSample>();

const LiveStateContext = createContext<LiveStateCtx>({
  connected: false,
  connectionState: 'connecting',
  alerts: [],
  version: 0,
  sampleVersion: 0,
  lastEventAt: null,
  reconnectAttempt: 0,
  syncToken: 0,
  watchDevice: () => {},
  unwatchDevice: () => {},
});
// نگاشت نمونه‌ها Context جداست: Layout/وضعیت اتصال با هر نمونه رندر نمی‌شوند.
const LiveSamplesContext = createContext<Map<number, LiveSample>>(EMPTY_SAMPLES);

/** فقط وضعیت اتصال/هشدارها؛ بدون اشتراک در نمونه‌های هر تجهیز */
export function useLiveState() {
  return useContext(LiveStateContext);
}

/** نگاشت کامل نمونه‌های زنده (مصرف‌کننده‌های حساس به دادهٔ لحظه‌ای) */
export function useLiveSamples() {
  return useContext(LiveSamplesContext);
}

/** سازگاری: ترکیب وضعیت و نمونه‌ها؛ در کامپوننت‌های سنگین از useLiveState استفاده کنید. */
export function useLive(): LiveCtx {
  const state = useLiveState();
  const samples = useLiveSamples();
  return useMemo(() => ({ ...state, samples }), [state, samples]);
}

export function useDeviceLive(deviceId: number | string | undefined) {
  const samples = useLiveSamples();
  const { watchDevice, unwatchDevice } = useLiveState();
  const numeric = deviceId == null ? null : Number(deviceId);
  // هر کارت/صفحه‌ای که دادهٔ زندهٔ یک تجهیز را نشان می‌دهد، آن را اشتراک می‌کند؛
  // سرور دیگر نمونهٔ همهٔ تجهیزات را برای همهٔ کلاینت‌ها نمی‌فرستد.
  useEffect(() => {
    if (numeric == null || !Number.isFinite(numeric)) return;
    watchDevice(numeric);
    return () => unwatchDevice(numeric);
  }, [numeric, watchDevice, unwatchDevice]);
  return numeric == null ? undefined : samples.get(numeric);
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
  const [sampleVersion, setSampleVersion] = useState(0);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [syncToken, setSyncToken] = useState(0);

  // بافر محدود: هر تجهیز فقط آخرین نمونه را نگه می‌دارد (سقف سخت ۱۰٬۰۰۰)
  const buffer = useRef(new LiveSampleBuffer(10000));
  const flushTimer = useRef<number | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const lastEventRef = useRef<number>(Date.now());
  // lastEventAt فقط هر ۱۰ ثانیه در state منتشر می‌شود؛ نمونه‌های هر ۵۰۰ms
  // نباید Context وضعیت را عوض کنند (وگرنه همهٔ مصرف‌کنندگان رندر می‌شوند).
  const lastEventPublished = useRef<number>(0);
  // وضعیت واقعی اتصال برای کلوزرهای داخل افکت با deps خالی
  const connectedRef = useRef(false);
  // تجهیزات تحت نمایش این تب؛ با تغییر آن اتصال SSE به‌صورت بی‌صدا بازسازی
  // می‌شود تا فیلتر سمت سرور اعمال شود.
  const watchIds = useRef(new Set<number>());
  const resubscribeRef = useRef<null | (() => void)>(null);

  const watchDevice = useCallback((id: number) => {
    if (watchIds.current.has(id)) return;
    watchIds.current.add(id);
    resubscribeRef.current?.();
  }, []);
  const unwatchDevice = useCallback((id: number) => {
    if (!watchIds.current.delete(id)) return;
    resubscribeRef.current?.();
  }, []);

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
        for (const s of list) {
          // رویداد قدیمی/تکراری نباید داده تازه‌تر را بازنویسی کند؛ این حالت پس از
          // اتصال مجدد یا بازپخش بافر رخ می‌دهد.
          if (!shouldApplySample(next.get(s.deviceId), s)) continue;
          next.set(s.deviceId, s);
        }
        return next;
      });
      // نسخهٔ نمونه‌ها جدا از نسخهٔ رویدادهای معنایی است؛ پیش‌تر هر دستهٔ نمونه
      // باعث اجرای دوبارهٔ افکت‌های وابسته به version (و درخواست تکراری API) می‌شد.
      setSampleVersion((v) => v + 1);
    };

    const scheduleFlush = (ms: number) => {
      if (flushTimer.current == null) flushTimer.current = window.setTimeout(flush, ms);
    };

    const markEvent = () => {
      const now = Date.now();
      lastEventRef.current = now;
      if (now - lastEventPublished.current < 10000) return;
      lastEventPublished.current = now;
      setLastEventAt(now);
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
      // همیشه پارامتر devices فرستاده می‌شود (حتی خالی) تا سرور نمونه‌های
      // تجهیزات بدون مصرف‌کننده را منتقل نکند.
      const watch = [...watchIds.current].join(',');
      source = new EventSource(`/api/events?devices=${watch}`);

      source.addEventListener('hello', () => {
        const resumed = attempt > 0;
        attempt = 0;
        connectedRef.current = true;
        setReconnectAttempt(0);
        setConnected(true);
        setConnectionState('live');
        markEvent();
        // اتصال تازه یعنی ممکن است رویدادهایی از دست رفته باشد؛ صفحه‌ها باید
        // Snapshot را دوباره بگیرند، نه اینکه به داده قبل از قطع اتصال تکیه کنند.
        if (resumed) setSyncToken((v) => v + 1);
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
          // همان هشدار ممکن است پس از اتصال مجدد دوباره برسد؛ نباید تکراری شود.
          setAlerts((prev) => (prev.some((x) => x.id === a.id) ? prev : [a, ...prev].slice(0, MAX_LIVE_ALERTS)));
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

    // تغییر اشتراک: اتصال فعلی بسته و با فهرست تازه باز می‌شود. این کار عمداً
    // وضعیت «reconnecting» را تغییر نمی‌دهد (اتصال پایدار است، فقط فیلتر عوض شده).
    let subTimer: number | null = null;
    resubscribeRef.current = () => {
      if (closed) return;
      if (subTimer != null) window.clearTimeout(subTimer);
      subTimer = window.setTimeout(() => {
        subTimer = null;
        if (closed) return;
        attempt = 0;
        source?.close();
        source = null;
        connect();
      }, 300);
    };

    connect();

    return () => {
      closed = true;
      resubscribeRef.current = null;
      if (subTimer != null) window.clearTimeout(subTimer);
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

  const stateValue = useMemo(
    () => ({
      connected,
      connectionState,
      alerts,
      version,
      sampleVersion,
      lastEventAt,
      reconnectAttempt,
      syncToken,
      watchDevice,
      unwatchDevice,
    }),
    [connected, connectionState, alerts, version, sampleVersion, lastEventAt, reconnectAttempt, syncToken, watchDevice, unwatchDevice]
  );
  return (
    <LiveStateContext.Provider value={stateValue}>
      <LiveSamplesContext.Provider value={samples}>{children}</LiveSamplesContext.Provider>
    </LiveStateContext.Provider>
  );
}
