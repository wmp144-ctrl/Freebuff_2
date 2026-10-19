/**
 * آزمون واحد سیاست رمز عبور (Phase 3):
 *   • طول قابل تنظیم و پیش‌فرض ۱۲
 *   • الزام ترکیب نویسه‌ها (یا عبارت بلند)
 *   • رد رمزهای رایج/مشابه نام کاربری/کنترلی
 *   • رمز تولیدی بوت‌استرپ همیشه سیاست را پاس می‌کند
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePolicy,
  describePasswordPolicy,
  validatePassword,
  assertPassword,
  generateStrongPassword,
} from '../../password-policy.js';

test('default policy requires 12 characters and three character classes', () => {
  const policy = normalizePolicy({});
  assert.equal(policy.minLength, 12);
  assert.equal(policy.requireComplexity, true);
  assert.equal(validatePassword('Short123!x', { policy }).ok, false, '10 chars is too short');
  assert.equal(validatePassword('short-Pass-123', { policy }).ok, true);
  assert.equal(validatePassword('lowercaseonly1234', { policy }).ok, false, 'two classes only');
  // عبارت بلند (≥۲۰) بدون سه دسته هم پذیرفته می‌شود
  assert.equal(validatePassword('correct horse battery staple', { policy }).ok, true);
});

test('policy is configurable', () => {
  const relaxed = { passwordMinLength: 8, passwordRequireComplexity: false };
  assert.equal(validatePassword('zigzag-fjord', { policy: relaxed }).ok, true);
  assert.equal(validatePassword('abcdefgh', { policy: relaxed }).ok, false, 'simple sequences stay blocked');
  const strict = { passwordMinLength: 20, passwordRequireComplexity: true };
  assert.equal(validatePassword('Abcdefghij1!', { policy: strict }).ok, false);
  assert.equal(validatePassword('Abcdefghijklmnop1!23', { policy: strict }).ok, true);
});

test('common, repetitive, control and username-derived passwords are rejected', () => {
  const policy = normalizePolicy({});
  assert.equal(validatePassword('password123', { policy }).ok, false);
  assert.equal(validatePassword('123456789012', { policy }).ok, false);
  assert.equal(validatePassword('aaaaaaaaaaaa', { policy }).ok, false);
  assert.equal(validatePassword('Active-User-123!', { username: 'active-user-123', policy }).ok, false);
  assert.equal(validatePassword('Active-User-123!x', { username: 'someone', policy }).ok, true);
  assert.equal(validatePassword('Good-Pass-123\n', { policy }).ok, false, 'control characters rejected');
  assert.equal(validatePassword(' Good-Pass-123', { policy }).ok, false, 'leading whitespace rejected');
  assert.equal(validatePassword('', { policy }).ok, false);
  assert.equal(validatePassword(null, { policy }).ok, false);
});

test('assertPassword throws a 400 without echoing the secret', () => {
  try {
    assertPassword('weak', { username: 'alice', policy: {} });
    assert.fail('expected a throw');
  } catch (error) {
    assert.equal(error.status, 400);
    assert.equal(error.code, 'WEAK_PASSWORD');
    assert.match(error.message, /رمز عبور/);
    assert.equal(error.message.includes('weak'), false, 'the raw secret must never be echoed');
  }
});

test('generated bootstrap passwords always satisfy the default policy', () => {
  const policy = normalizePolicy({});
  for (let i = 0; i < 25; i++) {
    const password = generateStrongPassword();
    assert.ok(password.length >= 16);
    assert.equal(validatePassword(password, { policy }).ok, true, `generated password rejected: ${password}`);
  }
});

test('policy description is safe for API responses', () => {
  const description = describePasswordPolicy({ passwordMinLength: 14 });
  assert.equal(description.minLength, 14);
  assert.equal(description.requireComplexity, true);
  assert.equal(JSON.stringify(description).includes('secret'), false);
});
