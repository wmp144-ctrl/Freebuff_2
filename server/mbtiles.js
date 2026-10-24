/**
 * NetWatch — خواندن نقشه‌های آفلاین MBTiles
 * ----------------------------------------------------------------
 * فایل‌های .mbtiles در پوشه data/mbtiles نگهداری می‌شوند و کاشی‌ها
 * به‌صورت کاملاً آفلاین از همان فایل SQLite خوانده می‌شوند.
 *
 * نکته‌های مهم پیاده‌سازی:
 * • فایل همیشه read-only باز می‌شود و هیچ نوشتنی روی آن انجام نمی‌شود.
 * • MBTiles استاندارد از طرح TMS استفاده می‌کند؛ ردیف کاشی برعکس XYZ است:
 *       xyzY = (2^zoom - 1) - tile_row
 *   تبدیل در همین ماژول انجام می‌شود تا مرورگر هرگز کاشی وارونه نگیرد.
 * • نوع کاشی (PNG/JPEG/WebP یا PBF برداری) از metadata و در صورت نبود آن از
 *   امضای بایت‌های خود کاشی تشخیص داده می‌شود.
 * • اندازهٔ کاشی (۲۵۶ یا ۵۱۲) و بازهٔ زوم واقعی فایل خوانده می‌شود تا
 *   Leaflet/MapLibre بدون کاشی شکسته یا خطای زوم کار کنند.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { MBTILES_DIR } from './db.js';

const cache = new Map(); // fileName -> { db, meta, probe, ... }

export function listFiles() {
  try {
    return fs
      .readdirSync(MBTILES_DIR)
      .filter((f) => /\.mbtiles$/i.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(MBTILES_DIR, f));
        return { fileName: f, sizeBytes: st.size, modifiedAt: st.mtimeMs };
      });
  } catch {
    return [];
  }
}

function mtimeOf(full) {
  try {
    return fs.statSync(full).mtimeMs;
  } catch {
    return null;
  }
}

function normalizeFormat(value) {
  const f = String(value || '').toLowerCase().trim();
  if (!f) return null;
  if (f.includes('jpeg') || f === 'jpg') return 'jpg';
  if (f.includes('webp')) return 'webp';
  if (f.includes('png')) return 'png';
  if (f.includes('pbf') || f.includes('mvt') || f.includes('vector') || f.includes('protobuf')) return 'pbf';
  if (f.includes('gif')) return 'gif';
  return f;
}

/**
 * تشخیص نوع و ابعاد کاشی از امضای بایت‌ها.
 * برای کاشی‌های برداری، PBF معمولاً gzip شده است؛ هر دو حالت «برداری» هستند.
 */
export function detectTileBuffer(input) {
  if (!input || input.length < 12) return { format: null, width: null, height: null, gzip: false };
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input);

  // PNG: 89 50 4E 47 0D 0A 1A 0A — ابعاد در IHDR (بایت‌های ۱۶ و ۲۰)
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { format: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20), gzip: false };
  }

  // JPEG: FF D8 — پیمایش تا بخش SOF برای عرض/ارتفاع
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if (marker === 0xda) break; // شروع دادهٔ فشرده؛ ابعاد باید قبل از آن آمده باشد
      const len = b.readUInt16BE(i + 2);
      if (len < 2) break;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'jpg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7), gzip: false };
      }
      i += 2 + len;
    }
    return { format: 'jpg', width: null, height: null, gzip: false };
  }

  // WebP: "RIFF....WEBP"
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X' && b.length >= 30) {
      return { format: 'webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), gzip: false };
    }
    if (kind === 'VP8 ' && b.length >= 30) {
      return { format: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, gzip: false };
    }
    if (kind === 'VP8L' && b.length >= 25) {
      const bits = b.readUInt32LE(21);
      return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, gzip: false };
    }
    return { format: 'webp', width: null, height: null, gzip: false };
  }

  // gzip → معمولاً PBF/MVT فشرده‌شده
  if (b[0] === 0x1f && b[1] === 0x8b) return { format: 'pbf', width: null, height: null, gzip: true };

  // Protobuf (MVT) بدون gzip؛ بایت اول معمولاً 0x1A (lengthed field)
  return { format: 'pbf', width: null, height: null, gzip: false };
}

function toZoom(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 24 ? Math.round(n) : null;
}

function firstTile(f) {
  for (const sql of ['SELECT tile_data FROM tiles LIMIT 1', 'SELECT tile_data FROM images LIMIT 1']) {
    try {
      const row = f.db.prepare(sql).get();
      if (row?.tile_data) return row.tile_data;
    } catch {
      /* جدول متفاوت */
    }
  }
  return null;
}

/**
 * خواندن یک کاشی با هر یک از طرح‌های رایج جدول کاشی:
 * tiles (view استاندارد MBTiles)، map+images و در نهایت ستون‌های z/x/y.
 * ترتیب تلاش بر عهدهٔ getTile است؛ این تابع فقط ردیف داده را برمی‌گرداند.
 */
function tileDataAt(f, z, x, row) {
  const queries = [
    { sql: 'SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?', args: [z, x, row] },
    {
      sql: 'SELECT images.tile_data AS tile_data FROM map JOIN images ON map.tile_id = images.tile_id WHERE map.zoom_level=? AND map.tile_column=? AND map.tile_row=?',
      args: [z, x, row],
    },
    { sql: 'SELECT tile_data FROM tiles WHERE z=? AND x=? AND y=?', args: [z, x, row] },
  ];
  for (const q of queries) {
    try {
      const r = f.db.prepare(q.sql).get(...q.args);
      if (r?.tile_data) return r.tile_data;
    } catch {
      /* طرح بعدی */
    }
  }
  return null;
}

/** بازرسی یک‌بارهٔ فایل: فرمت، برداری بودن، اندازهٔ کاشی و بازهٔ زوم واقعی */
function probe(f) {
  if (f.probe) return f.probe;
  const metaFormat = normalizeFormat(f.meta?.format);
  const detected = detectTileBuffer(firstTile(f));
  const format = detected.format || metaFormat || 'png';
  const isVector = format === 'pbf';

  let minzoom = toZoom(f.meta?.minzoom);
  let maxzoom = toZoom(f.meta?.maxzoom);
  if (minzoom == null || maxzoom == null) {
    // فقط وقتی metadata بازهٔ زوم را ندارد روی جدول کاشی کوئری می‌زنیم؛ این
    // پرس‌وجو بدون ایندکس روی فایل‌های بزرگ می‌تواند سنگین باشد.
    const zoomQueries = [
      'SELECT MIN(zoom_level) AS minz, MAX(zoom_level) AS maxz FROM tiles',
      'SELECT MIN(zoom_level) AS minz, MAX(zoom_level) AS maxz FROM map',
    ];
    for (const sql of zoomQueries) {
      try {
        const row = f.db.prepare(sql).get();
        if (minzoom == null) minzoom = toZoom(row?.minz);
        if (maxzoom == null) maxzoom = toZoom(row?.maxz);
      } catch {
        /* طرح جدول متفاوت */
      }
      if (minzoom != null && maxzoom != null) break;
    }
  }

  const tileWidth = Number(detected.width) || 0;
  const tileSize = !isVector && tileWidth >= 64 ? tileWidth : null;

  f.probe = {
    format,
    isVector,
    tileSize,
    minzoom: minzoom ?? 0,
    maxzoom: maxzoom ?? 19,
    gzip: !!detected.gzip,
  };
  return f.probe;
}

/**
 * باز کردن (و در حافظه نگه داشتن) اتصال خواندنی به یک فایل MBTiles.
 *
 * کاشی‌های یک فایل در طول عمرش تغییر نمی‌کنند، پس تا وقتی فایل جایگزین نشده
 * همان اتصال بازاستفاده می‌شود. پیش‌تر کش هر ۶۰ ثانیه منقضی می‌شد و برای هر
 * نوبت یک اتصال تازه باز می‌شد بدون بستن اتصال قبلی؛ سرو کردن نقشه پس از چند
 * ساعت به تمام‌شدن توصیف‌گرهای فایل (EMFILE) می‌انجامید.
 */
export function open(fileName) {
  const safe = path.basename(String(fileName || ''));
  const full = path.join(MBTILES_DIR, safe);
  if (!/\.mbtiles$/i.test(safe) || !fs.existsSync(full)) return null;
  const mtime = mtimeOf(full);
  const cached = cache.get(safe);
  if (cached && cached.mtimeMs === mtime) return cached;
  if (cached) {
    try {
      cached.db.close();
    } catch {
      /* بی‌اثر */
    }
    cache.delete(safe);
  }
  try {
    // readOnly: فایل اصلی هرگز تغییر نمی‌کند (حتی اگر metadata یا tiles نوشتنی باشند).
    const d = new DatabaseSync(full, { readOnly: true });
    const meta = {};
    try {
      for (const row of d.prepare('SELECT name, value FROM metadata').all()) meta[row.name] = row.value;
    } catch {
      /* metadata اختیاری است */
    }
    // فقط metadata می‌تواند طرح غیراستاندارد را اعلام کند؛ نتیجهٔ یک جست‌وجوی
    // ناموفق/جایگزین هرگز به‌عنوان طرح کل فایل کش نمی‌شود (وگرنه یک کاشی
    // خالی باعث وارونگی همهٔ کاشی‌های بعدی می‌شد).
    const declared = String(meta.scheme || meta.tile_scheme || '').toLowerCase();
    const scheme = declared.includes('xyz') || declared.includes('wgs84') ? 'xyz' : 'tms';
    const info = { db: d, meta, file: safe, mtimeMs: mtime, tileCount: undefined, scheme, at: Date.now() };
    cache.set(safe, info);
    return info;
  } catch {
    return null;
  }
}

export function info(fileName, { countTiles = true } = {}) {
  const f = open(fileName);
  if (!f) return null;
  // شمارش کاشی‌ها فقط یک‌بار در طول عمر اتصال انجام می‌شود (قبلاً در هر درخواست
  // کاشی یک COUNT(*) روی کل جدول اجرا می‌شد). برای فهرست لایه‌ها این شمارش
  // لازم نیست و می‌تواند فایل چند صد مگابایتی را قفل کند؛ در بارگذاری، شمارش
  // در Worker Thread انجام و در ستون tile_count ذخیره می‌شود.
  if (countTiles && f.tileCount === undefined) {
    try {
      f.tileCount = f.db.prepare('SELECT COUNT(*) AS c FROM tiles').get().c;
    } catch {
      f.tileCount = null;
    }
  }
  // برای لایه‌های برداری (pbf/mvt)، شرح لایه‌های درون کاشی در کلید metadata.json
  // نگه‌داری می‌شود؛ بدون آن نمی‌توان استایل نقشهٔ برداری را ساخت.
  let vectorLayers = [];
  if (f.meta.json) {
    try {
      const parsed = JSON.parse(f.meta.json);
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
  const p = probe(f);
  const isVector = p.isVector || vectorLayers.length > 0;
  return {
    fileName: f.file,
    tileCount: countTiles ? f.tileCount : (f.tileCount ?? null),
    name: f.meta.name || f.file,
    format: p.format,
    isVector,
    tileSize: p.tileSize,
    gzip: p.gzip,
    minzoom: p.minzoom,
    maxzoom: p.maxzoom,
    bounds: f.meta.bounds || null,
    attribution: f.meta.attribution || f.meta.planettime || '',
    vectorLayers,
  };
}

/**
 * فرادادهٔ سبک یک فایل برای مسیر سرو کاشی (بدون شمارش و بدون parse دوبارهٔ
 * metadata.json در هر درخواست).
 */
export function tileMeta(fileName) {
  const f = open(fileName);
  if (!f) return null;
  const p = probe(f);
  return { format: p.format, gzip: p.gzip, isVector: p.isVector, tileSize: p.tileSize };
}

/**
 * خواندن یک کاشی تصویری/برداری با مختصات XYZ (همان چیزی که Leaflet و MapLibre
 * درخواست می‌کنند). تبدیل TMS→XYZ و تشخیص طرح جدول در همین‌جا انجام می‌شود.
 */
export function getTile(fileName, z, x, y) {
  const f = open(fileName);
  if (!f) return null;
  const zi = Number(z);
  const xi = Number(x);
  const yi = Number(y);
  // z/x/y از آدرس درخواست می‌آیند؛ مرزگذاری از پرس‌وجوهای بی‌معنا جلوگیری می‌کند
  if (![zi, xi, yi].every((n) => Number.isInteger(n) && n >= 0)) return null;
  if (zi > 24 || xi >= 2 ** zi || yi >= 2 ** zi) return null;

  // تبدیل استاندارد TMS → XYZ: ردیف ذخیره‌شده در MBTiles برعکس y درخواست است.
  const flipped = 2 ** zi - 1 - yi;

  // پیش‌تر ابتدا با ردیف XYZ جست‌وجو می‌شد و چون جدول تقریباً برای همهٔ ردیف‌ها
  // داده دارد، همان ردیف اشتباه (کاشی وارونهٔ شمال/جنوب) برگردانده می‌شد.
  // حالا فقط طرح TMS استاندارد خوانده می‌شود؛ اگر metadata صراحتاً xyz اعلام
  // کرده باشد از همان ردیف و در صورت نبود، از ردیف TMS استفاده می‌شود.
  // جست‌وجوی «جایگزین» برای فایل‌های استاندارد انجام نمی‌شود تا یک کاشی خالی
  // در حاشیهٔ نقشه، کاشی نیم‌کرهٔ مقابل را (با محتوای اشتباه) نشان ندهد.
  const order = f.scheme === 'xyz' ? [yi, flipped] : [flipped];

  for (const row of order) {
    const data = tileDataAt(f, zi, xi, row);
    if (data) return Buffer.from(data);
  }
  return null;
}

/**
 * حذف فایل‌های یتیم MBTiles در شروع سرور (BUG-19).
 *
 * فایلی که هیچ لایه‌ای به آن ارجاع نمی‌دهد و از یک ساعت قدیمی‌تر است، باقی‌ماندهٔ
 * آپلود/Crash است و پاک می‌شود؛ فایل‌های تازه و مرجع‌دار دست‌نخورده می‌مانند.
 */
export function sweepOrphanFiles({ referenced = [], now = Date.now(), minAgeMs = 60 * 60 * 1000 } = {}) {
  let removed = 0;
  let missing = 0;
  const keep = new Set((referenced || []).map((n) => path.basename(String(n))));
  let names;
  try {
    names = fs.readdirSync(MBTILES_DIR);
  } catch {
    return { removed, missing, unavailable: true };
  }
  const present = new Set(names.filter((n) => /\.mbtiles$/i.test(n)));
  // رکوردی که به فایلی ارجاع می‌دهد اما فایلش نیست باید گزارش شود؛ پیش‌تر فقط
  // فایل‌های موجود بررسی می‌شدند و این حالت هرگز شمرده نمی‌شد.
  for (const name of keep) {
    if (/\.mbtiles$/i.test(name) && !present.has(name)) missing += 1;
  }
  for (const name of names) {
    if (!/\.mbtiles$/i.test(name)) continue;
    const full = path.join(MBTILES_DIR, name);
    if (keep.has(name)) continue;
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (now - st.mtimeMs < minAgeMs) continue;
    const cached = cache.get(name);
    if (cached) {
      try {
        cached.db.close();
      } catch {}
      cache.delete(name);
    }
    try {
      fs.unlinkSync(full);
      removed += 1;
    } catch {
      /* بی‌اثر */
    }
  }
  return { removed, missing };
}

export function deleteFile(fileName) {
  const safe = path.basename(String(fileName || ''));
  const full = path.join(MBTILES_DIR, safe);
  // فقط فایل‌های نقشه داخل پوشه کاشی حذف می‌شوند
  if (!/\.mbtiles$/i.test(safe)) return false;
  const c = cache.get(safe);
  if (c) {
    try {
      c.db.close();
    } catch {}
    cache.delete(safe);
  }
  if (fs.existsSync(full)) fs.unlinkSync(full);
  return true;
}

export { MBTILES_DIR };
