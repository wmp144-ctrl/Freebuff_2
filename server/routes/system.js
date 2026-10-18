/**
 * NetWatch — API پایگاه‌داده و پشتیبان‌گیری
 * ----------------------------------------------------------------
 * خواندن وضعیت با `system:health` (Operator/Administrator) و عملیات
 * پشتیبان‌گیری/بازیابی فقط برای Administrator است، چون هر دو کل داده را
 * جابه‌جا می‌کنند. بازیابی ابتدا موتور را متوقف می‌کند تا هیچ نوشتنی در
 * میانهٔ جای‌گذاری فایل رخ ندهد.
 */
import express from 'express';
import path from 'node:path';
import {
  db,
  checkDatabaseHealth,
  diskSpace,
  log,
} from '../db.js';
import { isAdmin, requirePermission } from '../permissions.js';
import { logEvent } from '../logger.mjs';
import {
  BACKUP_DIR,
  backupStatus,
  createBackup,
  listBackups,
  pruneBackups,
  restoreBackup,
  runCheckpoint,
  verifyBackup,
} from '../backup.js';
import { engine } from '../engine.js';

const router = express.Router();

router.use(requirePermission('system:health'));

/** نتیجهٔ سلامت برای ۳۰ ثانیه کش می‌شود تا پایش مداوم، integrity_check را تکرار نکند */
let healthCache = { at: 0, value: null };
function cachedHealth() {
  if (Date.now() - healthCache.at < 30000) return healthCache.value;
  const value = checkDatabaseHealth({ full: false });
  healthCache = { at: Date.now(), value };
  return value;
}

function requireAdmin(req, res, next) {
  if (isAdmin(req.user)) return next();
  return res.status(403).json({ error: 'این عملیات فقط برای Administrator مجاز است.' });
}

router.get('/db/health', (_req, res) => {
  const health = cachedHealth();
  const wal = db.walInfo();
  res.json({
    ok: health.ok,
    health,
    wal,
    disk: diskSpace(),
    backups: backupStatus(),
    tables: (() => {
      try {
        return db
          .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all()
          .map((r) => r.name);
      } catch {
        return [];
      }
    })(),
  });
});

router.post('/db/checkpoint', requireAdmin, (req, res) => {
  const result = runCheckpoint('api');
  res.status(result.busy ? 409 : 200).json(result);
});

router.get('/backups', (_req, res) => {
  res.json({ dir: BACKUP_DIR, items: listBackups(), status: backupStatus() });
});

router.post('/backups', requireAdmin, (req, res) => {
  try {
    const result = createBackup({
      includeMbtiles: req.body?.includeMbtiles !== false,
      keep: req.body?.keep,
      reason: `api:${req.user?.username || 'unknown'}`,
    });
    res.status(201).json({
      name: result.name,
      dir: result.dir,
      manifest: result.manifest,
    });
  } catch (e) {
    const status = Number(e.status) || (e.code === 'DB_DISK_FULL' ? 507 : 500);
    res.status(status).json({ error: e.message, code: e.code });
  }
});

router.post('/backups/verify', requireAdmin, (req, res) => {
  const target = resolveBackupTarget(req.body?.name, req.body?.path);
  if (target.error) return res.status(target.status).json({ error: target.error });
  const report = verifyBackup(target.path);
  res.status(report.ok ? 200 : 400).json(report);
});

router.post('/backups/prune', requireAdmin, (req, res) => {
  const removed = pruneBackups(req.body?.keep);
  res.json({ removed, count: removed.length });
});

/**
 * بازیابی: فقط نام مجموعه‌های داخل BACKUP_DIR پذیرفته می‌شود (جلوگیری از
 * path traversal). بازیابی عامل توقف و راه‌اندازی دوبارهٔ موتور است.
 */
router.post('/backups/restore', requireAdmin, (req, res) => {
  const target = resolveBackupTarget(req.body?.name, null);
  if (target.error) return res.status(target.status).json({ error: target.error });
  const dryRun = req.body?.dryRun === true;
  const wasRunning = engine.getStatus().running;
  const wasLeader = engine.getStatus().leader;
  try {
    const result = restoreBackup(target.path, {
      restoreMbtiles: req.body?.restoreMbtiles !== false,
      dryRun,
      force: true,
      onBeforeRestore: () => {
        try {
          engine.stop();
        } catch {
          /* بی‌اثر */
        }
        logEvent('warn', 'restore_via_api', { by: req.user?.username, name: target.name });
      },
    });
    if (!dryRun && wasRunning) engine.start().catch((e) => log('error', `راه‌اندازی موتور پس از بازیابی ناموفق: ${e.message}`));
    log('warn', `بازیابی از پشتیبان «${target.name}» توسط ${req.user?.username || 'ناشناس'} انجام شد.`);
    res.json(result);
  } catch (e) {
    if (wasRunning && !dryRun) engine.start().catch(() => {});
    if (wasLeader) logEvent('warn', 'restore_leader_lost', {});
    res.status(Number(e.status) || 500).json({ error: e.message, code: e.code });
  }
});

/** فقط نام پوشهٔ پشتیبان داخل BACKUP_DIR (یا path وقتی صریحاً مجاز باشد) */
function resolveBackupTarget(name, explicitPath) {
  if (explicitPath) {
    const resolved = path.resolve(String(explicitPath));
    if (!resolved.startsWith(path.resolve(BACKUP_DIR) + path.sep) && resolved !== path.resolve(BACKUP_DIR)) {
      return { error: 'مسیر پشتیبان باید داخل پوشهٔ پشتیبان‌ها باشد.', status: 400 };
    }
    return { path: resolved, name: path.basename(resolved) };
  }
  const safe = path.basename(String(name || ''));
  if (!safe || safe.startsWith('.') || !/^netwatch-\d{8}-\d{6}-[a-f0-9]{6}$/.test(safe)) {
    return { error: 'نام پشتیبان نامعتبر است.', status: 400 };
  }
  const known = listBackups().find((b) => b.name === safe);
  if (!known) return { error: 'پشتیبان یافت نشد.', status: 404 };
  return { path: known.dir, name: safe };
}

export default router;
