#!/usr/bin/env node
/**
 * NetWatch — بررسی سلامت و کارایی پایگاه‌داده («دکتر پایگاه‌داده»)
 *
 *   npm run db:doctor
 *
 * کارها:
 *   • integrity_check کامل + foreign_key_check
 *   • وضعیت WAL/Checkpoint/فضای دیسک و سیاست دوام
 *   • حجم جدول‌ها و فهرست ایندکس‌ها
 *   • EXPLAIN QUERY PLAN پرس‌وجوهای داغ: اگر روی جدول بزرگ پیمایش کامل شود،
 *     هشدار می‌دهد (کد خروج ۱). این همان معیار «بهینه‌سازی با EXPLAIN» است.
 */
// خروجی JSON مصرف‌ماشینی است؛ لاگ‌ها به stderr می‌روند.
process.env.NETWATCH_LOG_STREAM = 'stderr';
const { db, checkDatabaseHealth, diskSpace, DB_PATH, SYNC_MODE } = await import('../db.js');
const { backupStatus, listBackups } = await import('../backup.js');

const queries = [
  {
    name: 'due-devices',
    sql: `SELECT id, ip FROM devices
          WHERE enabled = 1 AND monitoring_enabled = 1 AND next_check_at <= ?
          ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END
          LIMIT ?`,
    params: [Date.now(), 100],
    big: ['devices'],
  },
  {
    name: 'samples-series',
    sql: `SELECT (ts / ?) * ? AS bucket, COUNT(*) AS samples, SUM(ok) AS ok_count
          FROM samples WHERE device_id = ? AND ts >= ?
          GROUP BY bucket ORDER BY bucket ASC`,
    params: [60000, 60000, 1, 0],
    big: ['samples'],
  },
  {
    name: 'samples-ok-count',
    sql: 'SELECT COUNT(*) AS c FROM samples WHERE device_id = ? AND ok = 1',
    params: [1],
    big: ['samples'],
  },
  {
    name: 'outages-device',
    sql: 'SELECT * FROM outages WHERE device_id = ? ORDER BY started_at DESC LIMIT ?',
    params: [1, 100],
    big: ['outages'],
  },
  {
    name: 'outage-open',
    sql: 'SELECT id FROM outages WHERE device_id = ? AND open = 1 ORDER BY started_at DESC LIMIT 1',
    params: [1],
    big: ['outages'],
  },
  {
    name: 'alerts-recent-duplicate',
    sql: 'SELECT id, created_at FROM alerts WHERE duplicate_key = ? ORDER BY created_at DESC LIMIT 1',
    params: ['offline:1:0'],
    big: ['alerts'],
  },
  {
    name: 'alerts-active',
    sql: "SELECT * FROM alerts WHERE status = 'active' ORDER BY created_at DESC LIMIT 25",
    params: [],
    big: ['alerts'],
  },
  {
    name: 'prune-samples',
    sql: 'DELETE FROM samples WHERE rowid IN (SELECT rowid FROM samples WHERE ts < ? LIMIT ?)',
    params: [0, 5000],
    big: ['samples'],
  },
  {
    name: 'prune-outages',
    sql: `DELETE FROM outages WHERE rowid IN (
            SELECT rowid FROM outages o WHERE o.open = 0 AND o.started_at < ?
              AND NOT EXISTS (SELECT 1 FROM maintenance_records m WHERE m.outage_id = o.id)
            LIMIT ?)`,
    params: [0, 5000],
    big: ['outages'],
  },
  {
    name: 'sessions-by-expiry',
    sql: 'DELETE FROM sessions WHERE expires_at <= ?',
    params: [0],
    big: ['sessions'],
  },
  {
    name: 'audit-list',
    sql: 'SELECT * FROM audit_log ORDER BY ts DESC LIMIT 50',
    params: [],
    big: ['audit_log'],
  },
  {
    name: 'daily-stats-range',
    sql: 'SELECT device_id, day, checks, failed FROM daily_stats WHERE day >= ? AND day < ?',
    params: ['2000-01-01', '2100-01-01'],
    big: ['daily_stats'],
  },
  {
    name: 'maintenance-by-outage',
    sql: 'SELECT id FROM maintenance_records WHERE outage_id = ?',
    params: [1],
    big: ['maintenance_records'],
  },
];

function planFor(query) {
  try {
    const rows = db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params);
    return rows.map((r) => String(r.detail ?? ''));
  } catch (e) {
    return [`ERROR: ${e.message}`];
  }
}

function fullScanWarnings(query, plan) {
  const warnings = [];
  for (const step of plan) {
    for (const table of query.big) {
      // پیمایش کامل جدول بزرگ بدون ایندکس
      const re = new RegExp(`^SCAN ${table}\\b`);
      if (re.test(step) && !/USING\s+(COVERING\s+)?INDEX/i.test(step)) {
        warnings.push(`${query.name}: ${step}`);
      }
    }
  }
  return warnings;
}

const health = checkDatabaseHealth({ full: true });
const tables = db
  .prepare(
    `SELECT name,
            (SELECT COUNT(*) FROM sqlite_schema s2 WHERE s2.type='table' AND s2.name = s.name) AS dummy
     FROM sqlite_schema s WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  )
  .all()
  .map((r) => r.name);

const sizes = [];
for (const t of tables) {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS rows FROM ${t}`).get();
    sizes.push({ table: t, rows: row.rows });
  } catch {
    /* جدول مجازی */
  }
}

const indexes = db
  .prepare("SELECT name, tbl_name AS tbl FROM sqlite_schema WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name")
  .all();

const plans = [];
const warnings = [];
for (const query of queries) {
  const plan = planFor(query);
  plans.push({ name: query.name, plan });
  warnings.push(...fullScanWarnings(query, plan));
}

const backups = listBackups();
const output = {
  ok: health.ok && warnings.length === 0,
  db: {
    path: DB_PATH,
    syncMode: SYNC_MODE,
    health,
    wal: db.walInfo(),
    disk: diskSpace(),
    pageSize: db.prepare('PRAGMA page_size').get()?.page_size,
    freePages: db.prepare('PRAGMA freelist_count').get()?.freelist_count,
  },
  sizes,
  indexes,
  plans,
  warnings,
  backups: { ...backupStatus(), items: backups.slice(0, 5) },
};

console.log(JSON.stringify(output, null, 2));
db.close();
process.exit(output.ok ? 0 : 1);
