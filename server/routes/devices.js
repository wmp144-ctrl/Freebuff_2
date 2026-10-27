/**
 * NetWatch — API تجهیزات
 */
import express from 'express';
import { db, getSettings, transaction, requireDiskSpace } from '../db.js';
import {
  listDevices,
  getDevice,
  createDevice,
  updateDevice,
  deleteDevices,
  closeDeviceMonitoringState,
  parseListQuery,
  attachTags,
  groupByName,
  buildDeviceWhere,
  setDeviceGroups,
} from '../store.js';
import { runJob } from '../jobs.js';
import { engine } from '../engine.js';
import { isValidIp } from '../ping.js';
import { templateRows, EXPORT_HEADERS } from '../impexp.js';
import { routePermission, requirePermission, hasPermission } from '../permissions.js';
import { spreadsheetUpload as upload } from '../upload.js';
import { probeTargetGuard, allowedProbeDeviceIds } from '../probe-guard.js';
import { probeQueue, createProbeBatch, recordProbeBatchResult, getProbeBatch } from '../probe-queue.js';
import { cleanupDeviceAttachmentFiles } from '../attachments.js';
import { jalaliLabelFromMs } from '../jalali.js';

const router = express.Router();

/**
 * خطای پردازش فایل ورودی خطای کاربر است، نه خطای داخلی سرور.
 * JobError برای شکست Worker پیش‌فرض 500 دارد؛ اگر همان را مستقیم برگردانیم،
 * یک فایل Excel خراب پاسخ ۵۰۰ می‌گیرد و در پایش به‌عنوان خرابی سرویس ثبت
 * می‌شود. فقط کدهای زیرساختی (صف پر/مهلت/حجم) حفظ می‌شوند و بقیه ۴۰۰ هستند.
 */
function importErrorStatus(error) {
  const status = Number(error?.status);
  return [413, 415, 429, 503, 504, 507].includes(status) ? status : 400;
}

// خواندن با devices:read و هر تغییر با devices:write (Viewer فقط می‌خواند).
router.use(routePermission({ read: 'devices:read', write: 'devices:write' }));

const RANGE_BUCKETS = {
  '15m': { ms: 60 * 1000, label: '۱ دقیقه' },
  '1h': { ms: 60 * 1000, label: '۱ دقیقه' },
  '6h': { ms: 5 * 60 * 1000, label: '۵ دقیقه' },
  '24h': { ms: 15 * 60 * 1000, label: '۱۵ دقیقه' },
  '7d': { ms: 60 * 60 * 1000, label: '۱ ساعت' },
  '30d': { ms: 6 * 60 * 60 * 1000, label: '۶ ساعت' },
  '90d': { ms: 24 * 60 * 60 * 1000, label: '۱ روز' },
};
const RANGE_MS = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

/* --------------------------- سری زمانی --------------------------- */

/**
 * باکت‌های مجاز برای پنجرهٔ زمانی دلخواه. بزرگ‌ترین مقدار (۱ روز) برای
 * نمای ماهانهٔ چند ماهه و کوچک‌ترین (۱ دقیقه) برای نمای ساعتی است.
 */
const ALLOWED_BUCKETS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];
const BUCKET_LABELS = new Map([
  [60_000, '۱ دقیقه'],
  [5 * 60_000, '۵ دقیقه'],
  [15 * 60_000, '۱۵ دقیقه'],
  [30 * 60_000, '۳۰ دقیقه'],
  [60 * 60_000, '۱ ساعت'],
  [6 * 60 * 60_000, '۶ ساعت'],
  [24 * 60 * 60_000, '۱ روز'],
]);
const MAX_WINDOW_MS = 370 * 24 * 60 * 60_000;
const MAX_WINDOW_POINTS = 4000;

function bucketLabel(bucketMs) {
  return BUCKET_LABELS.get(bucketMs) ?? `${Math.round(bucketMs / 60000)} دقیقه`;
}

/**
 * مقدار باکت را به یکی از گام‌های مجاز گرد می‌کند و اگر تعداد باکت‌های پنجره
 * از سقف پاسخ بیشتر شود، گام را بزرگ‌تر می‌کند تا پاسخ سنگین نشود.
 */
function normalizeBucket(requested, windowMs) {
  const value = Number(requested);
  let bucket = ALLOWED_BUCKETS.includes(value) ? value : ALLOWED_BUCKETS[3];
  while (windowMs / bucket > MAX_WINDOW_POINTS && bucket < ALLOWED_BUCKETS[ALLOWED_BUCKETS.length - 1]) {
    bucket = ALLOWED_BUCKETS[ALLOWED_BUCKETS.indexOf(bucket) + 1];
  }
  return bucket;
}

/** پرس‌وجوی مشترک سری زمانی؛ بازهٔ [from, to) و باکت مشخص. */
function querySeries(deviceId, from, to, bucketMs) {
  const rows = db
    .prepare(
      // پارامترهای عددی در node:sqlite به‌صورت REAL بایند می‌شوند؛ بدون CAST،
      // تقسیم اعشاری می‌شود و هر نمونهٔ خام یک «باکت» جدا می‌سازد.
      `SELECT (ts / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS bucket,
              COUNT(*) AS samples,
              SUM(ok) AS ok_count,
              AVG(CASE WHEN ok = 1 THEN rtt_ms END) AS rtt,
              MIN(CASE WHEN ok = 1 THEN rtt_ms END) AS min_rtt,
              MAX(CASE WHEN ok = 1 THEN rtt_ms END) AS max_rtt,
              AVG(CASE WHEN ok = 1 THEN 0 ELSE 100 END) AS loss,
              AVG(ok) * 100 AS availability
       FROM samples WHERE device_id = ? AND ts >= ? AND ts < ?
       GROUP BY bucket ORDER BY bucket ASC`
    )
    .all(bucketMs, bucketMs, Number(deviceId), from, to);
  return rows.map((r) => ({
    t: r.bucket,
    rtt: r.rtt == null ? null : Math.round(r.rtt * 100) / 100,
    minRtt: r.min_rtt == null ? null : Math.round(r.min_rtt * 100) / 100,
    maxRtt: r.max_rtt == null ? null : Math.round(r.max_rtt * 100) / 100,
    loss: r.loss == null ? 0 : Math.round(r.loss * 10) / 10,
    availability: r.availability == null ? 0 : Math.round(r.availability * 10) / 10,
    samples: r.samples,
    ok: r.ok_count || 0,
    down: r.samples - (r.ok_count || 0),
    status: (r.ok_count || 0) === 0 ? 'offline' : (r.availability || 0) < 99 ? 'warning' : 'online',
  }));
}

/**
 * سری زمانی تجهیز.
 *
 * `span` تعداد پنجره‌های هم‌اندازهٔ `range` است که پیش از اکنون خوانده می‌شود؛
 * با span=7 برای range=24h، هفت روز داده برمی‌گردد تا نمودار بتواند با اسکرول
 * افقی روزهای قبل را نشان دهد. حداکثر ۳۰ پنجره مجاز است تا حجم پاسخ کنترل شود.
 */
export function seriesFor(deviceId, range = '1h', span = 1) {
  const bucket = RANGE_BUCKETS[range] || RANGE_BUCKETS['1h'];
  const windows = Math.min(30, Math.max(1, Math.floor(Number(span) || 1)));
  const to = Date.now();
  const from = to - (RANGE_MS[range] || RANGE_MS['1h']) * windows;
  return {
    range,
    span: windows,
    bucketMs: bucket.ms,
    bucketLabel: bucket.label,
    from,
    to,
    points: querySeries(deviceId, from, to, bucket.ms),
  };
}

/**
 * سری زمانی یک پنجرهٔ دلخواه (نه فقط «تا اکنون»).
 *
 * نمای ماهانه/هفتگی/روزانه/ساعتی برای جابه‌جایی در تاریخ به این پنجره نیاز
 * دارد؛ query‌های range قدیمی همیشه به اکنون ختم می‌شدند و ماه قبل را
 * پوشش نمی‌دادند. ورودی‌ها این‌جا اعتبارسنجی و مرزگذاری شده‌اند.
 */
export function seriesWindowFor(deviceId, from, to, requestedBucket) {
  const end = Number(to);
  const start = Math.min(Number(from), end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    const error = new Error('بازهٔ زمانی نامعتبر است.');
    error.status = 400;
    error.code = 'INVALID_WINDOW';
    throw error;
  }
  if (end - start > MAX_WINDOW_MS) {
    const error = new Error('بازهٔ زمانی بیش از حد بزرگ است.');
    error.status = 400;
    error.code = 'WINDOW_TOO_LARGE';
    throw error;
  }
  const bucketMs = normalizeBucket(requestedBucket, end - start);
  return {
    range: 'custom',
    span: 1,
    bucketMs,
    bucketLabel: bucketLabel(bucketMs),
    from: start,
    to: end,
    points: querySeries(deviceId, start, end, bucketMs),
  };
}

/* --------------------------- فهرست و جزئیات --------------------------- */

router.get('/', (req, res) => {
  const filters = parseListQuery(req.query);
  res.json(listDevices(filters));
});

router.get('/meta', (_req, res) => {
  const settings = getSettings();
  res.json({
    // شمارش تجهیزاتی که پینگشان از آستانهٔ مجاز بالا‌تر است (برای نمایش فیلتر «پینگ بالا»)
    highLatency: db
      .prepare(
        'SELECT COUNT(*) AS c FROM devices WHERE enabled = 1 AND last_rtt_ms IS NOT NULL AND last_rtt_ms > COALESCE(latency_threshold, ?)'
      )
      .get(settings.latency_threshold).c,
    // شمارش گروه بر اساس عضویت چندگانه (با در نظر گرفتن ستون قدیمی group_id)
    groups: db
      .prepare(
        `SELECT g.*, (SELECT COUNT(DISTINCT d.id) FROM devices d WHERE d.group_id = g.id
           OR EXISTS (SELECT 1 FROM device_group_members m WHERE m.device_id = d.id AND m.group_id = g.id)) AS device_count
         FROM groups g ORDER BY g.name`
      )
      .all(),
    tags: db.prepare('SELECT t.*, (SELECT COUNT(*) FROM device_tags dt WHERE dt.tag_id = t.id) AS device_count FROM tags t ORDER BY t.name').all(),
    types: db.prepare('SELECT device_type AS value, COUNT(*) AS count FROM devices GROUP BY device_type ORDER BY count DESC').all(),
    locations: db.prepare("SELECT location AS value, COUNT(*) AS count FROM devices WHERE location != '' GROUP BY location ORDER BY count DESC").all(),
    vendors: db.prepare("SELECT vendor AS value, COUNT(*) AS count FROM devices WHERE vendor != '' GROUP BY vendor ORDER BY count DESC").all(),
    priorities: db.prepare('SELECT priority AS value, COUNT(*) AS count FROM devices GROUP BY priority').all(),
    layers: db.prepare('SELECT * FROM map_layers ORDER BY is_default DESC, name').all(),
    settings,
  });
});

router.get('/export', async (req, res) => {
  const format = String(req.query.format || 'csv').toLowerCase() === 'xlsx' ? 'xlsx' : 'csv';
  const filters = { ...parseListQuery({ ...req.query, page: '1', pageSize: '500' }) };
  let rows;
  if (req.query.ids) {
    const ids = String(req.query.ids).split(',').map((n) => Number(n)).filter(Boolean);
    rows = ids.map((id) => getDevice(id)).filter(Boolean);
  } else {
    filters.pageSize = 5000;
    rows = listDevices(filters).items;
  }
  const data = rows.map((d) => ({
    ...d,
    priority: d.priority,
    tags: (d.tags || []).map((t) => t.name).join(', '),
    enabled: d.enabled ? 1 : 0,
    monitoring_enabled: d.monitoringEnabled ? 1 : 0,
    location: d.location,
    group: d.groupName,
    device_type: d.deviceType,
    latitude: d.latitude,
    longitude: d.longitude,
    last_rtt_ms: d.lastRtt,
    uptime_pct: d.uptimePct,
    loss_pct: d.lossPct,
    status: d.status,
    installed_at: d.installedAt ? jalaliLabelFromMs(d.installedAt, getSettings().timezone_offset_minutes) : '',
  }));
  // ساخت Excel/CSV در Worker انجام می‌شود تا رشتهٔ اصلی سرور در طول پردازش
  // فایل بزرگ (هزاران ردیف) قفل نشود.
  const result = await runJob('export', { rows: data, headers: EXPORT_HEADERS, format }, { timeoutMs: 120000 });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="netwatch-devices-${stamp}.${format}"`);
  res.send(Buffer.from(result.buffer));
});

router.get('/template', async (req, res) => {
  const format = String(req.query.format || 'xlsx').toLowerCase() === 'csv' ? 'csv' : 'xlsx';
  const result = await runJob('export', { rows: templateRows(), headers: EXPORT_HEADERS, format }, { timeoutMs: 30000 });
  res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="netwatch-devices-template.${format}"`);
  res.send(Buffer.from(result.buffer));
});

/** پیش‌نمایش ورود گروهی از فایل */
router.post('/import/preview', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایلی دریافت نشد' });
  try {
    const existing = db.prepare('SELECT id, name, ip FROM devices').all();
    // پارس و اعتبارسنجی فایل در Worker؛ بدنهٔ درخواست در حافظه می‌ماند اما
    // CPU سرور برای پاسخ‌دهی به بقیهٔ APIها آزاد است.
    const result = await runJob(
      'devicesPreview',
      { buffer: req.file.buffer, filename: req.file.originalname, existing },
      { timeoutMs: 120000 }
    );
    const knownGroups = new Set(db.prepare('SELECT name FROM groups').all().map((r) => r.name));
    const knownTags = new Set(db.prepare('SELECT name FROM tags').all().map((r) => r.name));
    // پاسخ پیش‌نمایش برای فایل ۵۰٬۰۰۰ ردیفی نباید ده‌ها مگابایت JSON شود؛
    // رابط کاربری فقط شمارش‌ها و چند نمونهٔ خطا را نشان می‌دهد. شمارش کامل در
    // summary می‌ماند و نمونه‌ها سقف دارند تا حافظهٔ کلاینت/سرور کنترل شود.
    const PREVIEW_ITEMS = 200;
    res.json({
      fileName: req.file.originalname,
      headers: result.headers,
      totalRows: result.totalRows,
      valid: result.valid.slice(0, PREVIEW_ITEMS),
      errors: result.errors.slice(0, PREVIEW_ITEMS),
      duplicates: result.duplicates.slice(0, PREVIEW_ITEMS),
      truncated: {
        valid: result.valid.length > PREVIEW_ITEMS,
        errors: result.errors.length > PREVIEW_ITEMS,
        duplicates: result.duplicates.length > PREVIEW_ITEMS,
      },
      summary: {
        valid: result.valid.length,
        invalid: result.errors.length,
        duplicates: result.duplicates.length,
        newGroups: [...new Set(result.valid.map((r) => r.group).filter(Boolean))].filter((g) => !knownGroups.has(g)),
        newTags: [...new Set(result.valid.flatMap((r) => r.tags))].filter((t) => !knownTags.has(t)),
      },
    });
  } catch (e) {
    res.status(importErrorStatus(e)).json({ error: `خطا در خواندن فایل: ${e.message}` });
  }
});

/** ثبت نهایی ورود گروهی */
router.post('/import/commit', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایلی دریافت نشد' });
  const onlyValid = String(req.body?.onlyValid ?? '1') !== '0';
  try {
    const existing = db.prepare('SELECT id, name, ip FROM devices').all();
    const { valid, errors } = await runJob(
      'devicesParse',
      { buffer: req.file.buffer, filename: req.file.originalname, existing },
      { timeoutMs: 120000 }
    );
    const list = onlyValid ? valid : [...valid, ...errors.filter((e) => e.ip && isValidIp(e.ip))];
    // پیش از نوشتن دستهٔ بزرگ، فضای دیسک بررسی می‌شود؛ در غیر این صورت پر شدن
    // دیسک وسط کار، همهٔ ردیف‌ها را با خطای پایگاه‌داده برمی‌گرداند.
    requireDiskSpace(list.length * 1024 + 4 * 1024 * 1024, `ورود گروهی ${list.length} تجهیز`);
    // ورود گروهی یک عملیات اتمیک است: اگر یک ردیف شکست بخورد، هیچ تجهیزی ثبت
    // نمی‌شود (پیش‌تر ردیف‌های موفق باقی می‌ماندند و کاربر فکر می‌کرد همه ثبت شده).
    const result = transaction(
      () => {
        let inserted = 0;
        for (const r of list) {
          try {
            createDevice(r, { source: 'import' });
            inserted++;
          } catch (e) {
            const err = new Error(`ردیف «${r.name ?? ''}» (${r.ip ?? ''}) ثبت نشد: ${e.message}`);
            err.importIndex = inserted;
            throw err;
          }
        }
        db.prepare('INSERT INTO engine_log(ts, level, message) VALUES (?,?,?)').run(
          Date.now(),
          'info',
          `ورود گروهی: ${inserted} تجهیز افزوده شد.`
        );
        return { inserted };
      },
      { label: 'devices.import' }
    );
    res.json({ inserted: result.inserted, failed: [], atomic: true, skipped: onlyValid ? errors.length : 0 });
  } catch (e) {
    const status = importErrorStatus(e);
    res.status(status).json({
      error: `ورود گروهی انجام نشد و هیچ تغییری ثبت نگردید: ${e.message}`,
      rolledBack: true,
    });
  }
});

/** خروجی مختصات جغرافیایی */
router.get('/export/geo', async (req, res) => {
  const format = String(req.query.format || 'csv').toLowerCase() === 'xlsx' ? 'xlsx' : 'csv';
  const rows = db
    .prepare("SELECT name, ip, device_type AS type, location, latitude, longitude, status FROM devices WHERE latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY name")
    .all()
    .map((r) => ({ 'نام تجهیز': r.name, 'آدرس IP': r.ip, 'نوع': r.type, 'موقعیت': r.location, 'عرض جغرافیایی': r.latitude, 'طول جغرافیایی': r.longitude, 'وضعیت': r.status }));
  const headers = Object.keys(
    rows[0] || {
      'نام تجهیز': '',
      'آدرس IP': '',
      'نوع': '',
      'موقعیت': '',
      'عرض جغرافیایی': '',
      'طول جغرافیایی': '',
      'وضعیت': '',
    }
  ).map((k) => [k, k]);
  const result = await runJob('export', { rows, headers, format }, { timeoutMs: 120000 });
  res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="netwatch-locations.${format}"`);
  res.send(Buffer.from(result.buffer));
});

/** ورود مختصات جغرافیایی */
router.post('/import/geo', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایلی دریافت نشد' });
  try {
    const { rows } = await runJob(
      'parse',
      { buffer: req.file.buffer, filename: req.file.originalname },
      { timeoutMs: 120000 }
    );
    let updated = 0;
    const errors = [];
    const upd = db.prepare('UPDATE devices SET latitude = ?, longitude = ?, updated_at = ? WHERE ip = ?');
    const byName = db.prepare('SELECT id FROM devices WHERE name = ?');
    for (const r of rows) {
      const lat = Number(r.latitude);
      const lng = Number(r.longitude);
      const ip = String(r.ip ?? '').trim();
      const name = String(r.name ?? '').trim();
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        errors.push({ row: r.__row, reason: 'مختصات نامعتبر' });
        continue;
      }
      if (ip) {
        const n = upd.run(lat, lng, Date.now(), ip).changes;
        if (n) {
          updated += n;
          continue;
        }
      }
      if (name) {
        const d = byName.get(name);
        if (d) {
          db.prepare('UPDATE devices SET latitude=?, longitude=?, updated_at=? WHERE id=?').run(lat, lng, Date.now(), d.id);
          updated++;
          continue;
        }
      }
      errors.push({ row: r.__row, reason: 'تجهیزی با این IP یا نام یافت نشد' });
    }
    res.json({ updated, errors });
  } catch (e) {
    res.status(400).json({ error: `خطا در خواندن فایل: ${e.message}` });
  }
});

/* --------------------------- عملیات گروهی --------------------------- */

router.post('/bulk', (req, res) => {
  const { ids = [], action, payload = {} } = req.body || {};
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Boolean);
  if (!list.length) return res.status(400).json({ error: 'هیچ تجهیزی انتخاب نشده است' });
  // سقف ورودی گروهی: درخواست با ده‌ها‌هزار شناسه نه منطقی است و نه باید
  // تراکنشی با هزاران پارامتر SQL بسازد.
  if (list.length > 5000) return res.status(413).json({ error: 'تعداد تجهیزات انتخابی برای عملیات گروهی بیش از حد مجاز (۵۰۰۰) است.' });
  const ph = list.map(() => '?').join(',');
  // Probe (اسکن فعال) نوشتن دیتابیس نیست و به‌صورت غیرهمگام اجرا می‌شود؛ پیش از
  // تراکنش و جداگانه رسیدگی می‌شود.
  if (action === 'ping') {
    if (!hasPermission(req.user, 'probe:run')) return res.status(403).json({ error: 'شما مجوز انجام Probe را ندارید.' });
    if (list.length > MAX_BULK_PROBE) {
      return res.status(413).json({ error: `هر درخواست Ping گروهی حداکثر ${MAX_BULK_PROBE} تجهیز را می‌پذیرد.` });
    }
    const rows = db.prepare(`SELECT id, ip FROM devices WHERE id IN (${ph})`).all(...list);
    const allowed = allowedProbeDeviceIds(rows);
    const skipped = rows.length - allowed.length;
    // عملیات طولانی به یک Job قابل پیگیری تبدیل می‌شود؛ هر Probe از صف مرکزی
    // با سقف هم‌زمانی/ظرفیت عبور می‌کند و هرگز Promise.all نامحدود ساخته نمی‌شود.
    const job = createProbeBatch({ total: allowed.length, skipped, owner: req.user?.id ?? null });
    if (!allowed.length) {
      job.status = 'done';
      job.finishedAt = Date.now();
    }
    for (const id of allowed) {
      probeQueue
        .submit(`device:${id}:manual`, ({ signal }) => pingDevice(id, { manual: true, source: 'manual', signal }), {
          timeoutMs: 60000,
        })
        .then((result) => recordProbeBatchResult(job.id, { deviceId: id, ok: result?.ok }))
        .catch((error) => recordProbeBatchResult(job.id, { deviceId: id, error: error?.message || String(error) }));
    }
    return res.status(202).json({
      jobId: job.id,
      statusUrl: `/api/devices/bulk/probe/${job.id}`,
      queued: allowed.length,
      affected: allowed.length,
      skipped,
      total: rows.length,
    });
  }
  let affected;
  try {
    // عملیات گروهی می‌تواند روی صدها تجهیز اثر بگذارد؛ اتمیک است تا خطای میانی
    // فقط بخشی از تجهیزات را تغییر ندهد.
    affected = transaction(
      () => {
  switch (action) {
    case 'enable':
      affected = db.prepare(`UPDATE devices SET enabled=1, next_check_at=0, updated_at=? WHERE id IN (${ph})`).run(Date.now(), ...list).changes;
      break;
    case 'disable':
      affected = db.prepare(`UPDATE devices SET enabled=0, updated_at=? WHERE id IN (${ph})`).run(Date.now(), ...list).changes;
      // قطعی باز و هشدارهای فعال نباید برای تجهیز خارج‌شده از پایش باقی بمانند
      for (const id of list) closeDeviceMonitoringState(id);
      break;
    case 'monitoring_on':
      affected = db.prepare(`UPDATE devices SET monitoring_enabled=1, next_check_at=0, updated_at=? WHERE id IN (${ph})`).run(Date.now(), ...list).changes;
      break;
    case 'monitoring_off':
      affected = db.prepare(`UPDATE devices SET monitoring_enabled=0, updated_at=? WHERE id IN (${ph})`).run(Date.now(), ...list).changes;
      for (const id of list) closeDeviceMonitoringState(id);
      break;
    case 'delete': {
      // فایل‌های پیوست پیش از حذف ردیف‌ها نگه داشته می‌شوند؛ پس از حذف تجهیز،
      // فایل یتیم روی دیسک نمی‌ماند (DB با CASCADE ردیف‌ها را پاک می‌کند).
      const attachmentRows = db
        .prepare(`SELECT stored_name FROM device_attachments WHERE device_id IN (${ph})`)
        .all(...list);
      affected = deleteDevices(list);
      cleanupDeviceAttachmentFiles(attachmentRows);
      break;
    }
    case 'group': {
      const g = groupByName(payload.group);
      affected = g ? db.prepare(`UPDATE devices SET group_id=?, updated_at=? WHERE id IN (${ph})`).run(g.id, Date.now(), ...list).changes : 0;
      // عضویت چندگانه هم ثبت می‌شود تا فهرست گروه‌های تجهیز و گزارش‌ها هم‌گام بمانند.
      if (g) {
        const addMember = db.prepare('INSERT OR IGNORE INTO device_group_members(device_id, group_id, added_at) VALUES (?,?,?)');
        for (const id of list) addMember.run(id, g.id, Date.now());
      }
      break;
    }
    case 'priority':
      affected = db.prepare(`UPDATE devices SET priority=?, updated_at=? WHERE id IN (${ph})`).run(payload.priority || 'normal', Date.now(), ...list).changes;
      break;
    case 'interval':
      affected = db.prepare(`UPDATE devices SET ping_interval=?, updated_at=? WHERE id IN (${ph})`).run(payload.interval ? Number(payload.interval) : null, Date.now(), ...list).changes;
      break;
    case 'tag': {
      for (const id of list) attachTags(id, [payload.tag]);
      affected = list.length;
      break;
    }
    case 'untag':
      affected = payload.tagId
        ? db.prepare(`DELETE FROM device_tags WHERE tag_id=? AND device_id IN (${ph})`).run(Number(payload.tagId), ...list).changes
        : 0;
      break;
    default:
      throw new Error(`عملیات ناشناخته: ${action}`);
  }
        db.prepare('INSERT INTO engine_log(ts, level, message) VALUES (?,?,?)').run(
          Date.now(),
          'info',
          `عملیات گروهی «${action}» روی ${affected} تجهیز اجرا شد.`
        );
        return affected;
      },
      { label: 'devices.bulk' }
    );
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.json({ affected, action });
});

/** وضعیت Job گروهی Probe (قابل پیگیری پس از بسته‌شدن اتصال اولیه) */
router.get('/bulk/probe/:jobId', (req, res) => {
  const job = getProbeBatch(String(req.params.jobId));
  if (!job) return res.status(404).json({ error: 'Job یافت نشد یا منقضی شده است.' });
  if (job.owner != null && req.user?.role !== 'admin' && Number(job.owner) !== Number(req.user?.id)) {
    return res.status(403).json({ error: 'این Job متعلق به کاربر دیگری است.' });
  }
  const { owner: _owner, ...payload } = job;
  return res.json(payload);
});

/** به‌روزرسانی سریع موقعیت روی نقشه */
router.post('/positions', (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const upd = db.prepare('UPDATE devices SET latitude=?, longitude=?, map_layer_id=COALESCE(?, map_layer_id), updated_at=? WHERE id=?');
  // جابه‌جایی روی نقشه یک عملیات واحد است؛ مختصات باید همه یا هیچ‌کدام ثبت شوند.
  let n;
  try {
    n = transaction(
      () => {
        let count = 0;
        for (const it of items) {
          const lat = it.latitude == null ? null : Number(it.latitude);
          const lng = it.longitude == null ? null : Number(it.longitude);
          count += upd.run(lat, lng, it.mapLayerId ?? null, Date.now(), Number(it.id)).changes;
        }
        return count;
      },
      { label: 'devices.positions' }
    );
  } catch (e) {
    return res.status(400).json({ error: `ثبت موقعیت‌ها انجام نشد: ${e.message}` });
  }
  res.json({ updated: n });
});

/** سری نمونه‌ای سبک برای نمودار کارت‌های فهرست تجهیزات */
router.get('/sparklines', (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map(Number)
    .filter(Boolean)
    .slice(0, 300);
  const range = String(req.query.range || '1h');
  if (!ids.length) return res.json({ range, series: {} });
  const bucket = RANGE_BUCKETS[range] || RANGE_BUCKETS['1h'];
  const from = Date.now() - (RANGE_MS[range] || RANGE_MS['1h']);
  const ph = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT device_id, (ts / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS bucket,
              AVG(CASE WHEN ok=1 THEN rtt_ms END) AS rtt,
              AVG(ok) * 100 AS availability
       FROM samples WHERE device_id IN (${ph}) AND ts >= ?
       GROUP BY device_id, bucket ORDER BY bucket`
    )
    .all(bucket.ms, bucket.ms, ...ids, from);
  const series = {};
  for (const r of rows) {
    if (!series[r.device_id]) series[r.device_id] = [];
    series[r.device_id].push({
      t: r.bucket,
      rtt: r.rtt == null ? null : Math.round(r.rtt * 100) / 100,
      loss: r.availability == null ? 0 : Math.round((100 - r.availability) * 10) / 10,
    });
  }
  res.json({ range, bucketMs: bucket.ms, series });
});

/* --------------------------- نقشه --------------------------- */

// سقف پاسخ نقشه برای حفظ حافظه؛ اما بسیار بالاتر از محدودیت قبلی (۵۰۰) است،
// پس صدها/هزاران تجهیز دارای مختصات قابل نمایش‌اند. محدودهٔ جغرافیایی
// (bbox) تعداد Markerها را در نمای نزدیک به‌طور طبیعی کم می‌کند.
const MAP_MAX_DEVICES = (() => {
  const n = Number(process.env.NETWATCH_MAP_MAX);
  return Number.isFinite(n) && n >= 1000 ? Math.min(50000, Math.floor(n)) : 25000;
})();
const MAP_STATUSES = ['online', 'warning', 'offline', 'maintenance', 'unknown'];

/** bbox=minLng,minLat,maxLng,maxLat (اختیاری، با اعتبارسنجی و مرزگذاری) */
function parseBbox(raw) {
  if (!raw) return null;
  const parts = String(raw)
    .split(',')
    .map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  let [minLng, minLat, maxLng, maxLat] = parts;
  minLng = clamp(minLng, -180, 180);
  maxLng = clamp(maxLng, -180, 180);
  minLat = clamp(minLat, -90, 90);
  maxLat = clamp(maxLat, -90, 90);
  if (minLat > maxLat) [minLat, maxLat] = [maxLat, minLat];
  return { minLng, minLat, maxLng, maxLat, wrap: minLng > maxLng };
}

/**
 * API اختصاصی نقشه.
 *
 * تفاوت کلیدی با فهرست تجهیزات:
 *   • تعداد کل، تعداد دارای مختصات و تعداد بدون مختصات مستقل محاسبه می‌شوند.
 *   • فیلتر محدودهٔ جغرافیایی (bbox) و زوم از کلاینت می‌آید تا فقط نقاط نمای
 *     فعلی منتقل شوند؛ اما آمار سراسری فیلترها هم برگردانده می‌شود.
 *   • payload سبک است (بدون تاریخچه/تگ/فیلدهای تزئینی) تا هزاران Marker بدون
 *     فشار حافظه پاسخ داده شوند.
 */
router.get('/map', (req, res) => {
  const filters = parseListQuery({ ...req.query, geo: 'with' });
  const withGeoWhere = buildDeviceWhere(filters);
  // تعداد کل مستقل از وجود مختصات است
  const totalWhere = buildDeviceWhere({ ...filters, geo: '' });
  const join = 'FROM devices d LEFT JOIN groups g ON g.id = d.group_id';
  const total = db.prepare(`SELECT COUNT(*) AS c ${join} ${totalWhere.clause}`).get(...totalWhere.params).c;
  const withGeo = db.prepare(`SELECT COUNT(*) AS c ${join} ${withGeoWhere.clause}`).get(...withGeoWhere.params).c;

  const stats = Object.fromEntries(MAP_STATUSES.map((s) => [s, 0]));
  for (const row of db
    .prepare(`SELECT d.status, COUNT(*) AS c ${join} ${withGeoWhere.clause} GROUP BY d.status`)
    .all(...withGeoWhere.params)) {
    stats[row.status] = row.c;
  }

  const bbox = parseBbox(req.query.bbox);
  const params = [...withGeoWhere.params];
  let bboxSql = '';
  if (bbox) {
    if (bbox.wrap) {
      bboxSql =
        ' AND d.latitude >= ? AND d.latitude <= ? AND (d.longitude >= ? OR d.longitude <= ?)';
      params.push(bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng);
    } else {
      bboxSql =
        ' AND d.latitude >= ? AND d.latitude <= ? AND d.longitude >= ? AND d.longitude <= ?';
      params.push(bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng);
    }
  }
  const limit = Math.min(
    MAP_MAX_DEVICES,
    Math.max(100, parseInt(req.query.limit || String(MAP_MAX_DEVICES), 10) || MAP_MAX_DEVICES)
  );
  const rows = db
    .prepare(
      `SELECT d.id, d.name, d.ip, d.status, d.latitude, d.longitude, d.location,
              d.device_type, d.last_rtt_ms, d.priority, d.map_layer_id, g.name AS group_name
       ${join}
       ${withGeoWhere.clause}${bboxSql}
       ORDER BY CASE d.status WHEN 'offline' THEN 0 WHEN 'warning' THEN 1 WHEN 'maintenance' THEN 2 ELSE 3 END, d.name
       LIMIT ?`
    )
    .all(...params, limit + 1);

  const truncated = rows.length > limit;
  const items = (truncated ? rows.slice(0, limit) : rows).map((r) => ({
    id: r.id,
    name: r.name,
    ip: r.ip,
    status: r.status,
    latitude: r.latitude,
    longitude: r.longitude,
    deviceType: r.device_type,
    groupName: r.group_name || null,
    lastRtt: r.last_rtt_ms,
    priority: r.priority,
    location: r.location || '',
    mapLayerId: r.map_layer_id,
  }));

  res.json({
    items,
    total,
    withGeo,
    missingGeo: Math.max(0, total - withGeo),
    returned: items.length,
    truncated,
    stats,
    bbox: bbox ? [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat] : null,
    zoom: Math.min(22, Math.max(0, Number(req.query.zoom) || 0)),
    generatedAt: Date.now(),
  });
});

/* --------------------------- CRUD --------------------------- */

router.get('/:id', (req, res) => {
  const d = getDevice(req.params.id);
  if (!d) return res.status(404).json({ error: 'تجهیز یافت نشد' });
  const s = getSettings();
  const interval = d.pingInterval || s.ping_interval;
  res.json({
    ...d,
    effective: {
      pingInterval: interval,
      timeoutMs: d.timeoutMs || s.timeout_ms,
      packetCount: d.packetCount || s.packet_count,
      retries: d.retries ?? s.retries,
      latencyThreshold: d.latencyThreshold ?? s.latency_threshold,
      lossThreshold: d.lossThreshold ?? s.loss_threshold,
    },
    stats: {
      outages: d.outageCount || 0,
      openOutage: d.currentOutageStartedAt ? Math.max(0, Math.round((Date.now() - d.currentOutageStartedAt) / 1000)) : null,
      packets: { sent: d.totalChecks, received: d.successCount, lost: d.failCount },
    },
  });
});

router.post('/', (req, res) => {
  try {
    const d = createDevice(req.body || {});
    res.status(201).json(d);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const d = updateDevice(req.params.id, req.body || {});
    if (!d) return res.status(404).json({ error: 'تجهیز یافت نشد' });
    res.json(d);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/:id', (req, res) => {
  try {
    const d = updateDevice(req.params.id, req.body || {});
    if (!d) return res.status(404).json({ error: 'تجهیز یافت نشد' });
    res.json(d);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  const attachments = db.prepare('SELECT stored_name FROM device_attachments WHERE device_id = ?').all(Number(req.params.id));
  const n = deleteDevices([req.params.id]);
  if (!n) return res.status(404).json({ error: 'تجهیز یافت نشد' });
  cleanupDeviceAttachmentFiles(attachments);
  res.json({ deleted: n });
});

/* ------------------------- عضویت گروهی چندگانه ------------------------- */

router.put('/:id/groups', (req, res) => {
  const device = getDevice(req.params.id, { withTags: false });
  if (!device) return res.status(404).json({ error: 'تجهیز یافت نشد' });
  // هر تجهیز فقط عضو یک گروه است؛ ورودی چندگانه به اولین شناسه محدود می‌شود.
  const ids = Array.isArray(req.body?.groupIds) ? req.body.groupIds.slice(0, 1) : [];
  try {
    setDeviceGroups(device.id, ids);
    res.json(getDevice(device.id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* --------------------------- بررسی لحظه‌ای --------------------------- */

// مرزگذاری پارامترهای ورودی کاربر (تعداد packet و مدت انتظار از بدنهٔ درخواست می‌آید)
function clamp(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

async function pingDevice(id, opts = {}) {
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(Number(id));
  if (!row) return null;
  return engine.checkDevice(row, { manual: true, source: 'manual', ...opts });
}

/** خطای Probe/صف به وضعیت HTTP قابل‌فهم تبدیل می‌شود. */
function probeStatus(error) {
  if (Number(error?.status) === 499) return 499;
  if (Number(error?.status) === 503) return 503;
  if (Number(error?.status) === 504) return 504;
  if (error?.code === 'ENGINE_NOT_LEADER') return 409;
  return 500;
}

/**
 * AbortSignal درخواست: اگر کلاینت پیش از پایان قطع شود، منتظر این Probe حذف
 * می‌شود. کار مشترک (مثلاً Probe در جریان موتور) با لغو یک کلاینت متوقف
 * نمی‌شود تا نتیجه در پایگاه‌داده نیمه‌کاره نماند.
 */
function requestSignal(req, res) {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once('close', onClose);
  return { signal: controller.signal, cleanup: () => res.removeListener('close', onClose) };
}

const MAX_BULK_PROBE = 500;

router.post('/:id/ping', requirePermission('probe:run'), probeTargetGuard, async (req, res) => {
  const d = getDevice(req.params.id, { withTags: false });
  if (!d) return res.status(404).json({ error: 'تجهیز یافت نشد' });
  const { signal, cleanup } = requestSignal(req, res);
  try {
    const body = req.body || {};
    const before = { ...d };
    const result = await probeQueue.submit(
      `device:${d.id}:manual`,
      async ({ signal: jobSignal }) => {
        if (body.mode && body.mode !== 'engine') {
          const { icmpPing, tcpPing } = await import('../ping.js');
          const timeoutMs = clamp(body.timeout || d.timeoutMs || d.effective?.timeoutMs || 1200, 100, 15000);
          const count = clamp(body.count || 1, 1, 10);
          const port = clamp(body.port || 80, 1, 65535);
          if (body.mode === 'tcp') return tcpPing(d.ip, { timeoutMs, count: 1, port, signal: jobSignal });
          if (body.mode === 'icmp') return icmpPing(d.ip, { timeoutMs, count, signal: jobSignal });
        }
        return pingDevice(d.id, { manual: true, source: 'manual', signal: jobSignal });
      },
      { signal, timeoutMs: 60000 }
    );
    const after = getDevice(d.id);
    res.json({ result, device: after, before: { status: before.status, lastRtt: before.lastRtt } });
  } catch (e) {
    const status = probeStatus(e);
    if (status === 499) return res.status(499).json({ error: 'درخواست لغو شد.', code: 'PROBE_CANCELLED' });
    res
      .status(status)
      .json({
        error: status === 409 ? e.message : `خطا در ارسال Ping: ${e.message}`,
        code: e?.code || undefined,
      });
  } finally {
    cleanup();
  }
});

/* ------------------------- بررسی زندهٔ لحظه‌ای ------------------------- */

// بررسی سبک برای «پنجرهٔ شناور پینگ»: نتیجه را برمی‌گرداند اما هیچ نمونه‌ای ثبت
// نمی‌کند؛ در غیر این صورت بررسی هر یک ثانیه، آمار، دسترس‌پذیری و رکوردهای قطعی
// را آلوده می‌کرد.
router.get('/:id/probe', requirePermission('probe:run'), probeTargetGuard, async (req, res) => {
  const d = getDevice(req.params.id, { withTags: false });
  if (!d) return res.status(404).json({ error: 'تجهیز یافت نشد' });
  const s = getSettings();
  const requested = String(req.query.mode || s.engine_mode);
  const mode = ['icmp', 'tcp', 'simulate'].includes(requested) ? requested : 'simulate';
  const timeoutMs = clamp(req.query.timeout ?? d.timeoutMs ?? s.timeout_ms, 100, 10000);
  const port = clamp(req.query.port ?? s.tcp_port, 1, 65535);
  const { signal, cleanup } = requestSignal(req, res);
  // کلید شامل حالت/پورت/مهلت است تا دو بررسی متفاوت با هم قاطی نشوند.
  const key = `live:${d.id}:${mode}:${port}:${timeoutMs}`;
  try {
    const result = await probeQueue.submit(
      key,
      async ({ signal: jobSignal }) => {
        if (mode === 'icmp') {
          const { icmpPing } = await import('../ping.js');
          return icmpPing(d.ip, { timeoutMs, count: 1, signal: jobSignal });
        }
        if (mode === 'tcp') {
          const { tcpPing } = await import('../ping.js');
          return tcpPing(d.ip, { timeoutMs, count: 1, port, signal: jobSignal });
        }
        if (d.status === 'offline') {
          // تجهیزی که در وضعیت قطع است، در حالت شبیه‌سازی هم نباید پاسخ موفق بدهد؛
          // پیش‌تر پنجرهٔ پینگ زنده برای تجهیزات قطع، مقدار و نمودار «وصل» نشان می‌داد.
          return { ok: false, reachable: false, service: 'unknown', rtt: null, packetsSent: 1, packetsRecv: 0, lossPct: 100, mode: 'simulate', error: 'NO_RESPONSE' };
        }
        const base = d.avgRtt ?? d.lastRtt ?? 12;
        const jitter = (Math.random() - 0.5) * Math.max(2, base * 0.35);
        const rtt = Math.max(0.3, base + jitter);
        // شبیه‌سازی هرگز سلامت سرویس را ادعا نمی‌کند.
        return { ok: true, reachable: true, service: 'unknown', rtt: Math.round(rtt * 100) / 100, packetsSent: 1, packetsRecv: 1, lossPct: 0, mode: 'simulate' };
      },
      { signal, timeoutMs: timeoutMs * 3 + 3000, cancelWhenNoWaiters: true }
    );
    res.json({
      result: { ...result, at: Date.now() },
      deviceId: d.id,
      name: d.name,
      ip: d.ip,
      threshold: d.latencyThreshold ?? s.latency_threshold,
    });
  } catch (e) {
    const status = probeStatus(e);
    if (status === 499) return res.status(499).json({ error: 'درخواست لغو شد.', code: 'PROBE_CANCELLED' });
    res.status(status).json({ error: `بررسی زنده ناموفق بود: ${e.message}`, code: e?.code || undefined });
  } finally {
    cleanup();
  }
});

/* --------------------------- تاریخچه --------------------------- */

router.get('/:id/series', (req, res) => {
  try {
    if (req.query.from != null || req.query.to != null) {
      res.json(seriesWindowFor(req.params.id, req.query.from, req.query.to ?? Date.now(), req.query.bucket));
      return;
    }
    res.json(seriesFor(req.params.id, String(req.query.range || '1h'), req.query.span));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code });
  }
});

router.get('/:id/outages', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '100', 10) || 100));
  const from = Number(req.query.from);
  const to = Number(req.query.to);
  const hasWindow = Number.isFinite(from) && Number.isFinite(to) && to > from;
  const rows = hasWindow
    ? db
        .prepare(
          `SELECT * FROM outages
           WHERE device_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)
           ORDER BY started_at DESC LIMIT ?`
        )
        .all(Number(req.params.id), to, from, limit)
    : db
        .prepare('SELECT * FROM outages WHERE device_id = ? ORDER BY started_at DESC LIMIT ?')
        .all(Number(req.params.id), limit);
  const total = hasWindow
    ? db
        .prepare(
          `SELECT COUNT(*) AS c FROM outages
           WHERE device_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)`
        )
        .get(Number(req.params.id), to, from).c
    : db.prepare('SELECT COUNT(*) AS c FROM outages WHERE device_id = ?').get(Number(req.params.id)).c;
  const openRow = db.prepare('SELECT * FROM outages WHERE device_id = ? AND open = 1 ORDER BY started_at DESC LIMIT 1').get(Number(req.params.id));
  res.json({
    total,
    from: hasWindow ? from : null,
    to: hasWindow ? to : null,
    open: openRow
      ? { ...openRow, durationSec: Math.round((Date.now() - openRow.started_at) / 1000) }
      : null,
    items: rows.map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      durationSec: r.ended_at ? r.duration_sec ?? Math.round((r.ended_at - r.started_at) / 1000) : Math.round((Date.now() - r.started_at) / 1000),
      cause: r.cause,
      detail: r.detail,
      lat: r.lat,
      lng: r.lng,
      open: !!r.open,
      maintenance: db.prepare('SELECT id, action, technician FROM maintenance_records WHERE outage_id = ?').get(r.id) || null,
    })),
  });
});

router.get('/:id/availability', (req, res) => {
  const range = String(req.query.range || '24h');
  const series = seriesFor(req.params.id, range);
  const buckets = series.points;
  const overall = buckets.length ? buckets.reduce((a, b) => a + b.availability, 0) / buckets.length : 100;
  const checks = buckets.reduce((a, b) => a + b.samples, 0);
  const failed = buckets.reduce((a, b) => a + b.down, 0);
  res.json({
    range,
    bucketLabel: series.bucketLabel,
    overall: Math.round(overall * 100) / 100,
    checks,
    failed,
    worstBucket: buckets.length ? buckets.reduce((a, b) => (a.availability <= b.availability ? a : b)) : null,
    buckets: buckets.map((b) => ({ t: b.t, availability: b.availability, down: b.down, samples: b.samples })),
  });
});

router.get('/:id/samples', (req, res) => {
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit || '200', 10) || 200));
  const rows = db
    .prepare('SELECT ts, rtt_ms, loss_pct, status, ok, mode, packets_sent, packets_recv FROM samples WHERE device_id = ? ORDER BY ts DESC LIMIT ?')
    .all(Number(req.params.id), limit);
  res.json({
    items: rows.map((r) => ({
      ts: r.ts,
      rtt: r.rtt_ms,
      lossPct: r.loss_pct,
      status: r.status,
      ok: !!r.ok,
      mode: r.mode,
      sent: r.packets_sent,
      received: r.packets_recv,
    })),
  });
});

/** نمای کلی سلامت تجهیز برای سربرگ صفحه جزئیات */
router.get('/:id/health', (req, res) => {
  const d = getDevice(req.params.id);
  if (!d) return res.status(404).json({ error: 'تجهیز یافت نشد' });
  const day = db
    .prepare('SELECT * FROM daily_stats WHERE device_id = ? ORDER BY day DESC LIMIT 14')
    .all(Number(req.params.id));
  const mtbf = db
    .prepare('SELECT AVG(diff) AS mtbf FROM (SELECT started_at - LAG(ended_at) OVER (ORDER BY started_at) AS diff FROM outages WHERE device_id = ? AND ended_at IS NOT NULL)')
    .get(Number(req.params.id));
  // MTTR فقط برای قطعی‌هایی که رکورد تعمیر متصل دارند محاسبه می‌شود؛ تعداد
  // مبنا و موارد کنارگذاشته‌شده برای شفافیت برگردانده می‌شوند.
  const mttr = db
    .prepare(
      `SELECT AVG(CAST(MAX(o.ended_at - o.started_at, 0) AS REAL) / 1000.0) AS mttr, COUNT(*) AS c
       FROM outages o WHERE o.device_id = ? AND o.ended_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM maintenance_records m WHERE m.outage_id = o.id)`
    )
    .get(Number(req.params.id));
  const closedOutages = db
    .prepare('SELECT COUNT(*) AS c FROM outages WHERE device_id = ? AND ended_at IS NOT NULL')
    .get(Number(req.params.id)).c;
  res.json({
    deviceId: d.id,
    daily: day.reverse(),
    mtbfSec: mtbf?.mtbf ? Math.round(mtbf.mtbf / 1000) : null,
    mttrSec: mttr?.mttr != null ? Math.round(mttr.mttr) : null,
    mttrEvents: mttr?.c || 0,
    mttrExcluded: Math.max(0, closedOutages - (mttr?.c || 0)),
    maintenance: db
      .prepare('SELECT COUNT(*) AS c FROM maintenance_records WHERE device_id = ?')
      .get(Number(req.params.id)).c,
  });
});

router.get('/:id/maintenance', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM maintenance_records WHERE device_id = ? ORDER BY started_at DESC')
    .all(Number(req.params.id));
  res.json({ items: rows });
});

export { pingDevice, RANGE_BUCKETS, RANGE_MS };
export default router;
