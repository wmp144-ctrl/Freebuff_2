/**
 * NetWatch — دروازهٔ «آخرین درخواست برنده است»
 * ----------------------------------------------------------------
 * هر بار که وابستگی‌های یک صفحه تغییر می‌کند یا درخواست تازه‌ای شروع
 * می‌شود، درخواست قبلی لغو و نتیجه‌اش نامعتبر می‌شود. این کار جلوی
 * Race Condition کلاسیک را می‌گیرد: پاسخ کندِ درخواست قدیمی دیگر نمی‌تواند
 * دادهٔ تازه‌تر را بازنویسی کند.
 *
 * این ماژول عمداً بدون وابستگی به React/DOM نوشته شده تا مستقل آزمون شود.
 */

export interface GateTicket {
  /** شمارهٔ یکتای این درخواست */
  readonly id: number;
  /** سیگنالی که با شروع درخواست بعدی (یا abort دستی) لغو می‌شود */
  readonly signal: AbortSignal;
  /** آیا این بلیت هنوز جدیدترین درخواست است؟ */
  isCurrent(): boolean;
}

export class LatestRequestGate {
  private seq = 0;
  private controller: AbortController | null = null;

  begin(): GateTicket {
    // درخواست قبلی بی‌فایده است؛ هم لغو می‌شود و هم با افزایش seq نتیجه‌اش دور ریخته می‌شود
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const id = ++this.seq;
    return {
      id,
      signal: controller.signal,
      isCurrent: () => id === this.seq,
    };
  }

  /** لغو درخواست جاری و بی‌اعتبار کردن نتایج آن (مثلاً هنگام Unmount) */
  abort(): void {
    this.controller?.abort();
    this.controller = null;
    this.seq += 1;
  }

  get currentId(): number {
    return this.seq;
  }
}

/** تشخیص خطای لغو (AbortError) در مرورگر و Node */
export function isAbortError(error: unknown): boolean {
  if (!error) return false;
  const e = error as { name?: string; code?: string; aborted?: boolean };
  return e.aborted === true || e.name === 'AbortError' || e.code === 'ABORTED';
}

/** پیام یک خطای ناشناخته را به متن قابل‌نمایش تبدیل می‌کند */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'خطای نامشخص';
}
