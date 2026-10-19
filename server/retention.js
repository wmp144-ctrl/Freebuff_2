/**
 * NetWatch — Data Retention Engine
 * ----------------------------------------------------------------
 * سرویس مستقل نگهداری داده با این تضمین‌ها:
 *   • هر Batch در تراکنش مستقل اجرا می‌شود؛ شکست یا توقف، داده‌ای را نیمه‌حذف
 *     نمی‌کند و اجرای بعدی از همان وضعیت معتبر ادامه می‌دهد.
 *   • پیش از حذف نمونه‌ها، روزهای دارای نمونه در `daily_stats` تثبیت می‌شوند؛
 *     اگر تجمیعی ممکن نباشد، حذف نمونه‌ها متوقف می‌شود (دادهٔ تاریخی از دست
 *     نمی‌رود).
 *   • قطعی «باز»، هشدار «حل‌نشده» و قطعی متصل به سابقهٔ تعمیرات هرگز حذف
 *     نمی‌شوند.
 *   • قفل تک‌نمونه‌ای در پایگاه‌داده، اجرای هم‌زمان سرور و engine-cli را مهار
 *     می‌کند؛ قفل منقضی‌شده پس از Crash با lease تازه آزاد می‌شود.
 *   • هر اجرا در `retention_runs` و Audit Log ثبت می‌شود.
 *   • پشتیبان‌ها به‌طور پیش‌فرض در این سرویس حذف نمی‌شوند.
 */
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { db, getSettings, transaction, log, DB_PATH } from './db.js';
import { logEvent } from './logger.mjs';
import { DbError, DB_ERROR_CODES, logDbError } from './db-errors.js';
import { DAY_MS, dayStart, dayLabel } from './daily.js';
import { ensureDailyStatsBefore } from './rollup.js';
import { recordAudit } from './audit.js';
import { pruneBackupsByPolicy } from './backup.js';

const MINUTE_MS = 60000;
const LOCK_LEASE_MS = 120000;
const MAX_BATCHES_PER_STAGE = 100000;

/** فاصلهٔ عددی امن برای سیاست */
function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * سیاست مؤثر: مقادیر ذخیره‌شده در settings، با کف‌های قانونی.
 * کف‌ها تضمین می‌کنند حتی تنظیم خراب/دستکاری‌شده دادهٔ تاریخی را نابود نکند.
 */
export function retentionPolicy(settings = getSettings()) {
  const s = settings || {};
  return {
    enabled: s.retention_enabled !== false,
    legalHold: s.retention_legal_hold === true,
    runTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.retention_run_time || '')) ? String(s.retention_run_time) : '03:00',
    intervalMinutes: clampInt(s.retention_interval_minutes, 15, 10080, 1440),
    batchSize: clampInt(s.retention_batch_size, 100, 50000, 5000),
    maxRowsPerRun: clampInt(s.retention_max_rows_per_run, 1000, 5000000, 100000),
    samplesDays: clampInt(s.samples_retention_days ?? s.retention_days, 1, 3650, 90),
    dailyStatsDays: clampInt(s.daily_stats_retention_days, 365, 36500, 365),
    outagesDays: clampInt(s.outages_retention_days, 365, 36500, 365),
    alertsDays: clampInt(s.alerts_retention_days, 30, 3650, 180),
    auditDays: clampInt(s.audit_retention_days, 365, 36500, 365),
    engineLogDays: clampInt(s.engine_log_retention_days, 7, 3650, 30),
    timezoneOffsetMinutes: clampInt(s.timezone_offset_minutes, -720, 840, 0),
    pruneBackups: s.retention_prune_backups === true,
  };
}

/* ------------------------------------------------------------------ */
/* قفل و وضعیت                                                        */
/* ------------------------------------------------------------------ */

const OWNER = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

const stmts = {
  state: db.prepare('SELECT * FROM retention_state WHERE id = 1'),
  acquire: db.prepare(
    `UPDATE retention_state SET lock_owner = ?, lock_expires_at = ?, updated_at = ?
     WHERE id = 1 AND (lock_owner IS NULL OR lock_owner = ? OR lock_expires_at < ?)`
  ),
  renew: db.prepare('UPDATE retention_state SET lock_expires_at = ?, updated_at = ? WHERE id = 1 AND lock_owner = ?'),
  stopFlag: db.prepare('SELECT stop_requested FROM retention_state WHERE id = 1'),
  requestStop: db.prepare('UPDATE retention_state SET stop_requested = 1, updated_at = ? WHERE id = 1'),
  clearStop: db.prepare('UPDATE retention_state SET stop_requested = 0, updated_at = ? WHERE id = 1'),
  release: db.prepare('UPDATE retention_state SET lock_owner = NULL, lock_expires_at = 0, updated_at = ? WHERE id = 1 AND lock_owner = ?'),
  finish: db.prepare(
    `UPDATE retention_state SET last_run_id = ?, last_started_at = ?, last_finished_at = ?,
       last_status = ?, last_deleted_rows = ?, last_freed_bytes = ?, next_run_at = ?, updated_at = ?
     WHERE id = 1`
  ),
  interruptStale: db.prepare(
    `UPDATE retention_runs SET status = 'interrupted', finished_at = ?, stage = 'interrupted',
       error = CASE WHEN error = '' THEN 'اجرای قبلی پیش از پایان متوقف شد (Crash/خروج)' ELSE error END
     WHERE status = 'running'`
  ),
  newRun: db.prepare(
    `INSERT INTO retention_runs(started_at, trigger, actor, dry_run, status, policy)
     VALUES (?,?,?,?, 'running', ?)`
  ),
  updateRun: db.prepare(
    `UPDATE retention_runs SET stage = ?, deleted = ?, scanned = ?, deleted_rows = ?, freed_bytes = ?, batches = ? WHERE id = ?`
  ),
  finishRun: db.prepare('UPDATE retention_runs SET finished_at = ?, status = ?, stage = ?, duration_ms = ?, error = ?, deleted = ?, deleted_rows = ?, freed_bytes = ?, batches = ? WHERE id = ?'),
  lastRuns: db.prepare('SELECT * FROM retention_runs ORDER BY started_at DESC, id DESC LIMIT ?'),
  countSamples: db.prepare('SELECT COUNT(*) AS c FROM samples WHERE ts < ?'),
  countOutages: db.prepare(
    `SELECT COUNT(*) AS c FROM outages o
      WHERE o.open = 0 AND o.started_at < ?
        AND NOT EXISTS (SELECT 1 FROM maintenance_records m WHERE m.outage_id = o.id)
        AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.current_outage_id = o.id)`
  ),
  countAlerts: db.prepare(
    `SELECT COUNT(*) AS c FROM alerts a
      WHERE a.created_at < ? AND a.status IN ('resolved','suppressed')
        AND NOT EXISTS (SELECT 1 FROM outages o WHERE o.device_id = a.device_id AND o.open = 1)`
  ),
  countDaily: db.prepare('SELECT COUNT(*) AS c FROM daily_stats WHERE day < ?'),
  countAudit: db.prepare('SELECT COUNT(*) AS c FROM audit_log WHERE ts < ?'),
  countEngineLog: db.prepare('SELECT COUNT(*) AS c FROM engine_log WHERE ts < ?'),
  pruneSamples: db.prepare('DELETE FROM samples WHERE rowid IN (SELECT rowid FROM samples WHERE ts < ? LIMIT ?)'),
  pruneOutages: db.prepare(
    `DELETE FROM outages WHERE rowid IN (
       SELECT o.rowid FROM outages o
        WHERE o.open = 0 AND o.started_at < ?
          AND NOT EXISTS (SELECT 1 FROM maintenance_records m WHERE m.outage_id = o.id)
          -- ارجاع هر تجهیز به این قطعی (حتی به‌شکل ناسازگار) پیوند را حفظ می‌کند
          AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.current_outage_id = o.id)
        LIMIT ?)`
  ),
  pruneAlerts: db.prepare(
    `DELETE FROM alerts WHERE rowid IN (
       SELECT a.rowid FROM alerts a
        WHERE a.created_at < ? AND a.status IN ('resolved','suppressed')
          AND NOT EXISTS (SELECT 1 FROM outages o WHERE o.device_id = a.device_id AND o.open = 1)
        LIMIT ?)`
  ),
  pruneDaily: db.prepare('DELETE FROM daily_stats WHERE rowid IN (SELECT rowid FROM daily_stats WHERE day < ? LIMIT ?)'),
  pruneAudit: db.prepare('DELETE FROM audit_log WHERE rowid IN (SELECT rowid FROM audit_log WHERE ts < ? LIMIT ?)'),
  pruneEngineLog: db.prepare('DELETE FROM engine_log WHERE rowid IN (SELECT rowid FROM engine_log WHERE ts < ? LIMIT ?)'),
  pageStats: db.prepare('PRAGMA page_count'),
  freePages: db.prepare('PRAGMA freelist_count'),
  pageSize: db.prepare('PRAGMA page_size'),
};

let running = false;
let abortRequested = false;
let schedulerTimer = null;
let schedulerTick = null;
let leaderCheck = null;

/**
 * درخواست توقف کنترل‌شدهٔ اجرای جاری.
 *
 * پرچم در پایگاه‌داده هم نوشته می‌شود تا اجرای جاری — حتی اگر در فرآیند دیگری
 * (سرور/engine-cli) باشد — بین دو Batch آن را ببیند. دلیل: خود موتور همگام است
 * و در میانهٔ یک Batch نمی‌تواند پاسخ HTTP بگیرد؛ بنابراین توقف همیشه در
 * مرز Batch اعمال می‌شود و اجرا از همان وضعیت معتبر ادامه می‌یابد.
 */
export function requestRetentionStop() {
  try {
    stmts.requestStop.run(Date.now());
  } catch {
    /* بی‌اثر */
  }
  if (!running) return false;
  abortRequested = true;
  logEvent('warn', 'retention_stop_requested', { owner: OWNER });
  return true;
}

/** آیا توقف از فرآیند دیگری درخواست شده است؟ */
function stopRequestedInDb() {
  try {
    return Number(stmts.stopFlag.get()?.stop_requested || 0) === 1;
  } catch {
    return false;
  }
}

function acquireLock() {
  const now = Date.now();
  const result = stmts.acquire.run(OWNER, now + LOCK_LEASE_MS, now, OWNER, now);
  if (!result.changes) {
    const row = stmts.state.get();
    return { ok: false, owner: row?.lock_owner, expiresAt: row?.lock_expires_at };
  }
  return { ok: true };
}

function renewLock() {
  const now = Date.now();
  return stmts.renew.run(now + LOCK_LEASE_MS, now, OWNER).changes > 0;
}

function releaseLock() {
  try {
    stmts.release.run(Date.now(), OWNER);
  } catch {
    /* بی‌اثر */
  }
}

function storageStats() {
  try {
    const pageSize = Number(stmts.pageSize.get()?.page_size) || 4096;
    const pages = Number(stmts.pageStats.get()?.page_count) || 0;
    const free = Number(stmts.freePages.get()?.freelist_count) || 0;
    const wal = (() => {
      try {
        return fs.statSync(`${DB_PATH}-wal`).size;
      } catch {
        return 0;
      }
    })();
    return { pageSize, pages, freePages: free, dbBytes: pages * pageSize, freeBytes: free * pageSize, walBytes: wal };
  } catch {
    return { pageSize: 4096, pages: 0, freePages: 0, dbBytes: 0, freeBytes: 0, walBytes: 0 };
  }
}

/* ------------------------------------------------------------------ */
/* زمان‌بندی                                                          */
/* ------------------------------------------------------------------ */

/** زمان اجرای بعدی بر پایهٔ ساعت محلی تنظیمات + حداقل فاصلهٔ اجرا */
export function computeNextRunAt(policy, from = Date.now()) {
  const offset = policy.timezoneOffsetMinutes * MINUTE_MS;
  const local = new Date(from + offset);
  const [hh, mm] = policy.runTime.split(':').map(Number);
  const candidateLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hh, mm, 0, 0);
  let candidate = candidateLocal - offset;
  if (candidate <= from) candidate += DAY_MS;
  const state = stmts.state.get();
  const last = Number(state?.last_started_at) || 0;
  const minGap = policy.intervalMinutes * MINUTE_MS;
  if (last && candidate < last + minGap) candidate = last + minGap;
  return candidate;
}

/* ------------------------------------------------------------------ */
/* اجرای Retention                                                    */
/* ------------------------------------------------------------------ */

/**
 * @typedef {object} RetentionOptions
 * @property {'scheduled'|'manual'|'engine'|'cli'} [trigger]
 * @property {string} [actor]
 * @property {boolean} [dryRun]
 * @property {object} [policyOverride] مقادیر جایگزین (آزمون/موتور قدیمی)
 * @property {boolean} [force] اجرا حتی وقتی retention_enabled=false (فقط مدیر)
 */

/**
 * اجرای یک دورهٔ محدود Retention.
 * @param {RetentionOptions} [options]
 */
export function runRetention(options = {}) {
  const trigger = options.trigger || 'manual';
  const dryRun = options.dryRun === true;
  const settings = getSettings();
  const policy = { ...retentionPolicy(settings), ...(options.policyOverride || {}) };
  const startedAt = Date.now();

  if (policy.legalHold) {
    return { status: 'skipped', reason: 'legal_hold', policy, dryRun, runId: null, deleted: {}, deletedRows: 0 };
  }
  if (!policy.enabled && trigger !== 'manual' && !options.force) {
    return { status: 'skipped', reason: 'disabled', policy, dryRun, runId: null, deleted: {}, deletedRows: 0 };
  }
  if (running) throw new DbError(DB_ERROR_CODES.BUSY, 'یک اجرای Retention دیگر در جریان است.', { status: 409 });

  const lock = acquireLock();
  if (!lock.ok) {
    throw new DbError(
      DB_ERROR_CODES.BUSY,
      `Retention در نمونهٔ دیگری اجرا می‌شود (${lock.owner || 'ناشناس'})؛ اجرای هم‌زمان مجاز نیست.`,
      { status: 409 }
    );
  }

  running = true;
  abortRequested = false;
  try {
    stmts.clearStop.run(Date.now());
  } catch {
    /* بی‌اثر */
  }
  const runId = Number(
    stmts.newRun.run(startedAt, trigger, String(options.actor || '').slice(0, 64), dryRun ? 1 : 0, JSON.stringify(policy))
      .lastInsertRowid
  );
  const deleted = { samples: 0, outages: 0, alerts: 0, daily_stats: 0, audit_log: 0, engine_log: 0, backups: 0 };
  let scanned = 0;
  let batches = 0;
  let stage = 'init';
  const blocked = {};
  const before = storageStats();

  const persist = (status = 'running') => {
    try {
      stmts.updateRun.run(stage, JSON.stringify(deleted), scanned, Object.values(deleted).reduce((a, b) => a + b, 0), 0, batches, runId);
      if (status === 'running') renewLock();
    } catch (e) {
      logEvent('warn', 'retention_progress_write_failed', { message: e?.message });
    }
  };

  try {
    // ردیف‌های runningِ اجراهای قبلی (Crash) به interrupted تغییر می‌کنند؛ خود این
    // اجرا با lock تازه از وضعیت معتبر ادامه می‌دهد.
    stmts.interruptStale.run(startedAt);

    const now = Date.now();
    const offset = policy.timezoneOffsetMinutes;
    const sampleCutoff = Math.min(now - policy.samplesDays * DAY_MS, dayStart(now, offset) - DAY_MS);
    const oldestCutoff = now - policy.outagesDays * DAY_MS;
    const alertCutoff = now - policy.alertsDays * DAY_MS;
    const auditCutoff = now - policy.auditDays * DAY_MS;
    const engineLogCutoff = now - policy.engineLogDays * DAY_MS;
    const dailyCutoffLabel = dayLabel(dayStart(now - policy.dailyStatsDays * DAY_MS, offset), offset);

    const wanted = {
      samples: sampleCutoff > 0,
      outages: true,
      alerts: true,
      daily_stats: true,
      audit_log: true,
      engine_log: true,
      backups: policy.pruneBackups,
    };

    /* ---------- پیش‌بررسی: تثبیت آمار روزانه ---------- */
    stage = 'preflight';
    persist();
    const rollup = ensureDailyStatsBefore({
      cutoff: sampleCutoff,
      offsetMin: offset,
      limit: 62,
      dryRun,
    });
    if (rollup.remaining > 0) {
      // بدون آمار روزانه، حذف نمونه‌ها یعنی نابودی گزارش تاریخی؛ این مرحله
      // متوقف می‌شود و در اجرای بعدی پس از تجمیع ادامه می‌یابد.
      wanted.samples = false;
      blocked.samples = `missing_daily_stats:${rollup.remaining}`;
      log('warn', `حذف نمونه‌ها متوقف شد: ${rollup.remaining} روز تجمیع‌نشده در بازهٔ حذف وجود دارد.`);
    }

    /* ---------- شمارش (Dry-Run و گزارش) ---------- */
    stage = 'count';
    const counts = {
      samples: wanted.samples ? Number(stmts.countSamples.get(sampleCutoff)?.c || 0) : 0,
      outages: Number(stmts.countOutages.get(oldestCutoff)?.c || 0),
      alerts: Number(stmts.countAlerts.get(alertCutoff)?.c || 0),
      daily_stats: Number(stmts.countDaily.get(dailyCutoffLabel)?.c || 0),
      audit_log: Number(stmts.countAudit.get(auditCutoff)?.c || 0),
      engine_log: Number(stmts.countEngineLog.get(engineLogCutoff)?.c || 0),
    };
    scanned = Object.values(counts).reduce((a, b) => a + b, 0);
    persist();

    if (dryRun) {
      const finishedAt = Date.now();
      stmts.finishRun.run(finishedAt, 'completed', 'dry-run', finishedAt - startedAt, '', JSON.stringify(counts), 0, 0, 0, runId);
      stmts.finish.run(runId, startedAt, finishedAt, 'completed', 0, 0, computeNextRunAt(policy, finishedAt), finishedAt);
      auditRetention({ trigger, actor: options.actor, runId, dryRun: true, deleted: counts, blocked, policy });
      logEvent('info', 'retention_dry_run', { runId, counts, blocked });
      return {
        status: 'completed',
        dryRun: true,
        runId,
        counts,
        deleted: counts,
        deletedRows: Object.values(counts).reduce((a, b) => a + b, 0),
        blocked,
        policy,
        durationMs: finishedAt - startedAt,
      };
    }

    /* ---------- حذف مرحله‌به‌مرحله ---------- */
    const stages = [
      {
        key: 'samples',
        table: 'samples',
        enabled: wanted.samples,
        cutoff: sampleCutoff,
        stmt: stmts.pruneSamples,
        batch: policy.batchSize,
      },
      { key: 'outages', table: 'outages', enabled: true, cutoff: oldestCutoff, stmt: stmts.pruneOutages, batch: policy.batchSize },
      { key: 'alerts', table: 'alerts', enabled: true, cutoff: alertCutoff, stmt: stmts.pruneAlerts, batch: policy.batchSize },
      { key: 'daily_stats', table: 'daily_stats', enabled: true, cutoff: dailyCutoffLabel, stmt: stmts.pruneDaily, batch: policy.batchSize },
      { key: 'audit_log', table: 'audit_log', enabled: true, cutoff: auditCutoff, stmt: stmts.pruneAudit, batch: policy.batchSize },
      { key: 'engine_log', table: 'engine_log', enabled: true, cutoff: engineLogCutoff, stmt: stmts.pruneEngineLog, batch: policy.batchSize },
    ];

    let stopped = false;
    let totalDeleted = 0;
    for (const st of stages) {
      if (!st.enabled) continue;
      if (totalDeleted >= policy.maxRowsPerRun) break;
      stage = st.key;
      let stageBatches = 0;
      while (totalDeleted < policy.maxRowsPerRun) {
        // قلاب پیشرفت (بررسی Batch): آزمون‌ها و ابزارهای عملیاتی می‌توانند پیش از
        // هر Batch تصمیم بگیرند؛ توقف واقعی از پرچم حافظه/پایگاه‌داده خوانده می‌شود.
        options.onBatch?.({ stage: st.key, batches, deletedRows: totalDeleted });
        if (abortRequested || stopRequestedInDb()) {
          stopped = true;
          break;
        }
        const size = Math.min(st.batch, policy.maxRowsPerRun - totalDeleted);
        if (size <= 0) break;
        // هر Batch یک تراکنش مستقل: Crash فقط همان Batch را برمی‌گرداند.
        const n = Number(
          transaction(() => st.stmt.run(st.cutoff, size).changes || 0, { label: `retention.${st.key}` })
        );
        batches += 1;
        stageBatches += 1;
        totalDeleted += n;
        deleted[st.key] += n;
        if (n < size || stageBatches >= MAX_BATCHES_PER_STAGE) break;
      }
      persist();
      if (stopped || totalDeleted >= policy.maxRowsPerRun) break;
    }

    /* ---------- اختیاری: هرس پشتیبان با سیاست مستقل ---------- */
    if (policy.pruneBackups && !stopped && totalDeleted < policy.maxRowsPerRun) {
      stage = 'backups';
      try {
        const removed = pruneBackupsByPolicy({
          dailyKeep: clampInt(settings.backup_daily_keep, 1, 60, 7),
          weeklyKeep: clampInt(settings.backup_weekly_keep, 0, 52, 4),
        });
        deleted.backups = removed.length;
        totalDeleted += removed.length;
      } catch (e) {
        logEvent('warn', 'retention_backup_prune_failed', { message: e?.message });
      }
    }

    const finishedAt = Date.now();
    const after = storageStats();
    const freedBytes = Math.max(0, after.freePages - before.freePages) * after.pageSize;
    const finalStatus = stopped ? 'stopped' : 'completed';
    stage = finalStatus;
    stmts.finishRun.run(
      finishedAt,
      finalStatus,
      stage,
      finishedAt - startedAt,
      '',
      JSON.stringify(deleted),
      totalDeleted,
      freedBytes,
      batches,
      runId
    );
    stmts.finish.run(runId, startedAt, finishedAt, finalStatus, totalDeleted, freedBytes, computeNextRunAt(policy, finishedAt), finishedAt);
    if (running) releaseLock();
    running = false;

    // Checkpoint سبک پس از حذف: WAL جمع می‌شود ولی نوشتن هم‌زمان مسدود نمی‌شود.
    try {
      db.checkpoint('PASSIVE');
      db.exec('PRAGMA optimize');
    } catch {
      /* بی‌اثر */
    }

    auditRetention({ trigger, actor: options.actor, runId, dryRun: false, deleted, blocked, policy, status: finalStatus, freedBytes });
    log(
      'info',
      `Retention (${finalStatus}): ${totalDeleted.toLocaleString('fa-IR')} رکورد حذف شد؛ ${Math.round(freedBytes / 1024).toLocaleString('fa-IR')} کیلوبایت آزاد شد.`
    );
    logEvent('info', 'retention_completed', { runId, trigger, status: finalStatus, deleted, freedBytes, batches, durationMs: finishedAt - startedAt });

    return {
      status: finalStatus,
      dryRun: false,
      runId,
      deleted,
      deletedRows: totalDeleted,
      freedBytes,
      batches,
      blocked,
      policy,
      durationMs: finishedAt - startedAt,
    };
  } catch (e) {
    const finishedAt = Date.now();
    const err = logDbError('retention.run', e);
    try {
      stmts.finishRun.run(finishedAt, 'failed', stage, finishedAt - startedAt, String(err?.message || e).slice(0, 500), JSON.stringify(deleted), 0, 0, batches, runId);
      stmts.finish.run(runId, startedAt, finishedAt, 'failed', 0, 0, computeNextRunAt(policy, finishedAt), finishedAt);
    } catch {
      /* ثبت شکست نباید خطای اصلی را بپوشاند */
    }
    log('error', `Retention ناموفق بود و متوقف شد: ${err?.message || e}`);
    logEvent('error', 'retention_failed', { runId, stage, message: err?.message || String(e), deleted });
    throw err;
  } finally {
    running = false;
    abortRequested = false;
    releaseLock();
  }
}

function auditRetention({ trigger, actor, runId, dryRun, deleted, blocked, policy, status = 'completed', freedBytes = 0 }) {
  try {
    recordAudit({
      action: dryRun ? 'retention.dry_run' : 'retention.run',
      targetType: 'retention',
      targetId: String(runId),
      actor: actor ? { username: actor } : { username: trigger === 'engine' ? 'engine' : 'system' },
      success: true,
      details: { trigger, dryRun, status, deleted, blocked, freedBytes, policy },
    });
  } catch {
    /* حسابرسی نباید اجرای Retention را بشکند */
  }
}

/* ------------------------------------------------------------------ */
/* زمان‌بند و وضعیت                                                    */
/* ------------------------------------------------------------------ */

/**
 * زمان‌بند Retention: هر ۶۰ ثانیه بیدار می‌شود و در صورت رسیدن موعد و
 * رهبربودن نمونه، یک اجرای محدود انجام می‌دهد.
 */
export function startRetentionScheduler({ isLeader = null } = {}) {
  if (schedulerTimer) return schedulerTimer;
  leaderCheck = typeof isLeader === 'function' ? isLeader : null;
  const tick = () => {
    if (running) return;
    try {
      const settings = getSettings();
      const policy = retentionPolicy(settings);
      if (!policy.enabled || policy.legalHold) return;
      if (leaderCheck && !leaderCheck()) return;
      const state = stmts.state.get();
      const next = Number(state?.next_run_at) || computeNextRunAt(policy);
      if (Date.now() < next) return;
      runRetention({ trigger: 'scheduled', actor: 'scheduler' });
    } catch (e) {
      logEvent('error', 'retention_scheduler_error', { message: e?.message, code: e?.code });
    }
  };
  schedulerTimer = setInterval(tick, 60000);
  if (schedulerTimer.unref) schedulerTimer.unref();
  schedulerTick = setTimeout(tick, 8000);
  if (schedulerTick.unref) schedulerTick.unref();
  logEvent('info', 'retention_scheduler_started', { owner: OWNER });
  return schedulerTimer;
}

export function stopRetentionScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (schedulerTick) clearTimeout(schedulerTick);
  schedulerTimer = null;
  schedulerTick = null;
  leaderCheck = null;
}

/** وضعیت کامل برای API/UI؛ هیچ مقدار حساسی ندارد */
export function retentionStatus() {
  const policy = retentionPolicy();
  const state = stmts.state.get() || {};
  const runs = stmts.lastRuns.all(10).map((r) => ({
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    trigger: r.trigger,
    actor: r.actor,
    dryRun: Boolean(r.dry_run),
    status: r.status,
    stage: r.stage,
    deleted: safeJson(r.deleted),
    deletedRows: r.deleted_rows,
    freedBytes: r.freed_bytes,
    batches: r.batches,
    durationMs: r.duration_ms,
    error: r.error,
  }));
  return {
    owner: OWNER,
    running,
    stopRequested: abortRequested,
    policy,
    lock: {
      owner: state.lock_owner || null,
      expiresAt: state.lock_expires_at || 0,
      heldByThisProcess: state.lock_owner === OWNER,
    },
    lastRun: runs[0] || null,
    runs,
    nextRunAt: Number(state.next_run_at) || computeNextRunAt(policy),
    lastStatus: state.last_status || 'never',
    lastDeletedRows: state.last_deleted_rows || 0,
    lastFreedBytes: state.last_freed_bytes || 0,
    storage: storageStats(),
  };
}

function safeJson(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

/** علامت‌گذاری اجراهای نیمه‌کارهٔ قبلی در راه‌اندازی */
export function markInterruptedRetentionRuns() {
  try {
    const n = stmts.interruptStale.run(Date.now()).changes;
    if (n) logEvent('warn', 'retention_runs_interrupted', { count: n });
    return n;
  } catch {
    return 0;
  }
}

export default {
  runRetention,
  retentionPolicy,
  retentionStatus,
  requestRetentionStop,
  startRetentionScheduler,
  stopRetentionScheduler,
  markInterruptedRetentionRuns,
  computeNextRunAt,
};
