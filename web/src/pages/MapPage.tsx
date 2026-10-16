import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Crosshair,
  Download,
  Eye,
  EyeOff,
  Layers,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Tag as TagIcon,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { api, downloadUrl } from '../lib/api';
import { useApp, useAsync, useToast } from '../lib/store';
import { faDigits, fmtMs, fmtPct, statusMeta } from '../lib/format';
import { Badge, Card, CardHeader, EmptyState, Modal, StatusPill, Toggle } from '../components/ui';
import type { Device, MapLayer } from '../lib/types';

/* ------------------------ لایه پایه آفلاین ------------------------ */
const OfflineGridLayer = L.GridLayer.extend({
  createTile(this: L.GridLayer, coords: L.Coords) {
    const tile = document.createElement('div');
    const size = this.getTileSize();
    tile.style.width = `${size.x}px`;
    tile.style.height = `${size.y}px`;
    tile.style.background = '#f2f6fb';
    tile.style.boxShadow = 'inset 0 0 0 1px rgba(148,163,184,0.18)';
    tile.style.position = 'relative';
    const scale = Math.pow(2, coords.z);
    const lon = (coords.x / scale) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * coords.y) / scale;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    const label = document.createElement('span');
    label.textContent = `${lat.toFixed(1)}° , ${lon.toFixed(1)}°`;
    label.style.cssText =
      'position:absolute;top:6px;left:8px;font-size:10px;color:#94a3b8;font-family:Vazirmatn,Tahoma,sans-serif;direction:ltr';
    tile.appendChild(label);
    if (coords.z >= 6 && (coords.x + coords.y) % 2 === 0) {
      const cross = document.createElement('span');
      cross.style.cssText =
        'position:absolute;inset:0;background-image:linear-gradient(to right,rgba(148,163,184,0.12) 1px,transparent 1px),linear-gradient(to bottom,rgba(148,163,184,0.12) 1px,transparent 1px);background-size:28px 28px';
      tile.appendChild(cross);
    }
    return tile;
  },
}) as unknown as new (options?: L.GridLayerOptions) => L.GridLayer;

function markerIcon(device: Device, showLabel: boolean, tags: string[]) {
  const meta = statusMeta(device.status);
  const label = showLabel ? `<span class="nw-map-label">${escapeHtml(tags.length ? tags.join(' · ') : device.name)}</span>` : '';
  const pulse = device.status === 'offline' ? `<span class="nw-pulse" style="background:${meta.chart}"></span>` : '';
  return L.divIcon({
    className: 'nw-marker',
    html: `<span class="nw-pin" style="--c:${meta.chart}">${pulse}<span class="nw-dot"></span></span>${label}`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export default function MapPage() {
  const { meta, settings, tzOffset, refreshMeta } = useApp();
  const { push } = useToast();
  const [params, setParams] = useSearchParams();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayers = useRef<Record<number, L.Layer>>({});
  const markers = useRef<Map<number, L.Marker>>(new Map());
  const [ready, setReady] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<{ id: number; latitude: number; longitude: number } | null>(null);
  const [layersOpen, setLayersOpen] = useState(false);
  const [placingDevice, setPlacingDevice] = useState<number | null>(null);

  const query = useMemo(
    () => ({
      search: params.get('search') ?? '',
      status: params.get('status') ?? '',
      group: params.get('group') ?? '',
      tag: params.get('tag') ?? '',
      geo: 'with' as const,
    }),
    [params]
  );

  const { data: devicePage, loading, refresh } = useAsync(() => api.devices({ ...query, pageSize: 500 }), [JSON.stringify(query)]);
  const { data: layersData, refresh: refreshLayers } = useAsync(() => api.layers(), []);
  const devices = devicePage?.items ?? [];
  const layers = layersData?.items ?? [];

  const visibleTagNames = useMemo(
    () => new Set((meta?.tags ?? []).filter((t) => !!t.show_on_map).map((t) => t.name)),
    [meta?.tags]
  );

  /* ------------------------- init map ------------------------- */
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const center = settings?.map_default_center ?? [35.6892, 51.389];
    const map = L.map(containerRef.current, {
      center: L.latLng(center[0], center[1]),
      zoom: settings?.map_default_zoom ?? 6,
      zoomControl: false,
      attributionControl: false,
      preferCanvas: false,
    });
    L.control.zoom({ position: 'bottomleft' }).addTo(map);
    L.control.scale({ position: 'bottomright', imperial: false }).addTo(map);
    mapRef.current = map;
    setReady(true);
    return () => {
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const center = settings?.map_default_center ?? [35.6892, 51.389];
    map.setView(L.latLng(center[0], center[1]), settings?.map_default_zoom ?? 6);
  }, [settings?.map_default_center, settings?.map_default_zoom]);

  /* ------------------------- base layers ------------------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const wanted = new Set<number>();
    for (const layer of layers) {
      if (!layer.visible) continue;
      wanted.add(layer.id);
      if (tileLayers.current[layer.id]) continue;
      let instance: L.Layer | null = null;
      if (layer.kind === 'mbtiles' && layer.file_name) {
        instance = L.tileLayer(`/api/tiles/${layer.id}/{z}/{x}/{y}.png`, {
          minZoom: layer.min_zoom ?? 0,
          maxZoom: layer.max_zoom ?? 19,
          maxNativeZoom: layer.max_zoom ?? 19,
          tileSize: 256,
          noWrap: false,
          attribution: layer.attribution || '',
          errorTileUrl: undefined,
        });
      } else {
        instance = new OfflineGridLayer({ tileSize: 256, minZoom: 0, maxZoom: 20 });
      }
      if (instance) {
        instance.addTo(map);
        tileLayers.current[layer.id] = instance;
      }
    }
    for (const [id, instance] of Object.entries(tileLayers.current)) {
      if (!wanted.has(Number(id))) {
        map.removeLayer(instance);
        delete tileLayers.current[Number(id)];
      }
    }
    // ترتیب: لایه‌های پایه زیر نشانگرها
    for (const layer of layers.filter((l) => l.visible)) {
      const inst = tileLayers.current[layer.id] as L.GridLayer | undefined;
      if (inst && typeof inst.bringToBack === 'function') inst.bringToBack();
    }
  }, [layers, ready]);

  /* --------------------------- markers --------------------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const current = new Set<number>();
    for (const device of devices) {
      const lat = device.latitude;
      const lng = device.longitude;
      if (lat == null || lng == null) continue;
      current.add(device.id);
      const tagNames = (device.tags || []).map((t) => t.name);
      const showLabel = !!settings?.map_show_labels;
      const icon = markerIcon(device, showLabel, tagNames.filter((t) => visibleTagNames.has(t)));
      let marker = markers.current.get(device.id);
      if (!marker) {
        marker = L.marker([lat, lng], { icon, riseOnHover: true }).addTo(map);
        marker.on('click', () => {
          const mapInstance = mapRef.current;
          if (editing) {
            setPlacingDevice(device.id);
            return;
          }
          marker?.openPopup();
          mapInstance?.panTo([lat, lng]);
        });
        markers.current.set(device.id, marker);
      } else {
        marker.setLatLng([lat, lng]);
        marker.setIcon(icon);
      }
      marker.bindPopup(popupHtml(device, tzOffset), { closeButton: true, minWidth: 220 });
    }

    for (const [id, marker] of markers.current.entries()) {
      if (!current.has(id)) {
        map.removeLayer(marker);
        markers.current.delete(id);
      }
    }
  }, [devices, ready, editing, settings?.map_show_labels, visibleTagNames, tzOffset]);

  /* ------------------------- edit position ------------------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const onClick = (e: L.LeafletMouseEvent) => {
      if (!editing || !placingDevice) return;
      setPending({ id: placingDevice, latitude: Number(e.latlng.lat.toFixed(6)), longitude: Number(e.latlng.lng.toFixed(6)) });
      setPlacingDevice(null);
    };
    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
    };
  }, [ready, editing, placingDevice]);

  const savePosition = async () => {
    if (!pending) return;
    try {
      await api.positions([{ id: pending.id, latitude: pending.latitude, longitude: pending.longitude }]);
      push('موقعیت تجهیز ذخیره شد', 'success');
      setPending(null);
      setEditing(false);
      refresh();
    } catch (e) {
      push((e as Error).message, 'error');
    }
  };

  const flyToDevice = (id: number) => {
    const device = devices.find((d) => d.id === id);
    const map = mapRef.current;
    const lat = device?.latitude;
    const lng = device?.longitude;
    if (!map || lat == null || lng == null) return;
    map.setView([lat, lng], Math.max(map.getZoom(), 14), { animate: true });
    setTimeout(() => markers.current.get(id)?.openPopup(), 450);
  };

  useEffect(() => {
    const target = params.get('device');
    if (target && devices.length) flyToDevice(Number(target));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('device'), devices.length]);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const statusCounts = useMemo(() => {
    const out: Record<string, number> = { online: 0, warning: 0, offline: 0, maintenance: 0, unknown: 0 };
    devices.forEach((d) => {
      out[d.status] = (out[d.status] ?? 0) + 1;
    });
    return out;
  }, [devices]);

  const missingGeo = (devicePage?.total ?? 0) - devices.length;

  return (
    <div className="space-y-4">
      <Card padded={false} className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[200px] flex-1">
            <Search size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-400" />
            <input className="field !rounded-pill pr-9" placeholder="جست‌وجوی تجهیز روی نقشه…" value={query.search} onChange={(e) => setParam('search', e.target.value)} />
          </div>
          <select className="field !w-auto !rounded-pill" value={query.status} onChange={(e) => setParam('status', e.target.value)}>
            <option value="">همه وضعیت‌ها</option>
            <option value="online">در دسترس</option>
            <option value="warning">دارای اختلال</option>
            <option value="offline">قطع‌شده</option>
            <option value="maintenance">در تعمیرات</option>
          </select>
          <select className="field !w-auto !rounded-pill" value={query.group} onChange={(e) => setParam('group', e.target.value)}>
            <option value="">همه گروه‌ها</option>
            {(meta?.groups ?? []).map((g) => (
              <option key={g.id} value={g.name}>
                {g.name}
              </option>
            ))}
          </select>
          <select className="field !w-auto !rounded-pill" value={query.tag} onChange={(e) => setParam('tag', e.target.value)}>
            <option value="">همه تگ‌ها</option>
            {(meta?.tags ?? []).map((t) => (
              <option key={t.id} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>

          <div className="ms-auto flex flex-wrap items-center gap-2">
            <button type="button" className={`btn-xs ${editing ? 'btn-warn' : 'btn-ghost'}`} onClick={() => { setEditing((v) => !v); setPlacingDevice(null); setPending(null); }}>
              <Crosshair size={14} />
              {editing ? 'حالت ویرایش موقعیت' : 'ویرایش موقعیت'}
            </button>
            <button type="button" className="btn-ghost btn-xs" onClick={() => setLayersOpen(true)}>
              <Layers size={14} />
              لایه‌های نقشه
            </button>
            <a className="btn-ghost btn-xs" href={downloadUrl('/devices/export/geo', { format: 'xlsx' })}>
              <Download size={14} />
              خروجی مختصات
            </a>
            <button type="button" className="btn-ghost btn-xs" onClick={refresh}>
              <RefreshCw size={14} />
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-ink-100 pt-3">
          {(['online', 'warning', 'offline', 'maintenance'] as const).map((s) => {
            const sm = statusMeta(s);
            return (
              <span key={s} className="inline-flex items-center gap-1.5 text-[11px] text-ink-500">
                <span className={`h-2.5 w-2.5 rounded-full ${sm.dot}`} />
                {sm.label}: <span className="num font-medium text-ink-700">{faDigits(statusCounts[s] ?? 0)}</span>
              </span>
            );
          })}
          <span className="text-[11px] text-ink-400">نمایش {faDigits(devices.length)} تجهیز دارای موقعیت روی نقشه</span>
          {missingGeo > 0 ? (
            <span className="chip border-sun-200 bg-sun-50 text-sun-700">
              {faDigits(missingGeo)} تجهیز بدون مختصات جغرافیایی
            </span>
          ) : null}
          <span className="ms-auto inline-flex items-center gap-1.5 text-[11px] text-ink-400">
            <MapPin size={12} />
            {settings?.map_show_labels ? 'برچسب تگ‌ها فعال است' : 'برچسب‌ها غیرفعال است'}
          </span>
        </div>
      </Card>

      {editing ? (
        <div className="animate-fade-up rounded-card border border-sun-200 bg-sun-50/80 p-3 text-[12px] text-sun-800">
          حالت ویرایش فعال است. روی نشانگر تجهیز کلیک کنید و سپس محل جدید را روی نقشه انتخاب کنید.
          {placingDevice ? (
            <span className="ms-2 font-semibold">در انتظار انتخاب محل جدید برای تجهیز #{faDigits(placingDevice)}</span>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-4">
        <div className="xl:col-span-3">
          <div className="relative overflow-hidden rounded-card border border-ink-200/70 bg-white shadow-card">
            <div ref={containerRef} className="h-[520px] w-full sm:h-[620px]" />
            {loading ? <div className="absolute inset-x-0 top-0 h-1 bg-brand-100"><div className="h-full w-1/3 animate-pulse bg-brand-500" /></div> : null}
            {pending ? (
              <div className="absolute inset-x-0 bottom-4 mx-auto flex w-[92%] max-w-lg items-center justify-between gap-3 rounded-soft border border-brand-200 bg-white/97 p-3 shadow-pop backdrop-blur">
                <span className="text-[12px] text-ink-600">
                  موقعیت جدید: <span className="num font-semibold">{pending.latitude}, {pending.longitude}</span>
                </span>
                <div className="flex gap-2">
                  <button type="button" className="btn-ghost btn-xs" onClick={() => setPending(null)}>
                    انصراف
                  </button>
                  <button type="button" className="btn-primary btn-xs" onClick={savePosition}>
                    <Save size={13} />
                    ذخیره موقعیت
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          <style>{`
            .nw-pin { position: relative; display: grid; place-items: center; width: 18px; height: 18px; }
            .nw-dot { width: 12px; height: 12px; border-radius: 999px; background: var(--c); border: 2px solid #fff; box-shadow: 0 2px 8px rgba(15,23,42,.35); display:block; }
            .nw-pulse { position: absolute; inset: 0; border-radius: 999px; opacity: .45; animation: nwPulse 1.8s ease-out infinite; display:block; }
            @keyframes nwPulse { 0% { transform: scale(.7); opacity:.5 } 70% { transform: scale(2); opacity:0 } 100% { opacity:0 } }
            .nw-marker { background: transparent; border: 0; }
            .nw-map-label { position:absolute; inset-inline-start: 16px; top:-2px; white-space:nowrap; background: rgba(255,255,255,.92);
              border: 1px solid rgba(148,163,184,.35); border-radius: 8px; padding: 1px 6px; font-size: 10px; color:#475569;
              font-family: Vazirmatn, Tahoma, sans-serif; direction: rtl; box-shadow: 0 4px 10px -6px rgba(15,23,42,.4); }
          `}</style>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="فهرست تجهیزات روی نقشه" subtitle="برای تمرکز روی هر تجهیز کلیک کنید" icon={<MapPin size={18} />} />
            <div className="mt-3 max-h-[420px] space-y-1.5 overflow-y-auto pe-1">
              {devices.length === 0 ? (
                <EmptyState title="تجهیزی با مختصات یافت نشد" description="ابتدا برای تجهیزات، عرض و طول جغرافیایی ثبت کنید یا فایل مختصات را وارد کنید." icon={<MapPin size={22} />} />
              ) : (
                devices.map((d) => (
                  <div key={d.id} className="flex items-center justify-between gap-2 rounded-soft border border-ink-100 bg-white/70 px-2.5 py-2">
                    <button type="button" className="min-w-0 flex-1 text-right" onClick={() => flyToDevice(d.id)}>
                      <span className="block truncate text-[12px] font-medium text-ink-700">{d.name}</span>
                      <span className="num block text-[10.5px] text-ink-400">
                        {d.latitude?.toFixed(4)}, {d.longitude?.toFixed(4)}
                      </span>
                    </button>
                    <StatusPill status={d.status} size="sm" showLabel={false} />
                    <Link to={`/devices/${d.id}`} className="btn-ghost btn-xs">
                      جزئیات
                    </Link>
                  </div>
                ))
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="تگ‌های روی نقشه" subtitle="نمایش یا مخفی‌سازی برچسب تگ‌ها" icon={<TagIcon size={18} />} />
            <div className="mt-3 space-y-2">
              {(meta?.tags ?? []).map((t) => (
                <div key={t.id} className="flex items-center justify-between gap-2 rounded-soft border border-ink-100 bg-white/70 px-2.5 py-2">
                  <span className="chip" style={{ borderColor: `${t.color}44`, background: `${t.color}12`, color: t.color }}>
                    {t.name}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="num text-[10.5px] text-ink-400">{faDigits(t.device_count ?? 0)} تجهیز</span>
                    <button
                      type="button"
                      className="btn-ghost btn-xs"
                      title={t.show_on_map ? 'مخفی کردن روی نقشه' : 'نمایش روی نقشه'}
                      onClick={async () => {
                        await api.updateTag(t.id, { show_on_map: t.show_on_map ? 0 : 1 });
                        refreshMeta();
                      }}
                    >
                      {t.show_on_map ? <Eye size={13} /> : <EyeOff size={13} />}
                    </button>
                  </span>
                </div>
              ))}
              {(meta?.tags ?? []).length === 0 ? <p className="py-4 text-center text-[11px] text-ink-400">تگی تعریف نشده است</p> : null}
            </div>
          </Card>
        </div>
      </div>

      <LayerManager
        open={layersOpen}
        onClose={() => setLayersOpen(false)}
        layers={layers}
        onChanged={() => {
          refreshLayers();
          refreshMeta();
        }}
      />
    </div>
  );
}

function popupHtml(device: Device, tzOffset: number) {
  const meta = statusMeta(device.status);
  return `
  <div style="min-width:220px">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
      <strong style="font-size:13px;color:#1e293b">${escapeHtml(device.name)}</strong>
      <span style="font-size:10.5px;padding:2px 8px;border-radius:99px;background:${meta.chart}1a;color:${meta.chart};border:1px solid ${meta.chart}33">${meta.label}</span>
    </div>
    <div style="margin-top:8px;font-size:11.5px;color:#475569;display:grid;gap:4px">
      <div style="display:flex;justify-content:space-between"><span style="color:#94a3b8">آدرس IP</span><span style="font-family:monospace">${escapeHtml(device.ip)}</span></div>
      <div style="display:flex;justify-content:space-between"><span style="color:#94a3b8">نوع تجهیز</span><span>${escapeHtml(device.deviceType)}</span></div>
      <div style="display:flex;justify-content:space-between"><span style="color:#94a3b8">گروه</span><span>${escapeHtml(device.groupName ?? '—')}</span></div>
      <div style="display:flex;justify-content:space-between"><span style="color:#94a3b8">تأخیر</span><span>${device.lastRtt == null ? '—' : device.lastRtt.toFixed(1) + ' ms'}</span></div>
      <div style="display:flex;justify-content:space-between"><span style="color:#94a3b8">دسترس‌پذیری</span><span>${device.uptimePct == null ? '—' : device.uptimePct.toFixed(2) + '٪'}</span></div>
      <div style="display:flex;justify-content:space-between"><span style="color:#94a3b8">موقعیت</span><span>${escapeHtml(device.location || '—')}</span></div>
    </div>
    ${
      (device.tags || []).length
        ? `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px">${device.tags
            .map((t) => `<span style="font-size:10px;padding:1px 6px;border-radius:99px;background:${t.color}14;color:${t.color};border:1px solid ${t.color}33">${escapeHtml(t.name)}</span>`)
            .join('')}</div>`
        : ''
    }
    <a href="/devices/${device.id}" style="display:block;margin-top:10px;text-align:center;font-size:11.5px;padding:6px;border-radius:10px;background:#eff6ff;color:#1d4ed8;text-decoration:none">مشاهده صفحه تجهیز</a>
  </div>`;
}

/* ---------------------------- Layer manager ---------------------------- */
function LayerManager({
  open,
  onClose,
  layers,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  layers: MapLayer[];
  onChanged: () => void;
}) {
  const { push } = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const res = await api.uploadLayer(file, name || undefined);
      push(`لایه «${res.layer.name}» با ${faDigits(res.info.tileCount ?? 0)} کاشی بارگذاری شد`, 'success');
      setName('');
      onChanged();
    } catch (e) {
      push((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="مدیریت لایه‌های نقشه"
      subtitle="لایه‌های آفلاین MBTiles را بارگذاری و مدیریت کنید — بدون نیاز به اینترنت"
      footer={
        <button type="button" className="btn-ghost" onClick={onClose}>
          بستن
        </button>
      }
    >
      <div className="space-y-4">
        <div className="rounded-soft border border-brand-100 bg-brand-50/50 p-4">
          <p className="text-[12.5px] font-medium text-brand-800">بارگذاری نقشه آفلاین (.mbtiles)</p>
          <p className="mt-1 text-[11px] text-brand-700/80">
            فایل MBTiles را انتخاب کنید. کاشی‌ها از همان فایل و به‌صورت کاملاً آفلاین سرو می‌شوند.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input className="field !w-auto flex-1" placeholder="نام نمایشی لایه (اختیاری)" value={name} onChange={(e) => setName(e.target.value)} />
            <input
              ref={fileRef}
              type="file"
              accept=".mbtiles"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload(f);
                e.currentTarget.value = '';
              }}
            />
            <button type="button" className="btn-primary btn-xs" disabled={busy} onClick={() => fileRef.current?.click()}>
              <Upload size={14} />
              {busy ? 'در حال بارگذاری…' : 'انتخاب فایل MBTiles'}
            </button>
          </div>
        </div>

        <div className="space-y-2">
          {layers.map((l) => (
            <div key={l.id} className="rounded-soft border border-ink-200 bg-white/80 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-[12.5px] font-semibold text-ink-700">{l.name}</p>
                    {l.is_default ? <Badge tone="brand">پیش‌فرض</Badge> : null}
                    <Badge tone={l.kind === 'mbtiles' ? 'emerald' : l.kind === 'builtin' ? 'brand' : 'ink'}>
                      {l.kind === 'mbtiles' ? 'MBTiles' : l.kind === 'builtin' ? 'داخلی' : 'خالی'}
                    </Badge>
                  </div>
                  <p className="mt-1 text-[11px] text-ink-500">{l.description || '—'}</p>
                  <p className="num mt-1 text-[10.5px] text-ink-400">
                    {l.file_name ? `${l.file_name} · ` : ''}
                    {faDigits(l.tile_count ?? 0)} کاشی · زوم {faDigits(l.min_zoom)} تا {faDigits(l.max_zoom)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Toggle
                    checked={!!l.visible}
                    onChange={async (v) => {
                      await api.updateLayer(l.id, { visible: v ? 1 : 0 });
                      onChanged();
                    }}
                    label={l.visible ? 'نمایش' : 'مخفی'}
                  />
                  {!l.is_default ? (
                    <button
                      type="button"
                      className="btn-ghost btn-xs"
                      onClick={async () => {
                        await api.updateLayer(l.id, { is_default: 1 });
                        onChanged();
                        push('لایه پیش‌فرض تغییر کرد', 'success');
                      }}
                    >
                      <Save size={13} />
                      پیش‌فرض
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn-danger btn-xs"
                    onClick={async () => {
                      if (!window.confirm(`لایه «${l.name}» حذف شود؟`)) return;
                      await api.deleteLayer(l.id, l.kind === 'mbtiles');
                      onChanged();
                      push('لایه حذف شد', 'success');
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-soft border border-ink-200 bg-white/70 p-3">
          <span className="text-[11.5px] text-ink-500">ایجاد لایه خالی برای دسته‌بندی تجهیزات:</span>
          <button
            type="button"
            className="btn-soft btn-xs"
            onClick={async () => {
              const label = window.prompt('نام لایه جدید:');
              if (!label) return;
              await api.createLayer({ name: label, kind: 'empty' });
              onChanged();
              push('لایه جدید ساخته شد', 'success');
            }}
          >
            <Plus size={13} />
            افزودن لایه
          </button>
        </div>
      </div>
    </Modal>
  );
}
