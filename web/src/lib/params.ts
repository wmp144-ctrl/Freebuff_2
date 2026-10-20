import { useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * به‌روزرسانی خالص پارامترهای آدرس
 * ----------------------------------------------------------------
 * تغییر یک پارامتر بدون از دست دادن بقیهٔ پارامترها و با حذف شمارهٔ صفحه
 * (هر تغییر فیلتر/جست‌وجو به صفحهٔ اول برمی‌گردد مگر خودِ صفحه تغییر کند).
 *
 * @param base پارامترهای فعلی آدرس
 * @param key نام پارامتر
 * @param value مقدار جدید؛ رشتهٔ خالی یعنی حذف پارامتر
 */
export function mergeParam(base: URLSearchParams, key: string, value: string): URLSearchParams {
  const next = new URLSearchParams(base);
  if (value) next.set(key, value);
  else next.delete(key);
  if (key !== 'page') next.delete('page');
  return next;
}

/**
 * مدیریت پارامترهای آدرس با تضمین «آخرین وضعیت»
 * ----------------------------------------------------------------
 * دو تغییر پشت‌سرهم (مثلاً پاک‌کردن جست‌وجو و کلیک فوری فیلتر) در یک تیک رخ
 * می‌دهند؛ در آن حالت آخرین URL هنوز در state روتور منعکس نشده است. به‌روزرسانی
 * تابعیِ `setSearchParams` هم از رندر فعلی می‌خواند و می‌تواند تغییر اول را از
 * آدرس بیندازد. این قلاب آخرین مقدارِ ارسال‌شده را در ref نگه می‌دارد تا هیچ
 * به‌روزرسانی‌ای گم نشود.
 */
export function useUrlParams() {
  const [params, setParams] = useSearchParams();
  const latest = useRef(params);

  useEffect(() => {
    latest.current = params;
  }, [params]);

  const setParam = useCallback(
    (key: string, value: string) => {
      const next = mergeParam(latest.current, key, value);
      latest.current = next;
      setParams(next, { replace: true });
    },
    [setParams]
  );

  const resetParams = useCallback(() => {
    const next = new URLSearchParams();
    latest.current = next;
    setParams(next, { replace: true });
  }, [setParams]);

  return { params, setParam, resetParams };
}
