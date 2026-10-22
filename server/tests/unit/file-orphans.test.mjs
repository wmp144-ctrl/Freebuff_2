/**
 * فایل‌های پیوست و MBTiles — سازگاری فایل و پایگاه‌داده (BUG-19)
 * ----------------------------------------------------------------
 * عملیات حذف باید دو مرحله‌ای باشد تا نه «رکورد بدون فایل» بماند و نه «فایل
 * یتیم»؛ و در شروع سرور هر فایل یتیمِ قدیمی پاک شود.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDataDir, cleanupDir } from '../helpers.mjs';

const dir = useTempDataDir('file-orphans');
const attachments = await import('../../attachments.js');
const mbtiles = await import('../../mbtiles.js');

const HOUR = 3600 * 1000;

after(() => {
  cleanupDir(dir);
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function age(pathname, ms) {
  const t = (Date.now() - ms) / 1000;
  fs.utimesSync(pathname, t, t);
}

test('attachment removal is staged: DB failure can restore the file', () => {
  attachments.ensureAttachmentsDir();
  const written = attachments.writeAttachmentFile(PNG, attachments.ALLOWED_TYPES.png);
  const original = path.join(attachments.ATTACHMENTS_DIR, written.storedName);
  assert.ok(fs.existsSync(original));

  const staged = attachments.stageAttachmentRemoval(written.storedName);
  assert.equal(fs.existsSync(original), false, 'فایل اصلی موقتاً برداشته می‌شود');
  assert.ok(staged.trash && fs.existsSync(staged.trash));

  // سناریوی شکست حذف رکورد: فایل باید برگردد.
  assert.equal(staged.restore(), true);
  assert.ok(fs.existsSync(original), 'فایل پس از خطای DB بازگردانده می‌شود');

  const second = attachments.stageAttachmentRemoval(written.storedName);
  assert.equal(second.commit(), true);
  assert.equal(fs.existsSync(original), false);
  assert.equal(fs.existsSync(second.trash), false);
});

test('attachment sweep deletes only old unreferenced files and trash leftovers', () => {
  attachments.ensureAttachmentsDir();
  const referenced = attachments.writeAttachmentFile(PNG, attachments.ALLOWED_TYPES.png);
  const orphan = attachments.writeAttachmentFile(PNG, attachments.ALLOWED_TYPES.png);
  const fresh = attachments.writeAttachmentFile(PNG, attachments.ALLOWED_TYPES.png);

  const p = (name) => path.join(attachments.ATTACHMENTS_DIR, name);
  age(p(orphan.storedName), 2 * HOUR);
  const trash = path.join(attachments.ATTACHMENTS_DIR, '.trash-test-leftover.png');
  fs.writeFileSync(trash, PNG);
  age(trash, 2 * HOUR);

  const result = attachments.sweepAttachmentOrphans({
    referenced: [referenced.storedName, 'missing-but-referenced.png'],
    now: Date.now(),
  });
  assert.equal(result.removedFiles, 1, 'فقط فایل یتیمِ قدیمی حذف شود');
  assert.equal(result.trashed, 1, 'باقی‌ماندهٔ .trash پاک شود');
  assert.equal(result.missingFiles, 1, 'رکورد بدون فایل فقط گزارش می‌شود');
  assert.ok(fs.existsSync(p(referenced.storedName)), 'فایل مرجع‌دار باید بماند');
  assert.ok(fs.existsSync(p(fresh.storedName)), 'فایل تازه نباید حذف شود');
  assert.equal(fs.existsSync(p(orphan.storedName)), false);
  assert.equal(fs.existsSync(trash), false);
});

test('mbtiles sweep deletes only old unreferenced map files', () => {
  fs.mkdirSync(mbtiles.MBTILES_DIR, { recursive: true });
  const referenced = path.join(mbtiles.MBTILES_DIR, 'kept.mbtiles');
  const orphan = path.join(mbtiles.MBTILES_DIR, 'orphan.mbtiles');
  const fresh = path.join(mbtiles.MBTILES_DIR, 'fresh.mbtiles');
  for (const file of [referenced, orphan, fresh]) fs.writeFileSync(file, Buffer.from('SQLite format 3\0'));
  age(orphan, 2 * HOUR);

  const result = mbtiles.sweepOrphanFiles({ referenced: ['kept.mbtiles', 'gone.mbtiles'], now: Date.now() });
  assert.equal(result.removed, 1);
  assert.equal(result.missing, 1);
  assert.ok(fs.existsSync(referenced), 'فایل لایهٔ موجود باید بماند');
  assert.equal(fs.existsSync(orphan), false);
  assert.ok(fs.existsSync(fresh), 'فایل تازه دست‌نخورده می‌ماند');
});
