/**
 * آزمون آزادسازی Workerها در خاموشی: پس از shutdownJobs هیچ کار جدیدی پذیرفته
 * نمی‌شود و صف با خطای مشخص رد می‌شود (بدون Promise معلق).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runJob, shutdownJobs, jobStats } from '../../jobs.js';

test('shutdownJobs rejects new work and reports worker state', async () => {
  const before = jobStats();
  assert.equal(before.shuttingDown, false);
  assert.equal(before.activeWorkers, 0);

  const result = shutdownJobs('test');
  assert.equal(result.cancelled, 0);
  assert.equal(result.terminated, 0);

  await assert.rejects(
    () => runJob('parse', { buffer: Buffer.from('x') }),
    (e) => e.code === 'JOB_SHUTDOWN' && e.status === 503
  );
  assert.equal(jobStats().shuttingDown, true);
  assert.equal(jobStats().queued, 0);
  assert.equal(jobStats().activeWorkers, 0);
});
