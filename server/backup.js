/**
 * NetWatch — پشتیبان‌گیری، Checkpoint و بازیابی پایگاه‌داده
 * ----------------------------------------------------------------
 * اصول:
 *   • پشتیبان با وضعیت WAL سازگار است: نخست `wal_checkpoint(TRUNCATE)` و سپس
 *     `VACUUM INTO` که یک عکس لحظه‌ای تراکنشی از پایگاه‌داده می‌سازد (شامل
 *     نوشته‌های تأییدشدهٔ موجود در WAL).
 *   • هر مجموعهٔ پشتیبان یک پوشهٔ مستقل با `manifest.json` است: checksum
 *     SHA-256، اندازه، نتیجهٔ integrity_check و فهرست فایل‌های MBTiles.
 *   • پشتیبان نیمه‌کاره هرگز به‌عنوان پشتیبان معتبر دیده نمی‌شود: نوشتن در
 *     پوشهٔ موقت و تغییر نام اتمیک در پایان.
 *   • پیش از Restore، checksum و integrity_check و وجود جدول‌ها بررسی می‌شود؛
 *     سپس از پایگاه‌دادهٔ فعلی یک نسخهٔ ایمنی ساخته می‌شود.
 *   • فایل‌های MBTiles هم در همان مجموعه و با checksum پشتیبان/بازیابی
 *     می‌شوند تا پایگاه‌داده و نقشه‌ها هماهنگ بمانند.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  db,
  DB_PATH,
  DATA_DIR,
  MBTILES_DIR,
  checkDatabaseHealth,
  runMigrations,
  ensureDefaultSettings,
  getSettings,
  requireDiskSpace,
  log,
  SCHEMA_VERSION,
} from './db.js';
import { logEvent } from './logger.mjs';
import { config } from './config.js';
import { DbError, DB_ERROR_CODES, logDbError } from './db-errors.js';
import { freeDiskBytes, fileSizeBytes } from './db-safety.js';

/** نسخهٔ برنامه در Manifest؛ برای تطبیق پشتیبان با نسخهٔ سازنده */
export const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
})();

export const BACKUP_FORMAT = 1;
// مسیر پشتیبان از منبع مرکزی پیکربندی می‌آید (NETWATCH_BACKUP_DIR > DATA_DIR/backups)
export const BACKUP_DIR = config.backupDir;
const MANIFEST = 'manifest.json';
const STATE_FILE = '.scheduler-state.json';
const RESTORE_STATE_FILE = '.restore-state.json';
const REQUIRED_TABLES = ['settings', 'devices', 'samples', 'outages', 'daily_stats', 'alerts'];

let backupInProgress = false;
let restoreInProgress = false;

export function isBackupRunning() {
  return backupInProgress;
}

/* ------------------------------------------------------------------ */
/* ابزار فایل                                                          */
/* ------------------------------------------------------------------ */

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* پلتفرم/فایل‌سیستم بدون پشتیبانی chmod */
  }
  return dir;
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function fsyncPath(target) {
  try {
    const fd = fs.openSync(target, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* fsync روی برخی فایل‌سیستم‌ها/پلتفرم‌ها پشتیبانی نمی‌شود */
  }
}

function copyFileDurable(from, to) {
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
  try {
    // پشتیبان پایگاه‌داده شامل دادهٔ کاربران و حسابرسی است.
    fs.chmodSync(to, 0o600);
  } catch {
    /* بی‌اثر */
  }
  fsyncPath(to);
}

function writeJsonDurable(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* بی‌اثر */
  }
  fs.renameSync(tmp, file);
  fsyncPath(path.dirname(file));
}

/* ------------------------------------------------------------------ */
/* وضعیت Restore (قابل مشاهده در برنامه و قابل بازیابی پس از Crash)     */
/* ------------------------------------------------------------------ */

function restoreStatePath() {
  return path.join(DATA_DIR, RESTORE_STATE_FILE);
}

export function readRestoreState() {
  try {
    return JSON.parse(fs.readFileSync(restoreStatePath(), 'utf8'));
  } catch {
    return null;
  }
}

function writeRestoreState(patch) {
  try {
    ensureDir(DATA_DIR);
    // فایل وضعیت باید پیش از تغییر فایل اصلی روی دیسک باشد؛ وگرنه پس از
    // Crash نمی‌فهمیم بازیابی در چه مرحله‌ای بوده است.
    writeJsonDurable(restoreStatePath(), { ...(readRestoreState() || {}), ...patch });
  } catch (e) {
    logEvent('warn', 'restore_state_write_failed', { message: e?.message });
  }
}

/** وضعیت آخرین/جاری بازیابی برای API و رابط کاربری */
export function restoreStatus() {
  const state = readRestoreState();
  if (!state) return { status: 'never', inProgress: false };
  return {
    ...state,
    inProgress: state.status === 'in_progress',
    stale: state.status === 'in_progress' && Date.now() - Number(state.updatedAt || 0) > 10 * 60 * 1000,
  };
}

function stampName(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `netwatch-${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
}

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
  } catch {
    return null;
  }
}

function tableCounts(file) {
  const conn = new DatabaseSync(file, { readOnly: true });
  try {
    const count = (table) => {
      try {
        return Number(conn.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);
      } catch {
        return null;
      }
    };
    return {
      devices: count('devices'),
      samples: count('samples'),
      outages: count('outages'),
      openOutages: (() => {
        try {
          return Number(conn.prepare('SELECT COUNT(*) AS c FROM outages WHERE open = 1').get().c);
        } catch {
          return null;
        }
      })(),
      alerts: count('alerts'),
      users: count('users'),
    };
  } finally {
    conn.close();
  }
}

/** بررسی یک فایل SQLite با integrity_check و foreign_key_check */
function inspectSqliteFile(file) {
  const info = { ok: false, errors: [], pageCount: null, userVersion: null, journalMode: null };
  let conn = null;
  try {
    conn = new DatabaseSync(file, { readOnly: true });
    const integrity = conn.prepare('PRAGMA integrity_check').all();
    const messages = integrity.map((r) => String(Object.values(r)[0] ?? ''));
    const bad = messages.filter((m) => m.toLowerCase() !== 'ok');
    if (bad.length) info.errors.push(...bad.slice(0, 20));
    const fk = conn.prepare('PRAGMA foreign_key_check').all();
    if (fk.length) info.errors.push(`نقض کلید خارجی: ${fk.length} ردیف`);
    const present = new Set(conn.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((r) => r.name));
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
    if (missing.length) info.errors.push(`جدول‌های غایب: ${missing.join(', ')}`);
    info.pageCount = conn.prepare('PRAGMA page_count').get()?.page_count ?? null;
    info.userVersion = conn.prepare('PRAGMA user_version').get()?.user_version ?? null;
    info.journalMode = conn.prepare('PRAGMA journal_mode').get()?.journal_mode ?? null;
    info.ok = info.errors.length === 0;
  } catch (e) {
    info.errors.push(e.message);
    info.ok = false;
  } finally {
    try {
      conn?.close();
    } catch {
      /* بی‌اثر */
    }
  }
  return info;
}

/* ------------------------------------------------------------------ */
/* ایجاد پشتیبان                                                       */
/* ------------------------------------------------------------------ */

function mbtilesFiles() {
  try {
    return fs
      .readdirSync(MBTILES_DIR)
      .filter((f) => /\.mbtiles$/i.test(f))
      .sort();
  } catch {
    return [];
  }
}

/**
 * ساخت یک مجموعهٔ پشتیبان کامل (پایگاه‌داده + MBTiles).
 *
 * @param {{includeMbtiles?: boolean, keep?: number, reason?: string}} [options]
 * @returns {{name: string, dir: string, manifest: object}}
 */
export function createBackup({ includeMbtiles = true, keep = null, reason = 'manual' } = {}) {
  if (restoreInProgress) throw new DbError(DB_ERROR_CODES.BUSY, 'بازیابی در جریان است؛ پشتیبان‌گیری ممکن نیست.', { status: 409 });
  if (backupInProgress) throw new DbError(DB_ERROR_CODES.BUSY, 'یک پشتیبان‌گیری دیگر در جریان است.', { status: 409 });
  if (String(DB_PATH).startsWith(':')) throw new DbError(DB_ERROR_CODES.BACKUP_INVALID, 'برای پایگاه‌دادهٔ درون‌حافظه‌ای پشتیبان‌گیری فایلی ممکن نیست.', { status: 400 });
  const settings = getSettings();
  const keepCount = Number(keep ?? settings.backup_keep ?? 7);
  const startedAt = Date.now();
  backupInProgress = true;
  let workDir = null;
  try {
    ensureDir(BACKUP_DIR);
    // برآورد محافظه‌کارانه: پایگاه‌داده + MBTiles + فضای موقت برای VACUUM
    const dbBytes = Math.max(fileSizeBytes(DB_PATH), 1024 * 1024);
    const tilesBytes = includeMbtiles ? mbtilesFiles().reduce((sum, f) => sum + fileSizeBytes(path.join(MBTILES_DIR, f)), 0) : 0;
    requireDiskSpace(dbBytes * 2 + tilesBytes + 8 * 1024 * 1024, 'ساخت پشتیبان');

    // ۱) انتقال WAL به فایل اصلی تا عکس لحظه‌ای شامل همهٔ تراکنش‌های تأییدشده باشد
    const checkpoint = db.checkpoint('TRUNCATE');
    logEvent('info', 'backup_checkpoint', checkpoint);

    // ۲) نوشتن عکس لحظه‌ای در پوشهٔ موقت (هیچ پشتیبان نیمه‌کاره‌ای دیده نمی‌شود)
    const name = `${stampName()}-${crypto.randomBytes(3).toString('hex')}`;
    workDir = path.join(BACKUP_DIR, `.partial-${name}`);
    ensureDir(workDir);
    const sqliteTmp = path.join(workDir, 'netwatch.db.tmp');
    db.prepare('VACUUM INTO ?').run(sqliteTmp);
    fsyncPath(sqliteTmp);
    const verification = inspectSqliteFile(sqliteTmp);
    if (!verification.ok) {
      throw new DbError(DB_ERROR_CODES.BACKUP_INVALID, `پشتیبان ساخته‌شده معتبر نیست: ${verification.errors.join(' | ')}`, {
        status: 500,
        detail: verification,
      });
    }
    const dbFile = path.join(workDir, 'netwatch.db');
    fs.renameSync(sqliteTmp, dbFile);
    fsyncPath(workDir);

    // ۳) فایل‌های MBTiles در همان مجموعه؛ اگر فایلی هنگام کپی تغییر کند،
    //    کپی دوباره انجام می‌شود تا checksum با محتوای پایدار بخورد.
    const mbtiles = [];
    if (includeMbtiles) {
      ensureDir(path.join(workDir, 'mbtiles'));
      for (const fileName of mbtilesFiles()) {
        const src = path.join(MBTILES_DIR, fileName);
        const before = fs.statSync(src);
        const dest = path.join(workDir, 'mbtiles', fileName);
        copyFileDurable(src, dest);
        const after = fs.statSync(src);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          copyFileDurable(src, dest);
        }
        const finalStat = fs.statSync(src);
        mbtiles.push({
          name: fileName,
          size: fileSizeBytes(dest),
          sha256: sha256File(dest),
          sourceSize: finalStat.size,
          sourceMtimeMs: finalStat.mtimeMs,
        });
      }
    }

    // ۴) مانیفست: تنها راه شناسایی یک پشتیبان معتبر
    const counts = tableCounts(dbFile);
    const manifest = {
      format: BACKUP_FORMAT,
      app: 'netwatch',
      appVersion: APP_VERSION,
      schemaVersion: verification.userVersion,
      name,
      reason,
      createdAt: new Date().toISOString(),
      createdAtMs: startedAt,
      dbPath: DB_PATH,
      db: {
        file: 'netwatch.db',
        size: fileSizeBytes(dbFile),
        sha256: sha256File(dbFile),
        integrity: verification.errors.length ? 'failed' : 'ok',
        pageCount: verification.pageCount,
        userVersion: verification.userVersion,
        counts,
      },
      mbtiles,
      checkpoint,
      settings: {
        journalMode: db.walInfo().journalMode,
        synchronous: db.walInfo().synchronous,
      },
      durationMs: Date.now() - startedAt,
    };
    writeJsonDurable(path.join(workDir, MANIFEST), manifest);

    // ۵) انتشار اتمیک مجموعه
    const finalDir = path.join(BACKUP_DIR, name);
    fs.renameSync(workDir, finalDir);
    workDir = null;
    fsyncPath(BACKUP_DIR);

    // با keep صریح، رفتار قبلی (سقف کل) حفظ می‌شود؛ در حالت پیش‌فرض، سیاست
    // روزانه/هفتگی (۷ روزانه + ۴ هفتگی) اعمال می‌شود.
    const pruned = keep == null
      ? pruneBackupsByPolicy({
          dailyKeep: Number(settings.backup_daily_keep) || keepCount,
          weeklyKeep: Number(settings.backup_weekly_keep) || 0,
        })
      : pruneBackups(keepCount);
    log('info', `پشتیبان کامل ساخته شد: ${name} (${Math.round(manifest.db.size / 1024)} کیلوبایت، ${mbtiles.length} فایل نقشه).`);
    logEvent('info', 'backup_created', {
      name,
      reason,
      dbBytes: manifest.db.size,
      mbtiles: mbtiles.length,
      durationMs: manifest.durationMs,
      pruned,
    });
    return { name, dir: finalDir, manifest };
  } catch (e) {
    // پشتیبان نیمه‌کاره پاک می‌شود؛ هیچ فایل ناقصی باقی نمی‌ماند.
    if (workDir) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* بی‌اثر */
      }
    }
    const err = logDbError('backup.create', e);
    log('error', `ساخت پشتیبان ناموفق بود: ${err.message}`);
    throw err;
  } finally {
    backupInProgress = false;
  }
}

/** فهرست پشتیبان‌های معتبر (به‌ترتیب جدیدترین) */
export function listBackups(dir = BACKUP_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  } catch {
    return [];
  }
  if (!entries) return [];
  const items = [];
  for (const entry of entries) {
    const itemDir = path.join(dir, entry.name);
    const manifest = readManifest(itemDir);
    if (!manifest || manifest.format !== BACKUP_FORMAT) continue;
    items.push({
      name: manifest.name || entry.name,
      dir: itemDir,
      createdAt: manifest.createdAt,
      createdAtMs: manifest.createdAtMs || 0,
      reason: manifest.reason || '',
      dbBytes: manifest.db?.size ?? 0,
      mbtiles: manifest.mbtiles?.length ?? 0,
      integrity: manifest.db?.integrity || 'unknown',
      counts: manifest.db?.counts || null,
    });
  }
  return items.sort((a, b) => b.createdAtMs - a.createdAtMs);
}

/** شمارهٔ هفتهٔ ISO برای سیاست هفتگی */
function isoWeek(dateMs) {
  const d = new Date(dateMs);
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc - yearStart) / 86400000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * هرس پشتیبان با سیاست Grandfather-Father-Son:
 *   • newest backup of each of the last `dailyKeep` calendar days (UTC)
 *   • newest backup of each of the last `weeklyKeep` ISO weeks
 * همهٔ نسخه‌های دیگر حذف می‌شوند. حداقل یک نسخه همیشه می‌ماند.
 * @returns {string[]} نام نسخه‌های حذف‌شده
 */
export function pruneBackupsByPolicy({ dailyKeep = 7, weeklyKeep = 4, dir = BACKUP_DIR } = {}) {
  const daily = Math.max(1, Math.min(60, Number(dailyKeep) || 7));
  const weekly = Math.max(0, Math.min(52, Number(weeklyKeep) || 0));
  const all = listBackups(dir);
  if (!all.length) return [];
  const keep = new Set();
  const days = new Set();
  const weeks = new Set();
  for (const item of all) {
    const ts = Number(item.createdAtMs) || Date.parse(item.createdAt) || 0;
    const day = new Date(ts).toISOString().slice(0, 10);
    if (days.size < daily && !days.has(day)) {
      days.add(day);
      keep.add(item.name);
      continue;
    }
    if (weekly > 0) {
      const week = isoWeek(ts);
      if (weeks.size < weekly && !weeks.has(week)) {
        weeks.add(week);
        keep.add(item.name);
      }
    }
  }
  // جدیدترین نسخه در هر حال حفظ می‌شود (حتی اگر همه در یک روز باشند).
  keep.add(all[0].name);
  const removed = [];
  for (const item of all) {
    if (keep.has(item.name)) continue;
    try {
      fs.rmSync(item.dir, { recursive: true, force: true });
      removed.push(item.name);
    } catch (e) {
      logEvent('warn', 'backup_prune_failed', { name: item.name, message: e.message });
    }
  }
  if (removed.length) logEvent('info', 'backup_pruned', { removed: removed.length, kept: keep.size, daily, weekly });
  return removed;
}

/** حذف پشتیبان‌های قدیمی‌تر از سقف نگهداری (فقط مجموعه‌های معتبر) */
export function pruneBackups(keep = 7) {
  const limit = Math.max(1, Math.min(60, Number(keep) || 7));
  const all = listBackups();
  const removed = [];
  for (const item of all.slice(limit)) {
    try {
      fs.rmSync(item.dir, { recursive: true, force: true });
      removed.push(item.name);
    } catch (e) {
      logEvent('warn', 'backup_prune_failed', { name: item.name, message: e.message });
    }
  }
  return removed;
}

/* ------------------------------------------------------------------ */
/* اعتبارسنجی و بازیابی                                               */
/* ------------------------------------------------------------------ */

/** مسیر فایل پایگاه‌دادهٔ درون یک پشتیبان (پوشه یا فایل مستقیم) */
function resolveBackupDb(source) {
  if (!source) throw new DbError(DB_ERROR_CODES.BACKUP_INVALID, 'مسیر پشتیبان مشخص نشده است.', { status: 400 });
  const resolved = path.resolve(String(source));
  const stat = fs.existsSync(resolved) ? fs.statSync(resolved) : null;
  if (!stat) throw new DbError(DB_ERROR_CODES.BACKUP_INVALID, `مسیر پشتیبان یافت نشد: ${resolved}`, { status: 404 });
  if (stat.isDirectory()) {
    const manifest = readManifest(resolved);
    if (!manifest) throw new DbError(DB_ERROR_CODES.BACKUP_INVALID, 'مانیفست پشتیبان یافت نشد؛ مجموعهٔ پشتیبان ناقص است.', { status: 400 });
    return { dir: resolved, dbFile: path.join(resolved, 'netwatch.db'), manifest };
  }
  return { dir: path.dirname(resolved), dbFile: resolved, manifest: null };
}

/**
 * بررسی صحت پشتیبان پیش از هر بازیابی.
 * @param {string} source مسیر پوشهٔ پشتیبان یا فایل .db
 */
export function verifyBackup(source) {
  const report = { ok: false, errors: [], warnings: [], dbFile: null, manifest: null, mbtiles: [], integrity: null };
  try {
    const resolved = resolveBackupDb(source);
    report.dbFile = resolved.dbFile;
    report.manifest = resolved.manifest;
    if (!fs.existsSync(resolved.dbFile)) {
      report.errors.push('فایل پایگاه‌دادهٔ پشتیبان وجود ندارد.');
      return report;
    }
    // ۱) checksum باید با مانیفست بخورد (تشخیص دستکاری/کپی ناقص)
    if (resolved.manifest) {
      const expected = resolved.manifest.db?.sha256;
      const actual = sha256File(resolved.dbFile);
      report.dbSha256 = actual;
      if (expected && expected !== actual) {
        report.errors.push('checksum فایل پشتیبان با مانیفست مطابقت ندارد.');
      }
      if (resolved.manifest.format !== BACKUP_FORMAT) {
        report.errors.push(`نسخهٔ قالب پشتیبان پشتیبانی نمی‌شود (${resolved.manifest.format}).`);
      }
      const backupSchema = Number(resolved.manifest.schemaVersion ?? resolved.manifest.db?.userVersion ?? 0);
      if (backupSchema > SCHEMA_VERSION) {
        report.errors.push(`نسخهٔ ساختار پشتیبان (${backupSchema}) از نسخهٔ برنامه (${SCHEMA_VERSION}) جدیدتر است.`);
      }
      if (resolved.manifest.db?.size && Number(resolved.manifest.db.size) !== fileSizeBytes(resolved.dbFile)) {
        report.errors.push('اندازهٔ فایل پشتیبان با مانیفست مطابقت ندارد.');
      }
      report.counts = tableCounts(resolved.dbFile);
      const expectedCounts = resolved.manifest.db?.counts || {};
      for (const key of ['devices', 'outages', 'alerts']) {
        if (expectedCounts[key] != null && report.counts[key] != null && expectedCounts[key] !== report.counts[key]) {
          report.errors.push(`تعداد ${key} با مانیفست مطابقت ندارد.`);
        }
      }
      for (const tile of resolved.manifest.mbtiles || []) {
        const file = path.join(resolved.dir, 'mbtiles', path.basename(tile.name));
        if (!fs.existsSync(file)) {
          report.errors.push(`فایل نقشهٔ پشتیبان غایب است: ${tile.name}`);
          continue;
        }
        const sha = sha256File(file);
        if (tile.sha256 && sha !== tile.sha256) report.errors.push(`checksum نقشهٔ ${tile.name} نامعتبر است.`);
        report.mbtiles.push({ name: tile.name, path: file, size: fileSizeBytes(file), sha256: sha });
      }
    }
    // ۲) integrity_check و ساختار
    const info = inspectSqliteFile(resolved.dbFile);
    report.integrity = info;
    if (!info.ok) report.errors.push(...info.errors);
    report.ok = report.errors.length === 0;
  } catch (e) {
    report.errors.push(e.message);
    report.ok = false;
  }
  return report;
}

function engineLockOwner() {
  try {
    return db.prepare('SELECT owner, expires_at FROM engine_lock WHERE id = 1').get() || null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* بازیابی                                                            */
/* ------------------------------------------------------------------ */

function removeWalShm() {
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.unlinkSync(`${DB_PATH}${suffix}`);
    } catch {
      /* فایلی وجود ندارد */
    }
  }
}

/** بازگرداندن نسخهٔ ایمنی با rename اتمیک (پس از خرابی هر مرحله) */
function rollbackToSafety(safetyFile) {
  if (!safetyFile || !fs.existsSync(safetyFile)) return false;
  const rb = `${DB_PATH}.rollback-${process.pid}`;
  fs.copyFileSync(safetyFile, rb);
  fsyncPath(rb);
  removeWalShm();
  fs.renameSync(rb, DB_PATH);
  fsyncPath(path.dirname(DB_PATH));
  return true;
}

/**
 * بازیابی کامل از پشتیبان.
 *
 * ترتیب امن (Crash-safe):
 *   ۱) verifyBackup: checksum + integrity + FK + جدول‌ها + نسخهٔ ساختار
 *   ۲) بررسی فضای دیسک و توقف نویسنده‌ها (onBeforeRestore)
 *   ۳) Checkpoint کامل و ساخت نسخهٔ ایمنی با fsync
 *   ۴) کپی پشتیبان در مسیر موقت و اعتبارسنجی دوبارهٔ همان کپی
 *   ۵) بستن اتصال، حذف WAL/SHM (پس از Checkpoint)، rename اتمیک فایل موقت
 *   ۶) بازگشایی، مهاجرت‌ها، integrity_check + foreign_key_check و تطبیق تعداد رکوردها
 *   ۷) بازیابی MBTiles با checksum تأییدشده
 *
 * فایل وضعیت `.restore-state.json` پیش از هر مرحله روی دیسک نوشته می‌شود؛
 * db.js پیش از بازکردن اتصال، بازیابی نیمه‌کاره را تشخیص و نسخهٔ ایمنی را
 * برمی‌گرداند. بنابراین Crash/SIGKILL در هر مرحله به دادهٔ معتبر می‌رسد.
 *
 * @param {string} source
 * @param {{restoreMbtiles?: boolean, force?: boolean, dryRun?: boolean, onBeforeRestore?: Function, onAfterRestore?: Function}} [options]
 */
export function restoreBackup(source, options = {}) {
  const { restoreMbtiles = true, force = false, dryRun = false, onBeforeRestore, onAfterRestore } = options;
  if (restoreInProgress) throw new DbError(DB_ERROR_CODES.BUSY, 'یک بازیابی دیگر در جریان است.', { status: 409 });
  if (String(DB_PATH).startsWith(':')) throw new DbError(DB_ERROR_CODES.BACKUP_INVALID, 'بازیابی روی پایگاه‌دادهٔ درون‌حافظه‌ای پشتیبانی نمی‌شود.', { status: 400 });

  const verification = verifyBackup(source);
  if (!verification.ok) {
    logEvent('warn', 'restore_rejected', { source: String(source), errors: verification.errors });
    throw new DbError(
      DB_ERROR_CODES.BACKUP_INVALID,
      `پشتیبان معتبر نیست و بازیابی انجام نشد: ${verification.errors.join(' | ')}`,
      { status: 400, detail: verification }
    );
  }
  if (dryRun) return { restored: false, dryRun: true, verification };

  const lock = engineLockOwner();
  if (lock && Number(lock.expires_at) > Date.now() && !force && !onBeforeRestore) {
    throw new DbError(
      DB_ERROR_CODES.BUSY,
      'موتور پایش فعال است؛ پیش از بازیابی سرویس را متوقف کنید یا گزینهٔ force را انتخاب کنید.',
      { status: 409 }
    );
  }

  restoreInProgress = true;
  const startedAt = Date.now();
  const safetyFile = `${DB_PATH}.pre-restore-${startedAt}`;
  const stageFile = `${DB_PATH}.restore-stage-${process.pid}`;
  const tilesStageDir = path.join(MBTILES_DIR, `.restore-stage-${process.pid}`);
  let closed = false;
  let installed = false;
  try {
    requireDiskSpace(fileSizeBytes(DB_PATH) * 2 + fileSizeBytes(verification.dbFile) + 8 * 1024 * 1024, 'بازیابی');
    onBeforeRestore?.();

    // ۱) دوام نوشته‌های تأییدشده در فایل اصلی، سپس نسخهٔ ایمنی
    try {
      db.checkpoint('TRUNCATE');
    } catch (e) {
      logEvent('warn', 'restore_checkpoint_failed', { message: e?.message });
    }
    if (fs.existsSync(DB_PATH)) {
      copyFileDurable(DB_PATH, safetyFile);
      fsyncPath(DATA_DIR);
    }
    writeRestoreState({
      status: 'in_progress',
      phase: 'safety_ready',
      startedAt,
      source: verification.dbFile,
      safetyFile: fs.existsSync(safetyFile) ? safetyFile : null,
      updatedAt: Date.now(),
    });

    // ۲) کپی در مسیر موقت و اعتبارسنجی همان کپی (نه فقط مبدأ)
    copyFileDurable(verification.dbFile, stageFile);
    const staged = inspectSqliteFile(stageFile);
    if (!staged.ok) {
      throw new DbError(DB_ERROR_CODES.BACKUP_INVALID, `کپی موقت پشتیبان معتبر نیست: ${staged.errors.join(' | ')}`, {
        status: 500,
      });
    }
    const stagedCounts = tableCounts(stageFile);
    const expectedCounts = verification.manifest?.db?.counts || {};
    const countMismatch = ['devices', 'samples', 'outages', 'alerts', 'users'].filter(
      (k) => expectedCounts[k] != null && stagedCounts[k] != null && Number(expectedCounts[k]) !== Number(stagedCounts[k])
    );
    if (countMismatch.length) {
      throw new DbError(DB_ERROR_CODES.BACKUP_INVALID, `تعداد رکوردهای کپی موقت با مانیفست نمی‌خواند: ${countMismatch.join(', ')}`, {
        status: 400,
      });
    }

    // ۳) آماده‌سازی فایل‌های نقشه در پوشهٔ موقت (پیش از جای‌گذاری پایگاه‌داده)
    const stagedTiles = [];
    if (restoreMbtiles && verification.mbtiles.length) {
      ensureDir(tilesStageDir);
      for (const tile of verification.mbtiles) {
        const tmp = path.join(tilesStageDir, path.basename(tile.name));
        copyFileDurable(tile.path, tmp);
        const sha = sha256File(tmp);
        if (tile.sha256 && sha !== tile.sha256) {
          throw new DbError(DB_ERROR_CODES.BACKUP_INVALID, `checksum فایل نقشه در کپی موقت نامعتبر است: ${tile.name}`, {
            status: 400,
          });
        }
        stagedTiles.push({ name: path.basename(tile.name), tmp });
      }
    }

    // ۴) جای‌گذاری اتمیک: ابتدا اتصال بسته و WAL/SHM پاک می‌شود تا WAL قدیمی
    //    هرگز روی فایل جدید بازپخش نشود؛ سپس rename موقت → اصلی.
    db.close();
    closed = true;
    removeWalShm();
    writeRestoreState({ status: 'in_progress', phase: 'installing', updatedAt: Date.now() });
    fs.renameSync(stageFile, DB_PATH);
    installed = true;
    fsyncPath(DATA_DIR);

    db.reopen();
    closed = false;
    runMigrations();
    ensureDefaultSettings();
    const health = checkDatabaseHealth({ full: true });
    if (!health.ok) {
      throw new DbError(DB_ERROR_CODES.CORRUPT, `پایگاه‌دادهٔ بازیابی‌شده سالم نیست: ${health.errors.join(' | ')}`, {
        status: 500,
        detail: health,
      });
    }
    // تطبیق نهایی: تعداد رکوردهای اصلی باید همان مانیفست باشد (کپی ناقص/خطای I/O)
    const postCounts = tableCounts(DB_PATH);
    const postMismatch = ['devices', 'samples', 'outages', 'alerts', 'users'].filter(
      (k) => expectedCounts[k] != null && postCounts[k] != null && Number(expectedCounts[k]) !== Number(postCounts[k])
    );
    if (postMismatch.length) {
      throw new DbError(DB_ERROR_CODES.CORRUPT, `تعداد رکوردها پس از بازیابی با مانیفست نمی‌خواند: ${postMismatch.join(', ')}`, {
        status: 500,
      });
    }

    // ۵) نصب فایل‌های نقشهٔ تأییدشده
    const restoredTiles = [];
    if (stagedTiles.length) {
      ensureDir(MBTILES_DIR);
      for (const tile of stagedTiles) {
        const dest = path.join(MBTILES_DIR, tile.name);
        const tmp = `${dest}.restore-tmp-${process.pid}`;
        fs.copyFileSync(tile.tmp, tmp);
        fsyncPath(tmp);
        fs.renameSync(tmp, dest);
        restoredTiles.push(tile.name);
      }
      fsyncPath(MBTILES_DIR);
    }

    const summary = {
      restored: true,
      source: verification.dbFile,
      safetyCopy: fs.existsSync(safetyFile) ? safetyFile : null,
      counts: postCounts,
      mbtiles: restoredTiles,
      durationMs: Date.now() - startedAt,
      health: { ok: health.ok, mode: health.mode, foreignKeyViolations: health.foreignKeyViolations },
      schemaVersion: Number(db.prepare('PRAGMA user_version').get()?.user_version) || null,
    };
    writeRestoreState({
      status: 'completed',
      phase: 'done',
      finishedAt: Date.now(),
      updatedAt: Date.now(),
      counts: postCounts,
      mbtiles: restoredTiles,
      durationMs: summary.durationMs,
      error: '',
    });
    log('info', `بازیابی از پشتیبان انجام شد: ${path.basename(verification.dbFile)} (${summary.durationMs}ms).`);
    logEvent('info', 'restore_completed', summary);
    onAfterRestore?.(summary);
    return summary;
  } catch (e) {
    const err = logDbError('backup.restore', e);
    let rolledBack = false;
    try {
      if (closed) {
        db.close();
        closed = false;
      }
      if (installed) {
        rolledBack = rollbackToSafety(safetyFile);
      }
      db.reopen();
      closed = false;
    } catch (recoveryError) {
      logEvent('error', 'restore_rollback_failed', { message: recoveryError?.message });
    }
    writeRestoreState({
      status: 'failed',
      phase: 'failed',
      finishedAt: Date.now(),
      updatedAt: Date.now(),
      error: String(err?.message || e).slice(0, 500),
      rolledBack,
      safetyFile: fs.existsSync(safetyFile) ? safetyFile : null,
    });
    log('error', `بازیابی ناموفق بود${rolledBack ? ' و نسخهٔ ایمنی بازگردانده شد' : ''}: ${err.message}`);
    onAfterRestore?.(null);
    throw err;
  } finally {
    restoreInProgress = false;
    for (const file of [stageFile]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* بی‌اثر */
      }
    }
    try {
      fs.rmSync(tilesStageDir, { recursive: true, force: true });
    } catch {
      /* بی‌اثر */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Checkpoint و زمان‌بندی                                              */
/* ------------------------------------------------------------------ */

/** Checkpoint دوره‌ای؛ مقدار بازگشتی برای گزارش‌ها و آزمون‌ها */
export function runCheckpoint(reason = 'scheduled') {
  try {
    const startedAt = Date.now();
    const result = db.checkpoint('TRUNCATE');
    const info = { ...result, reason, durationMs: Date.now() - startedAt, ...db.walInfo() };
    if (result.busy) {
      logEvent('warn', 'wal_checkpoint_busy', info);
    } else {
      logEvent('info', 'wal_checkpoint', info);
    }
    return info;
  } catch (e) {
    const err = logDbError('db.checkpoint.scheduled', e);
    logEvent('error', 'wal_checkpoint_failed', { message: err.message, reason });
    return { ok: false, error: err.message, reason };
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, STATE_FILE), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(patch = {}) {
  try {
    ensureDir(BACKUP_DIR);
    writeJsonDurable(path.join(BACKUP_DIR, STATE_FILE), { ...readState(), ...patch });
  } catch {
    /* وضعیت زمان‌بند حیاتی نیست */
  }
}

let schedulerTimer = null;
let schedulerKickoff = null;
let lastCheckpointAt = 0;
let lastBackupAt = 0;
let tickRunning = false;
let leaderCheck = null;

/**
 * زمان‌بند پشتیبان‌گیری خودکار + Checkpoint دوره‌ای.
 * هر ۶۰ ثانیه بیدار می‌شود و بر اساس تنظیمات (backup_enabled،
 * backup_interval_hours، checkpoint_interval_minutes) کار را انجام می‌دهد.
 * پشتیبان نخستین بار چند ثانیه پس از راه‌اندازی (اگر موعدش رسیده باشد).
 */
export function startBackupScheduler({ isLeader = null } = {}) {
  if (schedulerTimer) return schedulerTimer;
  leaderCheck = typeof isLeader === 'function' ? isLeader : null;
  const state = readState();
  lastBackupAt = Number(state.lastBackupAt) || 0;
  lastCheckpointAt = Date.now();
  const tick = () => {
    if (tickRunning || restoreInProgress) return;
    tickRunning = true;
    try {
      const s = getSettings();
      const checkpointEvery = Math.max(1, Number(s.checkpoint_interval_minutes) || 15) * 60000;
      if (Date.now() - lastCheckpointAt >= checkpointEvery) {
        lastCheckpointAt = Date.now();
        runCheckpoint('scheduled');
      }
      if (s.backup_enabled === false) return;
      // پشتیبان‌گیری فقط در نمونهٔ رهبر انجام می‌شود تا در اجرای هم‌زمان
      // سرور و engine-cli، دو پشتیبان تکراری ساخته نشود.
      if (leaderCheck && !leaderCheck()) return;
      const backupEvery = Math.max(1, Number(s.backup_interval_hours) || 24) * 3600000;
      if (Date.now() - lastBackupAt >= backupEvery) {
        lastBackupAt = Date.now();
        const created = createBackup({
          keep: s.backup_prune_enabled === false ? s.backup_keep : null,
          reason: 'scheduled',
        });
        writeState({ lastBackupAt: Date.now(), lastName: created.name });
        lastBackupAt = Date.now();
      }
    } catch (e) {
      logEvent('error', 'backup_scheduler_error', { message: e?.message, code: e?.code });
    } finally {
      tickRunning = false;
    }
  };
  schedulerTimer = setInterval(tick, 60000);
  if (schedulerTimer.unref) schedulerTimer.unref();
  schedulerKickoff = setTimeout(tick, 5000);
  if (schedulerKickoff.unref) schedulerKickoff.unref();
  logEvent('info', 'backup_scheduler_started', { dir: BACKUP_DIR, lastBackupAt });
  return schedulerTimer;
}

export function stopBackupScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (schedulerKickoff) clearTimeout(schedulerKickoff);
  schedulerTimer = null;
  schedulerKickoff = null;
  leaderCheck = null;
}

/** وضعیت خلاصه برای /api/system/db/health */
export function backupStatus() {
  const backups = listBackups();
  const state = readState();
  const settings = getSettings();
  return {
    dir: BACKUP_DIR,
    appVersion: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    count: backups.length,
    lastBackupAt: Number(state.lastBackupAt) || lastBackupAt || null,
    latest: backups[0] || null,
    running: backupInProgress,
    restoring: restoreInProgress,
    restore: restoreStatus(),
    policy: {
      enabled: settings.backup_enabled !== false,
      intervalHours: settings.backup_interval_hours,
      pruneEnabled: settings.backup_prune_enabled !== false,
      dailyKeep: settings.backup_daily_keep,
      weeklyKeep: settings.backup_weekly_keep,
    },
    freeBytes: freeDiskBytes(DATA_DIR),
  };
}

