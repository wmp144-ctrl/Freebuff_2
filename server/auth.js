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
 *   • نخستین مدیر در راه‌اندازی اول ساخته می‌شود؛ رمز از
 *     NETWATCH_ADMIN_PASSWORD خوانده می‌شود و اگر تنظیم نشده باشد، یک رمز
 *     تصادفی یک‌بار در data/initial-admin-password.txt نوشته می‌شود.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { hashSync, verifySync } from '@node-rs/argon2';
import { db, DATA_DIR } from './db.js';
import { logEvent } from './logger.mjs';
import { createRateLimiter } from './rate-limit.js';
import { normalizeRole, permissionsForRole, ROLE_LABELS, requirePermission, ALL_PERMISSIONS } from './permissions.js';

const SESSION_COOKIE = 'nw_session';
const CSRF_COOKIE = 'nw_csrf';
const SESSION_TTL_MS = Math.max(1, Number(process.env.NETWATCH_SESSION_HOURS || 12)) * 3600 * 1000;
const ADMIN_PASSWORD_FILE = path.join(DATA_DIR, 'initial-admin-password.txt');
const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;
const MIN_PASSWORD = 8;
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
  return Boolean(req.secure) || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https';
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
    String(req.ip || '').slice(0, 64),
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

/** حذف نشست‌های منقضی؛ دوره‌ای از index.js هم صدا زده می‌شود */
export function pruneSessions(now = Date.now()) {
  try {
    return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes;
  } catch {
    return 0;
  }
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
    if (!row) return next();
    if (row.expires_at <= Date.now() || row.disabled) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
      return next();
    }
    // آخرین بازدید حداکثر هر ۶۰ ثانیه به‌روز می‌شود تا هر درخواست یک نوشتن
    // اضافه در WAL نسازد.
    if (Date.now() - row.last_seen_at > 60000) {
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(Date.now(), row.token_hash);
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
 * تنها مسیرهای عمومی: ورود و سلامت عمومی.
 * خروج و /auth/me نیازمند نشست‌اند تا خروج هم CSRF-محافظت شود.
 */
const PUBLIC_PATHS = new Set(['/health', '/auth/login']);

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
  if (req.path === '/auth/login') return next(); // هنوز نشستی برای سوءاستفاده وجود ندارد
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
    .prepare('SELECT id, username, role, display_name, disabled, created_at, updated_at, last_login_at FROM users ORDER BY id')
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
  };
}

function removeBootstrapPasswordFile() {
  try {
    if (fs.existsSync(ADMIN_PASSWORD_FILE)) fs.unlinkSync(ADMIN_PASSWORD_FILE);
  } catch {
    /* بی‌اثر */
  }
}

export function createUser({ username, password, role = 'viewer', displayName = '' }) {
  const name = String(username || '').trim();
  if (!USERNAME_RE.test(name)) {
    throw Object.assign(new Error('نام کاربری باید ۳ تا ۳۲ نویسهٔ لاتین، رقم، نقطه، خط تیره یا زیرخط باشد.'), { status: 400 });
  }
  if (String(password || '').length < MIN_PASSWORD || String(password || '').length > MAX_PASSWORD) {
    throw Object.assign(new Error(`رمز عبور باید بین ${MIN_PASSWORD} و ${MAX_PASSWORD} نویسه باشد.`), { status: 400 });
  }
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

/**
 * ساخت نخستین مدیر. اگر کاربری وجود داشته باشد کاری نمی‌کند.
 * رمز از env خوانده می‌شود؛ در غیر این صورت رمز تصادفی یک‌بار در فایل
 * (فقط برای مالک فایل) نوشته می‌شود تا اپراتور بتواند وارد شود.
 */
export function ensureInitialAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return { created: false };
  const username = String(process.env.NETWATCH_ADMIN_USER || 'admin').trim();
  let password = String(process.env.NETWATCH_ADMIN_PASSWORD || '');
  let generated = false;
  let passwordFile = null;
  if (!password) {
    password = crypto.randomBytes(12).toString('base64url');
    generated = true;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(ADMIN_PASSWORD_FILE, `${username}\n${password}\n`, { mode: 0o600 });
      fs.chmodSync(ADMIN_PASSWORD_FILE, 0o600);
      passwordFile = ADMIN_PASSWORD_FILE;
    } catch (e) {
      logEvent('error', 'admin_password_file_failed', { message: e.message });
    }
  }
  const user = createUser({ username, password, role: 'admin', displayName: 'مدیر سامانه' });
  logEvent('warn', 'admin_bootstrap', { username: user.username, generated, passwordFile });
  if (generated) {
    console.log(
      `\n  نخستین حساب مدیر ساخته شد: ${user.username}` +
        (passwordFile ? `\n  رمز یک‌بارمصرف در فایل ${passwordFile} ذخیره شد (پس از ورود آن را تغییر دهید).` : '\n  ساخت فایل رمز ناموفق بود؛ NETWATCH_ADMIN_PASSWORD را تنظیم و سرویس را دوباره اجرا کنید.')
    );
  }
  return { created: true, username: user.username, generated, passwordFile };
}

/* ------------------------------------------------------------------ */
/* مسیرهای /api/auth                                                   */
/* ------------------------------------------------------------------ */

// سقف نرخ ورود جداگانه و سخت‌گیرانه: ۱۰ تلاش در ۱۵ دقیقه برای هر IP.
// بدون این، رمز ۸ نویسه‌ای با حملهٔ آنلاین قابل حدس است.
const loginLimiter = createRateLimiter({
  name: 'ورود',
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.NETWATCH_LOGIN_RATE_LIMIT_MAX || 10),
});

export const authRouter = express.Router();

authRouter.post('/login', loginLimiter, (req, res) => {
  const username = String(req.body?.username || '').trim().slice(0, 64);
  const password = String(req.body?.password || '');
  if (!username || !password || password.length > MAX_PASSWORD) {
    return res.status(400).json({ error: 'نام کاربری و رمز عبور الزامی است.' });
  }
  const row = findUserByUsername(username);
  // حتی وقتی کاربر وجود ندارد، یک Argon2id اجرا می‌شود تا زمان پاسخ، وجود
  // نام کاربری را لو ندهد.
  const ok = verifyPassword(password, row ? row.password_hash : DUMMY_HASH);
  if (!row || !ok || row.disabled) {
    logEvent('warn', 'auth_login_failed', { username: username.slice(0, 32), ip: req.ip });
    return res.status(401).json({ error: 'نام کاربری یا رمز عبور نادرست است.' });
  }
  const role = normalizeRole(row.role);
  if (!role) {
    logEvent('error', 'auth_unknown_role', { username: row.username, role: row.role });
    return res.status(403).json({ error: 'نقش این حساب معتبر نیست؛ با مدیر سامانه تماس بگیرید.' });
  }
  const now = Date.now();
  // ارتقای شفاف هش قدیمی (scrypt یا Argon2id با پارامتر ضعیف‌تر) در نخستین ورود موفق
  if (needsRehash(row.password_hash)) {
    try {
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hashPassword(password), now, row.id);
    } catch (e) {
      logEvent('warn', 'auth_rehash_failed', { username: row.username, message: e.message });
    }
  }
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, row.id);
  createSession(row.id, req, res);
  // رمز یک‌بارمصرف فایل بوت‌استرپ پس از نخستین ورود مدیر حذف می‌شود.
  if (role === 'admin') removeBootstrapPasswordFile();
  req.auditActor = { id: row.id, username: row.username, role };
  logEvent('info', 'auth_login', { username: row.username, role, ip: req.ip });
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
  res.json({ items: listUsers().map(publicUser), roles: Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label })) });
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
  if (req.body?.password) {
    const length = String(req.body.password).length;
    if (length < MIN_PASSWORD || length > MAX_PASSWORD) {
      return res.status(400).json({ error: `رمز عبور باید بین ${MIN_PASSWORD} و ${MAX_PASSWORD} نویسه باشد.` });
    }
    passwordHash = hashPassword(req.body.password);
  }
  db.prepare('UPDATE users SET role=?, disabled=?, password_hash=?, display_name=?, updated_at=? WHERE id=?').run(
    role,
    disabled,
    passwordHash,
    String(req.body?.displayName ?? row.display_name ?? '').slice(0, 80),
    Date.now(),
    id
  );
  if (disabled || req.body?.password) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  logEvent('info', 'auth_user_updated', { username: row.username, role, disabled: Boolean(disabled), by: req.user.username });
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

export const authConstants = { SESSION_COOKIE, CSRF_COOKIE, SESSION_TTL_MS, MIN_PASSWORD, MAX_PASSWORD, ALL_PERMISSIONS };

let pruneTimer = null;
/** هر ساعت نشست‌های منقضی پاک می‌شوند تا جدول sessions رشد نکند */
export function startSessionSweeper() {
  if (pruneTimer) return pruneTimer;
  pruneSessions();
  pruneTimer = setInterval(() => pruneSessions(), 3600 * 1000);
  if (pruneTimer.unref) pruneTimer.unref();
  return pruneTimer;
}

export default {
  authRouter,
  attachUser,
  requireAuth,
  csrfGuard,
  ensureInitialAdmin,
  startSessionSweeper,
  hashPassword,
  verifyPassword,
  createSession,
  parseCookies,
  authConstants,
};
