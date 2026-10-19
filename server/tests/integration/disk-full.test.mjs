/**
 * شبیه‌سازی پرشدن دیسک.
 *
 * کمبود فضا با بالا بردن آستانهٔ `NETWATCH_MIN_FREE_BYTES` شبیه‌سازی می‌شود؛
 * همان تابع واقعی `requireDiskSpace` اجرا می‌شود، بدون اینکه به دیسک میزبان
 * آسیب بزنیم. انتظار: ۵۰۷ پیش از نوشتن، پیام روشن و هیچ رکورد/پشتیبان ناقصی.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDataDir, cleanupDir, startServer, api, upload } from '../helpers.mjs';

const dir = useTempDataDir('disk-full-api');
let srv;

test('import and backup fail cleanly with 507 when free space is insufficient', { timeout: 30000 }, async () => {
  srv = await startServer({
    dataDir: dir,
    engine: false,
    env: { NETWATCH_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER) },
  });
  try {
    const csv = 'نام تجهیز,آدرس IP\nDisk Full,10.240.0.1\n';
    const imported = await upload(srv.base, '/api/devices/import/commit', { filename: 'disk.csv', content: csv });
    assert.equal(imported.status, 507, JSON.stringify(imported.data));
    assert.equal(imported.data.rolledBack, true);
    assert.match(String(imported.data.error), /فضا|دیسک/i);

    const list = await api(srv.base, 'GET', '/api/devices?search=Disk Full');
    assert.equal(list.data.items.length, 0, 'no partial import may be written');

    const backup = await api(srv.base, 'POST', '/api/system/backups', { includeMbtiles: false });
    assert.equal(backup.status, 507, JSON.stringify(backup.data));
    assert.equal(backup.data.code, 'DB_DISK_FULL');

    const backupDir = path.join(dir, 'backups');
    const leftovers = fs.existsSync(backupDir)
      ? fs.readdirSync(backupDir).filter((n) => n.startsWith('.partial'))
      : [];
    assert.deepEqual(leftovers, [], 'no partial backup directory may remain');

    // سرویس باید سالم بماند و به کار ادامه دهد
    const health = await api(srv.base, 'GET', '/api/health', undefined, { auth: false });
    assert.equal(health.status, 200);
    assert.equal(srv.child.exitCode, null);
  } finally {
    await srv.stop();
    cleanupDir(dir);
  }
});

test.after(async () => {
  if (srv && srv.child.exitCode === null) await srv.stop();
});
