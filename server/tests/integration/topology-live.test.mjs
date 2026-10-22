/**
 * آزمون وضعیت زندهٔ دیاگرام ارتباطات:
 *   • وضعیت واقعی گره‌ها/لینک‌ها از دادهٔ موتور (بدون تغییر دستی رنگ)
 *   • رنگ چهارگانه: سبز/زرد/قرمز/خاکستری با قواعد مشخص
 *   • تأخیر، افت بسته، نوسان تأخیر و کهنگی داده
 *   • مشخصات فنی تجهیز روی گره
 *   • Regression حذف کامل SNMP: نه فیلد سنجش در پاسخ، نه مسیر Poll
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { useTempDataDir, cleanupDir, startServer, api } from '../helpers.mjs';

const dir = useTempDataDir('topology-live');
let srv;
let raw;
let devices = [];
let diagram;
let nodeA;
let nodeB;
let linkId;

function openDb() {
  raw = new DatabaseSync(path.join(dir, 'netwatch.db'));
  raw.exec('PRAGMA busy_timeout = 5000');
  return raw;
}

function setDevice(id, patch) {
  const entries = Object.entries(patch);
  raw
    .prepare(`UPDATE devices SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...entries.map(([, v]) => v), id);
}

function insertSamples(deviceId, values) {
  const now = Date.now();
  const stmt = raw.prepare(
    'INSERT INTO samples(device_id, ts, rtt_ms, packets_sent, packets_recv, loss_pct, status, ok, mode) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  values.forEach((rtt, index) => stmt.run(deviceId, now - (values.length - index) * 30000, rtt, 3, 3, 0, 'online', 1, 'test'));
}

before(async () => {
  srv = await startServer({ dataDir: dir, engine: false });
  const list = await api(srv.base, 'GET', '/api/devices?pageSize=5');
  assert.equal(list.status, 200);
  devices = list.data.items.slice(0, 2);
  assert.equal(devices.length, 2, 'دادهٔ نمونه باید حداقل دو تجهیز داشته باشد');
  openDb();
  const now = Date.now();
  setDevice(devices[0].id, {
    status: 'online',
    status_reason: '',
    last_check_at: now,
    last_rtt_ms: 12.4,
    loss_pct: 0,
    vendor: 'Cisco',
    model: 'C9300-48P',
    serial: 'SN-TEST-0001',
    firmware: '17.9.4',
    location: 'سالن A',
    building: 'ساختمان مرکزی',
    rack: 'R-12',
  });
  setDevice(devices[1].id, {
    status: 'online',
    status_reason: '',
    last_check_at: now,
    last_rtt_ms: 24.2,
    loss_pct: 0,
    vendor: 'Juniper',
    model: 'EX4300',
    serial: 'SN-TEST-0002',
    location: 'سالن B',
  });
  insertSamples(devices[1].id, [22, 24, 41, 23]);

  const created = await api(srv.base, 'POST', '/api/topology/diagrams', { name: 'دیاگرام زنده' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  diagram = created.data;
  nodeA = randomUUID();
  nodeB = randomUUID();
  linkId = randomUUID();
  const saved = await api(srv.base, 'PUT', `/api/topology/diagrams/${diagram.id}/graph`, {
    revision: 1,
    nodes: [
      { id: nodeA, kind: 'device', deviceId: devices[0].id, x: 40, y: 40 },
      { id: nodeB, kind: 'device', deviceId: devices[1].id, x: 400, y: 40 },
    ],
    links: [
      {
        id: linkId,
        from: nodeA,
        to: nodeB,
        kind: 'fiber',
        label: 'فیبر اصلی',
        capacityMbps: 100,
        // فیلدهای قدیمی SNMP نادیده گرفته می‌شوند و خطا نمی‌سازند.
        telemetry: { enabled: true, agent: '127.0.0.1', ifIndex: 3 },
      },
    ],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
});

after(async () => {
  try {
    raw?.close();
  } catch {
    /* بی‌اثر */
  }
  await srv?.stop();
  cleanupDir(dir);
});

async function status() {
  const res = await api(srv.base, 'GET', `/api/topology/diagrams/${diagram.id}/status?fresh=1`);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}

test('live snapshot derives green link plus latency, loss and jitter from real samples', async () => {
  const data = await status();
  assert.equal(data.revision, 2);
  assert.equal(data.links.length, 1);

  const link = data.links[0];
  assert.equal(link.status, 'up', JSON.stringify(link));
  assert.equal(link.latencyMs, 24.2);
  assert.equal(link.lossPct, 0);
  assert.ok(link.jitterMs > 5, 'نوسان باید از نمونه‌های واقعی محاسبه شود');
  assert.equal(link.capacityMbps, 100);
  assert.equal(link.sourceCount, 2);
  assert.equal(data.summary.up, 1);

  const node = data.nodes.find((n) => n.id === nodeB);
  assert.equal(node.status, 'online');
  assert.ok(node.jitterMs > 5);
  assert.ok(data.generatedAt > 0);
});

test('node carries technical identity and capacity is structured on the link', async () => {
  const loaded = await api(srv.base, 'GET', `/api/topology/diagrams/${diagram.id}`);
  assert.equal(loaded.status, 200);
  const node = loaded.data.nodes.find((n) => n.id === nodeA);
  assert.equal(node.device.vendor, 'Cisco');
  assert.equal(node.device.model, 'C9300-48P');
  assert.equal(node.device.serial, 'SN-TEST-0001');
  assert.equal(node.device.location, 'سالن A');
  assert.equal(node.device.rack, 'R-12');
  assert.equal(node.device.status, 'online');
  const link = loaded.data.links.find((l) => l.id === linkId);
  assert.equal(link.capacityMbps, 100);
  assert.equal(link.live.status, 'up');
});

test('automatic colour changes: offline is red, packet loss is yellow, stale is gray', async () => {
  const now = Date.now();
  setDevice(devices[1].id, { status: 'offline', status_reason: 'TIMEOUT', last_check_at: now });
  let link = (await status()).links[0];
  assert.equal(link.status, 'down');
  assert.equal(link.reasonCode, 'endpoint-offline');

  setDevice(devices[1].id, { status: 'warning', status_reason: 'loss', last_check_at: now, loss_pct: 22 });
  link = (await status()).links[0];
  assert.equal(link.status, 'degraded');
  assert.ok(['loss', 'endpoint-warning'].includes(link.reasonCode));
  assert.equal(link.lossPct, 22);

  setDevice(devices[1].id, { status: 'online', loss_pct: 0, last_check_at: now - 3_600_000 });
  link = (await status()).links[0];
  assert.equal(link.status, 'unknown');
  assert.ok(['stale', 'partial-stale'].includes(link.reasonCode));

  setDevice(devices[1].id, { status: 'online', status_reason: '', last_check_at: now, loss_pct: 0 });
  link = (await status()).links[0];
  assert.equal(link.status, 'up');
});

test('SNMP removal: no telemetry fields are serialized and the poll route is gone', async () => {
  const loaded = await api(srv.base, 'GET', `/api/topology/diagrams/${diagram.id}`);
  assert.equal(loaded.status, 200);
  const link = loaded.data.links.find((l) => l.id === linkId);
  assert.equal('telemetry' in link, false, 'پیکربندی SNMP نباید در مدل لینک بماند');
  assert.equal('telemetry' in link.live, false, 'وضعیت زنده نباید متریک SNMP داشته باشد');
  assert.equal('utilPct' in link.live, false);
  assert.equal('saturation' in link.live, false);

  const polled = await api(srv.base, 'POST', `/api/topology/diagrams/${diagram.id}/telemetry/poll`, {});
  assert.equal(polled.status, 404, 'مسیر Poll مبتنی بر SNMP باید حذف شده باشد');

  const exportRes = await api(srv.base, 'GET', `/api/topology/diagrams/${diagram.id}/export`);
  assert.equal(exportRes.status, 200);
  const exported = typeof exportRes.data === 'string' ? JSON.parse(exportRes.data) : exportRes.data;
  assert.equal('telemetry' in exported.links[0], false);

  // ستون‌های SNMP پس از مهاجرت ۱۱ نباید در پایگاه‌داده بمانند.
  const columns = raw.prepare('PRAGMA table_info(topology_links)').all().map((row) => row.name);
  assert.equal(columns.some((name) => name.startsWith('telemetry')), false, `ستون‌های باقی‌مانده: ${columns.join(', ')}`);
  const table = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='topology_link_telemetry'")
    .get();
  assert.equal(table, undefined, 'جدول سنجش SNMP باید حذف شده باشد');
});

