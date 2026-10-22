/**
 * آزمون یکپارچگی صف Probe و سهمیهٔ نرخ.
 *
 * این آزمون رفتار واقعی سرور را می‌سنجد (نه ماژول را جداگانه):
 *   ۱. Ping گروهی به Job قابل پیگیری تبدیل می‌شود و همهٔ تجهیزات در آن
 *      گزارش می‌شوند (بدون Promise.all نامحدود).
 *   ۲. درخواست تکراری هم‌زمان برای همان تجهیز، کار صف را تکرار نمی‌کند.
 *   ۳. سقف تعداد تجهیز در یک درخواست گروهی اعمال می‌شود.
 *   ۴. سهمیهٔ Probe مستقل از سهمیهٔ عمومی و شامل Ping مستقیم، Ping گروهی و
 *      بررسی همهٔ تجهیزات است.
 *   ۵. Poll توپولوژی سهمیهٔ مستقل دارد.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, startServer, api, waitFor } from '../helpers.mjs';

const dir = useTempDataDir('probe-bulk');
process.env.NETWATCH_DATA_DIR = dir;

test('bulk probe runs through the central queue and reports a trackable job', async (t) => {
  const srv = await startServer({ dataDir: dir });
  t.after(async () => {
    await srv.stop();
    cleanupDir(dir);
  });

  // حالت شبیه‌سازی: Probe واقعی شبکه لازم نیست؛ رفتار صف و Job سنجیده می‌شود.
  const settings = await api(srv.base, 'PUT', '/api/settings', { engine_mode: 'simulate' });
  assert.equal(settings.status, 200, JSON.stringify(settings.data));

  const ids = [];
  for (let i = 1; i <= 6; i++) {
    const created = await api(srv.base, 'POST', '/api/devices', {
      name: `bulk-${i}`,
      ip: `10.250.0.${i}`,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    ids.push(created.data.id);
  }

  const started = await api(srv.base, 'POST', '/api/devices/bulk', { ids, action: 'ping' });
  assert.equal(started.status, 202, JSON.stringify(started.data));
  assert.equal(started.data.queued, ids.length);
  assert.equal(started.data.skipped, 0);
  assert.ok(started.data.jobId, 'job id must be returned');

  // Job پس از بسته‌شدن پاسخ اولیه قابل پیگیری است.
  const finished = await waitFor(
    async () => {
      const r = await api(srv.base, 'GET', started.data.statusUrl);
      if (r.status !== 200) return null;
      return r.data.status === 'done' ? r.data : null;
    },
    { timeout: 15000 }
  );
  assert.ok(finished, 'bulk probe job must finish');
  assert.equal(finished.total, ids.length);
  assert.equal(finished.completed + finished.failed, ids.length);
  // `queued` تعداد نتیجه‌های ثبت‌شده است (نام تاریخی فیلد).
  assert.equal(finished.queued, ids.length);

  // گزارش نتایج برای هر تجهیز (بدون تکرار/گم‌شدن) موجود است.
  const device = await api(srv.base, 'GET', `/api/devices/${ids[0]}`);
  assert.equal(device.status, 200);
  assert.equal(device.data.status, 'online');
  assert.ok(device.data.lastCheckAt > 0);

  // درخواست تکراری هم‌زمان: کار صف برای همان کلید تکرار نمی‌شود و هر دو
  // درخواست پاسخ ۲۰۲ معتبر می‌گیرند.
  const [a, b] = await Promise.all([
    api(srv.base, 'POST', '/api/devices/bulk', { ids: [ids[0]], action: 'ping' }),
    api(srv.base, 'POST', '/api/devices/bulk', { ids: [ids[0]], action: 'ping' }),
  ]);
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  for (const job of [a.data, b.data]) {
    const done = await waitFor(
      async () => {
        const r = await api(srv.base, 'GET', job.statusUrl);
        return r.data?.status === 'done' ? r.data : null;
      },
      { timeout: 10000 }
    );
    assert.ok(done);
    assert.equal(done.completed + done.failed, 1);
  }

  // سقف تعداد تجهیز در یک درخواست گروهی (۵۰۰) پیش از هر کوئری دیتابیس اعمال
  // می‌شود؛ ورودی بزرگ نباید تراکنشی با هزاران پارامتر بسازد.
  const tooMany = await api(srv.base, 'POST', '/api/devices/bulk', {
    ids: Array.from({ length: 501 }, (_, i) => i + 1),
    action: 'ping',
  });
  assert.equal(tooMany.status, 413, JSON.stringify(tooMany.data));

  // شناسهٔ ناموجود نادیده گرفته می‌شود و Job خالی بلافاصله تمام می‌شود.
  const empty = await api(srv.base, 'POST', '/api/devices/bulk', { ids: [99999], action: 'ping' });
  assert.equal(empty.status, 202, JSON.stringify(empty.data));
  assert.equal(empty.data.queued, 0);
  assert.equal(empty.data.total, 0);
  const emptyJob = await api(srv.base, 'GET', empty.data.statusUrl);
  assert.equal(emptyJob.status, 200, JSON.stringify(emptyJob.data));
  assert.equal(emptyJob.data.status, 'done');
  assert.equal(emptyJob.data.finishedAt > 0, true);

  // عملیات غیر Probe همچنان همگام و بدون Job است (رفتار قبلی حفظ می‌شود).
  const disabled = await api(srv.base, 'POST', '/api/devices/bulk', { ids, action: 'disable' });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.data.affected, ids.length);
});

test('probe and topology poll endpoints have their own rate budgets', async (t) => {
  const dir2 = useTempDataDir('probe-bulk-rate');
  const srv = await startServer({
    dataDir: dir2,
    env: {
      NETWATCH_PROBE_RATE_LIMIT_MAX: '2',
      NETWATCH_TOPOLOGY_RATE_LIMIT_MAX: '2',
      // سقف عمومی باید بزرگ‌تر بماند تا آزمون سهمیهٔ Probe را بسنجد، نه عمومی را.
      NETWATCH_RATE_LIMIT_MAX: '1000',
    },
  });
  t.after(async () => {
    await srv.stop();
    cleanupDir(dir2);
  });

  const settings = await api(srv.base, 'PUT', '/api/settings', { engine_mode: 'simulate' });
  assert.equal(settings.status, 200, JSON.stringify(settings.data));

  const created = await api(srv.base, 'POST', '/api/devices', { name: 'rate', ip: '10.251.0.1' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.id;

  const first = await api(srv.base, 'POST', `/api/devices/${id}/ping`, {});
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const second = await api(srv.base, 'POST', `/api/devices/${id}/ping`, {});
  assert.equal(second.status, 200, JSON.stringify(second.data));

  const third = await api(srv.base, 'POST', `/api/devices/${id}/ping`, {});
  assert.equal(third.status, 429, JSON.stringify(third.data));
  assert.ok(Number(third.headers.get('retry-after')) >= 1, 'Retry-After header must be present');

  // بررسی همهٔ تجهیزات هم همان سهمیه را مصرف می‌کند (پیش‌تر از سقف Probe
  // رد نمی‌شد). اکنون سهمیه تمام شده است.
  const checkAll = await api(srv.base, 'POST', '/api/engine/check-all', {});
  assert.equal(checkAll.status, 429, JSON.stringify(checkAll.data));

  // خواندن‌های عادی (مثلاً فهرست تجهیزات) از سهمیهٔ Probe مصرف نمی‌کنند.
  for (let i = 0; i < 5; i++) {
    const list = await api(srv.base, 'GET', '/api/devices');
    assert.equal(list.status, 200);
  }

  // سهمیهٔ Poll توپولوژی مستقل است: Ping تمام‌شده مانع خواندن وضعیت نیست.
  const diagram = await api(srv.base, 'POST', '/api/topology/diagrams', { name: 'rate-graph' });
  assert.equal(diagram.status, 201, JSON.stringify(diagram.data));
  const diagramId = diagram.data.id;

  const p1 = await api(srv.base, 'GET', `/api/topology/diagrams/${diagramId}/status`);
  assert.equal(p1.status, 200, JSON.stringify(p1.data));
  const p2 = await api(srv.base, 'GET', `/api/topology/diagrams/${diagramId}/status`);
  assert.equal(p2.status, 200, JSON.stringify(p2.data));
  // نسخهٔ کش‌شده: Poll تکراری همان Snapshot را می‌گیرد (بدون بازسازی).
  assert.equal(p2.data.cached, true);

  const p3 = await api(srv.base, 'GET', `/api/topology/diagrams/${diagramId}/status`);
  assert.equal(p3.status, 429, JSON.stringify(p3.data));
});
