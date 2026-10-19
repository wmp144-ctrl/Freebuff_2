/**
 * NetWatch — منطق خالص اتصال زنده (SSE)
 * ----------------------------------------------------------------
 * جدا کردن بافر و محاسبهٔ تأخیر اتصال مجدد از React، دو مزیت دارد:
 *   ۱) می‌توان آن را بدون مرورگر آزمون کرد.
 *   ۲) سقف حافظه و رفتار Backpressure صریح و قابل‌اندازه‌گیری است.
 */

export interface LiveSample {
  deviceId: number;
  ts: number;
  status: string;
  rtt: number | null;
  lossPct: number;
  ok: boolean;
  mode: string;
}

/**
 * بافر تازه‌ترین نمونهٔ هر تجهیز.
 *
 * فریم‌های SSE می‌توانند سریع‌تر از نرخ رندر React برسند. اگر هر فریم را در
 * یک آرایه جمع کنیم، بین دو Flush ممکن است هزاران ردیف تکراری برای یک تجهیز
 * انباشته شود. این‌جا برای هر تجهیز فقط آخرین نمونه نگه داشته می‌شود و کل
 * بافر هم سقف سخت دارد؛ پس حافظه هرگز بی‌مرز رشد نمی‌کند.
 */
export class LiveSampleBuffer {
  private readonly items = new Map<number, LiveSample>();
  private readonly max: number;

  constructor(max = 10000) {
    this.max = max;
  }

  push(samples: Iterable<LiveSample>): void {
    for (const sample of samples) {
      const id = Number(sample?.deviceId);
      if (!Number.isFinite(id)) continue;
      // حذف و درج دوباره، ترتیب LRU را نگه می‌دارد تا در سقف، قدیمی‌ترین برود
      this.items.delete(id);
      this.items.set(id, sample);
    }
    this.trim();
  }

  private trim(): void {
    while (this.items.size > this.max) {
      const oldest = this.items.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
  }

  /** همهٔ نمونه‌های تازه را برمی‌گرداند و بافر را خالی می‌کند */
  drain(): LiveSample[] {
    if (!this.items.size) return [];
    const out = [...this.items.values()];
    this.items.clear();
    return out;
  }

  get size(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }
}

export interface ReconnectOptions {
  baseMs?: number;
  maxMs?: number;
  /** نسبت جیتر (۰ تا ۱) برای پخش بار بین کلاینت‌ها */
  jitter?: number;
  /** تابع تصادف تزریق‌شدنی برای آزمون قطعی */
  random?: () => number;
}

/**
 * تأخیر اتصال مجدد با Backoff نمایی + Jitter.
 * تلاش ۰ → حدود ۱ ثانیه، تلاش ۵ → حدود ۳۲ ثانیه (سقف پیش‌فرض ۳۰ ثانیه).
 */
export function nextReconnectDelay(attempt: number, options: ReconnectOptions = {}): number {
  const base = options.baseMs ?? 1000;
  const max = options.maxMs ?? 30000;
  const jitter = Math.min(1, Math.max(0, options.jitter ?? 0.25));
  const random = options.random ?? Math.random;
  const safeAttempt = Math.max(0, Math.floor(Number(attempt) || 0));
  // 2 ** 40 مهار می‌شود تا محاسبه برای تلاش‌های بزرگ بی‌نهایت نشود
  const exp = Math.min(max, base * 2 ** Math.min(safeAttempt, 20));
  const factor = 1 - jitter + random() * jitter * 2;
  return Math.max(0, Math.round(Math.min(max, exp * factor)));
}
