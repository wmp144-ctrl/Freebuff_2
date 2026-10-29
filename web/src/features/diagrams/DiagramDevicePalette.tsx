/**
 * فهرست تجهیزات پنل کناری دیاگرام — همهٔ تجهیزاتی که برای مانیتورینگ ثبت
 * شده‌اند. با انتخاب هر ردیف، افزودن آن تجهیز به بوم مسلح می‌شود و کلیک
 * بعدی روی بوم آن را با نام، مدل و شناسهٔ همان تجهیز می‌سازد.
 */
import React, { useMemo, useState } from 'react';
import { Plus, RefreshCw, Search, Server } from 'lucide-react';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/store';
import { faDigits, statusMeta } from '../../lib/format';
import type { Device } from '../../lib/types';

export interface DiagramDevicePaletteProps {
  editing: boolean;
  onPick: (device: Device) => void;
}

export default function DiagramDevicePalette({ editing, onPick }: DiagramDevicePaletteProps) {
  const [query, setQuery] = useState('');
  const { data, loading, error, reload } = useAsync(
    (signal) => api.devices({ pageSize: 500, sort: 'name', order: 'asc' }, signal),
    []
  );

  const devices = data?.items ?? [];
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return devices;
    return devices.filter((device) =>
      [device.name, device.ip, device.hostname, device.deviceType, device.location, device.groupName]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle))
    );
  }, [devices, query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-1.5 border-b border-ink-100 px-2 py-1.5">
        <div className="relative">
          <Search size={12} className="pointer-events-none absolute end-2 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            className="field !py-1 pe-7 text-[11px]"
            placeholder="جست‌وجوی نام، IP یا گروه…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="جست‌وجوی تجهیزات"
          />
        </div>
        <div className="flex items-center gap-1">
          <p className="min-w-0 flex-1 text-[10px] leading-4 text-ink-400">
            {editing
              ? 'روی تجهیز کلیک کنید، سپس روی بوم کلیک کنید.'
              : 'برای افزودن به بوم، حالت ویرایش را فعال کنید.'}
          </p>
          <button
            type="button"
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink-400 hover:bg-ink-50 hover:text-ink-700"
            onClick={reload}
            title="بازخوانی فهرست تجهیزات"
            aria-label="بازخوانی فهرست تجهیزات"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {loading && !data ? (
          <p className="px-2 py-6 text-center text-[11px] text-ink-400">در حال بارگذاری تجهیزات…</p>
        ) : error ? (
          <p className="px-2 py-6 text-center text-[11px] leading-5 text-red-600">{error}</p>
        ) : filtered.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] leading-5 text-ink-400">
            {devices.length === 0 ? 'هنوز تجهیزی برای مانیتورینگ ثبت نشده است.' : 'تجهیزی با این جست‌وجو پیدا نشد.'}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {filtered.map((device) => {
              const meta = statusMeta(device.status);
              return (
                <li key={device.id}>
                  <button
                    type="button"
                    disabled={!editing}
                    onClick={() => onPick(device)}
                    title={editing ? `افزودن «${device.name}» به بوم` : 'حالت ویرایش غیرفعال است'}
                    className="group flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1.5 text-right transition hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${meta.dot}`} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11.5px] font-medium text-ink-700">{device.name}</span>
                      <span className="ltr block truncate text-left text-[10px] text-ink-400">
                        {device.ip}
                        {device.deviceType ? ` · ${device.deviceType}` : ''}
                      </span>
                    </span>
                    <Plus
                      size={12}
                      className="shrink-0 text-ink-300 transition group-hover:text-brand-600 group-disabled:group-hover:text-ink-300"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1 border-t border-ink-100 px-2 py-1.5 text-[10px] text-ink-400">
        <Server size={11} />
        <span className="flex-1">
          {faDigits(devices.length)} تجهیز مانیتورینگ
          {query.trim() ? ` · ${faDigits(filtered.length)} نتیجه` : ''}
        </span>
      </div>
    </div>
  );
}
