/**
 * آزمون واحد احراز هویت: هش رمز، نشست، CSRF و ساخت نخستین مدیر.
 * پایگاه‌دادهٔ موقت پیش از import شدن db.js تنظیم می‌شود.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir } from '../helpers.mjs';

const dir = useTempDataDir('auth-unit');
process.env.NETWATCH_ADMIN_PASSWORD = 'unit-admin-password-123';
const auth = await import('../../auth.js');
const { db } = await import('../../db.js');

after(() => {
  try {
    db.close();
  } catch {
    /* بی‌اثر */
  }
  cleanupDir(dir);
});

/** درخواست/پاسخ ساختگی برای ساخت و خواندن نشست */
function fakeReq(cookie = '') {
  return {
    ip: '127.0.0.1',
    secure: false,
    get: (name) => (name.toLowerCase() === 'cookie' ? cookie : name.toLowerCase() === 'user-agent' ? 'node-test' : ''),
  };
}

function fakeRes() {
  const headers = {};
  return {
    headers,
    append(name, value) {
      headers[name] = headers[name] ? [].concat(headers[name], value) : value;
    },
    setHeader(name, value) {
      headers[name] = value;
    },
  };
}

test('hashPassword/verifyPassword round-trip and rejects wrong passwords', () => {
  const stored = auth.hashPassword('correct horse battery staple');
  assert.match(stored, /^scrypt\$/);
  assert.ok(!stored.includes('correct horse'), 'plaintext must not be stored');
  assert.equal(auth.verifyPassword('correct horse battery staple', stored), true);
  assert.equal(auth.verifyPassword('wrong', stored), false);
  // هر هش نمک جدا دارد
  assert.notEqual(auth.hashPassword('same'), auth.hashPassword('same'));
});

test('verifyPassword tolerates corrupted stored hashes instead of throwing', () => {
  for (const bad of ['', null, 'plain', 'scrypt$1$2$3', 'scrypt$x$y$z$AAAA$BBBB', 'bcrypt$1$2$3$4$5']) {
    assert.equal(auth.verifyPassword('x', bad), false, `stored=${bad}`);
  }
});

test('parseCookies decodes values and ignores malformed parts', () => {
  assert.deepEqual(auth.parseCookies('a=1; b=two%20words; junk; c='), { a: '1', b: 'two words', c: '' });
  assert.deepEqual(auth.parseCookies(''), {});
});

test('ensureInitialAdmin creates exactly one admin from env password', () => {
  const first = auth.ensureInitialAdmin();
  assert.equal(first.created, true);
  const admin = auth.findUserByUsername('admin');
  assert.equal(admin.role, 'admin');
  assert.equal(auth.verifyPassword('unit-admin-password-123', admin.password_hash), true);
  assert.equal(auth.ensureInitialAdmin().created, false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM users').get().c, 1);
});

test('createUser validates username, password and role', () => {
  assert.throws(() => auth.createUser({ username: 'ab', password: 'long-enough-1' }), /نام کاربری/);
  assert.throws(() => auth.createUser({ username: 'has space', password: 'long-enough-1' }), /نام کاربری/);
  assert.throws(() => auth.createUser({ username: 'shortpw', password: '1234' }), /رمز عبور/);
  assert.throws(() => auth.createUser({ username: 'badrole', password: 'long-enough-1', role: 'root' }), /نقش/);
  const viewer = auth.createUser({ username: 'viewer.one', password: 'long-enough-1', role: 'viewer' });
  assert.equal(viewer.role, 'viewer');
  assert.equal(viewer.username, 'viewer.one');
  assert.throws(() => auth.createUser({ username: 'VIEWER.ONE', password: 'long-enough-1' }), /قبلاً ثبت/);
});

test('createSession → attachUser resolves the user and CSRF token', () => {
  const user = auth.createUser({ username: 'sess.user', password: 'long-enough-1', role: 'admin' });
  const res = fakeRes();
  const { token, csrf } = auth.createSession(user.id, fakeReq(), res);
  const cookies = [].concat(res.headers['Set-Cookie']);
  assert.equal(cookies.length, 2);
  assert.match(cookies[0], /nw_session=/);
  assert.match(cookies[0], /HttpOnly/);
  assert.match(cookies[0], /SameSite=Strict/);
  assert.doesNotMatch(cookies[1], /HttpOnly/, 'CSRF cookie must be readable by the page');

  const req = fakeReq(`nw_session=${token}; nw_csrf=${csrf}`);
  let called = false;
  auth.attachUser(req, fakeRes(), () => (called = true));
  assert.ok(called);
  assert.equal(req.user.username, 'sess.user');
  assert.equal(req.user.role, 'admin');
  assert.equal(req.csrfToken, csrf);
});

test('expired and unknown sessions are rejected without throwing', () => {
  const req = fakeReq('nw_session=not-a-real-token');
  auth.attachUser(req, fakeRes(), () => {});
  assert.equal(req.user, null);

  const user = auth.createUser({ username: 'expired.user', password: 'long-enough-1' });
  const res = fakeRes();
  const { token } = auth.createSession(user.id, fakeReq(), res);
  db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1000, user.id);
  const expiredReq = fakeReq(`nw_session=${token}`);
  auth.attachUser(expiredReq, fakeRes(), () => {});
  assert.equal(expiredReq.user, null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id = ?').get(user.id).c, 0);
});

test('disabled users lose access immediately', () => {
  const user = auth.createUser({ username: 'disabled.user', password: 'long-enough-1' });
  const { token } = auth.createSession(user.id, fakeReq(), fakeRes());
  db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(user.id);
  const req = fakeReq(`nw_session=${token}`);
  auth.attachUser(req, fakeRes(), () => {});
  assert.equal(req.user, null);
});

test('session pruning removes only expired rows', () => {
  const user = auth.findUserByUsername('admin');
  auth.createSession(user.id, fakeReq(), fakeRes());
  db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(0, user.id);
  const before = db.prepare('SELECT COUNT(*) c FROM sessions').get().c;
  auth.pruneSessions();
  const after = db.prepare('SELECT COUNT(*) c FROM sessions').get().c;
  assert.ok(after < before);
});
