/**
 * آزمون صف کارهای سنگین: پارس/خروجی در Worker Thread اجرا می‌شود، خطا به
 * فراخوان برمی‌گردد و کار طولانی با مهلت متوقف می‌شود (حافظه آزاد می‌ماند).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runJob, jobStats, JobError } from '../../jobs.js';

test('CSV parsing runs in the worker and returns rows', async () => {
  const csv = 'name,ip\nsw-1,10.0.0.1\nsw-2,10.0.0.2\n';
  const result = await runJob('parse', { buffer: Buffer.from(csv), filename: 'd.csv' });
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].name, 'sw-1');
  assert.equal(result.rows[1].ip, '10.0.0.2');
});

test('device preview validates duplicates and invalid rows in the worker', async () => {
  const csv = 'name,ip\nok,10.1.0.1\nbad,not-an-ip\ndup,10.1.0.1\n';
  const result = await runJob('devicesPreview', {
    buffer: Buffer.from(csv),
    filename: 'd.csv',
    existing: [{ id: 99, name: 'existing', ip: '10.9.9.9' }],
  });
  assert.equal(result.totalRows, 3);
  assert.equal(result.valid.length, 1);
  assert.equal(result.valid[0].name, 'ok');
  assert.equal(result.errors.length, 2);
});

test('export is generated in the worker and preserves Persian headers', async () => {
  const result = await runJob('export', {
    rows: [{ name: 'سوئیچ', ip: '10.0.0.5' }],
    headers: [
      ['name', 'نام تجهیز'],
      ['ip', 'آدرس IP'],
    ],
    format: 'csv',
  });
  const text = Buffer.from(result.buffer).toString('utf8');
  assert.match(text, /نام تجهیز/);
  assert.match(text, /10\.0\.0\.5/);
  assert.ok(result.bytes > 0);
});

test('a long job is terminated when it exceeds its timeout', async () => {
  const rows = Array.from({ length: 20000 }, (_, i) => ({ name: `n-${i}`, ip: `10.0.${Math.floor(i / 250)}.${(i % 250) + 1}` }));
  const started = Date.now();
  await assert.rejects(
    () =>
      runJob(
        'export',
        {
          rows,
          headers: [
            ['name', 'name'],
            ['ip', 'ip'],
          ],
          format: 'xlsx',
        },
        { timeoutMs: 5 }
      ),
    (e) => {
      assert.ok(e instanceof JobError);
      assert.equal(e.code, 'JOB_TIMEOUT');
      assert.equal(e.status, 504);
      return true;
    }
  );
  assert.ok(Date.now() - started < 5000, 'timeout must be enforced promptly');
  assert.ok(jobStats().timeouts >= 1);
});

test('job stats expose bounded queue/concurrency configuration', () => {
  const stats = jobStats();
  assert.ok(stats.maxConcurrency >= 1 && stats.maxConcurrency <= 8);
  assert.ok(stats.maxQueueSize >= 1);
  assert.ok(stats.completed >= 3, 'earlier jobs are counted');
  assert.ok(stats.timeouts >= 1);
});
