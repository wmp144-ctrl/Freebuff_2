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

export function open(fileName) {
  const safe = path.basename(String(fileName || ''));
  const full = path.join(MBTILES_DIR, safe);
  if (!/\.mbtiles$/i.test(safe) || !fs.existsSync(full)) return null;
  const cached = cache.get(safe);
  if (cached && Date.now() - cached.at < 60000) return cached;
  try {
    const d = new DatabaseSync(full, { readOnly: true });
    const meta = {};
    try {
      for (const row of d.prepare('SELECT name, value FROM metadata').all()) meta[row.name] = row.value;
    } catch {
      /* metadata اختیاری است */
    }
    const info = { db: d, meta, file: safe, at: Date.now() };
    cache.set(safe, info);
    return info;
  } catch {
    return null;
  }
}

export function info(fileName) {
  const f = open(fileName);
  if (!f) return null;
  let count = null;
  try {
    count = f.db.prepare('SELECT COUNT(*) AS c FROM tiles').get().c;
  } catch {
    /* بی‌اثر */
  }
  return {
    fileName: f.file,
    tileCount: count,
    name: f.meta.name || f.file,
    format: f.meta.format || 'png',
    minzoom: f.meta.minzoom ? Number(f.meta.minzoom) : undefined,
    maxzoom: f.meta.maxzoom ? Number(f.meta.maxzoom) : undefined,
    bounds: f.meta.bounds || null,
    attribution: f.meta.attribution || f.meta.planettime || '',
  };
}

let tmsColumns = null;
function hasTmsScheme(f) {
  if (tmsColumns !== null) return tmsColumns;
  try {
    const cols = f.db.prepare('PRAGMA table_info(tiles)').all().map((c) => c.name);
    tmsColumns = cols.includes('tile_column') && cols.includes('tile_row') && !cols.includes('zoom_level');
    return tmsColumns;
  } catch {
    return false;
  }
}

/** خواندن یک کاشی؛ pbf برای برداری و png/jpg برای تصویری */
export function getTile(fileName, z, x, y) {
  const f = open(fileName);
  if (!f) return null;
  const zi = Number(z);
  const xi = Number(x);
  const yi = Number(y);
  if (![zi, xi, yi].every((n) => Number.isFinite(n) && n >= 0)) return null;
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

export function deleteFile(fileName) {
  const safe = path.basename(String(fileName || ''));
  const full = path.join(MBTILES_DIR, safe);
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
