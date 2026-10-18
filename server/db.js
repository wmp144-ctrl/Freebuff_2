/**
 * NetWatch — لایه پایگاه‌داده
 * ----------------------------------------------------------------
 * کاملاً آفلاین و بدون وابستگی بومی؛ از ماژول داخلی «node:sqlite» استفاده می‌کند.
 * همه زمان‌ها به‌صورت epoch milliseconds (INTEGER) ذخیره می‌شوند.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logEvent } from './logger.mjs';
import { normalizeCidrList } from './net-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.NETWATCH_DATA_DIR || path.join(__dirname, '..', 'data');
export const MBTILES_DIR = path.join(DATA_DIR, 'mbtiles');
fs.mkdirSync(MBTILES_DIR, { recursive: true });
export const DB_PATH = process.env.NETWATCH_DB || path.join(DATA_DIR, 'netwatch.db');

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA foreign_keys = ON');
// هنگام نوشتن هم‌زمان دو فرآیند (سرور + موتور مستقل) به‌جای خطای فوری، تا ۵ ثانیه انتظار می‌کشد
db.exec('PRAGMA busy_timeout = 5000');
// جلوگیری از رشد بی‌رویه فایل WAL در نوشتن‌های پرحجم
db.exec('PRAGMA journal_size_limit = 67108864');

export const STATUS = {
  ONLINE: 'online',
  OFFLINE: 'offline',
  WARNING: 'warning',
  UNKNOWN: 'unknown',
  MAINTENANCE: 'maintenance',
};

export const DEFAULT_SETTINGS = {
  site_name: 'مرکز پایش شبکه',
  engine_enabled: true,
  engine_mode: 'simulate', // auto | icmp | tcp | simulate
  ping_interval: 30, // ثانیه — بازه پیش‌فرض ارسال Ping
  timeout_ms: 1200,
  retries: 1, // تعداد تلاش مجدد
  packet_count: 3, // تعداد packet در هر بررسی
  max_workers: 128, // همزمانی موتور مانیتورینگ
  latency_threshold: 150, // آستانه مجاز تأخیر (ms)
  loss_threshold: 10, // آستانه مجاز packet loss (٪)
  failures_for_offline: 3, // شکست متوالی برای تشخیص Offline
  successes_for_online: 2, // پاسخ موفق متوالی برای Recovery
  retention_days: 14, // نگهداری رکوردهای خام
  chart_default_range: '1h', // بازه پیش‌فرض نمودارها
  tcp_port: 80,
  calendar: 'jalali',
  timezone_offset_minutes: 210, // Asia/Tehran
  alerting_enabled: true,
  alert_cooldown: 600,
  alert_delay: 0,
  suppression_enabled: false,
  suppression_start: '23:00',
  suppression_end: '06:00',
  notify_browser: true,
  repair_causes: [
    'مشکلات زیرساخت فیبر نوری',
    'مشکلات شبکه',
    'قطعی برق',
    'هنگ کردن سوئیچ',
    'سوختن یا خرابی تجهیز',
    'اختلال نرم‌افزاری',
    'نگهداری پیشگیرانه',
    'سایر',
  ],
  repair_actions: [
    'تعویض تجهیز',
    'تعمیر تجهیز',
    'تعویض قطعه',
    'اصلاح زیرساخت',
    'رفع مشکل شبکه',
    'به‌روزرسانی نرم‌افزار',
    'سایر',
  ],
  map_default_center: [35.6892, 51.389],
  map_default_zoom: 6,
  map_show_labels: true,
  // چیدمان ویجت‌های صفحه جزئیات تجهیز و داشبورد (خالی = چیدمان پیش‌فرض)
  device_detail_widgets: [],
  dashboard_widgets: [],
  // Probe و اسکن فعال فقط روی این محدوده‌ها مجاز است (پیش‌فرض: شبکه‌های خصوصی)
  probe_allowed_cidrs: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10'],
  // نگهداری گزارش حسابرسی (روز)
  audit_retention_days: 180,
};

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- قفل رهبری موتور: فقط یک فرآیند در هر لحظه Ping می‌زند
CREATE TABLE IF NOT EXISTS engine_lock (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  owner      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- احراز هویت: رمز فقط به‌صورت هش Argon2id (و scrypt قدیمی برای مهاجرت)؛ نقش admin | operator | viewer
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'viewer',
  display_name  TEXT DEFAULT '',
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

-- نشست‌ها: توکن خام هرگز ذخیره نمی‌شود، فقط هش SHA-256 آن
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_hash    TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip           TEXT DEFAULT '',
  user_agent   TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- گزارش حسابرسی: هر عملیات تغییردهنده و رویداد امنیتی. مقادیر حساس هرگز ذخیره نمی‌شوند.
CREATE TABLE IF NOT EXISTS audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  actor_id       INTEGER,
  actor_username TEXT NOT NULL DEFAULT '',
  actor_role     TEXT NOT NULL DEFAULT '',
  action         TEXT NOT NULL,
  target_type    TEXT DEFAULT '',
  target_id      TEXT DEFAULT '',
  method         TEXT DEFAULT '',
  path           TEXT DEFAULT '',
  ip             TEXT DEFAULT '',
  user_agent     TEXT DEFAULT '',
  status         INTEGER,
  success        INTEGER NOT NULL DEFAULT 1,
  details        TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_username);

CREATE TABLE IF NOT EXISTS groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  color       TEXT DEFAULT '#3b82f6',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  color        TEXT DEFAULT '#f59e0b',
  show_on_map  INTEGER NOT NULL DEFAULT 1,
  icon         TEXT DEFAULT 'tag',
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS map_layers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  description   TEXT DEFAULT '',
  kind          TEXT NOT NULL DEFAULT 'builtin', -- builtin | mbtiles | empty
  file_name     TEXT,
  min_zoom      INTEGER DEFAULT 0,
  max_zoom      INTEGER DEFAULT 19,
  attribution   TEXT DEFAULT '',
  visible       INTEGER NOT NULL DEFAULT 1,
  is_default    INTEGER NOT NULL DEFAULT 0,
  tile_count    INTEGER DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  name                      TEXT NOT NULL,
  ip                        TEXT NOT NULL,
  hostname                  TEXT DEFAULT '',
  device_type               TEXT DEFAULT 'سوئیچ',
  group_id                  INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  location                  TEXT DEFAULT '',
  building                  TEXT DEFAULT '',
  rack                      TEXT DEFAULT '',
  latitude                  REAL,
  longitude                 REAL,
  map_layer_id              INTEGER REFERENCES map_layers(id) ON DELETE SET NULL,
  vendor                    TEXT DEFAULT '',
  model                     TEXT DEFAULT '',
  serial                    TEXT DEFAULT '',
  firmware                  TEXT DEFAULT '',
  owner                     TEXT DEFAULT '',
  notes                     TEXT DEFAULT '',
  priority                  TEXT NOT NULL DEFAULT 'normal', -- low | normal | high | critical
  enabled                   INTEGER NOT NULL DEFAULT 1,
  monitoring_enabled        INTEGER NOT NULL DEFAULT 1,
  ping_interval             INTEGER, -- خالی = استفاده از مقدار عمومی
  timeout_ms                INTEGER,
  packet_count              INTEGER,
  retries                   INTEGER,
  latency_threshold         REAL,
  loss_threshold            REAL,
  status                    TEXT NOT NULL DEFAULT 'unknown',
  status_reason             TEXT DEFAULT '',
  last_check_at             INTEGER,
  last_status_change_at     INTEGER,
  last_rtt_ms               REAL,
  min_rtt_ms                REAL,
  max_rtt_ms                REAL,
  avg_rtt_ms                REAL,
  loss_pct                  REAL DEFAULT 0,
  success_count             INTEGER NOT NULL DEFAULT 0,
  fail_count                INTEGER NOT NULL DEFAULT 0,
  consecutive_failures      INTEGER NOT NULL DEFAULT 0,
  consecutive_successes     INTEGER NOT NULL DEFAULT 0,
  uptime_pct                REAL DEFAULT 100,
  total_checks              INTEGER NOT NULL DEFAULT 0,
  last_outage_at            INTEGER,
  current_outage_id         INTEGER,
  current_outage_started_at INTEGER,
  last_recovery_at          INTEGER,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  next_check_at             INTEGER NOT NULL DEFAULT 0 -- زمان سررسید بررسی بعدی (0 = بی‌درنگ)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_ip ON devices(ip);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
CREATE INDEX IF NOT EXISTS idx_devices_group ON devices(group_id);

CREATE TABLE IF NOT EXISTS device_tags (
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (device_id, tag_id)
);

CREATE TABLE IF NOT EXISTS samples (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id     INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ts            INTEGER NOT NULL,
  rtt_ms        REAL,
  packets_sent  INTEGER NOT NULL DEFAULT 1,
  packets_recv  INTEGER NOT NULL DEFAULT 0,
  loss_pct      REAL NOT NULL DEFAULT 0,
  status        TEXT NOT NULL,
  ok            INTEGER NOT NULL DEFAULT 0,
  mode          TEXT DEFAULT 'simulate'
);
CREATE INDEX IF NOT EXISTS idx_samples_device_ts ON samples(device_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts DESC);

CREATE TABLE IF NOT EXISTS outages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  duration_sec INTEGER,
  cause       TEXT DEFAULT 'Ping Timeout',
  detail      TEXT DEFAULT '',
  lat         REAL,
  lng         REAL,
  open        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_outages_device ON outages(device_id, started_at DESC);

CREATE TABLE IF NOT EXISTS daily_stats (
  device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  day         TEXT NOT NULL, -- YYYY-MM-DD (UTC)
  checks      INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  avg_rtt     REAL,
  min_rtt     REAL,
  max_rtt     REAL,
  loss_pct    REAL,
  outages     INTEGER NOT NULL DEFAULT 0,
  downtime_sec INTEGER NOT NULL DEFAULT 0,
  uptime_pct  REAL,
  PRIMARY KEY (device_id, day)
);
CREATE INDEX IF NOT EXISTS idx_daily_day ON daily_stats(day);

CREATE TABLE IF NOT EXISTS alert_rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  metric          TEXT NOT NULL DEFAULT 'offline', -- offline | latency | loss | recovery
  comparator      TEXT NOT NULL DEFAULT 'gte',
  threshold       REAL DEFAULT 0,
  duration_sec    INTEGER DEFAULT 0, -- تأخیر قبل از ثبت هشدار
  severity        TEXT NOT NULL DEFAULT 'warning', -- info | warning | critical
  scope_group_id  INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  cooldown_sec    INTEGER DEFAULT 600,
  apply_to_unmon  INTEGER NOT NULL DEFAULT 0,
  silent          INTEGER NOT NULL DEFAULT 0, -- در بازه سکوت قرار بگیرد
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id     INTEGER REFERENCES devices(id) ON DELETE CASCADE,
  rule_id       INTEGER REFERENCES alert_rules(id) ON DELETE SET NULL,
  severity      TEXT NOT NULL DEFAULT 'warning',
  kind          TEXT NOT NULL DEFAULT 'offline', -- offline | latency | loss | recovery | maintenance
  title         TEXT NOT NULL,
  message       TEXT DEFAULT '',
  value         REAL,
  created_at    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active', -- active | acknowledged | resolved | suppressed
  acknowledged_at INTEGER,
  acknowledged_by TEXT,
  resolved_at   INTEGER,
  notified      INTEGER NOT NULL DEFAULT 0,
  duplicate_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);

CREATE TABLE IF NOT EXISTS maintenance_records (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id    INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  outage_id    INTEGER REFERENCES outages(id) ON DELETE SET NULL,
  title        TEXT DEFAULT '',
  cause        TEXT NOT NULL DEFAULT 'سایر', -- علت خرابی
  action       TEXT NOT NULL DEFAULT 'سایر', -- اقدام انجام‌شده
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  downtime_sec INTEGER DEFAULT 0,
  technician   TEXT DEFAULT '',
  cost         REAL DEFAULT 0,
  description  TEXT DEFAULT '',
  notes        TEXT DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'closed', -- open | closed
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_maint_device ON maintenance_records(device_id, started_at DESC);

CREATE TABLE IF NOT EXISTS maintenance_windows (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id    INTEGER REFERENCES devices(id) ON DELETE CASCADE, -- خالی = سراسری
  title        TEXT DEFAULT 'پنجره تعمیرات',
  days         TEXT DEFAULT '0,1,2,3,4,5,6',
  start_time   TEXT DEFAULT '01:00',
  end_time     TEXT DEFAULT '03:00',
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS engine_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  level      TEXT NOT NULL DEFAULT 'info',
  message    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_engine_log_ts ON engine_log(ts DESC);

-- انواع «علامت» روی نقشه (مثل «تجهیز در حال نصب») که کاربر تعریف می‌کند
CREATE TABLE IF NOT EXISTS marker_types (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  color       TEXT DEFAULT '#0ea5e9',
  icon        TEXT DEFAULT 'map-pin',
  description TEXT DEFAULT '',
  created_at  INTEGER NOT NULL
);

-- جانمایی علامت‌ها روی نقشه؛ هر علامت یک نام مشخص و مختصات جغرافیایی دارد
CREATE TABLE IF NOT EXISTS map_markers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id     INTEGER REFERENCES marker_types(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  latitude    REAL NOT NULL,
  longitude   REAL NOT NULL,
  notes       TEXT DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_map_markers_type ON map_markers(type_id);
`);

/* ------------------------------------------------------------------ */
/* Migrations — افزودن ستون‌های تازه به پایگاه‌داده‌های موجود               */
/* ------------------------------------------------------------------ */

function hasColumn(table, column) {
  try {
    return db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((c) => c.name === column);
  } catch {
    return false;
  }
}

function migrate() {
  // زمان‌بندی صریح بررسی بعدی هر تجهیز؛ به موتور اجازه می‌دهد در هر ثانیه به‌جای
  // پیمایش همه تجهیزات، فقط تجهیزات سررسیدشده را با ایندکس بخواند (مقیاس ۱۰۰۰+)
  if (!hasColumn('devices', 'next_check_at')) {
    db.exec('ALTER TABLE devices ADD COLUMN next_check_at INTEGER NOT NULL DEFAULT 0');
  }
  // اگر ستون در نسخهٔ میانی بدون مقدار پیش‌فرض ساخته شده باشد، NULL یعنی «هیچ‌وقت سررسید
  // نمی‌شود» و آن تجهیز هرگز بررسی نخواهد شد؛ پس همهٔ NULL‌ها به ۰ برگردانده می‌شوند.
  db.exec('UPDATE devices SET next_check_at = 0 WHERE next_check_at IS NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_devices_due ON devices(enabled, monitoring_enabled, next_check_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_outages_started ON outages(started_at DESC)');
  // نام کاربری بدون توجه به بزرگی/کوچکی یکتا باشد (admin ≠ Admin)
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE)');
  } catch {
    log('warn', 'ساخت ایندکس یکتای نام کاربری ناموفق بود (نام تکراری در دادهٔ موجود).');
  }
  // کمینه تأخیر روزانه برای گزارش‌های بلندمدتی که نمونهٔ خام‌شان هرس شده است
  if (!hasColumn('daily_stats', 'min_rtt')) {
    db.exec('ALTER TABLE daily_stats ADD COLUMN min_rtt REAL');
  }
}

migrate();

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, JSON.stringify(v));

/**
 * خواندن تنظیمات با اولویت: متغیر محیطی > پایگاه‌داده > مقدار پیش‌فرض.
 * متغیرهای محیطی برای استقرار (systemd/docker) هستند و در پایگاه‌داده ذخیره
 * نمی‌شوند؛ پس تغییرشان با ویرایش UI اثر ندارد و نیاز به راه‌اندازی مجدد دارد.
 */
export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      out[r.key] = r.value;
    }
  }
  return { ...out, ...envSettings };
}

/* ------------------------------------------------------------------ */
/* اعتبارسنجی تنظیمات                                                  */
/* ------------------------------------------------------------------ */

// مقدارهای غیرمنطقی تنظیمات می‌توانند برنامه را از کار بیندازند: بازه منفی يا صفر
// باعث می‌شود موتور بدون وقفه Ping بزند، max_workers بزرگ تعداد هم‌زمانی را منفجر
// می‌کند و retention_days منفی همهٔ رکوردهای تاریخی را حذف می‌کند. پس همهٔ مقادیر
// ورودی در همین یک نقطه مرزگذاری می‌شوند.
const NUM_RANGES = {
  ping_interval: [5, 86400],
  timeout_ms: [100, 30000],
  retries: [0, 5],
  packet_count: [1, 10],
  max_workers: [1, 512],
  latency_threshold: [0, 60000],
  loss_threshold: [0, 100],
  failures_for_offline: [1, 50],
  successes_for_online: [1, 50],
  retention_days: [1, 3650],
  tcp_port: [1, 65535],
  timezone_offset_minutes: [-720, 840],
  alert_cooldown: [0, 604800],
  alert_delay: [0, 86400],
  map_default_zoom: [0, 22],
  audit_retention_days: [7, 3650],
};

const ENUMS = {
  engine_mode: ['auto', 'icmp', 'tcp', 'simulate'],
  chart_default_range: ['15m', '1h', '6h', '24h', '7d', '30d', '90d'],
  calendar: ['jalali', 'gregorian'],
};

const BOOLEAN_KEYS = ['engine_enabled', 'alerting_enabled', 'suppression_enabled', 'notify_browser', 'map_show_labels'];

/* ------------------------------------------------------------------ */
/* پیکربندی از طریق متغیرهای محیطی                                     */
/* ------------------------------------------------------------------ */

const ENV_SETTINGS = {
  NETWATCH_PING_INTERVAL: 'ping_interval',
  NETWATCH_TIMEOUT_MS: 'timeout_ms',
  NETWATCH_MAX_WORKERS: 'max_workers',
  NETWATCH_RETRIES: 'retries',
  NETWATCH_PACKET_COUNT: 'packet_count',
  NETWATCH_RETENTION_DAYS: 'retention_days',
  NETWATCH_ENGINE_MODE: 'engine_mode',
  NETWATCH_TCP_PORT: 'tcp_port',
};

const envSettings = {};
for (const [envKey, setting] of Object.entries(ENV_SETTINGS)) {
  const raw = process.env[envKey];
  if (raw === undefined || raw === '') continue;
  if (setting in ENUMS) {
    if (ENUMS[setting].includes(String(raw))) envSettings[setting] = String(raw);
    else console.error(`[config] مقدار ${envKey}=${raw} نامعتبر است و نادیده گرفته شد.`);
    continue;
  }
  const value = Number(String(raw).trim());
  const range = NUM_RANGES[setting];
  if (!Number.isFinite(value) || !range || value < range[0] || value > range[1]) {
    console.error(`[config] مقدار ${envKey}=${raw} نامعتبر است و نادیده گرفته شد.`);
    continue;
  }
  envSettings[setting] = value;
}
if (Object.keys(envSettings).length) {
  console.log(`[config] مقادیر ناشی از متغیر محیطی: ${Object.keys(envSettings).join(', ')}`);
}
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const WIDGET_KEYS = ['device_detail_widgets', 'dashboard_widgets'];
const WIDGET_SIZES = ['sm', 'md', 'lg', 'full'];

/** چیدمان ویجت‌ها را به شکل امن نرمال می‌کند: حداکثر ۴۰ ویجت، اندازهٔ مجاز و ترتیب عددی */
function cleanWidgets(value) {
  if (!Array.isArray(value)) return null;
  const out = value
    .slice(0, 40)
    .map((item, i) => ({
      id: String(item?.id ?? '').trim().slice(0, 48),
      visible: item?.visible === false || item?.visible === 0 || item?.visible === '0' ? 0 : 1,
      size: WIDGET_SIZES.includes(item?.size) ? item.size : 'md',
      order: Number.isFinite(Number(item?.order)) ? Math.max(0, Math.min(999, Number(item.order))) : i,
    }))
    .filter((w) => w.id);
  return out.length || value.length === 0 ? out : null;
}

function cleanStringList(value, maxItems = 30, maxLen = 60) {
  if (!Array.isArray(value)) return null;
  const out = value
    .map((v) => String(v ?? '').trim().slice(0, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
  return out.length ? out : null;
}

function coerceNumber(value, [min, max]) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/**
 * تنظیمات رسیده از کلاینت را اعتبارسنجی و مرزگذاری می‌کند.
 * @returns {{ clean: object, rejected: string[] }}
 */
export function sanitizeSettings(patch = {}) {
  const clean = {};
  const rejected = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    if (k in NUM_RANGES) {
      const n = coerceNumber(v, NUM_RANGES[k]);
      if (n == null) rejected.push(k);
      else clean[k] = n;
      continue;
    }
    if (k in ENUMS) {
      const s = String(v);
      if (ENUMS[k].includes(s)) clean[k] = s;
      else rejected.push(k);
      continue;
    }
    if (BOOLEAN_KEYS.includes(k)) {
      clean[k] = v === true || v === 1 || v === '1' || v === 'true';
      continue;
    }
    if (k === 'suppression_start' || k === 'suppression_end') {
      const s = String(v).trim();
      if (TIME_RE.test(s)) clean[k] = s;
      else rejected.push(k);
      continue;
    }
    if (k === 'probe_allowed_cidrs') {
      const list = normalizeCidrList(v);
      if (list && list.length) clean[k] = list;
      else rejected.push(k);
      continue;
    }
    if (k === 'site_name') {
      const s = String(v ?? '').trim().slice(0, 80);
      if (s) clean[k] = s;
      else rejected.push(k);
      continue;
    }
    if (k === 'repair_causes' || k === 'repair_actions') {
      const list = cleanStringList(v);
      if (list) clean[k] = list;
      else rejected.push(k);
      continue;
    }
    if (WIDGET_KEYS.includes(k)) {
      const widgets = cleanWidgets(v);
      if (widgets) clean[k] = widgets;
      else rejected.push(k);
      continue;
    }
    if (k === 'map_default_center') {
      const lat = Number(Array.isArray(v) ? v[0] : NaN);
      const lng = Number(Array.isArray(v) ? v[1] : NaN);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        clean[k] = [Number(lat.toFixed(5)), Number(lng.toFixed(5))];
      } else rejected.push(k);
      continue;
    }
    clean[k] = v;
  }
  return { clean, rejected };
}

export function setSettings(patch = {}) {
  const { clean, rejected } = sanitizeSettings(patch);
  if (rejected.length) log('warn', `مقدار نامعتبر برای تنظیمات نادیده گرفته شد: ${rejected.join(', ')}`);
  const stmt = db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [k, v] of Object.entries(clean)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    stmt.run(k, JSON.stringify(v));
  }
  return getSettings();
}

export function log(level, message, ts = Date.now()) {
  db.prepare('INSERT INTO engine_log(ts, level, message) VALUES (?, ?, ?)').run(ts, level, message);
  // خطاها و هشدارها علاوه بر جدول، به‌صورت ساختاریافته روی خروجی سرور هم می‌روند
  // تا سرویس‌های پایش بیرونی بتوانند بدون خواندن پایگاه‌داده آن‌ها را ببینند.
  if (level === 'error' || level === 'warn') logEvent(level, 'db_log', { message, ts });
}

/* ------------------------------------------------------------------ */
/* Demo seed                                                           */
/* ------------------------------------------------------------------ */

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED_GROUPS = [
  ['هسته شبکه', 'روترها و سوئیچ‌های مرکزی', '#2563eb'],
  ['سوئیچ‌های دسترسی', 'سوئیچ‌های لایه دسترسی ساختمان‌ها', '#0ea5e9'],
  ['فایروال و امنیت', 'تجهیزات امنیتی و VPN', '#7c3aed'],
  ['سرورها', 'سرورهای داخلی و مجازی', '#0d9488'],
  ['دوربین‌های نظارتی', 'NVR و دوربین‌های IP', '#db2777'],
  ['بی‌سیم و آنتن', 'اکسس‌پوینت‌ها و لینک‌های بی‌سیم', '#f59e0b'],
  ['زیرساخت برق', 'UPS و تجهیزات برق شبکه', '#64748b'],
];

const SEED_TAGS = [
  ['حیاتی', '#dc2626', 1, 'shield-alert'],
  ['ستون فقرات', '#2563eb', 1, 'network'],
  ['نقطه لبه', '#f59e0b', 1, 'radio'],
  ['پشت UPS', '#64748b', 0, 'battery-charging'],
  ['دارای پشتیبان', '#16a34a', 0, 'git-branch'],
  ['لینک اینترنت', '#0891b2', 1, 'globe'],
  ['در حال تعویض', '#a855f7', 1, 'wrench'],
];

const TYPE_BY_GROUP = {
  'هسته شبکه': ['روتر', 'سوئیچ'],
  'سوئیچ‌های دسترسی': ['سوئیچ'],
  'فایروال و امنیت': ['فایروال'],
  سرورها: ['سرور'],
  'دوربین‌های نظارتی': ['دوربین IP'],
  'بی‌سیم و آنتن': ['اکسس‌پوینت'],
  'زیرساخت برق': ['UPS شبکه'],
};

const PLACES = [
  ['تهران — مرکز داده اصلی', 'ساختمان A — طبقه ۱', 35.7005, 51.338],
  ['تهران — ساختمان اداری', 'ساختمان B — طبقه ۳', 35.7289, 51.3896],
  ['تهران — انبار مرکزی', 'ساختمان C', 35.662, 51.31],
  ['کرج — شعبه غرب', 'طبقه ۲', 35.8355, 50.9915],
  ['اصفهان — شعبه مرکزی', 'طبقه ۱', 32.6546, 51.668],
  ['مشهد — شعبه شرق', 'طبقه ۴', 36.2972, 59.6067],
  ['شیراز — دیتاسنتر پشتیبان', 'سالن B', 29.5918, 52.5837],
  ['تبریز — شعبه شمال‌غرب', 'طبقه ۲', 38.0805, 46.2919],
  ['اهواز — مرکز عملیات', 'طبقه ۱', 31.3183, 48.6706],
  ['قم — سایت مخابراتی', 'سایت', 34.6399, 50.8759],
  ['رشت — شعبه شمال', 'طبقه ۳', 37.2808, 49.5832],
  ['بندرعباس — پست فنی', 'پست', 27.1832, 56.2666],
];

const CAUSES = [
  'قطعی برق',
  'هنگ کردن سوئیچ',
  'اختلال در زیرساخت فیبر نوری',
  'مشکل شبکه',
  'سوختن یا خرابی تجهیز',
  'بازیابی خودکار پس از قطعی',
  'به‌روزرسانی نرم‌افزار',
];
// فهرست اقدام‌های پیش‌فرض تعمیرات در DEFAULT_SETTINGS (repair_actions) نگهداری می‌شود.

export function seedIfEmpty({ force = false } = {}) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM devices').get().c;
  if (count > 0 && !force) return false;

  const now = Date.now();
  const rnd = mulberry32(20261016);

  // اگر سرور و engine-cli هم‌زمان روی پایگاه‌دادهٔ تازه اجرا شوند، هر دو ممکن
  // است جدول را خالی ببینند و دادهٔ نمایشی را دوبار درج کنند (خطای UNIQUE روی
  // نام گروه). BEGIN IMMEDIATE نوشتن را از همان ابتدا قفل می‌کند و بررسی
  // دوبارهٔ داخل تراکنش، درج تکراری را ناممکن می‌کند.
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (e) {
    if (/busy|locked/i.test(String(e.message))) return false;
    throw e;
  }
  try {
    if (!force && db.prepare('SELECT COUNT(*) AS c FROM devices').get().c > 0) {
      db.exec('ROLLBACK');
      return false;
    }
    if (force) {
      for (const t of [
        'alert_rules',
        'alerts',
        'maintenance_records',
        'maintenance_windows',
        'device_tags',
        'outages',
        'samples',
        'daily_stats',
        'devices',
        'groups',
        'tags',
        'map_markers',
        'marker_types',
        'map_layers',
        'engine_log',
      ]) {
        db.exec(`DELETE FROM ${t}`);
      }
    }

    // لایه‌های نقشه
    const layerStmt = db.prepare(
      'INSERT INTO map_layers(name, description, kind, file_name, min_zoom, max_zoom, attribution, visible, is_default, tile_count, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    );
    // شناسهٔ لایه به‌صورت پویا خوانده می‌شود؛ در بازنشانی داده‌ها (AUTOINCREMENT)
    // شناسه‌ها ادامه پیدا می‌کنند و یک مقدار ثابت به کلید بیرونی نامعتبر اشاره می‌کرد.
    const builtinLayerId = Number(
      layerStmt.run(
        'نقشه برداری پایه (آفلاین)',
        'لایه وکتور داخلی بدون نیاز به اینترنت',
        'builtin',
        null,
        3,
        18,
        'NetWatch',
        1,
        1,
        0,
        now
      ).lastInsertRowid
    );
    layerStmt.run('لایه شبکه — نقشه شهری', 'لایه نمونه؛ فایل .mbtiles خود را بارگذاری کنید', 'empty', null, 3, 18, '', 1, 0, 0, now);
    layerStmt.run('لایه زیرساخت ساختمان‌ها', 'لایه داخلی برای تجهیزات داخل ساختمان', 'empty', null, 5, 20, '', 0, 0, 0, now);

    const groups = new Map();
    const gStmt = db.prepare('INSERT INTO groups(name, description, color, created_at) VALUES (?,?,?,?)');
    for (const [name, desc, color] of SEED_GROUPS) {
      const res = gStmt.run(name, desc, color, now);
      groups.set(name, Number(res.lastInsertRowid));
    }

    const tags = new Map();
    const tStmt = db.prepare('INSERT INTO tags(name, color, show_on_map, icon, created_at) VALUES (?,?,?,?,?)');
    for (const [name, color, onMap, icon] of SEED_TAGS) {
      const res = tStmt.run(name, color, onMap, icon, now);
      tags.set(name, Number(res.lastInsertRowid));
    }

    // تولید تجهیزات
    const deviceStmt = db.prepare(`INSERT INTO devices
      (name, ip, hostname, device_type, group_id, location, building, rack, latitude, longitude, map_layer_id,
       vendor, model, serial, firmware, owner, notes, priority, enabled, monitoring_enabled, ping_interval,
       timeout_ms, packet_count, retries, latency_threshold, loss_threshold, status, uptime_pct, total_checks,
       created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    const vendors = ['Cisco', 'HPE Aruba', 'MikroTik', 'Huawei', 'Ubiquiti', 'TP-Link', 'Fortinet', 'Juniper'];
    const inserted = [];
    let seq = 0;

    for (const [groupName, groupId] of groups) {
      const types = TYPE_BY_GROUP[groupName];
      const howMany = groupName === 'سوئیچ‌های دسترسی' ? 14 : groupName === 'دوربین‌های نظارتی' ? 8 : 5;
      for (let i = 0; i < howMany; i++) {
        seq++;
        const place = PLACES[Math.floor(rnd() * PLACES.length)];
        const type = types[Math.floor(rnd() * types.length)];
        const vendor = vendors[Math.floor(rnd() * vendors.length)];
        const ip = `10.${10 + (seq % 4)}.${Math.floor(seq / 60) + 1}.${(seq % 250) + 2}`;
        const hasGeo = rnd() > 0.16;
        const lat = hasGeo ? place[2] + (rnd() - 0.5) * 0.035 : null;
        const lng = hasGeo ? place[3] + (rnd() - 0.5) * 0.05 : null;
        const disabled = rnd() > 0.94 ? 1 : 0;
        const priority = rnd() > 0.86 ? 'critical' : rnd() > 0.6 ? 'high' : rnd() > 0.25 ? 'normal' : 'low';
        const name = `${groupName.split(' ')[0]}-${String(seq).padStart(3, '0')} (${place[0].split('—')[0].trim()})`;

        const res = deviceStmt.run(
          name,
          ip,
          `${groupName.replace(/\s/g, '').toLowerCase()}-${seq}.local`,
          type,
          groupId,
          place[0],
          place[1],
          `R${Math.ceil(rnd() * 24)}-U${Math.ceil(rnd() * 40)}`,
          lat,
          lng,
          hasGeo ? builtinLayerId : null,
          vendor,
          `${vendor.split(' ')[0]}-${1000 + Math.ceil(rnd() * 8000)}`,
          `SN${Math.floor(rnd() * 1e9).toString(16).toUpperCase()}`,
          `${Math.ceil(rnd() * 9)}.${Math.ceil(rnd() * 9)}.${Math.ceil(rnd() * 9)}`,
          ['تیم شبکه', 'تیم زیرساخت', 'تیم امنیت'][Math.floor(rnd() * 3)],
          '',
          priority,
          disabled ? 0 : 1,
          disabled ? 0 : 1,
          rnd() > 0.7 ? [15, 30, 60, 120, 300][Math.floor(rnd() * 5)] : null,
          rnd() > 0.8 ? [800, 1000, 1500, 2000][Math.floor(rnd() * 4)] : null,
          rnd() > 0.8 ? [1, 3, 5][Math.floor(rnd() * 3)] : null,
          rnd() > 0.85 ? [0, 1, 2][Math.floor(rnd() * 3)] : null,
          rnd() > 0.85 ? [80, 120, 200][Math.floor(rnd() * 3)] : null,
          rnd() > 0.9 ? [5, 15, 25][Math.floor(rnd() * 3)] : null,
          disabled ? STATUS.UNKNOWN : STATUS.ONLINE,
          disabled ? 0 : 98 + rnd() * 2,
          0,
          now - Math.floor(rnd() * 200 * 86400000),
          now
        );
        const id = Number(res.lastInsertRowid);
        inserted.push({ id, group: groupName, type, ip, lat, lng, disabled, place });
      }
    }

    // تگ‌گذاری
    const attach = db.prepare('INSERT OR IGNORE INTO device_tags(device_id, tag_id) VALUES (?,?)');
    const tagNames = [...tags.keys()];
    for (const d of inserted) {
      const n = 1 + Math.floor(rnd() * 2);
      for (let i = 0; i < n; i++) {
        const t = tagNames[Math.floor(rnd() * tagNames.length)];
        attach.run(d.id, tags.get(t));
      }
      if (d.group === 'هسته شبکه') attach.run(d.id, tags.get('ستون فقرات'));
      if (d.type === 'فایروال') attach.run(d.id, tags.get('حیاتی'));
      if (d.group === 'بی‌سیم و آنتن') attach.run(d.id, tags.get('نقطه لبه'));
    }

    // پنجره تعمیرات پیش‌فرض (سراسری)
    db.prepare(
      'INSERT INTO maintenance_windows(device_id, title, days, start_time, end_time, enabled, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(null, 'پنجره تعمیرات شبانه', '0,1,2,3,4,5,6', '01:00', '03:00', 0, now);

    // انواع «علامت» روی نقشه و چند جانمایی نمونه
    const mtypeStmt = db.prepare('INSERT INTO marker_types(name, color, icon, description, created_at) VALUES (?,?,?,?,?)');
    const mtypeIds = {};
    for (const [mtName, mtColor, mtIcon, mtDesc] of [
      ['تجهیز در حال نصب', '#0ea5e9', 'hammer', 'تجهیزاتی که در حال نصب یا راه‌اندازی هستند'],
      ['نقطه بازدید دوره‌ای', '#16a34a', 'eye', 'نقاطی که نیاز به بازدید دوره‌ای دارند'],
      ['محل حادثه و خرابی', '#dc2626', 'triangle-alert', 'محل وقوع خرابی یا حادثه'],
      ['نقطه توسعه آینده', '#7c3aed', 'circle-plus', 'مکان‌های پیش‌بینی‌شده برای توسعه'],
    ]) {
      mtypeIds[mtName] = Number(mtypeStmt.run(mtName, mtColor, mtIcon, mtDesc, now).lastInsertRowid);
    }
    const markerStmt = db.prepare(
      'INSERT INTO map_markers(type_id, name, latitude, longitude, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
    );
    for (const [mkType, mkName, mkLat, mkLng] of [
      ['تجهیز در حال نصب', 'نصب سوئیچ — ساختمان اداری', 35.7289, 51.3896],
      ['تجهیز در حال نصب', 'نصب اکسس‌پوینت — طبقه ۳', 35.7312, 51.4021],
      ['تجهیز در حال نصب', 'نصب دوربین — ورودی شرقی', 35.7021, 51.4243],
      ['تجهیز در حال نصب', 'نصب UPS — اتاق سرور', 35.7108, 51.3588],
      ['تجهیز در حال نصب', 'نصب لینک بی‌سیم — پشت‌بام', 35.6962, 51.4015],
      ['محل حادثه و خرابی', 'خرابی فیبر — مسیر شمالی', 35.7402, 51.3711],
      ['نقطه بازدید دوره‌ای', 'بازدید ماهانه — شعبه غرب', 35.8355, 50.9915],
    ]) {
      markerStmt.run(mtypeIds[mkType], mkName, mkLat, mkLng, '', now, now);
    }

    // قوانین هشدار پیش‌فرض
    const ruleStmt = db.prepare(
      'INSERT INTO alert_rules(name, enabled, metric, comparator, threshold, duration_sec, severity, scope_group_id, cooldown_sec, apply_to_unmon, silent, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    ruleStmt.run('قطع دسترسی تجهیز', 1, 'offline', 'gte', 1, 0, 'critical', null, 600, 1, 0, now);
    ruleStmt.run('تأخیر بیش از حد مجاز', 1, 'latency', 'gte', 150, 60, 'warning', null, 900, 0, 0, now);
    ruleStmt.run('افت شدید بسته (Packet Loss)', 1, 'loss', 'gte', 10, 0, 'warning', null, 600, 0, 0, now);
    ruleStmt.run('بازگشت تجهیز به وضعیت عادی', 1, 'recovery', 'lte', 1, 0, 'info', null, 0, 0, 0, now);
    ruleStmt.run('تأخیر بحرانی ستون فقرات', 1, 'latency', 'gte', 90, 120, 'critical', groups.get('هسته شبکه'), 1200, 0, 1, now);

    // ---------------- تولید تاریخچه ۷ روزه ----------------
    const HOURS = 24 * 7;
    const stepMs = 5 * 60 * 1000; // نمونه هر ۵ دقیقه
    const totalSlots = HOURS * 12;
    const startTs = Math.floor((now - HOURS * 3600000) / stepMs) * stepMs;

    const sampleStmt = db.prepare(
      'INSERT INTO samples(device_id, ts, rtt_ms, packets_sent, packets_recv, loss_pct, status, ok, mode) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    const outageStmt = db.prepare(
      'INSERT INTO outages(device_id, started_at, ended_at, duration_sec, cause, detail, lat, lng, open) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    const daily = new Map(); // key deviceId|day
    const bump = (deviceId, ts, ok, rtt, loss) => {
      const day = new Date(ts).toISOString().slice(0, 10);
      const key = `${deviceId}|${day}`;
      let row = daily.get(key);
      if (!row) {
        row = { deviceId, day, checks: 0, failed: 0, sum: 0, n: 0, max: 0, loss: 0, outages: 0, downtime: 0 };
        daily.set(key, row);
      }
      row.checks++;
      if (!ok) row.failed++;
      if (rtt != null) {
        row.sum += rtt;
        row.n++;
        row.max = Math.max(row.max, rtt);
      }
      row.loss += ok ? 0 : 100;
      return row;
    };

    const offlineNow = new Set();
    const warningNow = new Set();
    const outageCounters = new Map();

    const active = inserted.filter((d) => !d.disabled);
    // انتخاب تعدادی تجهیز برای وضعیت فعلی
    const shuffled = [...active].sort(() => rnd() - 0.5);
    const currentOffline = new Set(shuffled.slice(0, 4).map((d) => d.id));
    const currentWarning = new Set(shuffled.slice(4, 13).map((d) => d.id));

    for (const d of inserted) {
      if (d.disabled) continue;
      const baseLat = 3 + rnd() * 45;
      const jitter = 2 + rnd() * 18;
      const lossiness = rnd() > 0.78 ? 0.25 + rnd() * 0.5 : 0.02;
      const flapProne = rnd() > 0.7;

      // ساخت پنجره‌های قطعی تصادفی
      const windows = [];
      const nOut = flapProne ? 3 + Math.floor(rnd() * 4) : Math.floor(rnd() * 3);
      for (let i = 0; i < nOut; i++) {
        const startSlot = Math.floor(rnd() * (totalSlots - 20));
        const len = 1 + Math.floor(rnd() * (flapProne ? 9 : 4));
        windows.push([startSlot, startSlot + len]);
      }
      // قطعی جاری برای تجهیزات آفلاین
      if (currentOffline.has(d.id)) windows.push([totalSlots - 3, totalSlots + 1]);

      let prevStatus = STATUS.ONLINE;
      let openOutageId = null;

      for (let s = 0; s < totalSlots; s++) {
        const ts = startTs + s * stepMs;
        const inWindow = windows.find(([a, b]) => s >= a && s < b);
        let ok = true;
        let loss = 0;

        if (inWindow) {
          ok = false;
          loss = 100;
        } else if (rnd() < lossiness * 0.25) {
          loss = 30 + rnd() * 70;
          ok = rnd() > 0.5;
        }

        const rtt = ok ? Math.max(0.4, baseLat + (rnd() - 0.5) * jitter * 2 + (s % 288) * 0.004) : null;
        const status = ok ? (rtt > 150 ? STATUS.WARNING : STATUS.ONLINE) : STATUS.OFFLINE;
        sampleStmt.run(d.id, ts, rtt == null ? null : Number(rtt.toFixed(2)), 3, ok ? (loss ? 2 : 3) : 0, Number(loss.toFixed(1)), status, ok ? 1 : 0, 'history');
        const row = bump(d.id, ts, ok, rtt, loss);

        if (status === STATUS.OFFLINE && prevStatus !== STATUS.OFFLINE) {
          const cause = CAUSES[Math.floor(rnd() * CAUSES.length)];
          const res = outageStmt.run(d.id, ts, null, null, cause, '', d.lat, d.lng, 1);
          openOutageId = Number(res.lastInsertRowid);
          row.outages++;
          outageCounters.set(d.id, (outageCounters.get(d.id) || 0) + 1);
        } else if (status !== STATUS.OFFLINE && prevStatus === STATUS.OFFLINE && openOutageId) {
          const dur = Math.max(60, Math.round((ts - (startTs + (inWindow ? inWindow[0] : s) * stepMs)) / 1000));
          db.prepare('UPDATE outages SET ended_at=?, duration_sec=?, open=0 WHERE id=?').run(ts, dur, openOutageId);
          const key = `${d.id}|${new Date(ts).toISOString().slice(0, 10)}`;
          const r2 = daily.get(key);
          if (r2) r2.downtime += dur;
          openOutageId = null;
        } else if (status === STATUS.OFFLINE && openOutageId) {
          const key = `${d.id}|${new Date(ts).toISOString().slice(0, 10)}`;
          const r2 = daily.get(key);
          if (r2) r2.downtime += stepMs / 1000;
        }
        prevStatus = status;
      }
      if (currentOffline.has(d.id)) offlineNow.add(d.id);
      else if (currentWarning.has(d.id) || baseLat > 90) warningNow.add(d.id);
    }

    // آمار روزانه
    const dailyStmt = db.prepare(
      'INSERT INTO daily_stats(device_id, day, checks, failed, avg_rtt, max_rtt, loss_pct, outages, downtime_sec, uptime_pct) VALUES (?,?,?,?,?,?,?,?,?,?) ' +
        'ON CONFLICT(device_id, day) DO UPDATE SET checks=excluded.checks, failed=excluded.failed, avg_rtt=excluded.avg_rtt, max_rtt=excluded.max_rtt, loss_pct=excluded.loss_pct, outages=excluded.outages, downtime_sec=excluded.downtime_sec, uptime_pct=excluded.uptime_pct'
    );
    for (const row of daily.values()) {
      const avg = row.n ? row.sum / row.n : null;
      const uptime = row.checks ? ((row.checks - row.failed) / row.checks) * 100 : null;
      dailyStmt.run(
        row.deviceId,
        row.day,
        row.checks,
        row.failed,
        avg == null ? null : Number(avg.toFixed(2)),
        Number(row.max.toFixed(2)),
        Number((row.loss / row.checks).toFixed(2)),
        row.outages,
        Math.round(row.downtime),
        uptime == null ? null : Number(uptime.toFixed(2))
      );
    }

    // یکسان‌سازی: تنها تجهیزات در حال قطعی حق دارند قطعی «باز» داشته باشند و حداکثر یکی
    const offlineIds = [...currentOffline];
    db.prepare(
      `UPDATE outages SET ended_at = started_at + 60000, duration_sec = 60, open = 0
       WHERE open = 1 AND device_id NOT IN (${offlineIds.length ? offlineIds.map(() => '?').join(',') : 'NULL'})`
    ).run(...offlineIds);
    for (const id of offlineIds) {
      db.prepare(
        `UPDATE outages SET ended_at = started_at + 60000, duration_sec = 60, open = 0
         WHERE device_id = ? AND open = 1 AND id != (SELECT id FROM outages WHERE device_id = ? AND open = 1 ORDER BY started_at DESC LIMIT 1)`
      ).run(id, id);
    }

    // وضعیت فعلی و شاخص‌های تجمیعی
    const aggStmt = db.prepare(`SELECT
        COUNT(*) AS checks,
        SUM(ok) AS ok_count,
        MIN(rtt_ms) AS min_rtt,
        MAX(rtt_ms) AS max_rtt,
        AVG(rtt_ms) AS avg_rtt,
        AVG(loss_pct) AS avg_loss,
        MAX(ts) AS last_ts
      FROM samples WHERE device_id = ?`);
    const lastSample = db.prepare(
      'SELECT rtt_ms, loss_pct, status, ts FROM samples WHERE device_id = ? ORDER BY ts DESC LIMIT 1'
    );
    const lastOutage = db.prepare('SELECT started_at FROM outages WHERE device_id = ? ORDER BY started_at DESC LIMIT 1');
    const openOutage = db.prepare('SELECT id, started_at FROM outages WHERE device_id = ? AND open = 1 ORDER BY started_at DESC LIMIT 1');
    const successCount = db.prepare('SELECT COUNT(*) AS c FROM samples WHERE device_id=? AND ok=1');
    const failCount = db.prepare('SELECT COUNT(*) AS c FROM samples WHERE device_id=? AND ok=0');

    for (const d of inserted) {
      if (d.disabled) continue;
      const a = aggStmt.get(d.id);
      const last = lastSample.get(d.id);
      const isOffline = currentOffline.has(d.id) || (last && last.status === STATUS.OFFLINE);
      const isWarning = !isOffline && (warningNow.has(d.id) || (last && last.status === STATUS.WARNING));
      const status = isOffline ? STATUS.OFFLINE : isWarning ? STATUS.WARNING : STATUS.ONLINE;
      const uptime = a.checks ? ((a.ok_count || 0) / a.checks) * 100 : 100;
      const oo = isOffline ? openOutage.get(d.id) : null;
      const lo = lastOutage.get(d.id);

      db.prepare(`UPDATE devices SET
          status=?, status_reason=?, last_check_at=?, last_status_change_at=?,
          last_rtt_ms=?, min_rtt_ms=?, max_rtt_ms=?, avg_rtt_ms=?, loss_pct=?,
          success_count=?, fail_count=?, total_checks=?,
          consecutive_failures=?, consecutive_successes=?,
          uptime_pct=?, last_outage_at=?, current_outage_id=?, current_outage_started_at=?
        WHERE id=?`).run(
        status,
        isOffline ? 'عدم پاسخ به Ping' : isWarning ? 'تأخیر یا افت بسته بیش از حد مجاز' : '',
        last ? last.ts : null,
        now - Math.floor(rnd() * 4 * 3600000),
        last ? last.rtt_ms : null,
        a.min_rtt ?? null,
        a.max_rtt ?? null,
        a.avg_rtt == null ? null : Number(a.avg_rtt.toFixed(2)),
        last ? last.loss_pct : 0,
        successCount.get(d.id).c,
        failCount.get(d.id).c,
        a.checks,
        isOffline ? 3 + Math.floor(rnd() * 12) : 0,
        isOffline ? 0 : 5 + Math.floor(rnd() * 60),
        Number(uptime.toFixed(2)),
        lo ? lo.started_at : null,
        oo ? oo.id : null,
        oo ? oo.started_at : null,
        d.id
      );
    }

    // سوابق تعمیرات به‌صورت خودکار ساخته نمی‌شوند؛ این بخش فقط شامل رکوردهایی است
    // که کاربر خودش ثبت می‌کند. بنابراین داده‌های نمونه هیچ سابقهٔ تعمیراتی ندارند.

    // هشدارهای نمونه
    const alertStmt = db.prepare(
      'INSERT INTO alerts(device_id, rule_id, severity, kind, title, message, value, created_at, status, acknowledged_at, acknowledged_by, resolved_at, notified, duplicate_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    const recentOutages = db.prepare(
      'SELECT o.id, o.device_id, o.started_at, o.ended_at, o.cause, d.name, d.ip FROM outages o JOIN devices d ON d.id=o.device_id ORDER BY o.started_at DESC LIMIT 40'
    ).all();
    recentOutages.forEach((o, idx) => {
      const sev = o.cause.includes('خرابی') || o.cause.includes('برق') ? 'critical' : 'warning';
      const status = idx < 3 ? 'active' : idx % 5 === 0 ? 'acknowledged' : 'resolved';
      alertStmt.run(
        o.device_id,
        null,
        sev,
        'offline',
        `قطع ارتباط — ${o.name}`,
        `تجهیز ${o.name} (${o.ip}) در ساعت ${new Date(o.started_at).toLocaleString('fa-IR')} پاسخ نداد. علت ثبت‌شده: ${o.cause}`,
        null,
        o.started_at,
        status,
        status !== 'active' ? o.started_at + 300000 : null,
        status !== 'active' ? 'مدیر شبکه' : null,
        o.ended_at || (status === 'resolved' ? o.started_at + 600000 : null),
        1,
        `offline:${o.device_id}:${o.started_at}`
      );
      if (o.ended_at) {
        alertStmt.run(
          o.device_id,
          null,
          'info',
          'recovery',
          `بازگشت به حالت عادی — ${o.name}`,
          `تجهیز ${o.name} مجدداً در دسترس قرار گرفت.`,
          null,
          o.ended_at,
          'resolved',
          null,
          null,
          o.ended_at,
          1,
          `recovery:${o.device_id}:${o.ended_at}`
        );
      }
    });

    db.prepare('INSERT INTO engine_log(ts, level, message) VALUES (?,?,?)').run(
      now,
      'info',
      'داده‌های نمونه اولیه بارگذاری شد (۷ روز تاریخچه).'
    );

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return true;
}

if (process.argv[1] && process.argv[1].endsWith('db.js')) {
  const created = seedIfEmpty({ force: process.argv.includes('--force') });
  console.log(created ? 'seed: done' : 'seed: skipped (already has devices)');
  console.log('db:', DB_PATH);
}
