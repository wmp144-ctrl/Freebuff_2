/**
 * آزمون پشتهٔ Undo/Redo توپولوژی
 * ----------------------------------------------------------------
 * تمرکز روی رفتارهایی که از دست‌رفتن داده را تعیین می‌کنند:
 *   • ترتیب دقیق واگرد/ازنو و برچسب‌ها
 *   • پاک‌شدن پشتهٔ Redo با ویرایش تازه
 *   • باقی‌ماندن فرمان پس از خطا (تا کاربر بتواند دوباره تلاش کند)
 *   • سقف اندازهٔ پشته
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EditHistory, type EditCommand } from '../src/lib/topology-edits.ts';

function recorder() {
  const calls: string[] = [];
  const command = (name: string): EditCommand => ({
    label: name,
    undo: async () => {
      calls.push(`undo:${name}`);
    },
    redo: async () => {
      calls.push(`redo:${name}`);
    },
  });
  return { calls, command };
}

test('واگرد و ازنو به ترتیب معکوس اجرا می‌شوند', async () => {
  const history = new EditHistory();
  const { calls, command } = recorder();
  history.push(command('a'));
  history.push(command('b'));

  assert.equal(history.undoLabel, 'b');
  await history.undo();
  assert.equal(history.undoLabel, 'a');
  assert.equal(history.redoLabel, 'b');
  await history.redo();
  assert.deepEqual(calls, ['undo:b', 'redo:b']);
  assert.equal(history.undoLabel, 'b');
});

test('ویرایش تازه پشتهٔ ازنو را پاک می‌کند', async () => {
  const history = new EditHistory();
  const { command } = recorder();
  history.push(command('a'));
  await history.undo();
  assert.ok(history.canRedo);
  history.push(command('b'));
  assert.equal(history.canRedo, false);
  assert.equal(history.undoLabel, 'b');
});

test('خطا در واگرد فرمان را در پشته نگه می‌دارد', async () => {
  const history = new EditHistory();
  const failing: EditCommand = {
    label: 'حذف گره',
    undo: async () => {
      throw new Error('تعارض نسخه');
    },
    redo: async () => {},
  };
  history.push(failing);

  await assert.rejects(() => history.undo(), /تعارض نسخه/);
  assert.equal(history.canUndo, true, 'فرمان ناموفق نباید حذف شود');
  assert.equal(history.canRedo, false);
  assert.equal(history.undoLabel, 'حذف گره');
});

test('سقف پشته قدیمی‌ترین فرمان را حذف می‌کند', async () => {
  const history = new EditHistory(2);
  const { command } = recorder();
  history.push(command('a'));
  history.push(command('b'));
  history.push(command('c'));
  assert.equal(history.size, 2);
  await history.undo();
  await history.undo();
  assert.equal(history.canUndo, false);
  assert.equal(history.undoLabel, null);
});

test('واگرد بدون فرمان خطای روشن می‌دهد و وضعیت را تغییر نمی‌دهد', async () => {
  const history = new EditHistory();
  await assert.rejects(() => history.undo(), /واگرد/);
  await assert.rejects(() => history.redo(), /ازنو/);
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
});

test('پاک‌کردن کامل، هر دو پشته را خالی می‌کند', async () => {
  const history = new EditHistory();
  const { command } = recorder();
  history.push(command('a'));
  await history.undo();
  history.clear();
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
  assert.equal(history.size, 0);
});
