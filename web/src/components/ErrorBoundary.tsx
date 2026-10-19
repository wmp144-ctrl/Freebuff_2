import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: React.ReactNode;
  /** متن کوتاه برای اینکه کاربر بداند کدام بخش از کار افتاده است */
  label?: string;
  onReset?: () => void;
}

interface State {
  error: Error | null;
}

/**
 * مرز خطای رابط کاربری.
 *
 * خطای رندر در یک صفحه (مثلاً دادهٔ ناقص از API) نباید کل برنامه را سفید کند.
 * این مؤلفه خطا را می‌گیرد، پیام کوتاه نشان می‌دهد و امکان تلاش دوباره یا رفتن
 * به مسیر دیگر را می‌دهد؛ پوستهٔ برنامه (منو/وضعیت/اتصال زنده) سالم می‌ماند.
 */
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // جزئیات برای عیب‌یابی در کنسول می‌ماند، اما در UI به کاربر نشان داده نمی‌شود
    console.error('[UI] unhandled render error', error, info.componentStack);
  }

  private reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card p-6">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-soft border border-sun-200 bg-sun-50 text-sun-700">
            <AlertTriangle size={20} />
          </span>
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-ink-800">
              {this.props.label ? `${this.props.label} با خطا مواجه شد` : 'این بخش با خطا مواجه شد'}
            </h3>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-500">
              بقیهٔ صفحه سالم است. اگر خطا تکرار شد، صفحه را دوباره بارگذاری کنید. جزئیات فنی در کنسول مرورگر ثبت شد.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="btn-primary btn-xs" onClick={this.reset}>
                <RefreshCw size={13} />
                تلاش دوباره
              </button>
              <button type="button" className="btn-ghost btn-xs" onClick={() => window.location.assign('/dashboard')}>
                بازگشت به داشبورد
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
