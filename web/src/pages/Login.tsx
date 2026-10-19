import React, { useState } from 'react';
import { Activity, Eye, EyeOff, LockKeyhole, ShieldCheck, User } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { PageLoader } from '../components/ui';

/**
 * دروازهٔ ورود: تا وقتی نشست معتبری وجود نداشته باشد، هیچ صفحه‌ای (و هیچ
 * اتصال SSE) باز نمی‌شود؛ پس داده‌ای بدون احراز هویت بارگذاری نمی‌گردد.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-ink-50">
        <PageLoader label="بررسی نشست…" />
      </div>
    );
  }
  if (!user) return <Login />;
  return <>{children}</>;
}

export default function Login() {
  const { login, error } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!username.trim() || !password) return;
    setBusy(true);
    try {
      await login(username.trim(), password);
    } catch {
      /* پیام خطا در context ذخیره می‌شود */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-ink-50 px-4 py-10">
      {/* پس‌زمینهٔ نرم — بدون تصویر خارجی تا CSP دست‌نخورده بماند */}
      <div className="pointer-events-none absolute -top-32 right-1/2 h-[520px] w-[520px] translate-x-1/2 rounded-full bg-brand-200/40 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 left-0 h-[420px] w-[420px] rounded-full bg-emerald-200/30 blur-3xl" />

      <div className="relative w-full max-w-sm animate-fade-up">
        <div className="mb-5 flex flex-col items-center text-center">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-600 text-white shadow-pop">
            <Activity size={24} />
          </span>
          <h1 className="mt-3 text-lg font-bold text-ink-800">سامانهٔ پایش شبکه</h1>
          <p className="mt-1 text-[12px] text-ink-500">برای مشاهدهٔ وضعیت تجهیزات وارد شوید</p>
        </div>

        <form onSubmit={submit} className="card space-y-4 p-5">
          {error ? (
            <p className="rounded-soft border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700" role="alert">
              {error}
            </p>
          ) : null}

          <div>
            <label className="label" htmlFor="username">
              نام کاربری
            </label>
            <div className="relative">
              <User size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-400" />
              <input
                id="username"
                className="field pr-9"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                disabled={busy}
                required
              />
            </div>
          </div>

          <div>
            <label className="label" htmlFor="password">
              رمز عبور
            </label>
            <div className="relative">
              <LockKeyhole size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-400" />
              <input
                id="password"
                className="field px-9"
                type={show ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                disabled={busy}
                required
              />
              <button
                type="button"
                className="absolute left-2 top-1/2 -translate-y-1/2 rounded p-1 text-ink-400 transition hover:text-ink-700"
                onClick={() => setShow((v) => !v)}
                aria-label={show ? 'پنهان‌کردن رمز' : 'نمایش رمز'}
                tabIndex={-1}
              >
                {show ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          <button type="submit" className="btn-primary w-full justify-center" disabled={busy || !username.trim() || !password}>
            {busy ? 'در حال ورود…' : 'ورود به سامانه'}
          </button>

          <p className="flex items-center justify-center gap-1.5 text-[11px] text-ink-400">
            <ShieldCheck size={12} />
            نشست رمزنگاری‌شده و محدود به همین مرورگر است
          </p>
        </form>

        <p className="mt-4 text-center text-[11px] leading-5 text-ink-400">
          نقش‌ها: Administrator (همهٔ امکانات)، Operator (عملیات روزمره و Probe) و Viewer (فقط مشاهده).
        </p>
      </div>
    </div>
  );
}
