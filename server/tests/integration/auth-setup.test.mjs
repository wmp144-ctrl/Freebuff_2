/**
 * آزمون یکپارچهٔ راه‌اندازی اولیه
 * ----------------------------------------------------------------
 *   • سرور تازه هیچ کاربری نمی‌سازد، حتی اگر NETWATCH_ADMIN_PASSWORD تنظیم شده باشد.
 *   • وضعیت راه‌اندازی، سیاست رمز را بدون هیچ رازی برمی‌گرداند.
 *   • تکرار نامطابق/رمز ضعیف رد می‌شود و هنوز حسابی ساخته نشده است.
 *   • نخستین راه‌اندازی فقط یک مدیر می‌سازد، نشست می‌دهد و راه‌اندازی دوباره ۴۰۹ است.
 *   • ورود با همان نام کاربری/رمز انتخاب‌شده کار می‌کند.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TEST_ADMIN, api, cleanupDir, login, startServer, useTempDataDir } from '../helpers.mjs';

test('first-run setup creates the initial admin from user input and ignores env passwords', async () => {
  const dir = useTempDataDir('auth-setup');
  const admin = { username: 'netadmin', password: 'Strong-admin-pass!9' };
  const srv = await startServer({
    dataDir: dir,
    engine: false,
    setup: false,
    env: {
      NETWATCH_SEED_DEMO: '0',
      // روش قدیمی باید کاملاً بی‌اثر باشد: هیچ کاربری از این متغیر ساخته نمی‌شود.
      NETWATCH_ADMIN_PASSWORD: TEST_ADMIN.password,
      NETWATCH_ADMIN_USER: TEST_ADMIN.username,
    },
  });
  try {
    let res = await api(srv.base, 'GET', '/api/auth/setup', undefined, { auth: false });
    assert.equal(res.status, 200);
    assert.equal(res.data.required, true, 'نصب تازه باید راه‌اندازی اولیه را مطالبه کند');
    assert.ok(res.data.passwordPolicy?.rules?.length >= 2);
    assert.equal(res.data.passwordPolicy.rules.some((r) => r.includes(String(TEST_ADMIN.password))), false);

    // رمز env دیگر حساب نمی‌سازد.
    res = await api(
      srv.base,
      'POST',
      '/api/auth/login',
      { username: TEST_ADMIN.username, password: TEST_ADMIN.password },
      { auth: false }
    );
    assert.equal(res.status, 401, 'NETWATCH_ADMIN_PASSWORD نباید حساب بسازد');

    // تکرار رمز نامطابق
    res = await api(
      srv.base,
      'POST',
      '/api/auth/setup',
      { username: admin.username, password: admin.password, confirmPassword: 'something-else' },
      { auth: false }
    );
    assert.equal(res.status, 400);
    assert.match(res.data.error, /یکسان/);

    // رمز ضعیف (سیاست موجود بدون تغییر اعمال می‌شود)
    res = await api(
      srv.base,
      'POST',
      '/api/auth/setup',
      { username: admin.username, password: 'short', confirmPassword: 'short' },
      { auth: false }
    );
    assert.equal(res.status, 400);
    assert.match(res.data.error, /رمز عبور/);
    assert.equal((await api(srv.base, 'GET', '/api/auth/setup', undefined, { auth: false })).data.required, true);

    // راه‌اندازی موفق
    res = await api(
      srv.base,
      'POST',
      '/api/auth/setup',
      { username: admin.username, password: admin.password, confirmPassword: admin.password },
      { auth: false }
    );
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.user.username, admin.username);
    assert.equal(res.data.user.role, 'admin');
    assert.ok(res.data.user.permissions.includes('users:manage'));

    // راه‌اندازی دوباره ممنوع است و کاربر دوم ساخته نمی‌شود.
    res = await api(
      srv.base,
      'POST',
      '/api/auth/setup',
      { username: 'second', password: 'Second-admin-pass!9', confirmPassword: 'Second-admin-pass!9' },
      { auth: false }
    );
    assert.equal(res.status, 409);
    assert.equal((await api(srv.base, 'GET', '/api/auth/setup', undefined, { auth: false })).data.required, false);

    // ورود با اطلاعاتی که خود کاربر انتخاب کرده است.
    const session = await login(srv.base, admin.username, admin.password);
    assert.equal(session.user.username, admin.username);
    res = await api(srv.base, 'GET', '/api/auth/users');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.items.map((u) => u.username), [admin.username]);
  } finally {
    await srv.stop();
    cleanupDir(dir);
  }
});
