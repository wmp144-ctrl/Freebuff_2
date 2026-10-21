import type {
  Alert,
  AlertRule,
  AppHealthData,
  AppSettings,
  AuthUser,
  BackupStatus,
  ConflictReport,
  DashboardData,
  Device,
  DeviceAttachment,
  DeviceTemplate,
  DiscoveryPayload,
  DiscoveryResult,
  DiscoveryScanStatus,
  EngineStatus,
  FlapsData,
  Group,
  InstallationReport,
  MttrReport,
  MaintenanceRecord,
  MapLayer,
  MapMarker,
  MarkerType,
  OutageTimelineData,
  Paged,
  ReportData,
  RetentionStatus,
  Series,
  SimultaneousData,
  StatusData,
  Tag,
  TemplateField,
  TopOutageDevice,
  TopoCatalog,
  TopoDiagram,
  TopoDiagramSummary,
  TopoAnalysis,
  TopoGraphPayload,
  TopoImpact,
  TopoOverview,
  TopoPathDefinition,
  TopoReport,
  TopoSite,
  TopoStatusSnapshot,
  TopoVersionCompare,
  TopoVersionDetail,
  TopoVersionList,
  TopoViewport,
} from './types';

const BASE = '/api';

/** هیچ درخواستی بدون مهلت باقی نمی‌ماند. */
export const DEFAULT_TIMEOUT_MS = 15000;
/** بارگذاری/ورود فایل و تولید خروجی حجیم مهلت بیشتری دارد، اما باز هم محدود است. */
export const UPLOAD_TIMEOUT_MS = 120000;

export class ApiError extends Error {
  status: number;
  code: 'HTTP' | 'TIMEOUT' | 'NETWORK' | 'ABORTED' | 'INVALID_RESPONSE';
  aborted: boolean;
  constructor(
    message: string,
    status = 0,
    options: { code?: ApiError['code']; aborted?: boolean } = {}
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = options.code ?? 'HTTP';
    this.aborted = options.aborted ?? false;
  }
}

/** خطای لغو عمدی (تغییر صفحه/فیلتر یا Unmount) — نباید به کاربر نمایش داده شود */
export function isAbortError(error: unknown): boolean {
  return error instanceof ApiError ? error.aborted : (error as { name?: string } | null)?.name === 'AbortError';
}

/** توکن CSRF از کوکی خوانده می‌شود (کوکی عمداً HttpOnly نیست) */
function csrfToken(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/(?:^|;\s*)nw_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

export interface RequestOptions extends RequestInit {
  /** مهلت این درخواست به میلی‌ثانیه (پیش‌فرض: ۱۵ ثانیه، فایل: ۱۲۰ ثانیه) */
  timeoutMs?: number;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * تنها نقطهٔ ورود به API.
 *
 * • هر درخواست مهلت مشخص دارد و پس از آن واقعاً لغو می‌شود.
 * • Signal بیرونی (تغییر فیلتر/Unmount) به همان AbortController وصل می‌شود.
 * • خطای شبکه، مهلت، پاسخ غیر JSON و خطای HTTP همه به ApiError یکسان تبدیل
 *   می‌شوند تا صفحه‌ها یک نوع خطا را نمایش دهند.
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { timeoutMs, signal: externalSignal, ...init } = options;
  const method = (init.method || 'GET').toUpperCase();
  const headers = new Headers(init.headers || undefined);
  if (!(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  // CSRF double-submit: هدر باید با کوکی و با مقدار نشست بخواند.
  if (method !== 'GET' && method !== 'HEAD' && path !== '/auth/login') headers.set('X-CSRF-Token', csrfToken());

  const limit = timeoutMs ?? (init.body instanceof FormData ? UPLOAD_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      throw new ApiError('درخواست لغو شد.', 0, { code: 'ABORTED', aborted: true });
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, limit));

  try {
    const res = await fetch(`${BASE}${path}`, { ...init, method, headers, signal: controller.signal });
    const type = res.headers.get('content-type') || '';
    if (res.status === 401 && path !== '/auth/login' && path !== '/auth/me') {
      // نشست منقضی شده است؛ لایهٔ احراز هویت صفحهٔ ورود را نشان می‌دهد
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('nw:unauthorized'));
    }
    // بدنه فقط یک‌بار خوانده می‌شود (پیش‌تر برای خطا و موفقیت دو مسیر جدا بود)
    const text = await res.text();
    const data = text ? parseJson(text) : undefined;

    if (!res.ok) {
      const apiMessage =
        data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
          ? (data as { error: string }).error
          : `خطای ${res.status}`;
      throw new ApiError(apiMessage, res.status, { code: 'HTTP' });
    }
    if (res.status === 204 || text === '') return undefined as T;
    if (type.includes('application/json')) {
      if (data === undefined) {
        throw new ApiError('پاسخ سرور JSON معتبر نبود. دوباره تلاش کنید.', res.status, { code: 'INVALID_RESPONSE' });
      }
      return data as T;
    }
    throw new ApiError('پاسخ سرور با قالب مورد انتظار هم‌خوانی ندارد.', res.status, { code: 'INVALID_RESPONSE' });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timedOut) {
      throw new ApiError(`پاسخ سرور در ${Math.round(limit / 1000)} ثانیه دریافت نشد. دوباره تلاش کنید.`, 0, { code: 'TIMEOUT' });
    }
    if (externalSignal?.aborted || (error as { name?: string } | null)?.name === 'AbortError') {
      throw new ApiError('درخواست لغو شد.', 0, { code: 'ABORTED', aborted: true });
    }
    throw new ApiError('ارتباط با سرور برقرار نشد. اتصال شبکه را بررسی کنید.', 0, { code: 'NETWORK' });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
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
  users: (signal?: AbortSignal) =>
    request<{
      items: AuthUser[];
      roles: { value: string; label: string }[];
      passwordPolicy: { minLength: number; maxLength?: number; requireComplexity?: boolean; rules?: string[] };
    }>('/auth/users', { signal }),
  createUser: (body: { username: string; password: string; role: 'admin' | 'operator' | 'viewer'; displayName?: string }) =>
    request<AuthUser>('/auth/users', { method: 'POST', body: JSON.stringify(body) }),
  updateUser: (id: number, body: Record<string, unknown>) =>
    request<AuthUser>(`/auth/users/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteUser: (id: number) => request<{ deleted: number }>(`/auth/users/${id}`, { method: 'DELETE' }),
  unlockUser: (id: number) => request<AuthUser>(`/auth/users/${id}/unlock`, { method: 'POST', body: '{}' }),

  /* ---------------- داشبورد ---------------- */
  dashboard: (signal?: AbortSignal) => request<DashboardData>('/dashboard/summary', { signal }),

  /** وضعیت مستقل سرور، موتور، تجهیزات و سلامت برنامه برای نوار وضعیت و داشبورد */
  status: (signal?: AbortSignal) => request<StatusData>('/status', { signal }),

  /** سنجه‌های منابع خود برنامه (CPU/RAM/Heap/ELD/DB/SSE/صف) + تاریخچهٔ نمودار */
  appHealth: (signal?: AbortSignal) => request<AppHealthData>('/system/app-health', { signal }),

  /* ---------------- تجهیزات ---------------- */
  devices: (params: Record<string, string | number | undefined> = {}, signal?: AbortSignal) =>
    request<Paged<Device>>(`/devices${qs(params)}`, { signal }),
  /** نقشه: محدودهٔ جغرافیایی + شمارش مستقل کل/دارای مختصات/بدون مختصات */
  mapDevices: (
    params: Record<string, string | number | undefined> = {},
    signal?: AbortSignal
  ) =>
    request<{
      items: {
        id: number;
        name: string;
        ip: string;
        status: string;
        latitude: number;
        longitude: number;
        deviceType: string;
        groupName: string | null;
        lastRtt: number | null;
        priority: string;
        location: string;
        mapLayerId: number | null;
      }[];
      total: number;
      withGeo: number;
      missingGeo: number;
      returned: number;
      truncated: boolean;
      stats: Record<string, number>;
      bbox: [number, number, number, number] | null;
      zoom: number;
      generatedAt: number;
    }>(`/devices/map${qs(params)}`, { signal }),
  device: (id: number | string, signal?: AbortSignal) => request<Device>(`/devices/${id}`, { signal }),
  deviceMeta: (signal?: AbortSignal) =>
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
    }>('/devices/meta', { signal }),
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
  series: (id: number | string, range: string, signal?: AbortSignal) =>
    request<Series>(`/devices/${id}/series?range=${range}`, { signal }),
  outages: (id: number | string, limit = 100, signal?: AbortSignal) =>
    request<{ total: number; open: { id: number; started_at: number; durationSec: number } | null; items: import('./types').Outage[] }>(
      `/devices/${id}/outages?limit=${limit}`,
      { signal }
    ),
  samples: (id: number | string, limit = 200, signal?: AbortSignal) =>
    request<{ items: { ts: number; rtt: number | null; lossPct: number; status: string; ok: boolean; mode: string; sent: number; received: number }[] }>(
      `/devices/${id}/samples?limit=${limit}`,
      { signal }
    ),
  availability: (id: number | string, range: string, signal?: AbortSignal) =>
    request<{
      range: string;
      bucketLabel: string;
      overall: number;
      checks: number;
      failed: number;
      worstBucket: { t: number; availability: number } | null;
      buckets: { t: number; availability: number; down: number; samples: number }[];
    }>(`/devices/${id}/availability?range=${range}`, { signal }),
  deviceHealth: (id: number | string, signal?: AbortSignal) =>
    request<{
      deviceId: number;
      daily: { day: string; checks: number; failed: number; avg_rtt: number | null; max_rtt: number | null; loss_pct: number | null; outages: number; downtime_sec: number; uptime_pct: number | null }[];
      mtbfSec: number | null;
      mttrSec: number | null;
      maintenance: number;
    }>(`/devices/${id}/health`, { signal }),
  deviceMaintenance: (id: number | string, signal?: AbortSignal) =>
    request<{ items: MaintenanceRecord[] }>(`/devices/${id}/maintenance`, { signal }),
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
  sparklines: (ids: number[], range = '1h', signal?: AbortSignal) =>
    request<{ range: string; bucketMs: number; series: Record<number, { t: number; rtt: number | null; loss: number }[]> }>(
      `/devices/sparklines${qs({ ids: ids.join(','), range })}`,
      { signal }
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
  alerts: (params: Record<string, string | number | undefined> = {}, signal?: AbortSignal) =>
    request<
      Paged<Alert> & { stats: { active: number; acknowledged: number; resolved: number; suppressed: number; bySeverity: Record<string, number> } }
    >(`/alerts${qs(params)}`, { signal }),
  ackAlert: (id: number) => request<{ updated: number }>(`/alerts/${id}/ack`, { method: 'POST', body: '{}' }),
  resolveAlert: (id: number) => request<{ updated: number }>(`/alerts/${id}/resolve`, { method: 'POST', body: '{}' }),
  bulkAlerts: (ids: number[], action: string) =>
    request<{ updated: number }>('/alerts/bulk', { method: 'POST', body: JSON.stringify({ ids, action }) }),
  alertRules: (signal?: AbortSignal) => request<{ items: AlertRule[]; meta: { groups: Group[] } }>('/alert-rules', { signal }),
  createRule: (body: Partial<AlertRule>) => request<AlertRule>('/alert-rules', { method: 'POST', body: JSON.stringify(body) }),
  updateRule: (id: number, body: Partial<AlertRule>) => request<{ updated: number }>(`/alert-rules/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteRule: (id: number) => request<{ deleted: number }>(`/alert-rules/${id}`, { method: 'DELETE' }),

  /* ---------------- تعمیرات ---------------- */
  maintenance: (params: Record<string, string | number | undefined> = {}, signal?: AbortSignal) =>
    request<Paged<MaintenanceRecord> & { meta: { causes: string[]; actions: string[] } }>(`/maintenance${qs(params)}`, { signal }),
  createMaintenance: (body: Record<string, unknown>) => request<MaintenanceRecord>('/maintenance', { method: 'POST', body: JSON.stringify(body) }),
  updateMaintenance: (id: number, body: Record<string, unknown>) => request<MaintenanceRecord>(`/maintenance/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteMaintenance: (id: number) => request<{ deleted: number }>(`/maintenance/${id}`, { method: 'DELETE' }),
  windows: (signal?: AbortSignal) =>
    request<{ items: { id: number; device_id: number | null; deviceName?: string; title: string; days: string; start_time: string; end_time: string; enabled: number }[] }>(
      '/maintenance-windows',
      { signal }
    ),
  createWindow: (body: Record<string, unknown>) => request<unknown>('/maintenance-windows', { method: 'POST', body: JSON.stringify(body) }),
  updateWindow: (id: number, body: Record<string, unknown>) => request<{ updated: number }>(`/maintenance-windows/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteWindow: (id: number) => request<{ deleted: number }>(`/maintenance-windows/${id}`, { method: 'DELETE' }),

  /* ---------------- گزارش‌ها ---------------- */
  report: (params: Record<string, string | number | undefined> = {}, signal?: AbortSignal) =>
    request<ReportData>(`/reports/summary${qs(params)}`, { signal }),

  /* ---------------- گروه/تگ/لایه ---------------- */
  groups: (signal?: AbortSignal) => request<{ items: Group[] }>('/groups', { signal }),
  createGroup: (body: Record<string, unknown>) => request<Group>('/groups', { method: 'POST', body: JSON.stringify(body) }),
  updateGroup: (id: number, body: Record<string, unknown>) => request<{ updated: number }>(`/groups/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteGroup: (id: number, moveTo?: number) => request<{ deleted: number }>(`/groups/${id}${moveTo ? `?moveTo=${moveTo}` : ''}`, { method: 'DELETE' }),
  tags: (signal?: AbortSignal) => request<{ items: Tag[] }>('/tags', { signal }),
  createTag: (body: Record<string, unknown>) => request<Tag>('/tags', { method: 'POST', body: JSON.stringify(body) }),
  updateTag: (id: number, body: Record<string, unknown>) => request<{ updated: number }>(`/tags/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteTag: (id: number) => request<{ deleted: number }>(`/tags/${id}`, { method: 'DELETE' }),
  tagDevices: (tagId: number, ids: number[], mode: 'add' | 'remove') =>
    request<{ affected: number }>(`/tags/${tagId}/devices`, { method: 'POST', body: JSON.stringify({ ids, mode }) }),
  layers: (signal?: AbortSignal) =>
    request<{ items: MapLayer[]; files: { fileName: string; sizeBytes: number; modifiedAt: number }[]; tilesDir: string; settings: AppSettings    }>('/layers', { signal }),
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
  markerTypes: (signal?: AbortSignal) => request<{ items: MarkerType[] }>('/marker-types', { signal }),
  createMarkerType: (body: Record<string, unknown>) => request<MarkerType>('/marker-types', { method: 'POST', body: JSON.stringify(body) }),
  updateMarkerType: (id: number, body: Record<string, unknown>) => request<MarkerType>(`/marker-types/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteMarkerType: (id: number) => request<{ deleted: number }>(`/marker-types/${id}`, { method: 'DELETE' }),
  markers: (params: Record<string, string | number | undefined> = {}, signal?: AbortSignal) =>
    request<{ items: MapMarker[]; types: MarkerType[] }>(`/markers${qs(params)}`, { signal }),
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

  /* ---------------- دیاگرام ارتباطات شبکه ---------------- */
  topologyOverview: (signal?: AbortSignal) => request<TopoOverview>('/topology/overview', { signal }),
  topologyDiagram: (id: number | string, signal?: AbortSignal) =>
    request<TopoDiagram>(`/topology/diagrams/${id}`, { signal }),
  topologyDiagrams: (params: { templates?: boolean; search?: string } = {}, signal?: AbortSignal) =>
    request<{ items: TopoDiagramSummary[] }>(`/topology/diagrams${qs({ templates: params.templates ? 1 : undefined, search: params.search })}`, { signal }),
  createTopologyDiagram: (body: { name: string; description?: string; layout?: string; fromTemplateId?: number | null }) =>
    request<TopoDiagram>('/topology/diagrams', { method: 'POST', body: JSON.stringify(body) }),
  updateTopologyDiagram: (
    id: number | string,
    body: { name?: string; description?: string; layout?: string; settings?: Record<string, unknown>; viewport?: TopoViewport }
  ) => request<TopoDiagram>(`/topology/diagrams/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteTopologyDiagram: (id: number | string) =>
    request<{ deleted: number }>(`/topology/diagrams/${id}`, { method: 'DELETE' }),
  saveTopologyGraph: (id: number | string, body: TopoGraphPayload) =>
    request<TopoDiagram>(`/topology/diagrams/${id}/graph`, { method: 'PUT', body: JSON.stringify(body) }),
  lockTopologyDiagram: (id: number | string, locked: boolean) =>
    request<TopoDiagramSummary>(`/topology/diagrams/${id}/lock`, { method: 'POST', body: JSON.stringify({ locked }) }),
  duplicateTopologyDiagram: (id: number | string, body: { name?: string; asTemplate?: boolean } = {}) =>
    request<TopoDiagram>(`/topology/diagrams/${id}/duplicate`, { method: 'POST', body: JSON.stringify(body) }),
  templateTopologyDiagram: (id: number | string, body: { name?: string } = {}) =>
    request<TopoDiagram>(`/topology/diagrams/${id}/template`, { method: 'POST', body: JSON.stringify(body) }),
  topologyStatus: (id: number | string, signal?: AbortSignal, opts: { fresh?: boolean } = {}) =>
    request<TopoStatusSnapshot>(`/topology/diagrams/${id}/status${opts.fresh ? '?fresh=1' : ''}`, { signal }),
  topologyAnalysis: (id: number | string, signal?: AbortSignal) =>
    request<TopoAnalysis>(`/topology/diagrams/${id}/analysis`, { signal }),
  topologyImpact: (id: number | string, target: { linkId?: string; nodeId?: string }, signal?: AbortSignal) =>
    request<TopoImpact>(`/topology/diagrams/${id}/impact${qs(target)}`, { signal }),
  topologyPaths: (id: number | string, signal?: AbortSignal) =>
    request<{ items: TopoPathDefinition[]; revision: number }>(`/topology/diagrams/${id}/paths`, { signal }),
  saveTopologyPaths: (id: number | string, paths: TopoPathDefinition[]) =>
    request<{ items: TopoPathDefinition[]; revision: number }>(`/topology/diagrams/${id}/paths`, {
      method: 'PUT',
      body: JSON.stringify({ paths }),
    }),
  pollTopologyTelemetry: (id: number | string, signal?: AbortSignal) =>
    request<{ checked: number; ok: number; failed: number; skipped: number; snapshot: TopoStatusSnapshot }>(
      `/topology/diagrams/${id}/telemetry/poll`,
      { method: 'POST', body: '{}', signal, timeoutMs: 30000 }
    ),
  topologyExportUrl: (id: number | string) => downloadUrl(`/topology/diagrams/${id}/export`),
  topologyVersions: (id: number | string, params: { limit?: number; before?: number } = {}, signal?: AbortSignal) =>
    request<TopoVersionList>(`/topology/diagrams/${id}/versions${qs(params)}`, { signal }),
  topologyVersion: (id: number | string, versionId: number | string, signal?: AbortSignal) =>
    request<TopoVersionDetail>(`/topology/diagrams/${id}/versions/${versionId}`, { signal }),
  compareTopologyVersions: (id: number | string, a: number, b: number | 'current' = 'current', signal?: AbortSignal) =>
    request<TopoVersionCompare>(`/topology/diagrams/${id}/versions/compare${qs({ a, b })}`, { signal }),
  restoreTopologyVersion: (id: number | string, versionId: number, revision: number) =>
    request<TopoDiagram & { restoredFrom: number; restoreWarnings: string[] }>(
      `/topology/diagrams/${id}/versions/${versionId}/restore`,
      { method: 'POST', body: JSON.stringify({ revision }), timeoutMs: 30000 }
    ),
  topologyReport: (id: number | string, signal?: AbortSignal) =>
    request<TopoReport>(`/topology/diagrams/${id}/report`, { signal, timeoutMs: 30000 }),
  topologyReportUrl: (id: number | string, format: 'pdf' | 'xlsx') =>
    downloadUrl(`/topology/diagrams/${id}/report/export`, { format }),
  topologyCatalog: (
    params: { id?: number; search?: string; groupId?: number; status?: string; siteId?: number | 'unassigned'; diagramId?: number; limit?: number } = {},
    signal?: AbortSignal
  ) => request<TopoCatalog>(`/topology/device-catalog${qs(params)}`, { signal }),
  topologySites: (signal?: AbortSignal) => request<{ items: TopoSite[] }>('/topology/sites', { signal }),
  createTopologySite: (body: Record<string, unknown>) =>
    request<TopoSite>('/topology/sites', { method: 'POST', body: JSON.stringify(body) }),
  updateTopologySite: (id: number, body: Record<string, unknown>) =>
    request<TopoSite>(`/topology/sites/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteTopologySite: (id: number) => request<{ deleted: number; detachedDevices: number }>(`/topology/sites/${id}`, { method: 'DELETE' }),
  assignTopologySiteDevices: (id: number, ids: number[], mode: 'assign' | 'remove' = 'assign') =>
    request<{ ok: boolean; affected: number; site: TopoSite }>(`/topology/sites/${id}/devices`, {
      method: 'POST',
      body: JSON.stringify({ ids, mode }),
    }),

  /* ---------------- رویدادهای قطع و وصل ---------------- */
  flaps: (params: Record<string, string | number | undefined> = {}, signal?: AbortSignal) =>
    request<FlapsData>(`/events/flaps${qs(params)}`, { signal }),
  simultaneous: (params: Record<string, string | number | undefined> = {}, signal?: AbortSignal) =>
    request<SimultaneousData>(`/events/simultaneous${qs(params)}`, { signal }),
  outageTimeline: (params: Record<string, string | number | undefined> = {}, signal?: AbortSignal) =>
    request<OutageTimelineData>(`/events/timeline${qs(params)}`, { signal }),
  topOutageDevices: (params: Record<string, string | number | undefined> = {}, signal?: AbortSignal) =>
    request<{ days: number; items: TopOutageDevice[] }>(`/events/top-outage-devices${qs(params)}`, { signal }),

  /* ---------------- موتور و تنظیمات ---------------- */
  engineStatus: (signal?: AbortSignal) =>
    request<EngineStatus & { lastLogs: { ts: number; level: string; message: string }[] }>('/engine/status', { signal }),
  engineControl: (action: 'start' | 'stop' | 'restart') => request<EngineStatus>(`/engine/control/${action}`, { method: 'POST', body: '{}' }),
  checkAll: () => request<{ queued: number }>('/engine/check-all', { method: 'POST', body: '{}' }),
  engineLog: (limit = 100, signal?: AbortSignal) =>
    request<{ items: { ts: number; level: string; message: string }[] }>(`/engine/log?limit=${limit}`, { signal }),
  settings: (signal?: AbortSignal) =>
    request<{ settings: AppSettings; engine: EngineStatus; icmpAvailable: boolean | null; sampleCount: number }>(
      '/settings',
      { signal }
    ),
  saveSettings: (patch: Partial<AppSettings>) =>
    request<{ settings: AppSettings; engine: EngineStatus; rejected?: string[] }>('/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  resetDemo: () => request<{ ok: boolean; message: string }>('/settings/reset-demo', { method: 'POST', body: JSON.stringify({ confirm: 'reset' }) }),

  /* ---------------- نگهداری داده، پشتیبان و بازیابی ---------------- */
  retentionStatus: (signal?: AbortSignal) => request<RetentionStatus>('/system/retention', { signal }),
  runRetention: (dryRun = false) =>
    request<{ status: string; dryRun: boolean; deleted: Record<string, number>; deletedRows: number; freedBytes: number; blocked?: Record<string, string> }>(
      '/system/retention/run',
      { method: 'POST', body: JSON.stringify({ dryRun }) }
    ),
  stopRetention: () => request<{ accepted: boolean; message: string }>('/system/retention/stop', { method: 'POST', body: '{}' }),
  backupStatus: (signal?: AbortSignal) =>
    request<{ dir: string; items: unknown[]; status: BackupStatus }>('/system/backups', { signal }),
  createBackup: () => request<{ name: string; dir: string }>('/system/backups', { method: 'POST', body: JSON.stringify({}) }),
  restoreStatus: (signal?: AbortSignal) =>
    request<{ status: string; inProgress: boolean; phase?: string; finishedAt?: number; error?: string; rolledBack?: boolean }>(
      '/system/restore/status',
      { signal }
    ),

  /* ---------------- کشف شبکه ---------------- */
  discovery: (signal?: AbortSignal) => request<DiscoveryPayload>('/discovery/ranges', { signal }),
  createDiscoveryRange: (body: Record<string, unknown>) =>
    request<import('./types').DiscoveryRange>('/discovery/ranges', { method: 'POST', body: JSON.stringify(body) }),
  updateDiscoveryRange: (id: number, body: Record<string, unknown>) =>
    request<import('./types').DiscoveryRange>(`/discovery/ranges/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteDiscoveryRange: (id: number) => request<{ deleted: number }>(`/discovery/ranges/${id}`, { method: 'DELETE' }),
  scanDiscovery: (rangeIds?: number[]) =>
    request<{ started: boolean; status: DiscoveryScanStatus }>('/discovery/scan', {
      method: 'POST',
      body: JSON.stringify({ rangeIds }),
      timeoutMs: 30000,
    }),
  discoveryStatus: (signal?: AbortSignal) =>
    request<{ scan: DiscoveryScanStatus; pending: number }>('/discovery/status', { signal }),
  discoveryResults: (params: Record<string, string | number | undefined> = {}, signal?: AbortSignal) =>
    request<{ items: DiscoveryResult[]; total: number; limit: number; offset: number; now: number }>(
      `/discovery/results${qs(params)}`,
      { signal }
    ),
  importDiscovered: (id: number, name?: string) =>
    request<{ imported: boolean; deviceId?: number; ip?: string; name?: string; duplicate?: boolean }>(`/discovery/results/${id}/import`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  dismissDiscovered: (id: number) => request<{ deleted: number }>(`/discovery/results/${id}`, { method: 'DELETE' }),
  pruneDiscovery: () => request<{ removed: number }>('/discovery/prune', { method: 'POST', body: '{}' }),

  /* ---------------- قالب تجهیزات ---------------- */
  templates: (signal?: AbortSignal) => request<{ items: DeviceTemplate[]; fields: TemplateField[] }>('/templates', { signal }),
  createTemplate: (body: Record<string, unknown>) =>
    request<DeviceTemplate>('/templates', { method: 'POST', body: JSON.stringify(body) }),
  updateTemplate: (id: number, body: Record<string, unknown>) =>
    request<DeviceTemplate>(`/templates/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteTemplate: (id: number) => request<{ deleted: number }>(`/templates/${id}`, { method: 'DELETE' }),
  applyTemplate: (id: number, body: { deviceIds: number[]; fields?: string[]; overwrite?: boolean }) =>
    request<{ updated: number; skipped: number; overwrite: boolean; details: { deviceId: number; name: string; applied: string[]; preserved: string[] }[] }>(
      `/templates/${id}/apply`,
      { method: 'POST', body: JSON.stringify(body) }
    ),

  /* ---------------- تعارض IP ---------------- */
  conflicts: (signal?: AbortSignal) => request<ConflictReport>('/conflicts', { signal }),

  /* ---------------- پیوست تجهیز ---------------- */
  attachments: (deviceId: number | string, signal?: AbortSignal) =>
    request<{ items: DeviceAttachment[]; maxBytes: number }>(`/devices/${deviceId}/attachments`, { signal }),
  uploadAttachment: (deviceId: number | string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<DeviceAttachment>(`/devices/${deviceId}/attachments`, { method: 'POST', body: fd });
  },
  deleteAttachment: (deviceId: number | string, attachmentId: number) =>
    request<{ deleted: number }>(`/devices/${deviceId}/attachments/${attachmentId}`, { method: 'DELETE' }),
  setDeviceGroups: (deviceId: number | string, groupIds: number[]) =>
    request<Device>(`/devices/${deviceId}/groups`, { method: 'PUT', body: JSON.stringify({ groupIds }) }),

  /* ---------------- گزارش‌های مدیریتی ---------------- */
  reportMttr: (params: Record<string, string | number | undefined> = {}, signal?: AbortSignal) =>
    request<{ range: { from: number; to: number } } & MttrReport>(`/reports/mttr${qs(params)}`, { signal }),
  installations: (params: Record<string, string | number | undefined> = {}, signal?: AbortSignal) =>
    request<InstallationReport>(`/reports/installations${qs(params)}`, { signal }),
};

export type Api = typeof api;

/**
 * دسترسی سطح‌پایین برای موارد خاص (آزمون‌ها/دانلودهای سفارشی).
 * همهٔ فراخوانی‌های معمول باید از `api` استفاده کنند تا قواعد CSRF و خطا یکسان بماند.
 */
export const apiRequest = request;
