/**
 * NetWatch — صف کارهای سنگین در Worker Thread
 * ----------------------------------------------------------------
 * • حداکثر هم‌زمانی محدود است تا چند فایل بزرگ همهٔ CPU را نگیرند.
 * • صف سقف دارد؛ بار بیش از ظرفیت با ۵۰۳ رد می‌شود، نه با رشد بی‌مرز حافظه.
 * • هر کار مهلت دارد؛ کارگر گیرکرده terminate و حافظه‌اش آزاد می‌شود.
 * • آمار برای /api/system/health و گزارش عملکرد در دسترس است.
 */
import { Worker } from 'node:worker_threads';
import { logEvent } from './logger.mjs';

const WORKER_URL = new URL('./workers/impexp-worker.js', import.meta.url);

function intEnv(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const MAX_CONCURRENCY = intEnv('NETWATCH_JOB_CONCURRENCY', 2, 1, 8);
const MAX_QUEUE = intEnv('NETWATCH_JOB_QUEUE_MAX', 24, 1, 500);
const DEFAULT_TIMEOUT_MS = intEnv('NETWATCH_JOB_TIMEOUT_MS', 180000, 5000, 600000);

const queue = [];
const activeWorkers = new Set();
let shuttingDown = false;
const stats = {
  queued: 0,
  running: 0,
  completed: 0,
  failed: 0,
  rejected: 0,
  timeouts: 0,
  maxQueue: 0,
  maxRunning: 0,
};

export class JobError extends Error {
  constructor(message, { code = 'JOB_FAILED', status = 500 } = {}) {
    super(message);
    this.name = 'JobError';
    this.code = code;
    this.status = status;
  }
}

function pump() {
  while (stats.running < MAX_CONCURRENCY && queue.length) {
    const job = queue.shift();
    stats.queued = queue.length;
    stats.running += 1;
    stats.maxRunning = Math.max(stats.maxRunning, stats.running);
    execute(job).finally(() => {
      stats.running -= 1;
      pump();
    });
  }
}

function execute(job) {
  return new Promise((resolve) => {
    let settled = false;
    let worker;
    try {
      worker = new Worker(WORKER_URL);
      activeWorkers.add(worker);
    } catch (e) {
      stats.failed += 1;
      job.reject(new JobError(`راه‌اندازی کارگر پردازش ناموفق بود: ${e.message}`, { code: 'WORKER_START' }));
      return resolve();
    }

    const finish = (ok, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeWorkers.delete(worker);
      // terminate برای آزادسازی فوری حافظهٔ کارگر و جلوگیری از نشتی Worker
      worker.terminate().catch(() => {});
      if (ok) job.resolve(value);
      else job.reject(value);
      resolve();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      stats.timeouts += 1;
      logEvent('error', 'job_timeout', { type: job.type, timeoutMs: job.timeoutMs });
      finish(false, new JobError('پردازش بیش از حد طول کشید و متوقف شد. دوباره تلاش کنید.', { code: 'JOB_TIMEOUT', status: 504 }));
    }, job.timeoutMs);

    worker.once('message', (msg) => {
      if (msg?.ok) {
        stats.completed += 1;
        finish(true, msg.result);
      } else {
        stats.failed += 1;
        finish(false, new JobError(msg?.error || 'پردازش فایل ناموفق بود.', { code: 'JOB_FAILED' }));
      }
    });
    worker.once('error', (err) => {
      stats.failed += 1;
      logEvent('error', 'job_worker_error', { type: job.type, message: err?.message });
      finish(false, new JobError(`پردازش فایل ناموفق بود: ${err?.message || err}`, { code: 'WORKER_ERROR' }));
    });
    worker.once('exit', (code) => {
      if (!settled && code !== 0) {
        stats.failed += 1;
        finish(false, new JobError('کارگر پردازش به‌طور غیرمنتظره متوقف شد.', { code: 'WORKER_EXIT' }));
      }
    });

    try {
      worker.postMessage({ type: job.type, payload: job.payload });
    } catch (e) {
      stats.failed += 1;
      finish(false, new JobError(`ارسال داده به کارگر ناموفق بود: ${e.message}`, { code: 'WORKER_POST' }));
    }
  });
}

/**
 * اجرای یک کار در Worker Thread.
 * @param {string} type نوع کار (parse، devicesPreview، export، mbtilesInfo، …)
 * @param {object} payload دادهٔ قابل Clone
 * @param {{timeoutMs?: number}} options
 */
export function runJob(type, payload = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (shuttingDown) {
      stats.rejected += 1;
      return reject(new JobError('سرور در حال خاموش‌شدن است؛ کار جدید پذیرفته نمی‌شود.', { code: 'JOB_SHUTDOWN', status: 503 }));
    }
    if (queue.length >= MAX_QUEUE) {
      stats.rejected += 1;
      return reject(new JobError('صف پردازش فایل پر است؛ چند لحظه بعد دوباره تلاش کنید.', { code: 'JOB_QUEUE_FULL', status: 503 }));
    }
    queue.push({ type, payload, resolve, reject, timeoutMs });
    stats.queued = queue.length;
    stats.maxQueue = Math.max(stats.maxQueue, queue.length);
    pump();
  });
}

export function jobStats() {
  return { ...stats, activeWorkers: activeWorkers.size, maxConcurrency: MAX_CONCURRENCY, maxQueueSize: MAX_QUEUE, shuttingDown };
}

/**
 * خاموش‌سازی کنترل‌شدهٔ صف: کارهای در انتظار با خطای مشخص رد و Workerهای فعال
 * terminate می‌شوند. بدون این کار، Workerها و تایمر مهلتشان پس از خاموشی
 * سرور زنده می‌مانند.
 */
export function shutdownJobs(reason = 'shutdown') {
  shuttingDown = true;
  const err = new JobError(`پردازش فایل به دلیل خاموش‌شدن سرور متوقف شد (${reason}).`, { code: 'JOB_SHUTDOWN', status: 503 });
  const queued = queue.splice(0, queue.length);
  stats.queued = 0;
  for (const job of queued) {
    stats.rejected += 1;
    try {
      job.reject(err);
    } catch {
      /* بی‌اثر */
    }
  }
  const running = activeWorkers.size;
  for (const worker of [...activeWorkers]) {
    try {
      worker.terminate();
    } catch {
      /* بی‌اثر */
    }
  }
  activeWorkers.clear();
  return { cancelled: queued.length, terminated: running };
}
