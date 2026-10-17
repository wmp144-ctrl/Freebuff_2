/**
 * لاگ ساختاریافته: هر رخداد باید یک خط JSON معتبر با سطح، نام رویداد و زمان باشد.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { logEvent } from '../../logger.mjs';

function capture(stream, fn) {
  const chunks = [];
  const original = stream.write;
  stream.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    stream.write = original;
  }
  return chunks.join('');
}

test('info events are single-line JSON on stdout', () => {
  const out = capture(process.stdout, () => logEvent('info', 'unit_event', { deviceId: 7, ok: true }));
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.event, 'unit_event');
  assert.equal(parsed.deviceId, 7);
  assert.ok(!Number.isNaN(Date.parse(parsed.ts)), 'ts must be an ISO timestamp');
});

test('warn and error events go to stderr', () => {
  const err = capture(process.stderr, () => {
    logEvent('warn', 'unit_warn');
    logEvent('error', 'unit_error', { detail: 'x' });
  });
  const parsed = err.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(parsed.map((p) => p.level), ['warn', 'error']);
});

test('unknown levels fall back to info instead of throwing', () => {
  const out = capture(process.stdout, () => logEvent('nope', 'fallback'));
  assert.equal(JSON.parse(out.trim()).level, 'info');
});
