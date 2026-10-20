import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeParam } from '../src/lib/params.ts';

/**
 * آزمون منطق آدرس صفحه‌ها: هر تغییر فیلتر باید بقیهٔ پارامترها را نگه دارد،
 * شمارهٔ صفحه را صفر کند و ورودی خالی پارامتر را حذف کند.
 */

test('setting a param keeps the other params untouched', () => {
  const base = new URLSearchParams('search=sw1&status=online&group=core');
  const next = mergeParam(base, 'priority', 'high');
  assert.equal(next.get('search'), 'sw1');
  assert.equal(next.get('status'), 'online');
  assert.equal(next.get('group'), 'core');
  assert.equal(next.get('priority'), 'high');
});

test('an empty value removes the param instead of storing an empty string', () => {
  const next = mergeParam(new URLSearchParams('search=sw1&status=online'), 'search', '');
  assert.equal(next.has('search'), false);
  assert.equal(next.get('status'), 'online');
  assert.equal(next.toString(), 'status=online');
});

test('filter changes reset pagination but an explicit page change does not', () => {
  const base = new URLSearchParams('page=4&status=online');
  assert.equal(mergeParam(base, 'status', 'offline').has('page'), false);
  assert.equal(mergeParam(base, 'page', '2').get('page'), '2');
});

test('merging does not mutate the base params (no accidental lost updates)', () => {
  const base = new URLSearchParams('search=sw1');
  mergeParam(base, 'search', '');
  mergeParam(base, 'status', 'online');
  assert.equal(base.toString(), 'search=sw1');
});

test('two consecutive updates from the same base keep both changes', () => {
  // سناریوی واقعی: پاک‌کردن جست‌وجو و کلیک فوری فیلتر در یک تیک
  const base = new URLSearchParams('search=NO-SUCH&status=online');
  const afterClear = mergeParam(base, 'search', '');
  const afterFilter = mergeParam(afterClear, 'status', '');
  assert.equal(afterFilter.toString(), '');
});
