/**
 * آزمون Fencing Token قفل رهبری:
 *   • epoch در پایگاه‌داده نگهداری می‌شود و با هر انتقال مالکیت یک واحد
 *     افزایش می‌یابد (نه با تمدید).
 *   • رهبر سابق نمی‌تواند تمدید کند یا قفل رهبر جدید را آزاد کند.
 *   • verify با epoch قدیمی پس از تغییر رهبری false است.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir } from '../helpers.mjs';

const dir = useTempDataDir('leader-fencing');
const { db } = await import('../../db.js');
const { LeaderLock } = await import('../../leader.js');

after(() => {
  try {
    db.prepare('DELETE FROM engine_lock').run();
  } catch {
    /* بی‌اثر */
  }
  try {
    db.close();
  } catch {
    /* بی‌اثر */
  }
  cleanupDir(dir);
});

test('epoch increments only on ownership transfer and is persisted', () => {
  db.prepare('DELETE FROM engine_lock').run();
  const a = new LeaderLock({ ttlMs: 60000 });
  assert.equal(a.tryAcquire(), true);
  const firstEpoch = a.epoch;
  assert.ok(firstEpoch >= 1);
  assert.equal(a.status().epoch, firstEpoch);

  // تمدید همان مالک، epoch را تغییر نمی‌دهد
  assert.equal(a.renew(), true);
  assert.equal(a.epoch, firstEpoch);
  const row = db.prepare('SELECT epoch, owner FROM engine_lock WHERE id = 1').get();
  assert.equal(Number(row.epoch), firstEpoch);
  assert.equal(row.owner, a.owner);

  // انقضای Lease و برداشتن قفل توسط نمونهٔ دیگر
  db.prepare('UPDATE engine_lock SET expires_at = ? WHERE id = 1').run(Date.now() - 1);
  const b = new LeaderLock({ ttlMs: 60000 });
  assert.equal(b.tryAcquire(), true);
  assert.equal(b.epoch, firstEpoch + 1, 'a new leader must get a higher fencing token');
  assert.equal(Number(db.prepare('SELECT epoch FROM engine_lock WHERE id = 1').get().epoch), firstEpoch + 1);

  // رهبر سابق: تمدید/verify ناموفق و release بی‌اثر
  assert.equal(a.renew(), false);
  assert.equal(a.held, false);
  assert.equal(a.verify(firstEpoch), false);
  assert.equal(a.release(), 0, 'the old leader must not delete the new leader lock');
  assert.equal(a.status().mine, false);
  assert.equal(b.status().mine, true);
  assert.equal(b.verify(b.epoch), true);
  assert.equal(b.release(), 1);
});

test('verify requires both the local epoch and a live lease', () => {
  db.prepare('DELETE FROM engine_lock').run();
  const a = new LeaderLock({ ttlMs: 1000 });
  assert.equal(a.tryAcquire(), true);
  const epoch = a.epoch;
  assert.equal(a.verify(epoch), true);
  // epoch اشتباه
  assert.equal(a.verify(epoch + 1), false);
  // انقضای TTL بدون تغییر مالک: نوشتن با Lease منقضی مجاز نیست
  db.prepare('UPDATE engine_lock SET expires_at = ? WHERE id = 1').run(Date.now() - 1);
  assert.equal(a.verify(epoch), false);
  a.release();
});

test('released lock can be reacquired with a fresh epoch', () => {
  db.prepare('DELETE FROM engine_lock').run();
  const a = new LeaderLock({ ttlMs: 60000 });
  assert.equal(a.tryAcquire(), true);
  const oldEpoch = a.epoch;
  assert.equal(a.release(), 1);
  const b = new LeaderLock({ ttlMs: 60000 });
  assert.equal(b.tryAcquire(), true);
  assert.ok(b.epoch > oldEpoch, 'reacquisition is a new leadership period');
  b.release();
});
