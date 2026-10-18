/**
 * آزمون مدیریت فشار برگشتی SSE با سوکت ساختگی: فریم‌های قابل‌جایگزینی برای
 * کلاینت کند حذف می‌شوند، هشدارها تلاش می‌شوند و کلاینتی که بافرش از سقف
 * گذشته باشد قطع می‌شود.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSseHub } from '../../sse.js';

/**
 * پاسخ ساختگی: `failsAfter` تعیین می‌کند از چندمین نوشتن به بعد بافر پر شود
 * (write مقدار false برمی‌گرداند) و `buffered` مقدار writableLength است.
 */
function fakeRes({ failsAfter = Infinity, buffered = 0 } = {}) {
  const res = new EventEmitter();
  res.headers = {};
  res.writes = [];
  res.ended = false;
  res.writableLength = buffered;
  res.setHeader = (k, v) => (res.headers[k] = v);
  res.flushHeaders = () => {};
  res.end = () => (res.ended = true);
  res.write = (chunk) => {
    res.writes.push(chunk);
    return res.writes.length < failsAfter;
  };
  return res;
}

function fakeReq() {
  const req = new EventEmitter();
  req.on = req.on.bind(req);
  return req;
}

test('frames are formatted as SSE events and delivered to every client', () => {
  const hub = createSseHub();
  const a = fakeRes();
  const b = fakeRes();
  hub.add(fakeReq(), a, { ts: 1 });
  hub.add(fakeReq(), b);
  assert.equal(hub.size, 2);
  assert.match(a.headers['Content-Type'], /text\/event-stream/);

  const sent = hub.broadcast('samples', [{ deviceId: 1 }]);
  assert.equal(sent, 2);
  assert.match(a.writes.at(-1), /^event: samples\ndata: \[\{"deviceId":1\}\]\n\n$/);
  hub.closeAll();
});

test('replaceable frames are skipped while a client is backpressured', () => {
  const hub = createSseHub();
  const res = fakeRes({ failsAfter: 2 }); // hello → true، اولین samples → false
  hub.add(fakeReq(), res, { ts: 1 });
  assert.equal(hub.broadcast('samples', [1]), 1);
  const afterFirst = res.writes.length;

  // کلاینت هنوز بافرش تخلیه نشده: فریم نمونهٔ بعدی نباید نوشته شود
  assert.equal(hub.broadcast('samples', [2]), 0);
  assert.equal(res.writes.length, afterFirst, 'no write while backpressured');
  assert.equal(hub.stats().skippedFrames, 1);

  // وضعیت هم قابل‌جایگزینی است و نباید انباشته شود
  assert.equal(hub.broadcast('status', { deviceId: 1, status: 'offline' }), 0);
  assert.equal(hub.stats().skippedFrames, 2);
  hub.closeAll();
});

test('drain clears backpressure and delivery resumes', () => {
  const hub = createSseHub();
  const res = fakeRes({ failsAfter: 2 });
  hub.add(fakeReq(), res, { ts: 1 });
  hub.broadcast('samples', [1]);
  assert.equal(hub.broadcast('samples', [2]), 0);

  res.emit('drain');
  assert.equal(hub.broadcast('samples', [3]), 1, 'after drain the client receives frames again');
  hub.closeAll();
});

test('critical alerts are still attempted under backpressure', () => {
  const hub = createSseHub();
  const res = fakeRes({ failsAfter: 2 });
  hub.add(fakeReq(), res, { ts: 1 });
  hub.broadcast('samples', [1]); // بافر پر شد
  const before = res.writes.length;
  assert.equal(hub.broadcast('alert', { id: 7 }, { critical: true }), 1);
  assert.equal(res.writes.length, before + 1);
  assert.match(res.writes.at(-1), /event: alert/);
  hub.closeAll();
});

test('a client whose buffer exceeds the limit is disconnected', () => {
  const hub = createSseHub({ maxBufferedBytes: 1000 });
  const slow = fakeRes({ failsAfter: 2, buffered: 5000 });
  const healthy = fakeRes();
  hub.add(fakeReq(), slow, { ts: 1 });
  hub.add(fakeReq(), healthy);

  hub.broadcast('samples', [1]);
  assert.equal(hub.size, 1, 'slow client must be dropped');
  assert.equal(slow.ended, true);
  assert.equal(hub.stats().droppedClients, 1);

  // کلاینت سالم دست‌نخورده می‌ماند و رویداد بعدی را می‌گیرد
  assert.equal(hub.broadcast('samples', [2]), 1);
  hub.closeAll();
});

test('capacity is enforced and closeAll releases every connection', () => {
  const hub = createSseHub({ maxClients: 2 });
  const a = fakeRes();
  const b = fakeRes();
  const c = fakeRes();
  assert.ok(hub.add(fakeReq(), a));
  assert.ok(hub.add(fakeReq(), b));
  assert.equal(hub.add(fakeReq(), c), null, 'over-capacity connections are refused');
  assert.equal(hub.size, 2);
  assert.equal(hub.stats().peak, 2);

  hub.closeAll();
  assert.equal(hub.size, 0);
  assert.equal(a.ended && b.ended, true);
  assert.equal(hub.broadcast('samples', [1]), 0);
});

test('closing the request removes the client without marking it dropped', () => {
  const hub = createSseHub();
  const req = fakeReq();
  const res = fakeRes();
  hub.add(req, res);
  assert.equal(hub.size, 1);
  req.emit('close');
  assert.equal(hub.size, 0);
  assert.equal(hub.stats().droppedClients, 0, 'a normal browser disconnect is not a drop');
  assert.equal(res.ended, true);
});
