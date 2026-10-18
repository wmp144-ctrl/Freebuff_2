/**
 * آزمون کارایی (EXPLAIN QUERY PLAN) و بازبینی SQL Injection.
 *
 * معیار پذیرش:
 *   • پرس‌وجوهای داغ روی جدول‌های بزرگ پیمایش کامل (SCAN بدون INDEX) نداشته باشند
 *   • هیچ ورودی کاربر مستقیماً در متن SQL درج نشود؛ همهٔ درج‌های داینامیک از
 *     فهرست بسته‌ٔ داخلی می‌آیند و مقادیر همیشه پارامترند
 *   • تلاش تزریق از طریق فیلترها/مرتب‌سازی/شناسه‌ها بی‌اثر باشد
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDataDir, cleanupDir, addDevice, ROOT } from '../helpers.mjs';

const dir = useTempDataDir('db-plan');
const { db, checkDatabaseHealth } = await import('../../db.js');
const { parseListQuery, buildDeviceWhere } = await import('../../store.js');

for (let i = 0; i < 20; i++) addDevice(db, { name: `plan-${i}`, ip: `10.90.0.${i + 1}`, status: i % 3 ? 'online' : 'offline' });

/** پرس‌وجوهای داغ برنامه (همان فهرست db:doctor) */
const hotQueries = [
  {
    name: 'due-devices',
    sql: `SELECT id, ip FROM devices WHERE enabled = 1 AND monitoring_enabled = 1 AND next_check_at <= ? LIMIT ?`,
    params: [Date.now(), 100],
    big: ['devices'],
  },
  {
    name: 'samples-series',
    sql: `SELECT (ts / ?) * ? AS bucket, COUNT(*) AS c FROM samples WHERE device_id = ? AND ts >= ? GROUP BY bucket ORDER BY bucket`,
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
    name: 'alerts-duplicate',
    sql: 'SELECT id FROM alerts WHERE duplicate_key = ? ORDER BY created_at DESC LIMIT 1',
    params: ['offline:1:0'],
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
           SELECT o.rowid FROM outages o WHERE o.open = 0 AND o.started_at < ?
             AND NOT EXISTS (SELECT 1 FROM maintenance_records m WHERE m.outage_id = o.id) LIMIT ?)`,
    params: [0, 5000],
    big: ['outages'],
  },
  {
    name: 'maintenance-by-outage',
    sql: 'SELECT id FROM maintenance_records WHERE outage_id = ?',
    params: [1],
    big: ['maintenance_records'],
  },
  {
    name: 'sessions-by-expiry',
    sql: 'DELETE FROM sessions WHERE expires_at <= ?',
    params: [0],
    big: ['sessions'],
  },
];

test('hot queries use indexes instead of full table scans', () => {
  const problems = [];
  for (const query of hotQueries) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params).map((r) => String(r.detail));
    for (const step of plan) {
      for (const table of query.big) {
        if (new RegExp(`^SCAN ${table}\\b`).test(step) && !/USING\s+(COVERING\s+)?INDEX/i.test(step)) {
          problems.push(`${query.name}: ${step}`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], `پیمایش کامل جدول بزرگ:\n${problems.join('\n')}`);
});

test('required indexes exist in the schema', () => {
  const names = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='index'").all().map((r) => r.name));
  for (const index of [
    'idx_samples_device_ts',
    'idx_samples_ts',
    'idx_samples_device_ok',
    'idx_outages_device',
    'idx_outages_open',
    'idx_outages_closed_started',
    'idx_alerts_duplicate',
    'idx_alerts_status',
    'idx_maint_outage',
    'idx_devices_due',
    'idx_audit_ts',
    'idx_sessions_expires',
  ]) {
    assert.ok(names.has(index), `ایندکس ${index} ساخته نشده است`);
  }
});

test('indexes survive a full health check with no foreign key violations', () => {
  const health = checkDatabaseHealth({ full: true });
  assert.equal(health.ok, true, health.errors.join(' | '));
  assert.equal(health.foreignKeyViolations, 0);
});

test('injection attempts through filters are treated as data, never as SQL', () => {
  const attacks = ["x' OR 1=1 --", "'; DROP TABLE devices; --", '1; DELETE FROM devices', "%' UNION SELECT password_hash FROM users --"];
  for (const attack of attacks) {
    const filters = parseListQuery({ search: attack, status: attack, sort: attack, order: attack, group: attack, tag: attack });
    const { clause, params } = buildDeviceWhere(filters);
    assert.ok(!clause.includes('DROP') && !clause.includes('UNION') && !clause.includes('--'), 'متن تزریق نباید در SQL ظاهر شود');
    assert.ok(params.includes(attack) || params.some((p) => String(p).includes(attack)), 'مقدار باید پارامتر باشد');

    const count = db.prepare(`SELECT COUNT(*) AS c FROM devices d LEFT JOIN groups g ON g.id = d.group_id ${clause}`).get(...params).c;
    assert.equal(count, 0, 'فیلتر تزریقی نباید ردیفی برگرداند');
    assert.ok(db.prepare("SELECT COUNT(*) AS c FROM sqlite_schema WHERE name='devices'").get().c === 1, 'جدول‌ها باید سالم بمانند');
  }
  // sort نامعتبر باید به مقدار پیش‌فرض برگردد
  assert.equal(parseListQuery({ sort: 'name; DROP TABLE devices' }).sort, 'name');
  assert.equal(parseListQuery({ order: 'DESC; DELETE FROM devices' }).order, 'ASC');
});

test('source audit: every dynamic SQL interpolation comes from a closed internal set', () => {
  const files = [];
  const walk = (p) => {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      if (entry.name === 'tests' || entry.name === 'node_modules') continue;
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|js)$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(ROOT, 'server'));

  // الگوهای مجاز: نام متغیرهای داخلی که یا placeholder می‌سازند یا از فهرست بسته‌اند
  const allowed = new Set([
    'clause',
    'f.clause', // reports.js: فقط شروط ثابت + placeholder
    'placeholders', // daily.js: ? placeholder
    'ph',
    'ph2',
    'orderCol',
    'filters.order',
    "cols.join(',')",
    "cols.map(() => '?').join(',')",
    "sets.join(', ')",
    "where.join(' AND ')",
    'table', // backup.js: فقط نام جدول‌های ثابت داخلی
    't', // db.js: نام جدول ثابت در PRAGMA table_info
    'pragma',
    'safe', // db.js: حالت checkpoint از فهرست بسته
    'index',
  ]);
  const sqlKeyword = /\b(SELECT|INSERT INTO|UPDATE\s|DELETE FROM|PRAGMA|CREATE TABLE|CREATE INDEX|CREATE UNIQUE|ALTER TABLE|VACUUM INTO)\b/i;
  const offenders = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    // فقط محتوای string templateها بررسی می‌شود؛ نه کامنت‌ها و متن‌های دیگر
    for (const block of text.matchAll(/`([^`]*)`/gs)) {
      const body = block[1];
      if (!sqlKeyword.test(body)) continue;
      const line = text.slice(0, block.index).split('\n').length;
      for (const m of body.matchAll(/\$\{([^}]+)\}/g)) {
        const expr = m[1].trim();
        if (expr.includes('?')) continue;
        if (allowed.has(expr)) continue;
        // شناسه‌ای که با assertSqlIdentifier اعتبارسنجی شده است
        if (/^assertSqlIdentifier\(/.test(expr)) continue;
        if (/^[\w.]+\s*\.\s*map\([^)]*\)\s*\.\s*join\(/.test(expr)) continue;
        if (/\.join\(\s*['"][,'\s]+['"]\s*\)\s*$/.test(expr)) continue;
        if (/^[A-Z][A-Z0-9_]*$/.test(expr)) continue; // ثابت‌های ماژول
        offenders.push(`${path.relative(ROOT, file)}:${line} → \${${expr}}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `درج داینامیک خارج از فهرست مجاز:\n${offenders.join('\n')}`);
});

after(() => {
  db.close();
  cleanupDir(dir);
});
