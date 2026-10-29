/**
 * آزمون API دیاگرام‌های ماژولار:
 *   • ساخت دیاگرام ریشه و زیرمجموعهٔ درختی.
 *   • ذخیرهٔ مستقل اجزای هر دیاگرام (تجهیز، گروه، شکل، یادداشت، ارتباط).
 *   • جلوگیری از بازنویسی هم‌زمان با revision و رد پیوند معیوب.
 *   • حذف درختی (والد، زیرمجموعه‌ها را نیز حذف می‌کند).
 *   • تصویر/لوگوی بوم از همان سامانهٔ پیوست‌ها (آپلود/دریافت/حذف) و از دیاگرام
 *     دیگر قابل دسترسی نیست.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, cleanupDir, sessionFor, startServer, upload, useTempDataDir } from '../helpers.mjs';

// PNG یک‌پیکسلی معتبر (امضای فایل برای تشخیص نوع کافی است)
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const dir = useTempDataDir('diagrams');
let srv;

before(async () => {
  srv = await startServer({ dataDir: dir, engine: false });
});

after(async () => {
  await srv.stop();
  cleanupDir(dir);
});

const device = {
  id: 'd1',
  type: 'device',
  position: { x: 20, y: 40 },
  width: 190,
  height: 86,
  data: { label: 'سوئیچ مرکزی', deviceType: 'switch', color: '#2563eb', model: '2960', serial: 'SN-1', assetTag: 'A-1', description: 'هسته' },
};
const shape = {
  id: 's1',
  type: 'shape',
  position: { x: 320, y: 40 },
  width: 180,
  height: 110,
  data: { shape: 'rect', text: 'شبکهٔ دسترسی', color: '#dbeafe' },
};
const group = {
  id: 'g1',
  type: 'group',
  position: { x: 0, y: 0 },
  width: 360,
  height: 260,
  data: { label: 'طبقهٔ همکف', text: 'بخش دسترسی', color: '#60a5fa' },
};
const note = {
  id: 'n1',
  type: 'note',
  position: { x: 640, y: 40 },
  width: 220,
  height: 140,
  data: { label: 'یادداشت', text: 'فیبر در حال نصب', color: '#fef08a' },
};
const imageNode = {
  id: 'i1',
  type: 'image',
  position: { x: 80, y: 360 },
  width: 280,
  height: 180,
  data: { label: 'لوگو', src: '/api/diagrams/1/attachments/1/download', attachmentId: 1, caption: 'نقشهٔ طبقه' },
};
const edge = {
  id: 'e1',
  source: 'd1',
  target: 's1',
  sourceHandle: 'right',
  targetHandle: 'left',
  kind: 'fiber',
  label: 'uplink',
};

test('diagram tree stores each diagram independently and protects concurrent edits', async () => {
  const parent = await api(srv.base, 'POST', '/api/diagrams', { name: 'شبکهٔ تهران', description: 'کل شهر' });
  assert.equal(parent.status, 201, JSON.stringify(parent.data));
  const parentId = parent.data.id;

  const child = await api(srv.base, 'POST', '/api/diagrams', { name: 'مرکز مخابرات اول', parentId });
  assert.equal(child.status, 201, JSON.stringify(child.data));
  assert.equal(child.data.parentId, parentId);
  assert.deepEqual(child.data.nodes, []);
  const childId = child.data.id;

  const list = await api(srv.base, 'GET', '/api/diagrams');
  assert.equal(list.status, 200);
  assert.equal(list.data.items.length, 2);
  assert.equal(list.data.items.find((d) => d.id === childId).parentId, parentId);

  // محتوای دیاگرام فرزند
  const saved = await api(srv.base, 'PUT', `/api/diagrams/${childId}/content`, {
    revision: child.data.revision,
    nodes: [group, device, shape, note, imageNode],
    edges: [edge],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.revision, 2);
  assert.equal(saved.data.nodes.length, 5);
  assert.equal(saved.data.nodes.find((n) => n.id === 'g1').type, 'group');
  assert.equal(saved.data.nodes.find((n) => n.id === 'i1').type, 'image');
  assert.equal(saved.data.nodes.find((n) => n.id === 'i1').data.caption, 'نقشهٔ طبقه');
  assert.equal(saved.data.edges[0].kind, 'fiber');
  assert.equal(saved.data.edges[0].sourceHandle, 'right');
  assert.equal(saved.data.nodeCount, 5);
  assert.equal(saved.data.edgeCount, 1);

  // بازنویسی با نسخهٔ کهنه باید رد شود و محتوا دست‌نخورده بماند
  const stale = await api(srv.base, 'PUT', `/api/diagrams/${childId}/content`, {
    revision: 1,
    nodes: [],
    edges: [],
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'stale');
  assert.equal(stale.data.revision, 2);

  // دیاگرام والد مستقل است و محتوای خودش را دارد
  const parentGraph = await api(srv.base, 'PUT', `/api/diagrams/${parentId}/content`, {
    revision: parent.data.revision,
    nodes: [note],
    edges: [],
  });
  assert.equal(parentGraph.status, 200, JSON.stringify(parentGraph.data));
  const childAfter = await api(srv.base, 'GET', `/api/diagrams/${childId}`);
  assert.equal(childAfter.data.nodes.length, 5, 'ویرایش والد نباید فرزند را تغییر دهد');

  // پیوند نامعتبر و نوع ارتباط ناشناخته رد می‌شوند
  const badEdge = await api(srv.base, 'PUT', `/api/diagrams/${childId}/content`, {
    revision: 2,
    nodes: [device],
    edges: [{ ...edge, target: 'missing' }],
  });
  assert.equal(badEdge.status, 400);
  const badKind = await api(srv.base, 'PUT', `/api/diagrams/${childId}/content`, {
    revision: 2,
    nodes: [device, shape],
    edges: [{ ...edge, kind: 'satellite' }],
  });
  assert.equal(badKind.status, 400);
  const badType = await api(srv.base, 'PUT', `/api/diagrams/${childId}/content`, {
    revision: 2,
    nodes: [{ ...note, id: 'x1', type: 'unknown-part' }],
    edges: [],
  });
  assert.equal(badType.status, 400);

  // چرخه در درخت مجاز نیست
  const cycle = await api(srv.base, 'PUT', `/api/diagrams/${childId}`, { parentId: childId });
  assert.equal(cycle.status, 400);

  // حذف والد، زیرمجموعه را هم حذف می‌کند
  const removed = await api(srv.base, 'DELETE', `/api/diagrams/${parentId}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.data.deleted, 2);
  const gone = await api(srv.base, 'GET', `/api/diagrams/${childId}`);
  assert.equal(gone.status, 404);
});

test('diagram images use the attachment store and stay scoped to their diagram', async () => {
  const a = await api(srv.base, 'POST', '/api/diagrams', { name: 'دیاگرام تصویر' });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const other = await api(srv.base, 'POST', '/api/diagrams', { name: 'دیاگرام دیگر' });
  assert.equal(other.status, 201, JSON.stringify(other.data));

  const uploaded = await upload(srv.base, `/api/diagrams/${a.data.id}/attachments`, {
    filename: 'logo.png',
    content: PNG_1PX,
    type: 'image/png',
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
  assert.equal(uploaded.data.mime, 'image/png');
  assert.equal(uploaded.data.diagramId, a.data.id);
  assert.match(uploaded.data.downloadUrl, new RegExp(`^/api/diagrams/${a.data.id}/attachments/\\d+/download$`));
  const attachmentId = uploaded.data.id;

  const listed = await api(srv.base, 'GET', `/api/diagrams/${a.data.id}/attachments`);
  assert.equal(listed.status, 200);
  assert.equal(listed.data.items.length, 1);
  assert.equal(listed.data.items[0].id, attachmentId);

  // دانلود همان بایت‌ها را برمی‌گرداند (فایل از سامانهٔ پیوست‌ها سرو می‌شود).
  const session = sessionFor(srv.base);
  const download = await fetch(srv.base + uploaded.data.downloadUrl, {
    headers: { cookie: session.cookie, origin: srv.base },
  });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(bytes.length, PNG_1PX.length);
  assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG');

  // تصویر دیاگرام دیگر از مسیر این دیاگرام قابل خواندن نیست.
  const crossRead = await fetch(srv.base + `/api/diagrams/${other.data.id}/attachments/${attachmentId}/download`, {
    headers: { cookie: session.cookie, origin: srv.base },
  });
  assert.equal(crossRead.status, 404);

  // فایل غیرتصویری برای بوم پذیرفته نمی‌شود.
  const pdf = await upload(srv.base, `/api/diagrams/${a.data.id}/attachments`, {
    filename: 'doc.pdf',
    content: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n'),
    type: 'application/pdf',
  });
  assert.equal(pdf.status, 415);

  // تصویر دیاگرام دیگر از مسیر این دیاگرام قابل حذف نیست.
  const cross = await api(srv.base, 'DELETE', `/api/diagrams/${other.data.id}/attachments/${attachmentId}`);
  assert.equal(cross.status, 404);

  const removed = await api(srv.base, 'DELETE', `/api/diagrams/${a.data.id}/attachments/${attachmentId}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  const empty = await api(srv.base, 'GET', `/api/diagrams/${a.data.id}/attachments`);
  assert.equal(empty.data.items.length, 0);

  // حذف دیاگرام، ردیف‌های پیوست آن را نیز پاک می‌کند (Cascade).
  const second = await upload(srv.base, `/api/diagrams/${a.data.id}/attachments`, {
    filename: 'floor.png',
    content: PNG_1PX,
    type: 'image/png',
  });
  assert.equal(second.status, 201, JSON.stringify(second.data));
  await api(srv.base, 'DELETE', `/api/diagrams/${a.data.id}`);
  const gone = await api(srv.base, 'GET', `/api/diagrams/${a.data.id}/attachments`);
  assert.equal(gone.status, 404);
});
