/**
 * NetWatch — کارگر پردازش فایل‌های حجیم
 * ----------------------------------------------------------------
 * پارس Excel/CSV و ساخت فایل خروجی می‌تواند برای فایل‌های بزرگ صدها میلی‌ثانیه
 * تا چند ثانیه CPU بگیرد. اجرای آن روی رشتهٔ اصلی، پاسخ‌دهی همهٔ APIها را
 * متوقف می‌کند. این کارگر همان توابع impexp را در یک Worker Thread اجرا می‌کند
 * تا سرور در طول پردازش به درخواست‌های دیگر پاسخ دهد.
 *
 * این فایل عمداً به db.js دسترسی ندارد؛ هیچ نوشتنی در پایگاه‌داده از داخل
 * Worker انجام نمی‌شود (نوشتن اتمیک در فرآیند اصلی می‌ماند).
 */
import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import {
  parseBuffer,
  validateRows,
  validateMarkerRows,
  normalizeMarkerKey,
  buildWorkbook,
  workbookToBuffer,
  EXPORT_HEADERS,
} from '../impexp.js';

function inspectMbtiles(filePath) {
  const d = new DatabaseSync(filePath, { readOnly: true });
  try {
    const meta = {};
    try {
      for (const row of d.prepare('SELECT name, value FROM metadata').all()) meta[row.name] = row.value;
    } catch {
      /* metadata اختیاری است */
    }
    let tileCount = null;
    try {
      tileCount = d.prepare('SELECT COUNT(*) AS c FROM tiles').get().c;
    } catch {
      /* جدول tiles وجود ندارد */
    }
    let vectorLayers = [];
    if (meta.json) {
      try {
        const parsed = JSON.parse(meta.json);
        if (Array.isArray(parsed?.vector_layers)) {
          vectorLayers = parsed.vector_layers.map((l) => ({
            id: String(l.id),
            minzoom: l.minzoom == null ? undefined : Number(l.minzoom),
            maxzoom: l.maxzoom == null ? undefined : Number(l.maxzoom),
          }));
        }
      } catch {
        /* metadata.json نامعتبر */
      }
    }
    return {
      tileCount,
      name: meta.name || '',
      format: meta.format || 'png',
      minzoom: meta.minzoom ? Number(meta.minzoom) : undefined,
      maxzoom: meta.maxzoom ? Number(meta.maxzoom) : undefined,
      bounds: meta.bounds || null,
      attribution: meta.attribution || meta.planettime || '',
      vectorLayers,
    };
  } finally {
    d.close();
  }
}

function handle(type, payload = {}) {
  switch (type) {
    case 'parse': {
      const parsed = parseBuffer(Buffer.from(payload.buffer), payload.filename);
      return { headers: parsed.headers, rows: parsed.rows };
    }
    case 'devicesPreview': {
      const parsed = parseBuffer(Buffer.from(payload.buffer), payload.filename);
      const result = validateRows(parsed.rows, payload.existing || []);
      return {
        headers: parsed.headers,
        totalRows: parsed.rows.length,
        valid: result.valid,
        errors: result.errors,
        duplicates: result.duplicates,
      };
    }
    case 'devicesParse': {
      const parsed = parseBuffer(Buffer.from(payload.buffer), payload.filename);
      const result = validateRows(parsed.rows, payload.existing || []);
      return { totalRows: parsed.rows.length, valid: result.valid, errors: result.errors, duplicates: result.duplicates };
    }
    case 'markersPreview': {
      // سرستون‌های فایل علامت‌ها نگاشت جداگانه دارند (نام/نوع/عرض/طول/توضیحات)
      const parsed = parseBuffer(Buffer.from(payload.buffer), payload.filename, normalizeMarkerKey);
      const result = validateMarkerRows(parsed.rows, payload.existingTypes || []);
      return { totalRows: parsed.rows.length, valid: result.valid, errors: result.errors };
    }
    case 'export': {
      const wb = buildWorkbook(payload.rows || [], payload.headers || EXPORT_HEADERS);
      const buffer = workbookToBuffer(wb, payload.format === 'csv' ? 'csv' : 'xlsx');
      return { buffer, bytes: buffer.length };
    }
    case 'mbtilesInfo': {
      return inspectMbtiles(payload.filePath);
    }
    default:
      throw new Error(`نوع کار ناشناخته است: ${type}`);
  }
}

parentPort.on('message', (msg) => {
  try {
    const result = handle(msg?.type, msg?.payload);
    parentPort.postMessage({ ok: true, result });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e?.message || String(e) });
  }
});
