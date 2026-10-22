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
export function probeIcmp({ signal = null } = {}) {
  return new Promise((resolve) => {
    if (icmpCapable !== null) return resolve(icmpCapable);
    const args = IS_WINDOWS ? ['-n', '1', '-w', '1200', '127.0.0.1'] : ['-c', '1', '-W', '2', '127.0.0.1'];
    const child = spawn('ping', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    // تایمر سخت باید در پایان آزاد شود؛ وگرنه برای هر فراخوانی (و در موتور با
    // صدها فراخوانی) یک تایمر زنده می‌ماند و حافظه/حلقهٔ رویداد اشغال می‌شود.
    let guard = null;
    let onAbort = null;
    const done = (capable) => {
      if (guard) clearTimeout(guard);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      icmpCapable = capable;
      resolve(capable);
    };
    child.on('error', () => done(false));
    child.on('close', (code) => {
      const blocked = /operation not permitted|missing cap|socket: /i.test(out);
      done(!blocked && code === 0);
    });
    guard = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
    }, 4000);
    if (signal) {
      if (signal.aborted) {
        try {
          child.kill('SIGKILL');
        } catch {}
        return done(false);
      }
      onAbort = () => {
        try {
          child.kill('SIGKILL');
        } catch {}
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
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
export function icmpPing(host, { timeoutMs = 1200, count = 3, signal = null } = {}) {
  return new Promise((resolve) => {
    const args = IS_WINDOWS
      ? ['-n', String(count), '-w', String(timeoutMs), host]
      : ['-c', String(count), '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), '-i', '0.2', host];
    const child = spawn('ping', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let finished = false;
    let hardTimer = null;
    let onAbort = null;
    const finish = (payload) => {
      if (finished) return;
      finished = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      // هر نتیجه‌ای که از ICMP می‌آید فقط «دسترسی شبکه» را می‌سنجد؛ سالم بودن
      // سرویس روی تجهیز از ICMP قابل استنتاج نیست.
      resolve({ ...payload, reachable: payload.ok === true, service: 'unknown', servicePort: null });
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
    hardTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish({ ok: false, rtt: null, packetsSent: count, packetsRecv: 0, lossPct: 100, mode: 'icmp', error: 'HARD_TIMEOUT' });
    }, hardLimit);
    if (signal) {
      if (signal.aborted) {
        try {
          child.kill('SIGKILL');
        } catch {}
        finish({ ok: false, rtt: null, packetsSent: count, packetsRecv: 0, lossPct: 100, mode: 'icmp', error: 'CANCELLED' });
      } else {
        onAbort = () => {
          try {
            child.kill('SIGKILL');
          } catch {}
          finish({ ok: false, rtt: null, packetsSent: count, packetsRecv: 0, lossPct: 100, mode: 'icmp', error: 'CANCELLED' });
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}

/**
 * اندازه‌گیری زمان اتصال TCP به یک پورت.
 *
 * تفکیک مهم (BUG-10): «اتصال موفق» یعنی پورت سرویس باز است؛ اما «رد شدن
 * اتصال» (ECONNREFUSED/RST) یعنی میزبان شبکه در دسترس است و فقط سرویس روی
 * آن پورت بالا نیست. پیش‌تر هر دو حالت «قطع» شمرده می‌شدند و سلامت شبکه با
 * سلامت سرویس قاطی می‌شد.
 *
 * خروجی:
 *   ok        → دسترسی شبکه (reachable)؛ بر همین مبنا وضعیت Online/Offline است
 *   reachable → آیا میزبان پاسخ شبکه‌ای داد (connect یا RST)
 *   service   → available | unavailable | unknown
 *   servicePort → پورتی که سنجیده شد
 */
export function tcpPing(host, { port = 80, timeoutMs = 1200, count = 1, signal = null } = {}) {
  const targetPort = Number.isInteger(Number(port)) && Number(port) >= 1 && Number(port) <= 65535 ? Number(port) : 80;
  const attempt = () =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve({ ok: false, reachable: false, error: 'CANCELLED' });
      const started = process.hrtime.bigint();
      const socket = new net.Socket();
      let settled = false;
      let onAbort = null;
      const done = (ok, error) => {
        if (settled) return;
        settled = true;
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        socket.destroy();
        // RST/ECONNREFUSED یعنی بستهٔ میزبان برگشته است؛ شبکه در دسترس است
        // ولی سرویس روی این پورت پذیرای اتصال نیست.
        const reachable = ok || error === 'ECONNREFUSED';
        resolve({ ok, reachable, rtt: ok ? Math.round(ms * 100) / 100 : null, error });
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false, 'TIMEOUT'));
      socket.once('error', (e) => done(false, e.code || 'ERROR'));
      if (signal) {
        onAbort = () => done(false, 'CANCELLED');
        signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        socket.connect(targetPort, host);
      } catch (e) {
        done(false, e.code || 'ERROR');
      }
    });

  return (async () => {
    const n = Math.max(1, count);
    let open = 0;
    let reachableCount = 0;
    const times = [];
    let lastError = null;
    for (let i = 0; i < n; i++) {
      const r = await attempt();
      if (r.ok) {
        open++;
        reachableCount++;
        times.push(r.rtt);
      } else if (r.reachable) {
        reachableCount++;
      }
      if (!r.ok) lastError = r.error;
      if (signal?.aborted) break;
      if (i < n - 1) await new Promise((r2) => setTimeout(r2, 120));
    }
    const rtt = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
    const reachable = reachableCount > 0;
    // `ok` همان معنای پیشین را دارد: هدفِ پایش (سرویس روی پورت) پاسخ داده است.
    // وضعیت Online/Offline و Uptime بر همین مبنا محاسبه می‌شود تا رفتار قبلی
    // حفظ شود؛ تفکیک «میزبان در دسترس است ولی سرویس بسته است» از طریق
    // reachable/service به لایهٔ بالاتر گزارش می‌شود.
    return {
      ok: open > 0,
      reachable,
      rtt: rtt == null ? null : Math.round(rtt * 100) / 100,
      packetsSent: n,
      packetsRecv: open,
      lossPct: Math.round(((n - open) / n) * 1000) / 10,
      mode: 'tcp',
      servicePort: targetPort,
      service: open > 0 ? 'available' : reachable ? 'unavailable' : 'unknown',
      error: open > 0 ? undefined : lastError === 'CANCELLED' ? 'CANCELLED' : reachable ? 'SERVICE_UNAVAILABLE' : 'NO_RESPONSE',
    };
  })();
}

/**
 * اعتبارسنجی IP با تجزیه‌گر خود Node.
 * اعتبارسنجی دستی قبلی رشته‌هایی مثل «:::» یا «12345::» را قبول می‌کرد و
 * آن‌ها به‌عنوان میزبان به فرمان ping می‌رسیدند.
 */
export function isValidIp(ip) {
  if (typeof ip !== 'string') return false;
  const v = ip.trim();
  if (!v || v.length > 45) return false;
  return net.isIP(v) > 0;
}

export function isValidHost(value) {
  const v = String(value ?? '').trim();
  if (!v) return false;
  if (isValidIp(v)) return true;
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(v);
}
