/**
 * آزمون واحد گارد محتوای فایل (Phase 3):
 *   • پسوند به‌تنهایی کافی نیست (امضای واقعی ZIP/OLE/UTF-8)
 *   • ZIP Bomb و نسبت فشرده‌سازی غیرعادی رد می‌شود
 *   • مسیر پیمایشی داخل آرشیو و ZIP64 رد می‌شود
 *   • CSV باینری/NUL/غیر UTF-8 رد می‌شود
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isZip,
  isOle,
  inspectZip,
  inspectCsv,
  assertSpreadsheetContent,
} from '../../file-guard.js';

/** ساخت یک آرشیو ZIP حداقلی فقط با دایرکتوری مرکزی (برای آزمون بازرس) */
function makeZip(entries) {
  const local = Buffer.alloc(4);
  local.writeUInt32LE(0x04034b50, 0);
  const centralParts = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(entry.flags ?? 0, 8);
    header.writeUInt16LE(entry.method ?? 8, 10);
    header.writeUInt32LE(entry.compressed ?? 100, 20);
    header.writeUInt32LE(entry.uncompressed ?? 1000, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    centralParts.push(Buffer.concat([header, name]));
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(4, 16);
  return Buffer.concat([local, central, eocd]);
}

const validEntries = [
  { name: '[Content_Types].xml', compressed: 300, uncompressed: 500 },
  { name: 'xl/workbook.xml', compressed: 300, uncompressed: 500 },
];

test('a real ZIP/OLE signature is required for spreadsheet extensions', () => {
  assert.equal(isZip(Buffer.from('PK\u0003\u0004xxx')), true);
  assert.equal(isZip(Buffer.from('not a zip')), false);
  assert.equal(isOle(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), true);
  assert.throws(
    () => assertSpreadsheetContent(Buffer.from('MZ executable'), 'devices.xlsx'),
    (error) => error.status === 400 && /ZIP/.test(error.message)
  );
  assert.throws(
    () => assertSpreadsheetContent(Buffer.from('MZ executable'), 'devices.xls'),
    (error) => error.status === 400 && /OLE/.test(error.message)
  );
  assert.equal(assertSpreadsheetContent(makeZip(validEntries), 'devices.xlsx').kind, 'xlsx');
  assert.equal(
    assertSpreadsheetContent(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), 'legacy.xls').kind,
    'xls'
  );
});

test('a zip bomb with an extreme compression ratio is rejected', () => {
  const bomb = makeZip([
    { name: '[Content_Types].xml', compressed: 50, uncompressed: 10 * 1024 * 1024 },
    { name: 'xl/workbook.xml', compressed: 50, uncompressed: 10 * 1024 * 1024 },
  ]);
  assert.throws(
    () => inspectZip(bomb),
    (error) => error.status === 400 && /ZIP Bomb|فشرده/.test(error.message)
  );
});

test('path traversal, encryption and ZIP64 entries are rejected', () => {
  assert.throws(
    () => inspectZip(makeZip([...validEntries, { name: '../../etc/passwd' }])),
    (error) => error.status === 400 && /مسیر/.test(error.message)
  );
  assert.throws(
    () => inspectZip(makeZip([{ ...validEntries[0], flags: 1 }, validEntries[1]])),
    (error) => error.status === 400 && /رمزنگاری/.test(error.message)
  );
  assert.throws(
    () => inspectZip(makeZip([{ ...validEntries[0], uncompressed: 0xffffffff }, validEntries[1]])),
    (error) => error.status === 400 && /ZIP64/.test(error.message)
  );
  assert.throws(
    () => inspectZip(makeZip([{ name: '[Content_Types].xml' }, { name: 'other/data.xml' }])),
    (error) => error.status === 400 && /Excel/.test(error.message)
  );
});

test('CSV must be valid UTF-8 text without binary payloads', () => {
  assert.equal(inspectCsv(Buffer.from('name,ip\nrouter,10.0.0.1\n')).lines, 2);
  assert.throws(
    () => inspectCsv(Buffer.from('name,ip\nbad,\u0000\n')),
    (error) => error.status === 400 && /NUL|باینری/.test(error.message)
  );
  assert.throws(
    () => inspectCsv(Buffer.from([0xc3, 0x28])),
    (error) => error.status === 400 && /UTF-8/.test(error.message)
  );
  assert.throws(() => inspectCsv(Buffer.alloc(0)), (error) => error.status === 400);
  assert.throws(
    () => assertSpreadsheetContent(makeZip(validEntries), 'renamed.csv'),
    (error) => error.status === 400 && /باینری/.test(error.message)
  );
});

test('column and row caps are enforced before parsing', () => {
  const wide = Buffer.from(`${Array.from({ length: 300 }, (_, i) => `c${i}`).join(',')}\n1\n`);
  assert.throws(
    () => inspectCsv(wide),
    (error) => error.status === 400 && /ستون/.test(error.message)
  );
  const manyRows = Buffer.from(`a\n${'x\n'.repeat(20)}`);
  assert.throws(
    () => inspectCsv(manyRows, { maxRows: 10 }),
    (error) => error.status === 400 && /ردیف/.test(error.message)
  );
});

test('BUG-18: quoted commas, newlines and escaped quotes do not inflate row/column caps', () => {
  const csv =
    'name,notes,ip\r\n' +
    '"router, core","خط اول\nخط دوم",10.0.0.1\r\n' +
    '"switch ""A""",x,10.0.0.2\r\n';
  const shape = inspectCsv(Buffer.from(csv, 'utf8'), { maxRows: 2, maxColumns: 3 });
  assert.equal(shape.rows, 2, 'دو ردیف داده، نه چهار ردیف فیزیکی');
  assert.equal(shape.columns, 3, 'ویرگول داخل نقل‌قول ستون جدید نمی‌سازد');
  assert.equal(shape.lines, 3, 'lines سازگار با نسخهٔ قبل: سرستون + دو ردیف');

  // همان فایل با سقف واقعی‌اش باید بپذیرد اما با سقف کمتر رد شود.
  assert.throws(
    () => inspectCsv(Buffer.from(csv, 'utf8'), { maxRows: 1 }),
    (error) => error.status === 400 && /ردیف/.test(error.message)
  );
  assert.throws(
    () => inspectCsv(Buffer.from(csv, 'utf8'), { maxColumns: 2 }),
    (error) => error.status === 400 && /ستون/.test(error.message)
  );

  // نقل‌قول بسته‌نشده یعنی ساختار خراب، نه ستون‌های بی‌پایان.
  assert.throws(
    () => inspectCsv(Buffer.from('a,b\n"x,1\n')),
    (error) => error.status === 400 && /نقل‌قول|ساختار/.test(error.message)
  );

  // خطوط خالی وسط/پایان فایل ردیف حساب نمی‌شوند.
  const blank = inspectCsv(Buffer.from('a,b\n\n1,2\n\n'), { maxRows: 1 });
  assert.equal(blank.rows, 1);
});
