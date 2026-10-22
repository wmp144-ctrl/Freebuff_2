/**
 * ورود CSV — پارس استاندارد فیلدهای نقل‌قولی (BUG-18)
 * ----------------------------------------------------------------
 * پیش‌تر شمارش ردیف/ستون با شمردن خط و ویرگول انجام می‌شد و فایل معتبری که در
 * یادداشت آن ویرگول یا خط جدید بود رد می‌شد. این آزمون هم گارد (file-guard) و
 * هم پارس واقعی (SheetJS) را روی همان محتوا می‌سنجد.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBuffer } from '../../impexp.js';
import { inspectCsv } from '../../file-guard.js';

const CSV =
  'name,ip,notes\r\n' +
  '"router, core",10.0.0.1,"خط اول\nخط دوم"\r\n' +
  '"switch ""A""",10.0.0.2,ok\r\n';

test('quoted CSV fields are counted and parsed without corruption', () => {
  const buffer = Buffer.from(CSV, 'utf8');
  const shape = inspectCsv(buffer, { maxRows: 2, maxColumns: 3 });
  assert.equal(shape.rows, 2);
  assert.equal(shape.columns, 3);

  const parsed = parseBuffer(buffer, 'devices.csv');
  assert.deepEqual(parsed.keys.slice(0, 3), ['name', 'ip', 'notes']);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].name, 'router, core');
  assert.equal(parsed.rows[0].ip, '10.0.0.1');
  assert.equal(parsed.rows[0].notes, 'خط اول\nخط دوم');
  assert.equal(parsed.rows[1].name, 'switch "A"');
  assert.equal(parsed.rows[1].ip, '10.0.0.2');
});

test('quoted commas do not add columns, but real extra columns are still capped', () => {
  // ویرگول داخل نقل‌قول بخشی از همان فیلد است: دو ستون، نه پنج.
  const quotedOnly = 'c1,c2\r\n"a,b,c,d",x\r\n';
  assert.equal(inspectCsv(Buffer.from(quotedOnly, 'utf8'), { maxColumns: 2 }).columns, 2);

  // سه فیلد واقعی باید با سقف دو رد شود.
  const wide = 'c1,c2\r\n"a,b",x,y\r\n';
  assert.throws(
    () => inspectCsv(Buffer.from(wide, 'utf8'), { maxColumns: 2 }),
    (error) => error.status === 400 && /ستون/.test(error.message)
  );
});
