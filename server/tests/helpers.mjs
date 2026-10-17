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

/**
 * اجرای سرور واقعی روی یک پایگاه‌دادهٔ موقت.
 * @returns {Promise<{base:string, child:import('node:child_process').ChildProcess, logs:()=>string, stop:()=>Promise<void>}>}
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
  return { base, child, port: p, logs: () => logs, stop };
}

/** درخواست JSON با کنترل Origin (پیش‌فرض: همان مبدأ) */
export async function api(base, method, url, body, { origin = base, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
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

export async function waitFor(fn, { timeout = 5000, interval = 25 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) return null;
    await new Promise((r) => setTimeout(r, interval));
  }
}
