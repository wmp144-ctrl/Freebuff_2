/**
 * هم‌زمانی عملیات پایگاه‌داده از مسیر HTTP واقعی.
 *
 * SQLite در حالت WAL نوشتن‌ها را سریالی می‌کند؛ انتظار این است که درخواست‌های
 * هم‌زمان یا موفق شوند یا خطای منطقی روشن (۴۰۰) بگیرند — هرگز ۵۰۰، قفل ماندگار
 * یا رکورد نیمه‌کاره. یکتایی IP باید حتی در مسابقهٔ هم‌زمان هم برقرار بماند.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, startServer, api } from '../helpers.mjs';

const dir = useTempDataDir('concurrency');
let srv;

before(async () => {
  srv = await startServer({ dataDir: dir, engine: false });
});

after(async () => {
  await srv.stop();
  cleanupDir(dir);
});

test('50 concurrent creates all commit and are readable immediately', async () => {
  const created = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      api(srv.base, 'POST', '/api/devices', { name: `concurrent-${i}`, ip: `10.210.0.${i + 1}` })
    )
  );
  assert.deepEqual(created.filter((r) => r.status === 201).length, 50);
  const ids = created.map((r) => r.data.id);
  assert.equal(new Set(ids).size, 50, 'each insert must have a distinct id');

  const list = await api(srv.base, 'GET', '/api/devices?pageSize=200&search=concurrent-');
  assert.equal(list.status, 200);
  assert.ok(list.data.items.length >= 50);
});

test('a duplicate-IP race produces exactly one winner and no 500', async () => {
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      api(srv.base, 'POST', '/api/devices', { name: `dup-${i}`, ip: '10.211.0.1' })
    )
  );
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 201).length, 1, `statuses: ${statuses}`);
  assert.equal(statuses.filter((s) => s === 400).length, 11);
  assert.equal(statuses.filter((s) => s >= 500).length, 0);
});

test('concurrent updates never lose the row and never return 500', async () => {
  const created = await api(srv.base, 'POST', '/api/devices', { name: 'update-race', ip: '10.212.0.1' });
  assert.equal(created.status, 201);
  const id = created.data.id;
  const updates = await Promise.all(
    Array.from({ length: 20 }, (_, i) => api(srv.base, 'PATCH', `/api/devices/${id}`, { notes: `note-${i}` }))
  );
  assert.equal(updates.filter((r) => r.status === 200).length, 20);
  const read = await api(srv.base, 'GET', `/api/devices/${id}`);
  assert.equal(read.status, 200);
  assert.match(read.data.notes, /^note-\d+$/, 'final note must be one of the concurrent writes');
});

test('concurrent bulk deletes are idempotent and never double-delete', async () => {
  const created = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      api(srv.base, 'POST', '/api/devices', { name: `delete-race-${i}`, ip: `10.213.0.${i + 1}` })
    )
  );
  const ids = created.map((r) => r.data.id);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => api(srv.base, 'POST', '/api/devices/bulk', { ids, action: 'delete' }))
  );
  assert.equal(results.filter((r) => r.status === 200).length, 8);
  const total = results.reduce((n, r) => n + (r.data.affected || 0), 0);
  assert.equal(total, 5, 'exactly five rows must be deleted in total');
  for (const id of ids) {
    assert.equal((await api(srv.base, 'GET', `/api/devices/${id}`)).status, 404);
  }
});

test('reads keep working while writes are in flight', async () => {
  const ops = [];
  for (let i = 0; i < 25; i++) {
    ops.push(api(srv.base, 'POST', '/api/devices', { name: `mix-${i}`, ip: `10.214.0.${i + 1}` }));
    ops.push(api(srv.base, 'GET', '/api/devices?pageSize=10'));
    ops.push(api(srv.base, 'GET', '/api/status'));
  }
  const results = await Promise.all(ops);
  assert.equal(results.filter((r) => r.status >= 500).length, 0);
  assert.equal(results.filter((r) => r.status === 200 || r.status === 201).length, results.length);
  assert.equal(srv.child.exitCode, null);
});

test('a backup remains consistent while concurrent writes continue', async () => {
  const writes = Array.from({ length: 20 }, (_, i) =>
    api(srv.base, 'POST', '/api/devices', { name: `backup-race-${i}`, ip: `10.215.0.${i + 1}` })
  );
  const backup = api(srv.base, 'POST', '/api/system/backups', { includeMbtiles: false, keep: 5 });
  const [backupRes, ...writeRes] = await Promise.all([backup, ...writes]);
  assert.equal(backupRes.status, 201, JSON.stringify(backupRes.data));
  assert.equal(writeRes.filter((r) => r.status === 201).length, 20);

  const verify = await api(srv.base, 'POST', '/api/system/backups/verify', { name: backupRes.data.name });
  assert.equal(verify.status, 200);
  assert.equal(verify.data.ok, true);
});

test('concurrent settings writes leave a valid, bounded configuration', async () => {
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      api(srv.base, 'PUT', '/api/settings', { ping_interval: 60 + i * 5, max_workers: 32 + i })
    )
  );
  assert.equal(results.filter((r) => r.status === 200).length, 10);
  const settings = await api(srv.base, 'GET', '/api/settings');
  assert.ok(settings.data.settings.ping_interval >= 60);
  assert.ok(settings.data.settings.max_workers >= 32);
});
