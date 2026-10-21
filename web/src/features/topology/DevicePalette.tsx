/**
 * پالت تجهیزات و مراکز تجمع
 * ----------------------------------------------------------------
 * جست‌وجو سمت سرور است تا با هزاران تجهیز هم سریع بماند؛ هر آیتم با Drag
 * قابل رهاکردن روی بوم است و دکمهٔ «افزودن» آن را در مرکز نمای فعلی می‌گذارد.
 * تجهیزات همین‌الان‌حاضر در دیاگرام با نشان «افزوده‌شده» و دکمهٔ «نمایش»
 * مشخص می‌شوند.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Building2, Check, Filter, LocateFixed, Plus, Search, Server, Settings2 } from 'lucide-react';
import type { TopoCatalogItem, TopoSite } from '../../lib/types';
import { api } from '../../lib/api';
import { useApp, useAsync } from '../../lib/store';
import { statusMeta } from '../../lib/format';
import { Tabs, Spinner } from '../../components/ui';

interface Props {
  diagramId: number | null;
  sites: TopoSite[];
  placedDeviceIds: Set<number>;
  placedSiteIds: Set<number>;
  refreshToken: number;
  disabled: boolean;
  onAddDevice: (item: TopoCatalogItem) => void;
  onAddSite: (site: TopoSite) => void;
  onFocusNode: (nodeId: string) => void;
  onManageSites: (siteId?: number) => void;
}

type Tab = 'devices' | 'sites';

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'همه' },
  { value: 'online', label: 'در دسترس' },
  { value: 'offline', label: 'قطع' },
  { value: 'warning', label: 'اختلال' },
];

export default function DevicePalette({
  diagramId,
  sites,
  placedDeviceIds,
  placedSiteIds,
  refreshToken,
  disabled,
  onAddDevice,
  onAddSite,
  onFocusNode,
  onManageSites,
}: Props) {
  const { meta } = useApp();
  const [tab, setTab] = useState<Tab>('devices');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');
  const [groupId, setGroupId] = useState('');
  const [siteFilter, setSiteFilter] = useState('');

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query.trim()), 280);
    return () => window.clearTimeout(id);
  }, [query]);

  const catalog = useAsync(
    (signal) =>
      api.topologyCatalog(
        {
          search: debounced || undefined,
          status: status || undefined,
          groupId: groupId ? Number(groupId) : undefined,
          siteId: siteFilter === 'unassigned' ? 'unassigned' : siteFilter ? Number(siteFilter) : undefined,
          diagramId: diagramId || undefined,
          limit: 400,
        },
        signal
      ),
    [debounced, status, groupId, siteFilter, diagramId, refreshToken]
  );

  const groups = meta?.groups ?? [];
  const siteList = useMemo(() => {
    const q = debounced.toLowerCase();
    if (!q) return sites;
    return sites.filter((s) => `${s.name} ${s.code} ${s.address}`.toLowerCase().includes(q));
  }, [sites, debounced]);

  const items = catalog.data?.items ?? [];
  const total = catalog.data?.total ?? 0;

  return (
    <aside className="card flex h-[380px] min-h-0 flex-col overflow-hidden !p-0 lg:h-full" aria-label="پالت دیاگرام">
      <div className="border-b border-ink-100 p-3">
        <div className="flex items-center justify-between gap-2">
          <Tabs<Tab>
            size="sm"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'devices', label: 'تجهیزات', count: total },
              { value: 'sites', label: 'مراکز تجمع', count: sites.length },
            ]}
          />
          {tab === 'sites' ? (
            <button type="button" className="btn-ghost btn-xs" onClick={() => onManageSites()} title="مدیریت مراکز تجمع">
              <Settings2 size={13} />
            </button>
          ) : null}
        </div>

        <div className="relative mt-3">
          <Search size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tab === 'devices' ? 'نام، IP، موقعیت…' : 'نام یا کد مرکز…'}
            className="field !py-1.5 pr-8 text-[12px]"
            aria-label="جست‌وجو در پالت"
          />
        </div>

        {tab === 'devices' ? (
          <div className="mt-2.5 space-y-2">
            <div className="flex flex-wrap gap-1">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.value || 'all'}
                  type="button"
                  onClick={() => setStatus(f.value)}
                  className={`rounded-pill border px-2 py-0.5 text-[10px] transition ${
                    status === f.value
                      ? 'border-brand-300 bg-brand-50 font-medium text-brand-700'
                      : 'border-ink-200 bg-white text-ink-500 hover:border-ink-300'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <Filter size={12} className="shrink-0 text-ink-400" />
              <select
                value={groupId}
                onChange={(event) => setGroupId(event.target.value)}
                className="field !py-1 text-[11px]"
                aria-label="فیلتر گروه"
              >
                <option value="">همه گروه‌ها</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
              <select
                value={siteFilter}
                onChange={(event) => setSiteFilter(event.target.value)}
                className="field !py-1 text-[11px]"
                aria-label="فیلتر مرکز تجمع"
              >
                <option value="">همه مراکز</option>
                <option value="unassigned">بدون مرکز</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2" role="list">
        {tab === 'devices' ? (
          catalog.loading && !catalog.data ? (
            <div className="grid place-items-center py-10 text-ink-400">
              <Spinner />
            </div>
          ) : catalog.error ? (
            <div className="px-2 py-6 text-center text-[11.5px] text-red-600">
              {catalog.error}
              <button type="button" className="btn-ghost btn-xs mt-2" onClick={catalog.reload}>
                تلاش دوباره
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="px-3 py-10 text-center text-[11.5px] text-ink-400">
              تجهیزی با این مشخصات پیدا نشد.
            </div>
          ) : (
            <div className="space-y-1.5">
              {items.map((item) => {
                const placed = placedDeviceIds.has(item.id);
                const metaStatus = statusMeta(item.status);
                return (
                  <div
                    key={item.id}
                    role="listitem"
                    draggable={!disabled && !placed}
                    onDragStart={(event) => {
                      event.dataTransfer.setData('application/x-netwatch-topology', JSON.stringify({ kind: 'device', id: item.id }));
                      event.dataTransfer.effectAllowed = 'copy';
                    }}
                    className={`group flex items-start gap-2 rounded-soft border p-2 transition ${
                      placed
                        ? 'border-emerald-100 bg-emerald-50/40'
                        : 'border-ink-100 bg-white hover:border-brand-200 hover:bg-brand-50/20'
                    } ${disabled || placed ? '' : 'cursor-grab active:cursor-grabbing'}`}
                  >
                    <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${metaStatus.dot}`} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-medium text-ink-700" title={item.name}>
                        {item.name}
                      </p>
                      <p className="num mt-0.5 truncate text-[10.5px] text-ink-400" title={item.ip}>
                        {item.ip}
                        {item.deviceType ? ` · ${item.deviceType}` : ''}
                      </p>
                      {item.siteName ? (
                        <p className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-ink-400">
                          <Building2 size={10} /> {item.siteName}
                        </p>
                      ) : null}
                    </div>
                    {placed ? (
                      <button
                        type="button"
                        className="btn-ghost btn-xs !px-1.5"
                        onClick={() => item.nodeId && onFocusNode(item.nodeId)}
                        title="نمایش روی بوم"
                        aria-label={`نمایش ${item.name} روی بوم`}
                      >
                        <LocateFixed size={13} className="text-emerald-600" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-ghost btn-xs !px-1.5 opacity-0 transition group-hover:opacity-100 focus:opacity-100"
                        onClick={() => onAddDevice(item)}
                        disabled={disabled}
                        title="افزودن به دیاگرام"
                        aria-label={`افزودن ${item.name}`}
                      >
                        <Plus size={13} />
                      </button>
                    )}
                  </div>
                );
              })}
              {catalog.data?.hasMore ? (
                <p className="px-2 py-2 text-center text-[10.5px] text-ink-400">
                  {total.toLocaleString('fa-IR')} نتیجه — برای دیدن بقیه جست‌وجو را دقیق‌تر کنید.
                </p>
              ) : null}
            </div>
          )
        ) : siteList.length === 0 ? (
          <div className="px-3 py-10 text-center text-[11.5px] text-ink-400">
            مرکز تجمعی تعریف نشده است.
            <button type="button" className="btn-soft btn-xs mt-2 w-full" onClick={() => onManageSites()}>
              <Settings2 size={12} /> مدیریت مراکز
            </button>
          </div>
        ) : (
          <div className="space-y-1.5">
            {siteList.map((site) => {
              const placed = placedSiteIds.has(site.id);
              return (
                <div
                  key={site.id}
                  role="listitem"
                  draggable={!disabled && !placed}
                  onDragStart={(event) => {
                    event.dataTransfer.setData('application/x-netwatch-topology', JSON.stringify({ kind: 'site', id: site.id }));
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                  className={`group flex items-start gap-2 rounded-soft border p-2 transition ${
                    placed ? 'border-indigo-100 bg-indigo-50/40' : 'border-ink-100 bg-white hover:border-indigo-200'
                  } ${disabled || placed ? '' : 'cursor-grab active:cursor-grabbing'}`}
                >
                  <span
                    className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg"
                    style={{ background: `${site.color}18`, color: site.color }}
                  >
                    <Building2 size={14} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-medium text-ink-700">{site.name}</p>
                    <p className="mt-0.5 truncate text-[10.5px] text-ink-400">
                      {site.code ? `${site.code} · ` : ''}
                      {site.deviceCount.toLocaleString('fa-IR')} تجهیز · {site.onlineCount.toLocaleString('fa-IR')} در دسترس
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center">
                    {placed ? (
                      <span className="grid h-6 w-6 place-items-center text-emerald-600" title="در دیاگرام">
                        <Check size={13} />
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn-ghost btn-xs !px-1.5 opacity-0 transition group-hover:opacity-100 focus:opacity-100"
                        onClick={() => onAddSite(site)}
                        disabled={disabled}
                        title="افزودن به دیاگرام"
                        aria-label={`افزودن ${site.name}`}
                      >
                        <Plus size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-ghost btn-xs !px-1.5"
                      onClick={() => onManageSites(site.id)}
                      title="مدیریت مرکز"
                      aria-label={`مدیریت ${site.name}`}
                    >
                      <Settings2 size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-ink-100 px-3 py-2 text-[10.5px] text-ink-400">
        <span className="inline-flex items-center gap-1">
          <Server size={11} /> {tab === 'devices' ? `${total.toLocaleString('fa-IR')} تجهیز` : `${sites.length.toLocaleString('fa-IR')} مرکز`}
        </span>
        <span>کشیدن روی بوم = افزودن</span>
      </div>
    </aside>
  );
}

export { DevicePalette };
