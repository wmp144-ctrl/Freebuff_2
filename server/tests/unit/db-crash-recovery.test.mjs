/**
 * آزمون بازیابی پس از قطع ناگهانی فرآیند (Crash Recovery).
 *
 * دو سناریو:
 *   ۱) کشتن فرآیند در میانهٔ نوشتن‌های پیوسته → پایگاه‌داده باید سالم باز شود و
 *      همهٔ تراکنش‌های تأییدشده باقی بمانند.
 *   ۲) کشتن فرآیند داخل یک تراکنش چندمرحله‌ای → هیچ رکورد ناقصی نباید باقی بماند
 *      (SQLite با WAL تراکنش تأییدنشده را برمی‌گرداند).
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { useTempDataDir, cleanupDir, ROOT } from '../helpers.mjs';

const dir = useTempDataDir('db-crash');
const DB = path.join(dir, 'crash.db');
// فرآیند والد و فرزندها باید دقیقاً به یک فایل پایگاه‌داده اشاره کنند.
process.env.NETWATCH_DB = DB;
const env = { ...process.env, NETWATCH_DATA_DIR: dir, NETWATCH_DB: DB };
const { db, checkDatabaseHealth, DB_PATH } = await import('../../db.js');
assert.equal(DB_PATH, DB);

/** اجرای یک فرآیند فرزند، انتظار برای یک نشانه روی stdout و سپس kill -9 */
function spawnUntil(signal, script, { killAfterSignal = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let killed = false;
    const timeout = setTimeout(() => {
      if (!killed) child.kill('SIGKILL');
      reject(new Error(`مهلت اجرای فرزند تمام شد. stdout=${out} stderr=${err}`));
    }, 30000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (!killed && out.includes(signal)) {
        killed = true;
        setTimeout(() => child.kill('SIGKILL'), killAfterSignal);
      }
    });
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('exit', (code, sig) => {
      clearTimeout(timeout);
      if (!killed) return reject(new Error(`فرآیند فرزند پیش از نشانهٔ ${signal} تمام شد (code=${code}): ${err}`));
      resolve({ code, sig, out, err });
    });
    child.on('error', reject);
  });
}

const scriptHeader = `
  const { db, transaction } = await import(${JSON.stringify(path.join(ROOT, 'server', 'db.js'))});
  db.exec('CREATE TABLE IF NOT EXISTS crash_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL, ts INTEGER NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS crash_probe_b (id INTEGER PRIMARY KEY AUTOINCREMENT, ref INTEGER NOT NULL, note TEXT NOT NULL)');
`;

test('SIGKILL during a stream of writes leaves a healthy database with committed rows intact', async () => {
  await spawnUntil(
    'WRITING',
    `
      ${scriptHeader}
      const stmt = db.prepare('INSERT INTO crash_probe(note, ts) VALUES (?,?)');
      let i = 0;
      process.stdout.write('WRITING\\n');
      // نوشتن پیوسته تا زمانی که والد فرآیند را بکشد
      const timer = setInterval(() => {
        for (let k = 0; k < 20; k++) { stmt.run('row-' + (++i), Date.now()); }
      }, 1);
      timer.ref();
      setInterval(() => {}, 1000);
    `,
    { killAfterSignal: 250 }
  );

  const health = checkDatabaseHealth({ full: true });
  assert.equal(health.ok, true, `پایگاه‌داده پس از kill -9 باید سالم باشد: ${health.errors.join(' | ')}`);
  assert.equal(health.foreignKeyViolations, 0);
  const rows = db.prepare("SELECT COUNT(*) AS c FROM crash_probe WHERE note LIKE 'row-%'").get().c;
  assert.ok(rows > 0, 'تراکنش‌های تأییدشده باید باقی بمانند');
  // هیچ ردیف ناقصی نباید وجود داشته باشد (note و ts هر دو پر هستند)
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM crash_probe WHERE note IS NULL OR ts IS NULL').get().c, 0);
});

test('SIGKILL inside a multi-step transaction rolls the whole operation back', async () => {
  const rowsBefore = db.prepare('SELECT COUNT(*) AS c FROM crash_probe').get().c;
  const bBefore = db.prepare('SELECT COUNT(*) AS c FROM crash_probe_b').get().c;

  await spawnUntil(
    'IN_TX',
    `
      ${scriptHeader}
      // هر سه مرحله داخل یک تراکنش واحد هستند؛ قتل فرآیند نباید هیچ‌کدام را باقی بگذارد.
      transaction(() => {
        const ref = db.prepare('INSERT INTO crash_probe(note, ts) VALUES (?,?)').run('tx-row', Date.now()).lastInsertRowid;
        db.prepare('INSERT INTO crash_probe_b(ref, note) VALUES (?,?)').run(Number(ref), 'tx-child');
        db.prepare('UPDATE crash_probe SET note = ? WHERE id = ?').run('tx-mutated', Number(ref));
        process.stdout.write('IN_TX\\n');
        // نگه‌داشتن تراکنش باز تا زمان kill شدن فرآیند
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
      });
    `,
    { killAfterSignal: 200 }
  );

  // تراکنش تأییدنشده باید برگردد: نه ردیف A، نه B و نه تغییر note
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM crash_probe').get().c, rowsBefore, 'ردیف‌های تراکنش باز نباید باقی بمانند');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM crash_probe_b').get().c, bBefore);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM crash_probe WHERE note IN ('tx-row','tx-mutated')").get().c, 0);

  const health = checkDatabaseHealth({ full: true });
  assert.equal(health.ok, true, health.errors.join(' | '));
});

test('writes continue normally after a crash (WAL replay works)', () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM crash_probe').get().c;
  db.prepare('INSERT INTO crash_probe(note, ts) VALUES (?,?)').run('after-crash', Date.now());
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM crash_probe').get().c, before + 1);
  assert.ok(db.prepare("SELECT id FROM crash_probe WHERE note='after-crash'").get());
  assert.equal(checkDatabaseHealth().ok, true);
});

after(() => {
  db.close();
  cleanupDir(dir);
});
