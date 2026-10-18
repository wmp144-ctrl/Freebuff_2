/**
 * پایداری عملیاتی: نقطهٔ پایانی سلامت، پیکربندی از طریق متغیر محیطی و سقف نرخ.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, startServer, api } from '../helpers.mjs';

const dirs = [];
function tempDir(tag) {
  const d = useTempDataDir(tag);
  dirs.push(d);
  return d;
}

after(() => {
  for (const d of dirs) cleanupDir(d);
});

test('public /health is minimal while authorized /api/system/health reports readiness without leaking the DB path', async () => {
  const srv = await startServer({ dataDir: tempDir('health'), engine: false });
  try {
    const res = await api(srv.base, 'GET', '/health', undefined, { auth: false });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.data.db, undefined, 'public health must not expose DB details');
    assert.equal(res.data.engine, undefined, 'public health must not expose engine details');

    const detail = await api(srv.base, 'GET', '/api/system/health');
    assert.equal(detail.status, 200);
    assert.equal(detail.data.ok, true);
    assert.equal(detail.data.db.ok, true);
    assert.ok(['ok', 'degraded', 'fail'].includes(detail.data.status));
    assert.ok(detail.data.engine && typeof detail.data.engine.running === 'boolean');
    assert.equal(JSON.stringify(detail.data).includes('netwatch.db'), false, 'health must not expose the DB path');
  } finally {
    await srv.stop();
  }
});

test('monitoring knobs can be configured through environment variables', async () => {
  const srv = await startServer({
    dataDir: tempDir('env'),
    engine: false,
    env: { NETWATCH_PING_INTERVAL: '17', NETWATCH_MAX_WORKERS: '8', NETWATCH_TIMEOUT_MS: '2500' },
  });
  try {
    const settings = await api(srv.base, 'GET', '/api/settings');
    assert.equal(settings.data.settings.ping_interval, 17);
    assert.equal(settings.data.settings.max_workers, 8);
    assert.equal(settings.data.settings.timeout_ms, 2500);
  } finally {
    await srv.stop();
  }
});

test('invalid environment values are ignored instead of breaking startup', async () => {
  const srv = await startServer({
    dataDir: tempDir('env-bad'),
    engine: false,
    env: { NETWATCH_PING_INTERVAL: '-4', NETWATCH_MAX_WORKERS: 'lots' },
  });
  try {
    const settings = await api(srv.base, 'GET', '/api/settings');
    assert.equal(settings.data.settings.ping_interval, 30);
    assert.equal(settings.data.settings.max_workers, 128);
  } finally {
    await srv.stop();
  }
});

test('expensive endpoints are rate limited with a Retry-After header', async () => {
  const srv = await startServer({
    dataDir: tempDir('rate'),
    engine: false,
    env: { NETWATCH_EXPENSIVE_RATE_LIMIT_MAX: '2', NETWATCH_RATE_LIMIT_MAX: '1000' },
  });
  try {
    const created = await api(srv.base, 'POST', '/api/devices', { name: 'rate-test', ip: '10.70.0.1', monitoring_enabled: 0 });
    assert.equal(created.status, 201);
    const id = created.data.id;

    for (let i = 0; i < 2; i++) {
      const ok = await api(srv.base, 'GET', `/api/devices/${id}/probe?mode=simulate`);
      assert.equal(ok.status, 200, `probe ${i + 1} should pass`);
    }
    const limited = await api(srv.base, 'GET', `/api/devices/${id}/probe?mode=simulate`);
    assert.equal(limited.status, 429);
    assert.ok(limited.data.error);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);

    // سایر مسیرها در همان پنجره محدود نمی‌شوند (سقف عمومی بالاست)
    assert.equal((await api(srv.base, 'GET', '/api/devices')).status, 200);
  } finally {
    await srv.stop();
  }
});

test('general API rate limit stops abusive clients', async () => {
  const srv = await startServer({
    dataDir: tempDir('rate-general'),
    engine: false,
    env: { NETWATCH_RATE_LIMIT_MAX: '3', NETWATCH_EXPENSIVE_RATE_LIMIT_MAX: '100' },
  });
  try {
    const statuses = [];
    for (let i = 0; i < 8; i++) statuses.push((await api(srv.base, 'GET', '/api/devices')).status);
    assert.ok(statuses.includes(429), `expected a 429 within 8 requests, got ${statuses.join(',')}`);
    assert.equal(statuses[0], 200);
  } finally {
    await srv.stop();
  }
});
