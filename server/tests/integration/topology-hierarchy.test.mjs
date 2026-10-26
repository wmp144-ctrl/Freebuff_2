/**
 * آزمون یکپارچگی سلسله‌مراتب پایدار توپولوژی:
 *   • CRUD شهر/مرکز/ایستگاه/تجهیز و اتصال با شناسهٔ پایدار
 *   • مالکیت سازمانی جدا از ویژگی‌های لینک
 *   • به‌روزرسانی جزئی (فیلدهای دیگر دست‌نخورده می‌مانند)
 *   • اعتبارسنجی اتصال (گره ناموجود، خوداتصال، سطح نامعتبر، تکراری)
 *   • ذخیره و بازخوانی موقعیت گره‌ها
 *   • حذف آبشاری و شمارش دقیق
 *   • دسترسی فقط‌خواندنی Viewer
 *   • بارگذاری دادهٔ نمونه فقط در حالت توسعه و روی پایگاه‌دادهٔ خالی
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { useTempDataDir, cleanupDir, startServer, api } from '../helpers.mjs';

const dir = useTempDataDir('topology-hierarchy');
let srv;
let viewer;
let groupId;

const ids = {
  cityA: randomUUID(),
  cityB: randomUUID(),
  center: randomUUID(),
  station: randomUUID(),
  device: randomUUID(),
  device2: randomUUID(),
};

async function loginAs(base, username, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `ورود ${username} ناموفق بود`);
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  const csrf = cookies.find((c) => c.startsWith('nw_csrf='))?.slice('nw_csrf='.length) ?? '';
  return { cookie: cookies.join('; '), csrf };
}

async function call(base, session, method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'GET' ? {} : { origin: base }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function hierarchy(base) {
  const res = await api(base, 'GET', '/api/topology/hierarchy');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}

before(async () => {
  srv = await startServer({ dataDir: dir, engine: false });

  const group = await api(srv.base, 'POST', '/api/groups', {
    name: 'گروه عملیات شبکه',
    description: 'مالک سازمانی گره‌ها',
    color: '#0ea5e9',
  });
  assert.equal(group.status, 201, JSON.stringify(group.data));
  groupId = group.data.id;

  const created = await api(srv.base, 'POST', '/api/auth/users', {
    username: 'hierarchy-viewer',
    password: 'HierarchyViewer!2345',
    role: 'viewer',
    displayName: 'Hierarchy Viewer',
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  viewer = await loginAs(srv.base, 'hierarchy-viewer', 'HierarchyViewer!2345');
});

after(async () => {
  await srv.stop();
  cleanupDir(dir);
});

test('empty hierarchy is a valid, readable payload', async () => {
  const data = await hierarchy(srv.base);
  assert.deepEqual(data.nodes, []);
  assert.deepEqual(data.connections, []);
  assert.equal(data.demo, false);
  assert.equal(data.demoAvailable, false, 'بدون پرچم توسعه، نمونه فعال نیست');
  assert.ok(Array.isArray(data.groups));
  assert.ok(data.groups.some((g) => g.id === groupId));
});

test('creates cities, a center, a station and devices with city ownership', async () => {
  const cityA = await api(srv.base, 'POST', '/api/topology/hierarchy/nodes', {
    id: ids.cityA,
    kind: 'city',
    name: 'تهران آزمون',
    description: 'شهر آزمون',
    notes: 'یادداشت شهر',
    ownerGroupId: groupId,
    ip: '10.90.0.1',
    status: 'online',
    x: 120,
    y: 90,
    meta: { lat: 35.7, lng: 51.4 },
  });
  assert.equal(cityA.status, 201, JSON.stringify(cityA.data));
  assert.equal(cityA.data.cityId, ids.cityA);
  assert.equal(cityA.data.parentId, null);
  assert.equal(cityA.data.ownerGroupId, groupId);
  assert.equal(cityA.data.ownerGroupName, 'گروه عملیات شبکه');

  const cityB = await api(srv.base, 'POST', '/api/topology/hierarchy/nodes', {
    id: ids.cityB,
    kind: 'city',
    name: 'مشهد آزمون',
    status: 'warning',
  });
  assert.equal(cityB.status, 201);

  const center = await api(srv.base, 'POST', '/api/topology/hierarchy/nodes', {
    id: ids.center,
    kind: 'aggregation',
    name: 'مرکز تجمع آزمون',
    parentId: ids.cityA,
    ownerGroupId: groupId,
    location: 'سالن اصلی',
  });
  assert.equal(center.status, 201, JSON.stringify(center.data));
  assert.equal(center.data.parentId, ids.cityA);
  assert.equal(center.data.cityId, ids.cityA);

  const station = await api(srv.base, 'POST', '/api/topology/hierarchy/nodes', {
    id: ids.station,
    kind: 'station',
    name: 'ایستگاه آزمون',
    parentId: ids.cityA,
  });
  assert.equal(station.status, 201);

  const device = await api(srv.base, 'POST', '/api/topology/hierarchy/nodes', {
    id: ids.device,
    kind: 'router',
    name: 'روتر آزمون',
    parentId: ids.center,
    ip: '10.90.1.1',
    deviceType: 'روتر',
    vendor: 'Cisco',
    model: 'ISR 4451',
    ports: 24,
    status: 'online',
    x: 240,
    y: 260,
  });
  assert.equal(device.status, 201, JSON.stringify(device.data));
  assert.equal(device.data.cityId, ids.cityA);
  assert.equal(device.data.ports, 24);

  const device2 = await api(srv.base, 'POST', '/api/topology/hierarchy/nodes', {
    id: ids.device2,
    kind: 'switch',
    name: 'سوئیچ آزمون',
    parentId: ids.station,
    ip: '10.90.2.1',
  });
  assert.equal(device2.status, 201);

  const data = await hierarchy(srv.base);
  assert.equal(data.nodes.length, 6);
  assert.equal(data.stats.city, 2);
  assert.equal(data.stats.aggregation, 1);
  assert.equal(data.stats.station, 1);
  assert.equal(data.stats.device, 2);
  assert.equal(data.nodes.find((n) => n.id === ids.device2).cityId, ids.cityA);
});

test('rejects invalid hierarchy and duplicate submissions', async () => {
  const asDeviceParent = await api(srv.base, 'POST', '/api/topology/hierarchy/nodes', {
    kind: 'router',
    name: 'روتر بی‌معنا',
    parentId: ids.device,
  });
  assert.equal(asDeviceParent.status, 400);

  const cityWithParent = await api(srv.base, 'POST', '/api/topology/hierarchy/nodes', {
    kind: 'city',
    name: 'شهر فرزند',
    parentId: ids.cityA,
  });
  assert.equal(cityWithParent.status, 400);

  const missingParent = await api(srv.base, 'POST', '/api/topology/hierarchy/nodes', {
    kind: 'station',
    name: 'ایستگاه بی‌والد',
    parentId: randomUUID(),
  });
  assert.equal(missingParent.status, 400);

  const duplicateId = await api(srv.base, 'POST', '/api/topology/hierarchy/nodes', {
    id: ids.cityA,
    kind: 'city',
    name: 'شهر تکراری',
  });
  assert.equal(duplicateId.status, 409);

  const duplicateName = await api(srv.base, 'POST', '/api/topology/hierarchy/nodes', {
    kind: 'station',
    name: 'ایستگاه آزمون',
    parentId: ids.cityA,
  });
  assert.equal(duplicateName.status, 409, 'نام تکراری در یک شاخه باید رد شود');

  const sameNameOtherParent = await api(srv.base, 'POST', '/api/topology/hierarchy/nodes', {
    kind: 'station',
    name: 'ایستگاه آزمون',
    parentId: ids.cityB,
  });
  assert.equal(sameNameOtherParent.status, 201, 'نام تکراری در شاخهٔ دیگر مجاز است');

  const emptyName = await api(srv.base, 'POST', '/api/topology/hierarchy/nodes', {
    kind: 'city',
    name: '   ',
  });
  assert.equal(emptyName.status, 400);

  const badIp = await api(srv.base, 'POST', '/api/topology/hierarchy/nodes', {
    kind: 'router',
    name: 'روتر IP نامعتبر',
    parentId: ids.center,
    ip: ':::',
  });
  assert.equal(badIp.status, 400);

  const badKind = await api(srv.base, 'POST', '/api/topology/hierarchy/nodes', {
    kind: 'datacenter',
    name: 'نوع ناشناخته',
  });
  assert.equal(badKind.status, 400);
});

test('partial update changes only the supplied fields', async () => {
  const before = (await hierarchy(srv.base)).nodes.find((n) => n.id === ids.device);
  const res = await api(srv.base, 'PUT', `/api/topology/hierarchy/nodes/${ids.device}`, {
    notes: 'یادداشت تازه',
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.notes, 'یادداشت تازه');
  assert.equal(res.data.name, before.name);
  assert.equal(res.data.ip, before.ip);
  assert.equal(res.data.vendor, 'Cisco');
  assert.equal(res.data.model, 'ISR 4451');
  assert.equal(res.data.ports, 24);
  assert.equal(res.data.status, 'online');
  assert.equal(res.data.x, before.x);
  assert.equal(res.data.y, before.y);
  assert.equal(res.data.cityId, before.cityId);

  const invalidIp = await api(srv.base, 'PUT', `/api/topology/hierarchy/nodes/${ids.device}`, {
    ip: '999.1.1.1',
  });
  assert.equal(invalidIp.status, 400);
  assert.equal((await hierarchy(srv.base)).nodes.find((n) => n.id === ids.device).ip, before.ip);

  const kindChange = await api(srv.base, 'PUT', `/api/topology/hierarchy/nodes/${ids.device}`, {
    kind: 'switch',
  });
  assert.equal(kindChange.status, 400, 'نوع گره پس از ایجاد تغییر نمی‌کند');
});

test('moving a device between sites updates its city and descendants', async () => {
  const res = await api(srv.base, 'PUT', `/api/topology/hierarchy/nodes/${ids.device2}`, {
    parentId: ids.center,
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.parentId, ids.center);
  assert.equal(res.data.cityId, ids.cityA);

  const badParent = await api(srv.base, 'PUT', `/api/topology/hierarchy/nodes/${ids.device2}`, {
    parentId: ids.device,
  });
  assert.equal(badParent.status, 400);
});

test('connection CRUD validates endpoints, levels, duplicates and partial edits', async () => {
  const fiber = await api(srv.base, 'POST', '/api/topology/hierarchy/connections', {
    id: randomUUID(),
    sourceId: ids.cityA,
    targetId: ids.cityB,
    medium: 'fiber',
    capacityMbps: 10000,
    latencyMs: 12.5,
    sourcePort: 'xe-0/0/0',
    targetPort: 'xe-0/0/1',
    role: 'primary',
    label: 'مدار بین‌شهری',
    description: 'ستم اصلی',
    notes: 'یادداشت لینک',
    state: 'up',
  });
  assert.equal(fiber.status, 201, JSON.stringify(fiber.data));
  const fiberId = fiber.data.id;

  const uplink = await api(srv.base, 'POST', '/api/topology/hierarchy/connections', {
    sourceId: ids.center,
    targetId: ids.device,
    medium: 'ethernet',
    capacityMbps: 1000,
    role: 'primary',
    state: 'degraded',
  });
  assert.equal(uplink.status, 201, JSON.stringify(uplink.data));

  const backup = await api(srv.base, 'POST', '/api/topology/hierarchy/connections', {
    sourceId: ids.device,
    targetId: ids.center,
    medium: 'vpn',
    capacityMbps: 200,
    role: 'backup',
  });
  assert.equal(backup.status, 201, 'مسیر پشتیبان همان دو سر مجاز است');

  const duplicate = await api(srv.base, 'POST', '/api/topology/hierarchy/connections', {
    sourceId: ids.cityB,
    targetId: ids.cityA,
    medium: 'fiber',
    role: 'primary',
  });
  assert.equal(duplicate.status, 409, 'اتصال تکراری با همان نقش باید رد شود');
  assert.equal(duplicate.data.id, fiberId);

  const self = await api(srv.base, 'POST', '/api/topology/hierarchy/connections', {
    sourceId: ids.cityA,
    targetId: ids.cityA,
    medium: 'fiber',
  });
  assert.equal(self.status, 400);

  const missing = await api(srv.base, 'POST', '/api/topology/hierarchy/connections', {
    sourceId: ids.cityA,
    targetId: randomUUID(),
    medium: 'fiber',
  });
  assert.equal(missing.status, 400);

  const cityToDevice = await api(srv.base, 'POST', '/api/topology/hierarchy/connections', {
    sourceId: ids.cityA,
    targetId: ids.device,
    medium: 'fiber',
  });
  assert.equal(cityToDevice.status, 400);

  const crossCity = await api(srv.base, 'POST', '/api/topology/hierarchy/connections', {
    sourceId: ids.device,
    targetId: randomUUID(),
    medium: 'fiber',
  });
  assert.equal(crossCity.status, 400);

  const badMedium = await api(srv.base, 'POST', '/api/topology/hierarchy/connections', {
    sourceId: ids.center,
    targetId: ids.station,
    medium: 'coax',
  });
  assert.equal(badMedium.status, 400);

  // به‌روزرسانی جزئی: فقط یادداشت تغییر می‌کند
  const updated = await api(srv.base, 'PUT', `/api/topology/hierarchy/connections/${fiberId}`, {
    notes: 'یادداشت ویرایش‌شده',
    capacityMbps: 40000,
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.notes, 'یادداشت ویرایش‌شده');
  assert.equal(updated.data.capacityMbps, 40000);
  assert.equal(updated.data.latencyMs, 12.5);
  assert.equal(updated.data.sourcePort, 'xe-0/0/0');
  assert.equal(updated.data.label, 'مدار بین‌شهری');
  assert.equal(updated.data.medium, 'fiber');

  const badUpdate = await api(srv.base, 'PUT', `/api/topology/hierarchy/connections/${fiberId}`, {
    capacityMbps: -5,
  });
  assert.equal(badUpdate.status, 400);
});

test('layout positions are saved and restored', async () => {
  const res = await api(srv.base, 'PUT', '/api/topology/hierarchy/layout', {
    items: [
      { id: ids.cityA, x: 111, y: 222 },
      { id: ids.center, x: 333, y: 444 },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.updated, 2);

  const data = await hierarchy(srv.base);
  assert.equal(data.nodes.find((n) => n.id === ids.cityA).x, 111);
  assert.equal(data.nodes.find((n) => n.id === ids.cityA).y, 222);
  assert.equal(data.nodes.find((n) => n.id === ids.center).x, 333);

  const bad = await api(srv.base, 'PUT', '/api/topology/hierarchy/layout', {
    items: [
      { id: ids.cityB, x: 5, y: 5 },
      { id: randomUUID(), x: 6, y: 6 },
    ],
  });
  assert.equal(bad.status, 400);
  const after = await hierarchy(srv.base);
  assert.notEqual(after.nodes.find((n) => n.id === ids.cityB).x, 5, 'درخواست نامعتبر نباید نیمه‌کاره ذخیره شود');
});

test('viewer can read but not mutate; anonymous is rejected', async () => {
  const read = await call(srv.base, viewer, 'GET', '/api/topology/hierarchy');
  assert.equal(read.status, 200);
  const write = await call(srv.base, viewer, 'POST', '/api/topology/hierarchy/nodes', {
    kind: 'city',
    name: 'شهر توسط بیننده',
  });
  assert.equal(write.status, 403);

  const anonymous = await fetch(`${srv.base}/api/topology/hierarchy`);
  assert.equal(anonymous.status, 401);
});

test('demo seed is refused without the development flag', async () => {
  const res = await api(srv.base, 'POST', '/api/topology/hierarchy/demo-seed', {
    nodes: [{ kind: 'city', name: 'شهر نمونه' }],
    connections: [],
  });
  assert.equal(res.status, 403);
  assert.equal((await hierarchy(srv.base)).demo, false);
});

test('demo seed loads isolated fixture only on an empty database', async () => {
  const demoDir = useTempDataDir('topology-hierarchy-demo');
  const demo = await startServer({
    dataDir: demoDir,
    engine: false,
    env: { NETWATCH_DEMO_SEED: '1' },
  });
  try {
    const empty = await hierarchy(demo.base);
    assert.equal(empty.demoAvailable, true);
    assert.deepEqual(empty.nodes, []);

    // دادهٔ ناقص باید کل تراکنش را برگرداند
    const broken = await api(demo.base, 'POST', '/api/topology/hierarchy/demo-seed', {
      nodes: [
        { id: randomUUID(), kind: 'city', name: 'شهر نمونه' },
        { id: randomUUID(), kind: 'station', name: 'ایستگاه بی‌والد', parentId: randomUUID() },
      ],
      connections: [],
    });
    assert.equal(broken.status, 400);
    assert.deepEqual((await hierarchy(demo.base)).nodes, [], 'بارگذاری ناقص نباید چیزی ذخیره کند');

    const cityId = randomUUID();
    const siteId = randomUUID();
    const deviceId = randomUUID();
    const seeded = await api(demo.base, 'POST', '/api/topology/hierarchy/demo-seed', {
      nodes: [
        { id: cityId, kind: 'city', name: 'شهر نمونه', x: 10, y: 20, meta: { lat: 35.7, lng: 51.4 } },
        { id: siteId, kind: 'aggregation', name: 'مرکز نمونه', parentId: cityId, x: 30, y: 40 },
        { id: deviceId, kind: 'router', name: 'روتر نمونه', parentId: siteId, ip: '10.0.0.1', x: 50, y: 60 },
      ],
      connections: [
        {
          id: randomUUID(),
          sourceId: cityId,
          targetId: siteId,
          medium: 'fiber',
          capacityMbps: 1000,
          role: 'primary',
        },
      ],
    });
    assert.equal(seeded.status, 201, JSON.stringify(seeded.data));
    assert.deepEqual(seeded.data.inserted, { nodes: 3, connections: 1 });

    const data = await hierarchy(demo.base);
    assert.equal(data.demo, true);
    assert.equal(data.nodes.length, 3);
    assert.ok(data.nodes.every((n) => n.origin === 'demo'));
    assert.equal(data.connections[0].origin, 'demo');
    assert.equal(data.nodes.find((n) => n.id === deviceId).cityId, cityId);

    const again = await api(demo.base, 'POST', '/api/topology/hierarchy/demo-seed', {
      nodes: [{ kind: 'city', name: 'شهر دیگر' }],
      connections: [],
    });
    assert.equal(again.status, 409, 'بارگذاری دوباره روی دادهٔ موجود مجاز نیست');
  } finally {
    await demo.stop();
    cleanupDir(demoDir);
  }
});

test('deleting a site cascades its devices and connections with accurate counts', async () => {
  const before = await hierarchy(srv.base);
  const removedConnections = before.connections.filter(
    (c) => [c.source, c.target].includes(ids.center) || [c.source, c.target].includes(ids.device)
  ).length;
  const deleted = await api(srv.base, 'DELETE', `/api/topology/hierarchy/nodes/${ids.center}`);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.equal(deleted.data.deleted, 1);
  assert.ok(deleted.data.nodes >= 2, 'گره مرکز و تجهیز زیرمجموعه حذف می‌شوند');
  assert.equal(deleted.data.connections, removedConnections);

  const after = await hierarchy(srv.base);
  assert.equal(after.nodes.some((n) => n.id === ids.center), false);
  assert.equal(after.nodes.some((n) => n.id === ids.device), false);
  assert.equal(
    after.connections.some((c) => [c.source, c.target].includes(ids.center)),
    false,
    'لینک‌های متصل به گره حذف‌شده نباید باقی بمانند'
  );
});

test('missing resources return clear status codes', async () => {
  assert.equal((await api(srv.base, 'DELETE', `/api/topology/hierarchy/nodes/${randomUUID()}`)).status, 404);
  assert.equal((await api(srv.base, 'PUT', `/api/topology/hierarchy/nodes/${randomUUID()}`, { notes: 'x' })).status, 404);
  assert.equal(
    (await api(srv.base, 'PUT', `/api/topology/hierarchy/connections/${randomUUID()}`, { notes: 'x' })).status,
    404
  );
  assert.equal((await api(srv.base, 'DELETE', `/api/topology/hierarchy/connections/${randomUUID()}`)).status, 404);
});
