/**
 * آزمون یکپارچگی قابلیت‌های مدیریتی:
 * تاریخ نصب، گروه چندگانه، قالب، تعارض، کشف شبکه، پیوست، MTTR و گزارش نصب.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, api, upload, sessionFor, useTempDataDir, cleanupDir, waitFor } from '../helpers.mjs';

const dir = useTempDataDir('management-api');
let server;

before(async () => {
  server = await startServer({ dataDir: dir, env: { NETWATCH_SEED_DEMO: '0' } });
});

after(async () => {
  await server?.stop();
  cleanupDir(dir);
});

async function createDevice(fields) {
  const res = await api(server.base, 'POST', '/api/devices', {
    name: fields.name,
    ip: fields.ip,
    device_type: 'سوئیچ',
    ...fields,
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data;
}

test('تاریخ نصب و عضویت تک‌گروهی در ساخت/ویرایش و فیلتر', async () => {
  const g = await api(server.base, 'POST', '/api/groups', { name: 'گروه آزمایش', color: '#2563eb' });
  assert.equal(g.status, 201, JSON.stringify(g.data));
  const g2 = await api(server.base, 'POST', '/api/groups', { name: 'گروه دوم', color: '#16a34a' });

  const d = await createDevice({ name: 'سوئیچ نصب‌شده', ip: '10.50.0.10', installed_at: '2026-08-01', group_ids: [g.data.id, g2.data.id] });
  assert.ok(d.installedAt, 'installedAt باید epoch باشد');
  // هر تجهیز فقط عضو یک گروه است؛ ورودی چندگانه به اولین گروه محدود می‌شود.
  assert.deepEqual(d.groupIds, [g.data.id]);

  const updated = await api(server.base, 'PUT', `/api/devices/${d.id}`, { installed_at: '2026-09-15' });
  assert.equal(updated.status, 200);
  const fetched = await api(server.base, 'GET', `/api/devices/${d.id}`);
  assert.deepEqual(fetched.data.groupIds, [g.data.id], 'ویرایش تاریخ نباید عضویت گروه را پاک کند');

  const filtered = await api(server.base, 'GET', `/api/devices?group=${encodeURIComponent('گروه دوم')}`);
  assert.ok(!filtered.data.items.some((x) => x.id === d.id), 'تجهیز در گروه دوم نیست');
  const filteredFirst = await api(server.base, 'GET', `/api/devices?group=${encodeURIComponent('گروه آزمایش')}`);
  assert.ok(filteredFirst.data.items.some((x) => x.id === d.id), 'فیلتر گروه عضویت یکتا را می‌بیند');

  const byDate = await api(server.base, 'GET', '/api/devices?installedFrom=2026-08-01&installedTo=2026-09-30');
  assert.ok(byDate.data.items.some((x) => x.id === d.id));
  const outOfRange = await api(server.base, 'GET', '/api/devices?installedFrom=2025-01-01&installedTo=2025-01-31');
  assert.ok(!outOfRange.data.items.some((x) => x.id === d.id));

  const cleared = await api(server.base, 'PUT', `/api/devices/${d.id}/groups`, { groupIds: [g.data.id] });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.data.groupIds, [g.data.id]);
});

test('قالب تجهیز: ساخت، اعمال محافظه‌کارانه و بازنویسی با تأیید', async () => {
  const d = await createDevice({ name: 'تجهیز قالب', ip: '10.50.0.20', vendor: 'HP', ping_interval: 30 });
  const t = await api(server.base, 'POST', '/api/templates', {
    name: 'قالب تست',
    settings: { vendor: 'Cisco', ping_interval: 120, timeout_ms: 800 },
  });
  assert.equal(t.status, 201, JSON.stringify(t.data));

  const safe = await api(server.base, 'POST', `/api/templates/${t.data.id}/apply`, { deviceIds: [d.id], overwrite: false });
  assert.equal(safe.status, 200, JSON.stringify(safe.data));
  let dev = await api(server.base, 'GET', `/api/devices/${d.id}`);
  assert.equal(dev.data.vendor, 'HP');
  assert.equal(dev.data.pingInterval, 30);
  assert.equal(dev.data.timeoutMs, 800);

  const forced = await api(server.base, 'POST', `/api/templates/${t.data.id}/apply`, {
    deviceIds: [d.id],
    fields: ['vendor'],
    overwrite: true,
  });
  assert.equal(forced.status, 200);
  dev = await api(server.base, 'GET', `/api/devices/${d.id}`);
  assert.equal(dev.data.vendor, 'Cisco');
  assert.equal(dev.data.pingInterval, 30, 'فیلد انتخاب‌نشده بازنویسی نمی‌شود');

  const badTemplate = await api(server.base, 'POST', '/api/templates', { name: 'بدون تنظیم', settings: { ip: '1.2.3.4' } });
  assert.equal(badTemplate.status, 400);
});

test('تشخیص تعارض فقط موارد مشکوک با شاهد را برمی‌گرداند', async () => {
  await createDevice({ name: 'تعارض ۱', ip: '10.51.0.1', serial: 'SN-CONFLICT', hostname: 'edge-a' });
  await createDevice({ name: 'تعارض ۲', ip: '10.51.0.2', serial: 'SN-CONFLICT', hostname: 'edge-a' });
  const res = await api(server.base, 'GET', '/api/conflicts');
  assert.equal(res.status, 200);
  assert.ok(res.data.items.some((i) => i.type === 'duplicate_serial'));
  assert.ok(res.data.items.every((i) => i.definitive === false));
  assert.match(res.data.note, /تأیید/);
});

test('کشف شبکه: اعتبارسنجی محدوده، اسکن فوری و وضعیت', async () => {
  const outside = await api(server.base, 'POST', '/api/discovery/ranges', { name: 'اینترنت', cidr: '8.8.8.0/24' });
  assert.equal(outside.status, 400, 'محدودهٔ خارج از allowlist باید رد شود');
  const tooBig = await api(server.base, 'POST', '/api/discovery/ranges', { name: 'بزرگ', cidr: '10.0.0.0/16' });
  assert.equal(tooBig.status, 400);

  const ok = await api(server.base, 'POST', '/api/discovery/ranges', { name: 'آزمایش کشف', cidr: '192.168.250.0/30', intervalHours: 24 });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.hosts, 4);

  const dup = await api(server.base, 'POST', '/api/discovery/ranges', { name: 'تکراری', cidr: '192.168.250.0/30' });
  assert.equal(dup.status, 409);

  const scan = await api(server.base, 'POST', '/api/discovery/scan', {});
  assert.equal(scan.status, 202, JSON.stringify(scan.data));
  const finished = await waitFor(async () => {
    const st = await api(server.base, 'GET', '/api/discovery/status');
    return st.data.scan.running ? null : st.data;
  }, { timeout: 15000, interval: 100 });
  assert.ok(finished, 'اسکن باید در مهلت پایان یابد');
  assert.equal(finished.scan.error, null);

  const results = await api(server.base, 'GET', '/api/discovery/results');
  assert.equal(results.status, 200);
  assert.ok(Array.isArray(results.data.items));
  assert.ok(results.data.items.every((r) => r.ip.startsWith('192.168.250.')), 'فقط میزبان‌های محدوده');

  const del = await api(server.base, 'DELETE', `/api/discovery/ranges/${ok.data.id}`);
  assert.equal(del.status, 200);
});

test('پیوست: بارگذاری تصویر، دانلود با نشست و رد فایل غیرمجاز', async () => {
  const d = await createDevice({ name: 'تجهیز پیوست', ip: '10.52.0.5' });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const up = await upload(server.base, `/api/devices/${d.id}/attachments`, { filename: 'photo.png', content: png, type: 'image/png' });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.equal(up.data.kind, 'image');

  const list = await api(server.base, 'GET', `/api/devices/${d.id}/attachments`);
  assert.equal(list.status, 200);
  assert.equal(list.data.items.length, 1);

  const session = sessionFor(server.base);
  const dl = await fetch(`${server.base}/api/devices/${d.id}/attachments/${up.data.id}/download`, {
    headers: { cookie: session.cookie },
  });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'image/png');
  assert.match(dl.headers.get('content-disposition') || '', /inline/);

  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
  const rejected = await upload(server.base, `/api/devices/${d.id}/attachments`, { filename: 'evil.zip', content: zip, type: 'application/zip' });
  assert.equal(rejected.status, 415, 'آرشیو/فایل اجرایی پذیرفته نمی‌شود');

  const unauth = await fetch(`${server.base}/api/devices/${d.id}/attachments/${up.data.id}/download`);
  assert.equal(unauth.status, 401, 'دانلود بدون نشست ممنوع است');

  const removed = await api(server.base, 'DELETE', `/api/devices/${d.id}/attachments/${up.data.id}`);
  assert.equal(removed.status, 200);
});

test('گزارش MTTR فقط قطعی دارای تعمیر را می‌شمارد و گزارش نصب کار می‌کند', async () => {
  const d = await createDevice({ name: 'تجهیز MTTR', ip: '10.53.0.7', installed_at: '2026-09-01' });
  const now = Date.now();
  const started = now - 3 * 3600 * 1000;
  const ended = now - 3600 * 1000;
  const dbFile = path.join(dir, 'netwatch.db');
  assert.ok(fs.existsSync(dbFile));
  const conn = new DatabaseSync(dbFile);
  conn.exec('PRAGMA busy_timeout = 5000');
  const outage = conn
    .prepare('INSERT INTO outages(device_id, started_at, ended_at, duration_sec, cause, open) VALUES (?,?,?,?,?,0)')
    .run(d.id, started, ended, 7200, 'تست');
  const outageId = Number(outage.lastInsertRowid);
  // قطعی دوم بدون تعمیر — باید excluded شود
  conn
    .prepare('INSERT INTO outages(device_id, started_at, ended_at, duration_sec, cause, open) VALUES (?,?,?,?,?,0)')
    .run(d.id, started - 86400000, ended - 86400000, 1800, 'بدون تعمیر');
  conn
    .prepare(
      'INSERT INTO maintenance_records(device_id, outage_id, action, cause, started_at, ended_at, status, created_at, technician) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(d.id, outageId, 'تعمیر تجهیز', 'قطعی برق', started, ended, 'closed', now, 'تکنسین تست');
  conn.close();

  const mttr = await api(server.base, 'GET', `/api/reports/mttr?device=${d.id}&range=7d`);
  assert.equal(mttr.status, 200, JSON.stringify(mttr.data));
  assert.equal(mttr.data.count, 1, 'فقط قطعی دارای تعمیر');
  assert.equal(mttr.data.excluded, 1);
  assert.equal(mttr.data.avgSec, 7200);
  assert.equal(mttr.data.events[0].maintenanceId > 0, true);

  const summary = await api(server.base, 'GET', '/api/reports/summary?range=7d');
  assert.equal(summary.status, 200);
  assert.ok(summary.data.mttr);
  assert.equal(summary.data.totals.mttrEvents, summary.data.mttr.count);

  const install = await api(server.base, 'GET', '/api/reports/installations?from=2026-08-01&to=2026-09-30');
  assert.equal(install.status, 200, JSON.stringify(install.data));
  assert.ok(install.data.items.some((r) => r.id === d.id));
  assert.ok(install.data.items.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.installedAtLabel)), 'برچسب شمسی استاندارد');
});
