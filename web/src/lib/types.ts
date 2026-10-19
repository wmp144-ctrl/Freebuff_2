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
  engine: EngineStatus;
  settings: { siteName: string; latencyThreshold: number; lossThreshold: number; chartRange: ChartRange; engineMode: string; calendar: string };
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
}
