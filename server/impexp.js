/**
 * NetWatch — ورود و خروج اطلاعات (Excel / CSV)
 * ----------------------------------------------------------------
 * کاملاً محلی؛ از کتابخانه SheetJS استفاده می‌کند و هیچ ارتباطی با اینترنت ندارد.
 */
import * as XLSX from 'xlsx';
import { isValidIp } from './ping.js';

/** نگاشت سرستون‌های فارسی/انگلیسی به فیلدهای داخلی */
const COLUMN_MAP = {
  name: 'name',
  نام: 'name',
  'نام تجهیز': 'name',
  'نام دستگاه': 'name',
  ip: 'ip',
  'آدرس ip': 'ip',
  'آدرس آیپی': 'ip',
  address: 'ip',
  hostname: 'hostname',
  'نام هاست': 'hostname',
  type: 'device_type',
  'نوع': 'device_type',
  'نوع تجهیز': 'device_type',
  'نوع دستگاه': 'device_type',
  device_type: 'device_type',
  group: 'group',
  'گروه': 'group',
  'دسته': 'group',
  'دستهبندی': 'group',
  location: 'location',
  'موقعیت': 'location',
  'محل استقرار': 'location',
  'محل': 'location',
  building: 'building',
  'ساختمان': 'building',
  rack: 'rack',
  'رک': 'rack',
  latitude: 'latitude',
  lat: 'latitude',
  'عرض جغرافیایی': 'latitude',
  longitude: 'longitude',
  lng: 'longitude',
  lon: 'longitude',
  'طول جغرافیایی': 'longitude',
  vendor: 'vendor',
  'سازنده': 'vendor',
  'برند': 'vendor',
  model: 'model',
  'مدل': 'model',
  serial: 'serial',
  'سریال': 'serial',
  owner: 'owner',
  'مسئول': 'owner',
  'مالک': 'owner',
  priority: 'priority',
  'اولویت': 'priority',
  notes: 'notes',
  'توضیحات': 'notes',
  tags: 'tags',
  'تگ': 'tags',
  'تگها': 'tags',
  enabled: 'enabled',
  'فعال': 'enabled',
  monitoring: 'monitoring_enabled',
  'مانیتورینگ': 'monitoring_enabled',
  ping_interval: 'ping_interval',
  'بازه ping': 'ping_interval',
  'بازه بررسی': 'ping_interval',
  timeout_ms: 'timeout_ms',
  'زمان انتظار': 'timeout_ms',
};

export const EXPORT_HEADERS = [
  ['name', 'نام تجهیز'],
  ['ip', 'آدرس IP'],
  ['hostname', 'نام هاست'],
  ['device_type', 'نوع تجهیز'],
  ['group', 'گروه'],
  ['location', 'محل استقرار'],
  ['building', 'ساختمان'],
  ['rack', 'رک'],
  ['latitude', 'عرض جغرافیایی'],
  ['longitude', 'طول جغرافیایی'],
  ['vendor', 'سازنده'],
  ['model', 'مدل'],
  ['serial', 'سریال'],
  ['owner', 'مسئول'],
  ['priority', 'اولویت'],
  ['ping_interval', 'بازه بررسی (ثانیه)'],
  ['timeout_ms', 'زمان انتظار (میلی‌ثانیه)'],
  ['tags', 'تگ‌ها'],
  ['enabled', 'فعال'],
  ['monitoring_enabled', 'مانیتورینگ فعال'],
  ['notes', 'توضیحات'],
  ['status', 'وضعیت'],
  ['last_rtt_ms', 'آخرین تأخیر (ms)'],
  ['uptime_pct', 'دسترس‌پذیری (٪)'],
  ['loss_pct', 'افت بسته (٪)'],
];

function foldKey(key) {
  return String(key ?? '')
    .replace(/\u200c/g, ' ')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function normalizeKey(key) {
  const k = foldKey(key);
  return COLUMN_MAP[k] || k.replace(/\s+/g, '_');
}

/** نگاشت سرستون‌های فایل علامت‌های نقشه (نام، نوع، مختصات) */
const MARKER_COLUMN_MAP = {
  name: 'name',
  'نام': 'name',
  'نام علامت': 'name',
  'نام نشان': 'name',
  'نام نشانه': 'name',
  'عنوان': 'name',
  title: 'name',
  type: 'type',
  'نوع': 'type',
  'نوع علامت': 'type',
  'نوع نشان': 'type',
  'دسته': 'type',
  latitude: 'latitude',
  lat: 'latitude',
  'عرض جغرافیایی': 'latitude',
  'عرض': 'latitude',
  longitude: 'longitude',
  lng: 'longitude',
  lon: 'longitude',
  'طول جغرافیایی': 'longitude',
  'طول': 'longitude',
  notes: 'notes',
  'توضیحات': 'notes',
  'یادداشت': 'notes',
  color: 'color',
  'رنگ': 'color',
  icon: 'icon',
  'آیکون': 'icon',
};

export function normalizeMarkerKey(key) {
  const k = foldKey(key);
  return MARKER_COLUMN_MAP[k] || k.replace(/\s+/g, '_');
}

export const MARKER_EXPORT_HEADERS = [
  ['name', 'نام علامت'],
  ['type', 'نوع علامت'],
  ['latitude', 'عرض جغرافیایی'],
  ['longitude', 'طول جغرافیایی'],
  ['notes', 'توضیحات'],
];

// سقف تعداد ردیف‌های ورودی: هر ردیف به یک شیء جداگانه تبدیل و اعتبارسنجی می‌شود؛
// فایل‌های ناخواسته (مثلاً CSV چند صد هزار سطری) حافظهٔ سرور را تمام می‌کنند.
export const MAX_IMPORT_ROWS = 50000;

export function parseBuffer(buffer, filename = '', keyFn = normalizeKey) {
  // ورودی CSV به‌صورت صریح UTF-8 رمزگشایی می‌شود: SheetJS بدون BOM، متن فارسی را
  // با یک کدگذاری تک‌بایتی می‌خواند و سرستون‌ها به‌هم‌ریخته می‌شوند. فایل CSV
  // ذخیره‌شده با Excel یا ویرایشگرهای متن معمولاً BOM ندارد.
  // (گزینهٔ `codepage` در نسخهٔ رسمی SheetJS جدول‌های کدگذاری را همراه ندارد.)
  const wb = /\.csv$/i.test(String(filename || ''))
    ? XLSX.read(new TextDecoder('utf-8').decode(buffer).replace(/^\uFEFF/, ''), { type: 'string' })
    : XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { headers: [], rows: [] };
  const sheet = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
  if (!matrix.length) return { headers: [], rows: [] };
  if (matrix.length - 1 > MAX_IMPORT_ROWS) {
    throw new Error(`تعداد ردیف‌های فایل (${matrix.length - 1}) بیش از حد مجاز است؛ حداکثر ${MAX_IMPORT_ROWS} ردیف در هر بار ورود پشتیبانی می‌شود.`);
  }
  const rawHeaders = matrix[0].map((h) => String(h ?? '').trim());
  const keys = rawHeaders.map(keyFn);
  const rows = [];
  for (let i = 1; i < matrix.length; i++) {
    const arr = matrix[i];
    if (!arr || arr.every((c) => String(c ?? '').trim() === '')) continue;
    const obj = { __row: i + 1 };
    keys.forEach((k, idx) => {
      if (!k) return;
      let v = arr[idx];
      if (v instanceof Date) v = v.toISOString();
      obj[k] = typeof v === 'string' ? v.trim() : v;
    });
    rows.push(obj);
  }
  return { headers: rawHeaders, keys, rows, sheetName };
}

export function toBool(v, fallback = 1) {
  if (v === '' || v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on', 'فعال', 'بله', 'آری', 'دارد'].includes(s)) return 1;
  if (['0', 'false', 'no', 'n', 'off', 'غیرفعال', 'خیر', 'ندارد'].includes(s)) return 0;
  return fallback;
}

const PRIORITIES = ['low', 'normal', 'high', 'critical'];
const PRIORITY_FA = { 'کم': 'low', 'عادی': 'normal', 'متوسط': 'normal', 'بالا': 'high', 'بحرانی': 'critical', 'حیاتی': 'critical' };

export function normalizePriority(v) {
  if (v == null || v === '') return 'normal';
  const s = String(v).trim().toLowerCase();
  if (PRIORITY_FA[s]) return PRIORITY_FA[s];
  return PRIORITIES.includes(s) ? s : 'normal';
}

/**
 * اعتبارسنجی ردیف‌های ورودی
 * @returns {{ valid: Array, errors: Array, duplicates: Array }}
 */
export function validateRows(rows, existing = []) {
  const byIp = new Map(existing.map((d) => [String(d.ip).trim(), d]));
  const seen = new Map();
  const valid = [];
  const errors = [];
  const duplicates = [];

  for (const r of rows) {
    const issues = [];
    const name = String(r.name ?? '').trim();
    const ip = String(r.ip ?? '').trim();
    if (!name) issues.push('نام تجهیز وارد نشده است');
    if (!ip) issues.push('آدرس IP وارد نشده است');
    else if (!isValidIp(ip)) issues.push(`آدرس IP نامعتبر: ${ip}`);
    if (ip && seen.has(ip)) issues.push(`IP تکراری در فایل (ردیف ${seen.get(ip)})`);
    if (ip && byIp.has(ip)) issues.push(`IP تکراری در سیستم — تجهیز «${byIp.get(ip).name}»`);

    const lat = r.latitude === '' || r.latitude == null ? null : Number(r.latitude);
    const lng = r.longitude === '' || r.longitude == null ? null : Number(r.longitude);
    if (lat != null && (Number.isNaN(lat) || lat < -90 || lat > 90)) issues.push('عرض جغرافیایی نامعتبر');
    if (lng != null && (Number.isNaN(lng) || lng < -180 || lng > 180)) issues.push('طول جغرافیایی نامعتبر');

    const record = {
      row: r.__row,
      name,
      ip,
      hostname: String(r.hostname ?? '').trim(),
      device_type: String(r.device_type ?? 'سوئیچ').trim() || 'سوئیچ',
      group: String(r.group ?? '').trim(),
      location: String(r.location ?? '').trim(),
      building: String(r.building ?? '').trim(),
      rack: String(r.rack ?? '').trim(),
      latitude: lat,
      longitude: lng,
      vendor: String(r.vendor ?? '').trim(),
      model: String(r.model ?? '').trim(),
      serial: String(r.serial ?? '').trim(),
      owner: String(r.owner ?? '').trim(),
      priority: normalizePriority(r.priority),
      notes: String(r.notes ?? '').trim(),
      tags: String(r.tags ?? '')
        .split(/[,،;|]/)
        .map((t) => t.trim())
        .filter(Boolean),
      enabled: toBool(r.enabled, 1),
      monitoring_enabled: toBool(r.monitoring_enabled, 1),
      ping_interval: r.ping_interval === '' || r.ping_interval == null ? null : Number(r.ping_interval) || null,
      timeout_ms: r.timeout_ms === '' || r.timeout_ms == null ? null : Number(r.timeout_ms) || null,
    };

    if (ip && !seen.has(ip)) seen.set(ip, r.__row);
    if (issues.length) {
      errors.push({ ...record, issues });
      if (issues.some((x) => x.includes('تکراری'))) duplicates.push({ ...record, issues });
    } else {
      valid.push(record);
    }
  }
  return { valid, errors, duplicates };
}

export function buildWorkbook(rows, headers = EXPORT_HEADERS) {
  const keys = headers.map((h) => h[0]);
  const labels = headers.map((h) => h[1]);
  const data = rows.map((r) =>
    Object.fromEntries(labels.map((label, i) => [label, r[keys[i]] == null ? '' : r[keys[i]]]))
  );
  const ws = XLSX.utils.json_to_sheet(data, { header: labels });
  ws['!cols'] = labels.map((l) => ({ wch: Math.max(12, Math.min(34, String(l).length + 12)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Devices');
  return wb;
}

export function workbookToBuffer(wb, format = 'xlsx') {
  if (format === 'csv') {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]], { forceQuotes: false });
    return Buffer.from('\uFEFF' + csv, 'utf8'); // BOM برای نمایش صحیح فارسی در Excel
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * اعتبارسنجی ردیف‌های ورودی علامت‌های نقشه.
 * @returns {{ valid: Array, errors: Array }}
 */
export function validateMarkerRows(rows, existingTypes = []) {
  const knownTypes = new Set(existingTypes.map((t) => String(t).trim()));
  const valid = [];
  const errors = [];
  for (const r of rows) {
    const issues = [];
    const name = String(r.name ?? '').trim();
    const type = String(r.type ?? '').trim();
    const lat = r.latitude === '' || r.latitude == null ? NaN : Number(r.latitude);
    const lng = r.longitude === '' || r.longitude == null ? NaN : Number(r.longitude);
    if (!name) issues.push('نام علامت وارد نشده است');
    if (!type) issues.push('نوع علامت وارد نشده است');
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) issues.push('عرض جغرافیایی نامعتبر');
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) issues.push('طول جغرافیایی نامعتبر');
    const record = {
      row: r.__row,
      name,
      type,
      latitude: Number.isFinite(lat) ? lat : null,
      longitude: Number.isFinite(lng) ? lng : null,
      notes: String(r.notes ?? '').trim().slice(0, 500),
      color: String(r.color ?? '').trim(),
      icon: String(r.icon ?? '').trim(),
      newType: !!type && !knownTypes.has(type),
    };
    if (issues.length) errors.push({ ...record, issues });
    else valid.push(record);
  }
  return { valid, errors };
}

export function buildMarkerWorkbook(rows) {
  const keys = MARKER_EXPORT_HEADERS.map((h) => h[0]);
  const labels = MARKER_EXPORT_HEADERS.map((h) => h[1]);
  const data = rows.map((r) => Object.fromEntries(labels.map((label, i) => [label, r[keys[i]] == null ? '' : r[keys[i]]])));
  const ws = XLSX.utils.json_to_sheet(data, { header: labels });
  ws['!cols'] = labels.map((l) => ({ wch: Math.max(14, Math.min(34, String(l).length + 12)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Markers');
  return wb;
}

/** ردیف‌های نمونه برای فایل «علامت‌های نقشه» */
export function markerTemplateRows() {
  return [
    {
      name: 'نصب سوئیچ — ساختمان اداری',
      type: 'تجهیز در حال نصب',
      latitude: 35.7289,
      longitude: 51.3896,
      notes: 'این ردیف نمونه است و می‌توانید حذفش کنید.',
    },
    {
      name: 'نصب اکسس‌پوینت — طبقه ۳',
      type: 'تجهیز در حال نصب',
      latitude: 35.7312,
      longitude: 51.4021,
      notes: '',
    },
    {
      name: 'خرابی فیبر — مسیر شمالی',
      type: 'محل حادثه و خرابی',
      latitude: 35.7402,
      longitude: 51.3711,
      notes: 'نیازمند بازدید فوری',
    },
    {
      name: 'بازدید ماهانه — شعبه غرب',
      type: 'نقطه بازدید دوره‌ای',
      latitude: 35.8355,
      longitude: 50.9915,
      notes: '',
    },
  ];
}

export function templateRows() {
  return [
    {
      name: 'نمونه — سوئیچ دسترسی',
      ip: '192.168.10.20',
      device_type: 'سوئیچ',
      group: 'سوئیچ‌های دسترسی',
      location: 'تهران — ساختمان اداری',
      latitude: 35.7289,
      longitude: 51.3896,
      vendor: 'Cisco',
      owner: 'تیم شبکه',
      priority: 'normal',
      tags: 'حیاتی, نقطه لبه',
      enabled: 1,
      monitoring_enabled: 1,
      notes: 'این ردیف نمونه است و می‌توانید حذفش کنید.',
    },
  ];
}
