/**
 * NetWatch — لایه ارسال Ping
 * ----------------------------------------------------------------
 * سه روش بررسی در دسترس است:
 *   1) icmp  : استفاده از ابزار سیستمی ping (بدون نیاز به اینترنت؛ صرفاً ICMP در شبکه محلی)
 *   2) tcp   : اتصال TCP به یک پورت مشخص (زمانی که RAW socket مجاز نیست)
 *   3) simulate : تولید داده‌های واقع‌نما برای دمو/آموزش
 */
import { spawn } from 'node:child_process';
import net from 'node:net';

const IS_WINDOWS = process.platform === 'win32';

let icmpCapable = null; // null = نامشخص

/** بررسی یک‌باره‌ی امکان استفاده از ICMP (ping سیستمی) */
export function probeIcmp() {
  return new Promise((resolve) => {
    if (icmpCapable !== null) return resolve(icmpCapable);
    const args = IS_WINDOWS ? ['-n', '1', '-w', '1200', '127.0.0.1'] : ['-c', '1', '-W', '2', '127.0.0.1'];
    const child = spawn('ping', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const done = (capable) => {
      icmpCapable = capable;
      resolve(capable);
    };
    child.on('error', () => done(false));
    child.on('close', (code) => {
      const blocked = /operation not permitted|missing cap|socket: /i.test(out);
      done(!blocked && code === 0);
    });
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
    }, 4000);
  });
}

export function icmpStatus() {
  return icmpCapable;
}

function parseLatencies(text) {
  const res = [];
  const re = /time[=<]\s*([\d.]+)\s*ms/gi;
  let m;
  while ((m = re.exec(text))) res.push(parseFloat(m[1]));
  return res;
}

/**
 * اجرای ICMP Ping با ابزار سیستمی
 * @returns {Promise<{ok:boolean, rtt:number|null, packetsSent:number, packetsRecv:number, lossPct:number, mode:string, error?:string}>}
 */
export function icmpPing(host, { timeoutMs = 1200, count = 3 } = {}) {
  return new Promise((resolve) => {
    const args = IS_WINDOWS
      ? ['-n', String(count), '-w', String(timeoutMs), host]
      : ['-c', String(count), '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), '-i', '0.2', host];
    const child = spawn('ping', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let finished = false;
    const finish = (payload) => {
      if (finished) return;
      finished = true;
      resolve(payload);
    };
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('error', (e) =>
      finish({ ok: false, rtt: null, packetsSent: count, packetsRecv: 0, lossPct: 100, mode: 'icmp', error: e.message })
    );
    child.on('close', (code) => {
      const times = parseLatencies(out);
      const sentMatch = out.match(/(\d+)\s+(?:packets )?transmitted/i);
      const recvMatch = out.match(/(\d+)\s+(?:packets )?(?:received|تم دریافت)/i);
      const sent = sentMatch ? parseInt(sentMatch[1], 10) : count;
      const recv = recvMatch ? parseInt(recvMatch[1], 10) : times.length;
      const loss = sent ? Math.round(((sent - recv) / sent) * 1000) / 10 : recv ? 0 : 100;
      if (/operation not permitted|missing cap|socket:/i.test(out) && code !== 0) {
        icmpCapable = false;
        return finish({
          ok: false,
          rtt: null,
          packetsSent: sent,
          packetsRecv: 0,
          lossPct: 100,
          mode: 'icmp',
          error: 'ICMP_BLOCKED',
        });
      }
      const rtt = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
      finish({
        ok: code === 0 && recv > 0,
        rtt: rtt == null ? null : Math.round(rtt * 100) / 100,
        packetsSent: sent,
        packetsRecv: recv,
        lossPct: loss,
        mode: 'icmp',
        error: code === 0 ? undefined : 'TIMEOUT',
      });
    });
    const hardLimit = timeoutMs * count + 2500;
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish({ ok: false, rtt: null, packetsSent: count, packetsRecv: 0, lossPct: 100, mode: 'icmp', error: 'HARD_TIMEOUT' });
    }, hardLimit);
  });
}

/** اندازه‌گیری زمان اتصال TCP به یک پورت */
export function tcpPing(host, { port = 80, timeoutMs = 1200, count = 1 } = {}) {
  const attempt = () =>
    new Promise((resolve) => {
      const started = process.hrtime.bigint();
      const socket = new net.Socket();
      let settled = false;
      const done = (ok, error) => {
        if (settled) return;
        settled = true;
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        socket.destroy();
        resolve({ ok, rtt: ok ? Math.round(ms * 100) / 100 : null, error });
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false, 'TIMEOUT'));
      socket.once('error', (e) => done(false, e.code || 'ERROR'));
      try {
        socket.connect(port, host);
      } catch (e) {
        done(false, e.code || 'ERROR');
      }
    });

  return (async () => {
    const n = Math.max(1, count);
    let recv = 0;
    const times = [];
    for (let i = 0; i < n; i++) {
      const r = await attempt();
      if (r.ok) {
        recv++;
        times.push(r.rtt);
      }
      if (i < n - 1) await new Promise((r) => setTimeout(r, 120));
    }
    const rtt = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
    return {
      ok: recv > 0,
      rtt: rtt == null ? null : Math.round(rtt * 100) / 100,
      packetsSent: n,
      packetsRecv: recv,
      lossPct: Math.round(((n - recv) / n) * 1000) / 10,
      mode: 'tcp',
      error: recv === 0 ? 'NO_RESPONSE' : undefined,
    };
  })();
}

export function isValidIp(ip) {
  if (typeof ip !== 'string') return false;
  const v = ip.trim();
  if (!v) return false;
  if (v.includes(':')) return /^[0-9a-fA-F:]+$/.test(v) && v.split(':').length <= 8; // IPv6 ساده
  const parts = v.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

export function isValidHost(value) {
  const v = String(value ?? '').trim();
  if (!v) return false;
  if (isValidIp(v)) return true;
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(v);
}
