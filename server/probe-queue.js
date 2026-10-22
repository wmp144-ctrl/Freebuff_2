/**
 * NetWatch — صف مرکزی Probe
 * ----------------------------------------------------------------
 * پیش از این، درخواست‌های دستی و «Ping گروهی» هر کدام یک Promise/فرآیند
 * مستقل می‌ساختند: یک درخواست گروهی با صدها شناسه می‌توانست صدها فرآیند
 * ping و سوکت هم‌زمان راه بیندازد و ظرفیت موتور را نیز دور بزند.
 *
 * این ماژول یک نقطهٔ کنترل واحد است:
 *   • سقف هم‌زمانی مشخص (NETWATCH_PROBE_CONCURRENCY، پیش‌فرض ۴)
 *   • ظرفیت صف مشخص (NETWATCH_PROBE_QUEUE_MAX)؛ پر بودن صف با ۵۰۳ رد می‌شود
 *   • ضدتکرار بر اساس کلید: یک Probe برای یک تجهیز/حالت هم‌زمان دوبار اجرا نمی‌شود
 *     و فراخوانی دوم همان Promise را می‌گیرد
 *   • مهلت سخت برای هر کار (NETWATCH_PROBE_TIMEOUT_MS)؛ پس از آن AbortSignal
 *     فعال و کار با خطای ۵۰۴ بسته می‌شود
 *   • لغو: AbortSignal بیرونی فقط همان منتظر را جدا می‌کند و اگر هیچ منتظری
 *     نماند و cancelWhenNoWaiters روشن باشد، کار لغو می‌شود
 *   • خاموشی: کارهای صف رد و کارهای در اجرا Abort می‌شوند
 *
 * Probeهای موتور خودش سقف max_workers و ضدتکرار inflight دارد؛ این صف
 * مسیرهای API (دستی، زنده و گروهی) را محدود می‌کند تا مجموع عملیات هم‌زمان
 * همیشه کراندار بماند. `engine.checkDevice` نیز برای همان تجهیز، درخواست
 * تکراری را به بررسی در جریان وصل می‌کند.
 */
import { logEvent } from './logger.mjs';

function intEnv(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export const PROBE_CONCURRENCY = intEnv('NETWATCH_PROBE_CONCURRENCY', 4, 1, 32);
export const PROBE_QUEUE_MAX = intEnv('NETWATCH_PROBE_QUEUE_MAX', 64, 1, 1000);
export const PROBE_TIMEOUT_MS = intEnv('NETWATCH_PROBE_TIMEOUT_MS', 45000, 1000, 300000);

// نگه‌داشتن حداکثر ۱۰۰ گزارش گروهی و حذف گزارش‌های کهنه‌تر از ۳۰ دقیقه؛
// وضعیت Job نباید به رشد بی‌مرز حافظه تبدیل شود.
const BATCH_MAX = 100;
const BATCH_TTL_MS = 30 * 60 * 1000;

export class ProbeQueueError extends Error {
  constructor(message, { code = 'PROBE_FAILED', status = 500 } = {}) {
    super(message);
    this.name = 'ProbeQueueError';
    this.code = code;
    this.status = status;
  }
}

export class ProbeQueue {
  constructor({
    concurrency = PROBE_CONCURRENCY,
    maxQueue = PROBE_QUEUE_MAX,
    defaultTimeoutMs = PROBE_TIMEOUT_MS,
    now = () => Date.now(),
  } = {}) {
    this.concurrency = Math.max(1, Math.floor(concurrency));
    this.maxQueue = Math.max(1, Math.floor(maxQueue));
    this.defaultTimeoutMs = Math.max(1000, Math.floor(defaultTimeoutMs));
    this.now = now;
    this.active = 0;
    this.queue = [];
    this.jobs = new Map(); // key -> job (در انتظار یا در اجرا)
    this.shuttingDown = false;
    this.stats = { submitted: 0, deduped: 0, completed: 0, failed: 0, rejected: 0, timeouts: 0, cancelled: 0, maxQueue: 0, maxActive: 0 };
  }

  get pending() {
    return this.queue.length;
  }

  /**
   * ارسال یک کار. کلید یکتا (مثلاً `device:12:manual`) تضمین می‌کند کار
   * هم‌زمان تکراری ساخته نشود.
   * @param {string} key
   * @param {(ctx:{signal:AbortSignal}) => Promise<any>} task
   * @param {{timeoutMs?:number, signal?:AbortSignal, cancelWhenNoWaiters?:boolean}} options
   */
  submit(key, task, { timeoutMs = this.defaultTimeoutMs, signal = null, cancelWhenNoWaiters = false } = {}) {
    if (this.shuttingDown) {
      this.stats.rejected += 1;
      return Promise.reject(new ProbeQueueError('سرور در حال خاموش‌شدن است؛ Probe جدید پذیرفته نمی‌شود.', { code: 'PROBE_SHUTDOWN', status: 503 }));
    }
    const existing = this.jobs.get(key);
    if (existing) {
      this.stats.deduped += 1;
      existing.deduped += 1;
      return this.waitFor(existing, { signal, cancelWhenNoWaiters });
    }
    if (this.active >= this.concurrency && this.queue.length >= this.maxQueue) {
      this.stats.rejected += 1;
      return Promise.reject(
        new ProbeQueueError('ظرفیت صف Probe پر است؛ چند لحظه بعد دوباره تلاش کنید.', { code: 'PROBE_QUEUE_FULL', status: 503 })
      );
    }
    this.stats.submitted += 1;
    const controller = new AbortController();
    const job = {
      key,
      task,
      controller,
      timeoutMs: Math.max(1000, Math.min(this.defaultTimeoutMs, Math.floor(timeoutMs) || this.defaultTimeoutMs)),
      createdAt: this.now(),
      startedAt: null,
      settled: false,
      waiters: 0,
      deduped: 0,
      cancelWhenNoWaiters,
      timer: null,
      resolve: null,
      reject: null,
      promise: null,
    };
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    this.jobs.set(key, job);
    if (this.active < this.concurrency) this.start(job);
    else {
      this.queue.push(job);
      this.stats.maxQueue = Math.max(this.stats.maxQueue, this.queue.length);
    }
    return this.waitFor(job, { signal, cancelWhenNoWaiters });
  }

  /** یک منتظر برای Job؛ AbortSignal فقط همین منتظر را جدا می‌کند. */
  waitFor(job, { signal = null, cancelWhenNoWaiters = false } = {}) {
    job.waiters += 1;
    let detached = false;
    let onAbort = null;
    const detach = () => {
      detached = true;
      job.waiters = Math.max(0, job.waiters - 1);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      if (cancelWhenNoWaiters && job.waiters === 0) this.cancel(job.key);
    };
    const promise = new Promise((resolve, reject) => {
      if (signal) {
        if (signal.aborted) {
          detach();
          return reject(new ProbeQueueError('درخواست Probe لغو شد.', { code: 'PROBE_CANCELLED', status: 499 }));
        }
        onAbort = () => {
          if (job.settled) return;
          detach();
          reject(new ProbeQueueError('درخواست Probe لغو شد.', { code: 'PROBE_CANCELLED', status: 499 }));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      job.promise.then(
        (value) => {
          if (detached) return;
          detach();
          resolve(value);
        },
        (error) => {
          if (detached) return;
          detach();
          reject(error);
        }
      );
    });
    return promise;
  }

  start(job) {
    if (job.settled) return;
    this.active += 1;
    this.stats.maxActive = Math.max(this.stats.maxActive, this.active);
    job.startedAt = this.now();
    job.timer = setTimeout(() => {
      if (job.settled) return;
      this.stats.timeouts += 1;
      try {
        job.controller.abort();
      } catch {
        /* بی‌اثر */
      }
      logEvent('warn', 'probe_timeout', { key: job.key, timeoutMs: job.timeoutMs });
      this.finish(job, new ProbeQueueError('Probe از مهلت مجاز گذشت و متوقف شد.', { code: 'PROBE_TIMEOUT', status: 504 }));
    }, job.timeoutMs);
    if (job.timer.unref) job.timer.unref();

    Promise.resolve()
      .then(() => job.task({ signal: job.controller.signal }))
      .then(
        (value) => this.finish(job, null, value),
        (error) => this.finish(job, error)
      );
  }

  finish(job, error, value) {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    // فقط کاری که واقعاً شروع شده یک جایگاه هم‌زمانی را آزاد می‌کند؛ کار
    // لغوشده در صف نباید ظرفیت یک Probe در حال اجرا را کم کند.
    if (job.startedAt != null) this.active = Math.max(0, this.active - 1);
    if (error) {
      this.stats.failed += 1;
      // خطای شبکه/تجهیز بخشی از نتیجهٔ Probe است و Job را نمی‌شکند؛ ولی خطای
      // غیرمنتظرهٔ ماژول باید دیده شود. متن کوتاه است و راز/مسیر فایل ندارد.
      if (!(error instanceof ProbeQueueError)) {
        logEvent('warn', 'probe_task_failed', { key: job.key, message: String(error?.message || error).slice(0, 200) });
      }
      job.reject(error);
    } else {
      this.stats.completed += 1;
      job.resolve(value);
    }
    this.pump();
  }

  pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      if (!job || job.settled) continue;
      this.start(job);
    }
  }

  /** لغو یک کار در انتظار یا در اجرا (خروجی: آیا کاری لغو شد) */
  cancel(key) {
    const job = this.jobs.get(key);
    if (!job) return false;
    this.stats.cancelled += 1;
    if (job.startedAt == null) {
      const index = this.queue.indexOf(job);
      if (index >= 0) this.queue.splice(index, 1);
      this.finish(job, new ProbeQueueError('Probe پیش از اجرا لغو شد.', { code: 'PROBE_CANCELLED', status: 499 }));
      return true;
    }
    try {
      job.controller.abort();
    } catch {
      /* بی‌اثر */
    }
    this.finish(job, new ProbeQueueError('Probe لغو شد.', { code: 'PROBE_CANCELLED', status: 499 }));
    return true;
  }

  /** آمار سبک برای /health و Application Health */
  snapshot() {
    return {
      concurrency: this.concurrency,
      maxQueue: this.maxQueue,
      active: this.active,
      pending: this.queue.length,
      running: this.jobs.size,
      ...this.stats,
    };
  }

  /** خاموشی تمیز: هیچ کار در انتظار/در اجرا باقی نمی‌ماند */
  shutdown() {
    this.shuttingDown = true;
    const queued = this.queue.splice(0, this.queue.length);
    for (const job of queued) {
      this.finish(job, new ProbeQueueError('Probe به دلیل خاموش‌شدن سرور متوقف شد.', { code: 'PROBE_SHUTDOWN', status: 503 }));
    }
    for (const job of [...this.jobs.values()]) {
      try {
        job.controller.abort();
      } catch {
        /* بی‌اثر */
      }
      this.finish(job, new ProbeQueueError('Probe به دلیل خاموش‌شدن سرور متوقف شد.', { code: 'PROBE_SHUTDOWN', status: 503 }));
    }
    return { cancelled: queued.length };
  }
}

export const probeQueue = new ProbeQueue();

/* ------------------------------------------------------------------ */
/* Jobهای گروهی قابل پیگیری                                           */
/* ------------------------------------------------------------------ */

const batches = new Map();
let batchSeq = 0;

function pruneBatches(now = Date.now()) {
  for (const [id, job] of batches) {
    if (now - job.createdAt > BATCH_TTL_MS) batches.delete(id);
  }
  while (batches.size > BATCH_MAX) {
    const oldest = [...batches.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (!oldest) break;
    batches.delete(oldest[0]);
  }
}

/**
 * ساخت Job گروهی برای Probeهای طولانی. عملیات در پس‌زمینه اجرا می‌شود و
 * وضعیت آن از مسیر `/api/devices/bulk/probe/:jobId` قابل پیگیری است.
 */
export function createProbeBatch({ total, skipped = 0, kind = 'bulk-ping', owner = null } = {}) {
  pruneBatches();
  batchSeq += 1;
  const id = `probe-${Date.now().toString(36)}-${batchSeq.toString(36)}`;
  const job = {
    id,
    kind,
    owner,
    status: 'running',
    total: Math.max(0, Number(total) || 0),
    skipped: Math.max(0, Number(skipped) || 0),
    queued: 0,
    completed: 0,
    failed: 0,
    results: [],
    createdAt: Date.now(),
    finishedAt: null,
  };
  batches.set(id, job);
  return job;
}

export function recordProbeBatchResult(id, result) {
  const job = batches.get(id);
  if (!job) return null;
  job.queued += 1;
  if (result?.error) {
    job.failed += 1;
    // فهرست خطاها سقف دارد؛ برای صدها تجهیز، Job نباید به حافظهٔ بی‌مرز تبدیل شود.
    if (job.results.length < 200) job.results.push({ deviceId: result.deviceId ?? null, error: String(result.error).slice(0, 160) });
  } else {
    job.completed += 1;
  }
  if (job.queued >= job.total) {
    job.status = job.failed > 0 ? 'done-with-errors' : 'done';
    job.finishedAt = Date.now();
  }
  return job;
}

export function getProbeBatch(id) {
  pruneBatches();
  const job = batches.get(id);
  if (!job) return null;
  return {
    id: job.id,
    kind: job.kind,
    owner: job.owner,
    status: job.status,
    total: job.total,
    skipped: job.skipped,
    queued: job.queued,
    completed: job.completed,
    failed: job.failed,
    results: job.results,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

export function setProbeBatchOwner(id, owner) {
  const job = batches.get(id);
  if (job) job.owner = owner;
  return job;
}

export function probeJobStats() {
  pruneBatches();
  return { jobs: batches.size, maxJobs: BATCH_MAX, ttlMs: BATCH_TTL_MS };
}

export default { probeQueue, ProbeQueue, ProbeQueueError, createProbeBatch, recordProbeBatchResult, getProbeBatch, probeJobStats };
