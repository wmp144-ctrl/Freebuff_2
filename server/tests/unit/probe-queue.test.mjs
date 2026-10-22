/**
 * صف مرکزی Probe (Regression BUG-02/BUG-05):
 *   • سقف هم‌زمانی هرگز دور زده نمی‌شود
 *   • ظرفیت صف مشخص است و سرریز با ۵۰۳ رد می‌شود
 *   • کلید تکراری همان Promise را می‌گیرد (Probe دوباره اجرا نمی‌شود)
 *   • مهلت سخت کار را لغو و با ۵۰۴ رد می‌کند
 *   • AbortSignal فقط منتظر را جدا می‌کند و کار مشترک را خراب نمی‌کند
 *   • Job گروهی وضعیت قابل پیگیری دارد و در خاموشی پاک می‌شود
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProbeQueue, createProbeBatch, recordProbeBatchResult, getProbeBatch } from '../../probe-queue.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('concurrency never exceeds the configured limit', async () => {
  const queue = new ProbeQueue({ concurrency: 2, maxQueue: 20, defaultTimeoutMs: 5000 });
  let active = 0;
  let maxActive = 0;
  const tasks = Array.from({ length: 8 }, (_, i) =>
    queue.submit(`k${i}`, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(15);
      active -= 1;
      return i;
    })
  );
  const results = await Promise.all(tasks);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(maxActive, 2);
  assert.equal(queue.snapshot().active, 0);
  assert.equal(queue.snapshot().completed, 8);
});

test('queue capacity is enforced with a retryable 503', async () => {
  const queue = new ProbeQueue({ concurrency: 1, maxQueue: 1, defaultTimeoutMs: 5000 });
  const release = { fn: null };
  const first = queue.submit('a', () => new Promise((resolve) => (release.fn = resolve)));
  const second = queue.submit('b', async () => 'b');
  await assert.rejects(queue.submit('c', async () => 'c'), (error) => error.status === 503 && error.code === 'PROBE_QUEUE_FULL');
  release.fn('a');
  assert.equal(await first, 'a');
  assert.equal(await second, 'b');
  assert.equal(queue.snapshot().rejected, 1);
});

test('identical keys dedupe to one execution and one shared result', async () => {
  const queue = new ProbeQueue({ concurrency: 4, maxQueue: 10 });
  let calls = 0;
  const task = async () => {
    calls += 1;
    await sleep(20);
    return 'value';
  };
  const [a, b, c] = await Promise.all([
    queue.submit('device:1:manual', task),
    queue.submit('device:1:manual', task),
    queue.submit('device:1:manual', task),
  ]);
  assert.equal(calls, 1, 'the probe must run once');
  assert.deepEqual([a, b, c], ['value', 'value', 'value']);
  assert.equal(queue.snapshot().deduped, 2);
});

test('hard timeout aborts the task and rejects with 504', async () => {
  const queue = new ProbeQueue({ concurrency: 2, maxQueue: 4 });
  let aborted = false;
  const pending = queue.submit(
    'slow',
    ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve('aborted');
        });
      }),
    { timeoutMs: 1200 }
  );
  await assert.rejects(pending, (error) => error.status === 504 && error.code === 'PROBE_TIMEOUT');
  assert.equal(aborted, true);
  assert.equal(queue.snapshot().timeouts, 1);
  // جایگاه هم‌زمانی آزاد شده و صف می‌تواند کار تازه را شروع کند.
  assert.equal(await queue.submit('next', async () => 'ok'), 'ok');
});

test('an aborted waiter detaches without cancelling shared work', async () => {
  const queue = new ProbeQueue({ concurrency: 2, maxQueue: 4 });
  let release;
  const shared = queue.submit('shared', () => new Promise((resolve) => (release = resolve)));
  const controller = new AbortController();
  const waiter = queue.submit('shared', async () => 'unused', { signal: controller.signal });
  controller.abort();
  await assert.rejects(waiter, (error) => error.code === 'PROBE_CANCELLED');
  release('finished');
  assert.equal(await shared, 'finished', 'the original probe keeps running');
});

test('shutdown rejects queued and running work and drains capacity', async () => {
  const queue = new ProbeQueue({ concurrency: 1, maxQueue: 4 });
  const running = queue.submit('running', () => new Promise(() => {}));
  const queued = queue.submit('queued', async () => 'never');
  await sleep(5);
  queue.shutdown();
  await assert.rejects(running, (error) => error.code === 'PROBE_SHUTDOWN');
  await assert.rejects(queued, (error) => error.code === 'PROBE_SHUTDOWN');
  assert.equal(queue.snapshot().active, 0);
  assert.equal(queue.snapshot().pending, 0);
});

test('bulk probe jobs expose progress and cap retained errors', () => {
  const job = createProbeBatch({ total: 3, skipped: 2, owner: 7 });
  assert.equal(job.status, 'running');
  recordProbeBatchResult(job.id, { deviceId: 1, ok: true });
  let status = getProbeBatch(job.id);
  assert.equal(status.completed, 1);
  assert.equal(status.queued, 1);
  recordProbeBatchResult(job.id, { deviceId: 2, error: 'TIMEOUT' });
  recordProbeBatchResult(job.id, { deviceId: 3, error: 'TIMEOUT' });
  status = getProbeBatch(job.id);
  assert.equal(status.status, 'done-with-errors');
  assert.equal(status.failed, 2);
  assert.equal(status.results.length, 2);
  assert.equal(status.skipped, 2);
  assert.ok(status.finishedAt > 0);
  assert.equal(getProbeBatch('missing'), null);
});
