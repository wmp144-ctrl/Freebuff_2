/**
 * NetWatch — سیاست زمان واحد
 * ----------------------------------------------------------------
 * همهٔ رکوردهای پایگاه‌داده، epoch میلی‌ثانیهٔ UTC هستند و مقایسه/مرتب‌سازی
 * آن‌ها مستقل از منطقهٔ زمانی است. برای اینکه «عقب‌رفتن ساعت سیستم» باعث
 * نمونه‌های با زمان نزولی، مدت قطعی منفی یا ترتیب نامعقول رخدادها نشود:
 *
 *   • `monotonicNow()` هرگز زمانی کوچک‌تر از آخرین زمانِ صادرشده برنمی‌گرداند.
 *   • `observeClock()` آخرین ساعت دیوار را در `runtime_state` نگه می‌دارد و
 *     جهش بزرگ به عقب را یک‌بار در Audit/رویداد ثبت می‌کند.
 *
 * توجه: این ماژول ساعت را «اصلاح» نمی‌کند؛ فقط یکنواختی ترتیب داده را تضمین
 * می‌کند و اختلاف را قابل‌مشاهده می‌سازد. تغییر ساعت به جلو نیز به‌عنوان یک
 * جهش در گزارش ثبت می‌شود (داده‌ها معتبر می‌مانند).
 */
import fs from 'node:fs';
import { db } from './db.js';
import { logEvent } from './logger.mjs';

const KEY = 'clock.last_seen';
const BACKWARD_TOLERANCE_MS = 60000;
const FORWARD_TOLERANCE_MS = 24 * 3600 * 1000;

let lastMonotonic = 0;
let lastWarnAt = 0;

/**
 * زمان یکنوای میلی‌ثانیه‌ای. اگر ساعت سیستم عقب رفته باشد، مقدار قبلی
 * برگردانده می‌شود تا رکورد جدید «گذشته» ثبت نشود.
 */
export function monotonicNow() {
  const real = Date.now();
  if (real < lastMonotonic) {
    if (real < lastMonotonic - BACKWARD_TOLERANCE_MS && Date.now() - lastWarnAt > 300000) {
      lastWarnAt = Date.now();
      logEvent('warn', 'clock_backwards_detected', { real, monotonic: lastMonotonic, skewMs: lastMonotonic - real });
    }
    return lastMonotonic;
  }
  lastMonotonic = real;
  return real;
}

const stateStmt = {
  get: db.prepare('SELECT value, updated_at FROM runtime_state WHERE key = ?'),
  put: db.prepare(
    'INSERT INTO runtime_state(key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ),
};

/**
 * ثبت مشاهدهٔ ساعت در وضعیت پایدار.
 * @param {number} [now]
 * @returns {{skewMs:number, direction:string|null, previous:number|null}}
 */
export function observeClock(now = Date.now()) {
  let previous = null;
  try {
    const row = stateStmt.get.get(KEY);
    if (row) previous = Number(row.value);
    stateStmt.put.run(KEY, String(now), now);
  } catch {
    /* وضعیت ساعت نباید مسیر اصلی را بشکند */
  }
  if (!previous) return { skewMs: 0, direction: null, previous: null };
  const skew = now - previous;
  let direction = null;
  if (skew < -BACKWARD_TOLERANCE_MS) direction = 'backward';
  else if (skew > FORWARD_TOLERANCE_MS) direction = 'forward';
  if (direction) {
    logEvent('warn', 'clock_jump_detected', { direction, skewMs: skew, previous, now });
  }
  return { skewMs: skew, direction, previous };
}

/** پاک‌سازی فایل‌های موقت قدیمی (کمکی برای اسکریپت‌های عملیاتی) */
export function removeStaleTempFiles(dir, prefix, olderThanMs = 7 * 86400000) {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const full = `${dir}/${name}`;
      const st = fs.statSync(full);
      if (now - st.mtimeMs > olderThanMs) fs.rmSync(full, { force: true, recursive: true });
    }
  } catch {
    /* بی‌اثر */
  }
}
