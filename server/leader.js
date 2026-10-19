/**
 * NetWatch — قفل رهبری موتور با Fencing Token
 * ----------------------------------------------------------------
 * موتور می‌تواند داخل سرور یا به‌صورت `engine-cli` اجرا شود. اگر هر دو فعال
 * باشند، هر تجهیز دو بار Ping می‌خورد، نمونه‌ها دوتایی ثبت می‌شوند و پیام
 * «قطعی/بازگشت» ممکن است با فاصلهٔ میلی‌ثانیه دو بار ساخته شود. این ماژول یک
 * قفل سبک در پایگاه‌داده می‌گذارد تا فقط یک فرآیند در هر لحظه بررسی کند.
 *
 * Fencing Token:
 *   • شمارندهٔ یکتا و افزایشی در جدول `engine_meta` (کلید leader_epoch)
 *     نگهداری می‌شود. هر بار مالکیت قفل به دورهٔ رهبری تازه‌ای منتقل شود
 *     (شامل آزادسازی آگاهانه، انقضای Lease یا Crash)، یک واحد بالا می‌رود.
 *   • epoch در ردیف `engine_lock` هم کپی می‌شود تا وضعیت/عیب‌یابی یک‌جا دیده
 *     شود؛ منبع حقیقت برای یکتایی، جدول meta است تا حتی پس از حذف ردیف قفل
 *     (خاموشی تمیز) شمارنده هرگز تکرار نشود.
 *   • موتور در شروع هر عملیات epoch را نگه می‌دارد و پیش از ثبت نتیجه دوباره
 *     مالکیت/epoch/TTL را می‌خواند. اگر رهبری عوض شده باشد، نتیجه باطل می‌شود.
 *   • گرفتن قفل + افزایش epoch در یک تراکنش BEGIN IMMEDIATE انجام می‌شود؛ دو
 *     فرآیند هم‌زمان نمی‌توانند هر دو رهبر شوند.
 */
import crypto from 'node:crypto';
import { db, transaction } from './db.js';
import { config } from './config.js';

export const LOCK_ID = 1;
export const EPOCH_KEY = 'leader_epoch';

const DEFAULT_TTL_MS = Math.max(1000, Number(config.engine.lockTtlMs) || 15000);

export class LeaderLock {
  /**
   * @param {{ttlMs?:number, owner?:string}} options
   *        owner یکتا برای هر فرآیند/نمونه است تا دو نمونه در یک فرآیند هم
   *        با هم قفل نشوند.
   */
  constructor({ ttlMs = DEFAULT_TTL_MS, owner = null } = {}) {
    this.ttlMs = Math.max(1000, Number(ttlMs) || DEFAULT_TTL_MS);
    this.owner = owner || `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    this.held = false;
    /** epoch (fencing token) قفل در اختیار این نمونه؛ 0 یعنی رهبر نیست */
    this.epoch = 0;
    this.readStmt = db.prepare('SELECT owner, expires_at, updated_at, epoch FROM engine_lock WHERE id = ?');
    this.upsertStmt = db.prepare(
      `INSERT INTO engine_lock(id, owner, expires_at, updated_at, epoch) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         owner = excluded.owner,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at,
         epoch = excluded.epoch`
    );
    this.releaseStmt = db.prepare('DELETE FROM engine_lock WHERE id = ? AND owner = ? AND epoch = ?');
    this.bumpEpochStmt = db.prepare('UPDATE engine_meta SET value = value + 1 WHERE key = ?');
    this.readEpochStmt = db.prepare('SELECT value FROM engine_meta WHERE key = ?');
    this.initMetaStmt = db.prepare('INSERT OR IGNORE INTO engine_meta(key, value) VALUES (?, 0)');
  }

  currentEpoch() {
    this.initMetaStmt.run(EPOCH_KEY);
    return Number(this.readEpochStmt.get(EPOCH_KEY)?.value) || 0;
  }

  /**
   * گرفتن/تمدید قفل به‌صورت اتمی. epoch در همان تراکنش افزایش می‌یابد تا
   * حتی در رقابت دو فرآیند هم یکتا بماند.
   */
  tryAcquire(now = Date.now()) {
    try {
      return transaction(
        () => {
          const row = this.readStmt.get(LOCK_ID);
          const free = !row || row.expires_at <= now;
          const mine = row && row.owner === this.owner;
          if (!free && !mine) {
            this.held = false;
            this.epoch = 0;
            return false;
          }
          let epoch;
          if (mine) {
            epoch = Number(row.epoch) || 0;
          } else {
            // دورهٔ رهبری تازه: شمارندهٔ پایدار یک واحد بالا می‌رود
            this.initMetaStmt.run(EPOCH_KEY);
            const bumped = this.bumpEpochStmt.run(EPOCH_KEY).changes;
            epoch = Number(this.readEpochStmt.get(EPOCH_KEY)?.value) || 0;
            if (!bumped || epoch < 1) throw new Error('افزایش Fencing Token ناموفق بود.');
          }
          this.upsertStmt.run(LOCK_ID, this.owner, now + this.ttlMs, now, epoch);
          const saved = this.readStmt.get(LOCK_ID);
          if (!saved || saved.owner !== this.owner || Number(saved.epoch) !== epoch) {
            this.held = false;
            this.epoch = 0;
            return false;
          }
          this.held = true;
          this.epoch = epoch;
          return true;
        },
        { label: 'leader.acquire' }
      );
    } catch {
      this.held = false;
      this.epoch = 0;
      return false;
    }
  }

  /**
   * تمدید قفل موجود. اگر مالکیت از دست رفته باشد false برمی‌گردد (مثلاً پس از
   * توقف طولانی فرآیند و برداشتن قفل توسط نمونهٔ دیگر).
   */
  renew(now = Date.now()) {
    if (!this.held) return false;
    const epoch = this.epoch;
    const ok = this.tryAcquire(now);
    if (!ok) {
      this.held = false;
      return false;
    }
    // epoch همان مالک نباید تغییر کند؛ اگر کرد یعنی دورهٔ رهبری عوض شده است.
    if (this.epoch !== epoch) {
      this.held = false;
      return false;
    }
    return true;
  }

  /**
   * اعتبارسنجی یک epoch عملیات: مالک، epoch و TTL زنده باید مطابق باشند.
   * @param {number} [epoch] اگر داده نشود، epoch محلی بررسی می‌شود
   */
  verify(epoch = this.epoch, now = Date.now()) {
    if (!this.held) return false;
    const row = this.readStmt.get(LOCK_ID);
    if (!row) return false;
    if (row.owner !== this.owner) return false;
    if (Number(row.epoch) !== Number(epoch)) return false;
    if (Number(row.epoch) !== Number(this.epoch)) return false;
    if (Number(row.expires_at) <= now) return false;
    return true;
  }

  /** آزادکردن قفل هنگام خاموش‌سازی تا نمونهٔ بعدی بی‌درنگ شروع کند */
  release() {
    if (!this.held) return 0;
    // owner+epoch: فرآیند قدیمی نمی‌تواند قفل رهبر جدید را پاک کند.
    const n = this.releaseStmt.run(LOCK_ID, this.owner, this.epoch).changes;
    this.held = false;
    this.epoch = 0;
    return Number(n) || 0;
  }

  /** مالک فعلی قفل (برای نمایش در /health و عیب‌یابی) */
  status(now = Date.now()) {
    const row = this.readStmt.get(LOCK_ID);
    if (!row) {
      return { owner: null, expiresAt: null, active: false, mine: false, epoch: this.currentEpoch(), localEpoch: this.epoch };
    }
    return {
      owner: row.owner,
      expiresAt: row.expires_at,
      active: row.expires_at > now,
      mine: row.owner === this.owner,
      epoch: Number(row.epoch) || 0,
      localEpoch: this.epoch,
    };
  }
}

export default LeaderLock;
