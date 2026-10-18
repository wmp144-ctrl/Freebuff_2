/**
 * NetWatch — API دسته‌بندی، تگ‌ها، لایه‌های نقشه و کاشی‌های آفلاین
 */
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { db, MBTILES_DIR, getSettings } from '../db.js';
import * as mbtiles from '../mbtiles.js';
import { routePermission } from '../permissions.js';
import { mbtilesOnly, mbtilesLimits } from '../upload.js';

const router = express.Router();

router.use(routePermission({ read: 'inventory:read', write: 'inventory:write' }));

const MIN_FREE_BYTES = 256 * 1024 * 1024; // حداقل فضای آزاد لازم روی دیسک

/** فایل MBTiles مستقیماً داخل پوشهٔ کاشی‌ها نوشته می‌شود (نام پایه + مُهر زمانی) */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      const st = fs.statfsSync(MBTILES_DIR);
      if (Number(st.bsize) * Number(st.bavail) < MIN_FREE_BYTES) {
        const err = new Error('فضای ذخیره‌سازی سرور کافی نیست.');
        err.code = 'STORAGE_LOW';
        err.status = 507;
        return cb(err);
      }
    } catch {
      /* اگر بررسی فضا ممکن نبود، بارگذاری متوقف نمی‌شود */
    }
    return cb(null, MBTILES_DIR);
  },
  filename: (_req, file, cb) => {
    const base = path.basename(file.originalname).replace(/[^\w\u0600-\u06FF.-]+/g, '_');
    cb(null, `${Date.now()}-${base}`);
  },
});

// پسوند پیش از نوشتن فایل بررسی می‌شود؛ پیش‌تر یک فایل ۲ گیگابایتی بی‌ربط
// کاملاً روی دیسک نوشته می‌شد و بعد حذف می‌گشت. سقف حجم/فیلد/بخش از upload.js.
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
        `SELECT g.*, COUNT(d.id) AS device_count,
                -- «وصل» شامل تجهیزات دارای اختلال هم می‌شود (هم‌راستا با داشبورد)
                SUM(CASE WHEN d.status IN ('online','warning') THEN 1 ELSE 0 END) AS online,
                SUM(CASE WHEN d.status='offline' THEN 1 ELSE 0 END) AS offline,
                SUM(CASE WHEN d.status='warning' THEN 1 ELSE 0 END) AS warning,
                ROUND(AVG(d.uptime_pct),2) AS uptime
         FROM groups g LEFT JOIN devices d ON d.group_id = g.id
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
  db.prepare('UPDATE devices SET group_id = ? WHERE group_id = ?').run(move, id);
  res.json({ deleted: db.prepare('DELETE FROM groups WHERE id=?').run(id).changes });
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
  const items = db.prepare('SELECT * FROM map_layers ORDER BY is_default DESC, name').all().map((l) => ({ ...l, fileInfo: l.file_name ? mbtiles.info(l.file_name) : null }));
  res.json({ items, files: mbtiles.listFiles(), tilesDir: MBTILES_DIR, settings: getSettings() });
});

router.post('/layers', (req, res) => {
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
    const info = mbtiles.info(path.basename(String(b.file_name)));
    if (info) db.prepare('UPDATE map_layers SET tile_count=?, min_zoom=?, max_zoom=?, attribution=? WHERE id=?').run(info.tileCount || 0, info.minzoom ?? 0, info.maxzoom ?? 19, info.attribution || '', id);
  }
  res.status(201).json(db.prepare('SELECT * FROM map_layers WHERE id=?').get(id));
});

router.put('/layers/:id', (req, res) => {
  const b = req.body || {};
  const id = Number(req.params.id);
  if (Number(b.is_default)) db.prepare('UPDATE map_layers SET is_default = 0').run();
  const n = db
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
  res.json({ updated: n });
});

router.delete('/layers/:id', (req, res) => {
  const id = Number(req.params.id);
  const layer = db.prepare('SELECT * FROM map_layers WHERE id=?').get(id);
  const removeFile = String(req.query.removeFile || '') === '1';
  if (layer?.file_name && removeFile) mbtiles.deleteFile(layer.file_name);
  res.json({ deleted: db.prepare('DELETE FROM map_layers WHERE id=?').run(id).changes });
});

/** بارگذاری فایل .mbtiles */
router.post('/layers/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایلی دریافت نشد' });
  const fileName = path.basename(req.file.path);
  if (!/\.mbtiles$/i.test(fileName)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'فقط فایل با پسوند .mbtiles پذیرفته می‌شود' });
  }
  if (!hasSqliteHeader(req.file.path)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'فایل بارگذاری‌شده یک پایگاه‌دادهٔ SQLite/MBTiles معتبر نیست.' });
  }
  const info = mbtiles.info(fileName);
  if (!info) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'فایل MBTiles معتبر نیست یا جدول کاشی آن خوانده نمی‌شود' });
  }
  const b = req.body || {};
  const r = db
    .prepare(
      'INSERT INTO map_layers(name, description, kind, file_name, min_zoom, max_zoom, attribution, visible, is_default, tile_count, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    )
    .run(
      text(b.name, 120) || path.basename(req.file.originalname, '.mbtiles').slice(0, 120),
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
  const info = mbtiles.info(layer.file_name);
  const format = (info?.format || 'png').toLowerCase();
  const type = format.includes('jpg') || format.includes('jpeg') ? 'image/jpeg' : format.includes('webp') ? 'image/webp' : format.includes('pbf') ? 'application/x-protobuf' : 'image/png';
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'public, max-age=86400');
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
