/**
 * آزمون قفل رهبری موتور: گرفتن، تمدید، برداشتن پس از انقضا و آزادسازی.
 * این قفل مانع می‌شود سرور و engine-cli هم‌زمان یک تجهیز را Ping بزنند.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir } from '../helpers.mjs';

const dir = useTempDataDir('leader-unit');
const { db } = await import('../../db.js');
const { LeaderLock } = await import('../../leader.js');

after(() => {
  try {
    db.close();
  } catch {
    /* بی‌اثر */
  }
  cleanupDir(dir);
});

test('only one lock holder at a time', () => {
  const a = new LeaderLock({ ttlMs: 5000 });
  const b = new LeaderLock({ ttlMs: 5000 });
  assert.equal(a.tryAcquire(), true);
  assert.equal(b.tryAcquire(), false, 'second process must not become leader');
  assert.equal(a.held, true);
  assert.equal(b.held, false);
  const status = a.status();
  assert.equal(status.mine, true);
  assert.equal(status.active, true);
  assert.equal(status.owner, a.owner);
  a.release();
});

test('renew keeps ownership and release hands it over immediately', () => {
  const a = new LeaderLock({ ttlMs: 5000 });
  const b = new LeaderLock({ ttlMs: 5000 });
  assert.equal(a.tryAcquire(), true);
  assert.equal(a.renew(), true);
  assert.equal(b.tryAcquire(), false);
  assert.equal(a.release(), 1);
  assert.equal(a.held, false);
  assert.equal(b.tryAcquire(), true, 'a released lock must be acquirable at once');
  b.release();
});

test('an expired lock can be taken over and the old owner cannot renew', () => {
  const a = new LeaderLock({ ttlMs: 5000 });
  const b = new LeaderLock({ ttlMs: 5000 });
  assert.equal(a.tryAcquire(), true);
  // شبیه‌سازی توقف طولانی فرآیند رهبر (kill -9): قفل منقضی می‌شود
  db.prepare('UPDATE engine_lock SET expires_at = ? WHERE id = 1').run(Date.now() - 1);
  assert.equal(b.tryAcquire(), true);
  assert.equal(a.renew(), false, 'previous owner must lose leadership');
  assert.equal(a.held, false);

  const status = a.status();
  assert.equal(status.mine, false);
  assert.equal(status.owner, b.owner);
  b.release();
});

test('status reports an inactive lock when nobody holds it', () => {
  const a = new LeaderLock({ ttlMs: 5000 });
  a.release();
  const status = a.status();
  assert.equal(status.owner, null);
  assert.equal(status.active, false);
});
