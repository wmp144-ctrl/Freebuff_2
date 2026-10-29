/**
 * Retention — کنترل رشد جدول‌های تاریخی (BUG-23)
 * ----------------------------------------------------------------
 * `retention_runs` پیش‌تر هیچ سیاستی نداشت و در بهره‌برداری طولانی‌مدت بی‌مرز
 * رشد می‌کرد. این آزمون تضمین می‌کند فقط ۵۰۰ اجرای آخر نگه داشته می‌شود و
 * ردیف running هرگز حذف نمی‌شود.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir } from '../helpers.mjs';

const dir = useTempDataDir('retention-growth');
const { db, setSettings } = await import('../../db.js');
const { runRetention } = await import('../../retention.js');

after(() => {
  db.close();
  cleanupDir(dir);
});

const NOW = Date.now();

setSettings({
  retention_enabled: true,
  retention_legal_hold: false,
  samples_retention_days: 10,
  outages_retention_days: 365,
  alerts_retention_days: 180,
  daily_stats_retention_days: 365,
  audit_retention_days: 365,
  engine_log_retention_days: 30,
  retention_batch_size: 200,
  retention_max_rows_per_run: 100000,
  retention_prune_backups: false,
});

const count = (sql, ...args) => db.prepare(sql).get(...args).c;

test('retention keeps only the newest run history and never drops a running row', () => {
  db.prepare('DELETE FROM retention_runs').run();
  const insert = db.prepare(
    `INSERT INTO retention_runs(started_at, trigger, status, stage, deleted, policy)
     VALUES (?, 'manual', 'completed', 'done', '{}', '{}')`
  );
  for (let i = 0; i < 620; i++) insert.run(NOW - (700 - i) * 60000);
  const running = Number(
    db
      .prepare("INSERT INTO retention_runs(started_at, trigger, status, stage) VALUES (?, 'manual', 'running', 'samples')")
      .run(NOW - 1000).lastInsertRowid
  );

  const result = runRetention({ trigger: 'manual' });
  assert.equal(result.status, 'completed');
  assert.ok(result.deleted.retention_runs > 0, 'تاریخچهٔ قدیمی باید هرس شود');
  assert.equal(count("SELECT COUNT(*) AS c FROM retention_runs WHERE status <> 'running'"), 500, 'فقط ۵۰۰ اجرای آخر می‌ماند');
  assert.ok(db.prepare('SELECT id FROM retention_runs WHERE id = ?').get(running), 'ردیف running هرگز حذف نمی‌شود');
});

