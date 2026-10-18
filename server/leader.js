/**
 * NetWatch — قفل رهبری موتور
 * ----------------------------------------------------------------
 * موتور می‌تواند داخل سرور یا به‌صورت `engine-cli` اجرا شود. اگر هر دو فعال
 * باشند، هر تجهیز دو بار Ping می‌خورد، نمونه‌ها دوتایی ثبت می‌شوند و پیام
 * «قطعی/بازگشت» ممکن است با فاصلهٔ میلی‌ثانیه دو بار ساخته شود. این ماژول یک
 * قفل سبک در پایگاه‌داده می‌گذارد تا فقط یک فرآیند در هر لحظه بررسی کند.
 *
 * ویژگی‌ها:
 *   • قفل با TTL: اگر فرآیند رهبر از کار بیفتد (kill -9، قطع برق)، پس از
 *     انقضا فرآیند دیگری می‌تواند قفل را بردارد؛ قفل «ابد» نمی‌ماند.
 *   • تمدید دوره‌ای: رهبر در هر چرخه TTL را تمدید می‌کند؛ اگر تمدید شکست
 *     بخورد (کسی قفل را گرفته)، بررسی‌ها فوراً متوقف می‌شوند.
 *   • یک دستور SQL اتمی: درج/تمدید فقط وقتی موفق است که قفل آزاد/منقضی باشد
 *     یا مالک همان فرآیند باشد؛ پس دو فرآیند هم‌زمان نمی‌توانند هر دو رهبر شوند
 *     (SQLite نوشتن را سریالی می‌کند).
 */
import crypto from 'node:crypto';
import { db } from './db.js';

export const LOCK_ID = 1;

const DEFAULT_TTL_MS = Math.max(1000, Number(process.env.NETWATCH_ENGINE_LOCK_TTL_MS || 15000));

export class LeaderLock {
  /**
   * @param {{ttlMs?:number, owner?:string}} options
   *        owner یکتا برای هر فرآیند/نمونه است تا دو نمونه در یک فرآیند هم
   *        با هم قفل نشوند.
   */
  constructor({ ttlMs = DEFAULT_TTL_MS, owner = null } = {}) {
    this.ttlMs = Math.max(50, Number(ttlMs) || DEFAULT_TTL_MS);
    this.owner = owner || `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    this.held = false;
    this.acquireStmt = db.prepare(
      `INSERT INTO engine_lock(id, owner, expires_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         owner = excluded.owner,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at
       WHERE engine_lock.owner = excluded.owner OR engine_lock.expires_at <= excluded.updated_at`
    );
    this.releaseStmt = db.prepare('DELETE FROM engine_lock WHERE id = ? AND owner = ?');
    this.readStmt = db.prepare('SELECT owner, expires_at, updated_at FROM engine_lock WHERE id = ?');
  }

  /** تلاش برای گرفتن/تمدید قفل. true یعنی این نمونه رهبر است. */
  tryAcquire(now = Date.now()) {
    const r = this.acquireStmt.run(LOCK_ID, this.owner, now + this.ttlMs, now);
    this.held = Number(r.changes) === 1;
    return this.held;
  }

  /**
   * تمدید قفل موجود. اگر مالکیت از دست رفته باشد false برمی‌گردد (مثلاً پس از
   * توقف طولانی فرآیند و برداشتن قفل توسط نمونهٔ دیگر).
   */
  renew(now = Date.now()) {
    if (!this.held) return false;
    const ok = this.tryAcquire(now);
    if (!ok) this.held = false;
    return ok;
  }

  /** آزادکردن قفل هنگام خاموش‌سازی تا نمونهٔ بعدی بی‌درنگ شروع کند */
  release() {
    if (!this.held) return 0;
    const n = this.releaseStmt.run(LOCK_ID, this.owner).changes;
    this.held = false;
    return Number(n) || 0;
  }

  /** مالک فعلی قفل (برای نمایش در /health و عیب‌یابی) */
  status(now = Date.now()) {
    const row = this.readStmt.get(LOCK_ID);
    if (!row) return { owner: null, expiresAt: null, active: false, mine: false };
    return {
      owner: row.owner,
      expiresAt: row.expires_at,
      active: row.expires_at > now,
      mine: row.owner === this.owner,
    };
  }
}

export default LeaderLock;
