/**
 * ورود ۵۰٬۰۰۰ ردیف (سقف مجاز) از مسیر واقعی HTTP.
 *
 * این آزمون سنگین است و در `npm test` پیش‌فرض اجرا نمی‌شود؛ با
 * `npm run test:heavy` اجرا می‌شود. معیار: پردازش در Worker، پاسخ پیش‌نمایش
 * کوچک، ثبت اتمیک و شمارش دقیق، بدون ۵۰۰ و بدون رشد نامتعارف حافظه.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { useTempDataDir, cleanupDir, startServer, api, upload } from '../helpers.mjs';

const ROWS = 50000;
const dir = useTempDataDir('import-50k');
let srv;

function rssMb(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
    return match ? Math.round((Number(match[1]) / 1024) * 10) / 10 : null;
  } catch {
    return null;
  }
}

test('50,000 rows preview and import atomically within the job timeout', { timeout: 180000 }, async () => {
  srv = await startServer({
    dataDir: dir,
    engine: false,
    env: { NETWATCH_MAX_IMPORT_ROWS: String(ROWS), NETWATCH_JOB_TIMEOUT_MS: '180000' },
  });
  try {
    const lines = ['نام تجهیز,آدرس IP,گروه,اولویت'];
    for (let i = 0; i < ROWS; i++) {
      lines.push(`import-${i},10.100.${Math.floor(i / 250)}.${(i % 250) + 1},bulk-import,normal`);
    }
    const csv = lines.join('\n');
    const bytes = Buffer.byteLength(csv);
    assert.ok(bytes < 10 * 1024 * 1024, 'test file must be below the default upload cap');

    const rssBefore = rssMb(srv.child.pid);
    const previewStart = Date.now();
    const preview = await upload(srv.base, '/api/devices/import/preview', { filename: 'bulk-50k.csv', content: csv });
    const previewMs = Date.now() - previewStart;
    assert.equal(preview.status, 200, JSON.stringify(preview.data)?.slice(0, 300));
    assert.equal(preview.data.summary.valid, ROWS);
    assert.equal(preview.data.summary.invalid, 0);
    assert.ok(preview.data.valid.length <= 200, 'preview sample must stay bounded');
    assert.ok(preview.data.truncated.valid, 'large preview must report truncation');
    const previewBytes = Buffer.byteLength(JSON.stringify(preview.data));

    const commitStart = Date.now();
    const commit = await upload(srv.base, '/api/devices/import/commit', { filename: 'bulk-50k.csv', content: csv });
    const commitMs = Date.now() - commitStart;
    assert.equal(commit.status, 200, JSON.stringify(commit.data)?.slice(0, 300));
    assert.equal(commit.data.inserted, ROWS);
    assert.equal(commit.data.atomic, true);
    const rssAfter = rssMb(srv.child.pid);

    const counted = await api(srv.base, 'GET', '/api/devices?pageSize=1&search=import-');
    assert.equal(counted.status, 200);
    assert.equal(counted.data.total, ROWS);

    const health = await api(srv.base, 'GET', '/api/health', undefined, { auth: false });
    assert.equal(health.status, 200);
    assert.equal(srv.child.exitCode, null);

    const metrics = {
      rows: ROWS,
      csvBytes: bytes,
      previewMs,
      previewBytes,
      commitMs,
      rowsPerSecond: Math.round((ROWS / commitMs) * 1000),
      rssBefore,
      rssAfter,
      rssGrowthMb: rssAfter && rssBefore ? Math.round((rssAfter - rssBefore) * 10) / 10 : null,
    };
    fs.mkdirSync('data/qa', { recursive: true });
    fs.writeFileSync('data/qa/import-50k.json', JSON.stringify(metrics, null, 2));
    console.log('IMPORT_50K', JSON.stringify(metrics));
    assert.ok(commitMs < 170000, `commit exceeded the 170s budget: ${commitMs}ms`);
    assert.ok(previewBytes < 2 * 1024 * 1024, `preview response too large: ${previewBytes} bytes`);
    assert.ok(metrics.rssGrowthMb == null || metrics.rssGrowthMb < 300, `server RSS grew ${metrics.rssGrowthMb} MB`);
  } finally {
    await srv.stop();
    cleanupDir(dir);
  }
});

test.after(async () => {
  if (srv && srv.child.exitCode === null) await srv.stop();
});
