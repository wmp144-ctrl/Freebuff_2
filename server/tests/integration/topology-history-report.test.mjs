/**
 * آزمون یکپارچهٔ مرحلهٔ ۴ دیاگرام ارتباطات:
 *   • ثبت خودکار نسخه هنگام ایجاد/ویرایش گراف/مسیرها
 *   • تغییر ساختاریافته (افزودن، حذف، ویرایش) و مقایسهٔ نسخه‌ها
 *   • بازگردانی کامل به نسخهٔ قبلی و حفظ تاریخچه
 *   • گزارش واقعی ساختار/تجهیزات/مسیرها/لینک‌ها/ظرفیت/ریسک
 *   • خروجی Excel چندبرگی و PDF فارسی
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { useTempDataDir, cleanupDir, startServer, api } from '../helpers.mjs';

const dir = useTempDataDir('topology-history-report');
let srv;
let devices = [];
let diagram;
const ids = {
  site: randomUUID(),
  gateway: randomUUID(),
  sw: randomUUID(),
  linkA: randomUUID(),
  linkB: randomUUID(),
  linkC: randomUUID(),
  path: randomUUID(),
};
const firstGraph = {
  nodes: [
    { id: ids.site, kind: 'site', x: 40, y: 40 },
    { id: ids.gateway, kind: 'device', deviceId: null, label: 'Gateway', x: 300, y: 40 },
    { id: ids.sw, kind: 'device', deviceId: null, label: 'Core Switch', x: 560, y: 40 },
  ],
  links: [
    { id: ids.linkA, from: ids.site, to: ids.gateway, kind: 'fiber', label: 'uplink', capacityMbps: 1000 },
    { id: ids.linkB, from: ids.gateway, to: ids.sw, kind: 'fiber', label: 'core', capacityMbps: 1000 },
  ],
};

before(async () => {
  srv = await startServer({ dataDir: dir, engine: false });
  const list = await api(srv.base, 'GET', '/api/devices?pageSize=5');
  assert.equal(list.status, 200);
  devices = list.data.items.slice(0, 3);
  assert.equal(devices.length, 3, 'دادهٔ نمونه باید حداقل سه تجهیز داشته باشد');

  // مرکز تجمع و عضویت تجهیزات واقعی برای گزارش مراکز
  const site = await api(srv.base, 'POST', '/api/topology/sites', {
    name: 'مرکز دادهٔ آزمون',
    code: 'DC-T',
    address: 'سالن آزمون',
  });
  assert.equal(site.status, 201, JSON.stringify(site.data));
  const assigned = await api(srv.base, 'POST', `/api/topology/sites/${site.data.id}/devices`, {
    ids: devices.map((d) => d.id),
  });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.data));

  const created = await api(srv.base, 'POST', '/api/topology/diagrams', { name: 'دیاگرام تاریخچه' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  diagram = created.data;
  firstGraph.nodes[1].deviceId = devices[0].id;
  firstGraph.nodes[2].deviceId = devices[1].id;
  assert.equal(created.data.revision, 1);
});

after(async () => {
  if (srv) await srv.stop();
  cleanupDir(dir);
});

test('creating a diagram records the initial version', async () => {
  const versions = await api(srv.base, 'GET', `/api/topology/diagrams/${diagram.id}/versions`);
  assert.equal(versions.status, 200, JSON.stringify(versions.data));
  assert.equal(versions.data.items.length, 1);
  assert.equal(versions.data.items[0].action, 'create');
  assert.equal(versions.data.items[0].actionLabel, 'ایجاد دیاگرام');
  assert.equal(versions.data.items[0].summary.nodes, 0);
});

test('graph save records added nodes/links with structured changes', async () => {
  const saved = await api(srv.base, 'PUT', `/api/topology/diagrams/${diagram.id}/graph`, {
    revision: 1,
    nodes: firstGraph.nodes,
    links: firstGraph.links,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.revision, 2);
  assert.equal(saved.data.nodes.length, 3);
  assert.equal(saved.data.links.length, 2);

  const versions = await api(srv.base, 'GET', `/api/topology/diagrams/${diagram.id}/versions`);
  assert.equal(versions.status, 200);
  const latest = versions.data.items[0];
  assert.equal(latest.action, 'graph');
  assert.equal(latest.summary.nodes, 3);
  assert.equal(latest.summary.links, 2);
  assert.equal(latest.changeSummary.nodesAdded, 3);
  assert.equal(latest.changeSummary.linksAdded, 2);
  assert.equal(latest.changeSummary.total, 5);
});

test('editing and deleting records field-level differences and supports comparison', async () => {
  const changed = {
    nodes: [
      { id: ids.site, kind: 'site', x: 80, y: 80 },
      { id: ids.gateway, kind: 'device', deviceId: devices[0].id, label: 'Gateway اصلی', x: 320, y: 60 },
      { id: ids.sw, kind: 'device', deviceId: devices[1].id, label: 'Core Switch', x: 560, y: 40 },
      { id: randomUUID(), kind: 'device', deviceId: devices[2].id, label: 'Access Switch', x: 820, y: 40 },
    ],
    links: [
      { id: ids.linkA, from: ids.site, to: ids.gateway, kind: 'fiber', label: 'uplink', capacityMbps: 2000 },
      { id: ids.linkC, from: ids.sw, to: ids.sw, kind: 'fiber', label: 'invalid' },
    ],
  };
  // لینک خودارجاع باید رد شود؛ پیام دقیق برای تشخیص علت
  const invalid = await api(srv.base, 'PUT', `/api/topology/diagrams/${diagram.id}/graph`, {
    revision: 2,
    ...changed,
  });
  assert.equal(invalid.status, 400);
  assert.match(String(invalid.data.error), /خودش|لینک/);

  const nodeD = changed.nodes[3].id;
  const linkC = ids.linkC;
  const saved = await api(srv.base, 'PUT', `/api/topology/diagrams/${diagram.id}/graph`, {
    revision: 2,
    nodes: changed.nodes,
    links: [
      { id: ids.linkA, from: ids.site, to: ids.gateway, kind: 'fiber', label: 'uplink', capacityMbps: 2000 },
      { id: linkC, from: ids.sw, to: nodeD, kind: 'ethernet', label: 'access', capacityMbps: 100 },
    ],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.nodes.length, 4);
  assert.equal(saved.data.links.length, 2);

  const versions = await api(srv.base, 'GET', `/api/topology/diagrams/${diagram.id}/versions`);
  assert.equal(versions.status, 200);
  assert.equal(versions.data.items[0].summary.nodes, 4);
  const summary = versions.data.items[0].changeSummary;
  assert.equal(summary.nodesAdded, 1);
  assert.equal(summary.nodesUpdated, 2);
  assert.equal(summary.linksAdded, 1);
  assert.equal(summary.linksRemoved, 1);
  const firstGraphVersion = versions.data.items.find((item) => item.summary.nodes === 3);
  assert.ok(firstGraphVersion, 'نسخهٔ گراف اول باید در تاریخچه باشد');

  const detail = await api(srv.base, 'GET', `/api/topology/diagrams/${diagram.id}/versions/${firstGraphVersion.id}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  assert.equal(detail.data.snapshot.nodes.length, 3);
  assert.equal(detail.data.snapshot.links.length, 2);

  const compare = await api(
    srv.base,
    'GET',
    `/api/topology/diagrams/${diagram.id}/versions/compare?a=${firstGraphVersion.id}&b=current`
  );
  assert.equal(compare.status, 200, JSON.stringify(compare.data));
  const diff = compare.data.changes;
  assert.equal(diff.summary.nodesAdded, 1);
  assert.equal(diff.summary.nodesUpdated, 2);
  assert.equal(diff.summary.linksAdded, 1);
  assert.equal(diff.summary.linksRemoved, 1);
  const gateway = diff.nodes.updated.items.find((item) => item.id === ids.gateway);
  assert.ok(gateway.fields.some((field) => field.field === 'label' && field.after === 'Gateway اصلی'));
  assert.ok(gateway.fields.some((field) => field.field === 'position'));
  const capacity = diff.links.updated.items.find((item) => item.id === ids.linkA);
  assert.ok(capacity.fields.some((field) => field.field === 'capacityMbps' && field.after === 2000));
});

test('paths are versioned and included in reports', async () => {
  const saved = await api(srv.base, 'PUT', `/api/topology/diagrams/${diagram.id}/paths`, {
    paths: [
      {
        id: ids.path,
        name: 'مسیر اصلی دفتر',
        role: 'primary',
        nodeIds: [ids.site, ids.gateway],
      },
    ],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.items.length, 1);

  const versions = await api(srv.base, 'GET', `/api/topology/diagrams/${diagram.id}/versions`);
  assert.equal(versions.data.items[0].action, 'paths');
  assert.equal(versions.data.items[0].summary.paths, 1);
  assert.equal(versions.data.items[0].changeSummary.pathsAdded, 1);
});

test('report uses real graph, site, path and capacity data', async () => {
  const report = await api(srv.base, 'GET', `/api/topology/diagrams/${diagram.id}/report`);
  assert.equal(report.status, 200, JSON.stringify(report.data));
  const data = report.data;
  assert.equal(data.diagram.id, diagram.id);
  assert.equal(data.structure.deviceNodeCount, 3);
  assert.equal(data.structure.siteNodeCount, 1);
  assert.equal(data.structure.linkCount, 2);
  assert.equal(data.devices.length, 3);
  assert.equal(data.sites.length, 1);
  assert.equal(data.sites[0].deviceCount, 3);
  assert.equal(data.paths.length, 1);
  assert.equal(data.paths[0].name, 'مسیر اصلی دفتر');
  assert.ok(['up', 'degraded', 'down', 'unknown'].includes(data.paths[0].primary.status));
  assert.equal(data.pathCounts.primary, 1);
  assert.equal(data.pathCounts.backup, 0);
  assert.equal(data.pathCounts.withoutBackup, 1);
  assert.equal(data.capacity.configuredCount, 2);
  assert.equal(data.capacity.totalCapacityMbps, 2100);
  assert.equal(data.links.length, 2);
  assert.ok(['up', 'degraded', 'down', 'unknown'].includes(data.links[0].status));
  assert.ok(data.links[0].reason.length > 0);
  assert.ok(Array.isArray(data.risks.criticalNodes));
  assert.ok(data.generatedAt <= Date.now());
});

test('Excel export contains real multi-sheet data', async () => {
  const res = await fetch(`${srv.base}/api/topology/diagrams/${diagram.id}/report/export?format=xlsx`, {
    headers: {
      cookie: srv.session.cookie,
    },
  });
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-type')), /spreadsheetml/);
  const buffer = Buffer.from(await res.arrayBuffer());
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  assert.ok(wb.SheetNames.includes('خلاصه'));
  assert.ok(wb.SheetNames.includes('تجهیزات'));
  assert.ok(wb.SheetNames.includes('مسیرها'));
  assert.ok(wb.SheetNames.includes('ظرفیت و مصرف'));
  const devicesSheet = XLSX.utils.sheet_to_json(wb.Sheets['تجهیزات']);
  assert.equal(devicesSheet.length, 3);
  assert.ok(devicesSheet.some((row) => String(row['IP']).length > 0));
  const summarySheet = XLSX.utils.sheet_to_json(wb.Sheets['خلاصه'], { header: 1 });
  assert.ok(summarySheet.some((row) => row[0] === 'تعداد لینک' && row[1] === 2));
});

test('PDF export is a valid Persian report document', async () => {
  const res = await fetch(`${srv.base}/api/topology/diagrams/${diagram.id}/report/export?format=pdf`, {
    headers: { cookie: srv.session.cookie },
  });
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-type')), /application\/pdf/);
  const buffer = Buffer.from(await res.arrayBuffer());
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
  assert.ok(buffer.length > 15000, `PDF unexpectedly small: ${buffer.length}`);
  assert.ok(buffer.includes(Buffer.from('%%EOF')));
});

test('restore returns the graph to an earlier version and keeps history', async () => {
  const versionsBefore = await api(srv.base, 'GET', `/api/topology/diagrams/${diagram.id}/versions`);
  const firstGraphVersion = versionsBefore.data.items.find(
    (item) => item.action === 'graph' && item.summary.nodes === 3
  );
  assert.ok(firstGraphVersion);
  const renamed = await api(srv.base, 'PUT', `/api/topology/diagrams/${diagram.id}`, {
    name: 'نام موقت برای آزمون بازگردانی',
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal(renamed.data.name, 'نام موقت برای آزمون بازگردانی');

  const current = await api(srv.base, 'GET', `/api/topology/diagrams/${diagram.id}`);
  assert.equal(current.status, 200);

  const restored = await api(
    srv.base,
    'POST',
    `/api/topology/diagrams/${diagram.id}/versions/${firstGraphVersion.id}/restore`,
    { revision: current.data.revision }
  );
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.equal(restored.data.name, 'دیاگرام تاریخچه');
  assert.equal(restored.data.nodes.length, 3);
  assert.equal(restored.data.links.length, 2);
  assert.equal(restored.data.nodes.find((n) => n.id === ids.gateway).label, 'Gateway');
  assert.equal(restored.data.nodes.some((n) => n.id === ids.sw && n.label === 'Core Switch'), true);
  assert.equal(restored.data.restoredFrom, firstGraphVersion.id);

  const paths = await api(srv.base, 'GET', `/api/topology/diagrams/${diagram.id}/paths`);
  assert.equal(paths.status, 200);
  assert.equal(paths.data.items.length, 0, 'مسیرهای ساخته‌شده پس از نسخهٔ بازگردانی‌شده باید برداشته شوند');

  const versionsAfter = await api(srv.base, 'GET', `/api/topology/diagrams/${diagram.id}/versions`);
  assert.equal(versionsAfter.status, 200);
  assert.equal(versionsAfter.data.items[0].action, 'restore');
  assert.equal(versionsAfter.data.items[0].restoredFrom, firstGraphVersion.id);
  assert.equal(versionsAfter.data.items[1].action, 'pre-restore');
  assert.ok(versionsAfter.data.items.length > versionsBefore.data.items.length);
});

test('locked diagram refuses restore and report still works', async () => {
  const versions = await api(srv.base, 'GET', `/api/topology/diagrams/${diagram.id}/versions`);
  const target = versions.data.items[0];
  const lock = await api(srv.base, 'POST', `/api/topology/diagrams/${diagram.id}/lock`, { locked: true });
  assert.equal(lock.status, 200, JSON.stringify(lock.data));
  const blocked = await api(
    srv.base,
    'POST',
    `/api/topology/diagrams/${diagram.id}/versions/${target.id}/restore`,
    {}
  );
  assert.equal(blocked.status, 423);
  assert.match(String(blocked.data.error), /قفل/);

  const report = await api(srv.base, 'GET', `/api/topology/diagrams/${diagram.id}/report`);
  assert.equal(report.status, 200);
  assert.equal(report.data.diagram.locked, true);
  const pdf = await fetch(`${srv.base}/api/topology/diagrams/${diagram.id}/report/export?format=pdf`, {
    headers: { cookie: srv.session.cookie },
  });
  assert.equal(pdf.status, 200);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
});
