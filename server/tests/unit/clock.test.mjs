/**
 * آزمون سیاست زمان واحد: تغییر ساعت سرور نباید ترتیب/معنای داده را خراب کند.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir } from '../helpers.mjs';

const dir = useTempDataDir('clock');
const { db } = await import('../../db.js');
const { monotonicNow, observeClock } = await import('../../clock.js');

test('monotonicNow never goes backwards even when the wall clock does', () => {
  const realNow = Date.now;
  try {
    Date.now = () => 1_000_000;
    const first = monotonicNow();
    Date.now = () => 500_000; // ساعت سرور عقب می‌رود
    const second = monotonicNow();
    assert.equal(second, first, 'timestamp صادرشده نباید کوچک‌تر شود');
    Date.now = () => 1_500_000;
    assert.equal(monotonicNow(), 1_500_000, 'پس از جلو رفتن ساعت، مقدار جدید پذیرفته می‌شود');
  } finally {
    Date.now = realNow;
  }
});

test('observeClock persists the last seen time and flags large jumps', () => {
  const first = observeClock(2_000_000_000_000);
  assert.equal(first.direction, null);
  const forward = observeClock(2_000_000_000_000 + 48 * 3600 * 1000);
  assert.equal(forward.direction, 'forward');
  const backward = observeClock(2_000_000_000_000);
  assert.equal(backward.direction, 'backward');
  const stored = db.prepare("SELECT value FROM runtime_state WHERE key = 'clock.last_seen'").get();
  assert.equal(Number(stored.value), 2_000_000_000_000);
});

after(() => {
  db.close();
  cleanupDir(dir);
});
