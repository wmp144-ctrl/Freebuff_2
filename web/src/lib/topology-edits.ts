/**
 * پشتهٔ Undo/Redo ویرایش‌های توپولوژی
 * ----------------------------------------------------------------
 * هر ویرایش یک «فرمان» است که دو تابع معکوس دارد: `undo` و `redo`. خود
 * سرور مرجع نهایی است؛ این پشته فقط ترتیب عملیات را نگه می‌دارد و هیچ
 * داده‌ای را به‌صورت محلی «ذخیره‌شده» جا نمی‌زند.
 *
 * قاعده‌ها:
 *   • فرمان فقط پس از موفقیت API ثبت می‌شود.
 *   • اگر `undo` یا `redo` شکست بخورد، فرمان از پشته حذف نمی‌شود تا کاربر
 *     بتواند پس از رفع خطا دوباره تلاش کند.
 *   • هر ویرایش تازه، پشتهٔ Redo را پاک می‌کند (مثل ویرایشگرهای معمول).
 */

export interface EditCommand {
  /** برچسب کوتاه فارسی برای نمایش در راهنما/اعلان */
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

export class EditHistory {
  private undoStack: EditCommand[] = [];
  private redoStack: EditCommand[] = [];
  private readonly limit: number;

  constructor(limit = 40) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }

  get size(): number {
    return this.undoStack.length;
  }

  /** ثبت یک ویرایش موفق؛ پشتهٔ Redo پاک می‌شود. */
  push(command: EditCommand): void {
    this.undoStack.push(command);
    while (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  /** اجرای آخرین فرمان معکوس. در صورت خطا فرمان در پشته می‌ماند. */
  async undo(): Promise<string> {
    const command = this.undoStack[this.undoStack.length - 1];
    if (!command) throw new Error('عملیاتی برای واگرد وجود ندارد.');
    await command.undo();
    this.undoStack.pop();
    this.redoStack.push(command);
    return command.label;
  }

  /** اجرای دوبارهٔ آخرین فرمان واگردشده. در صورت خطا فرمان در پشته می‌ماند. */
  async redo(): Promise<string> {
    const command = this.redoStack[this.redoStack.length - 1];
    if (!command) throw new Error('عملیاتی برای ازنو وجود ندارد.');
    await command.redo();
    this.redoStack.pop();
    this.undoStack.push(command);
    return command.label;
  }

  /** پاک‌کردن کامل پشته (مثلاً هنگام بارگذاری دیاگرام یا خروج از حالت ویرایش) */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
