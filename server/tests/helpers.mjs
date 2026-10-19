/**
 * ابزار مشترک آزمون‌ها.
 *
 * هر فایل آزمون پیش از import کردن db.js، مسیر دادهٔ موقت خودش را تنظیم می‌کند
 * تا پایگاه‌دادهٔ واقعی پروژه هرگز لمس نشود. اجرای هر فایل در فرآیند جداگانه
 * (node --test) یعنی ماژول‌ها بین فایل‌ها به اشتراک گذاشته نمی‌شوند.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = path.resolve(SERVER_DIR, '..');

export function useTempDataDir(tag = 'test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `netwatch-${tag}-`));
  process.env.NETWATCH_DATA_DIR = dir;
  return dir;
}

export function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* بی‌اثر */
  }
}

/** نمونهٔ نتیجهٔ پروب برای جایگزینی engine.probe در آزمون‌ها */
export function probeResult(ok, extra = {}) {
  return {
    ok,
    rtt: ok ? 5 : null,
    packetsSent: 1,
    packetsRecv: ok ? 1 : 0,
    lossPct: ok ? 0 : 100,
    mode: 'test',
    error: ok ? undefined : 'TIMEOUT',
    ...extra,
  };
}

export function addDevice(db, overrides = {}) {
  const now = Date.now();
  const d = {
    name: `dev-${Math.random().toString(36).slice(2, 8)}`,
    ip: `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`,
    status: 'unknown',
    enabled: 1,
    monitoring_enabled: 1,
    ping_interval: 3600,
    next_check_at: 0,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  const cols = Object.keys(d);
  const res = db
    .prepare(`INSERT INTO devices(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => d[c]));
  return Number(res.lastInsertRowid);
}

export function deviceRow(db, id) {
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
}

/** یک پورت آزاد موقت برای اجرای سرور آزمون */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** حساب مدیر پیش‌فرض آزمون‌ها (سرور با همین رمز بالا می‌آید) */
export const TEST_ADMIN = { username: 'admin', password: 'test-admin-password-123' };

/** نشست‌های فعال هر سرور آزمون: base → { cookie, csrf, user } */
const sessions = new Map();

/** خواندن کوکی‌های Set-Cookie (چند مقدار برای یک نام، مثل نشست + CSRF) */
function cookiesFrom(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const pairs = list.map((c) => c.split(';')[0]);
  const csrf = pairs.find((p) => p.startsWith('nw_csrf='))?.slice('nw_csrf='.length) || '';
  return { cookie: pairs.join('; '), csrf };
}

/** ورود به سرور و نگه‌داشتن نشست برای درخواست‌های بعدی api() */
export async function login(base, username = TEST_ADMIN.username, password = TEST_ADMIN.password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => null);
  if (res.status !== 200) throw new Error(`login failed (${res.status}): ${data?.error || 'unknown'}`);
  const session = { ...cookiesFrom(res), user: data.user };
  sessions.set(base, session);
  return session;
}

/** نشست فعال یک سرور (برای آزمون‌هایی که هدرها را دستی می‌سازند) */
export function sessionFor(base) {
  return sessions.get(base) || null;
}

/**
 * اجرای سرور واقعی روی یک پایگاه‌دادهٔ موقت.
 * @returns {Promise<{base:string, child:import('node:child_process').ChildProcess, logs:()=>string, stop:()=>Promise<void>, session:object}>}
 */
export async function startServer({ dataDir, env = {}, port = null, engine = false } = {}) {
  const p = port || (await freePort());
  const base = `http://127.0.0.1:${p}`;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NETWATCH_DATA_DIR: dataDir,
      PORT: String(p),
      NETWATCH_ENGINE: engine ? '1' : '0',
      NETWATCH_ADMIN_USER: TEST_ADMIN.username,
      NETWATCH_ADMIN_PASSWORD: TEST_ADMIN.password,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => (logs += d.toString()));
  child.stderr.on('data', (d) => (logs += d.toString()));
  const stop = async () => {
    if (child.exitCode !== null) return child.exitCode;
    child.kill('SIGTERM');
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, 6000);
      child.once('exit', (c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
    return code;
  };
  const up = await waitFor(
    async () => {
      try {
        const res = await fetch(`${base}/api/health`);
        return res.status < 500;
      } catch {
        return false;
      }
    },
    { timeout: 20000 }
  );
  if (!up) {
    await stop();
    throw new Error(`server did not start:\n${logs}`);
  }
  // همهٔ آزمون‌ها با یک نشست مدیر کار می‌کنند؛ آزمون‌های امنیتی می‌توانند
  // درخواست بدون نشست را با fetch خام بسازند.
  const session = await login(base);
  return { base, child, port: p, logs: () => logs, stop, session };
}

/**
 * درخواست JSON با کنترل Origin و نشست مدیر.
 * با `auth: false` می‌توان درخواست بدون نشست ساخت (برای آزمون ۴۰۱/CSRF).
 */
export async function api(base, method, url, body, { origin = base, headers = {}, auth = true } = {}) {
  const session = auth ? sessions.get(base) : null;
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'GET' || method === 'HEAD' ? {} : { origin }),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* بدنهٔ غیر JSON */
  }
  return { status: res.status, data, headers: res.headers };
}

/**
 * درخواست multipart با نشست مدیر.
 * برای آزمون ورود Excel/CSV و بارگذاری MBTiles؛ بدنهٔ JSON نمی‌تواند فایل را
 * منتقل کند، اما همان گاردهای Origin/CSRF باید اعمال شوند.
 */
export async function upload(base, url, { filename, content, type = 'text/csv', fields = {}, method = 'POST' } = {}) {
  const session = sessions.get(base);
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  form.append('file', new Blob([content], { type }), filename);
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}),
      origin: base,
    },
    body: form,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* بدنهٔ غیر JSON */
  }
  return { status: res.status, data, headers: res.headers };
}

export async function waitFor(fn, { timeout = 5000, interval = 25 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) return null;
    await new Promise((r) => setTimeout(r, interval));
  }
}
