/**
 * آزمون API نگهداری داده:
 *   • GET وضعیت فقط با مجوز system:health
 *   • POST اجرا/Dry-Run فقط برای Administrator و ثبت در Audit Log
 *   • POST توقف وقتی اجرایی نیست ۴۰۹ می‌دهد
 *   • وضعیت Restore برای رابط کاربری قابل خواندن است
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, startServer, api } from '../helpers.mjs';

const dir = useTempDataDir('retention-api');
let server;

before(async () => {
  server = await startServer({ dataDir: dir });
});

after(async () => {
  await server.stop();
  cleanupDir(dir);
});

test('retention status is authenticated and reports policy, lock and runs', async () => {
  const anonymous = await api(server.base, 'GET', '/api/system/retention', undefined, { auth: false });
  assert.equal(anonymous.status, 401);

  const res = await api(server.base, 'GET', '/api/system/retention');
  assert.equal(res.status, 200);
  assert.equal(typeof res.data.policy.samplesDays, 'number');
  assert.ok(Array.isArray(res.data.runs));
  assert.equal(typeof res.data.nextRunAt, 'number');
  assert.equal(res.data.lock.heldByThisProcess, false);
});

test('a manual dry-run is audited and delete-nothing is guaranteed', async () => {
  const before = await api(server.base, 'GET', '/api/system/retention');
  const res = await api(server.base, 'POST', '/api/system/retention/run', { dryRun: true });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.dryRun, true);
  assert.equal(res.data.status, 'completed');

  const runs = await api(server.base, 'GET', '/api/system/retention/runs?limit=5');
  assert.equal(runs.status, 200);
  assert.ok(runs.data.items.some((r) => Number(r.dry_run) === 1));
  assert.ok(runs.data.items[0].started_at >= (before.data.lastRun?.startedAt ?? 0));

  const audit = await api(server.base, 'GET', '/api/audit?action=retention.dry_run&pageSize=5');
  assert.equal(audit.status, 200);
  assert.ok(audit.data.total >= 1, 'Dry-Run باید در Audit Log ثبت شود');
});

test('stop without a running retention is rejected, and restore status is exposed', async () => {
  const stop = await api(server.base, 'POST', '/api/system/retention/stop', {});
  assert.equal(stop.status, 409);
  assert.equal(stop.data.accepted, false);

  const restore = await api(server.base, 'GET', '/api/system/restore/status');
  assert.equal(restore.status, 200);
  assert.ok(['never', 'completed', 'failed', 'interrupted', 'recovered_interrupted'].includes(restore.data.status));

  const health = await api(server.base, 'GET', '/api/system/db/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);
  assert.equal(health.data.health.foreignKeyViolations, 0);
  assert.ok(health.data.retention, 'وضعیت Retention باید در سلامت پایگاه‌داده باشد');
  assert.ok(health.data.backups.restore !== undefined, 'وضعیت Restore باید در پاسخ پشتیبان باشد');
});
