/**
 * بار ۱۰۰ اتصال SSE هم‌زمان.
 *
 * هر اتصال باید event hello را دریافت کند، تعداد کلاینت‌ها در health درست باشد،
 * بستن همه اتصال‌ها باعث نشتی/گیرکردن سرور نشود و رشد حافظه در حد متعارف بماند.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { useTempDataDir, cleanupDir, startServer, api, sessionFor, waitFor } from '../helpers.mjs';

const dir = useTempDataDir('sse-load');
const CONNECTIONS = 100;
let srv;
const controllers = [];

function rssMb(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
    return match ? Math.round((Number(match[1]) / 1024) * 10) / 10 : null;
  } catch {
    return null;
  }
}

async function readHello(response, timeoutMs = 15000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    // خواننده عمداً باز می‌ماند تا اتصال SSE زنده بماند؛ بستن آن یعنی قطع کلاینت.
    if (text.includes('event: hello')) return text;
  }
  reader.cancel().catch(() => {});
  throw new Error(`hello not received within ${timeoutMs}ms: ${text.slice(0, 200)}`);
}

test('100 simultaneous SSE clients all receive hello, then disconnect cleanly', { timeout: 60000 }, async () => {
  srv = await startServer({
    dataDir: dir,
    engine: false,
    env: { NETWATCH_SSE_MAX: String(CONNECTIONS + 8), NETWATCH_SSE_HEARTBEAT_MS: '60000' },
  });
  const cookie = sessionFor(srv.base).cookie;
  const before = rssMb(srv.child.pid);
  assert.ok(before, 'server RSS must be readable on Linux');

  const responses = await Promise.all(
    Array.from({ length: CONNECTIONS }, async () => {
      const controller = new AbortController();
      controllers.push(controller);
      const res = await fetch(`${srv.base}/api/events`, {
        headers: { cookie, accept: 'text/event-stream' },
        signal: controller.signal,
      });
      assert.equal(res.status, 200);
      return res;
    })
  );
  await Promise.all(responses.map((res) => readHello(res)));

  const health = await api(srv.base, 'GET', '/api/system/health');
  assert.equal(health.status, 200);
  assert.ok(health.data.sse.clients >= CONNECTIONS, `expected ${CONNECTIONS} clients, got ${health.data.sse.clients}`);
  assert.ok(health.data.sse.peak >= CONNECTIONS);

  const during = rssMb(srv.child.pid);
  assert.ok(during - before < 150, `100 SSE clients grew RSS by ${during - before} MB`);

  for (const c of controllers) c.abort();
  const drained = await waitFor(async () => {
    const h = await api(srv.base, 'GET', '/api/system/health');
    return h.data.sse.clients === 0;
  }, { timeout: 15000, interval: 100 });
  assert.ok(drained, 'all SSE clients must be removed after disconnect');

  const after = rssMb(srv.child.pid);
  assert.ok(after - before < 100, `RSS after disconnect is ${after} MB (started ${before} MB)`);
  const alive = await api(srv.base, 'GET', '/api/health', undefined, { auth: false });
  assert.equal(alive.status, 200);
});

test.after(async () => {
  for (const c of controllers) {
    try {
      c.abort();
    } catch {
      /* بی‌اثر */
    }
  }
  if (srv) await srv.stop();
  cleanupDir(dir);
});
