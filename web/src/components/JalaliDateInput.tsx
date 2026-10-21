import React, { useEffect, useState } from 'react';
import { CalendarDays, X } from 'lucide-react';
import { faDigits } from '../lib/format';
import { formatJalaliIso, parseJalaliInput, todayJalali, jalaliToIso, isoToJalali } from '../lib/jalali';

/**
 * ورودی تاریخ شمسی.
 *
 * مقدار `value` همیشه ISO میلادی (همان چیزی که API می‌فهمد) است؛ کاربر تاریخ
 * را شمسی می‌بیند و تایپ می‌کند. خروجی فقط وقتی تغییر می‌کند که تاریخ شمسی
 * معتبر باشد، پس مقدار نیمه‌کاره هرگز به فیلتر/فرم نمی‌رسد.
 */
export default function JalaliDateInput({
  value,
  onChange,
  placeholder = '۱۴۰۵/۰۷/۲۹',
  disabled = false,
  allowClear = true,
  ariaLabel = 'تاریخ شمسی',
}: {
  value: string;
  onChange: (iso: string) => void;
  placeholder?: string;
  disabled?: boolean;
  allowClear?: boolean;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(() => (value ? formatJalaliIso(value, faDigits) : ''));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setText(value ? formatJalaliIso(value, faDigits) : '');
    setInvalid(false);
  }, [value]);

  const commit = (raw: string) => {
    if (!raw.trim()) {
      setInvalid(false);
      if (value) onChange('');
      return;
    }
    const iso = parseJalaliInput(raw);
    if (!iso) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setText(formatJalaliIso(iso, faDigits));
    if (iso !== value) onChange(iso);
  };

  const setToday = () => {
    const j = todayJalali();
    const iso = jalaliToIso(j.jy, j.jm, j.jd);
    setText(formatJalaliIso(iso, faDigits));
    setInvalid(false);
    onChange(iso);
  };

  return (
    <div className="relative">
      <CalendarDays size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-400" />
      <input
        dir="ltr"
        aria-label={ariaLabel}
        className={`field num !pr-9 ${allowClear ? '!pl-16' : ''} ${invalid ? '!border-red-400' : ''}`}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          setInvalid(false);
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit((e.target as HTMLInputElement).value);
          }
        }}
      />
      <div className="absolute left-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
        <button type="button" className="rounded px-1.5 py-1 text-[10px] text-brand-600 hover:bg-brand-50" onClick={setToday} tabIndex={-1}>
          امروز
        </button>
        {allowClear && value ? (
          <button
            type="button"
            aria-label="پاک کردن تاریخ"
            className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-red-500"
            onClick={() => {
              setText('');
              setInvalid(false);
              onChange('');
            }}
            tabIndex={-1}
          >
            <X size={12} />
          </button>
        ) : null}
      </div>
      {invalid ? <p className="mt-1 text-[10.5px] text-red-600">تاریخ شمسی را به شکل ۱۴۰۵/۰۷/۲۹ وارد کنید.</p> : null}
      {value ? <p className="mt-1 text-[10px] text-ink-400">میلادی ذخیره‌شده: {value}</p> : null}
    </div>
  );
}

/**
 * تاریخ و ساعت شمسی. مقدار خروجی همان قالب `datetime-local` محلی است
 * (`YYYY-MM-DDTHH:mm`) تا ساعت و منطقهٔ زمانی نمایش حفظ شود.
 */
export function JalaliDateTimeInput({
  value,
  onChange,
  allowClear = true,
  ariaLabel = 'تاریخ و ساعت شمسی',
}: {
  value: string;
  onChange: (value: string) => void;
  allowClear?: boolean;
  ariaLabel?: string;
}) {
  const datePart = /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '';
  const timePart = value.includes('T') ? value.slice(11, 16) : '';

  const emit = (isoDate: string, time: string) => {
    if (!isoDate) return onChange('');
    onChange(`${isoDate}T${time || '00:00'}`);
  };

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <JalaliDateInput value={datePart} onChange={(iso) => emit(iso, timePart)} allowClear={allowClear} ariaLabel={ariaLabel} />
      </div>
      <input
        type="time"
        dir="ltr"
        aria-label="ساعت"
        className="field num !w-[105px]"
        value={timePart}
        disabled={!datePart}
        onChange={(e) => emit(datePart, e.target.value)}
      />
    </div>
  );
}

export { isoToJalali };
