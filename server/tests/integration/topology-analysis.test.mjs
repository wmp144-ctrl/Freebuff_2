/**
 * آزمون یکپارچهٔ مرحلهٔ ۳ دیاگرام ارتباطات:
 *   • تحلیل ساختار واقعی: پل‌ها، نقاط بحرانی و شمارش تجهیزات وابسته
 *   • شبیه‌سازی قطع لینک/تجهیز و مسیر تا مرکز زیرساخت
 *   • ذخیره، اعتبارسنجی و وضعیت مسیرهای اصلی/پشتیبان
 *   • قفل دیاگرام و خطاهای ورودی
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { useTempDataDir, cleanupDir, startServer, api } from '../helpers.mjs';

const dir = useTempDataDir('topology-analysis');
let srv;
let raw;
let devices = [];
let chainDiagram;
let chainNodes;
let chainLinks;
let redundantDiagram;
let redundantNodes;
let redundantLinks;

function openDb() {
  raw = new DatabaseSync(path.join(dir, 'netwatch.db'));
  raw.exec('PRAGMA busy_timeout = 5000');
  return raw;
}

before(async () => {
  srv = await startServer({ dataDir: dir, engine: false });
  const list = await api(srv.base, 'GET', '/api/devices?pageSize=10');
  assert.equal(list.status, 200);
  devices = list.data.items.slice(0, 4);
  assert.equal(devices.length, 4, 'دادهٔ نمونه باید حداقل چهار تجهیز داشته باشد');
  openDb();
  const now = Date.now();
  const stmt = raw.prepare(
    "UPDATE devices SET status = 'online', status_reason = '', last_check_at = ?, last_rtt_ms = ?, loss_pct = 0 WHERE id = ?"
  );
  for (const device of devices) stmt.run(now, 12, device.id);

  const created = await api(srv.base, 'POST', '/api/topology/diagrams', { name: 'تحلیل زنجیره' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  chainDiagram = created.data;
  chainNodes = {
    site: randomUUID(),
    gateway: randomUUID(),
    sw: randomUUID(),
    server: randomUUID(),
  };
  chainLinks = {
    uplink: randomUUID(),
    core: randomUUID(),
    access: randomUUID(),
  };
  let saved = await api(srv.base, 'PUT', `/api/topology/diagrams/${chainDiagram.id}/graph`, {
    revision: 1,
    nodes: [
      { id: chainNodes.site, kind: 'site', x: 40, y: 40 },
      { id: chainNodes.gateway, kind: 'device', deviceId: devices[0].id, label: 'Gateway', x: 300, y: 40 },
      { id: chainNodes.sw, kind: 'device', deviceId: devices[1].id, label: 'Core Switch', x: 560, y: 40 },
      { id: chainNodes.server, kind: 'device', deviceId: devices[2].id, label: 'App Server', x: 820, y: 40 },
    ],
    links: [
      { id: chainLinks.uplink, from: chainNodes.site, to: chainNodes.gateway, kind: 'fiber', label: 'uplink' },
      { id: chainLinks.core, from: chainNodes.gateway, to: chainNodes.sw, kind: 'fiber', label: 'core' },
      { id: chainLinks.access, from: chainNodes.sw, to: chainNodes.server, kind: 'copper', label: 'access' },
    ],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));

  const redundant = await api(srv.base, 'POST', '/api/topology/diagrams', { name: 'مسیر پشتیبان' });
  assert.equal(redundant.status, 201, JSON.stringify(redundant.data));
  redundantDiagram = redundant.data;
  redundantNodes = {
    site: randomUUID(),
    a: randomUUID(),
    b: randomUUID(),
    c: randomUUID(),
    cloud: randomUUID(),
  };
  redundantLinks = {
    sa: randomUUID(),
    ab: randomUUID(),
    sc: randomUUID(),
    cb: randomUUID(),
  };
  saved = await api(srv.base, 'PUT', `/api/topology/diagrams/${redundantDiagram.id}/graph`, {
    revision: 1,
    nodes: [
      { id: redundantNodes.site, kind: 'site', x: 40, y: 40 },
      { id: redundantNodes.a, kind: 'device', deviceId: devices[0].id, label: 'A', x: 300, y: 40 },
      { id: redundantNodes.b, kind: 'device', deviceId: devices[1].id, label: 'B', x: 560, y: 40 },
      { id: redundantNodes.c, kind: 'device', deviceId: devices[2].id, label: 'C', x: 560, y: 160 },
      { id: redundantNodes.cloud, kind: 'cloud', x: 300, y: 160 },
    ],
    links: [
      { id: redundantLinks.sa, from: redundantNodes.site, to: redundantNodes.a, kind: 'fiber' },
      { id: redundantLinks.ab, from: redundantNodes.a, to: redundantNodes.b, kind: 'fiber' },
      { id: redundantLinks.sc, from: redundantNodes.site, to: redundantNodes.c, kind: 'fiber' },
      { id: redundantLinks.cb, from: redundantNodes.c, to: redundantNodes.b, kind: 'fiber' },
    ],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
});

after(async () => {
  raw?.close();
  await srv?.stop();
  cleanupDir(dir);
});

test('analysis derives bridges and critical nodes from the stored graph', async () => {
  const res = await api(srv.base, 'GET', `/api/topology/diagrams/${chainDiagram.id}/analysis`);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.anchorSource, 'explicit');
  assert.equal(res.data.summary.deviceCount, 3);
  assert.equal(res.data.summary.reachableDeviceCount, 3);
  const byNode = new Map(res.data.criticalNodes.map((item) => [item.id, item]));
  assert.equal(byNode.get(chainNodes.gateway).dependentDeviceCount, 2);
  assert.equal(byNode.get(chainNodes.gateway).role, 'gateway');
  assert.equal(byNode.get(chainNodes.sw).dependentDeviceCount, 1);

  const byLink = new Map(res.data.riskyLinks.map((item) => [item.id, item]));
  assert.equal(byLink.get(chainLinks.uplink).dependentDeviceCount, 3);
  assert.equal(byLink.get(chainLinks.core).dependentDeviceCount, 2);
  assert.equal(byLink.get(chainLinks.access).bridge, true);
});

test('impact simulation returns affected devices and the cut path to the infrastructure', async () => {
  const res = await api(
    srv.base,
    'GET',
    `/api/topology/diagrams/${chainDiagram.id}/impact?linkId=${chainLinks.core}`
  );
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.target.type, 'link');
  assert.equal(res.data.summary.affectedDeviceCount, 2);
  assert.equal(res.data.summary.alternateRoute, false);
  const affectedIds = res.data.affected.devices.map((item) => item.id);
  assert.ok(affectedIds.includes(chainNodes.sw));
  assert.ok(affectedIds.includes(chainNodes.server));
  assert.ok(res.data.paths.length >= 1);
  assert.ok(res.data.paths.every((item) => item.pathLabels.includes('Gateway')));
  assert.equal(res.data.paths[0].cutLinkId, chainLinks.core);
});

test('impact of a gateway includes downstream devices and the gateway itself', async () => {
  const res = await api(
    srv.base,
    'GET',
    `/api/topology/diagrams/${chainDiagram.id}/impact?nodeId=${chainNodes.gateway}`
  );
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.summary.affectedDeviceCount, 3);
  assert.equal(res.data.affected.devices.some((item) => item.id === chainNodes.gateway && item.isTarget), true);
  assert.equal(res.data.summary.severity, 'critical');
});

test('paths are validated, saved and returned with a stable revision', async () => {
  const saved = await api(srv.base, 'PUT', `/api/topology/diagrams/${chainDiagram.id}/paths`, {
    paths: [
      {
        name: 'دسترسی سرور',
        role: 'primary',
        nodeIds: [chainNodes.site, chainNodes.gateway, chainNodes.sw, chainNodes.server],
      },
    ],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.items.length, 1);
  assert.equal(saved.data.items[0].role, 'primary');
  assert.deepEqual(saved.data.items[0].nodeIds, [
    chainNodes.site,
    chainNodes.gateway,
    chainNodes.sw,
    chainNodes.server,
  ]);
  assert.equal(saved.data.items[0].linkIds.length, 3);

  const list = await api(srv.base, 'GET', `/api/topology/diagrams/${chainDiagram.id}/paths`);
  assert.equal(list.status, 200);
  assert.equal(list.data.items.length, 1);

  const analysis = await api(srv.base, 'GET', `/api/topology/diagrams/${chainDiagram.id}/analysis`);
  assert.equal(analysis.status, 200);
  assert.equal(analysis.data.redundancy.groups.length, 1);
  assert.equal(analysis.data.redundancy.groups[0].primary.status, 'up');
  assert.equal(analysis.data.redundancy.groups[0].activeRole, 'primary');
});

test('disconnected path segments, duplicates and mismatched endpoints are rejected', async () => {
  const disconnected = await api(srv.base, 'PUT', `/api/topology/diagrams/${chainDiagram.id}/paths`, {
    paths: [
      {
        name: 'نامعتبر',
        role: 'primary',
        nodeIds: [chainNodes.site, chainNodes.server],
      },
    ],
  });
  assert.equal(disconnected.status, 400);
  assert.match(disconnected.data.error, /متصل نیستند/);

  const duplicateRole = await api(srv.base, 'PUT', `/api/topology/diagrams/${chainDiagram.id}/paths`, {
    paths: [
      { name: 'تکراری', role: 'primary', nodeIds: [chainNodes.site, chainNodes.gateway] },
      { name: 'تکراری', role: 'primary', nodeIds: [chainNodes.site, chainNodes.sw] },
    ],
  });
  assert.equal(duplicateRole.status, 400);

  const mismatch = await api(srv.base, 'PUT', `/api/topology/diagrams/${redundantDiagram.id}/paths`, {
    paths: [
      { name: 'مسیر B', role: 'primary', nodeIds: [redundantNodes.site, redundantNodes.a, redundantNodes.b] },
      { name: 'مسیر B', role: 'backup', nodeIds: [redundantNodes.site, redundantNodes.c] },
    ],
  });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.data.error, /شروع و پایان/);
});

test('a backup path becomes active when the primary is down', async () => {
  const saved = await api(srv.base, 'PUT', `/api/topology/diagrams/${redundantDiagram.id}/paths`, {
    paths: [
      { name: 'مسیر B', role: 'primary', nodeIds: [redundantNodes.site, redundantNodes.a, redundantNodes.b] },
      { name: 'مسیر B', role: 'backup', nodeIds: [redundantNodes.site, redundantNodes.c, redundantNodes.b] },
    ],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));

  const healthy = await api(srv.base, 'GET', `/api/topology/diagrams/${redundantDiagram.id}/analysis`);
  assert.equal(healthy.data.redundancy.groups[0].activeRole, 'primary');

  // قطع واقعی لینک A-B با ثبت آخرین سنجش اینترفیس (oper_status=down).
  // تجهیزات دو سر آنلاین می‌مانند تا فقط اثر همین لینک سنجیده شود.
  raw
    .prepare("UPDATE topology_links SET telemetry_enabled = 1, telemetry_agent = '127.0.0.1', telemetry_if_index = 1 WHERE id = ?")
    .run(redundantLinks.ab);
  const now = Date.now();
  raw
    .prepare(
      `INSERT INTO topology_link_telemetry(link_id, diagram_id, sampled_at, counters_at, rx_bps, tx_bps, util_pct, capacity_mbps, oper_status, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(link_id) DO UPDATE SET sampled_at = excluded.sampled_at, counters_at = excluded.counters_at,
         rx_bps = excluded.rx_bps, tx_bps = excluded.tx_bps, util_pct = excluded.util_pct,
         capacity_mbps = excluded.capacity_mbps, oper_status = excluded.oper_status, updated_at = excluded.updated_at`
    )
    .run(redundantLinks.ab, redundantDiagram.id, now, now, 0, 0, 0, 1000, 'down', now);
  const analysis = await api(
    srv.base,
    'GET',
    `/api/topology/diagrams/${redundantDiagram.id}/analysis`
  );
  assert.equal(analysis.status, 200, JSON.stringify(analysis.data));
  const group = analysis.data.redundancy.groups[0];
  assert.equal(group.primary.status, 'down');
  assert.equal(group.backup.status, 'up');
  assert.equal(group.activeRole, 'backup');
  assert.equal(group.failover, true);
  assert.equal(analysis.data.summary.activeBackupCount, 1);
});

test('a path id owned by another diagram cannot be stolen', async () => {
  const chainPaths = await api(srv.base, 'GET', `/api/topology/diagrams/${chainDiagram.id}/paths`);
  const ownedId = chainPaths.data.items[0].id;
  const res = await api(srv.base, 'PUT', `/api/topology/diagrams/${redundantDiagram.id}/paths`, {
    paths: [
      {
        id: ownedId,
        name: 'مسیر سرقتی',
        role: 'primary',
        nodeIds: [redundantNodes.site, redundantNodes.a, redundantNodes.b],
      },
    ],
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /دیاگرام دیگری/);
  const stillThere = await api(srv.base, 'GET', `/api/topology/diagrams/${chainDiagram.id}/paths`);
  assert.equal(stillThere.data.items[0].id, ownedId);
});

test('a locked diagram rejects path edits', async () => {
  const locked = await api(srv.base, 'POST', `/api/topology/diagrams/${redundantDiagram.id}/lock`, {
    locked: true,
  });
  assert.equal(locked.status, 200, JSON.stringify(locked.data));
  const res = await api(srv.base, 'PUT', `/api/topology/diagrams/${redundantDiagram.id}/paths`, {
    paths: [],
  });
  assert.equal(res.status, 423);
  await api(srv.base, 'POST', `/api/topology/diagrams/${redundantDiagram.id}/lock`, { locked: false });
});

test('impact and analysis reject malformed targets without touching the graph', async () => {
  const missing = await api(srv.base, 'GET', `/api/topology/diagrams/${chainDiagram.id}/impact`);
  assert.equal(missing.status, 400);
  const both = await api(
    srv.base,
    'GET',
    `/api/topology/diagrams/${chainDiagram.id}/impact?linkId=${chainLinks.core}&nodeId=${chainNodes.gateway}`
  );
  assert.equal(both.status, 400);
  const unknown = await api(
    srv.base,
    'GET',
    `/api/topology/diagrams/${chainDiagram.id}/impact?linkId=${randomUUID()}`
  );
  assert.equal(unknown.status, 404);
  const notFound = await api(srv.base, 'GET', '/api/topology/diagrams/999999/analysis');
  assert.equal(notFound.status, 404);
});
