/**
 * آزمون بازیابی اتصال زنده: پس از قطع اتصال، سرور باید اتصال تازه را بپذیرد و
 * دوباره رویداد hello بفرستد. تأخیر اتصال مجدد از همان تابع Backoff کلاینت
 * محاسبه می‌شود تا مسیر واقعی «قطع → انتظار → اتصال مجدد → hello» آزموده شود.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, startServer, sessionFor } from '../helpers.mjs';
import { nextReconnectDelay } from '../../../web/src/lib/live-core.ts';

const dir = useTempDataDir('sse-reconnect');
let srv;

async function readHello(response, timeoutMs = 4000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes('event: hello')) return text;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  throw new Error(`hello event not received: ${text.slice(0, 200)}`);
}

async function connect(base, cookie) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, {
    headers: { cookie, accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(res.status, 200, 'SSE endpoint must accept an authenticated client');
  return { res, controller };
}

test('SSE reconnects after a dropped connection and receives hello again', async () => {
  srv = await startServer({ dataDir: dir, engine: false });
  const cookie = sessionFor(srv.base).cookie;
  try {
    const first = await connect(srv.base, cookie);
    await readHello(first.res);
    first.controller.abort();

    // همان محاسبهٔ کلاینت: تلاش اول، بدون جیتر برای قطعیت آزمون
    const delay = nextReconnectDelay(0, { jitter: 0, maxMs: 1000 });
    assert.ok(delay >= 500 && delay <= 1000, `unexpected reconnect delay: ${delay}`);
    await new Promise((r) => setTimeout(r, delay));

    const second = await connect(srv.base, cookie);
    const text = await readHello(second.res);
    assert.match(text, /event: hello/);
    assert.match(text, /"engine"/, 'hello carries the current engine snapshot');
    second.controller.abort();
  } finally {
    await srv.stop();
    cleanupDir(dir);
  }
});

test.after(async () => {
  if (srv && srv.child.exitCode === null) await srv.stop();
});
