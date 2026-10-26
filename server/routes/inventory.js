/**
 * NetWatch — API دسته‌بندی، تگ‌ها، لایه‌های نقشه و کاشی‌های آفلاین
 */
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { db, MBTILES_DIR, getSettings, transaction } from '../db.js';
import * as mbtiles from '../mbtiles.js';
import { routePermission } from '../permissions.js';
import { mbtilesOnly, mbtilesLimits, UPLOAD_TMP_DIR, ensureUploadTmpDir } from '../upload.js';
import { runJob } from '../jobs.js';
import { fileGuardMessage } from '../file-guard.js';
import { logEvent } from '../logger.mjs';

const router = express.Router();

router.use(routePermission({ read: 'inventory:read', write: 'inventory:write' }));

const MIN_FREE_BYTES = 256 * 1024 * 1024; // حداقل فضای آزاد لازم روی دیسک

/** فایل نقشهٔ نامعتبر خطای کاربر است (۴۰۰)، نه خرابی سرور (۵۰۰). */
function mapFileErrorStatus(error) {
  const status = Number(error?.status);
  return [413, 415, 429, 503, 504, 507].includes(status) ? status : 400;
}

/**
 * فایل ابتدا در پوشهٔ موقت `data/tmp` (۰۷۰۰) نوشته می‌شود و فقط پس از
 * اعتبارسنجی محتوا به `data/mbtiles` منتقل می‌شود. بنابراین فایل نیمه‌کاره یا
 * نامعتبر هرگز در مسیر قابل‌سرو قرار نمی‌گیرد و نام فایل از ورودی کاربر ساخته
 * نمی‌شود (فقط نام پایهٔ پاک‌شده + مُهر زمانی + شناسهٔ تصادفی).
 */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      ensureUploadTmpDir();
      const st = fs.statfsSync(UPLOAD_TMP_DIR);
      if (Number(st.bsize) * Number(st.bavail) < MIN_FREE_BYTES) {
        const err = new Error('فضای ذخیره‌سازی سرور کافی نیست.');
        err.code = 'STORAGE_LOW';
        err.status = 507;
        return cb(err);
      }
    } catch {
      /* اگر بررسی فضا ممکن نبود، بارگذاری متوقف نمی‌شود */
    }
    return cb(null, ensureUploadTmpDir());
  },
  filename: (_req, _file, cb) => {
    // نام موقت کاملاً تولیدی است؛ هیچ بخشی از نام کاربر در مسیر نوشتن نمی‌آید.
    cb(null, `${Date.now()}-${crypto.randomUUID()}.upload`);
  },
});

// پسوند پیش از نوشتن فایل بررسی می‌شود؛ پیش‌تر یک فایل ۲ گیگابایتی بی‌ربط
// کاملاً روی دیسک نوشته می‌شد و بعد حذف می‌گشت. سقف فیلد/بخش از upload.js و
// فضای آزاد دیسک همین‌جا کنترل می‌شود؛ حجم فایل نقشه محدودیتی ندارد.
const upload = multer({ storage, fileFilter: mbtilesOnly, limits: mbtilesLimits });

/** آیا فایل، هدر SQLite معتبر دارد؟ (فایل غیرمرتبط پیش از ثبت رد می‌شود) */
function hasSqliteHeader(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(16);
      const read = fs.readSync(fd, buf, 0, 16, 0);
      return read === 16 && buf.toString('utf8') === 'SQLite format 3\u0000';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** مرزگذاری مقادیر ورودی لایه (نام‌ها از فیلدهای multipart می‌آیند و محدودیت بدنهٔ JSON شاملشان نیست) */
function text(v, max) {
  return String(v ?? '').trim().slice(0, max);
}
function zoom(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(24, Math.max(0, Math.round(n)));
}

/* ------------------------------ گروه‌ها ------------------------------ */

router.get('/groups', (_req, res) => {
  res.json({
    items: db
      .prepare(
        `SELECT g.*, COUNT(DISTINCT d.id) AS device_count,
                -- «وصل» شامل تجهیزات دارای اختلال هم می‌شود (هم‌راستا با داشبورد)
                SUM(CASE WHEN d.status IN ('online','warning') THEN 1 ELSE 0 END) AS online,
                SUM(CASE WHEN d.status='offline' THEN 1 ELSE 0 END) AS offline,
                SUM(CASE WHEN d.status='warning' THEN 1 ELSE 0 END) AS warning,
                ROUND(AVG(d.uptime_pct),2) AS uptime
         FROM groups g
         LEFT JOIN devices d ON d.group_id = g.id
           OR EXISTS (SELECT 1 FROM device_group_members m WHERE m.device_id = d.id AND m.group_id = g.id)
         GROUP BY g.id ORDER BY g.name`
      )
      .all(),
  });
});

router.post('/groups', (req, res) => {
  const { name, description = '', color = '#3b82f6' } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'نام گروه الزامی است' });
  const exists = db.prepare('SELECT id FROM groups WHERE name = ?').get(String(name).trim());
  if (exists) return res.status(400).json({ error: 'گروهی با این نام وجود دارد' });
  const r = db
    .prepare('INSERT INTO groups(name, description, color, created_at) VALUES (?,?,?,?)')
    .run(String(name).trim(), String(description), String(color), Date.now());
  res.status(201).json(db.prepare('SELECT * FROM groups WHERE id=?').get(Number(r.lastInsertRowid)));
});

router.put('/groups/:id', (req, res) => {
  const b = req.body || {};
  const n = db
    .prepare('UPDATE groups SET name=COALESCE(?, name), description=COALESCE(?, description), color=COALESCE(?, color) WHERE id=?')
    .run(b.name ?? null, b.description ?? null, b.color ?? null, Number(req.params.id)).changes;
  res.json({ updated: n });
});

router.delete('/groups/:id', (req, res) => {
  const id = Number(req.params.id);
  const move = req.query.moveTo ? Number(req.query.moveTo) : null;
  // جابه‌جایی اتمیک: ستون قدیمی و عضویت چندگانه هم‌زمان منتقل می‌شوند؛
  // در غیر این صورت حذف گروه، عضویت‌ها را CASCADE پاک می‌کرد.
  const deleted = transaction(
    () => {
      if (move) {
        db.prepare('UPDATE devices SET group_id = ? WHERE group_id = ?').run(move, id);
        db.prepare(
          'INSERT OR IGNORE INTO device_group_members(device_id, group_id, added_at) SELECT device_id, ?, ? FROM device_group_members WHERE group_id = ?'
        ).run(move, Date.now(), id);
      }
      return db.prepare('DELETE FROM groups WHERE id=?').run(id).changes;
    },
    { label: 'inventory.group.delete' }
  );
  res.json({ deleted });
});

/* ------------------------------- تگ‌ها ------------------------------- */

router.get('/tags', (_req, res) => {
  res.json({
    items: db
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM device_tags dt WHERE dt.tag_id = t.id) AS device_count
         FROM tags t ORDER BY t.name`
      )
      .all(),
  });
});

router.post('/tags', (req, res) => {
  const { name, color = '#f59e0b', show_on_map = 1, icon = 'tag' } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'نام تگ الزامی است' });
  const exists = db.prepare('SELECT id FROM tags WHERE name = ?').get(String(name).trim());
  if (exists) return res.status(400).json({ error: 'تگی با این نام وجود دارد' });
  const r = db
    .prepare('INSERT INTO tags(name, color, show_on_map, icon, created_at) VALUES (?,?,?,?,?)')
    .run(String(name).trim(), String(color), Number(show_on_map) ? 1 : 0, String(icon), Date.now());
  res.status(201).json(db.prepare('SELECT * FROM tags WHERE id=?').get(Number(r.lastInsertRowid)));
});

router.put('/tags/:id', (req, res) => {
  const b = req.body || {};
  const n = db
    .prepare('UPDATE tags SET name=COALESCE(?,name), color=COALESCE(?,color), show_on_map=COALESCE(?,show_on_map), icon=COALESCE(?,icon) WHERE id=?')
    .run(b.name ?? null, b.color ?? null, b.show_on_map === undefined ? null : Number(b.show_on_map) ? 1 : 0, b.icon ?? null, Number(req.params.id)).changes;
  res.json({ updated: n });
});

router.delete('/tags/:id', (req, res) => {
  res.json({ deleted: db.prepare('DELETE FROM tags WHERE id=?').run(Number(req.params.id)).changes });
});

/** اختصاص/حذف تگ از تجهیز به‌صورت تکی */
router.post('/tags/:tagId/devices', (req, res) => {
  const tagId = Number(req.params.tagId);
  const ids = (req.body?.ids || []).map(Number).filter(Boolean);
  const mode = req.body?.mode === 'remove' ? 'remove' : 'add';
  const stmt =
    mode === 'add'
      ? db.prepare('INSERT OR IGNORE INTO device_tags(device_id, tag_id) VALUES (?,?)')
      : db.prepare('DELETE FROM device_tags WHERE device_id=? AND tag_id=?');
  let n = 0;
  for (const id of ids) n += stmt.run(id, tagId).changes;
  res.json({ affected: n, mode });
});

/* --------------------------- لایه‌های نقشه --------------------------- */

router.get('/layers', (_req, res) => {
  // fileInfo بدون COUNT(*) روی جدول کاشی ساخته می‌شود تا باز کردن فهرست لایه‌ها
  // روی فایل MBTiles بزرگ، رشتهٔ اصلی را قفل نکند. تعداد کاشی از DB می‌آید.
  const items = db
    .prepare('SELECT * FROM map_layers ORDER BY is_default DESC, name')
    .all()
    .map((l) => ({ ...l, fileInfo: l.file_name ? mbtiles.info(l.file_name, { countTiles: false }) : null }));
  res.json({ items, files: mbtiles.listFiles(), tilesDir: MBTILES_DIR, settings: getSettings() });
});

router.post('/layers', async (req, res) => {
  const b = req.body || {};
  const r = db
    .prepare(
      'INSERT INTO map_layers(name, description, kind, file_name, min_zoom, max_zoom, attribution, visible, is_default, tile_count, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    )
    .run(
      text(b.name, 120) || 'لایه جدید',
      text(b.description, 500),
      ['builtin', 'mbtiles', 'empty'].includes(b.kind) ? b.kind : 'empty',
      b.file_name ? path.basename(String(b.file_name)).slice(0, 200) : null,
      zoom(b.min_zoom, 0),
      zoom(b.max_zoom, 19),
      text(b.attribution, 200),
      b.visible === undefined ? 1 : Number(b.visible) ? 1 : 0,
      0,
      0,
      Date.now()
    );
  const id = Number(r.lastInsertRowid);
  if (b.file_name) {
    // خواندن metadata و شمارش کاشی برای فایل موجود هم در Worker انجام می‌شود
    try {
      const filePath = path.join(MBTILES_DIR, path.basename(String(b.file_name)));
      if (fs.existsSync(filePath)) {
        const info = await runJob('mbtilesInfo', { filePath }, { timeoutMs: 120000 });
        if (info) {
          db.prepare('UPDATE map_layers SET tile_count=?, min_zoom=?, max_zoom=?, attribution=? WHERE id=?').run(
            info.tileCount || 0,
            info.minzoom ?? 0,
            info.maxzoom ?? 19,
            info.attribution || '',
            id
          );
        }
      }
    } catch {
      /* ثبت لایه حتی اگر خواندن فایل ناموفق باشد؛ کاربر بعداً می‌تواند حذف کند */
    }
  }
  res.status(201).json(db.prepare('SELECT * FROM map_layers WHERE id=?').get(id));
});

router.put('/layers/:id', (req, res) => {
  const b = req.body || {};
  const id = Number(req.params.id);
  // «صفر کردن پیش‌فرض قبلی + تعیین پیش‌فرض جدید» اتمیک است؛ وگرنه شکست میانی،
  // نقشه را بدون لایهٔ پیش‌فرض رها می‌کرد.
  const n = transaction(() => {
  if (Number(b.is_default)) db.prepare('UPDATE map_layers SET is_default = 0').run();
  return db
    .prepare(
      'UPDATE map_layers SET name=COALESCE(?,name), description=COALESCE(?,description), kind=COALESCE(?,kind), file_name=COALESCE(?,file_name), min_zoom=COALESCE(?,min_zoom), max_zoom=COALESCE(?,max_zoom), attribution=COALESCE(?,attribution), visible=COALESCE(?,visible), is_default=COALESCE(?,is_default) WHERE id=?'
    )
    .run(
      b.name === undefined ? null : text(b.name, 120),
      b.description === undefined ? null : text(b.description, 500),
      ['builtin', 'mbtiles', 'empty'].includes(b.kind) ? b.kind : null,
      b.file_name ? path.basename(String(b.file_name)).slice(0, 200) : null,
      b.min_zoom === undefined ? null : zoom(b.min_zoom, 0),
      b.max_zoom === undefined ? null : zoom(b.max_zoom, 19),
      b.attribution === undefined ? null : text(b.attribution, 200),
      b.visible === undefined ? null : Number(b.visible) ? 1 : 0,
      b.is_default === undefined ? null : Number(b.is_default) ? 1 : 0,
      id
    ).changes;
  }, { label: 'inventory.layer.update' });
  res.json({ updated: n });
});

router.delete('/layers/:id', (req, res) => {
  const id = Number(req.params.id);
  const layer = db.prepare('SELECT * FROM map_layers WHERE id=?').get(id);
  const removeFile = String(req.query.removeFile || '') === '1';
  // ترتیب امن (BUG-19): ابتدا رکورد حذف می‌شود؛ اگر حذف فایل شکست بخورد لایهٔ
  // نیمه‌کاره در پایگاه‌داده نمی‌ماند و فایل یتیم در شروع بعدی پاک می‌شود.
  const deleted = db.prepare('DELETE FROM map_layers WHERE id=?').run(id).changes;
  if (deleted && layer?.file_name && removeFile) {
    try {
      mbtiles.deleteFile(layer.file_name);
    } catch (e) {
      logEvent('warn', 'map_layer_file_delete_failed', { layerId: id, message: String(e?.message || e) });
    }
  }
  res.json({ deleted });
});

/** بارگذاری فایل .mbtiles (موقت → اعتبارسنجی → انتقال اتمیک) */
router.post('/layers/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایلی دریافت نشد' });
  const tmpPath = req.file.path;
  let finalPath = null;
  const cleanup = () => {
    for (const file of [tmpPath, finalPath]) {
      if (!file) continue;
      try {
        fs.unlinkSync(file);
      } catch {
        /* بی‌اثر */
      }
    }
  };
  const original = path.basename(String(req.file.originalname || ''));
  if (!/\.mbtiles$/i.test(original)) {
    cleanup();
    return res.status(400).json({ error: 'فقط فایل با پسوند .mbtiles پذیرفته می‌شود' });
  }
  // پسوند به‌تنهایی کافی نیست: امضای واقعی SQLite بررسی می‌شود و سپس خود فایل
  // در Worker به‌صورت read-only باز و جدول کاشی آن خوانده می‌شود.
  if (!hasSqliteHeader(tmpPath)) {
    cleanup();
    return res.status(400).json({ error: 'فایل بارگذاری‌شده یک پایگاه‌دادهٔ SQLite/MBTiles معتبر نیست.' });
  }
  let info;
  try {
    info = await runJob('mbtilesInfo', { filePath: tmpPath }, { timeoutMs: 120000 });
  } catch (e) {
    cleanup();
    return res.status(mapFileErrorStatus(e)).json({ error: `فایل MBTiles معتبر نیست یا خوانده نشد: ${fileGuardMessage(e)}` });
  }
  if (!info || info.tileCount == null) {
    cleanup();
    return res.status(400).json({ error: 'فایل MBTiles معتبر نیست یا جدول کاشی آن خوانده نمی‌شود' });
  }
  // نام نهایی کاملاً تولیدی است (هیچ بخشی از ورودی کاربر در مسیر ذخیره نیست).
  const fileName = `${Date.now()}-${crypto.randomUUID()}.mbtiles`;
  finalPath = path.join(MBTILES_DIR, fileName);
  try {
    fs.renameSync(tmpPath, finalPath);
    // فقط مالک سرویس می‌تواند فایل نقشه را بخواند/تغییر دهد.
    try {
      fs.chmodSync(finalPath, 0o600);
    } catch {
      /* سیستم فایل ممکن است chmod را پشتیبانی نکند */
    }
  } catch (e) {
    cleanup();
    return res.status(507).json({ error: `ذخیرهٔ فایل نقشه ناموفق بود: ${e.message}` });
  }
  try {
    const b = req.body || {};
    const r = db
      .prepare(
        'INSERT INTO map_layers(name, description, kind, file_name, min_zoom, max_zoom, attribution, visible, is_default, tile_count, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        text(b.name, 120) || path.basename(original, '.mbtiles').slice(0, 120),
        text(b.description, 500),
        'mbtiles',
        fileName,
        info.minzoom ?? 0,
        info.maxzoom ?? 19,
        info.attribution || '',
        1,
        0,
        info.tileCount || 0,
        Date.now()
      );
    res.status(201).json({ layer: db.prepare('SELECT * FROM map_layers WHERE id=?').get(Number(r.lastInsertRowid)), info });
  } catch (e) {
    // اگر ثبت پایگاه‌داده شکست بخورد، فایل یتیم نمی‌ماند.
    cleanup();
    res.status(500).json({ error: 'ثبت لایهٔ نقشه ناموفق بود.' });
  }
});

router.get('/layers/:id/info', (req, res) => {
  const layer = db.prepare('SELECT * FROM map_layers WHERE id=?').get(Number(req.params.id));
  if (!layer) return res.status(404).json({ error: 'لایه یافت نشد' });
  res.json({ layer, info: layer.file_name ? mbtiles.info(layer.file_name) : null });
});

/* ------------------------- سرو کاشی آفلاین ------------------------- */

router.get('/tiles/:layerId/:z/:x/:y', (req, res) => {
  const layerId = Number(req.params.layerId);
  const layer = db.prepare('SELECT * FROM map_layers WHERE id=?').get(layerId);
  if (!layer || !layer.file_name) return res.status(404).json({ error: 'لایه فایل ندارد' });
  const yRaw = String(req.params.y);
  const y = Number(yRaw.split('.')[0]);
  const buf = mbtiles.getTile(layer.file_name, Number(req.params.z), Number(req.params.x), y);
  if (!buf) return res.status(404).end();
  // نوع کاشی از امضای خود کاشی/metadata تشخیص داده می‌شود (نه از پسوند آدرس)؛
  // این کار تصاویر JPEG/WebP را هم درست نمایش می‌دهد و درخواست تکراری برای
  // خواندن metadata در هر کاشی انجام نمی‌شود.
  const meta = mbtiles.tileMeta(layer.file_name);
  const format = String(meta?.format || 'png').toLowerCase();
  const type = format === 'jpg'
    ? 'image/jpeg'
    : format === 'webp'
      ? 'image/webp'
      : format === 'pbf'
        ? 'application/x-protobuf'
        : format === 'gif'
          ? 'image/gif'
          : 'image/png';
  res.setHeader('Content-Type', type);
  // کاشی‌های برداری معمولاً gzip شده‌اند؛ با اعلام Content-Encoding مرورگر خودش
  // باز می‌کند و MapLibre بدنهٔ PBF معتبر می‌گیرد. تصمیم بر اساس بایت‌های همین
  // کاشی گرفته می‌شود، نه فقط کاشی اول فایل: در برخی فایل‌ها بخشی از کاشی‌ها
  // (مثلاً کاشی‌های خالی) فشرده نیستند و هدر اشتباه، بدنه را خراب می‌کرد.
  const gzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  if (gzip) res.setHeader('Content-Encoding', 'gzip');
  // کاشی‌ها پشت نشست هستند؛ کش مشترک/پروکسی نباید نسخهٔ یک کاربر را به
  // کاربر دیگر (حتی ناشناس) بدهد. کش مرورگر همان کاربر کافی است.
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(buf);
});

router.get('/mbtiles/files', (_req, res) => {
  res.json({ items: mbtiles.listFiles(), dir: MBTILES_DIR });
});

router.delete('/mbtiles/files/:name', (req, res) => {
  mbtiles.deleteFile(req.params.name);
  res.json({ ok: true });
});

export default router;
