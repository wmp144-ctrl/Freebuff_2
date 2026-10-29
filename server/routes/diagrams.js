/**
 * NetWatch — API دیاگرام‌های ماژولار شبکه
 * ----------------------------------------------------------------
 * هر دیاگرام یک فایل مستقل است: نام، توضیح و کل اجزای بوم (تجهیزات، گروه‌ها،
 * شکل‌ها، یادداشت‌ها و ارتباط‌ها) در همان ردیف ذخیره می‌شوند. دیاگرام‌ها با
 * `parent_id` ساختار درختی می‌سازند و ویرایش یکی، دیگری را تغییر نمی‌دهد.
 *
 * `revision` خوش‌بینانه جلوی بازنویسی هم‌زمان دو تب را می‌گیرد: هر ذخیره
 * شمارهٔ نسخه‌ای را که کلاینت دیده است می‌فرستد و اگر سرور نسخهٔ جدیدتری
 * داشته باشد، ۴۰۹ برمی‌گرداند تا کاربر تصمیم بگیرد.
 */
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import { db, getSettings, log } from '../db.js';
import { routePermission } from '../permissions.js';
import {
  attachmentMaxBytes,
  attachmentPath,
  detectFileType,
  removeAttachmentFile,
  safeDisplayName,
  stageAttachmentRemoval,
  writeAttachmentFile,
} from '../attachments.js';

const router = express.Router();

router.use(routePermission({ read: 'diagrams:read', write: 'diagrams:write' }));

const CONNECTION_KINDS = new Set(['fiber', 'copper', 'bandwidth', 'radio', 'modem']);
const NODE_TYPES = new Set(['device', 'shape', 'note', 'group', 'image']);
const MAX_NODES = 800;
const MAX_EDGES = 1600;
const MAX_DATA_BYTES = 4 * 1024 * 1024;

const NAME_MAX = 120;
const DESCRIPTION_MAX = 2000;

const text = (v, max) => String(v ?? '').trim().slice(0, max);

class DiagramError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function nowMs() {
  return Date.now();
}

function serializeSummary(row) {
  let graph = { nodes: [], edges: [] };
  try {
    graph = JSON.parse(row.data || '{}');
  } catch {
    /* دادهٔ خراب نباید فهرست را از کار بیندازد */
  }
  return {
    id: row.id,
    parentId: row.parent_id ?? null,
    name: row.name,
    description: row.description || '',
    revision: row.revision,
    nodeCount: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
    edgeCount: Array.isArray(graph.edges) ? graph.edges.length : 0,
    createdBy: row.created_by || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serialize(row) {
  let graph = { nodes: [], edges: [] };
  try {
    graph = JSON.parse(row.data || '{}');
  } catch {
    /* نمای خالی */
  }
  return {
    ...serializeSummary(row),
    nodes: Array.isArray(graph.nodes) ? graph.nodes : [],
    edges: Array.isArray(graph.edges) ? graph.edges : [],
  };
}

function getRow(id) {
  const row = db.prepare('SELECT * FROM diagrams WHERE id = ?').get(id);
  if (!row) throw new DiagramError('دیاگرام پیدا نشد.', 404);
  return row;
}

/** آیا `candidate` خودِ `id` یا یکی از زیرمجموعه‌های آن است؟ */
function isSelfOrDescendant(id, candidate) {
  let cursor = candidate;
  const seen = new Set();
  while (cursor != null) {
    if (cursor === id) return true;
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const row = db.prepare('SELECT parent_id FROM diagrams WHERE id = ?').get(cursor);
    cursor = row?.parent_id ?? null;
  }
  return false;
}

function descendantIds(id) {
  return db
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM diagrams WHERE id = ?
         UNION ALL
         SELECT d.id FROM diagrams d JOIN tree t ON d.parent_id = t.id
       )
       SELECT id FROM tree`
    )
    .all(id)
    .map((r) => r.id);
}

function normalizeParent(parentId) {
  if (parentId === null || parentId === undefined || parentId === '') return null;
  const value = Number(parentId);
  if (!Number.isInteger(value) || value <= 0) throw new DiagramError('شناسهٔ دیاگرام والد نامعتبر است.');
  const parent = db.prepare('SELECT id FROM diagrams WHERE id = ?').get(value);
  if (!parent) throw new DiagramError('دیاگرام والد پیدا نشد.', 404);
  return value;
}

function cleanNode(raw, index) {
  if (!raw || typeof raw !== 'object') throw new DiagramError(`جزء شمارهٔ ${index + 1} نامعتبر است.`);
  const id = String(raw.id ?? '').trim();
  if (!id || id.length > 80) throw new DiagramError(`شناسهٔ جزء شمارهٔ ${index + 1} نامعتبر است.`);
  const type = String(raw.type ?? '');
  if (!NODE_TYPES.has(type)) throw new DiagramError(`نوع جزء «${type}» پشتیبانی نمی‌شود.`);
  const x = Number(raw.position?.x);
  const y = Number(raw.position?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new DiagramError('موقعیت جزء باید عدد باشد.');
  const width = Number(raw.width);
  const height = Number(raw.height);
  const data = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : {};
  return {
    id,
    type,
    position: { x, y },
    ...(Number.isFinite(width) && width > 0 ? { width: Math.min(4000, Math.round(width)) } : {}),
    ...(Number.isFinite(height) && height > 0 ? { height: Math.min(4000, Math.round(height)) } : {}),
    data,
  };
}

function normalizeGraph(input) {
  const nodes = Array.isArray(input?.nodes) ? input.nodes : [];
  const edges = Array.isArray(input?.edges) ? input.edges : [];
  if (nodes.length > MAX_NODES) throw new DiagramError(`حداکثر ${MAX_NODES} جزء در هر دیاگرام مجاز است.`);
  if (edges.length > MAX_EDGES) throw new DiagramError(`حداکثر ${MAX_EDGES} ارتباط در هر دیاگرام مجاز است.`);

  const cleanNodes = nodes.map(cleanNode);
  const ids = new Set(cleanNodes.map((n) => n.id));
  if (ids.size !== cleanNodes.length) throw new DiagramError('شناسهٔ اجزای دیاگرام باید یکتا باشد.');

  const cleanEdges = edges.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new DiagramError(`ارتباط شمارهٔ ${index + 1} نامعتبر است.`);
    const id = String(raw.id ?? '').trim();
    const source = String(raw.source ?? '').trim();
    const target = String(raw.target ?? '').trim();
    if (!id || id.length > 80) throw new DiagramError(`شناسهٔ ارتباط شمارهٔ ${index + 1} نامعتبر است.`);
    if (!ids.has(source) || !ids.has(target)) throw new DiagramError('دو سر ارتباط باید جزء موجود روی بوم باشند.');
    if (source === target) throw new DiagramError('اتصال یک جزء به خودش مجاز نیست.');
    const kind = String(raw.kind ?? 'copper');
    if (!CONNECTION_KINDS.has(kind)) throw new DiagramError(`نوع ارتباط «${kind}» پشتیبانی نمی‌شود.`);
    return {
      id,
      source,
      target,
      sourceHandle: String(raw.sourceHandle ?? '').slice(0, 20),
      targetHandle: String(raw.targetHandle ?? '').slice(0, 20),
      kind,
      label: text(raw.label, 120),
    };
  });
  if (new Set(cleanEdges.map((e) => e.id)).size !== cleanEdges.length) {
    throw new DiagramError('شناسهٔ ارتباط‌ها باید یکتا باشد.');
  }

  const graph = { nodes: cleanNodes, edges: cleanEdges };
  if (Buffer.byteLength(JSON.stringify(graph), 'utf8') > MAX_DATA_BYTES) {
    throw new DiagramError('حجم دیاگرام بیش از حد مجاز است.');
  }
  return graph;
}

/** ساختار درختی برای پنل کنار بوم: فهرست تخت با parentId */
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM diagrams ORDER BY name COLLATE NOCASE').all();
  res.json({ items: rows.map(serializeSummary) });
});

router.get('/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new DiagramError('شناسهٔ دیاگرام نامعتبر است.');
    res.json(serialize(getRow(id)));
  } catch (e) {
    next(e);
  }
});

router.post('/', (req, res, next) => {
  try {
    const name = text(req.body?.name, NAME_MAX);
    if (!name) throw new DiagramError('نام دیاگرام لازم است.');
    const parentId = normalizeParent(req.body?.parentId);
    const ts = nowMs();
    const info = db
      .prepare(
        `INSERT INTO diagrams(parent_id, name, description, data, revision, created_by, created_at, updated_at)
         VALUES (?,?,?,?,1,?,?,?)`
      )
      .run(
        parentId,
        name,
        text(req.body?.description, DESCRIPTION_MAX),
        '{"nodes":[],"edges":[]}',
        text(req.user?.username, 120),
        ts,
        ts
      );
    const row = getRow(Number(info.lastInsertRowid));
    log('info', `دیاگرام «${row.name}» ساخته شد.`);
    res.status(201).json(serialize(row));
  } catch (e) {
    next(e);
  }
});

router.put('/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = getRow(id);
    const name = req.body?.name === undefined ? row.name : text(req.body.name, NAME_MAX);
    if (!name) throw new DiagramError('نام دیاگرام لازم است.');
    const description =
      req.body?.description === undefined ? row.description : text(req.body.description, DESCRIPTION_MAX);
    let parentId = row.parent_id;
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'parentId')) {
      parentId = normalizeParent(req.body.parentId);
      if (parentId !== null && isSelfOrDescendant(id, parentId)) {
        throw new DiagramError('دیاگرام نمی‌تواند زیرمجموعهٔ خودش یا زیرمجموعه‌هایش باشد.');
      }
    }
    db.prepare(
      `UPDATE diagrams SET name = ?, description = ?, parent_id = ?, updated_at = ? WHERE id = ?`
    ).run(name, description, parentId, nowMs(), id);
    res.json(serialize(getRow(id)));
  } catch (e) {
    next(e);
  }
});

router.put('/:id/content', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = getRow(id);
    const revision = Number(req.body?.revision);
    if (!Number.isInteger(revision)) throw new DiagramError('شمارهٔ نسخهٔ دیاگرام لازم است.');
    if (revision !== row.revision) {
      return res.status(409).json({
        error: 'این دیاگرام در جای دیگری تغییر کرده است. برای ادامه، نسخهٔ تازه را بارگذاری کنید.',
        code: 'stale',
        revision: row.revision,
        updatedAt: row.updated_at,
      });
    }
    const graph = normalizeGraph(req.body);
    const nextRevision = row.revision + 1;
    db.prepare('UPDATE diagrams SET data = ?, revision = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(graph),
      nextRevision,
      nowMs(),
      id
    );
    res.json(serialize(getRow(id)));
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* پیوست‌های دیاگرام — تصویر/لوگو/نقشهٔ طبقه روی بوم                     */
/* ------------------------------------------------------------------ */
/* همان سامانهٔ پیوست تجهیزات استفاده می‌شود: تشخیص نوع از محتوای واقعی، نام
   تولیدی فایل روی دیسک و سقف حجم از تنظیمات. فقط تصویر پذیرفته می‌شود چون
   کاربرد این پیوست‌ها نمایش روی بوم است. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 + 1, files: 1, fields: 5, parts: 8 },
});

function serializeAttachment(row) {
  return {
    id: row.id,
    diagramId: row.diagram_id,
    fileName: row.file_name,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    kind: row.kind,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
    downloadUrl: `/api/diagrams/${row.diagram_id}/attachments/${row.id}/download`,
  };
}

router.get('/:id/attachments', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = getRow(id);
    const items = db
      .prepare('SELECT * FROM diagram_attachments WHERE diagram_id = ? ORDER BY created_at DESC')
      .all(row.id);
    res.json({ items: items.map(serializeAttachment), maxBytes: attachmentMaxBytes(getSettings()) });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/attachments', upload.single('file'), (req, res, next) => {
  let written = null;
  try {
    const id = Number(req.params.id);
    const row = getRow(id);
    if (!req.file || !req.file.buffer?.length) throw new DiagramError('فایلی دریافت نشد.');
    const maxBytes = attachmentMaxBytes(getSettings());
    if (req.file.size > maxBytes) {
      throw new DiagramError(`حجم فایل بیش از حد مجاز (${Math.round(maxBytes / 1024 / 1024)} مگابایت) است.`, 413);
    }
    const type = detectFileType(req.file.buffer);
    if (!type || type.kind !== 'image') {
      throw new DiagramError('فقط تصویر (PNG/JPEG/GIF/WebP) برای بوم دیاگرام پذیرفته می‌شود.', 415);
    }
    written = writeAttachmentFile(req.file.buffer, type);
    const now = nowMs();
    const info = db
      .prepare(
        `INSERT INTO diagram_attachments(diagram_id, file_name, stored_name, mime, size_bytes, kind, uploaded_by, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        row.id,
        safeDisplayName(req.file.originalname, type.ext),
        written.storedName,
        type.mime,
        written.sizeBytes,
        type.kind,
        text(req.user?.username, 80),
        now
      );
    const saved = db.prepare('SELECT * FROM diagram_attachments WHERE id = ?').get(Number(info.lastInsertRowid));
    res.status(201).json(serializeAttachment(saved));
  } catch (e) {
    // آپلود ناموفق نباید فایل یتیم روی دیسک بگذارد.
    if (written?.storedName) removeAttachmentFile(written.storedName);
    next(e);
  }
});

router.get('/:id/attachments/:attachmentId/download', (req, res, next) => {
  try {
    const row = db
      .prepare('SELECT * FROM diagram_attachments WHERE id = ? AND diagram_id = ?')
      .get(Number(req.params.attachmentId), Number(req.params.id));
    if (!row) throw new DiagramError('تصویر دیاگرام پیدا نشد.', 404);
    const full = attachmentPath(row.stored_name);
    if (!full || !fs.existsSync(full)) throw new DiagramError('فایل تصویر در دسترس نیست.', 404);
    res.setHeader('Content-Type', row.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.file_name)}`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.sendFile(full);
  } catch (e) {
    next(e);
  }
});

router.delete('/:id/attachments/:attachmentId', (req, res, next) => {
  try {
    const row = db
      .prepare('SELECT * FROM diagram_attachments WHERE id = ? AND diagram_id = ?')
      .get(Number(req.params.attachmentId), Number(req.params.id));
    if (!row) throw new DiagramError('تصویر دیاگرام پیدا نشد.', 404);
    const isAdmin = String(req.user?.role) === 'admin';
    if (!isAdmin && row.uploaded_by !== String(req.user?.username || '')) {
      throw new DiagramError('حذف تصویر دیگران فقط برای مدیر مجاز است.', 403);
    }
    // همان ترتیب امن پیوست تجهیز: اول فایل کنار گذاشته می‌شود، سپس رکورد.
    const staged = stageAttachmentRemoval(row.stored_name);
    try {
      db.prepare('DELETE FROM diagram_attachments WHERE id = ?').run(row.id);
    } catch (e) {
      if (staged?.restore) staged.restore();
      throw e;
    }
    if (staged?.commit) staged.commit();
    else removeAttachmentFile(row.stored_name);
    res.json({ deleted: 1 });
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = getRow(id);
    const ids = descendantIds(id);
    db.prepare('DELETE FROM diagrams WHERE id = ?').run(id);
    log('info', `دیاگرام «${row.name}» و ${ids.length - 1} زیرمجموعهٔ آن حذف شد.`);
    res.json({ deleted: ids.length });
  } catch (e) {
    next(e);
  }
});

export default router;

// خطاهای اعتبارسنجی/تعارض، خطای سرور نیستند و نباید در گزارش رویدادها
// به‌عنوان خطای داخلی ثبت شوند.
router.use((err, _req, res, next) => {
  if (!(err instanceof DiagramError)) return next(err);
  res.status(err.status).json({ error: err.message });
});
