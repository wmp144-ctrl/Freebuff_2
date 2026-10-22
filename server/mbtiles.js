/**
 * NetWatch — خواندن نقشه‌های آفلاین MBTiles
 * ----------------------------------------------------------------
 * فایل‌های .mbtiles در پوشه data/mbtiles نگهداری می‌شوند و کاشی‌ها
 * به‌صورت کاملاً آفلاین از همان فایل SQLite خوانده می‌شوند.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { MBTILES_DIR } from './db.js';

const cache = new Map(); // fileName -> { db, meta, at }

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

/**
 * باز کردن (و در حافظه نگه داشتن) اتصال خواندنی به یک فایل MBTiles.
 *
 * کاشی‌های یک فایل در طول عمرش تغییر نمی‌کنند، پس تا وقتی فایل جایگزین نشده
 * همان اتصال بازاستفاده می‌شود. پیش‌تر کش هر ۶۰ ثانیه منقضی می‌شد و برای هر
 * نوبت یک اتصال تازه باز می‌شد بدون بستن اتصال قبلی؛ سرو کردن نقشه پس از چند
 * ساعت به تمام‌شدن توصیفگرهای فایل (EMFILE) می‌انجامید.
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
    const d = new DatabaseSync(full, { readOnly: true });
    const meta = {};
    try {
      for (const row of d.prepare('SELECT name, value FROM metadata').all()) meta[row.name] = row.value;
    } catch {
      /* metadata اختیاری است */
    }
    const info = { db: d, meta, file: safe, mtimeMs: mtime, tileCount: undefined, at: Date.now() };
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
  return {
    fileName: f.file,
    tileCount: countTiles ? f.tileCount : (f.tileCount ?? null),
    name: f.meta.name || f.file,
    format: f.meta.format || 'png',
    minzoom: f.meta.minzoom ? Number(f.meta.minzoom) : undefined,
    maxzoom: f.meta.maxzoom ? Number(f.meta.maxzoom) : undefined,
    bounds: f.meta.bounds || null,
    attribution: f.meta.attribution || f.meta.planettime || '',
    vectorLayers,
  };
}

/** خواندن یک کاشی؛ pbf برای برداری و png/jpg برای تصویری */
export function getTile(fileName, z, x, y) {
  const f = open(fileName);
  if (!f) return null;
  const zi = Number(z);
  const xi = Number(x);
  const yi = Number(y);
  // z/x/y از آدرس درخواست می‌آیند؛ مرزگذاری از پرس‌وجوهای بی‌معنا جلوگیری می‌کند
  if (![zi, xi, yi].every((n) => Number.isInteger(n) && n >= 0)) return null;
  if (zi > 24 || xi >= 2 ** zi || yi >= 2 ** zi) return null;
  const queries = [
    { sql: 'SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?', args: [zi, xi, yi] },
    // طرح TMS: ردیف معکوس می‌شود
    { sql: 'SELECT tile_data AS tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?', args: [zi, xi, Math.pow(2, zi) - 1 - yi] },
  ];
  for (const q of queries) {
    try {
      const row = f.db.prepare(q.sql).get(...q.args);
      if (row && row.tile_data) return Buffer.from(row.tile_data);
    } catch {
      /* تلاش بعدی */
    }
  }
  // پشتیبانی از دنیای برداری (جدول tiles به‌سبک MBTiles 1.3 / maps)
  try {
    const row = f.db.prepare('SELECT tile_data FROM tiles WHERE z=? AND x=? AND y=?').get(zi, xi, yi);
    if (row && row.tile_data) return Buffer.from(row.tile_data);
  } catch {
    /* بی‌اثر */
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
  let names = [];
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
