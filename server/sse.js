/**
 * NetWatch — مرکز رویدادهای زنده (SSE) با مدیریت فشار برگشتی
 * ----------------------------------------------------------------
 * پیش از این، هر رویداد مستقیماً روی هر اتصال نوشته می‌شد و نتیجهٔ `write`
 * بررسی نمی‌شد. اگر کلاینتی کند باشد (تب خواب‌رفته، شبکهٔ بی‌کیفیت)، بافر
 * سوکت Node بی‌مرز رشد می‌کرد و حافظهٔ سرور را می‌خورد. این ماژول:
 *
 *   • رویدادهای «قابل‌جایگزینی» (نمونه‌ها/وضعیت) را برای کلاینتی که هنوز
 *     بافرِ قبلی‌اش تخلیه نشده نمی‌فرستد — آخرین وضعیت مهم است، نه هر فریم.
 *   • رویدادهای مهم (هشدار و رفع هشدار) را می‌فرستد، اما اگر بافر کلاینت از
 *     سقف بگذرد، اتصال را می‌بندد تا حافظه آزاد شود.
 *   • آمار (تعداد کلاینت، فریم‌های حذف‌شده، کلاینت‌های قطع‌شده) را برای /health
 *     و لاگ ساختاریافته نگه می‌دارد.
 */
import { logEvent } from './logger.mjs';

const DEFAULT_MAX_BUFFER = 1024 * 1024; // ۱ مگابایت بافر برای هر کلاینت

export function createSseHub({
  maxClients = Number(process.env.NETWATCH_SSE_MAX || 32),
  maxBufferedBytes = Number(process.env.NETWATCH_SSE_MAX_BUFFER || DEFAULT_MAX_BUFFER),
  heartbeatMs = Number(process.env.NETWATCH_SSE_HEARTBEAT_MS || 25000),
} = {}) {
  const clients = new Set();
  const stats = { clients: 0, peak: 0, droppedClients: 0, skippedFrames: 0, deliveredFrames: 0 };

  const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  function remove(client, reason) {
    if (!clients.has(client)) return;
    clearInterval(client.heartbeat);
    clients.delete(client);
    try {
      client.res.end?.();
    } catch {
      /* بی‌اثر */
    }
    stats.clients = clients.size;
    if (reason) {
      stats.droppedClients += 1;
      logEvent('warn', 'sse_client_dropped', {
        reason,
        bufferedBytes: Number(client.res.writableLength) || 0,
        clients: clients.size,
      });
    }
  }

  /** ارسال یک فریم؛ در فشار برگشتی، فریم‌های غیرمهم حذف می‌شوند */
  function send(client, payload, { critical = false } = {}) {
    if (!clients.has(client)) return false;
    if (client.backpressured && !critical) {
      client.skipped += 1;
      stats.skippedFrames += 1;
      return false;
    }
    let ok;
    try {
      ok = client.res.write(payload) !== false;
    } catch {
      remove(client, 'write_error');
      return false;
    }
    client.backpressured = !ok;
    if (ok) stats.deliveredFrames += 1;
    // نوشتن ناموفق یعنی بافر سوکت پر است؛ اگر از سقف گذشته باشد، این کلاینت
    // دیگر ارزش نگه‌داشتن ندارد (وگرنه کل حافظهٔ سرور را می‌بلعد).
    if (!ok && (Number(client.res.writableLength) || 0) > maxBufferedBytes) {
      remove(client, 'buffer_limit');
      return false;
    }
    return true;
  }

  /**
   * ثبت یک اتصال SSE. اگر ظرفیت پر باشد null برمی‌گرداند (پاسخ ۵۰۳ با
   * مسؤولیت فراخوان).
   */
  function add(req, res, helloEvent = null) {
    if (clients.size >= maxClients) return null;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const client = { res, backpressured: false, skipped: 0, heartbeat: null };
    clients.add(client);
    stats.clients = clients.size;
    stats.peak = Math.max(stats.peak, clients.size);

    // تخلیهٔ بافر (رویداد drain) یعنی می‌توان دوباره رویدادهای عادی فرستاد
    res.on?.('drain', () => {
      client.backpressured = false;
    });
    const drop = () => remove(client, null);
    req.on('close', drop);
    req.on('error', drop);
    res.on('error', () => remove(client, 'socket_error'));

    if (helloEvent) send(client, frame('hello', helloEvent), { critical: true });
    client.heartbeat = setInterval(() => send(client, ': ping\n\n', { critical: false }), heartbeatMs);
    if (client.heartbeat.unref) client.heartbeat.unref();
    return client;
  }

  function broadcast(event, data, { critical = false } = {}) {
    if (!clients.size) return 0;
    const payload = frame(event, data);
    let sent = 0;
    for (const client of [...clients]) {
      if (send(client, payload, { critical })) sent += 1;
    }
    return sent;
  }

  function closeAll() {
    for (const client of [...clients]) remove(client, null);
  }

  return {
    add,
    broadcast,
    closeAll,
    get size() {
      return clients.size;
    },
    stats: () => ({ ...stats, clients: clients.size }),
  };
}

export default createSseHub;
