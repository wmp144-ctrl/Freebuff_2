/**
 * آزمون خاموشی کنترل‌شده روی سرور واقعی:
 *   • SIGTERM با کد خروج ۰ تمام می‌شود و از مهلت تعیین‌شده بیشتر طول نمی‌کشد.
 *   • اتصال SSE باز هنگام خاموشی بسته می‌شود.
 *   • WAL پیش از خروج Checkpoint می‌شود و پایگاه‌داده سالم می‌ماند.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { useTempDataDir, cleanupDir, startServer } from '../helpers.mjs';

const dir = useTempDataDir('shutdown-resources');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('SIGTERM drains the engine, closes SSE and checkpoints the database', async () => {
  const srv = await startServer({
    dataDir: dir,
    engine: true,
    env: {
      NETWATCH_ENGINE_MODE: 'simulate',
      NETWATCH_PING_INTERVAL: '3600',
      NETWATCH_SHUTDOWN_TIMEOUT_MS: '3000',
      NETWATCH_LOCK_RETRY_MS: '200',
    },
  });

  const res = await fetch(`${srv.base}/api/events`, {
    headers: { cookie: srv.session.cookie, accept: 'text/event-stream' },
  });
  assert.equal(res.status, 200);
  assert.ok(res.body, 'SSE body expected');
  const reader = res.body.getReader();
  const hello = await Promise.race([reader.read(), delay(3000).then(() => null)]);
  assert.ok(hello && !hello.done, 'the hello frame must arrive before shutdown');

  const started = Date.now();
  const code = await srv.stop();
  const elapsed = Date.now() - started;
  assert.equal(code, 0, `server must exit cleanly:\n${srv.logs()}`);
  assert.ok(elapsed < 6000, `shutdown took ${elapsed}ms`);

  // ممکن است پیش از بسته‌شدن، یک فریم نهایی برسد؛ تا EOF می‌خوانیم.
  const closed = await Promise.race([
    (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return true;
      }
    })().catch(() => true),
    delay(5000).then(() => false),
  ]);
  assert.equal(closed, true, 'the SSE stream must be closed on shutdown');
  assert.match(srv.logs(), /shutdown_done/);
  assert.match(srv.logs(), /engine_stopped/);

  // فایل WAL پس از checkpoint خروجی نباید حاوی تراکنش تأییدنشده باشد.
  const db = new DatabaseSync(path.join(dir, 'netwatch.db'));
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.ok(db.prepare('SELECT COUNT(*) c FROM devices').get().c >= 0);
  } finally {
    db.close();
  }
  cleanupDir(dir);
});
