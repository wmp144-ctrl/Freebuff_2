/**
 * آزمون E2E مسیرهای اصلی: افزودن تجهیز، بررسی وضعیت، هشدار و حذف.
 * موتور روی حالت TCP با یک پورت بسته اجرا می‌شود تا «قطع بودن» قطعی و سریع باشد.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, startServer, api, freePort } from '../helpers.mjs';

const dir = useTempDataDir('e2e');
let srv;
let closedPort;

before(async () => {
  closedPort = await freePort(); // پورت آزاد که کسی به آن گوش نمی‌دهد
  srv = await startServer({ dataDir: dir, engine: false });
  const settings = await api(srv.base, 'PUT', '/api/settings', {
    engine_mode: 'tcp',
    tcp_port: closedPort,
    timeout_ms: 200,
    retries: 0,
    packet_count: 1,
    ping_interval: 3600,
    failures_for_offline: 2,
    successes_for_online: 1,
    alerting_enabled: true,
    alert_cooldown: 0,
    suppression_enabled: false,
  });
  assert.equal(settings.status, 200);
});

after(async () => {
  await srv.stop();
  cleanupDir(dir);
});

test('add device → fail checks → offline status + active alert → delete', async () => {
  const created = await api(srv.base, 'POST', '/api/devices', { name: 'E2E-سوئیچ', ip: '127.0.0.1', group: 'گروه آزمون' });
  assert.equal(created.status, 201);
  const id = created.data.id;

  const first = await api(srv.base, 'POST', `/api/devices/${id}/ping`, { mode: 'engine' });
  assert.equal(first.status, 200);
  assert.equal((await api(srv.base, 'GET', `/api/devices/${id}`)).data.status, 'unknown');

  const second = await api(srv.base, 'POST', `/api/devices/${id}/ping`, { mode: 'engine' });
  assert.equal(second.status, 200);
  const after = await api(srv.base, 'GET', `/api/devices/${id}`);
  assert.equal(after.data.status, 'offline');
  assert.ok(after.data.statusReason.length > 0);

  const alerts = await api(srv.base, 'GET', `/api/alerts?status=active&deviceId=${id}`);
  assert.equal(alerts.status, 200);
  const offlineAlert = alerts.data.items.find((a) => a.kind === 'offline');
  assert.ok(offlineAlert, 'an offline alert must be visible through the API');
  assert.equal(offlineAlert.severity, 'critical');

  const outages = await api(srv.base, 'GET', `/api/devices/${id}/outages`);
  assert.equal(outages.data.open?.id != null, true, 'an open outage must be recorded');

  const ack = await api(srv.base, 'POST', `/api/alerts/${offlineAlert.id}/ack`, { by: 'آزمون' });
  assert.equal(ack.data.updated, 1);

  assert.equal((await api(srv.base, 'DELETE', `/api/devices/${id}`)).status, 200);
  const gone = await api(srv.base, 'GET', `/api/devices/${id}`);
  assert.equal(gone.status, 404);
  const alertsAfter = await api(srv.base, 'GET', `/api/alerts?deviceId=${id}`);
  assert.equal(alertsAfter.data.items.length, 0, 'alerts must be removed with the device (cascade)');
});

test('list endpoint reflects device status counters used by the UI', async () => {
  const created = await api(srv.base, 'POST', '/api/devices', { name: 'E2E-مانیتور', ip: '127.0.0.2' });
  assert.equal(created.status, 201);
  const id = created.data.id;

  await api(srv.base, 'POST', `/api/devices/${id}/ping`, { mode: 'engine' });
  await api(srv.base, 'POST', `/api/devices/${id}/ping`, { mode: 'engine' });

  const offlineList = await api(srv.base, 'GET', '/api/devices?status=offline&pageSize=100');
  assert.ok(offlineList.data.items.some((d) => d.id === id), 'device must appear in the offline filter');
  const meta = await api(srv.base, 'GET', '/api/devices/meta');
  assert.equal(meta.status, 200);
  assert.ok(meta.data.settings && meta.data.groups.some((g) => g.name === 'گروه آزمون'));

  await api(srv.base, 'DELETE', `/api/devices/${id}`);
});
