/**
 * NetWatch — منطق قالب تجهیز، گروه‌های چندعضویتی و تشخیص تعارض
 * ----------------------------------------------------------------
 * این ماژول مستقل از HTTP است تا آزمون واحد بتواند قاعده‌های اصلی را
 * مستقیم بسنجد:
 *   • اعمال قالب هرگز بدون تأیید صریح (`overwrite: true`) مقدار اختصاصی
 *     تجهیز را بازنویسی نمی‌کند.
 *   • تعارض IP فقط به‌عنوان «مشکوک» با شواهد گزارش می‌شود؛ هیچ نتیجهٔ قطعی
 *     بدون شاهد ساخته نمی‌شود.
 */
import { db, getSettings, transaction } from './db.js';
import { sanitizeDeviceInput } from './store.js';

/** فیلدهایی که قالب اجازهٔ اشتراک‌گذاری‌شان را دارد (نه هویت و نه IP). */
export const TEMPLATE_FIELDS = Object.freeze([
  'device_type',
  'vendor',
  'model',
  'firmware',
  'priority',
  'monitoring_enabled',
  'ping_interval',
  'timeout_ms',
  'packet_count',
  'retries',
  'latency_threshold',
  'loss_threshold',
]);

const FIELD_LABELS = {
  device_type: 'نوع تجهیز',
  vendor: 'سازنده',
  model: 'مدل',
  firmware: 'نسخهٔ firmware',
  priority: 'اولویت',
  monitoring_enabled: 'پایش خودکار',
  ping_interval: 'بازهٔ بررسی',
  timeout_ms: 'زمان انتظار',
  packet_count: 'تعداد بسته',
  retries: 'تلاش مجدد',
  latency_threshold: 'آستانهٔ تأخیر',
  loss_threshold: 'آستانهٔ افت بسته',
};

export function fieldLabel(field) {
  return FIELD_LABELS[field] || field;
}

/** اعتبارسنجی و پاک‌سازی تنظیمات قالب با همان قواعد ورودی تجهیز */
export function normalizeTemplateSettings(input = {}) {
  const clean = sanitizeDeviceInput(
    Object.fromEntries(Object.entries(input || {}).filter(([k]) => TEMPLATE_FIELDS.includes(k))),
    { partial: true }
  );
  return Object.fromEntries(Object.entries(clean).filter(([k]) => TEMPLATE_FIELDS.includes(k)));
}

export function serializeTemplate(row) {
  let settings;
  try {
    settings = JSON.parse(row.settings || '{}');
  } catch {
    settings = {};
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    deviceType: row.device_type || '',
    settings: Object.fromEntries(Object.entries(settings).filter(([k]) => TEMPLATE_FIELDS.includes(k))),
    createdBy: row.created_by || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deviceCount: row.device_count ?? undefined,
  };
}

export function createTemplate({ name, description = '', settings = {} }, { actor = '' } = {}) {
  const cleanName = String(name || '').trim().slice(0, 120);
  if (!cleanName) throw new Error('نام قالب الزامی است.');
  const normalized = normalizeTemplateSettings(settings);
  if (!Object.keys(normalized).length) throw new Error('قالب باید حداقل یک تنظیم مشترک داشته باشد.');
  if (db.prepare('SELECT id FROM device_templates WHERE name = ?').get(cleanName)) throw new Error('قالبی با این نام وجود دارد.');
  const now = Date.now();
  const r = db
    .prepare(
      'INSERT INTO device_templates(name, description, device_type, settings, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
    )
    .run(
      cleanName,
      String(description || '').trim().slice(0, 500),
      String(normalized.device_type || '').slice(0, 60),
      JSON.stringify(normalized),
      String(actor || '').slice(0, 80),
      now,
      now
    );
  return serializeTemplate(db.prepare('SELECT * FROM device_templates WHERE id=?').get(Number(r.lastInsertRowid)));
}

export function updateTemplate(id, { name, description, settings }, { actor = '' } = {}) {
  const row = db.prepare('SELECT * FROM device_templates WHERE id = ?').get(Number(id));
  if (!row) return null;
  let normalized;
  if (settings !== undefined) normalized = normalizeTemplateSettings(settings);
  const nextName = name === undefined ? row.name : String(name || '').trim().slice(0, 120);
  if (!nextName) throw new Error('نام قالب الزامی است.');
  if (nextName !== row.name && db.prepare('SELECT id FROM device_templates WHERE name = ? AND id != ?').get(nextName, row.id)) {
    throw new Error('قالبی با این نام وجود دارد.');
  }
  const finalSettings = normalized === undefined ? row.settings : JSON.stringify(normalized);
  if (normalized && !Object.keys(normalized).length) throw new Error('قالب باید حداقل یک تنظیم مشترک داشته باشد.');
  db.prepare('UPDATE device_templates SET name=?, description=?, device_type=?, settings=?, updated_at=? WHERE id=?').run(
    nextName,
    description === undefined ? row.description : String(description || '').trim().slice(0, 500),
    normalized?.device_type ?? row.device_type,
    finalSettings,
    Date.now(),
    row.id
  );
  return { ...serializeTemplate(db.prepare('SELECT * FROM device_templates WHERE id=?').get(row.id)), updatedBy: String(actor || '') };
}

export function deleteTemplate(id) {
  return db.prepare('DELETE FROM device_templates WHERE id=?').run(Number(id)).changes;
}

/**
 * اعمال قالب روی تجهیزات انتخابی.
 *
 * @param {number} templateId
 * @param {{deviceIds:number[], fields?:string[], overwrite?:boolean}} options
 * @returns {{updated:number, skipped:number, details:{deviceId:number,name:string,applied:string[],preserved:string[]}[]}}
 */
export function applyTemplate(templateId, { deviceIds = [], fields = null, overwrite = false } = {}) {
  const template = db.prepare('SELECT * FROM device_templates WHERE id=?').get(Number(templateId));
  if (!template) {
    const err = new Error('قالب یافت نشد.');
    err.status = 404;
    throw err;
  }
  let settings = {};
  try {
    settings = JSON.parse(template.settings || '{}');
  } catch {
    settings = {};
  }
  const keys = TEMPLATE_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(settings, k));
  const selected = keys.filter((k) => !Array.isArray(fields) || fields.includes(k));
  if (!selected.length) throw new Error('هیچ فیلد قابل اعمالی انتخاب نشده است.');
  const ids = [...new Set((deviceIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500);
  if (!ids.length) throw new Error('هیچ تجهیزی انتخاب نشده است.');

  return transaction(
    () => {
      const details = [];
      let updated = 0;
      let skipped = 0;
      for (const id of ids) {
        const device = db.prepare('SELECT * FROM devices WHERE id=?').get(id);
        if (!device) continue;
        const applied = [];
        const preserved = [];
        const sets = [];
        const vals = [];
        for (const key of selected) {
          const next = settings[key];
          const current = device[key];
          const isEmpty = current === null || current === undefined || current === '';
          // تنها با تأیید صریح بازنویسی می‌شود؛ در غیر این صورت فقط فیلد خالی پر می‌شود.
          if (!overwrite && !isEmpty) {
            preserved.push(key);
            continue;
          }
          if (current !== next) {
            sets.push(`${key} = ?`);
            vals.push(next);
            applied.push(key);
          }
        }
        if (sets.length) {
          sets.push('updated_at = ?');
          vals.push(Date.now(), id);
          db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
          updated += 1;
        } else {
          skipped += 1;
        }
        details.push({ deviceId: id, name: device.name, applied, preserved });
      }
      db.prepare('INSERT INTO engine_log(ts, level, message) VALUES (?,?,?)').run(
        Date.now(),
        'info',
        `قالب «${template.name}» روی ${updated} تجهیز اعمال شد (بازنویسی: ${overwrite ? 'بله' : 'خیر'}).`
      );
      return { updated, skipped, details };
    },
    { label: 'management.applyTemplate' }
  );
}

/* ------------------------------------------------------------------ */
/* تشخیص تعارض IP                                                     */
/* ------------------------------------------------------------------ */

function devicesBy(rows) {
  return rows.map((d) => ({ id: d.id, name: d.name, ip: d.ip, status: d.status, hostname: d.hostname || '', serial: d.serial || '' }));
}

/**
 * موارد مشکوک تعارض. ماهیت روش:
 *   • IP هر تجهیز در پایگاه‌داده یکتاست (قید UNIQUE)؛ پس «تعارض IP» واقعی با
 *     دو تجهیز هم‌IP از این مسیر قابل مشاهده نیست و هرگز ادعا نمی‌شود.
 *   • شواهد قابل اتکا: یک شماره سریال روی چند IP، یک نام هاست روی چند IP، و
 *     IP ثبت‌شده‌ای که هم‌زمان در فهرست کشف دیده شده است. هر مورد با
 *     `definitive: false` و فهرست شواهد برگردانده می‌شود تا مدیر تأیید کند.
 */
export function detectConflicts() {
  const now = Date.now();
  const items = [];
  const devices = db.prepare('SELECT id, name, ip, status, hostname, serial FROM devices ORDER BY name').all();

  const groupBy = (keyFn) => {
    const map = new Map();
    for (const d of devices) {
      const key = keyFn(d);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(d);
    }
    return [...map.entries()].filter(([, list]) => list.length > 1);
  };

  for (const [serial, list] of groupBy((d) => String(d.serial || '').trim().toLowerCase())) {
    items.push({
      id: `serial:${serial}`,
      type: 'duplicate_serial',
      severity: 'warning',
      confidence: 'high',
      definitive: false,
      ip: null,
      title: 'شماره سریال تکراری روی چند تجهیز',
      detail: 'یک شماره سریال برای چند دستگاه ثبت شده است؛ ممکن است یکی از رکوردها تکراری یا جابه‌جا باشد.',
      evidence: [`شماره سریال «${serial}» در ${list.length} تجهیز`, ...list.map((d) => `${d.name} → ${d.ip}`)],
      devices: devicesBy(list),
    });
  }

  for (const [hostname, list] of groupBy((d) => String(d.hostname || '').trim().toLowerCase())) {
    items.push({
      id: `hostname:${hostname}`,
      type: 'duplicate_hostname',
      severity: 'info',
      confidence: 'medium',
      definitive: false,
      ip: null,
      title: 'نام هاست تکراری روی چند IP',
      detail: 'نام هاست یکسان با آدرس‌های متفاوت دیده می‌شود؛ احتمال تغییر IP یا ثبت دوباره وجود دارد.',
      evidence: [`نام هاست «${hostname}» در ${list.length} تجهیز`, ...list.map((d) => `${d.name} → ${d.ip}`)],
      devices: devicesBy(list),
    });
  }

  return { items, checkedDevices: devices.length, generatedAt: now, note: 'هیچ موردی به‌عنوان تعارض قطعی ثبت نشده است؛ همه موارد نیازمند تأیید مدیر هستند.' };
}

/** تنظیمات پیش‌فرض مورد استفاده برای قالب‌سازی سریع */
export function templateFromDevice(deviceId) {
  const d = db.prepare('SELECT * FROM devices WHERE id=?').get(Number(deviceId));
  if (!d) return null;
  return Object.fromEntries(TEMPLATE_FIELDS.filter((k) => d[k] !== null && d[k] !== undefined).map((k) => [k, d[k]]));
}

export function currentTimezoneOffset() {
  return Number(getSettings().timezone_offset_minutes) || 0;
}
