/**
 * NetWatch — API علامت‌های نقشه
 * ----------------------------------------------------------------
 * کاربر می‌تواند انواع «علامت» (مثلاً «تجهیز در حال نصب») را تعریف کند و
 * نمونه‌هایی از آن را با یک نام مشخص و مختصات جغرافیایی روی نقشه جانمایی کند.
 * علامت‌ها با فرمت مشخص (Excel/CSV) قابل ورود و خروج هستند و یک فایل نمونه هم
 * برای ورود ارائه می‌شود.
 */
import express from 'express';
import multer from 'multer';
import { db, log } from '../db.js';
import {
  parseBuffer,
  normalizeMarkerKey,
  validateMarkerRows,
  buildMarkerWorkbook,
  markerTemplateRows,
  workbookToBuffer,
  MAX_IMPORT_ROWS,
} from '../impexp.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const HEX = /^#[0-9a-fA-F]{6}$/;
const text = (v, max) => String(v ?? '').trim().slice(0, max);

function serializeType(t) {
  return {
    id: t.id,
    name: t.name,
    color: t.color,
    icon: t.icon || 'map-pin',
    description: t.description || '',
    markerCount: t.marker_count ?? 0,
    createdAt: t.created_at,
  };
}

function allTypes() {
  return db
    .prepare(
      `SELECT t.*, (SELECT COUNT(*) FROM map_markers m WHERE m.type_id = t.id) AS marker_count
       FROM marker_types t ORDER BY t.name`
    )
    .all()
    .map(serializeType);
}

function serializeMarker(m) {
  return {
    id: m.id,
    typeId: m.type_id,
    typeName: m.typeName ?? null,
    typeColor: m.typeColor ?? null,
    typeIcon: m.typeIcon ?? null,
    name: m.name,
    latitude: m.latitude,
    longitude: m.longitude,
    notes: m.notes || '',
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  };
}

function listMarkers({ typeId = null, search = '' } = {}) {
  const where = [];
  const params = [];
  if (typeId) {
    where.push('m.type_id = ?');
    params.push(Number(typeId));
  }
  if (search) {
    where.push('(m.name LIKE ? OR m.notes LIKE ? OR t.name LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT m.*, t.name AS typeName, t.color AS typeColor, t.icon AS typeIcon
       FROM map_markers m LEFT JOIN marker_types t ON t.id = m.type_id
       ${clause} ORDER BY m.name`
    )
    .all(...params)
    .map(serializeMarker);
}

/** نام یا شناسهٔ نوع را به شناسهٔ موجود تبدیل می‌کند و در صورت نبود، نوع تازه می‌سازد */
function resolveTypeId(body = {}) {
  if (body.type_id != null && body.type_id !== '') {
    const t = db.prepare('SELECT id FROM marker_types WHERE id = ?').get(Number(body.type_id));
    if (t) return t.id;
  }
  const name = text(body.type ?? body.typeName ?? body.type_name, 80);
  if (!name) return null;
  const existing = db.prepare('SELECT id FROM marker_types WHERE name = ?').get(name);
  if (existing) return existing.id;
  const color = HEX.test(String(body.color)) ? String(body.color) : '#0ea5e9';
  const r = db
    .prepare('INSERT INTO marker_types(name, color, icon, description, created_at) VALUES (?,?,?,?,?)')
    .run(name, color, text(body.icon, 40) || 'map-pin', '', Date.now());
  return Number(r.lastInsertRowid);
}

function validLatLng(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/* ---------------------------- انواع علامت ---------------------------- */

router.get('/marker-types', (_req, res) => {
  res.json({ items: allTypes() });
});

router.post('/marker-types', (req, res) => {
  const b = req.body || {};
  const name = text(b.name, 80);
  if (!name) return res.status(400).json({ error: 'نام نوع علامت الزامی است' });
  if (db.prepare('SELECT id FROM marker_types WHERE name = ?').get(name)) return res.status(400).json({ error: 'نوعی با این نام از قبل وجود دارد' });
  const r = db
    .prepare('INSERT INTO marker_types(name, color, icon, description, created_at) VALUES (?,?,?,?,?)')
    .run(name, HEX.test(String(b.color)) ? String(b.color) : '#0ea5e9', text(b.icon, 40) || 'map-pin', text(b.description, 240), Date.now());
  res.status(201).json(serializeType(db.prepare('SELECT * FROM marker_types WHERE id=?').get(Number(r.lastInsertRowid))));
});

router.put('/marker-types/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM marker_types WHERE id=?').get(id);
  if (!existing) return res.status(404).json({ error: 'نوع علامت یافت نشد' });
  const b = req.body || {};
  const name = b.name === undefined ? existing.name : text(b.name, 80) || existing.name;
  if (name !== existing.name && db.prepare('SELECT id FROM marker_types WHERE name=? AND id!=?').get(name, id))
    return res.status(400).json({ error: 'نوعی با این نام از قبل وجود دارد' });
  db.prepare('UPDATE marker_types SET name=?, color=?, icon=?, description=? WHERE id=?').run(
    name,
    b.color === undefined ? existing.color : HEX.test(String(b.color)) ? String(b.color) : existing.color,
    b.icon === undefined ? existing.icon : text(b.icon, 40) || existing.icon,
    b.description === undefined ? existing.description : text(b.description, 240),
    id
  );
  res.json(serializeType(db.prepare('SELECT * FROM marker_types WHERE id=?').get(id)));
});

router.delete('/marker-types/:id', (req, res) => {
  const id = Number(req.params.id);
  res.json({ deleted: db.prepare('DELETE FROM marker_types WHERE id=?').run(id).changes });
});

/* ------------------------------ خروجی/ورود ------------------------------ */

router.get('/markers/export', (req, res) => {
  const format = String(req.query.format || 'xlsx').toLowerCase() === 'csv' ? 'csv' : 'xlsx';
  const items = listMarkers();
  const wb = buildMarkerWorkbook(
    items.map((m) => ({
      name: m.name,
      type: m.typeName || '',
      latitude: m.latitude,
      longitude: m.longitude,
      notes: m.notes,
    }))
  );
  const buf = workbookToBuffer(wb, format);
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="netwatch-markers-${stamp}.${format}"`);
  res.send(buf);
});

/** فایل نمونهٔ ورود علامت‌ها */
router.get('/markers/template', (req, res) => {
  const format = String(req.query.format || 'xlsx').toLowerCase() === 'csv' ? 'csv' : 'xlsx';
  const wb = buildMarkerWorkbook(markerTemplateRows());
  const buf = workbookToBuffer(wb, format);
  res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="netwatch-markers-template.${format}"`);
  res.send(buf);
});

function parseMarkerFile(file) {
  const { rows } = parseBuffer(file.buffer, file.originalname, normalizeMarkerKey);
  if (rows.length > MAX_IMPORT_ROWS) throw new Error(`تعداد ردیف‌های فایل بیش از حد مجاز است (حداکثر ${MAX_IMPORT_ROWS} ردیف).`);
  const types = db.prepare('SELECT name FROM marker_types').all().map((t) => t.name);
  return validateMarkerRows(rows, types);
}

router.post('/markers/import/preview', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایلی دریافت نشد' });
  try {
    const { valid, errors } = parseMarkerFile(req.file);
    res.json({
      fileName: req.file.originalname,
      totalRows: valid.length + errors.length,
      valid: valid.length,
      invalid: errors.length,
      newTypes: [...new Set(valid.filter((v) => v.newType).map((v) => v.type))],
      errors: errors.slice(0, 200),
    });
  } catch (e) {
    res.status(400).json({ error: `خطا در خواندن فایل: ${e.message}` });
  }
});

router.post('/markers/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایلی دریافت نشد' });
  const replace = String(req.body?.mode || '') === 'replace';
  try {
    const { valid, errors } = parseMarkerFile(req.file);
    const now = Date.now();
    const ins = db.prepare(
      'INSERT INTO map_markers(type_id, name, latitude, longitude, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
    );
    let inserted = 0;
    const newTypes = new Set();
    db.exec('BEGIN');
    try {
      if (replace) db.prepare('DELETE FROM map_markers').run();
      for (const r of valid) {
        const typeId = resolveTypeId({ type: r.type, color: r.color, icon: r.icon });
        if (r.newType) newTypes.add(r.type);
        ins.run(typeId, r.name, r.latitude, r.longitude, r.notes, now, now);
        inserted++;
      }
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw e;
    }
    log('info', `ورود علامت‌های نقشه: ${inserted} علامت افزوده شد، ${errors.length} ردیف نامعتبر.`);
    res.json({ inserted, skipped: errors.length, newTypes: [...newTypes], errors: errors.slice(0, 60) });
  } catch (e) {
    res.status(400).json({ error: `خطا در ثبت علامت‌ها: ${e.message}` });
  }
});

/* ------------------------------- علامت‌ها ------------------------------- */

router.get('/markers', (req, res) => {
  res.json({
    items: listMarkers({ typeId: req.query.typeId ? Number(req.query.typeId) : null, search: text(req.query.search, 80) }),
    types: allTypes(),
  });
});

router.post('/markers', (req, res) => {
  const b = req.body || {};
  const name = text(b.name, 120);
  if (!name) return res.status(400).json({ error: 'نام علامت الزامی است' });
  const lat = Number(b.latitude);
  const lng = Number(b.longitude);
  if (!validLatLng(lat, lng)) return res.status(400).json({ error: 'مختصات جغرافیایی نامعتبر است' });
  const typeId = resolveTypeId(b);
  if (!typeId) return res.status(400).json({ error: 'نوع علامت الزامی است' });
  const now = Date.now();
  const r = db
    .prepare('INSERT INTO map_markers(type_id, name, latitude, longitude, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(typeId, name, lat, lng, text(b.notes, 500), now, now);
  const row = db
    .prepare(
      `SELECT m.*, t.name AS typeName, t.color AS typeColor, t.icon AS typeIcon FROM map_markers m LEFT JOIN marker_types t ON t.id=m.type_id WHERE m.id=?`
    )
    .get(Number(r.lastInsertRowid));
  res.status(201).json(serializeMarker(row));
});

router.put('/markers/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM map_markers WHERE id=?').get(id);
  if (!existing) return res.status(404).json({ error: 'علامت یافت نشد' });
  const b = req.body || {};
  const name = b.name === undefined ? existing.name : text(b.name, 120) || existing.name;
  const lat = b.latitude === undefined ? existing.latitude : Number(b.latitude);
  const lng = b.longitude === undefined ? existing.longitude : Number(b.longitude);
  if (!validLatLng(lat, lng)) return res.status(400).json({ error: 'مختصات جغرافیایی نامعتبر است' });
  const typeId =
    b.type_id === undefined && b.type === undefined && b.typeName === undefined
      ? existing.type_id
      : resolveTypeId(b) ?? existing.type_id;
  db.prepare('UPDATE map_markers SET type_id=?, name=?, latitude=?, longitude=?, notes=?, updated_at=? WHERE id=?').run(
    typeId,
    name,
    lat,
    lng,
    b.notes === undefined ? existing.notes : text(b.notes, 500),
    Date.now(),
    id
  );
  const row = db
    .prepare(
      `SELECT m.*, t.name AS typeName, t.color AS typeColor, t.icon AS typeIcon FROM map_markers m LEFT JOIN marker_types t ON t.id=m.type_id WHERE m.id=?`
    )
    .get(id);
  res.json(serializeMarker(row));
});

router.delete('/markers/bulk', (req, res) => {
  const ids = (req.body?.ids || []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'هیچ علامتی انتخاب نشده است' });
  const ph = ids.map(() => '?').join(',');
  res.json({ deleted: db.prepare(`DELETE FROM map_markers WHERE id IN (${ph})`).run(...ids).changes });
});

router.delete('/markers/:id', (req, res) => {
  res.json({ deleted: db.prepare('DELETE FROM map_markers WHERE id=?').run(Number(req.params.id)).changes });
});

export default router;
