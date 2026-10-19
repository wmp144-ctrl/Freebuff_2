/**
 * ورودی‌های مخرب و فایل‌های نامعتبر — آزمون یکپارچه روی سرور واقعی.
 *
 * تمرکز: فایل اجرایی/جعلی، صفحه‌گستردهٔ خراب، مسیر پیمایشی در نام فایل،
 * ردیف‌های نامعتبر با فرمول، بدنهٔ JSON با کلید خطرناک و نوع محتوای نادرست.
 * انتظار: رد روشن (۴xx) پیش از نوشتن، بدون ۵۰۰ و بدون باقی‌ماندن فایل ناقص.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDataDir, cleanupDir, startServer, api, upload, sessionFor } from '../helpers.mjs';

const dir = useTempDataDir('malicious');
let srv;

before(async () => {
  srv = await startServer({
    dataDir: dir,
    engine: false,
    env: { NETWATCH_MAX_IMPORT_ROWS: '100' },
  });
});

after(async () => {
  await srv.stop();
  cleanupDir(dir);
});

test('a disallowed file extension is rejected before parsing', async () => {
  const res = await upload(srv.base, '/api/devices/import/preview', {
    filename: 'payload.exe',
    content: 'MZ\u0000\u0000',
    type: 'application/octet-stream',
  });
  assert.equal(res.status, 400);
  assert.match(String(res.data?.error), /xlsx|xls|csv|پسوند/i);
});

test('a fake xlsx that is not a valid archive is rejected without a 500', async () => {
  const res = await upload(srv.base, '/api/devices/import/preview', {
    filename: 'broken.xlsx',
    content: 'PK\u0003\u0004 this is not a real workbook',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  assert.equal(res.status, 400);
  assert.ok(res.data?.error);
});

test('a text file renamed to .mbtiles is rejected and removed from disk', async () => {
  const res = await upload(srv.base, '/api/layers/upload', {
    filename: 'not-a-map.mbtiles',
    content: 'SQLite format 3\u0000 but truncated and invalid',
    type: 'application/octet-stream',
  });
  assert.equal(res.status, 400);
  const leftovers = fs.readdirSync(path.join(dir, 'mbtiles')).filter((f) => f.includes('not-a-map'));
  assert.deepEqual(leftovers, [], 'invalid MBTiles must not stay on disk');
});

test('path traversal in the upload filename cannot escape the data directory', async () => {
  const res = await upload(srv.base, '/api/layers/upload', {
    filename: '../../../../tmp/evil.mbtiles',
    content: 'not sqlite',
    type: 'application/octet-stream',
  });
  assert.equal(res.status, 400);
  assert.equal(fs.existsSync('/tmp/evil.mbtiles'), false);
  const files = await api(srv.base, 'GET', '/api/mbtiles/files');
  assert.deepEqual(files.data.items.filter((f) => f.includes('evil')), []);
});

test('too many imported rows are refused before any write (row cap)', async () => {
  const header = 'نام تجهیز,آدرس IP\n';
  const rows = Array.from({ length: 101 }, (_, i) => `too-many-${i},10.201.${Math.floor(i / 250)}.${(i % 250) + 1}`).join('\n');
  const res = await upload(srv.base, '/api/devices/import/commit', {
    filename: 'too-many.csv',
    content: header + rows,
  });
  assert.equal(res.status, 400);
  assert.match(String(res.data?.error), /حد مجاز|بیش از|row/i);
  const list = await api(srv.base, 'GET', '/api/devices?search=too-many');
  assert.equal(list.data.items.length, 0, 'atomic import must not write a partial batch');
});

test('invalid marker rows are counted as errors and never inserted', async () => {
  const before = await api(srv.base, 'GET', '/api/markers');
  const csv = [
    'نام علامت,نوع علامت,عرض جغرافیایی,طول جغرافیایی',
    ',QA-Type,35.7,51.4', // نام خالی
    'Bad Lat,QA-Type,999,51.4', // عرض خارج از بازه
    'Bad Lng,QA-Type,35.7,-999', // طول خارج از بازه
    'Ok Marker,QA-Type,35.7,51.4',
  ].join('\n');
  const preview = await upload(srv.base, '/api/markers/import/preview', { filename: 'markers.csv', content: csv });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.valid, 1);
  assert.equal(preview.data.invalid, 3);

  const imported = await upload(srv.base, '/api/markers/import', { filename: 'markers.csv', content: csv });
  assert.equal(imported.status, 200);
  assert.equal(imported.data.inserted, 1);
  const after = await api(srv.base, 'GET', '/api/markers');
  assert.equal(after.data.items.length, before.data.items.length + 1);
});

test('CSV formula injection is neutralized in exported cells', async () => {
  const created = await api(srv.base, 'POST', '/api/devices', {
    name: '=HYPERLINK("http://evil.example","x")',
    ip: '10.202.0.1',
  });
  assert.equal(created.status, 201);

  const url = `${srv.base}/api/devices/export?format=csv&search=${encodeURIComponent('HYPERLINK')}`;
  const anonymous = await fetch(url);
  assert.equal(anonymous.status, 401, 'download without a session must be rejected');

  const session = sessionFor(srv.base);
  const exported = await fetch(url, { headers: { cookie: session.cookie } });
  assert.equal(exported.status, 200);
  const text = await exported.text();
  assert.match(text, /'=HYPERLINK/, 'exported formula must be prefixed with an apostrophe');
  assert.doesNotMatch(text, /(^|\n)=HYPERLINK/, 'raw formula must never start a cell');
});

test('prototype-polluting JSON keys and wrong content types are rejected', async () => {
  const session = sessionFor(srv.base);
  const headers = {
    origin: srv.base,
    cookie: session.cookie,
    'x-csrf-token': session.csrf,
  };
  const polluted = await fetch(`${srv.base}/api/devices`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: '{"__proto__":{"isAdmin":true},"name":"x","ip":"10.203.0.1"}',
  });
  assert.equal(polluted.status, 400);

  const wrongType = await fetch(`${srv.base}/api/devices`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'text/plain' },
    body: JSON.stringify({ name: 'x', ip: '10.203.0.2' }),
  });
  assert.equal(wrongType.status, 415);
});

test('deeply malformed query values do not crash the server', async () => {
  const weird = '?limit=1e999&page=-999&range[]=x&bbox=1,2,3&zoom=999999&search=%00%ff';
  for (const path of ['/api/devices', '/api/devices/map', '/api/reports/summary', '/api/events/flaps']) {
    const res = await api(srv.base, 'GET', path + weird);
    assert.ok(res.status === 200 || res.status === 400, `${path} → ${res.status}`);
  }
  assert.equal(srv.child.exitCode, null, 'server must stay alive');
  const health = await api(srv.base, 'GET', '/api/health', undefined, { auth: false });
  assert.equal(health.status, 200);
});
