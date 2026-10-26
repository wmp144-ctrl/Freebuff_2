/**
 * NetWatch — احراز هویت و کنترل دسترسی
 * ----------------------------------------------------------------
 * پیش از این نسخه، هر کسی که به پورت سرویس دسترسی داشت می‌توانست تجهیز حذف
 * کند یا تنظیمات را تغییر دهد. این ماژول یک لایهٔ سبک و بدون وابستگی اضافه
 * می‌کند:
 *
 *   • رمز عبور با Argon2id (نمک تصادفی برای هر کاربر) هش می‌شود؛ رمز خام هرگز
 *     ذخیره یا لاگ نمی‌شود. هش‌های قدیمی scrypt هنگام نخستین ورود موفق به
 *     Argon2id ارتقا می‌یابند.
 *   • نشست با کوکی HttpOnly + SameSite=Strict و توکن تصادفی ۲۵۶ بیتی؛ در
 *     پایگاه‌داده فقط هش SHA-256 توکن نگه داشته می‌شود تا نشت فایل DB نشست‌ها
 *     را قابل استفاده نکند.
 *   • سه نقش: admin (Administrator)، operator (Operator) و viewer (Viewer)؛
 *     مجوز دقیق هر API در permissions.js تعریف شده است.
 *   • CSRF با الگوی double-submit: هدر X-CSRF-Token باید با کوکی nw_csrf و
 *     مقدار هش‌شده در نشست بخواند. گارد همان‌مبدأ (index.js) هم سر جایش است.
 *   • نخستین مدیر در نخستین ورود و با نام کاربری/رمز انتخابی خود اپراتور
 *     ساخته می‌شود (POST /api/auth/setup). تا وقتی هیچ کاربری وجود ندارد،
 *     صفحهٔ ورود فرم «راه‌اندازی اولیه» را نشان می‌دهد و رمز باید دو بار
 *     وارد شود. هیچ رمز پیش‌فرض یا رمز تولیدشده در فایل ذخیره نمی‌شود.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { hashSync, verifySync } from '@node-rs/argon2';
import { db, DATA_DIR, transaction } from './db.js';
import { logEvent } from './logger.mjs';
import { config } from './config.js';
import { createRateLimiter, clientIp } from './rate-limit.js';
import { normalizeRole, permissionsForRole, ROLE_LABELS, requirePermission, ALL_PERMISSIONS } from './permissions.js';
import { assertPassword, describePasswordPolicy } from './password-policy.js';

const SESSION_COOKIE = 'nw_session';
const CSRF_COOKIE = 'nw_csrf';
const AUTH = config.auth;
const SESSION_TTL_MS = AUTH.sessionTtlMs;
const SESSION_IDLE_MS = AUTH.sessionIdleMs;
// فقط برای پاک‌کردن فایل بازماندهٔ نسخه‌های قدیمی (رمز بوت‌استرپ) استفاده می‌شود.
const LEGACY_ADMIN_PASSWORD_FILE = path.join(DATA_DIR, 'initial-admin-password.txt');
const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;
const MIN_PASSWORD = AUTH.passwordMinLength;
const MAX_PASSWORD = 1024; // سقف ورودی برای جلوگیری از مصرف حافظه/CPU با رمز غول‌آسا
// پارامترهای OWASP برای Argon2id (۱۹ مگابایت، ۲ تکرار، ۱ موازی)
const ARGON2 = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 };

/* ------------------------------------------------------------------ */
/* رمز عبور                                                            */
/* ------------------------------------------------------------------ */

/** @returns {string} هش Argon2id با فرمت استاندارد $argon2id$... */
export function hashPassword(password) {
  return hashSync(String(password), ARGON2);
}

/** آیا هش از الگوریتم/پارامترهای جاری است؟ (برای ارتقای خودکار هنگام ورود) */
export function needsRehash(stored) {
  const s = String(stored || '');
  if (!s.startsWith('$argon2id$')) return true;
  const m = s.match(/m=(\d+),t=(\d+),p=(\d+)/);
  if (!m) return true;
  return Number(m[1]) < ARGON2.memoryCost || Number(m[2]) < ARGON2.timeCost || Number(m[3]) < ARGON2.parallelism;
}

/**
 * بررسی رمز. هر قالب ناشناخته یا خراب «نامعتبر» است، نه استثنا؛ یک ردیف خراب
 * در جدول کاربران نباید ورود همه را ۵۰۰ کند. هش‌های scrypt نسخه‌های قبلی هم
 * تا زمان ارتقای خودکار پشتیبانی می‌شوند.
 */
export function verifyPassword(password, stored) {
  const value = String(stored || '');
  try {
    if (value.startsWith('$argon2')) return verifySync(value, String(password));
    if (value.startsWith('scrypt$')) {
      const parts = value.split('$');
      if (parts.length !== 6) return false;
      const [, n, r, p, saltB64, hashB64] = parts;
      const expected = Buffer.from(hashB64, 'base64');
      if (!expected.length) return false;
      const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
        N: Number(n),
        r: Number(r),
        p: Number(p),
      });
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    }
    return false;
  } catch {
    return false;
  }
}

/** هش ثابت برای مقایسهٔ زمان‌ثابت وقتی کاربر وجود ندارد (ضد شمارش کاربران) */
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

/* ------------------------------------------------------------------ */
/* نشست                                                                */
/* ------------------------------------------------------------------ */

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function isSecureRequest(req) {
  // فقط req.secure معتبر است؛ Express آن را از سوکت TLS یا از X-Forwarded-Proto
  // تنها وقتی می‌سازد که NETWATCH_TRUST_PROXY صریحاً تنظیم شده باشد. خواندن
  // مستقیم هدر در اینجا اجازه می‌داد یک درخواست HTTP بدون پروکسی، کوکی Secure
  // جعلی بگیرد یا برعکس. اگر خود سرویس با TLS اجرا شود، همهٔ پاسخ‌ها Secureاند.
  return Boolean(req.secure) || Boolean(config.tls.enabled);
}

function cookieAttrs(req, maxAgeSec) {
  return [
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
    isSecureRequest(req) ? 'Secure' : null,
  ]
    .filter(Boolean)
    .join('; ');
}

/**
 * ساخت نشست تازه. توکن خام فقط یک‌بار (در کوکی) به کلاینت می‌رود و CSRF
 * جداگانه صادر می‌شود تا اسکریپت صفحه بتواند آن را در هدر بفرستد.
 */
export function createSession(userId, req, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions(token_hash, user_id, csrf_hash, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?,?,?,?,?,?,?,?)'
  ).run(
    sha256(token),
    userId,
    sha256(csrf),
    now,
    now + SESSION_TTL_MS,
    now,
    clientIp(req).slice(0, 64),
    String(req.get('user-agent') || '').slice(0, 200)
  );
  const maxAgeSec = SESSION_TTL_MS / 1000;
  res.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; ${cookieAttrs(req, maxAgeSec)}`
  );
  res.append(
    'Set-Cookie',
    `${CSRF_COOKIE}=${csrf}; ${['Path=/', 'SameSite=Strict', `Max-Age=${Math.floor(maxAgeSec)}`, isSecureRequest(req) ? 'Secure' : null]
      .filter(Boolean)
      .join('; ')}`
  );
  return { token, csrf, expiresAt: now + SESSION_TTL_MS };
}

export function clearSessionCookies(req, res) {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; ${cookieAttrs(req, 0)}`);
  res.append(
    'Set-Cookie',
    `${CSRF_COOKIE}=; ${['Path=/', 'SameSite=Strict', 'Max-Age=0', isSecureRequest(req) ? 'Secure' : null].filter(Boolean).join('; ')}`
  );
}

/** حذف نشست جاری (خروج) */
export function destroySession(token) {
  if (!token) return 0;
  return db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token)).changes;
}

/** حذف نشست‌های منقضی یا بی‌فعالیت (Idle Timeout)؛ دوره‌ای هم اجرا می‌شود */
export function pruneSessions(now = Date.now()) {
  try {
    return db
      .prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?')
      .run(now, now - SESSION_IDLE_MS).changes;
  } catch {
    return 0;
  }
}

/** حذف نشستِ کوکیِ همراه درخواست؛ برای بازتولید نشست هنگام ورود */
export function destroySessionFromRequest(req) {
  const cookies = parseCookies(req.get('cookie') || '');
  return destroySession(cookies[SESSION_COOKIE]);
}

/**
 * خواندن نشست از کوکی و چسباندن کاربر به درخواست.
 * هیچ پاسخ خطایی نمی‌دهد؛ تصمیم با requireAuth است.
 */
export function attachUser(req, res, next) {
  req.user = null;
  req.session = null;
  const cookies = parseCookies(req.get('cookie') || '');
  const token = cookies[SESSION_COOKIE];
  if (!token) return next();
  // پاسخ وابسته به نشست است؛ کش مشترک (پروکسی) نباید آن را بین کاربران به
  // اشتراک بگذارد.
  res.setHeader('Vary', 'Cookie');
  try {
    const row = db
      .prepare(
        `SELECT s.token_hash, s.csrf_hash, s.expires_at, s.last_seen_at,
                u.id AS userId, u.username, u.role, u.disabled, u.display_name
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ?`
      )
      .get(sha256(token));
    const now = Date.now();
    if (!row) return next();
    // انقضای مطلق، غیرفعال‌شدن حساب و Idle Timeout همه نشست را باطل می‌کنند.
    // بدون Idle Timeout، یک کوکی رهاشده تا ۱۲ ساعت (یا بیشتر) قابل استفاده بود.
    if (row.expires_at <= now || row.disabled || now - row.last_seen_at > SESSION_IDLE_MS) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
      return next();
    }
    // آخرین بازدید حداکثر هر ۶۰ ثانیه به‌روز می‌شود تا هر درخواست یک نوشتن
    // اضافه در WAL نسازد.
    if (now - row.last_seen_at > 60000) {
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, row.token_hash);
    }
    req.session = { tokenHash: row.token_hash, csrfHash: row.csrf_hash, expiresAt: row.expires_at };
    req.user = {
      id: row.userId,
      username: row.username,
      role: row.role,
      displayName: row.display_name || row.username,
    };
    // نشست‌هایی که با کوکی می‌آیند فقط با هدر CSRF هم‌خوان پذیرفته می‌شوند
    req.csrfToken = cookies[CSRF_COOKIE] || null;
  } catch (e) {
    logEvent('error', 'auth_session_error', { message: e.message });
  }
  return next();
}

/**
 * تنها مسیرهای عمومی: راه‌اندازی اولیه، ورود و سلامت عمومی.
 * خروج و /auth/me نیازمند نشست‌اند تا خروج هم CSRF-محافظت شود.
 */
const PUBLIC_PATHS = new Set(['/health', '/auth/login', '/auth/setup']);

export function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (req.user) return next();
  res.setHeader('Cache-Control', 'no-store');
  return res.status(401).json({ error: 'برای دسترسی به این بخش باید وارد شوید.' });
}

/**
 * CSRF: برای درخواست‌های تغییردهنده، هدر X-CSRF-Token باید با کوکی و با
 * مقدار ذخیره‌شده در نشست بخواند. درخواستی که کوکی ندارد (ورود) از این
 * گارد عبور می‌کند، چون نشستی برای سوءاستفاده وجود ندارد.
 */
export function csrfGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  // ورود و راه‌اندازی اولیه پیش از وجود نشست انجام می‌شوند؛ نشستی برای
  // سوءاستفاده وجود ندارد.
  if (req.path === '/auth/login' || req.path === '/auth/setup') return next();
  if (!req.user || !req.session) return next(); // requireAuth پاسخ ۴۰۱ می‌دهد
  const header = String(req.get('x-csrf-token') || '');
  if (!header || !req.csrfToken || header !== req.csrfToken) {
    logEvent('warn', 'auth_csrf_rejected', { path: req.originalUrl, user: req.user.username });
    return res.status(403).json({ error: 'توکن امنیتی درخواست نامعتبر است؛ صفحه را دوباره بارگذاری کنید.' });
  }
  if (sha256(header) !== req.session.csrfHash) {
    return res.status(403).json({ error: 'توکن امنیتی درخواست نامعتبر است؛ صفحه را دوباره بارگذاری کنید.' });
  }
  return next();
}

/* ------------------------------------------------------------------ */
/* کاربران                                                             */
/* ------------------------------------------------------------------ */

export function findUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username || '').trim());
}

export function listUsers() {
  return db
    .prepare(
      'SELECT id, username, role, display_name, disabled, created_at, updated_at, last_login_at, failed_login_count, locked_until FROM users ORDER BY id'
    )
    .all();
}

function publicUser(row) {
  if (!row) return null;
  const role = normalizeRole(row.role) || 'viewer';
  return {
    id: row.id,
    username: row.username,
    role,
    roleLabel: ROLE_LABELS[role],
    displayName: row.display_name || row.username,
    permissions: permissionsForRole(role),
    disabled: Boolean(row.disabled),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at || null,
    // وضعیت قفل فقط برای پاسخ‌های مدیریتی/خود کاربر است و هرگز هش رمز را
    // همراه ندارد.
    locked: Boolean(row.locked_until && Number(row.locked_until) > Date.now()),
    lockedUntil: row.locked_until ? Number(row.locked_until) : null,
    failedLoginCount: Number(row.failed_login_count || 0),
  };
}

/** پاک‌کردن فایل رمز بوت‌استرپِ بازمانده از نسخه‌های قبلی پس از ورود مدیر */
function removeLegacyBootstrapPasswordFile() {
  try {
    if (fs.existsSync(LEGACY_ADMIN_PASSWORD_FILE)) fs.unlinkSync(LEGACY_ADMIN_PASSWORD_FILE);
  } catch {
    /* بی‌اثر */
  }
}

export function createUser({ username, password, role = 'viewer', displayName = '' }) {
  const name = String(username || '').trim();
  if (!USERNAME_RE.test(name)) {
    throw Object.assign(new Error('نام کاربری باید ۳ تا ۳۲ نویسهٔ لاتین، رقم، نقطه، خط تیره یا زیرخط باشد.'), { status: 400 });
  }
  // سیاست قابل تنظیم (طول، ترکیب، رمز رایج و شباهت به نام کاربری)
  assertPassword(password, { username: name, policy: AUTH });
  const normalizedRole = normalizeRole(role);
  if (!normalizedRole) {
    throw Object.assign(new Error('نقش نامعتبر است؛ نقش‌های مجاز: admin، operator، viewer.'), { status: 400 });
  }
  const now = Date.now();
  try {
    const r = db
      .prepare('INSERT INTO users(username, password_hash, role, display_name, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run(name, hashPassword(password), normalizedRole, String(displayName || '').slice(0, 80), now, now);
    return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid)));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      throw Object.assign(new Error('این نام کاربری قبلاً ثبت شده است.'), { status: 409 });
    }
    throw e;
  }
}

/** آیا سامانه هنوز هیچ کاربری ندارد؟ فقط در این حالت راه‌اندازی اولیه مجاز است. */
export function initialSetupRequired() {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0;
}

/**
 * ساخت نخستین مدیر با نام کاربری و رمزی که خود اپراتور در صفحهٔ راه‌اندازی
 * وارد کرده است. تکرار رمز اجباری است و سیاست رمز عبور (مانند ساخت کاربر)
 * اعمال می‌شود. بررسی «نبود کاربر» و درج حساب در یک تراکنش انجام می‌شود تا
 * دو درخواست هم‌زمان نتوانند دو مدیر بسازند.
 *
 * @param {{username?: string, password?: string, confirmPassword?: string, displayName?: string}} input
 */
export function createInitialAdmin({ username, password, confirmPassword, displayName = 'مدیر سامانه' } = {}) {
  if (password !== confirmPassword) {
    throw Object.assign(new Error('رمز عبور و تکرار آن باید یکسان باشند.'), { status: 400 });
  }
  if (!password) {
    throw Object.assign(new Error('رمز عبور الزامی است.'), { status: 400 });
  }
  const user = transaction(
    () => {
      if (!initialSetupRequired()) {
        throw Object.assign(new Error('حساب مدیر قبلاً ساخته شده است؛ از صفحهٔ ورود استفاده کنید.'), { status: 409 });
      }
      return createUser({ username, password, role: 'admin', displayName });
    },
    { label: 'auth.initial_admin' }
  );
  logEvent('warn', 'admin_bootstrap', { username: user.username, method: 'interactive_setup' });
  return user;
}

/* ------------------------------------------------------------------ */
/* مسیرهای /api/auth                                                   */
/* ------------------------------------------------------------------ */

// سقف نرخ ورود جداگانه و سخت‌گیرانه: ۱۰ تلاش در ۱۵ دقیقه برای هر IP.
// بدون این، رمز ۸ نویسه‌ای با حملهٔ آنلاین قابل حدس است.
const loginLimiter = createRateLimiter({
  name: 'ورود',
  windowMs: 15 * 60 * 1000,
  max: config.rateLimit.login,
  maxKeys: config.rateLimit.maxKeys,
  // شمارش هم روی IP و هم روی نام کاربری: حملهٔ توزیع‌شده روی یک حساب یا
  // تلاش متمرکز از یک IP هر دو محدود می‌شوند.
  accountKey: (req) => String(req.body?.username || '').trim().slice(0, 64) || null,
});

// راه‌اندازی اولیه فقط یک بار معنا دارد، اما همان سقف سخت‌گیرانهٔ ورود را
// اعمال می‌کنیم تا مسیر عمومی جدیدی برای آزمون/سوءاستفاده باز نشود.
const setupLimiter = createRateLimiter({
  name: 'راه‌اندازی اولیه',
  windowMs: 15 * 60 * 1000,
  max: config.rateLimit.login,
  maxKeys: config.rateLimit.maxKeys,
});

export const authRouter = express.Router();

/**
 * وضعیت راه‌اندازی اولیه برای صفحهٔ ورود. پاسخ هیچ راز یا هشی ندارد و فقط
 * می‌گوید آیا هنوز حسابی ساخته نشده است.
 */
authRouter.get('/setup', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ required: initialSetupRequired(), passwordPolicy: describePasswordPolicy(AUTH) });
});

/**
 * ساخت نخستین مدیر از ورودی کاربر. این مسیر فقط وقتی کار می‌کند که جدول
 * کاربران خالی باشد؛ پس از ساخت، خودکار وارد می‌شود (همان نشست/CSRF امن).
 */
authRouter.post('/setup', setupLimiter, (req, res) => {
  const username = String(req.body?.username || '').trim().slice(0, 64);
  const password = String(req.body?.password ?? '');
  const confirmPassword = String(req.body?.confirmPassword ?? '');
  if (!username || !password || !confirmPassword) {
    return res.status(400).json({ error: 'نام کاربری، رمز عبور و تکرار رمز عبور الزامی است.' });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'رمز عبور و تکرار آن باید یکسان باشند.' });
  }
  if (password.length > MAX_PASSWORD) {
    return res.status(400).json({ error: 'رمز عبور بیش از حد طولانی است.' });
  }
  let user;
  try {
    user = createInitialAdmin({ username, password, confirmPassword });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(e.status || 500).json({ error: e.status ? e.message : 'ساخت حساب مدیر ناموفق بود.' });
  }
  const role = normalizeRole(user.role);
  req.auditActor = { id: user.id, username: user.username, role };
  // Session Fixation: نشست پیش از راه‌اندازی (اگر وجود داشته باشد) باطل و با
  // توکن تازه جایگزین می‌شود.
  destroySessionFromRequest(req);
  createSession(user.id, req, res);
  logEvent('info', 'auth_setup_completed', { username: user.username, ip: clientIp(req) });
  res.setHeader('Cache-Control', 'no-store');
  return res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
});

/**
 * یک پیام و یک کد برای همهٔ حالت‌های شکست ورود. افشای «حساب وجود ندارد»،
 * «رمز غلط است» یا «حساب قفل است» به مهاجم می‌گوید کدام نام کاربری معتبر است.
 */
const LOGIN_FAILED_MESSAGE = 'نام کاربری یا رمز عبور نادرست است.';

function loginFailure(res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(401).json({ error: LOGIN_FAILED_MESSAGE });
}

/**
 * ثبت تلاش ناموفق و قفل موقت حساب پس از سقف تنظیم‌شده. شمارنده در پایگاه‌داده
 * است تا با ری‌استارت سرور یا چند نمونه، دور زده نشود. قفل خودکار پس از
 * NETWATCH_LOGIN_LOCKOUT_MINUTES برداشته می‌شود؛ مدیر هم می‌تواند از مسیر
 * unlock آن را صریحاً باز کند.
 */
function recordLoginFailure(row, req) {
  if (!row) return null;
  const now = Date.now();
  // شمارش اتمیک: دو تلاش هم‌زمان نباید یک شمارنده را از دست بدهند. قفل فقط
  // وقتی فعال می‌شود که به آستانه برسیم؛ تا وقتی قفل باز است این تابع صدا
  // زده نمی‌شود و زمان قفل بی‌نهایت تمدید نمی‌شود.
  db.prepare(
    `UPDATE users
        SET failed_login_count = failed_login_count + 1,
            locked_until = CASE WHEN failed_login_count + 1 >= ? THEN ? ELSE locked_until END
      WHERE id = ?`
  ).run(AUTH.loginMaxFailures, now + AUTH.loginLockoutMs, row.id);
  const fresh = db.prepare('SELECT failed_login_count, locked_until FROM users WHERE id = ?').get(row.id);
  const count = Number(fresh?.failed_login_count || 1);
  const lockedUntil = fresh?.locked_until || null;
  logEvent('warn', 'auth_login_failed', {
    username: String(row.username).slice(0, 32),
    ip: clientIp(req),
    failures: count,
    locked: Boolean(lockedUntil),
  });
  if (lockedUntil) logEvent('warn', 'auth_account_locked', { username: row.username, until: lockedUntil, ip: clientIp(req) });
  return lockedUntil;
}

authRouter.post('/login', loginLimiter, (req, res) => {
  const username = String(req.body?.username || '').trim().slice(0, 64);
  const password = String(req.body?.password || '');
  if (!username || !password || password.length > MAX_PASSWORD) {
    return res.status(400).json({ error: 'نام کاربری و رمز عبور الزامی است.' });
  }
  const row = findUserByUsername(username);
  const now = Date.now();
  const locked = Boolean(row?.locked_until && Number(row.locked_until) > now);
  // حتی وقتی کاربر وجود ندارد یا حساب قفل است، یک Argon2id اجرا می‌شود تا زمان
  // پاسخ، وجود/قفل‌بودن نام کاربری را لو ندهد.
  const ok = verifyPassword(password, row ? row.password_hash : DUMMY_HASH);
  if (!row || !ok || row.disabled || locked) {
    // قفل فعال، رمز صحیح را هم نمی‌پذیرد؛ در غیر این صورت قفل معنایی نداشت.
    if (row && !ok && !row.disabled && !locked) recordLoginFailure(row, req);
    else if (locked) logEvent('warn', 'auth_login_locked_rejected', { username: String(row.username).slice(0, 32), ip: clientIp(req) });
    else if (row && row.disabled) logEvent('warn', 'auth_login_disabled_rejected', { username: String(row.username).slice(0, 32), ip: clientIp(req) });
    return loginFailure(res);
  }
  const role = normalizeRole(row.role);
  if (!role) {
    logEvent('error', 'auth_unknown_role', { username: row.username, role: row.role });
    return res.status(403).json({ error: 'نقش این حساب معتبر نیست؛ با مدیر سامانه تماس بگیرید.' });
  }
  // ارتقای شفاف هش قدیمی (scrypt یا Argon2id با پارامتر ضعیف‌تر) در نخستین ورود موفق
  if (needsRehash(row.password_hash)) {
    try {
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hashPassword(password), now, row.id);
    } catch (e) {
      logEvent('warn', 'auth_rehash_failed', { username: row.username, message: e.message });
    }
  }
  db.prepare('UPDATE users SET last_login_at = ?, failed_login_count = 0, locked_until = NULL WHERE id = ?').run(now, row.id);
  // Session Fixation: هر نشستی که مرورگر پیش از ورود داشته، باطل و با توکن
  // تازه جایگزین می‌شود. توکن ورودی از کوکی خوانده می‌شود، نه از بدنه.
  const rotated = destroySessionFromRequest(req);
  createSession(row.id, req, res);
  // فایل رمز بوت‌استرپ نسخه‌های قدیمی پس از نخستین ورود مدیر حذف می‌شود.
  if (role === 'admin') removeLegacyBootstrapPasswordFile();
  req.auditActor = { id: row.id, username: row.username, role };
  logEvent('info', 'auth_login', { username: row.username, role, ip: clientIp(req), rotated: rotated > 0 });
  res.setHeader('Cache-Control', 'no-store');
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(row.id);
  return res.json({ user: publicUser(fresh) });
});

authRouter.post('/logout', (req, res) => {
  const cookies = parseCookies(req.get('cookie') || '');
  destroySession(cookies[SESSION_COOKIE]);
  clearSessionCookies(req, res);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true });
});

// خروج از همهٔ دستگاه‌ها: پس از تغییر رمز یا گم‌شدن دستگاه، کاربر می‌تواند
// همهٔ نشست‌های خودش را باطل کند. CSRF و احراز هویت روی همین مسیر اعمال می‌شود.
authRouter.post('/logout-all', (req, res) => {
  const revoked = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id).changes;
  clearSessionCookies(req, res);
  logEvent('info', 'auth_logout_all', { username: req.user.username, revoked });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, revoked });
});

authRouter.get('/me', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!req.user) return res.status(401).json({ error: 'نشست معتبری وجود ندارد.' });
  const role = normalizeRole(req.user.role) || 'viewer';
  res.json({
    user: { ...req.user, role, roleLabel: ROLE_LABELS[role], permissions: permissionsForRole(role) },
  });
});

/* ------------------------- مدیریت کاربران ------------------------- */

// فقط Administrator؛ Operator و Viewer به این بخش دسترسی ندارند.
const manageUsers = requirePermission('users:manage');

authRouter.get('/users', manageUsers, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    items: listUsers().map(publicUser),
    roles: Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label })),
    // سیاست رمز برای نمایش در رابط مدیریت کاربران؛ هیچ راز/هشی در آن نیست.
    passwordPolicy: describePasswordPolicy(AUTH),
  });
});

authRouter.post('/users', manageUsers, (req, res) => {
  try {
    const user = createUser({
      username: req.body?.username,
      password: req.body?.password,
      role: req.body?.role ?? 'viewer',
      displayName: req.body?.displayName,
    });
    logEvent('info', 'auth_user_created', { username: user.username, role: user.role, by: req.user.username });
    res.status(201).json(user);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'ساخت کاربر ناموفق بود.' });
  }
});

authRouter.put('/users/:id', manageUsers, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'کاربر یافت نشد.' });
  const role = req.body?.role === undefined ? normalizeRole(row.role) : normalizeRole(req.body.role);
  if (!role) return res.status(400).json({ error: 'نقش نامعتبر است؛ نقش‌های مجاز: admin، operator، viewer.' });
  const disabled = req.body?.disabled === undefined ? row.disabled : req.body.disabled ? 1 : 0;
  // آخرین مدیر فعال نباید تنزل یا غیرفعال شود؛ وگرنه سامانه بی‌مدیر می‌ماند.
  const admins = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND disabled=0").get().c;
  const losesAdmin = normalizeRole(row.role) === 'admin' && !row.disabled && (role !== 'admin' || disabled === 1);
  if (losesAdmin && admins <= 1) return res.status(400).json({ error: 'تنها مدیر فعال سامانه را نمی‌توان تنزل داد یا غیرفعال کرد.' });
  let passwordHash = row.password_hash;
  let passwordChangedAt = row.password_changed_at || null;
  if (req.body?.password !== undefined && req.body?.password !== '') {
    try {
      assertPassword(req.body.password, { username: row.username, policy: AUTH });
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    passwordHash = hashPassword(req.body.password);
    passwordChangedAt = Date.now();
  }
  // تغییر نقش/رمز و باطل‌کردن نشست‌ها یک عملیات امنیتی است: اگر تغییر نقش
  // ثبت شود ولی نشست‌های قبلی باقی بمانند، کاربر با مجوز قدیمی به کار ادامه
  // می‌دهد. پس هر دو در یک تراکنش انجام می‌شوند.
  transaction(
    () => {
      db.prepare(
        'UPDATE users SET role=?, disabled=?, password_hash=?, display_name=?, updated_at=?, password_changed_at=?, failed_login_count=0, locked_until=NULL WHERE id=?'
      ).run(
        role,
        disabled,
        passwordHash,
        String(req.body?.displayName ?? row.display_name ?? '').slice(0, 80),
        Date.now(),
        passwordChangedAt,
        id
      );
      if (disabled || req.body?.password) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    },
    { label: 'auth.user.update' }
  );
  logEvent('info', 'auth_user_updated', { username: row.username, role, disabled: Boolean(disabled), by: req.user.username });
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
});

/** رفع دستی قفل حساب؛ Recovery رسمی بدون انتظار برای انقضای خودکار */
authRouter.post('/users/:id/unlock', manageUsers, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'کاربر یافت نشد.' });
  db.prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?').run(Date.now(), id);
  logEvent('info', 'auth_user_unlocked', { username: row.username, by: req.user.username });
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
});

authRouter.delete('/users/:id', manageUsers, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'کاربر یافت نشد.' });
  if (id === req.user.id) return res.status(400).json({ error: 'حساب خودتان را نمی‌توانید حذف کنید.' });
  const admins = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND disabled=0").get().c;
  if (normalizeRole(row.role) === 'admin' && admins <= 1) return res.status(400).json({ error: 'آخرین مدیر سامانه قابل حذف نیست.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  logEvent('info', 'auth_user_deleted', { username: row.username, by: req.user.username });
  res.json({ deleted: 1 });
});

export const authConstants = {
  SESSION_COOKIE,
  CSRF_COOKIE,
  SESSION_TTL_MS,
  SESSION_IDLE_MS,
  MIN_PASSWORD,
  MAX_PASSWORD,
  ALL_PERMISSIONS,
};

let pruneTimer = null;
/** هر ساعت نشست‌های منقضی پاک می‌شوند تا جدول sessions رشد نکند */
export function startSessionSweeper() {
  if (pruneTimer) return pruneTimer;
  pruneSessions();
  pruneTimer = setInterval(() => pruneSessions(), 3600 * 1000);
  if (pruneTimer.unref) pruneTimer.unref();
  return pruneTimer;
}

/** آزادسازی تایمر پاک‌سازی نشست‌ها هنگام خاموشی سرور */
export function stopSessionSweeper() {
  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = null;
}

/** آزادسازی تایمر پاک‌سازی لیمیترهای ورود/راه‌اندازی */
export function closeAuthLimiters() {
  loginLimiter.close?.();
  setupLimiter.close?.();
}

export default {
  authRouter,
  attachUser,
  requireAuth,
  csrfGuard,
  createInitialAdmin,
  initialSetupRequired,
  startSessionSweeper,
  stopSessionSweeper,
  closeAuthLimiters,
  hashPassword,
  verifyPassword,
  createSession,
  parseCookies,
  authConstants,
};
