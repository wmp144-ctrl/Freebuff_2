/**
 * NetWatch — سنجه‌های داخلی برنامه (Application Health)
 * ----------------------------------------------------------------
 * هدف: پاسخ به این پرسش‌ها بدون ابزار بیرونی:
 *   • برنامه چقدر CPU/RAM/Heap مصرف می‌کند؟
 *   • حلقهٔ رویداد چقدر عقب می‌افتد (Event Loop Delay)؟
 *   • کدام Query کند است و چند درصد تأخیر دارد؟
 *   • چند اتصال SSE/پروب فعال و چند عملیات در صف است؟
 *
 * این ماژول هیچ وابستگی‌ای به db.js/engine.js ندارد تا حلقهٔ import ساخته نشود؛
 * مصرف‌کننده‌ها مقدار را ثبت می‌کنند و لایهٔ API آن را با وضعیت موتور/SSE ترکیب
 * می‌کند. همهٔ ساختارهای داده سقف‌دار هستند تا خود سنجه‌ها منبع نشتی نباشند.
 */
import os from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

/* ------------------------------ حلقه‌ها ------------------------------ */

/** حلقهٔ عددی با میانگین/صدک؛ حافظهٔ ثابت و بدون رشد نامحدود. */
class Ring {
  constructor(size = 256) {
    this.size = Math.max(8, size);
    this.values = new Float64Array(this.size);
    this.index = 0;
    this.count = 0;
  }

  push(value) {
    if (!Number.isFinite(value)) return;
    this.values[this.index] = value;
    this.index = (this.index + 1) % this.size;
    if (this.count < this.size) this.count += 1;
  }

  stats() {
    const n = this.count;
    if (!n) return { count: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    const arr = Array.from(this.values.subarray(0, n)).sort((a, b) => a - b);
    const at = (p) => arr[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))];
    let sum = 0;
    for (const v of arr) sum += v;
    return {
      count: n,
      mean: round(sum / n, 2),
      p50: round(at(50), 2),
      p95: round(at(95), 2),
      p99: round(at(99), 2),
      max: round(arr[n - 1], 2),
    };
  }

  clear() {
    this.index = 0;
    this.count = 0;
  }
}

function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(Number(n) * f) / f;
}

/* --------------------------- تأخیر حلقه رویداد --------------------------- */

const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();

function eventLoopStats() {
  const pct = (p) => round(eventLoop.percentile(p) / 1e6, 2);
  return {
    mean: round(eventLoop.mean / 1e6, 2),
    p50: pct(50),
    p95: pct(95),
    p99: pct(99),
    max: round(eventLoop.max / 1e6, 2),
    resolutionMs: 20,
  };
}

/* ------------------------------ CPU / RAM ------------------------------ */

const processStart = Date.now();
let lastCpu = process.cpuUsage();
let lastCpuAt = Date.now();

/** درصد CPU فرآیند نسبت به کل ظرفیت سرور (۰..۱۰۰×هسته) */
function cpuSnapshot() {
  const now = Date.now();
  const usage = process.cpuUsage(lastCpu);
  const elapsedMs = Math.max(1, now - lastCpuAt);
  lastCpu = process.cpuUsage();
  lastCpuAt = now;
  const cpuMs = (usage.user + usage.system) / 1000;
  const cores = os.cpus().length || 1;
  return {
    processPct: round((cpuMs / elapsedMs) * 100, 2),
    systemPct: round((cpuMs / (elapsedMs * cores)) * 100, 2),
    cores,
    loadAvg: os.loadavg().map((n) => round(n, 2)),
  };
}

function memorySnapshot() {
  const m = process.memoryUsage();
  return {
    rssBytes: m.rss,
    heapTotalBytes: m.heapTotal,
    heapUsedBytes: m.heapUsed,
    externalBytes: m.external,
    arrayBuffersBytes: m.arrayBuffers ?? 0,
    rssMb: round(m.rss / 1048576, 1),
    heapUsedMb: round(m.heapUsed / 1048576, 1),
    heapTotalMb: round(m.heapTotal / 1048576, 1),
  };
}

/* -------------------------- تأخیر Query پایگاه‌داده -------------------------- */

const SQL_MAX_KEYS = 300;
const queryOverall = new Ring(512);
const queryByKey = new Map(); // key → { sql, count, total, max, errors, ring }
let queryCount = 0;
let queryErrors = 0;
let slowQueryCount = 0;
let slowQueryTotalMs = 0;
const slowQueries = [];
const SLOW_QUERY_MS = 50;

/** SQL را برای گروه‌بندی نرمال می‌کند: فاصله‌ها، اعداد و رشته‌ها حذف می‌شوند. */
export function normalizeSql(sql) {
  return String(sql || '')
    .replace(/\s+/g, ' ')
    .replace(/'[^']*'/g, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .trim()
    .slice(0, 240);
}

/** ثبت زمان اجرای یک Query (از db.js فراخوانی می‌شود). */
export function recordQuery(sql, durationMs, failed = false) {
  if (!Number.isFinite(durationMs)) return;
  queryCount += 1;
  if (failed) queryErrors += 1;
  queryOverall.push(durationMs);
  const key = normalizeSql(sql);
  let entry = queryByKey.get(key);
  if (!entry) {
    if (queryByKey.size >= SQL_MAX_KEYS) {
      // سقف کش: کلید کم‌کاربرد حذف می‌شود تا حافظه با Queryهای داینامیک رشد نکند.
      let minKey = null;
      let minCount = Infinity;
      for (const [k, v] of queryByKey) if (v.count < minCount) ((minCount = v.count), (minKey = k));
      if (minKey) queryByKey.delete(minKey);
    }
    entry = { sql: key, count: 0, total: 0, max: 0, errors: 0, ring: new Ring(64) };
    queryByKey.set(key, entry);
  }
  entry.count += 1;
  entry.total += durationMs;
  entry.max = Math.max(entry.max, durationMs);
  if (failed) entry.errors += 1;
  entry.ring.push(durationMs);
  if (durationMs >= SLOW_QUERY_MS) {
    slowQueryCount += 1;
    slowQueryTotalMs += durationMs;
    slowQueries.push({ sql: key, ms: round(durationMs, 2), at: Date.now() });
    if (slowQueries.length > 20) slowQueries.shift();
  }
}

export function queryStats({ top = 10 } = {}) {
  const rows = [...queryByKey.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, top)
    .map((e) => ({
      sql: e.sql,
      count: e.count,
      avgMs: round(e.total / Math.max(1, e.count), 3),
      maxMs: round(e.max, 2),
      errors: e.errors,
      latency: e.ring.stats(),
    }));
  return {
    count: queryCount,
    errors: queryErrors,
    slow: { thresholdMs: SLOW_QUERY_MS, count: slowQueryCount, totalMs: round(slowQueryTotalMs, 1) },
    overall: queryOverall.stats(),
    top: rows,
    recentSlow: [...slowQueries].reverse(),
  };
}

/* -------------------------------- API -------------------------------- */

const API_MAX_ROUTES = 120;
const apiRouteMap = new Map(); // route → Ring
const apiOverall = new Ring(1024);
let apiCount = 0;
let apiServerErrors = 0;

/** مسیر را برای گروه‌بندی نرمال می‌کند؛ شناسه‌های عددی/hex جایگزین می‌شوند. */
export function normalizeRoute(pathname) {
  return String(pathname || '')
    .split('?')[0]
    .replace(/\/[0-9a-f]{8,}(?=\/|$)/gi, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .slice(0, 120);
}

export function recordApi(method, pathname, status, durationMs) {
  if (!Number.isFinite(durationMs)) return;
  apiCount += 1;
  if (status >= 500) apiServerErrors += 1;
  apiOverall.push(durationMs);
  const route = `${String(method || 'GET').toUpperCase()} ${normalizeRoute(pathname)}`;
  let ring = apiRouteMap.get(route);
  if (!ring) {
    if (apiRouteMap.size >= API_MAX_ROUTES) {
      // قدیمی‌ترین (نخستین) کلید حذف می‌شود؛ ترتیب Map = ترتیب ورود
      const first = apiRouteMap.keys().next().value;
      if (first) apiRouteMap.delete(first);
    }
    ring = new Ring(256);
    apiRouteMap.set(route, ring);
  }
  ring.push(durationMs);
}

export function apiStats({ top = 15 } = {}) {
  const routes = [...apiRouteMap.entries()]
    .map(([route, ring]) => {
      const s = ring.stats();
      return { route, count: s.count, p50: s.p50, p95: s.p95, p99: s.p99, max: s.max };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, top);
  return {
    count: apiCount,
    serverErrors: apiServerErrors,
    overall: apiOverall.stats(),
    routes,
  };
}

/* ------------------------------ تاریخچه ------------------------------ */

const HISTORY_SIZE = 720; // ۵s × 720 = ۱ ساعت
const history = [];
let historyTimer = null;

function sampleHistory() {
  const mem = memorySnapshot();
  const eld = eventLoopStats();
  const api = apiOverall.stats();
  const q = queryOverall.stats();
  history.push({
    t: Date.now(),
    cpuPct: cpuSnapshot().processPct,
    rssMb: mem.rssMb,
    heapMb: mem.heapUsedMb,
    eldP99: eld.p99,
    apiP95: api.p95,
    dbP95: q.p95,
  });
  if (history.length > HISTORY_SIZE) history.splice(0, history.length - HISTORY_SIZE);
  return history[history.length - 1];
}

/** نمونه‌گیری دوره‌ای برای نمودارهای صفحهٔ Application Health. */
export function startSampling(intervalMs = 5000) {
  if (historyTimer) return;
  sampleHistory();
  historyTimer = setInterval(sampleHistory, Math.max(1000, intervalMs));
  if (historyTimer.unref) historyTimer.unref();
}

export function stopSampling() {
  if (historyTimer) clearInterval(historyTimer);
  historyTimer = null;
}

export function historySnapshot(limit = HISTORY_SIZE) {
  return history.slice(-limit);
}

/* ------------------------------ خروجی کلی ------------------------------ */

export function metricsSnapshot() {
  const mem = memorySnapshot();
  return {
    generatedAt: Date.now(),
    uptimeSec: Math.round((Date.now() - processStart) / 1000),
    node: process.version,
    cpu: cpuSnapshot(),
    memory: mem,
    eventLoop: eventLoopStats(),
    queries: { count: queryCount, errors: queryErrors, overall: queryOverall.stats() },
    api: { count: apiCount, serverErrors: apiServerErrors, overall: apiOverall.stats() },
    handles: typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo().length : null,
  };
}

export const __test = { Ring, history, resetForTests };

/** فقط برای آزمون‌ها: پاک‌کردن سنجه‌ها بدون توقف هیستوگرام */
function resetForTests() {
  queryOverall.clear();
  queryByKey.clear();
  queryCount = 0;
  queryErrors = 0;
  slowQueryCount = 0;
  slowQueryTotalMs = 0;
  slowQueries.length = 0;
  apiOverall.clear();
  apiRouteMap.clear();
  apiCount = 0;
  apiServerErrors = 0;
  history.length = 0;
}

export { performance };
