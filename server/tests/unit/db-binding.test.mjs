/**
 * آزمون اصلاح خطاهای SQLite Binding.
 *
 * معیار پذیرش:
 *   • Boolean → 0/1، undefined → NULL، NaN/Infinity → NULL، Date → epoch ms
 *   • هیچ «Provided value cannot be bound» رخ ندهد
 *   • دادهٔ ناسازگار (شیء/آرایه/پارامتر نام‌دار) با خطای روشن رد شود
 *   • ثبت هم‌زمان دو فرآیند روی یک پایگاه‌داده بدون خطا و بدون گم‌شدن داده
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { useTempDataDir, cleanupDir, ROOT } from '../helpers.mjs';

const dir = useTempDataDir('db-bind');
const { db, DB_PATH } = await import('../../db.js');
const { classifyDbError, DB_ERROR_CODES } = await import('../../db-errors.js');
const { normalizeBindValue } = await import('../../db-safety.js');

db.exec('CREATE TABLE IF NOT EXISTS bind_probe (id INTEGER PRIMARY KEY, flag INTEGER, note TEXT, amount REAL)');

test('booleans are stored as 0/1 and undefined/NaN never reach SQLite as broken values', () => {
  db.prepare('DELETE FROM bind_probe').run();
  db.prepare('INSERT INTO bind_probe(flag, note, amount) VALUES (?,?,?)').run(true, 'undef-below', 1.5);
  db.prepare('INSERT INTO bind_probe(flag, note, amount) VALUES (?,?,?)').run(false, undefined, NaN);
  db.prepare('INSERT INTO bind_probe(flag, note, amount) VALUES (?,?,?)').run(1, 'inf', Infinity);

  const rows = db.prepare('SELECT flag, note, amount FROM bind_probe ORDER BY id').all();
  assert.equal(rows[0].flag, 1);
  assert.equal(rows[1].flag, 0);
  assert.equal(rows[1].note, null, 'undefined باید NULL شود');
  assert.equal(rows[1].amount, null, 'NaN باید NULL شود نه مقدار خراب');
  assert.equal(rows[2].amount, null, 'Infinity باید NULL شود');
});

test('every value type used by the application binds without throwing', () => {
  db.prepare('DELETE FROM bind_probe').run();
  const now = Date.now();
  const cases = [
    ['string', 'متن فارسی'],
    ['empty string', ''],
    ['integer', 42],
    ['float', 3.25],
    ['negative', -7],
    ['bigint', 123456789n],
    ['null', null],
    ['boolean true', true],
    ['boolean false', false],
    ['Date', new Date(now)],
    ['Buffer', Buffer.from([1, 2, 3])],
    ['Uint8Array', new Uint8Array([4, 5])],
    ['undefined', undefined],
    ['NaN', NaN],
  ];
  for (const [label, value] of cases) {
    assert.doesNotThrow(() => db.prepare('SELECT ? AS v').get(value), `بایند ${label} نباید خطا بدهد`);
  }
  const dateRow = db.prepare('SELECT ? AS v').get(new Date(now));
  assert.equal(dateRow.v, now, 'Date باید به epoch ms تبدیل شود');
  assert.equal(db.prepare('SELECT ? AS v').get(true).v, 1);
  assert.equal(db.prepare('SELECT ? AS v').get(undefined).v, null);
});

test('incompatible values fail with a clear binding error instead of silent corruption', () => {
  // bigint بیرون از محدودهٔ امن درایور را در زمان خواندن می‌شکند، پس همان زمان
  // نوشتن با خطای روشن رد می‌شود.
  assert.throws(() => db.prepare('SELECT ? AS v').get(9007199254740993n), (e) => e.code === 'DB_BINDING');
  for (const bad of [{ a: 1 }, [1, 2], () => 1, Symbol('x')]) {
    assert.throws(
      () => db.prepare('SELECT ? AS v').get(bad),
      (e) => e.code === 'DB_BINDING',
      `مقدار ${String(bad)} باید خطای DB_BINDING بدهد`
    );
  }
  // پارامتر نام‌دار پشتیبانی نمی‌شود و باید پیام روشن بدهد
  assert.throws(() => db.prepare('SELECT ? AS v').get({ $v: 1 }), (e) => e.code === 'DB_BINDING');
});

test('normalizeBindValue is the single choke point for coercions', () => {
  assert.equal(normalizeBindValue(true), 1);
  assert.equal(normalizeBindValue(false), 0);
  assert.equal(normalizeBindValue(undefined), null);
  assert.equal(normalizeBindValue(NaN), null);
  assert.equal(normalizeBindValue(-Infinity), null);
  assert.equal(normalizeBindValue(new Date(1234)), 1234);
  assert.equal(normalizeBindValue('x'), 'x');
});

test('NOT NULL guard: a NaN value is rejected by the schema instead of stored as NULL', () => {
  db.exec('CREATE TABLE IF NOT EXISTS bind_strict (id INTEGER PRIMARY KEY, required INTEGER NOT NULL)');
  assert.throws(
    () => db.prepare('INSERT INTO bind_strict(required) VALUES (?)').run(NaN),
    (e) => classifyDbError(e) === DB_ERROR_CODES.CONSTRAINT
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM bind_strict').get().c, 0);
});

test('two processes writing at the same time keep every row (no lost update)', async () => {
  const WRITES_PER_PROCESS = 250;
  const script = `
    const { db } = await import(${JSON.stringify(path.join(ROOT, 'server', 'db.js'))});
    db.exec('CREATE TABLE IF NOT EXISTS bind_probe (id INTEGER PRIMARY KEY, flag INTEGER, note TEXT, amount REAL)');
    let i = 0;
    const stmt = db.prepare('INSERT INTO bind_probe(flag, note, amount) VALUES (?,?,?)');
    const timer = setInterval(() => {
      for (let k = 0; k < 25; k++) { stmt.run(true, 'child', ${WRITES_PER_PROCESS}); i++; }
      if (i >= ${WRITES_PER_PROCESS}) { clearInterval(timer); db.close(); }
    }, 2);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    env: { ...process.env, NETWATCH_DATA_DIR: dir, NETWATCH_DB: DB_PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childLogs = '';
  child.stdout.on('data', (d) => (childLogs += d));
  child.stderr.on('data', (d) => (childLogs += d));

  db.prepare('DELETE FROM bind_probe').run();
  const parentStmt = db.prepare('INSERT INTO bind_probe(flag, note, amount) VALUES (?,?,?)');
  let parentWritten = 0;
  const started = Date.now();
  while (parentWritten < WRITES_PER_PROCESS && Date.now() - started < 30000) {
    try {
      parentStmt.run(false, 'parent', parentWritten % 10);
      parentWritten++;
    } catch (e) {
      // SQLITE_BUSY باید با busy_timeout مدیریت شود؛ بروز خطای BUSY خودش باگ است
      throw new Error(`نوشتن هم‌زمان ناموفق بود: ${e.code} ${e.message}`, { cause: e });
    }
  }
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`فرآیند فرزند پایان نیافت:\n${childLogs}`)), 30000);
    child.on('exit', (code) => {
      clearTimeout(t);
      if (code === 0) resolve();
      else reject(new Error(`فرآیند فرزند با کد ${code} تمام شد:\n${childLogs}`));
    });
  });

  const childWritten = db.prepare("SELECT COUNT(*) AS c FROM bind_probe WHERE note='child'").get().c;
  const parentSaved = db.prepare("SELECT COUNT(*) AS c FROM bind_probe WHERE note='parent'").get().c;
  assert.equal(parentWritten, WRITES_PER_PROCESS);
  assert.equal(childWritten, WRITES_PER_PROCESS, 'هیچ نوشتنی از فرآیند فرزند نباید گم شود');
  assert.equal(parentSaved, WRITES_PER_PROCESS, 'هیچ نوشتنی از فرآیند والد نباید گم شود');
});

after(() => {
  db.close();
  cleanupDir(dir);
});
