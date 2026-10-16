import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Camera,
  CirclePlus,
  Crosshair,
  Download,
  Eye,
  Flag,
  Hammer,
  HardHat,
  Layers,
  MapPin,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Star,
  Trash2,
  TriangleAlert,
  Upload,
  Wifi,
  Wrench,
  X,
} from 'lucide-react';
import { api, downloadUrl } from '../lib/api';
import { useApp, useAsync, useToast } from '../lib/store';
import { faDigits, statusMeta } from '../lib/format';
import { Badge, Card, EmptyState, Field, Modal, StatusPill, Toggle } from '../components/ui';
import type { Device, MapLayer, MapMarker, MarkerType } from '../lib/types';
// فقط برای اعلام نوع‌های افزوده‌شده به Leaflet؛ در زمان اجرا کتابخانهٔ MapLibre
// تنها وقتی لایهٔ برداری واقعی روی نقشه وجود داشته باشد بارگذاری می‌شود.
import type * as _LeafletMaplibreGL from '@maplibre/maplibre-gl-leaflet';

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

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function markerIcon(device: Device, showLabel: boolean) {
  const meta = statusMeta(device.status);
  const label = showLabel ? `<span class="nw-map-label">${escapeHtml(device.name)}</span>` : '';
  const pulse = device.status === 'offline' ? `<span class="nw-pulse" style="background:${meta.chart}"></span>` : '';
  return L.divIcon({
    className: 'nw-marker',
    html: `<span class="nw-pin" style="--c:${meta.chart}">${pulse}<span class="nw-dot"></span></span>${label}`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function markerPinIcon(marker: MapMarker, showLabel: boolean) {
  const color = marker.typeColor || '#0ea5e9';
  const label = showLabel ? `<span class="nw-map-label">${escapeHtml(marker.name)}</span>` : '';
  return L.divIcon({
    className: 'nw-marker',
    html: `<span class="nw-flag" style="--c:${color}"><svg width="20" height="26" viewBox="0 0 20 26"><path d="M10 0C4.48 0 0 4.48 0 10c0 7.5 10 16 10 16s10-8.5 10-16C20 4.48 15.52 0 10 0z" fill="${color}"/><circle cx="10" cy="10" r="4" fill="#fff"/></svg></span>${label}`,
    iconSize: [20, 26],
    iconAnchor: [10, 26],
    popupAnchor: [0, -22],
  });
}

/* --------------------------- آیکون علامت‌ها --------------------------- */
const MARKER_ICON_NAMES = ['map-pin', 'hammer', 'eye', 'triangle-alert', 'circle-plus', 'wrench', 'camera', 'wifi', 'flag', 'star', 'hard-hat'];

export function MarkerGlyph({ name, size = 14, className = '' }: { name?: string | null; size?: number; className?: string }) {
  const props = { size, className };
  switch ((name || 'map-pin').toLowerCase()) {
    case 'hammer':
      return <Hammer {...props} />;
    case 'eye':
      return <Eye {...props} />;
    case 'triangle-alert':
      return <TriangleAlert {...props} />;
    case 'circle-plus':
      return <CirclePlus {...props} />;
    case 'wrench':
      return <Wrench {...props} />;
    case 'camera':
      return <Camera {...props} />;
    case 'wifi':
      return <Wifi {...props} />;
    case 'flag':
      return <Flag {...props} />;
    case 'star':
      return <Star {...props} />;
    case 'hard-hat':
      return <HardHat {...props} />;
    default:
      return <MapPin {...props} />;
  }
}

const isVectorLayer = (layer: MapLayer) => {
  const fmt = String(layer.fileInfo?.format || '').toLowerCase();
  return fmt.includes('pbf') || fmt.includes('mvt') || fmt.includes('vector');
};

function buildVectorStyle(layer: MapLayer) {
  const vectorLayers = layer.fileInfo?.vectorLayers ?? [];
  const palette = ['#2563eb', '#16a34a', '#f59e0b', '#db2777', '#7c3aed', '#0891b2', '#dc2626', '#0d9488'];
  const source = 'netwatch';
  const styleLayers: Record<string, unknown>[] = [];
  vectorLayers.forEach((vl, i) => {
    const color = palette[i % palette.length];
    styleLayers.push({
      id: `fill-${vl.id}`,
      type: 'fill',
      source,
      'source-layer': vl.id,
      paint: { 'fill-color': color, 'fill-opacity': 0.22 },
    });
    styleLayers.push({
      id: `line-${vl.id}`,
      type: 'line',
      source,
      'source-layer': vl.id,
      paint: { 'line-color': color, 'line-width': 1 },
    });
    styleLayers.push({
      id: `point-${vl.id}`,
      type: 'circle',
      source,
      'source-layer': vl.id,
      paint: { 'circle-radius': 3, 'circle-color': color },
    });
  });
  return {
    version: 8,
    glyphs: undefined,
    sources: {
      [source]: {
        type: 'vector',
        tiles: [`${window.location.origin}/api/tiles/${layer.id}/{z}/{x}/{y}.pbf`],
        minzoom: layer.min_zoom ?? 0,
        maxzoom: layer.max_zoom ?? 19,
      },
    },
    layers: styleLayers,
  };
}

export default function MapPage() {
  const { settings, meta, refreshMeta } = useApp();
  const { push } = useToast();
  const [params, setParams] = useSearchParams();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayers = useRef<Record<number, L.Layer>>({});
  const markers = useRef<Map<number, L.Marker>>(new Map());
  const markerPins = useRef<Map<number, L.Marker>>(new Map());
  const [ready, setReady] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<{ id: number; latitude: number; longitude: number } | null>(null);
  const [layersOpen, setLayersOpen] = useState(false);
  const [placingDevice, setPlacingDevice] = useState<number | null>(null);
  const [listOpen, setListOpen] = useState(true);
  const [markersOpen, setMarkersOpen] = useState(true);
  const [armedType, setArmedType] = useState<{ typeId: number; typeName: string; typeColor: string; typeIcon: string } | null>(null);
  const [pendingMarker, setPendingMarker] = useState<{ latitude: number; longitude: number; typeId: number | null; typeName: string; typeColor: string; typeIcon: string; marker?: MapMarker } | null>(null);
  const [showMarkerLabels, setShowMarkerLabels] = useState(true);

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
  const { data: markersData, refresh: refreshMarkers } = useAsync(() => api.markers(), []);
  const devices = devicePage?.items ?? [];
  const layers = layersData?.items ?? [];
  const mapMarkers = markersData?.items ?? [];
  const markerTypes = markersData?.types ?? [];

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
      markers.current.clear();
      markerPins.current.clear();
      tileLayers.current = {};
      setPending(null);
      setPendingMarker(null);
      setPlacingDevice(null);
      setEditing(false);
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
    let alive = true;
    const wanted = new Set<number>();
    const ensure = async () => {
      for (const layer of layers) {
        if (!layer.visible) continue;
        wanted.add(layer.id);
        if (tileLayers.current[layer.id]) continue;
        let instance: L.Layer | null = null;
        if (layer.kind === 'mbtiles' && layer.file_name) {
          if (isVectorLayer(layer)) {
            try {
              await import('@maplibre/maplibre-gl-leaflet');
              const factory = (L as unknown as { maplibreGL?: (o: Record<string, unknown>) => L.Layer }).maplibreGL;
              if (factory) instance = factory({ style: buildVectorStyle(layer), attributionControl: false, interactive: false });
            } catch {
              push(`لایهٔ برداری «${layer.name}» بارگذاری نشد`, 'error');
            }
          } else {
            instance = L.tileLayer(`/api/tiles/${layer.id}/{z}/{x}/{y}.png`, {
              minZoom: layer.min_zoom ?? 0,
              maxZoom: layer.max_zoom ?? 19,
              maxNativeZoom: layer.max_zoom ?? 19,
              tileSize: 256,
              noWrap: false,
              attribution: layer.attribution || '',
            });
          }
        } else {
          instance = new OfflineGridLayer({ tileSize: 256, minZoom: 0, maxZoom: 20 });
        }
        if (instance && alive && mapRef.current === map) {
          instance.addTo(map);
          tileLayers.current[layer.id] = instance;
        }
      }
      if (!alive) return;
      for (const [id, instance] of Object.entries(tileLayers.current)) {
        if (!wanted.has(Number(id))) {
          map.removeLayer(instance);
          delete tileLayers.current[Number(id)];
        }
      }
      for (const layer of layers.filter((l) => l.visible)) {
        const inst = tileLayers.current[layer.id] as L.GridLayer | undefined;
        if (inst && typeof inst.bringToBack === 'function') inst.bringToBack();
      }
    };
    ensure();
    return () => {
      alive = false;
    };
  }, [layers, ready, push]);

  /* --------------------------- device markers --------------------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const current = new Set<number>();
    for (const device of devices) {
      const lat = device.latitude;
      const lng = device.longitude;
      if (lat == null || lng == null) continue;
      current.add(device.id);
      const showLabel = !!settings?.map_show_labels;
      const icon = markerIcon(device, showLabel);
      let marker = markers.current.get(device.id);
      if (!marker) {
        marker = L.marker([lat, lng], { icon, riseOnHover: true }).addTo(map);
        marker.on('click', () => {
          if (editing) {
            setPlacingDevice(device.id);
            return;
          }
          marker?.openPopup();
          map.panTo([lat, lng]);
        });
        markers.current.set(device.id, marker);
      } else {
        marker.setLatLng([lat, lng]);
        marker.setIcon(icon);
      }
      marker.bindPopup(popupHtml(device), { closeButton: true, minWidth: 220 });
    }

    for (const [id, marker] of markers.current.entries()) {
      if (!current.has(id)) {
        map.removeLayer(marker);
        markers.current.delete(id);
      }
    }
  }, [devices, ready, editing, settings?.map_show_labels]);

  /* --------------------------- map markers (علامت‌ها) --------------------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const current = new Set<number>();
    for (const marker of mapMarkers) {
      current.add(marker.id);
      const icon = markerPinIcon(marker, showMarkerLabels);
      let pin = markerPins.current.get(marker.id);
      if (!pin) {
        pin = L.marker([marker.latitude, marker.longitude], { icon, riseOnHover: true }).addTo(map);
        markerPins.current.set(marker.id, pin);
      } else {
        pin.setLatLng([marker.latitude, marker.longitude]);
        pin.setIcon(icon);
      }
      pin.bindPopup(markerPopupHtml(marker), { closeButton: true, minWidth: 200 });
    }
    for (const [id, pin] of markerPins.current.entries()) {
      if (!current.has(id)) {
        map.removeLayer(pin);
        markerPins.current.delete(id);
      }
    }
  }, [mapMarkers, ready, showMarkerLabels]);

  /* ------------------------- edit / place on map ------------------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const onClick = (e: L.LeafletMouseEvent) => {
      const lat = Number(e.latlng.lat.toFixed(6));
      const lng = Number(e.latlng.lng.toFixed(6));
      if (armedType) {
        setPendingMarker({ latitude: lat, longitude: lng, typeId: armedType.typeId, typeName: armedType.typeName, typeColor: armedType.typeColor, typeIcon: armedType.typeIcon });
        setArmedType(null);
        return;
      }
      if (editing && placingDevice) {
        setPending({ id: placingDevice, latitude: lat, longitude: lng });
        setPlacingDevice(null);
      }
    };
    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
    };
  }, [ready, editing, placingDevice, armedType]);

  /* ------------------------- drag & drop از فهرست به نقشه ------------------------- */
  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const map = mapRef.current;
    if (!map) return;
    const raw = e.dataTransfer.getData('text/nw-device') || e.dataTransfer.getData('text/plain');
    const id = Number(raw);
    if (!id) return;
    const latlng = map.mouseEventToLatLng(e.nativeEvent);
    const latitude = Number(latlng.lat.toFixed(6));
    const longitude = Number(latlng.lng.toFixed(6));
    const device = devices.find((d) => d.id === id);
    try {
      await api.positions([{ id, latitude, longitude }]);
      push(`موقعیت «${device?.name ?? `#${id}`}» روی نقشه ثبت شد`, 'success');
      refresh();
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

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

  const flyToMarker = (m: MapMarker) => {
    const map = mapRef.current;
    if (!map) return;
    map.setView([m.latitude, m.longitude], Math.max(map.getZoom(), 14), { animate: true });
    setTimeout(() => markerPins.current.get(m.id)?.openPopup(), 450);
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

          <div className="ms-auto flex flex-wrap items-center gap-2">
            <button type="button" className={`btn-xs ${listOpen ? 'btn-soft' : 'btn-ghost'}`} onClick={() => setListOpen((v) => !v)}>
              {listOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
              فهرست تجهیزات
            </button>
            <button type="button" className={`btn-xs ${markersOpen ? 'btn-soft' : 'btn-ghost'}`} onClick={() => setMarkersOpen((v) => !v)}>
              <Flag size={14} />
              علامت‌ها
            </button>
            <button type="button" className={`btn-xs ${editing ? 'btn-warn' : 'btn-ghost'}`} onClick={() => { setEditing((v) => !v); setPlacingDevice(null); setPending(null); setArmedType(null); }}>
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
            <span className="chip border-sun-200 bg-sun-50 text-sun-700">{faDigits(missingGeo)} تجهیز بدون مختصات جغرافیایی</span>
          ) : null}
          <span className="ms-auto inline-flex items-center gap-1.5 text-[11px] text-ink-400">
            <MapPin size={12} />
            {faDigits(mapMarkers.length)} علامت روی نقشه
          </span>
        </div>
      </Card>

      {editing ? (
        <div className="animate-fade-up rounded-card border border-sun-200 bg-sun-50/80 p-3 text-[12px] text-sun-800">
          حالت ویرایش فعال است. روی نشانگر تجهیز کلیک کنید و سپس محل جدید را روی نقشه انتخاب کنید — یا تجهیز را از فهرست بکشید و روی نقشه رها کنید.
          {placingDevice ? <span className="ms-2 font-semibold">در انتظار انتخاب محل جدید برای تجهیز #{faDigits(placingDevice)}</span> : null}
        </div>
      ) : null}

      {armedType ? (
        <div className="animate-fade-up rounded-card border border-brand-200 bg-brand-50/80 p-3 text-[12px] text-brand-800">
          برای جانمایی علامت «{armedType.typeName}» روی نقشه کلیک کنید.
          <button type="button" className="btn-ghost btn-xs ms-2" onClick={() => setArmedType(null)}>
            انصراف
          </button>
        </div>
      ) : null}

      {/* چیدمان: پنل علامت‌ها (راست) · نقشه (مرکز) · فهرست تجهیزات (چپ) */}
      <div className="flex flex-col gap-4 xl:flex-row xl:items-stretch">
        {markersOpen ? (
          <MarkersPanel
            className="shrink-0 h-[340px] xl:h-[620px] xl:w-[304px]"
            types={markerTypes}
            markers={mapMarkers}
            showLabels={showMarkerLabels}
            onToggleLabels={setShowMarkerLabels}
            armedTypeId={armedType?.typeId ?? null}
            onArm={(t) => setArmedType({ typeId: t.id, typeName: t.name, typeColor: t.color, typeIcon: t.icon })}
            onFlyTo={flyToMarker}
            onEdit={(m) => setPendingMarker({ latitude: m.latitude, longitude: m.longitude, typeId: m.typeId, typeName: m.typeName ?? '', typeColor: m.typeColor ?? '#0ea5e9', typeIcon: m.typeIcon ?? 'map-pin', marker: m })}
            onChanged={() => {
              refreshMarkers();
              refreshMeta();
            }}
            onClose={() => setMarkersOpen(false)}
          />
        ) : null}

        <div className="min-w-0 flex-1">
          <div className="relative overflow-hidden rounded-card border border-ink-200/70 bg-white shadow-card">
            <div
              ref={containerRef}
              className="h-[520px] w-full sm:h-[620px]"
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
            />
            {loading ? (
              <div className="absolute inset-x-0 top-0 h-1 bg-brand-100">
                <div className="h-full w-1/3 animate-pulse bg-brand-500" />
              </div>
            ) : null}
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
            .nw-flag { display:block; filter: drop-shadow(0 2px 4px rgba(15,23,42,.35)); }
            .nw-map-label { position:absolute; inset-inline-start: 16px; top:-2px; white-space:nowrap; background: rgba(255,255,255,.92);
              border: 1px solid rgba(148,163,184,.35); border-radius: 8px; padding: 1px 6px; font-size: 10px; color:#475569;
              font-family: Vazirmatn, Tahoma, sans-serif; direction: rtl; box-shadow: 0 4px 10px -6px rgba(15,23,42,.4); }
          `}</style>
        </div>

        {listOpen ? (
          <DevicePanel
            className="shrink-0 h-[320px] xl:h-[620px] xl:w-[300px]"
            devices={devices}
            selectedId={pending?.id ?? placingDevice ?? null}
            onFlyTo={flyToDevice}
            onClose={() => setListOpen(false)}
            onDragStart={(id) => {
              if (editing) setPlacingDevice(id);
            }}
          />
        ) : null}
      </div>

      <MarkerForm
        open={!!pendingMarker}
        draft={pendingMarker}
        types={markerTypes}
        onClose={() => setPendingMarker(null)}
        onSaved={() => {
          setPendingMarker(null);
          refreshMarkers();
        }}
      />

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

/* ============================== پنل تجهیزات ============================== */
function DevicePanel({
  devices,
  className,
  selectedId,
  onFlyTo,
  onClose,
  onDragStart,
}: {
  devices: Device[];
  className?: string;
  selectedId: number | null;
  onFlyTo: (id: number) => void;
  onClose: () => void;
  onDragStart: (id: number) => void;
}) {
  return (
    <Card className={`flex flex-col overflow-hidden ${className}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-[14px] font-semibold text-ink-800">
            <MapPin size={16} className="text-brand-500" />
            فهرست تجهیزات
          </h3>
          <p className="mt-0.5 text-[11px] text-ink-500">بکشید و روی نقشه رها کنید تا جانمایی شود</p>
        </div>
        <button type="button" className="btn-ghost btn-xs" onClick={onClose} title="مخفی کردن فهرست">
          <X size={13} />
        </button>
      </div>

      <div className="mt-3 min-h-0 flex-1 space-y-1.5 overflow-y-auto pe-1">
        {devices.length === 0 ? (
          <EmptyState title="تجهیزی با مختصات یافت نشد" description="برای تجهیزات عرض و طول جغرافیایی ثبت کنید یا از فهرست بکشید و روی نقشه رها کنید." icon={<MapPin size={22} />} />
        ) : (
          devices.map((d) => (
            <div
              key={d.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/nw-device', String(d.id));
                e.dataTransfer.setData('text/plain', String(d.id));
                e.dataTransfer.effectAllowed = 'move';
                onDragStart(d.id);
              }}
              className={`flex cursor-grab items-center justify-between gap-2 rounded-soft border bg-white/70 px-2.5 py-2 transition active:cursor-grabbing ${
                selectedId === d.id ? 'border-brand-300 ring-1 ring-brand-200' : 'border-ink-100 hover:border-brand-200'
              }`}
              title="برای جانمایی، بکشید و روی نقشه رها کنید"
            >
              <button type="button" className="min-w-0 flex-1 text-right" onClick={() => onFlyTo(d.id)}>
                <span className="block truncate text-[12px] font-medium text-ink-700">{d.name}</span>
                <span className="num block text-[10.5px] text-ink-400">
                  {d.latitude == null ? 'بدون مختصات' : `${d.latitude.toFixed(4)}, ${d.longitude?.toFixed(4)}`}
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
  );
}

/* ============================== پنل علامت‌ها ============================== */
function MarkersPanel({
  types,
  markers,
  className,
  showLabels,
  onToggleLabels,
  armedTypeId,
  onArm,
  onFlyTo,
  onEdit,
  onChanged,
  onClose,
}: {
  types: MarkerType[];
  markers: MapMarker[];
  className?: string;
  showLabels: boolean;
  onToggleLabels: (v: boolean) => void;
  armedTypeId: number | null;
  onArm: (t: MarkerType) => void;
  onFlyTo: (m: MapMarker) => void;
  onEdit: (m: MapMarker) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { push } = useToast();
  const [tab, setTab] = useState<'place' | 'types'>('place');
  const [typeForm, setTypeForm] = useState<Partial<MarkerType> | null>(null);
  const [filterType, setFilterType] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const filtered = filterType === '' ? markers : markers.filter((m) => m.typeId === filterType);

  const importFile = async (file: File) => {
    setBusy(true);
    try {
      const res = await api.markerImport(file, 'append');
      push(`${faDigits(res.inserted)} علامت وارد شد${res.skipped ? ` — ${faDigits(res.skipped)} ردیف نامعتبر` : ''}`, res.inserted ? 'success' : 'warning');
      onChanged();
    } catch (e) {
      push((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className={`flex flex-col overflow-hidden ${className}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-[14px] font-semibold text-ink-800">
            <Flag size={16} className="text-brand-500" />
            علامت‌های نقشه
          </h3>
          <p className="mt-0.5 text-[11px] text-ink-500">انواع علامت را تعریف و روی نقشه جانمایی کنید</p>
        </div>
        <button type="button" className="btn-ghost btn-xs" onClick={onClose} title="مخفی کردن پنل علامت‌ها">
          <X size={13} />
        </button>
      </div>

      <div className="mt-3 flex items-center gap-1 rounded-soft bg-ink-100/70 p-1 text-[11.5px]">
        <button
          type="button"
          className={`flex-1 rounded-lg px-2 py-1.5 font-medium transition ${tab === 'place' ? 'bg-white text-brand-700 shadow-soft' : 'text-ink-500'}`}
          onClick={() => setTab('place')}
        >
          جانمایی ({faDigits(markers.length)})
        </button>
        <button
          type="button"
          className={`flex-1 rounded-lg px-2 py-1.5 font-medium transition ${tab === 'types' ? 'bg-white text-brand-700 shadow-soft' : 'text-ink-500'}`}
          onClick={() => setTab('types')}
        >
          انواع علامت ({faDigits(types.length)})
        </button>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <Toggle checked={showLabels} onChange={onToggleLabels} label="برچسب نام" />
      </div>

      {tab === 'place' ? (
        <div className="mt-3 flex min-h-0 flex-1 flex-col">
          <select className="field !w-full !rounded-pill !py-1.5 text-[12px]" value={filterType} onChange={(e) => setFilterType(e.target.value ? Number(e.target.value) : '')}>
            <option value="">همه انواع علامت</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>

          <div className="mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto pe-1">
            {filtered.length === 0 ? (
              <p className="py-6 text-center text-[11px] text-ink-400">علامتی جانمایی نشده است</p>
            ) : (
              filtered.map((m) => (
                <div key={m.id} className="flex items-center justify-between gap-2 rounded-soft border border-ink-100 bg-white/70 px-2.5 py-2">
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-right" onClick={() => onFlyTo(m)}>
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full" style={{ background: `${m.typeColor || '#0ea5e9'}1f`, color: m.typeColor || '#0ea5e9' }}>
                      <MarkerGlyph name={m.typeIcon} size={13} />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] font-medium text-ink-700">{m.name}</span>
                      <span className="num block text-[10px] text-ink-400">
                        {m.typeName} · {m.latitude.toFixed(4)}, {m.longitude.toFixed(4)}
                      </span>
                    </span>
                  </button>
                  <button type="button" className="btn-ghost btn-xs" title="ویرایش" onClick={() => onEdit(m)}>
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    className="btn-danger btn-xs"
                    title="حذف"
                    onClick={async () => {
                      if (!window.confirm(`علامت «${m.name}» حذف شود؟`)) return;
                      await api.deleteMarker(m.id);
                      push('علامت حذف شد', 'success');
                      onChanged();
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="mt-2 space-y-2 border-t border-ink-100 pt-2">
            <button
              type="button"
              className="btn-primary btn-xs w-full justify-center"
              disabled={!types.length}
              onClick={() => {
                const t = types.find((x) => x.id === filterType) ?? types[0];
                if (t) onArm(t);
              }}
            >
              <Crosshair size={13} />
              جانمایی علامت روی نقشه
            </button>
            {armedTypeId ? <p className="text-center text-[10.5px] text-brand-600">در انتظار کلیک روی نقشه…</p> : null}

            <div className="flex flex-wrap items-center gap-1.5">
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.currentTarget.value = ''; }} />
              <button type="button" className="btn-ghost btn-xs flex-1 justify-center" disabled={busy} onClick={() => fileRef.current?.click()}>
                <Upload size={12} />
                ورود از فایل
              </button>
              <a className="btn-ghost btn-xs flex-1 justify-center" href={downloadUrl('/markers/export', { format: 'xlsx' })}>
                <Download size={12} />
                خروجی
              </a>
              <a className="btn-ghost btn-xs flex-1 justify-center" href={downloadUrl('/markers/template', { format: 'xlsx' })}>
                <Download size={12} />
                فایل نمونه
              </a>
            </div>
            <p className="text-[10px] leading-relaxed text-ink-400">
              قالب ورود: نام علامت، نوع علامت، عرض جغرافیایی، طول جغرافیایی، توضیحات. انواع ناشناخته به‌صورت خودکار ساخته می‌شوند.
            </p>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pe-1">
            {types.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-2 rounded-soft border border-ink-100 bg-white/70 px-2.5 py-2">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full" style={{ background: `${t.color}1f`, color: t.color }}>
                    <MarkerGlyph name={t.icon} size={13} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-medium text-ink-700">{t.name}</span>
                    <span className="num block text-[10px] text-ink-400">{faDigits(t.markerCount ?? 0)} علامت</span>
                  </span>
                </span>
                <button type="button" className="btn-ghost btn-xs" onClick={() => setTypeForm(t)}>
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  className="btn-danger btn-xs"
                  onClick={async () => {
                    if (!window.confirm(`نوع «${t.name}» حذف شود؟ علامت‌های این نوع بدون نوع خواهند شد.`)) return;
                    await api.deleteMarkerType(t.id);
                    push('نوع علامت حذف شد', 'success');
                    onChanged();
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            {types.length === 0 ? <p className="py-6 text-center text-[11px] text-ink-400">نوعی تعریف نشده است</p> : null}
          </div>
          <button type="button" className="btn-soft btn-xs mt-2 w-full justify-center" onClick={() => setTypeForm({})}>
            <Plus size={13} />
            نوع علامت جدید
          </button>
        </div>
      )}

      {typeForm ? <MarkerTypeForm draft={typeForm} onClose={() => setTypeForm(null)} onSaved={() => { setTypeForm(null); onChanged(); }} /> : null}
    </Card>
  );
}

/* ---------------------------- فرم نوع علامت ---------------------------- */
function MarkerTypeForm({ draft, onClose, onSaved }: { draft: Partial<MarkerType>; onClose: () => void; onSaved: () => void }) {
  const { push } = useToast();
  const editing = !!draft.id;
  const [name, setName] = useState(draft.name ?? '');
  const [color, setColor] = useState(draft.color ?? '#0ea5e9');
  const [icon, setIcon] = useState(draft.icon ?? 'map-pin');
  const [description, setDescription] = useState(draft.description ?? '');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return setError('نام نوع علامت الزامی است');
    try {
      if (editing) await api.updateMarkerType(draft.id!, { name, color, icon, description });
      else await api.createMarkerType({ name, color, icon, description });
      push(editing ? 'نوع علامت به‌روزرسانی شد' : 'نوع علامت ساخته شد', 'success');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal
      open
      size="sm"
      onClose={onClose}
      title={editing ? `ویرایش نوع — ${draft.name}` : 'نوع علامت جدید'}
      subtitle="نام، رنگ و آیکون این نوع علامت را مشخص کنید"
      footer={
        <>
          {error ? <p className="me-auto text-xs text-red-600">{error}</p> : null}
          <button type="button" className="btn-ghost" onClick={onClose}>
            انصراف
          </button>
          <button type="button" className="btn-primary" onClick={submit}>
            ذخیره
          </button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="نام نوع علامت" required className="sm:col-span-2">
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً تجهیز در حال نصب" />
        </Field>
        <Field label="رنگ">
          <input type="color" className="field h-[42px] p-1" value={color} onChange={(e) => setColor(e.target.value)} />
        </Field>
        <Field label="آیکون">
          <select className="field" value={icon} onChange={(e) => setIcon(e.target.value)}>
            {MARKER_ICON_NAMES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        <Field label="توضیحات" className="sm:col-span-2">
          <input className="field" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="sm:col-span-2 flex items-center gap-3 rounded-soft border border-ink-200 bg-white/70 p-3">
          <span className="text-[11.5px] text-ink-500">پیش‌نمایش:</span>
          <span className="grid h-8 w-8 place-items-center rounded-full" style={{ background: `${color}1f`, color }}>
            <MarkerGlyph name={icon} size={16} />
          </span>
          <span className="text-[12.5px] font-medium text-ink-700">{name || 'نام نوع علامت'}</span>
        </div>
      </div>
    </Modal>
  );
}

/* ----------------------------- فرم علامت ----------------------------- */
function MarkerForm({
  open,
  draft,
  types,
  onClose,
  onSaved,
}: {
  open: boolean;
  draft: { latitude: number; longitude: number; typeId: number | null; typeName: string; marker?: MapMarker } | null;
  types: MarkerType[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { push } = useToast();
  const [name, setName] = useState('');
  const [typeId, setTypeId] = useState<string>('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !draft) return;
    setError(null);
    setName(draft.marker?.name ?? '');
    setTypeId(String(draft.marker?.typeId ?? draft.typeId ?? types[0]?.id ?? ''));
    setLatitude(String(draft.marker?.latitude ?? draft.latitude));
    setLongitude(String(draft.marker?.longitude ?? draft.longitude));
    setNotes(draft.marker?.notes ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft]);

  if (!open || !draft) return null;
  const editing = !!draft.marker;

  const submit = async () => {
    if (!name.trim()) return setError('نام علامت الزامی است');
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return setError('عرض جغرافیایی نامعتبر است');
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) return setError('طول جغرافیایی نامعتبر است');
    try {
      const payload = { name: name.trim(), type_id: Number(typeId) || null, latitude: lat, longitude: lng, notes };
      if (editing) await api.updateMarker(draft.marker!.id, payload);
      else await api.createMarker(payload);
      push(editing ? 'علامت به‌روزرسانی شد' : 'علامت روی نقشه جانمایی شد', 'success');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal
      open
      size="sm"
      onClose={onClose}
      title={editing ? `ویرایش علامت — ${draft.marker!.name}` : 'جانمایی علامت جدید'}
      subtitle={editing ? 'مشخصات علامت را ویرایش کنید' : 'نام و نوع این علامت را مشخص کنید'}
      footer={
        <>
          {error ? <p className="me-auto text-xs text-red-600">{error}</p> : null}
          <button type="button" className="btn-ghost" onClick={onClose}>
            انصراف
          </button>
          <button type="button" className="btn-primary" onClick={submit}>
            <Save size={15} />
            ذخیره
          </button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="نام علامت" required className="sm:col-span-2">
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً نصب سوئیچ — ساختمان اداری" />
        </Field>
        <Field label="نوع علامت" className="sm:col-span-2">
          <select className="field" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="عرض جغرافیایی">
          <input dir="ltr" className="field num" value={latitude} onChange={(e) => setLatitude(e.target.value)} />
        </Field>
        <Field label="طول جغرافیایی">
          <input dir="ltr" className="field num" value={longitude} onChange={(e) => setLongitude(e.target.value)} />
        </Field>
        <Field label="توضیحات" className="sm:col-span-2">
          <textarea className="field min-h-[70px]" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/* ---------------------------- popups ---------------------------- */
function popupHtml(device: Device) {
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
      <div style="display:flex;justify-content:space-between"><span style="color:#94a3b8">موقعیت</span><span>${escapeHtml(device.location || '—')}</span></div>
    </div>
    <a href="/devices/${device.id}" style="display:block;margin-top:10px;text-align:center;font-size:11.5px;padding:6px;border-radius:10px;background:#eff6ff;color:#1d4ed8;text-decoration:none">مشاهده صفحه تجهیز</a>
  </div>`;
}

function markerPopupHtml(m: MapMarker) {
  return `
  <div style="min-width:200px">
    <div style="display:flex;align-items:center;gap:8px">
      <span style="display:inline-block;width:10px;height:10px;border-radius:99px;background:${m.typeColor || '#0ea5e9'}"></span>
      <strong style="font-size:13px;color:#1e293b">${escapeHtml(m.name)}</strong>
    </div>
    <div style="margin-top:8px;font-size:11.5px;color:#475569;display:grid;gap:4px">
      <div style="display:flex;justify-content:space-between"><span style="color:#94a3b8">نوع</span><span>${escapeHtml(m.typeName ?? '—')}</span></div>
      <div style="display:flex;justify-content:space-between"><span style="color:#94a3b8">عرض / طول</span><span style="font-family:monospace">${m.latitude.toFixed(5)}, ${m.longitude.toFixed(5)}</span></div>
      ${m.notes ? `<div style="color:#475569">${escapeHtml(m.notes)}</div>` : ''}
    </div>
    <p style="margin-top:8px;font-size:10.5px;color:#94a3b8">برای ویرایش از پنل «علامت‌ها» استفاده کنید.</p>
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
      subtitle="لایه‌های آفلاین MBTiles — هم تصویری (Raster) و هم برداری (Vector) — بدون نیاز به اینترنت"
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
            فایل MBTiles را انتخاب کنید. کاشی‌های تصویری (PNG/JPEG) با Leaflet و کاشی‌های برداری (PBF/MVT) با MapLibre سرو می‌شوند.
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
          {layers.map((l) => {
            const vector = isVectorLayer(l);
            return (
              <div key={l.id} className="rounded-soft border border-ink-200 bg-white/80 p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-[12.5px] font-semibold text-ink-700">{l.name}</p>
                      {l.is_default ? <Badge tone="brand">پیش‌فرض</Badge> : null}
                      <Badge tone={l.kind === 'mbtiles' ? 'emerald' : l.kind === 'builtin' ? 'brand' : 'ink'}>
                        {l.kind === 'mbtiles' ? (vector ? 'MBTiles برداری' : 'MBTiles تصویری') : l.kind === 'builtin' ? 'داخلی' : 'خالی'}
                      </Badge>
                    </div>
                    <p className="mt-1 text-[11px] text-ink-500">{l.description || '—'}</p>
                    <p className="num mt-1 text-[10.5px] text-ink-400">
                      {l.file_name ? `${l.file_name} · ` : ''}
                      {faDigits(l.tile_count ?? 0)} کاشی · زوم {faDigits(l.min_zoom)} تا {faDigits(l.max_zoom)}
                      {vector && l.fileInfo?.vectorLayers?.length ? ` · ${faDigits(l.fileInfo.vectorLayers.length)} لایه برداری` : ''}
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
            );
          })}
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
