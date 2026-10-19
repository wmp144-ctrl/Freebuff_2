/**
 * NetWatch — سیاست رمز عبور (Phase 3)
 * ----------------------------------------------------------------
 * سیاست در config.js خوانده و اعتبارسنجی می‌شود تا یک منبع حقیقت باشد:
 *   NETWATCH_PASSWORD_MIN_LENGTH      حداقل طول (پیش‌فرض ۱۲، بازهٔ ۸..۱۲۸)
 *   NETWATCH_PASSWORD_REQUIRE_COMPLEXITY
 *                                      الزام حداقل ۳ دسته از ۴ دسته
 *                                      (کوچک/بزرگ/رقم/نماد) یا عبارت ≥ ۲۰ نویسه
 *
 * قواعد:
 *   • رمز خام هرگز لاگ یا ذخیره نمی‌شود؛ این ماژول فقط true/false و پیام
 *     قابل‌نمایش برمی‌گرداند.
 *   • فهرست کوتاه رمزهای بسیار رایج و رمزهای مشتق از نام کاربری رد می‌شوند.
 *   • پیام خطا فقط دلیل رد را می‌گوید؛ خود رمز را بازگو نمی‌کند.
 *   • Argon2id در auth.js با پارامترهای OWASP انجام می‌شود؛ این ماژول فقط
 *     پیش‌شرط ورودی است.
 */
import crypto from 'node:crypto';

/** فهرست کوتاه رمزهای رایج (مقایسهٔ بدون حساسیت به بزرگی/کوچکی) */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  'p@ssw0rd',
  '12345678',
  '123456789',
  '1234567890',
  '123456789012',
  'qwertyuiop',
  'qwerty123',
  'letmein123',
  'welcome123',
  'admin123',
  'administrator',
  'changeme123',
  'iloveyou123',
  'monkey123',
  'dragon123',
  'netwatch123',
  'netwatch',
]);

const MIN_ALLOWED = 8;
const MAX_ALLOWED = 128;
const MAX_INPUT = 1024; // سقف ورودی برای جلوگیری از مصرف CPU با رمز غول‌آسا

/** نرمال‌سازی سیاست از config؛ مقدار نامعتبر به پیش‌فرض امن برمی‌گردد. */
export function normalizePolicy(policy = {}) {
  const rawMin = Number(policy.passwordMinLength ?? policy.minLength ?? 12);
  const minLength = Number.isInteger(rawMin) ? Math.min(MAX_ALLOWED, Math.max(MIN_ALLOWED, rawMin)) : 12;
  const requireComplexity = policy.passwordRequireComplexity ?? policy.requireComplexity ?? true;
  return { minLength, requireComplexity: requireComplexity !== false, maxLength: MAX_INPUT };
}

/** توصیف انسانی سیاست برای API/مستندات — بدون هیچ راز یا مقدار محیطی حساس */
export function describePasswordPolicy(policy = {}) {
  const p = normalizePolicy(policy);
  return {
    minLength: p.minLength,
    maxLength: p.maxLength,
    requireComplexity: p.requireComplexity,
    rules: [
      `حداقل ${p.minLength} نویسه`,
      p.requireComplexity
        ? 'حداقل سه دسته از حروف کوچک، حروف بزرگ، رقم و نماد (یا عبارت حداقل ۲۰ نویسه‌ای)'
        : 'بدون الزام ترکیب نویسه‌ها؛ طول ملاک است',
      'نباید رمز رایج، نام کاربری یا تکرار/دنبالهٔ ساده باشد',
    ],
  };
}

function characterClasses(value) {
  let classes = 0;
  if (/[a-z]/.test(value)) classes += 1;
  if (/[A-Z]/.test(value)) classes += 1;
  if (/\d/.test(value)) classes += 1;
  if (/[^A-Za-z0-9]/.test(value)) classes += 1;
  return classes;
}

function isSimpleSequence(value) {
  if (value.length < 8) return true;
  const lower = value.toLowerCase();
  const sequences = ['abcdefghijklmnopqrstuvwxyz', '01234567890', 'qwertyuiopasdfghjklzxcvbnm'];
  return sequences.some((seq) => {
    const doubled = seq + seq;
    return doubled.includes(lower) || [...doubled].reverse().join('').includes(lower);
  });
}

/**
 * اعتبارسنجی رمز.
 * @param {unknown} password
 * @param {{username?: string, policy?: object}} options
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validatePassword(password, { username = '', policy = {} } = {}) {
  const p = normalizePolicy(policy);
  const errors = [];
  if (typeof password !== 'string') {
    return { ok: false, errors: ['رمز عبور باید متن باشد.'] };
  }
  const value = password;
  if (!value.length) return { ok: false, errors: ['رمز عبور الزامی است.'] };
  if (value.length > p.maxLength) {
    return { ok: false, errors: [`رمز عبور نباید بیش از ${p.maxLength} نویسه باشد.`] };
  }
  if (value.length < p.minLength) {
    errors.push(`رمز عبور باید حداقل ${p.minLength} نویسه باشد.`);
  }
  if (value.trim() !== value) {
    errors.push('رمز عبور نباید با فاصله یا نویسهٔ کنترلی آغاز/پایان یابد.');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    errors.push('رمز عبور نباید نویسهٔ کنترلی داشته باشد.');
  }
  if (COMMON_PASSWORDS.has(value.toLowerCase()) || isSimpleSequence(value)) {
    errors.push('این رمز عبور بسیار رایج یا قابل‌حدس است؛ رمز دیگری انتخاب کنید.');
  }
  const name = String(username || '').trim().toLowerCase();
  if (name.length >= 3) {
    const lower = value.toLowerCase();
    // فقط حالت‌های واقعاً قابل‌حدس: خود نام کاربری، یا نام کاربری + پسوند کوتاه
    // (admin123). «شامل بودن» نام در یک عبارت بلند، رمز را ضعیف نمی‌کند و
    // سیاست را برای رمزهای بوت‌استرپ غیرقابل‌استفاده می‌کرد.
    const shortSuffix = (s) => s.length < 4;
    if (
      lower === name ||
      (lower.startsWith(name) && shortSuffix(lower.slice(name.length))) ||
      (lower.endsWith(name) && shortSuffix(lower.slice(0, lower.length - name.length)))
    ) {
      errors.push('رمز عبور نباید نام کاربری یا نام کاربری + پسوند کوتاه باشد.');
    }
  }
  if (/^(.)\1+$/.test(value)) {
    errors.push('رمز عبور نباید تکرار یک نویسه باشد.');
  }
  if (p.requireComplexity && value.length < 20 && characterClasses(value) < 3) {
    errors.push('رمز عبور باید حداقل سه دسته از حروف کوچک، حروف بزرگ، رقم و نماد را داشته باشد (یا حداقل ۲۰ نویسه باشد).');
  }
  return { ok: errors.length === 0, errors };
}

/** اعتبارسنجی با پرتاب خطای HTTP 400؛ برای مسیرهای ساخت/تغییر کاربر */
export function assertPassword(password, options = {}) {
  const result = validatePassword(password, options);
  if (result.ok) return true;
  const error = new Error(result.errors.join(' '));
  error.status = 400;
  error.code = 'WEAK_PASSWORD';
  error.errors = result.errors;
  throw error;
}

/**
 * ساخت رمز تصادفی قوی برای نخستین مدیر. هر چهار دسته تضمین شده‌اند تا سیاست
 * پیش‌فرض (سه دسته) و Argon2id بدون شکست بوت پاس شوند.
 */
export function generateStrongPassword(length = 24) {
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const symbols = '!@#$%^&*()-_=+';
  const all = lower + upper + digits + symbols;
  const target = Math.max(16, Math.min(64, Number(length) || 24));
  const chars = [lower, upper, digits, symbols].map((set) => set[crypto.randomInt(set.length)]);
  while (chars.length < target) chars.push(all[crypto.randomInt(all.length)]);
  // بی‌ترتیب‌سازی (Fisher–Yates) تا نویسه‌های تضمین‌شده در ابتدا نمانند
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export default {
  normalizePolicy,
  describePasswordPolicy,
  validatePassword,
  assertPassword,
  generateStrongPassword,
};
