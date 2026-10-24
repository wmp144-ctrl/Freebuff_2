import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { faDigits } from '../lib/format';
import {
  JALALI_MONTHS,
  formatJalaliIso,
  parseJalaliInput,
  todayJalali,
  jalaliToIso,
  isoToJalali,
  jalaliMonthLength,
  j2d,
} from '../lib/jalali';

/** روزهای هفته شمسی؛ شنبه ستون اول است. */
const WEEKDAYS = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'];

/** اندیس ستون (شنبه=۰) برای اولین روز یک ماه شمسی. */
function firstWeekdayIndex(jy: number, jm: number): number {
  return (j2d(jy, jm, 1) + 2) % 7;
}

interface PanelProps {
  value: string;
  anchor: DOMRect;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  onSelect: (iso: string) => void;
  onClose: () => void;
}

/**
 * تقویم ماهیانه شمسی.
 *
 * مقدار ورودی/خروجی همیشه ISO میلادی است (همان قالب API). انتخاب سال و ماه با
 * فهرست کشویی و انتخاب روز با کلیک روی خانهٔ همان روز انجام می‌شود. پنل در
 * Portal رندر می‌شود تا داخل Modal یا کادرهای اسکرول‌دار بریده نشود.
 */
function JalaliCalendarPanel({ value, anchor, anchorRef, onSelect, onClose }: PanelProps) {
  const initial = useMemo(() => isoToJalali(value) ?? todayJalali(), [value]);
  const [view, setView] = useState({ jy: initial.jy, jm: initial.jm });
  const panelRef = useRef<HTMLDivElement>(null);
  const today = todayJalali();

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // کلیک روی همان ورودی/آیکون نباید پنل را ببندد؛ خود دکمه toggle می‌کند.
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const shiftMonth = (delta: number) => {
    setView((v) => {
      const total = v.jy * 12 + (v.jm - 1) + delta;
      return { jy: Math.floor(total / 12), jm: ((total % 12) + 12) % 12 + 1 };
    });
  };

  const days = jalaliMonthLength(view.jy, view.jm);
  const offset = firstWeekdayIndex(view.jy, view.jm);
  const cells: (number | null)[] = [
    ...Array.from({ length: offset }, () => null),
    ...Array.from({ length: days }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const years = Array.from({ length: 31 }, (_, i) => today.jy - 15 + i);
  if (!years.includes(view.jy)) years.push(view.jy);
  years.sort((a, b) => a - b);

  const panelWidth = 300;
  const panelHeight = 348;
  const left = Math.min(Math.max(8, anchor.right - panelWidth), Math.max(8, window.innerWidth - panelWidth - 8));
  const openBelow = anchor.bottom + panelHeight + 8 < window.innerHeight;
  const top = openBelow ? anchor.bottom + 6 : Math.max(8, anchor.top - panelHeight - 6);

  return createPortal(
    <div
      ref={panelRef}
      dir="rtl"
      role="dialog"
      aria-label="تقویم شمسی"
      className="fixed z-[1200] w-[300px] rounded-card border border-ink-200 bg-white p-3 shadow-pop"
      style={{ top, left }}
    >
      <div className="flex items-center justify-between gap-1">
        <button
          type="button"
          className="btn-ghost btn-xs !px-1.5"
          onClick={() => shiftMonth(-1)}
          aria-label="ماه قبل"
        >
          <ChevronRight size={15} />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <select
            className="field !w-[86px] !py-1 text-[12px]"
            value={view.jm}
            onChange={(e) => setView((v) => ({ ...v, jm: Number(e.target.value) }))}
            aria-label="ماه"
          >
            {JALALI_MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
          <select
            className="field !w-[88px] !py-1 text-[12px]"
            value={view.jy}
            onChange={(e) => setView((v) => ({ ...v, jy: Number(e.target.value) }))}
            aria-label="سال"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {faDigits(y)}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="btn-ghost btn-xs !px-1.5"
          onClick={() => shiftMonth(1)}
          aria-label="ماه بعد"
        >
          <ChevronLeft size={15} />
        </button>
      </div>

      <div className="mt-3 grid grid-cols-7 gap-1 text-center">
        {WEEKDAYS.map((w, i) => (
          <span key={`${w}-${i}`} className="py-1 text-[10.5px] font-medium text-ink-400">
            {w}
          </span>
        ))}
        {cells.map((day, i) => {
          if (day == null) return <span key={`empty-${i}`} />;
          const iso = jalaliToIso(view.jy, view.jm, day);
          const selected = iso === value;
          const isToday = view.jy === today.jy && view.jm === today.jm && day === today.jd;
          return (
            <button
              key={iso}
              type="button"
              onClick={() => onSelect(iso)}
              className={`num h-8 rounded-lg text-[12px] transition ${
                selected
                  ? 'bg-brand-500 font-semibold text-white shadow-soft'
                  : isToday
                    ? 'border border-brand-300 bg-brand-50 text-brand-700'
                    : 'text-ink-600 hover:bg-ink-100'
              }`}
            >
              {faDigits(day)}
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-ink-100 pt-2">
        <button
          type="button"
          className="btn-ghost btn-xs"
          onClick={() => {
            const iso = jalaliToIso(today.jy, today.jm, today.jd);
            onSelect(iso);
          }}
        >
          امروز
        </button>
        <span className="num text-[10.5px] text-ink-400">
          {formatJalaliIso(value, (s) => s) === '—' ? 'تاریخی انتخاب نشده' : formatJalaliIso(value, faDigits)}
        </span>
        <button type="button" className="btn-ghost btn-xs" onClick={onClose}>
          بستن
        </button>
      </div>
    </div>,
    document.body
  );
}

/**
 * ورودی تاریخ شمسی.
 *
 * مقدار `value` همیشه ISO میلادی (همان چیزی که API می‌فهمد) است؛ کاربر تاریخ
 * را شمسی می‌بیند و تایپ می‌کند، یا با کلیک روی آیکون تقویم یک تقویم ماهیانه
 * شمسی باز می‌کند و روز/ماه/سال را انتخاب می‌کند. خروجی فقط وقتی تغییر می‌کند
 * که تاریخ شمسی معتبر باشد، پس مقدار نیمه‌کاره هرگز به فیلتر/فرم نمی‌رسد.
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
  const [calendar, setCalendar] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

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

  const choose = useCallback(
    (iso: string) => {
      setText(formatJalaliIso(iso, faDigits));
      setInvalid(false);
      setCalendar(null);
      if (iso !== value) onChange(iso);
    },
    [onChange, value]
  );

  const openCalendar = () => {
    if (disabled) return;
    const input = wrapRef.current?.querySelector('input');
    const rect = (input ?? wrapRef.current)?.getBoundingClientRect();
    if (rect) setCalendar(rect);
  };

  const setToday = () => {
    const j = todayJalali();
    choose(jalaliToIso(j.jy, j.jm, j.jd));
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => (calendar ? setCalendar(null) : openCalendar())}
        disabled={disabled}
        aria-label="باز کردن تقویم شمسی"
        title="انتخاب از تقویم"
        className="absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded p-1 text-ink-400 transition hover:bg-brand-50 hover:text-brand-600 disabled:opacity-50"
      >
        <CalendarDays size={15} />
      </button>
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
      {calendar ? (
        <JalaliCalendarPanel
          value={value}
          anchor={calendar}
          anchorRef={wrapRef}
          onSelect={choose}
          onClose={() => setCalendar(null)}
        />
      ) : null}
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
