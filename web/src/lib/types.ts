export type DeviceStatus = 'online' | 'offline' | 'warning' | 'unknown' | 'maintenance';
export type Priority = 'low' | 'normal' | 'high' | 'critical';
export type Severity = 'info' | 'warning' | 'critical';
export type ChartRange = '15m' | '1h' | '6h' | '24h' | '7d' | '30d' | '90d';

export interface Tag {
  id: number;
  name: string;
  color: string;
  show_on_map: number | boolean;
  icon?: string;
  device_count?: number;
}

export interface Group {
  id: number;
  name: string;
  description: string;
  color: string;
  device_count?: number;
  online?: number;
  offline?: number;
  warning?: number;
  uptime?: number | null;
}

export interface Device {
  id: number;
  name: string;
  ip: string;
  hostname: string;
  deviceType: string;
  groupId: number | null;
  groupName: string | null;
  groupColor: string | null;
  location: string;
  building: string;
  rack: string;
  latitude: number | null;
  longitude: number | null;
  mapLayerId: number | null;
  vendor: string;
  model: string;
  serial: string;
  firmware: string;
  owner: string;
  notes: string;
  priority: Priority;
  enabled: boolean;
  monitoringEnabled: boolean;
  pingInterval: number | null;
  timeoutMs: number | null;
  packetCount: number | null;
  retries: number | null;
  latencyThreshold: number | null;
  lossThreshold: number | null;
  status: DeviceStatus;
  statusReason: string;
  lastCheckAt: number | null;
  lastStatusChangeAt: number | null;
  lastRtt: number | null;
  minRtt: number | null;
  maxRtt: number | null;
  avgRtt: number | null;
  lossPct: number;
  successCount: number;
  failCount: number;
  totalChecks: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  uptimePct: number | null;
  lastOutageAt: number | null;
  currentOutageId: number | null;
  currentOutageStartedAt: number | null;
  lastRecoveryAt: number | null;
  createdAt: number;
  updatedAt: number;
  outageCount?: number;
  tags: Tag[];
  effective?: {
    pingInterval: number;
    timeoutMs: number;
    packetCount: number;
    retries: number;
    latencyThreshold: number;
    lossThreshold: number;
  };
  stats?: {
    outages: number;
    openOutage: number | null;
    packets: { sent: number; received: number; lost: number };
  };
}

export interface SeriesPoint {
  t: number;
  rtt: number | null;
  minRtt: number | null;
  maxRtt: number | null;
  loss: number;
  availability: number;
  samples: number;
  ok: number;
  down: number;
  status: DeviceStatus;
}

export interface Series {
  range: string;
  bucketMs: number;
  bucketLabel: string;
  from: number;
  to: number;
  points: SeriesPoint[];
}

export interface Outage {
  id: number;
  startedAt: number;
  endedAt: number | null;
  durationSec: number;
  cause: string;
  detail: string;
  lat: number | null;
  lng: number | null;
  open: boolean;
  maintenance: { id: number; action: string; technician: string } | null;
}

export interface Alert {
  id: number;
  deviceId: number | null;
  deviceName?: string | null;
  deviceIp?: string | null;
  ruleId: number | null;
  ruleName?: string | null;
  severity: Severity;
  kind: string;
  title: string;
  message: string;
  value: number | null;
  createdAt: number;
  status: 'active' | 'acknowledged' | 'resolved' | 'suppressed';
  acknowledgedAt?: number | null;
  acknowledgedBy?: string | null;
  resolvedAt?: number | null;
}

export interface AlertRule {
  id: number;
  name: string;
  enabled: number;
  metric: 'offline' | 'latency' | 'loss' | 'recovery';
  comparator: string;
  threshold: number;
  duration_sec: number;
  severity: Severity;
  scope_group_id: number | null;
  groupName?: string | null;
  cooldown_sec: number;
  apply_to_unmon: number;
  silent: number;
}

export interface MaintenanceRecord {
  id: number;
  deviceId: number;
  deviceName?: string;
  deviceIp?: string;
  groupName?: string;
  groupColor?: string;
  outageId: number | null;
  title: string;
  cause: string;
  action: string;
  startedAt: number;
  endedAt: number | null;
  downtimeSec: number;
  technician: string;
  cost: number;
  description: string;
  notes: string;
  status: 'open' | 'closed';
  createdAt?: number;
}

export interface MapLayer {
  id: number;
  name: string;
  description: string;
  kind: 'builtin' | 'mbtiles' | 'empty';
  file_name: string | null;
  min_zoom: number;
  max_zoom: number;
  attribution: string;
  visible: number;
  is_default: number;
  tile_count: number;
  created_at: number;
  fileInfo?: {
    tileCount: number | null;
    format: string;
    minzoom?: number;
    maxzoom?: number;
    vectorLayers?: { id: string; minzoom?: number; maxzoom?: number }[];
  } | null;
}

export interface AppSettings {
  site_name: string;
  engine_enabled: boolean;
  engine_mode: 'auto' | 'icmp' | 'tcp' | 'simulate';
  ping_interval: number;
  timeout_ms: number;
  retries: number;
  packet_count: number;
  max_workers: number;
  latency_threshold: number;
  loss_threshold: number;
  failures_for_offline: number;
  successes_for_online: number;
  retention_days: number;
  // ---- Data Retention Policy (Phase 2) ----
  retention_enabled: boolean;
  retention_run_time: string;
  retention_interval_minutes: number;
  retention_batch_size: number;
  retention_max_rows_per_run: number;
  samples_retention_days: number;
  daily_stats_retention_days: number;
  outages_retention_days: number;
  alerts_retention_days: number;
  engine_log_retention_days: number;
  audit_retention_days: number;
  retention_legal_hold: boolean;
  retention_prune_backups: boolean;
  backup_enabled: boolean;
  backup_interval_hours: number;
  backup_keep: number;
  backup_prune_enabled: boolean;
  backup_daily_keep: number;
  backup_weekly_keep: number;
  checkpoint_interval_minutes: number;
  chart_default_range: ChartRange;
  tcp_port: number;
  calendar: 'jalali' | 'gregorian';
  timezone_offset_minutes: number;
  alerting_enabled: boolean;
  alert_cooldown: number;
  alert_delay: number;
  suppression_enabled: boolean;
  suppression_start: string;
  suppression_end: string;
  notify_browser: boolean;
  repair_causes: string[];
  repair_actions: string[];
  map_default_center: [number, number];
  map_default_zoom: number;
  map_show_labels: boolean;
  device_detail_widgets: WidgetConfig[];
  dashboard_widgets: WidgetConfig[];
}

export type WidgetSize = 'sm' | 'md' | 'lg' | 'full';

/** چیدمان یک ویجت/بخش نمایشی: شناسه، نمایش، اندازه و ترتیب */
export interface WidgetConfig {
  id: string;
  visible: boolean | number;
  size: WidgetSize;
  order: number;
}

export interface RetentionRun {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  trigger: string;
  actor: string;
  dryRun: boolean;
  status: string;
  stage: string;
  deleted: Record<string, number>;
  deletedRows: number;
  freedBytes: number;
  batches: number;
  durationMs: number | null;
  error: string;
}

export interface RetentionStatus {
  owner: string;
  running: boolean;
  stopRequested: boolean;
  policy: Record<string, string | number | boolean>;
  lock: { owner: string | null; expiresAt: number; heldByThisProcess: boolean };
  lastRun: RetentionRun | null;
  runs: RetentionRun[];
  nextRunAt: number;
  lastStatus: string;
  lastDeletedRows: number;
  lastFreedBytes: number;
  storage: { pageSize: number; pages: number; freePages: number; dbBytes: number; freeBytes: number; walBytes: number };
}

export interface BackupStatus {
  dir: string;
  appVersion: string;
  schemaVersion: number;
  count: number;
  lastBackupAt: number | null;
  latest: { name: string; createdAt: string; createdAtMs: number; dbBytes: number; integrity: string } | null;
  running: boolean;
  restoring: boolean;
  restore: { status: string; inProgress: boolean; phase?: string; finishedAt?: number; error?: string; rolledBack?: boolean };
  policy: { enabled: boolean; intervalHours: number; pruneEnabled: boolean; dailyKeep: number; weeklyKeep: number };
  freeBytes: number;
}

export interface MarkerType {
  id: number;
  name: string;
  color: string;
  icon: string;
  description: string;
  markerCount?: number;
  createdAt?: number;
}

export interface MapMarker {
  id: number;
  typeId: number | null;
  typeName: string | null;
  typeColor: string | null;
  typeIcon: string | null;
  name: string;
  latitude: number;
  longitude: number;
  notes: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface FlapEvent {
  id: string;
  outageId: number;
  deviceId: number;
  deviceName: string;
  deviceIp: string;
  kind: 'up' | 'down';
  ts: number;
  cause: string;
  durationSec: number | null;
}

export interface FlapsData {
  hours: number;
  from: number;
  to: number;
  bucketMs: number;
  series: { t: number; down: number; up: number }[];
  items: FlapEvent[];
}

export interface SimultaneousCluster {
  start: number;
  end: number;
  durationSec: number;
  count: number;
  devices: { id: number; name: string }[];
}

export interface SimultaneousData {
  hours: number;
  from: number;
  to: number;
  bucketMs: number;
  series: { t: number; concurrent: number }[];
  items: SimultaneousCluster[];
  overlapping: number;
}

export interface OutageTimelineBar {
  id: number;
  start: number;
  end: number;
  open: boolean;
  cause: string;
}

export interface OutageTimelineData {
  hours: number;
  from: number;
  to: number;
  total: number;
  devices: { deviceId: number; name: string; ip: string; bars: OutageTimelineBar[] }[];
}

export interface TopOutageDevice {
  id: number;
  name: string;
  ip: string;
  status: DeviceStatus;
  groupName: string | null;
  groupColor: string | null;
  outages: number;
  downtimeSec: number;
  lastOutageAt: number | null;
}

export interface EngineStatus {
  running: boolean;
  /** نمونهٔ رهبر موتور (تنها نمونه‌ای که Ping می‌زند) */
  leader?: boolean;
  mode: string;
  icmpAvailable: boolean | null;
  interval: number;
  maxWorkers: number;
  inflight: number;
  cycles: number;
  checksRun: number;
  lastRunAt: number | null;
  startedAt: number | null;
  errors: number;
  skipped: number;
}

export interface DashboardData {
  kpis: {
    total: number;
    active: number;
    up: number;
    down: number;
    inactive: number;
    online: number;
    offline: number;
    warning: number;
    unknown: number;
    maintenance: number;
    disabled: number;
    monitoring: number;
    openOutages: number;
  };
  health: {
    score: number;
    grade: { label: string; tone: string };
    availability: number;
    avgRtt: number | null;
    lossAvg: number | null;
    checks24h: number;
    alertsActive: number;
    alertCounts: Record<string, number>;
  };
  statusDistribution: { key: string; label: string; value: number; color: string }[];
  offlineTrend: { t: number; offline: number; devices: number }[];
  outagesPerDay: { day: string; count: number; downtimeSec: number }[];
  topLatency: {
    id: number;
    name: string;
    ip: string;
    status: DeviceStatus;
    avgRtt: number;
    maxRtt: number;
    lastRtt: number;
    lossPct: number;
    groupName: string | null;
    groupColor: string | null;
  }[];
  topDowntime: {
    id: number;
    name: string;
    ip: string;
    status: DeviceStatus;
    groupName: string | null;
    groupColor: string | null;
    outages: number;
    downtimeSec: number;
  }[];
  groupStatus: {
    id: number;
    name: string;
    color: string;
    total: number;
    online: number;
    offline: number;
    warning: number;
    uptime: number | null;
    avgRtt: number | null;
  }[];
  healthTrend: { day: string; availability: number; checks: number; health: number | null }[];
  avgRttTrend: { day: string; health?: number; avgRtt?: number | null }[];
  recentAlerts: Alert[];
  degraded: { id: number; name: string; ip: string; status: DeviceStatus; avgRtt: number | null; lossPct: number; uptime: number | null }[];
  lastStatusChangeAt: number | null;
  engine: EngineStatus;
  settings: { siteName: string; latencyThreshold: number; lossThreshold: number; chartRange: ChartRange; engineMode: string; calendar: string };
  generatedAt: number;
}

/** بخش «سلامت برنامه» از /api/status — مستقل از سلامت شبکه */
export interface AppHealth {
  db: { ok: boolean; sizeBytes: number | null };
  sse: { clients: number; peak: number; skippedFrames: number; deliveredFrames: number; droppedClients: number };
  backup: {
    enabled: boolean;
    count: number;
    lastBackupAt: number | null;
    running: boolean;
    restoring: boolean;
    ok: boolean;
  };
  disk: { freeBytes: number | null; minFreeBytes: number; ok: boolean };
  probe: { lastSuccessAt: number | null; lastStatusChangeAt: number | null };
  jobs: { queued: number; running: number; rejected: number };
  generatedAt: number;
}

export interface StatusData {
  server: { ok: boolean; ts: number; uptime: number };
  engine: EngineStatus & { stale: boolean; staleMs: number | null };
  devices: { total: number; up: number; down: number; inactive: number; monitoring: number };
  app: AppHealth;
  generatedAt: number;
}

export interface ReportRow {
  id: number;
  name: string;
  ip: string;
  deviceType: string;
  status: DeviceStatus;
  priority: Priority;
  groupName: string | null;
  groupColor: string | null;
  location: string;
  checks: number;
  okCount: number;
  failed: number;
  availability: number | null;
  minRtt: number | null;
  maxRtt: number | null;
  avgRtt: number | null;
  lossPct: number | null;
  outages: number;
  downtimeSec: number;
  mttrSec: number;
  mtbfSec: number | null;
  alerts: number;
}

export interface ReportData {
  range: { from: number; to: number; days: number };
  totals: {
    devices: number;
    checks: number;
    failed: number;
    outages: number;
    downtimeSec: number;
    alerts: number;
    availability: number | null;
    avgRtt: number | null;
    maxRtt: number;
    mttrSec: number;
  };
  items: ReportRow[];
  days: { day: string; checks: number; availability: number | null; avgRtt: number | null; lossPct: number | null }[];
  dailyOutages: { day: string; count: number; downtimeSec: number }[];
  causes: { label: string; count: number; downtimeSec: number }[];
  actions: { label: string; count: number; cost: number }[];
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

export type AuthRole = 'admin' | 'operator' | 'viewer';

export interface AuthUser {
  id: number;
  username: string;
  role: AuthRole;
  roleLabel?: string;
  permissions?: string[];
  displayName: string;
  disabled?: boolean;
  createdAt?: number;
  lastLoginAt?: number | null;
  locked?: boolean;
  lockedUntil?: number | null;
  failedLoginCount?: number;
}

/* --------------------------- Application Health --------------------------- */

export interface LatencyStats {
  count: number;
  mean?: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface AppHealthData {
  generatedAt: number;
  ok: boolean;
  process: {
    uptimeSec: number;
    node: string;
    cpu: { processPct: number; systemPct: number; cores: number; loadAvg: number[] };
    memory: {
      rssBytes: number;
      heapTotalBytes: number;
      heapUsedBytes: number;
      externalBytes: number;
      arrayBuffersBytes: number;
      rssMb: number;
      heapUsedMb: number;
      heapTotalMb: number;
    };
    eventLoop: LatencyStats;
    queries: { count: number; errors: number; overall: LatencyStats };
    api: { count: number; serverErrors: number; overall: LatencyStats };
    handles: number | null;
  };
  db: {
    sizeBytes: number | null;
    walBytes: number | null;
    queries: {
      count: number;
      errors: number;
      slow: { thresholdMs: number; count: number; totalMs: number };
      overall: LatencyStats;
      top: { sql: string; count: number; avgMs: number; maxMs: number; errors: number; latency: LatencyStats }[];
      recentSlow: { sql: string; ms: number; at: number }[];
    };
  };
  engine: {
    running: boolean;
    leader: boolean;
    mode: string;
    simulation: boolean;
    activeProbes: number;
    maxWorkers: number;
    queueDepth: number;
    backlog: number;
    lastCycleAt: number | null;
    lastCycleMs: number | null;
    lastTickMs: number | null;
    lastTickReady: number;
    lastTickLaunched: number;
    checksRun: number;
    stalled: boolean;
    tickLagMs: number;
  };
  sse: {
    clients: number;
    peak: number;
    droppedClients: number;
    skippedFrames: number;
    deliveredFrames: number;
  };
  jobs: { queued: number; running: number; rejected: number; activeWorkers: number; maxConcurrency: number };
  api: {
    count: number;
    serverErrors: number;
    overall: LatencyStats;
    routes: { route: string; count: number; p50: number; p95: number; p99: number; max: number }[];
  };
  backup: { enabled: boolean; lastBackupAt: number | null; count: number; running: boolean; intervalHours: number | null } | null;
  retention: {
    lastStatus: string;
    lastRunAt: number | null;
    lastFinishedAt: number | null;
    lastDeletedRows: number;
    nextRunAt: number | null;
    running: boolean;
  } | null;
  history: {
    t: number;
    cpuPct: number;
    rssMb: number;
    heapMb: number;
    eldP99: number;
    apiP95: number;
    dbP95: number;
  }[];
}

/* ------------------------------------------------------------------ */
/* دیاگرام ارتباطات شبکه (Topology)                                   */
/* ------------------------------------------------------------------ */

export type TopoLayout = 'hierarchy-tb' | 'hierarchy-lr' | 'grid' | 'radial';
export type TopoNodeKind = 'device' | 'site' | 'cloud' | 'note' | 'group';
export type TopoLinkKind = 'ethernet' | 'fiber' | 'wireless' | 'vpn' | 'logical';
export type TopoLinkStyle = 'solid' | 'dashed' | 'dotted';

export interface TopoViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface TopoSettings {
  showLabels?: boolean;
  showIps?: boolean;
  showNotes?: boolean;
  showGrid?: boolean;
  snapToGrid?: boolean;
  gridSize?: number;
  edgeStyle?: 'bezier' | 'orthogonal';
  /** نمایش متریک زندهٔ لینک‌ها روی یال‌ها (پهنای باند/مصرف/تأخیر) */
  showLinkMetrics?: boolean;
}

export interface TopoDeviceInfo {
  id: number;
  name: string;
  ip: string;
  deviceType: string;
  status: DeviceStatus;
  lastRtt: number | null;
  lossPct: number;
  lastCheckAt: number | null;
  jitterMs?: number | null;
  location: string;
  groupId: number | null;
  groupName: string | null;
  groupColor: string | null;
  priority: Priority;
  /* مشخصات فنی تجهیز (مرحلهٔ ۲) — برای پیوند گره به پروندهٔ اطلاعاتی */
  hostname?: string;
  statusReason?: string;
  building?: string;
  rack?: string;
  vendor?: string;
  model?: string;
  serial?: string;
  firmware?: string;
  uptimePct?: number | null;
  monitoringEnabled?: boolean;
}

export interface TopoSiteRef {
  id: number;
  name: string;
  code: string;
  color: string;
  deviceCount: number;
  onlineCount: number;
}

export interface TopoNode {
  id: string;
  kind: TopoNodeKind;
  deviceId: number | null;
  siteId: number | null;
  label: string;
  notes: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  z: number;
  meta: Record<string, unknown>;
  device: TopoDeviceInfo | null;
  site: TopoSiteRef | null;
}

export type TopoLinkStatus = 'up' | 'down' | 'degraded' | 'unknown';
export type TopoSaturation = 'ok' | 'moderate' | 'high' | 'critical' | 'unmeasured';

/** آخرین سنجش ترافیک اینترفیس لینک (SNMP) — فقط دادهٔ واقعی */
export interface TopoLinkTelemetry {
  enabled: boolean;
  agent: string;
  ifIndex: number | null;
}

/** وضعیت زندهٔ لینک که سرور از موتور مانیتورینگ و سنجش ترافیک می‌سازد */
export interface TopoLinkLive {
  id: string;
  status: TopoLinkStatus;
  reasonCode: string;
  reason: string;
  latencyMs: number | null;
  lossPct: number | null;
  jitterMs: number | null;
  capacityMbps: number | null;
  utilPct: number | null;
  rxMbps: number | null;
  txMbps: number | null;
  saturation: TopoSaturation;
  telemetryAt: number | null;
  telemetryStale: boolean;
  telemetryError: string;
  operStatus: string;
  sourceCount: number;
  reportingCount: number;
  stale: boolean;
  updatedAt: number;
  sources?: {
    deviceId: number;
    name: string;
    status: DeviceStatus | string;
    stale: boolean;
    lastCheckAt: number | null;
  }[];
}

export interface TopoLink {
  id: string;
  from: string;
  to: string;
  kind: TopoLinkKind;
  label: string;
  notes: string;
  color: string;
  style: TopoLinkStyle;
  meta: Record<string, unknown>;
  /** پهنای باند اسمی (Mbps) — مقدار ثبت‌شده توسط کاربر، نه حدس */
  capacityMbps?: number | null;
  /** تجهیز مرجع سنجش تأخیر/افت/نوسان این لینک (اختیاری) */
  monitorDeviceId?: number | null;
  /** پیکربندی سنجش ترافیک اینترفیس */
  telemetry?: TopoLinkTelemetry;
  /** وضعیت زنده (سرور)؛ هرگز توسط کلاینت به‌عنوان تنظیم ذخیره نمی‌شود */
  live?: TopoLinkLive | null;
}

export interface TopoDiagramSummary {
  id: number;
  name: string;
  description: string;
  layout: TopoLayout;
  locked: boolean;
  isTemplate: boolean;
  revision: number;
  viewport: TopoViewport | Record<string, never>;
  settings: TopoSettings;
  createdBy: string;
  nodeCount: number;
  linkCount: number;
  deviceCount: number;
  offlineCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface TopoDiagramStats {
  online: number;
  offline: number;
  warning: number;
  unknown: number;
  maintenance: number;
  placeholders: number;
}

export interface TopoLinkStats {
  up: number;
  down: number;
  degraded: number;
  unknown: number;
  highLoad: number;
  saturated: number;
}

export interface TopoDiagram extends TopoDiagramSummary {
  nodes: TopoNode[];
  links: TopoLink[];
  stats: TopoDiagramStats;
  linkStats?: TopoLinkStats;
  liveGeneratedAt?: number | null;
}

export interface TopoSite {
  id: number;
  name: string;
  code: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  notes: string;
  color: string;
  deviceCount: number;
  onlineCount: number;
  offlineCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface TopoOverview {
  diagrams: TopoDiagramSummary[];
  templates: TopoDiagramSummary[];
  sites: TopoSite[];
  stats: {
    deviceTotal: number;
    siteTotal: number;
    placedDevices: number;
    unassignedSites: number;
    diagramTotal: number;
    templateTotal: number;
  };
  generatedAt: number;
}

export interface TopoCatalogItem {
  id: number;
  name: string;
  ip: string;
  hostname: string;
  deviceType: string;
  status: DeviceStatus;
  statusReason?: string;
  location: string;
  building: string;
  rack?: string;
  vendor?: string;
  model?: string;
  serial?: string;
  firmware?: string;
  uptimePct?: number | null;
  monitoringEnabled?: boolean;
  groupId: number | null;
  groupName: string | null;
  groupColor: string | null;
  priority: Priority;
  lastRtt: number | null;
  lossPct: number;
  lastCheckAt: number | null;
  nodeId: string | null;
  siteId: number | null;
  siteName: string | null;
}

export interface TopoCatalog {
  items: TopoCatalogItem[];
  total: number;
  returned: number;
  hasMore: boolean;
  generatedAt: number;
}

/* ------------------------------------------------------------------ */
/* تاریخچه و گزارش‌های دیاگرام (مرحلهٔ ۴)                              */
/* ------------------------------------------------------------------ */

export interface TopoVersionCounts {
  nodes: number;
  links: number;
  paths: number;
  devices: number;
  sites: number;
}

export interface TopoChangeSummary {
  nodesAdded: number;
  nodesRemoved: number;
  nodesUpdated: number;
  linksAdded: number;
  linksRemoved: number;
  linksUpdated: number;
  pathsAdded: number;
  pathsRemoved: number;
  pathsUpdated: number;
  metadataUpdated: number;
  total: number;
}

export interface TopoChangeField {
  field: string;
  label: string;
  before: unknown;
  after: unknown;
}

export interface TopoChangeItem {
  id: string;
  label: string;
  kind?: string;
  role?: string;
  fields?: TopoChangeField[];
}

export interface TopoChangeBucket {
  items: TopoChangeItem[];
  truncated: boolean;
  total: number;
}

export interface TopoChangeSet {
  summary: TopoChangeSummary;
  nodes: { added: TopoChangeBucket; removed: TopoChangeBucket; updated: TopoChangeBucket };
  links: { added: TopoChangeBucket; removed: TopoChangeBucket; updated: TopoChangeBucket };
  paths: { added: TopoChangeBucket; removed: TopoChangeBucket; updated: TopoChangeBucket };
  meta: TopoChangeField[];
}

export type TopoVersionAction = 'create' | 'graph' | 'paths' | 'metadata' | 'restore' | 'pre-restore' | 'baseline';

export interface TopoVersionSummary {
  id: number;
  diagramId: number;
  revision: number;
  action: TopoVersionAction | string;
  actionLabel: string;
  label: string;
  author: string;
  summary: TopoVersionCounts;
  changeSummary: Partial<TopoChangeSummary>;
  restoredFrom: number | null;
  sizeBytes: number | null;
  createdAt: number;
}

export interface TopoVersionSnapshot {
  name: string;
  description: string;
  layout: string;
  locked: boolean;
  isTemplate: boolean;
  settings: Record<string, unknown>;
  nodes: {
    id: string;
    kind: string;
    deviceId: number | null;
    siteId: number | null;
    label: string;
    notes: string;
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
    z: number;
    meta: Record<string, unknown>;
    deviceName?: string;
    deviceIp?: string;
    siteName?: string;
  }[];
  links: {
    id: string;
    from: string;
    to: string;
    kind: string;
    label: string;
    notes: string;
    capacityMbps: number | null;
    monitorDeviceId: number | null;
    telemetry: { enabled: boolean; agent: string; ifIndex: number | null };
  }[];
  paths: { id: string; name: string; role: 'primary' | 'backup'; nodeIds: string[]; linkIds: string[] }[];
}

export interface TopoVersionDetail extends TopoVersionSummary {
  snapshot: TopoVersionSnapshot;
  changes: TopoChangeSet;
}

export interface TopoVersionList {
  items: TopoVersionSummary[];
  limit: number;
  nextBefore: number | null;
  retention: number;
}

export interface TopoVersionCompare {
  base: { id: number | null; action: string; actionLabel: string; label: string; revision: number; createdAt: number; summary: TopoVersionCounts };
  target: { id: number | null; action: string; actionLabel: string; label: string; revision: number; createdAt: number; summary: TopoVersionCounts };
  changes: TopoChangeSet;
}

export interface TopoReportSite {
  id: number;
  name: string;
  code: string;
  address: string;
  color: string;
  deviceCount: number;
  onlineCount: number;
  offlineCount: number;
  onDiagram: boolean;
}

export interface TopoReportDevice {
  nodeId: string;
  deviceId: number | null;
  label: string;
  ip: string;
  kind: string;
  role: string;
  roleLabel: string;
  status: string;
  statusLabel: string;
  statusReason: string;
  group: string;
  site: string;
  location: string;
  vendor: string;
  model: string;
  serial: string;
  monitoringEnabled: boolean;
  degree: number;
}

export interface TopoReportPathLeg {
  id: string;
  from: string;
  to: string;
  hops: number;
  status: string;
  statusLabel: string;
  broken: boolean;
  active: boolean;
}

export interface TopoReportPathGroup {
  name: string;
  status: string;
  statusLabel: string;
  activeRole: string | null;
  failover: boolean;
  primary: TopoReportPathLeg | null;
  backup: TopoReportPathLeg | null;
}

export interface TopoReportLink {
  id: string;
  label: string;
  from: string;
  to: string;
  kind: string;
  kindLabel: string;
  status: string;
  statusLabel: string;
  reason: string;
  capacityMbps: number | null;
  utilPct: number | null;
  rxMbps: number | null;
  txMbps: number | null;
  latencyMs: number | null;
  lossPct: number | null;
  jitterMs: number | null;
  saturation: string;
  saturationLabel: string;
  telemetryAt: number | null;
  telemetryStale: boolean;
  telemetryError: string;
  operStatus: string;
  monitored: boolean;
}

export interface TopoReportRiskNode {
  id: string;
  label: string;
  role: string;
  roleLabel: string;
  ip: string;
  status: string;
  dependentDeviceCount: number;
  dependentNodeCount: number;
  dependentSiteCount: number;
  severity: string;
  severityLabel: string;
}

export interface TopoReportRiskLink {
  id: string;
  label: string;
  from: string;
  to: string;
  status: string;
  statusLabel: string;
  dependentDeviceCount: number;
  dependentNodeCount: number;
  dependentSiteCount: number;
  severity: string;
  severityLabel: string;
}

export interface TopoReportIncident {
  type: string;
  typeLabel: string;
  id: string;
  label: string;
  status: string;
  statusLabel: string;
  reason: string;
  affectedDeviceCount: number;
  endpoints: string[];
}

export interface TopoReport {
  generatedAt: number;
  diagram: {
    id: number;
    name: string;
    description: string;
    layout: string;
    revision: number;
    locked: boolean;
    updatedAt: number;
    nodes: number;
    links: number;
    paths: number;
  };
  structure: {
    nodeCount: number;
    deviceNodeCount: number;
    siteNodeCount: number;
    cloudNodeCount: number;
    noteCount: number;
    groupNodeCount: number;
    linkCount: number;
    connectedComponents: number;
    isolatedNodeCount: number;
    averageDegree: number | null;
    statusCounts: { online: number; offline: number; warning: number; maintenance: number; unknown: number };
    linkStatusCounts: { up: number; down: number; degraded: number; unknown: number };
    linkKinds: { kind: string; label: string; count: number }[];
    roles: { role: string; label: string; count: number }[];
    siteOnDiagramCount: number;
  };
  devices: TopoReportDevice[];
  sites: TopoReportSite[];
  paths: TopoReportPathGroup[];
  pathCounts: {
    groups: number;
    primary: number;
    backup: number;
    failover: number;
    broken: number;
    withoutBackup: number;
  };
  links: TopoReportLink[];
  capacity: {
    configuredCount: number;
    measuredCount: number;
    unmeasuredCount: number;
    totalCapacityMbps: number | null;
    weightedUtilPct: number | null;
    totalRxMbps: number | null;
    totalTxMbps: number | null;
    saturatedCount: number;
    highLoadCount: number;
    noCapacityCount: number;
  };
  risks: {
    criticalNodes: TopoReportRiskNode[];
    riskyLinks: TopoReportRiskLink[];
    incidents: TopoReportIncident[];
    unreachableDeviceCount: number;
    isolatedDeviceCount: number;
    affectedDeviceCount: number;
    criticalNodeCount: number;
    riskyLinkCount: number;
    incidentCount: number;
  };
  warnings: string[];
  sources: { liveGeneratedAt: number | null; analysisGeneratedAt: number | null; anchorSource: string };
}

export interface TopoStatusSnapshot {
  revision: number;
  generatedAt: number;
  nodes: {
    id: string;
    deviceId: number | null;
    kind: string;
    name: string | null;
    ip: string | null;
    status: DeviceStatus;
    reportedStatus?: DeviceStatus;
    statusReason?: string;
    stale?: boolean;
    lastRtt: number | null;
    lossPct: number;
    jitterMs?: number | null;
    lastCheckAt: number | null;
  }[];
  links: TopoLinkLive[];
  sites: { id: number; name: string; deviceCount: number; onlineCount: number }[];
  summary: TopoLinkStats;
  cached?: boolean;
}

/* ------------------------------------------------------------------ */
/* تحلیل وابستگی و تأثیر اختلال (مرحلهٔ ۳)                            */
/* ------------------------------------------------------------------ */

export type TopoNodeRole = 'gateway' | 'router' | 'switch' | 'firewall' | 'core' | 'access' | 'server' | 'site' | 'cloud' | 'device' | 'group';
export type TopoRiskSeverity = 'critical' | 'high' | 'medium' | 'low';
export type TopoRouteStatus = 'up' | 'down' | 'degraded' | 'unknown';

export interface TopoCriticalNode {
  id: string;
  kind: TopoNodeKind;
  label: string;
  role: TopoNodeRole;
  roleLabel: string;
  deviceId: number | null;
  ip: string;
  status: DeviceStatus | string;
  siteId: number | null;
  dependentNodeCount: number;
  dependentDeviceCount: number;
  dependentSiteCount: number;
  severity: TopoRiskSeverity;
  severityLabel: string;
  isArticulation: boolean;
}

export interface TopoRiskyLink {
  id: string;
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  label: string;
  kind: TopoLinkKind;
  status: TopoLinkStatus;
  capacityMbps: number | null;
  bridge: boolean;
  redundancy: boolean;
  dependentNodeCount: number;
  dependentDeviceCount: number;
  dependentSiteCount: number;
  severity: TopoRiskSeverity;
  severityLabel: string;
}

export interface TopoIncident {
  type: 'link' | 'node';
  id: string;
  label: string;
  status: string;
  reason: string;
  endpoints: string[];
  affectedNodeCount: number;
  affectedDeviceCount: number;
}

export interface TopoCutPath {
  nodeId: string;
  label: string;
  nodeIds: string[];
  linkIds: string[];
  cutLinkId: string | null;
  cutLinkLabel: string;
  cutNodeId: string | null;
  cutNodeLabel: string;
  pathLabels: string[];
}

export interface TopoAnalysis {
  revision: number;
  generatedAt: number;
  paths: TopoPathDefinition[];
  anchorSource: 'explicit' | 'inferred' | 'none';
  anchors: Array<Pick<TopoCriticalNode, 'id' | 'kind' | 'label' | 'role' | 'roleLabel' | 'deviceId' | 'ip' | 'status' | 'siteId'> & { reason: string }>;
  warning: string;
  summary: {
    nodeCount: number;
    linkCount: number;
    deviceCount: number;
    anchorCount: number;
    reachableDeviceCount: number;
    affectedDeviceCount: number;
    unreachableDeviceCount: number;
    isolatedDeviceCount: number;
    criticalNodeCount: number;
    riskyLinkCount: number;
    redundancyGroupCount: number;
    activeBackupCount: number;
    incidentCount: number;
  };
  criticalNodes: TopoCriticalNode[];
  riskyLinks: TopoRiskyLink[];
  live: {
    affectedNodeIds: string[];
    affectedDeviceCount: number;
    unreachableNodeIds: string[];
    offlineNodeIds: string[];
    problemLinkIds: string[];
    degradedLinkIds: string[];
    problemPathLinkIds: string[];
    problemPathNodeIds: string[];
    incidents: TopoIncident[];
    cutPaths: TopoCutPath[];
  };
  redundancy: {
    groups: TopoRedundancyGroup[];
    activeBackups: string[];
  };
}

export interface TopoPathDefinition {
  id: string;
  name: string;
  role: 'primary' | 'backup';
  nodeIds: string[];
  linkIds: string[];
  createdAt?: number;
  updatedAt?: number;
}

export interface TopoPathRoute extends TopoPathDefinition {
  fromNodeId: string | null;
  toNodeId: string | null;
  fromLabel: string;
  toLabel: string;
  hops: number;
  status: TopoRouteStatus;
  broken: boolean;
  missingSegments: string[];
  active: boolean;
}

export interface TopoRedundancyGroup {
  name: string;
  primary: TopoPathRoute | null;
  backup: TopoPathRoute | null;
  activeRole: 'primary' | 'backup' | null;
  failover: boolean;
  status: 'normal' | 'failover' | 'critical' | 'degraded' | 'unknown';
}

export interface TopoImpactDevice {
  id: string;
  kind: TopoNodeKind;
  label: string;
  role: TopoNodeRole;
  roleLabel: string;
  deviceId: number | null;
  ip: string;
  status: DeviceStatus | string;
  siteId: number | null;
  isTarget?: boolean;
}

export interface TopoImpactPath {
  nodeId: string;
  label: string;
  nodeIds: string[];
  linkIds: string[];
  pathLabels: string[];
  cutLinkId: string | null;
  cutNodeId: string | null;
}

export interface TopoImpact {
  revision: number;
  generatedAt: number;
  anchorSource: 'explicit' | 'inferred' | 'none';
  target: {
    id: string;
    type: 'link' | 'node';
    label: string;
    role?: TopoNodeRole;
    roleLabel?: string;
    status: string;
    from?: string;
    to?: string;
    fromLabel?: string;
    toLabel?: string;
    kind?: string;
    ip?: string;
    deviceId?: number | null;
  };
  summary: {
    affectedNodeCount: number;
    affectedDeviceCount: number;
    downstreamDeviceCount: number;
    affectedSiteCount: number;
    severity: TopoRiskSeverity;
    severityLabel: string;
    alternateRoute: boolean;
    baselineReachable: number;
    alreadyAffected: boolean;
  };
  affected: {
    nodeIds: string[];
    devices: TopoImpactDevice[];
    deviceCount: number;
    truncated: boolean;
    siteCount: number;
  };
  paths: TopoImpactPath[];
  pathLinkIds: string[];
  pathNodeIds: string[];
  backupActivated: Array<{
    name: string;
    primaryStatus: TopoRouteStatus;
    backupStatus: TopoRouteStatus;
    backupPathId: string | null;
    backupHops: number;
  }>;
}

export interface TopoGraphPayload {
  revision: number;
  nodes: Array<
    Pick<TopoNode, 'id' | 'kind' | 'deviceId' | 'siteId' | 'label' | 'notes' | 'x' | 'y' | 'width' | 'height' | 'color' | 'z' | 'meta'>
  >;
  links: TopoLink[];
}
