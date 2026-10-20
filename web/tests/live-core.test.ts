import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldApplySample, type LiveSample } from '../src/lib/live-core.ts';

function sample(deviceId: number, ts: number, status = 'online'): LiveSample {
  return { deviceId, ts, status, rtt: 12, lossPct: 0, ok: true, mode: 'test' };
}

test('a stale SSE sample cannot overwrite a newer sample of the same device', () => {
  const current = sample(7, 2_000, 'online');
  assert.equal(shouldApplySample(current, sample(7, 1_500, 'offline')), false, 'older event must be ignored');
  assert.equal(shouldApplySample(current, sample(7, 2_000, 'offline')), false, 'duplicate event must be ignored');
  assert.equal(shouldApplySample(current, sample(7, 2_001, 'offline')), true, 'newer event must apply');
  assert.equal(shouldApplySample(undefined, sample(7, 1)), true, 'first sample always applies');
  assert.equal(shouldApplySample(current, { ...sample(7, 3_000), ts: Number.NaN }), false, 'invalid timestamp is rejected');
});
