/**
 * آزمون یکپارچهٔ فشار برگشتی SSE: کلاینتی که جریان را نمی‌خواند (تب خواب‌رفته)
 * نباید بافر سرور را بی‌مرز کند. با کوچک‌کردن سقف بافر، سرور باید همان اتصال را
 * ببندد و /health هم آمار آن را نشان دهد.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { useTempDataDir, cleanupDir, startServer, sessionFor, waitFor } from '../helpers.mjs';

const dir = useTempDataDir('sse-bp');
let srv;
let raw;

test('a stalled SSE client is disconnected instead of buffering forever', async () => {
  srv = await startServer({
    dataDir: dir,
    engine: true,
    env: {
      NETWATCH_SSE_MAX_BUFFER: '1',
      NETWATCH_MAX_WORKERS: '512',
      NETWATCH_ENGINE_MODE: 'simulate',
      NETWATCH_PING_INTERVAL: '5',
    },
  });

  try {
    // ساخت انبوه تجهیزات سررسیدشده تا موتور، جریان نمونه‌ها را پرمتواتر کند
    const db = new DatabaseSync(path.join(dir, 'netwatch.db'));
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      const stmt = db.prepare(
        'INSERT INTO devices(name, ip, status, enabled, monitoring_enabled, ping_interval, next_check_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
      );
      const now = Date.now();
      for (let i = 0; i < 3000; i++) {
        stmt.run(`bp-${i}`, `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, 'online', 1, 1, 5, 0, now, now);
      }
    } finally {
      db.close();
    }

    const cookie = sessionFor(srv.base).cookie;
    const port = new URL(srv.base).port;
    raw = net.connect(Number(port), '127.0.0.1');
    await new Promise((resolve, reject) => {
      raw.once('connect', resolve);
      raw.once('error', reject);
    });
    raw.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${cookie}\r\nAccept: text/event-stream\r\n\r\n`);
    // از این لحظه جریان خوانده نمی‌شود: دقیقاً همان کلاینت کند
    raw.pause();

    const dropped = await waitFor(
      async () => {
        const res = await fetch(`${srv.base}/api/health`);
        const body = await res.json();
        return body.sse?.droppedClients >= 1 ? body.sse : null;
      },
      { timeout: 30000, interval: 500 }
    );
    assert.ok(dropped, 'server must drop the stalled client');
    assert.equal(dropped.clients, 0, 'no client may remain attached');
    assert.ok(
      dropped.skippedFrames >= 0 && dropped.deliveredFrames >= 1,
      `unexpected counters: ${JSON.stringify(dropped)}`
    );
  } finally {
    raw?.destroy();
    await srv.stop();
    cleanupDir(dir);
  }
});

test.after(async () => {
  if (srv && srv.child.exitCode === null) await srv.stop();
});
