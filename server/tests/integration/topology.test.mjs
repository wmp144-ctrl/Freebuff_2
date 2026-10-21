/**
 * آزمون یکپارچگی ماژول دیاگرام ارتباطات شبکه:
 *   • مراکز تجمع با شناسهٔ یکتا و عضویت انحصاری تجهیزات
 *   • ذخیرهٔ گراف با revision (جلوگیری از بازنویسی هم‌زمان)
 *   • حفظ ساختار پس از حذف تجهیز (گره به «حذف‌شده» تبدیل می‌شود)
 *   • قفل دیاگرام، تکثیر، الگو و خروجی JSON
 *   • دسترسی Viewer فقط خواندنی
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { useTempDataDir, cleanupDir, startServer, api } from '../helpers.mjs';

const dir = useTempDataDir('topology-api');
let srv;
let devices = [];
let siteId;
let diagramId;
let nodeIds;
let viewer;

async function loginAs(username, password) {
  const res = await fetch(`${srv.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: srv.base },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `ورود ${username} ناموفق بود`);
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  const csrf = cookies.find((c) => c.startsWith('nw_csrf='))?.slice('nw_csrf='.length) ?? '';
  return { cookie: cookies.join('; '), csrf };
}

async function call(session, method, url, body) {
  const res = await fetch(`${srv.base}${url}`, {
    method,
    headers: {
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'GET' ? {} : { origin: srv.base }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

before(async () => {
  srv = await startServer({ dataDir: dir, engine: false });
  const list = await api(srv.base, 'GET', '/api/devices?pageSize=5');
  assert.equal(list.status, 200);
  devices = list.data.items.slice(0, 3);
  assert.ok(devices.length >= 3, 'دادهٔ نمونه باید حداقل سه تجهیز داشته باشد');

  const created = await api(srv.base, 'POST', '/api/auth/users', {
    username: 'topology-viewer',
    password: 'TopologyViewer!2345',
    role: 'viewer',
    displayName: 'Topology Viewer',
  });
  assert.equal(created.status, 201);
  viewer = await loginAs('topology-viewer', 'TopologyViewer!2345');
});

after(async () => {
  await srv.stop();
  cleanupDir(dir);
});

test('sites are structured, uniquely named and each device belongs to one site', async () => {
  const created = await api(srv.base, 'POST', '/api/topology/sites', {
    name: 'مرکز داده آزمون',
    code: 'DC-TEST',
    address: 'سالن آزمون',
    notes: 'یادداشت مرکز',
    color: '#0ea5e9',
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  siteId = created.data.id;
  assert.ok(Number.isInteger(siteId));
  assert.equal(created.data.code, 'DC-TEST');

  const duplicate = await api(srv.base, 'POST', '/api/topology/sites', { name: 'مرکز داده آزمون' });
  assert.equal(duplicate.status, 400, 'نام تکراری باید رد شود');

  const assign = await api(srv.base, 'POST', `/api/topology/sites/${siteId}/devices`, {
    ids: devices.map((d) => d.id),
    mode: 'assign',
  });
  assert.equal(assign.status, 200, JSON.stringify(assign.data));
  assert.equal(assign.data.affected, 3);
  assert.equal(assign.data.site.deviceCount, 3);

  const secondSite = await api(srv.base, 'POST', '/api/topology/sites', { name: 'مرکز داده دوم' });
  assert.equal(secondSite.status, 201);
  await api(srv.base, 'POST', `/api/topology/sites/${secondSite.data.id}/devices`, {
    ids: [devices[0].id],
    mode: 'assign',
  });
  const sites = await api(srv.base, 'GET', '/api/topology/sites');
  assert.equal(sites.status, 200);
  const first = sites.data.items.find((s) => s.id === siteId);
  const second = sites.data.items.find((s) => s.id === secondSite.data.id);
  assert.equal(first.deviceCount, 2, 'انتقال تجهیز باید عضویت قبلی را حذف کند');
  assert.equal(second.deviceCount, 1);
  await api(srv.base, 'DELETE', `/api/topology/sites/${secondSite.data.id}`);

  const badAssign = await api(srv.base, 'POST', `/api/topology/sites/${siteId}/devices`, { ids: [999999], mode: 'assign' });
  assert.equal(badAssign.status, 400);
});

test('diagram graph persists nodes and links with stable unique ids', async () => {
  const created = await api(srv.base, 'POST', '/api/topology/diagrams', {
    name: 'دیاگرام آزمون',
    description: 'برای آزمون یکپارچگی',
    layout: 'hierarchy-lr',
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  diagramId = created.data.id;
  assert.equal(created.data.revision, 1);
  assert.deepEqual(created.data.nodes, []);

  nodeIds = { a: randomUUID(), b: randomUUID(), c: randomUUID(), note: randomUUID() };
  const linkIds = { fiber: randomUUID(), eth: randomUUID() };
  const nodes = [
    { id: nodeIds.a, kind: 'device', deviceId: devices[0].id, x: 40, y: 40, notes: 'سوییچ اصلی' },
    { id: nodeIds.b, kind: 'device', deviceId: devices[1].id, x: 360, y: 40 },
    { id: nodeIds.c, kind: 'site', siteId, x: 200, y: 260, label: 'مرکز تجمع' },
    { id: nodeIds.note, kind: 'note', label: 'یادداشت پروژه', notes: 'متن یادداشت', x: 620, y: 260 },
  ];
  const links = [
    { id: linkIds.fiber, from: nodeIds.a, to: nodeIds.b, kind: 'fiber', label: 'فیبر اصلی', notes: 'مسیر A' },
    { id: linkIds.eth, from: nodeIds.a, to: nodeIds.c, kind: 'ethernet' },
  ];
  const saved = await api(srv.base, 'PUT', `/api/topology/diagrams/${diagramId}/graph`, { revision: 1, nodes, links });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.revision, 2);
  assert.equal(saved.data.nodes.length, 4);
  assert.equal(saved.data.links.length, 2);
  const deviceNode = saved.data.nodes.find((n) => n.id === nodeIds.a);
  assert.equal(deviceNode.deviceId, devices[0].id);
  assert.equal(deviceNode.device.name, devices[0].name, 'دادهٔ واقعی تجهیز باید به گره بپیوندد');
  assert.equal(deviceNode.notes, 'سوییچ اصلی');
  const siteNode = saved.data.nodes.find((n) => n.id === nodeIds.c);
  assert.equal(siteNode.site.code, 'DC-TEST');
  assert.equal(siteNode.site.deviceCount, 2);
  assert.ok(saved.data.links.some((l) => l.id === linkIds.fiber && l.notes === 'مسیر A'));
  assert.equal(saved.data.stats.placeholders, 0);

  // ذخیرهٔ دوم: ویرایش، حذف گره/لینک و افزودن لینک تازه — شناسه‌ها پایدار می‌مانند.
  const nextNodes = nodes
    .filter((n) => n.id !== nodeIds.note)
    .map((n) => (n.id === nodeIds.a ? { ...n, x: 55, y: 60, notes: 'یادداشت ویرایش‌شده' } : n));
  const nextLinks = [
    links[0],
    { id: randomUUID(), from: nodeIds.b, to: nodeIds.c, kind: 'wireless', label: 'لینک رادیویی' },
  ];
  const second = await api(srv.base, 'PUT', `/api/topology/diagrams/${diagramId}/graph`, {
    revision: 2,
    nodes: nextNodes,
    links: nextLinks,
  });
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.equal(second.data.revision, 3);
  assert.equal(second.data.nodes.length, 3);
  assert.equal(second.data.links.length, 2);
  const edited = second.data.nodes.find((n) => n.id === nodeIds.a);
  assert.equal(edited.notes, 'یادداشت ویرایش‌شده');
  assert.equal(edited.x, 55);
  assert.equal(second.data.links.find((l) => l.from === nodeIds.a && l.to === nodeIds.b).notes, 'مسیر A');

  // نسخهٔ کهنه نباید دادهٔ تازه را بازنویسی کند.
  const stale = await api(srv.base, 'PUT', `/api/topology/diagrams/${diagramId}/graph`, {
    revision: 2,
    nodes: nextNodes,
    links: nextLinks,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.revision, 3);

  const badLink = await api(srv.base, 'PUT', `/api/topology/diagrams/${diagramId}/graph`, {
    revision: 3,
    nodes: nextNodes,
    links: [{ id: randomUUID(), from: nodeIds.a, to: randomUUID() }],
  });
  assert.equal(badLink.status, 400, 'لینک به گرهٔ خارج از دیاگرام باید رد شود');

  const duplicateDevice = await api(srv.base, 'PUT', `/api/topology/diagrams/${diagramId}/graph`, {
    revision: 3,
    nodes: [...nextNodes, { id: randomUUID(), kind: 'device', deviceId: devices[0].id }],
    links: nextLinks,
  });
  assert.equal(duplicateDevice.status, 400, 'یک تجهیز نباید دو گره داشته باشد');
});

test('locked diagrams reject edits until unlocked', async () => {
  const locked = await api(srv.base, 'POST', `/api/topology/diagrams/${diagramId}/lock`, { locked: true });
  assert.equal(locked.status, 200);
  assert.equal(locked.data.locked, true);

  const graph = await api(srv.base, 'PUT', `/api/topology/diagrams/${diagramId}/graph`, {
    revision: 3,
    nodes: [],
    links: [],
  });
  assert.equal(graph.status, 423);
  const meta = await api(srv.base, 'PUT', `/api/topology/diagrams/${diagramId}`, { name: 'نام تازه' });
  assert.equal(meta.status, 423);
  const duplicate = await api(srv.base, 'POST', `/api/topology/diagrams/${diagramId}/duplicate`, { name: 'کپی' });
  assert.equal(duplicate.status, 201, 'قفل نباید مانع خواندن یا تکثیر شود');

  const unlocked = await api(srv.base, 'POST', `/api/topology/diagrams/${diagramId}/lock`, { locked: false });
  assert.equal(unlocked.status, 200);
  assert.equal(unlocked.data.locked, false);
  await api(srv.base, 'DELETE', `/api/topology/diagrams/${duplicate.data.id}`);
});

test('duplicate, template and template instantiation preserve structure with new ids', async () => {
  const template = await api(srv.base, 'POST', `/api/topology/diagrams/${diagramId}/template`, { name: 'الگوی آزمون' });
  assert.equal(template.status, 201, JSON.stringify(template.data));
  assert.equal(template.data.isTemplate, true);
  assert.equal(template.data.nodes.length, 3);
  assert.equal(template.data.links.length, 2);

  const fromTemplate = await api(srv.base, 'POST', '/api/topology/diagrams', {
    name: 'دیاگرام از الگو',
    fromTemplateId: template.data.id,
  });
  assert.equal(fromTemplate.status, 201, JSON.stringify(fromTemplate.data));
  assert.equal(fromTemplate.data.nodes.length, 3);
  assert.equal(fromTemplate.data.links.length, 2);
  assert.notEqual(fromTemplate.data.revision, undefined);
  const templateIds = new Set(template.data.nodes.map((n) => n.id));
  assert.ok(fromTemplate.data.nodes.every((n) => !templateIds.has(n.id)), 'شناسه‌های نمونهٔ تازه باید یکتا باشند');
  assert.equal(new Set(fromTemplate.data.links.map((l) => l.id)).size, 2);

  const duplicate = await api(srv.base, 'POST', `/api/topology/diagrams/${fromTemplate.data.id}/duplicate`, {
    name: 'کپی نهایی',
  });
  assert.equal(duplicate.status, 201);
  assert.equal(duplicate.data.nodes.length, 3);

  const exported = await api(srv.base, 'GET', `/api/topology/diagrams/${diagramId}/export`);
  assert.equal(exported.status, 200);
  assert.equal(exported.data.format, 'netwatch-topology');
  assert.equal(exported.data.nodes.length, 3);
  assert.equal(exported.data.links.length, 2);

  await api(srv.base, 'DELETE', `/api/topology/diagrams/${template.data.id}`);
  await api(srv.base, 'DELETE', `/api/topology/diagrams/${fromTemplate.data.id}`);
  await api(srv.base, 'DELETE', `/api/topology/diagrams/${duplicate.data.id}`);
});

test('device catalog exposes live status and placement, and deleting a device keeps the graph', async () => {
  const catalog = await api(
    srv.base,
    'GET',
    `/api/topology/device-catalog?diagramId=${diagramId}&search=${encodeURIComponent(devices[1].ip)}`
  );
  assert.equal(catalog.status, 200);
  const found = catalog.data.items.find((d) => d.id === devices[1].id);
  assert.ok(found, 'تجهیز جست‌وجوشده باید در کاتالوگ باشد');
  assert.equal(found.nodeId, nodeIds.b, 'گرهٔ موجود باید در کاتالوگ مشخص باشد');
  assert.equal(found.siteName, 'مرکز داده آزمون');

  const before = await api(srv.base, 'GET', `/api/topology/diagrams/${diagramId}`);
  const removed = await api(srv.base, 'DELETE', `/api/devices/${devices[0].id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  const afterDelete = await api(srv.base, 'GET', `/api/topology/diagrams/${diagramId}`);
  assert.equal(afterDelete.status, 200);
  assert.equal(afterDelete.data.nodes.length, before.data.nodes.length, 'حذف تجهیز نباید گره را حذف کند');
  const orphan = afterDelete.data.nodes.find((n) => n.id === nodeIds.a);
  assert.equal(orphan.device, null);
  assert.equal(orphan.kind, 'device');
  assert.equal(afterDelete.data.stats.placeholders, 1);
});

test('viewer can read the topology but cannot change it', async () => {
  const read = await call(viewer, 'GET', '/api/topology/overview');
  assert.equal(read.status, 200);
  const diagramRead = await call(viewer, 'GET', `/api/topology/diagrams/${diagramId}`);
  assert.equal(diagramRead.status, 200);

  const create = await call(viewer, 'POST', '/api/topology/diagrams', { name: 'نباید ساخته شود' });
  assert.equal(create.status, 403);
  const save = await call(viewer, 'PUT', `/api/topology/diagrams/${diagramId}/graph`, { revision: 1, nodes: [], links: [] });
  assert.equal(save.status, 403);
  const site = await call(viewer, 'POST', '/api/topology/sites', { name: 'نباید ساخته شود' });
  assert.equal(site.status, 403);
});

test('overview reports aggregate counts', async () => {
  const res = await api(srv.base, 'GET', '/api/topology/overview');
  assert.equal(res.status, 200);
  assert.ok(res.data.diagrams.some((d) => d.id === diagramId));
  assert.ok(res.data.sites.some((s) => s.id === siteId));
  assert.ok(res.data.stats.deviceTotal >= 2);
  assert.ok(res.data.stats.diagramTotal >= 1);
  assert.ok(Array.isArray(res.data.templates));
});
