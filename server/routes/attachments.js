/**
 * NetWatch — API پیوست تجهیزات
 * ----------------------------------------------------------------
 * این Router روی مسیر `/api/devices` سوار می‌شود؛ مسیرها با `/:id/attachments`
 * هرگز با `GET /:id` تعارض ندارند (تعداد بخش‌ها متفاوت است).
 */
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import { db, getSettings } from '../db.js';
import { routePermission } from '../permissions.js';
import {
  attachmentMaxBytes,
  detectFileType,
  safeDisplayName,
  writeAttachmentFile,
  attachmentPath,
  removeAttachmentFile,
} from '../attachments.js';

const router = express.Router();

router.use(routePermission({ read: 'devices:read', write: 'devices:write' }));

// سقف مطلق multer؛ سقف مؤثر از تنظیمات در هندلر بررسی می‌شود (پیام روشن‌تر).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 + 1, files: 1, fields: 5, parts: 8 },
});

function serialize(row) {
  return {
    id: row.id,
    deviceId: row.device_id,
    fileName: row.file_name,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    kind: row.kind,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
    downloadUrl: `/api/devices/${row.device_id}/attachments/${row.id}/download`,
  };
}

router.get('/:id/attachments', (req, res) => {
  const deviceId = Number(req.params.id);
  if (!db.prepare('SELECT 1 AS ok FROM devices WHERE id=?').get(deviceId)) {
    return res.status(404).json({ error: 'تجهیز یافت نشد' });
  }
  const items = db.prepare('SELECT * FROM device_attachments WHERE device_id=? ORDER BY created_at DESC').all(deviceId);
  return res.json({ items: items.map(serialize), maxBytes: attachmentMaxBytes(getSettings()) });
});

router.post('/:id/attachments', upload.single('file'), (req, res) => {
  const deviceId = Number(req.params.id);
  const device = db.prepare('SELECT id, name FROM devices WHERE id=?').get(deviceId);
  if (!device) return res.status(404).json({ error: 'تجهیز یافت نشد' });
  if (!req.file || !req.file.buffer?.length) return res.status(400).json({ error: 'فایلی دریافت نشد' });

  const maxBytes = attachmentMaxBytes(getSettings());
  if (req.file.size > maxBytes) {
    return res.status(413).json({ error: `حجم فایل بیش از حد مجاز (${Math.round(maxBytes / 1024 / 1024)} مگابایت) است.` });
  }
  const type = detectFileType(req.file.buffer);
  if (!type) {
    return res.status(415).json({ error: 'نوع فایل مجاز نیست. فقط تصویر (PNG/JPEG/GIF/WebP)، PDF و متن ساده پذیرفته می‌شود.' });
  }
  let written;
  try {
    written = writeAttachmentFile(req.file.buffer, type);
  } catch (e) {
    return res.status(507).json({ error: `ذخیرهٔ پیوست ناموفق بود: ${e.message}` });
  }
  try {
    const now = Date.now();
    const r = db
      .prepare(
        `INSERT INTO device_attachments(device_id, file_name, stored_name, mime, size_bytes, kind, uploaded_by, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        deviceId,
        safeDisplayName(req.file.originalname, type.ext),
        written.storedName,
        type.mime,
        written.sizeBytes,
        type.kind,
        String(req.user?.username || '').slice(0, 80),
        now
      );
    db.prepare('INSERT INTO engine_log(ts, level, message) VALUES (?,?,?)').run(
      now,
      'info',
      `پیوست «${safeDisplayName(req.file.originalname)}» برای تجهیز «${device.name}» افزوده شد.`
    );
    const row = db.prepare('SELECT * FROM device_attachments WHERE id=?').get(Number(r.lastInsertRowid));
    return res.status(201).json(serialize(row));
  } catch (e) {
    // اگر ثبت DB شکست بخورد، فایل یتیم نمی‌ماند.
    removeAttachmentFile(written.storedName);
    return res.status(500).json({ error: 'ثبت پیوست ناموفق بود.' });
  }
});

router.get('/:id/attachments/:attachmentId/download', (req, res) => {
  const row = db
    .prepare('SELECT * FROM device_attachments WHERE id=? AND device_id=?')
    .get(Number(req.params.attachmentId), Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'پیوست یافت نشد' });
  const full = attachmentPath(row.stored_name);
  if (!full || !fs.existsSync(full)) return res.status(404).json({ error: 'فایل پیوست در دسترس نیست' });
  res.setHeader('Content-Type', row.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // تصاویر به‌صورت inline برای دکمهٔ «نمایش تصویر» و بقیه به‌صورت دانلود.
  const disposition = row.kind === 'image' ? 'inline' : 'attachment';
  res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(row.file_name)}`);
  // پیوست خصوصی است؛ کش مشترک ممنوع، کش مرورگر همان کاربر کوتاه است.
  res.setHeader('Cache-Control', 'private, max-age=60');
  return res.sendFile(full);
});

router.delete('/:id/attachments/:attachmentId', (req, res) => {
  const row = db
    .prepare('SELECT * FROM device_attachments WHERE id=? AND device_id=?')
    .get(Number(req.params.attachmentId), Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'پیوست یافت نشد' });
  // کنترل دسترسی: مدیر همه، اپراتور فقط پیوست‌های خودش.
  const isAdmin = String(req.user?.role) === 'admin';
  if (!isAdmin && row.uploaded_by !== String(req.user?.username || '')) {
    return res.status(403).json({ error: 'حذف پیوست دیگران فقط برای مدیر مجاز است.' });
  }
  db.prepare('DELETE FROM device_attachments WHERE id=?').run(row.id);
  removeAttachmentFile(row.stored_name);
  return res.json({ deleted: 1 });
});

export default router;
