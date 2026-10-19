import test from 'node:test';
import assert from 'node:assert/strict';
import { LatestRequestGate, isAbortError } from '../src/lib/async-gate.ts';
import { LiveSampleBuffer, nextReconnectDelay, type LiveSample } from '../src/lib/live-core.ts';

test('a newer request invalidates and aborts the previous one', () => {
  const gate = new LatestRequestGate();
  const first = gate.begin();
  assert.equal(first.isCurrent(), true);

  const second = gate.begin();
  assert.equal(first.signal.aborted, true, 'previous fetch must be aborted');
  assert.equal(first.isCurrent(), false, 'late response of the old request must be ignored');
  assert.equal(second.isCurrent(), true);
  assert.equal(second.signal.aborted, false);
});

test('abort() invalidates the in-flight request without starting a new one', () => {
  const gate = new LatestRequestGate();
  const ticket = gate.begin();
  gate.abort();
  assert.equal(ticket.signal.aborted, true);
  assert.equal(ticket.isCurrent(), false);
  // even after abort, a fresh request can begin
  const next = gate.begin();
  assert.equal(next.isCurrent(), true);
});

test('abort errors are recognized across browser and API shapes', () => {
  const dom = new Error('aborted');
  dom.name = 'AbortError';
  assert.equal(isAbortError(dom), true);
  assert.equal(isAbortError({ name: 'AbortError' }), true);
  assert.equal(isAbortError({ aborted: true }), true);
  assert.equal(isAbortError(new Error('boom')), false);
  assert.equal(isAbortError(null), false);
});

const sample = (deviceId: number, rtt = 10): LiveSample => ({
  deviceId,
  ts: Date.now(),
  status: 'online',
  rtt,
  lossPct: 0,
  ok: true,
  mode: 'icmp',
});

test('live buffer keeps only the newest sample per device', () => {
  const buffer = new LiveSampleBuffer();
  buffer.push([sample(1, 10), sample(2, 20), sample(1, 99)]);
  assert.equal(buffer.size, 2, 'duplicate device ids collapse into one entry');
  const drained = buffer.drain();
  assert.equal(drained.length, 2);
  assert.equal(drained.find((s) => s.deviceId === 1)?.rtt, 99);
  assert.equal(buffer.size, 0, 'drain empties the buffer');
  assert.deepEqual(buffer.drain(), []);
});

test('live buffer has a hard memory cap and drops the oldest devices', () => {
  const buffer = new LiveSampleBuffer(3);
  buffer.push([1, 2, 3].map((id) => sample(id)));
  assert.equal(buffer.size, 3);
  buffer.push([sample(4)]);
  assert.equal(buffer.size, 3, 'size never exceeds the cap');
  const ids = buffer.drain().map((s) => s.deviceId).sort();
  assert.deepEqual(ids, [2, 3, 4], 'oldest device is evicted first');
});

test('a burst larger than the cap still leaves bounded memory', () => {
  const buffer = new LiveSampleBuffer(50);
  buffer.push(Array.from({ length: 5000 }, (_, i) => sample(i + 1)));
  assert.equal(buffer.size, 50);
});

test('reconnect backoff grows exponentially, is capped, and includes jitter', () => {
  const noJitter = { jitter: 0, random: () => 0.5 };
  assert.equal(nextReconnectDelay(0, noJitter), 1000);
  assert.equal(nextReconnectDelay(1, noJitter), 2000);
  assert.equal(nextReconnectDelay(3, noJitter), 8000);
  assert.equal(nextReconnectDelay(10, noJitter), 30000, 'delay is capped');
  assert.equal(nextReconnectDelay(999, noJitter), 30000);

  const low = nextReconnectDelay(2, { jitter: 0.25, random: () => 0 });
  const high = nextReconnectDelay(2, { jitter: 0.25, random: () => 0.999 });
  assert.ok(low < 4000 && low >= 3000, `low jitter bound: ${low}`);
  assert.ok(high > 4000 && high <= 5000, `high jitter bound: ${high}`);
});
