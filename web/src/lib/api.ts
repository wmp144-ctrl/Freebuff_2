import type {
  Alert,
  AlertRule,
  AppSettings,
  AuthUser,
  DashboardData,
  Device,
  EngineStatus,
  FlapsData,
  Group,
  MaintenanceRecord,
  MapLayer,
  MapMarker,
  MarkerType,
  OutageTimelineData,
  Paged,
  ReportData,
  Series,
  SimultaneousData,
  Tag,
  TopOutageDevice,
} from './types';

const BASE = '/api';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** توکن CSRF از کوکی خوانده می‌شود (کوکی عمداً HttpOnly نیست) */
function csrfToken(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/(?:^|;\s*)nw_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || undefined);
  if (!(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  // CSRF double-submit: هدر باید با کوکی و با مقدار نشست بخواند.
  if (method !== 'GET' && method !== 'HEAD' && path !== '/auth/login') headers.set('X-CSRF-Token', csrfToken());
  const res = await fetch(`${BASE}${path}`, { ...options, method, headers });
  const type = res.headers.get('content-type') || '';
  if (res.status === 401 && path !== '/auth/login' && path !== '/auth/me') {
    // نشست منقضی شده است؛ لایهٔ احراز هویت صفحهٔ ورود را نشان می‌دهد
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('nw:unauthorized'));
  }
  if (!res.ok) {
    let message = `خطای ${res.status}`;
    if (type.includes('application/json')) {
      try {
        const data = await res.json();
        message = data.error || message;
      } catch {
        /* بی‌اثر */
      }
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  if (type.includes('application/json')) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

export function qs(params: Record<string, string | number | boolean | undefined | null> = {}): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export function downloadUrl(path: string, params: Record<string, string | number | undefined> = {}) {
  return `${BASE}${path}${qs(params)}`;
}

export const api = {
  /* ---------------- احراز هویت ---------------- */
  me: () => request<{ user: AuthUser }>('/auth/me'),
  login: (username: string, password: string) =>
    request<{ user: AuthUser }>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST', body: '{}' }),
  users: () => request<{ items: AuthUser[] }>('/auth/users'),
  createUser: (body: { username: string; password: string; role: 'admin' | 'viewer'; displayName?: string }) =>
    request<AuthUser>('/auth/users', { method: 'POST', body: JSON.stringify(body) }),
  updateUser: (id: number, body: Record<string, unknown>) =>
    request<AuthUser>(`/auth/users/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteUser: (id: number) => request<{ deleted: number }>(`/auth/users/${id}`, { method: 'DELETE' }),

  /* ---------------- داشبورد ---------------- */
  dashboard: () => request<DashboardData>('/dashboard/summary'),

  /* ---------------- تجهیزات ---------------- */
  devices: (params: Record<string, string | number | undefined> = {}) => request<Paged<Device>>(`/devices${qs(params)}`),
  device: (id: number | string) => request<Device>(`/devices/${id}`),
  deviceMeta: () =>
    request<{
      groups: Group[];
      tags: Tag[];
      types: { value: string; count: number }[];
      locations: { value: string; count: number }[];
      vendors: { value: string; count: number }[];
      priorities: { value: string; count: number }[];
      layers: MapLayer[];
      settings: AppSettings;
      highLatency: number;
    }>('/devices/meta'),
  createDevice: (body: Partial<Device> & Record<string, unknown>) =>
    request<Device>('/devices', { method: 'POST', body: JSON.stringify(body) }),
  updateDevice: (id: number | string, body: Record<string, unknown>) =>
    request<Device>(`/devices/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteDevice: (id: number | string) => request<{ deleted: number }>(`/devices/${id}`, { method: 'DELETE' }),
  pingDevice: (id: number | string, body: Record<string, unknown> = {}) =>
    request<{ result: { ok: boolean; rtt: number | null; mode: string; error?: string }; device: Device }>(`/devices/${id}/ping`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  bulk: (ids: number[], action: string, payload: Record<string, unknown> = {}) =>
    request<{ affected?: number; queued?: boolean }>('/devices/bulk', { method: 'POST', body: JSON.stringify({ ids, action, payload }) }),
  series: (id: number | string, range: string) => request<Series>(`/devices/${id}/series?range=${range}`),
  outages: (id: number | string, limit = 100) =>
    request<{ total: number; open: { id: number; started_at: number; durationSec: number } | null; items: import('./types').Outage[] }>(
      `/devices/${id}/outages?limit=${limit}`
    ),
  samples: (id: number | string, limit = 200) =>
    request<{ items: { ts: number; rtt: number | null; lossPct: number; status: string; ok: boolean; mode: string; sent: number; received: number }[] }>(
      `/devices/${id}/samples?limit=${limit}`
    ),
  availability: (id: number | string, range: string) =>
    request<{
      range: string;
      bucketLabel: string;
      overall: number;
      checks: number;
      failed: number;
      worstBucket: { t: number; availability: number } | null;
      buckets: { t: number; availability: number; down: number; samples: number }[];
    }>(`/devices/${id}/availability?range=${range}`),
  deviceHealth: (id: number | string) =>
    request<{
      deviceId: number;
      daily: { day: string; checks: number; failed: number; avg_rtt: number | null; max_rtt: number | null; loss_pct: number | null; outages: number; downtime_sec: number; uptime_pct: number | null }[];
      mtbfSec: number | null;
      mttrSec: number | null;
      maintenance: number;
    }>(`/devices/${id}/health`),
  deviceMaintenance: (id: number | string) => request<{ items: MaintenanceRecord[] }>(`/devices/${id}/maintenance`),
  positions: (items: { id: number; latitude: number | null; longitude: number | null; mapLayerId?: number }[]) =>
    request<{ updated: number }>('/devices/positions', { method: 'POST', body: JSON.stringify({ items }) }),
  /** بررسی زنده بدون ثبت نمونه — برای پنجرهٔ شناور پینگ */
  probe: (id: number | string, params: Record<string, string | number | undefined> = {}) =>
    request<{
      result: { ok: boolean; rtt: number | null; packetsSent: number; packetsRecv: number; lossPct: number; mode: string; error?: string; at: number };
      deviceId: number;
      name: string;
      ip: string;
      threshold: number;
    }>(`/devices/${id}/probe${qs(params)}`),
  sparklines: (ids: number[], range = '1h') =>
    request<{ range: string; bucketMs: number; series: Record<number, { t: number; rtt: number | null; loss: number }[]> }>(
      `/devices/sparklines${qs({ ids: ids.join(','), range })}`
    ),

  /* ---------------- ورود/خروج گروهی ---------------- */
  importPreview: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{
      fileName: string;
      headers: string[];
      totalRows: number;
      valid: unknown[];
      errors: { row: number; name: string; ip: string; issues: string[] }[];
      duplicates: { row: number; name: string; ip: string; issues: string[] }[];
      summary: { valid: number; invalid: number; duplicates: number; newGroups: string[]; newTags: string[] };
    }>('/devices/import/preview', { method: 'POST', body: fd });
  },
  importCommit: (file: File, onlyValid = true) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('onlyValid', onlyValid ? '1' : '0');
    return request<{ inserted: number; skipped: number; failed: { name: string; ip: string; reason: string }[] }>('/devices/import/commit', {
      method: 'POST',
      body: fd,
    });
  },
  importGeo: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{ updated: number; errors: { row: number; reason: string }[] }>('/devices/import/geo', { method: 'POST', body: fd });
  },

  /* ---------------- هشدارها ---------------- */
  alerts: (params: Record<string, string | number | undefined> = {}) =>
    request<
      Paged<Alert> & { stats: { active: number; acknowledged: number; resolved: number; suppressed: number; bySeverity: Record<string, number> } }
    >(`/alerts${qs(params)}`),
  ackAlert: (id: number) => request<{ updated: number }>(`/alerts/${id}/ack`, { method: 'POST', body: '{}' }),
  resolveAlert: (id: number) => request<{ updated: number }>(`/alerts/${id}/resolve`, { method: 'POST', body: '{}' }),
  bulkAlerts: (ids: number[], action: string) =>
    request<{ updated: number }>('/alerts/bulk', { method: 'POST', body: JSON.stringify({ ids, action }) }),
  alertRules: () => request<{ items: AlertRule[]; meta: { groups: Group[] } }>('/alert-rules'),
  createRule: (body: Partial<AlertRule>) => request<AlertRule>('/alert-rules', { method: 'POST', body: JSON.stringify(body) }),
  updateRule: (id: number, body: Partial<AlertRule>) => request<{ updated: number }>(`/alert-rules/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteRule: (id: number) => request<{ deleted: number }>(`/alert-rules/${id}`, { method: 'DELETE' }),

  /* ---------------- تعمیرات ---------------- */
  maintenance: (params: Record<string, string | number | undefined> = {}) =>
    request<Paged<MaintenanceRecord> & { meta: { causes: string[]; actions: string[] } }>(`/maintenance${qs(params)}`),
  createMaintenance: (body: Record<string, unknown>) => request<MaintenanceRecord>('/maintenance', { method: 'POST', body: JSON.stringify(body) }),
  updateMaintenance: (id: number, body: Record<string, unknown>) => request<MaintenanceRecord>(`/maintenance/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteMaintenance: (id: number) => request<{ deleted: number }>(`/maintenance/${id}`, { method: 'DELETE' }),
  windows: () => request<{ items: { id: number; device_id: number | null; deviceName?: string; title: string; days: string; start_time: string; end_time: string; enabled: number }[] }>('/maintenance-windows'),
  createWindow: (body: Record<string, unknown>) => request<unknown>('/maintenance-windows', { method: 'POST', body: JSON.stringify(body) }),
  updateWindow: (id: number, body: Record<string, unknown>) => request<{ updated: number }>(`/maintenance-windows/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteWindow: (id: number) => request<{ deleted: number }>(`/maintenance-windows/${id}`, { method: 'DELETE' }),

  /* ---------------- گزارش‌ها ---------------- */
  report: (params: Record<string, string | number | undefined> = {}) => request<ReportData>(`/reports/summary${qs(params)}`),

  /* ---------------- گروه/تگ/لایه ---------------- */
  groups: () => request<{ items: Group[] }>('/groups'),
  createGroup: (body: Record<string, unknown>) => request<Group>('/groups', { method: 'POST', body: JSON.stringify(body) }),
  updateGroup: (id: number, body: Record<string, unknown>) => request<{ updated: number }>(`/groups/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteGroup: (id: number, moveTo?: number) => request<{ deleted: number }>(`/groups/${id}${moveTo ? `?moveTo=${moveTo}` : ''}`, { method: 'DELETE' }),
  tags: () => request<{ items: Tag[] }>('/tags'),
  createTag: (body: Record<string, unknown>) => request<Tag>('/tags', { method: 'POST', body: JSON.stringify(body) }),
  updateTag: (id: number, body: Record<string, unknown>) => request<{ updated: number }>(`/tags/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteTag: (id: number) => request<{ deleted: number }>(`/tags/${id}`, { method: 'DELETE' }),
  tagDevices: (tagId: number, ids: number[], mode: 'add' | 'remove') =>
    request<{ affected: number }>(`/tags/${tagId}/devices`, { method: 'POST', body: JSON.stringify({ ids, mode }) }),
  layers: () =>
    request<{ items: MapLayer[]; files: { fileName: string; sizeBytes: number; modifiedAt: number }[]; tilesDir: string; settings: AppSettings }>('/layers'),
  createLayer: (body: Record<string, unknown>) => request<MapLayer>('/layers', { method: 'POST', body: JSON.stringify(body) }),
  updateLayer: (id: number, body: Record<string, unknown>) => request<{ updated: number }>(`/layers/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteLayer: (id: number, removeFile = false) => request<{ deleted: number }>(`/layers/${id}${removeFile ? '?removeFile=1' : ''}`, { method: 'DELETE' }),
  uploadLayer: (file: File, name?: string) => {
    const fd = new FormData();
    fd.append('file', file);
    if (name) fd.append('name', name);
    return request<{ layer: MapLayer; info: { tileCount: number | null; format: string } }>('/layers/upload', { method: 'POST', body: fd });
  },
  layerInfo: (id: number) => request<{ layer: MapLayer; info: unknown }>(`/layers/${id}/info`),

  /* ---------------- علامت‌های نقشه ---------------- */
  markerTypes: () => request<{ items: MarkerType[] }>('/marker-types'),
  createMarkerType: (body: Record<string, unknown>) => request<MarkerType>('/marker-types', { method: 'POST', body: JSON.stringify(body) }),
  updateMarkerType: (id: number, body: Record<string, unknown>) => request<MarkerType>(`/marker-types/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteMarkerType: (id: number) => request<{ deleted: number }>(`/marker-types/${id}`, { method: 'DELETE' }),
  markers: (params: Record<string, string | number | undefined> = {}) =>
    request<{ items: MapMarker[]; types: MarkerType[] }>(`/markers${qs(params)}`),
  createMarker: (body: Record<string, unknown>) => request<MapMarker>('/markers', { method: 'POST', body: JSON.stringify(body) }),
  updateMarker: (id: number, body: Record<string, unknown>) => request<MapMarker>(`/markers/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteMarker: (id: number) => request<{ deleted: number }>(`/markers/${id}`, { method: 'DELETE' }),
  bulkDeleteMarkers: (ids: number[]) => request<{ deleted: number }>('/markers/bulk', { method: 'DELETE', body: JSON.stringify({ ids }) }),
  markerImportPreview: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{ fileName: string; totalRows: number; valid: number; invalid: number; newTypes: string[]; errors: { row: number; name: string; issues: string[] }[] }>(
      '/markers/import/preview',
      { method: 'POST', body: fd }
    );
  },
  markerImport: (file: File, mode: 'append' | 'replace' = 'append') => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('mode', mode);
    return request<{ inserted: number; skipped: number; newTypes: string[]; errors: unknown[] }>('/markers/import', { method: 'POST', body: fd });
  },

  /* ---------------- رویدادهای قطع و وصل ---------------- */
  flaps: (params: Record<string, string | number | undefined> = {}) => request<FlapsData>(`/events/flaps${qs(params)}`),
  simultaneous: (params: Record<string, string | number | undefined> = {}) => request<SimultaneousData>(`/events/simultaneous${qs(params)}`),
  outageTimeline: (params: Record<string, string | number | undefined> = {}) => request<OutageTimelineData>(`/events/timeline${qs(params)}`),
  topOutageDevices: (params: Record<string, string | number | undefined> = {}) =>
    request<{ days: number; items: TopOutageDevice[] }>(`/events/top-outage-devices${qs(params)}`),

  /* ---------------- موتور و تنظیمات ---------------- */
  engineStatus: () => request<EngineStatus & { lastLogs: { ts: number; level: string; message: string }[] }>('/engine/status'),
  engineControl: (action: 'start' | 'stop' | 'restart') => request<EngineStatus>(`/engine/control/${action}`, { method: 'POST', body: '{}' }),
  checkAll: () => request<{ queued: number }>('/engine/check-all', { method: 'POST', body: '{}' }),
  engineLog: (limit = 100) => request<{ items: { ts: number; level: string; message: string }[] }>(`/engine/log?limit=${limit}`),
  settings: () =>
    request<{ settings: AppSettings; engine: EngineStatus; icmpAvailable: boolean | null; dbSize: number; paths: { dbFile: string; tilesDir: string } }>('/settings'),
  saveSettings: (patch: Partial<AppSettings>) => request<{ settings: AppSettings; engine: EngineStatus }>('/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  resetDemo: () => request<{ ok: boolean; message: string }>('/settings/reset-demo', { method: 'POST', body: JSON.stringify({ confirm: 'reset' }) }),
};

export type Api = typeof api;
