/**
 * آزمون مدل سلسله‌مراتب توپولوژی — مرحله ۱
 * قفل کردن سه چیز:
 *   ۱. الگوی خطِ رسانه‌های انتقال (فیبر پیوسته، بی‌سیم خط‌چین، …)
 *   ۲. رفتار دامنه‌ها و ناوبری سه‌سطحی (سراسری، شهر، جزئیات)
 *   ۳. درستی ساختار دادهٔ نمونه (شناسهٔ یکتا، والد موجود، لینک معتبر، …)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEDIA_META,
  MEDIUM_ORDER,
  breadcrumbFor,
  buildTree,
  childrenOf,
  connectionBodyFromDraft,
  connectionCreateError,
  connectionDraftFrom,
  countDescendants,
  datasetFromPayload,
  drillScope,
  edgesForScope,
  indexNodes,
  nodeBodyFromDraft,
  nodeDraftFrom,
  nodeFromApi,
  parentCandidates,
  validateConnectionDraft,
  validateCreateNode,
  validateNodeDraft,
  isDrillable,
  layoutLayered,
  layoutScope,
  nodeMatches,
  nodesForScope,
  scopeAnchor,
  scopeStats,
  visibleTreeIds,
  type TopologyDataset,
} from '../src/lib/topology-hierarchy.ts';
import { buildSampleTopology } from '../src/lib/topology-sample.ts';

const dataset: TopologyDataset = buildSampleTopology();
const byId = indexNodes(dataset.nodes);

test('رسانه‌های انتقال همان الگوی خط خواسته‌شده را دارند', () => {
  assert.equal(MEDIA_META.fiber.color, '#0d9488');
  assert.equal(MEDIA_META.fiber.dash, '', 'فیبر باید خط پیوسته باشد');
  assert.equal(MEDIA_META.wireless.color, '#9333ea');
  assert.match(MEDIA_META.wireless.dash, /\d+\s+\d+/, 'بی‌سیم باید خط‌چین باشد');
  assert.equal(MEDIA_META.ethernet.color, '#2563eb');
  assert.ok(MEDIA_META.ethernet.dash.length > 0, 'اترت باید نقطه‌چین باشد');
  assert.equal(MEDIA_META.vpn.color, '#d97706');
  assert.equal(MEDIA_META.vpn.dash.split(/\s+/).length, 4, 'VPN باید الگوی نقطه-خط داشته باشد');
  assert.deepEqual(MEDIUM_ORDER, ['fiber', 'wireless', 'ethernet', 'vpn']);
});

test('دادهٔ نمونه ساختار درست و یکتا دارد', () => {
  const ids = new Set<string>();
  for (const node of dataset.nodes) {
    assert.ok(!ids.has(node.id), `شناسهٔ تکراری: ${node.id}`);
    ids.add(node.id);
    if (node.parentId) assert.ok(byId.has(node.parentId), `والد ناموجود برای ${node.id}`);
    if (node.kind !== 'city') assert.ok(node.cityId && byId.get(node.cityId)?.kind === 'city');
  }
  assert.equal(dataset.source, 'sample');

  const edgeIds = new Set<string>();
  for (const edge of dataset.edges) {
    assert.ok(!edgeIds.has(edge.id), `شناسهٔ لینک تکراری: ${edge.id}`);
    edgeIds.add(edge.id);
    assert.ok(byId.has(edge.source), `مبدأ ناموجود: ${edge.source}`);
    assert.ok(byId.has(edge.target), `مقصد ناموجود: ${edge.target}`);
    assert.ok(MEDIUM_ORDER.includes(edge.medium), `رسانهٔ نامعتبر: ${edge.medium}`);
    assert.notEqual(edge.source, edge.target, 'لینک نباید به خود گره وصل شود');
  }

  // هر شهر حداقل یک مرکز/ایستگاه و هر مرکز/ایستگاه حداقل یک تجهیز دارد
  for (const city of dataset.nodes.filter((n) => n.kind === 'city')) {
    const sites = childrenOf(dataset.nodes, city.id);
    assert.ok(sites.length > 0, `شهر ${city.name} مرکز/ایستگاه ندارد`);
    for (const site of sites) {
      assert.ok(isDrillable(site));
      assert.ok(childrenOf(dataset.nodes, site.id).length > 0, `${site.name} تجهیزی ندارد`);
    }
  }

  // هر چهار رسانه در داده حضور دارند
  for (const medium of MEDIUM_ORDER) {
    assert.ok(dataset.edges.some((e) => e.medium === medium), `رسانهٔ ${medium} در داده نیست`);
  }
});

test('نمای سراسری فقط شهرها و خطوط بین‌شهری را دارد (بی‌شلوغی)', () => {
  const scope = { level: 'global' as const };
  const nodes = nodesForScope(dataset.nodes, scope);
  const edges = edgesForScope(dataset.nodes, dataset.edges, scope);

  assert.equal(nodes.length, 5);
  assert.ok(nodes.every((n) => n.kind === 'city'));
  assert.ok(edges.length <= 8, 'نمای سراسری نباید شلوغ شود');
  assert.ok(edges.every((e) => byId.get(e.source)?.kind === 'city' && byId.get(e.target)?.kind === 'city'));
  assert.equal(scopeAnchor(scope), null);
});

test('نمای شهر مراکز و ایستگاه‌ها را با اتصال به شهر نشان می‌دهد', () => {
  const scope = { level: 'city' as const, cityId: 'city-thr' };
  const nodes = nodesForScope(dataset.nodes, scope);
  const edges = edgesForScope(dataset.nodes, dataset.edges, scope);

  assert.ok(nodes.length >= 3);
  assert.ok(nodes.every((n) => n.parentId === 'city-thr' && (n.kind === 'aggregation' || n.kind === 'station')));
  assert.ok(edges.some((e) => e.source === 'city-thr' || e.target === 'city-thr'), 'اتصال به لنگر شهر لازم است');
  assert.ok(edges.some((e) => e.source !== 'city-thr' && e.target !== 'city-thr'), 'لینک بین مراکز/ایستگاه‌ها لازم است');
  // لینک‌های داخل تجهیزات نباید در این سطح دیده شوند
  const deviceKinds = new Set(['router', 'switch', 'firewall', 'server', 'access-point', 'other']);
  assert.ok(!edges.some((e) => deviceKinds.has(byId.get(e.source)!.kind) || deviceKinds.has(byId.get(e.target)!.kind)));
});

test('نمای جزئیات شبکهٔ داخلی مرکز را کامل می‌آورد', () => {
  const scope = { level: 'detail' as const, parentId: 'agg-thr-n' };
  const nodes = nodesForScope(dataset.nodes, scope);
  const edges = edgesForScope(dataset.nodes, dataset.edges, scope);

  assert.ok(nodes.length >= 6);
  assert.ok(nodes.every((n) => n.parentId === 'agg-thr-n'));
  assert.ok(edges.some((e) => e.source === 'agg-thr-n' || e.target === 'agg-thr-n'), 'لینک بالارونده به مرکز');
  assert.ok(edges.every((e) => byId.get(e.source)?.parentId === 'agg-thr-n' || e.source === 'agg-thr-n'));
  assert.equal(scopeAnchor(scope), 'agg-thr-n');

  // ساختار داخلی شامل روتر، سوئیچ و فایروال است
  const kinds = new Set(nodes.map((n) => n.kind));
  assert.ok(kinds.has('router') && kinds.has('switch') && kinds.has('firewall'));
});

test('ورود به سطح‌ها و نان‌العریس درست است', () => {
  assert.deepEqual(drillScope(byId.get('city-thr')!), { level: 'city', cityId: 'city-thr' });
  assert.deepEqual(drillScope(byId.get('agg-thr-n')!), { level: 'detail', parentId: 'agg-thr-n' });
  assert.deepEqual(drillScope(byId.get('st-thr-vnk')!), { level: 'detail', parentId: 'st-thr-vnk' });
  assert.equal(drillScope(byId.get('dev-vnk-r')!), null);

  const crumbs = breadcrumbFor(byId, { level: 'detail', parentId: 'agg-thr-n' });
  assert.deepEqual(
    crumbs.map((c) => c.label),
    ['کل شبکه', 'تهران', 'مرکز تجمع تهران شمال']
  );
  assert.deepEqual(crumbs[0].scope, { level: 'global' });
  assert.deepEqual(crumbs[1].scope, { level: 'city', cityId: 'city-thr' });
});

test('جست‌وجو مسیر نتیجه را در درخت باز نگه می‌دارد', () => {
  assert.ok(nodeMatches(byId.get('st-thr-vnk')!, 'ونک'));
  assert.ok(nodeMatches(byId.get('dev-vnk-r')!, '10.20.11.1'));

  const visible = visibleTreeIds(dataset.nodes, 'ونک');
  assert.ok(visible.has('st-thr-vnk'));
  assert.ok(visible.has('city-thr'), 'والد نتیجه باید در درخت بماند');
  assert.ok(!visible.has('city-mhd'));

  const tree = buildTree(dataset.nodes, visible);
  assert.ok(tree.some((root) => root.node.id === 'city-thr'));
  assert.equal(tree.filter((root) => root.node.id === 'city-mhd').length, 0);
});

test('چیدمان هر سطح برای همهٔ گره‌ها مختصات یکتا می‌دهد', () => {
  const scopes = [
    { level: 'global' as const },
    { level: 'city' as const, cityId: 'city-thr' },
    { level: 'detail' as const, parentId: 'agg-thr-n' },
  ];
  for (const scope of scopes) {
    const anchor = scopeAnchor(scope);
    const visible = nodesForScope(dataset.nodes, scope);
    const anchorNode = anchor ? byId.get(anchor)! : null;
    const nodes = anchorNode ? [anchorNode, ...visible] : visible;
    const edges = edgesForScope(dataset.nodes, dataset.edges, scope);
    const layout = layoutScope(nodes, edges, scope.level);

    assert.equal(Object.keys(layout).length, nodes.length);
    const seen = new Set<string>();
    for (const node of nodes) {
      const point = layout[node.id];
      assert.ok(point, `مختصات ${node.id} نیست`);
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
      const key = `${point.x}:${point.y}`;
      assert.ok(!seen.has(key), `دو گره هم‌مختصات‌اند: ${node.id}`);
      seen.add(key);
    }
  }
});

test('چیدمان جغرافیایی شهرها از مختصات meta استفاده می‌کند', () => {
  const cities = nodesForScope(dataset.nodes, { level: 'global' });
  const layout = layoutScope(cities, [], 'global');
  // تهران شمالی‌تر از شیراز است، پس y کمتری دارد
  assert.ok(layout['city-thr'].y < layout['city-shz'].y);
  // مشهد شرقی‌تر از تبریز است، پس x بیشتری دارد
  assert.ok(layout['city-mhd'].x > layout['city-tbz'].x);
});

test('چیدمان لایه‌ای ریشهٔ دامنه را در بالاترین ردیف می‌گذارد', () => {
  const nodes = [byId.get('agg-thr-n')!, ...nodesForScope(dataset.nodes, { level: 'detail', parentId: 'agg-thr-n' })];
  const edges = edgesForScope(dataset.nodes, dataset.edges, { level: 'detail', parentId: 'agg-thr-n' });
  const layout = layoutLayered(nodes, edges);
  const rootY = layout['agg-thr-n'].y;
  for (const node of nodes) {
    if (node.id === 'agg-thr-n') continue;
    assert.ok(layout[node.id].y >= rootY, 'گره‌ها نباید بالاتر از ریشه باشند');
  }
});

test('آمار دامنه وضعیت و ترکیب رسانه‌ها را می‌شمارد', () => {
  const scope = { level: 'detail' as const, parentId: 'agg-thr-n' };
  const nodes = nodesForScope(dataset.nodes, scope);
  const edges = edgesForScope(dataset.nodes, dataset.edges, scope);
  const stats = scopeStats(nodes, edges);

  assert.equal(stats.nodes, nodes.length);
  assert.equal(stats.edges, edges.length);
  assert.equal(stats.online + stats.offline + stats.warning + stats.unknown, nodes.length);
  assert.equal(
    stats.byMedium.fiber + stats.byMedium.wireless + stats.byMedium.ethernet + stats.byMedium.vpn,
    edges.length
  );
  assert.ok(stats.offline >= 1, 'دادهٔ نمونه یک تجهیز قطع دارد');
});

test('تعداد زیرمجموعه‌ها و ساخت درخت درست است', () => {
  assert.equal(countDescendants(dataset.nodes, 'city-thr'), childrenOf(dataset.nodes, 'city-thr').reduce((sum, child) => sum + 1 + countDescendants(dataset.nodes, child.id), 0));
  const tree = buildTree(dataset.nodes);
  assert.equal(tree.length, 5);
  assert.ok(tree.every((root) => root.node.kind === 'city'));
  const تهران = tree.find((root) => root.node.id === 'city-thr')!;
  assert.ok(تهران.children.length >= 3);
});

test('ساخت دوباره آرایه‌ها مستقل است (ویرایش، دادهٔ ماژول را تغییر نمی‌دهد)', () => {
  const first = buildSampleTopology();
  const second = buildSampleTopology();
  first.nodes[0].name = 'تغییر یافته';
  assert.notEqual(second.nodes[0].name, 'تغییر یافته');
});

/* ------------------------------------------------------------------ */
/* مرحله ۲ — نگاشت API، پیش‌نویس فرم و اعتبارسنجی                        */
/* ------------------------------------------------------------------ */

test('نگاشت ردیف API همهٔ فیلدهای پایدار را حفظ می‌کند', () => {
  const row = {
    id: 'n-1',
    kind: 'router' as const,
    parentId: 'p-1',
    cityId: 'c-1',
    name: 'روتر لبه',
    description: 'توضیح',
    notes: 'یادداشت',
    location: 'سالن ۱',
    ownerGroupId: 7,
    ownerGroupName: 'عملیات',
    ownerGroupColor: '#0ea5e9',
    ip: '10.0.0.1',
    deviceType: 'Router',
    vendor: 'Cisco',
    model: 'ISR',
    ports: 24,
    status: 'online' as const,
    x: 120,
    y: 240,
    meta: { rack: 'R1' },
    origin: 'user' as const,
    createdAt: 1,
    updatedAt: 2,
  };
  const model = nodeFromApi(row);
  assert.equal(model.id, 'n-1');
  assert.equal(model.cityId, 'c-1');
  assert.equal(model.ownerGroupId, 7);
  assert.equal(model.ownerGroupName, 'عملیات');
  assert.equal(model.ports, 24);
  assert.deepEqual(model.meta, { rack: 'R1' });
  assert.equal(model.x, 120);

  const payload = datasetFromPayload({
    nodes: [row],
    connections: [
      {
        id: 'e-1',
        source: 'n-1',
        target: 'p-1',
        medium: 'fiber' as const,
        capacityMbps: 10000,
        latencyMs: 2,
        sourcePort: 'xe-0',
        targetPort: 'xe-1',
        role: 'backup' as const,
        label: 'مدار',
        description: 'توضیح',
        notes: 'یادداشت',
        state: 'degraded' as const,
        meta: {},
        origin: 'demo' as const,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  });
  assert.equal(payload.source, 'live');
  assert.equal(payload.demo, true, 'وجود ردیف نمونه باید پرچم demo را روشن کند');
  assert.equal(payload.edges[0].sourcePort, 'xe-0');
  assert.equal(payload.edges[0].role, 'backup');
  assert.equal(payload.edges[0].state, 'degraded');
});

test('اعتبارسنجی پیش‌نویس گره و بدنهٔ ارسال', () => {
  const draft = nodeDraftFrom(byId.get('dev-thr-n-core')!);
  assert.deepEqual(validateNodeDraft({ ...draft, name: '   ' }).name, 'نام الزامی است.');
  assert.ok(validateNodeDraft({ ...draft, ip: '999.1.1.1' }).ip, 'IP با اکتت نامعتبر رد می‌شود');
  assert.ok(validateNodeDraft({ ...draft, ports: '5000' }).ports, 'پورت خارج از بازه رد می‌شود');
  assert.ok(validateNodeDraft({ ...draft, notes: 'x'.repeat(4001) }).notes);
  assert.equal(validateNodeDraft({ ...draft, ip: '10.0.0.1' }).ip, undefined);
  assert.equal(validateNodeDraft({ ...draft, ip: 'core-1.example.net' }).ip, undefined);

  const body = nodeBodyFromDraft({ ...draft, name: '  نام تازه  ', ports: '', ownerGroupId: '' });
  assert.equal(body.name, 'نام تازه');
  assert.equal(body.ports, null);
  assert.equal(body.ownerGroupId, null);
  assert.deepEqual(Object.keys(body).sort(), [
    'description',
    'deviceType',
    'ip',
    'location',
    'model',
    'name',
    'notes',
    'ownerGroupId',
    'ports',
    'status',
    'vendor',
  ]);
  assert.equal(body.kind, undefined, 'بدنهٔ ویرایش نباید نوع گره را بفرستد');
});

test('اعتبارسنجی پیش‌نویس لینک و بدنهٔ ارسال', () => {
  const edge = dataset.edges.find((e) => e.medium === 'fiber')!;
  const draft = connectionDraftFrom(edge);
  assert.equal(draft.role, 'primary');
  assert.ok(validateConnectionDraft({ ...draft, capacityMbps: '0' }).capacityMbps);
  assert.ok(validateConnectionDraft({ ...draft, capacityMbps: 'x' }).capacityMbps);
  assert.ok(validateConnectionDraft({ ...draft, latencyMs: '-1' }).latencyMs);
  assert.equal(validateConnectionDraft({ ...draft, capacityMbps: '1000' }).capacityMbps, undefined);

  const body = connectionBodyFromDraft({ ...draft, capacityMbps: '', latencyMs: '  ', label: ' مدار ' });
  assert.equal(body.capacityMbps, null);
  assert.equal(body.latencyMs, null);
  assert.equal(body.label, 'مدار');
  assert.equal(body.sourceId, undefined, 'ویرایش لینک نباید دو سر را دوباره بفرستد');
});

test('قواعد پیش‌بررسی اتصال با سرور هم‌سو است', () => {
  assert.match(connectionCreateError(dataset.nodes, dataset.edges, 'city-thr', 'city-thr', 'primary')!, /خودش/);
  assert.match(
    connectionCreateError(dataset.nodes, dataset.edges, 'city-thr', 'dev-thr-n-core', 'primary')!,
    /شهر به تجهیز/
  );
  assert.match(
    connectionCreateError(dataset.nodes, dataset.edges, 'dev-thr-n-core', 'dev-mhd-core', 'primary')!,
    /شهرهای مختلف/
  );
  assert.match(
    connectionCreateError(dataset.nodes, dataset.edges, 'city-thr', 'city-mhd', 'primary')!,
    /از قبل وجود دارد/
  );
  assert.equal(connectionCreateError(dataset.nodes, dataset.edges, 'city-thr', 'city-mhd', 'backup'), null);
  assert.equal(connectionCreateError(dataset.nodes, dataset.edges, 'agg-thr-n', 'city-thr', 'backup'), null);
});

test('اعتبارسنجی ساخت گره با والد درست', () => {
  assert.equal(parentCandidates(dataset.nodes, 'city').length, 0);
  assert.ok(parentCandidates(dataset.nodes, 'aggregation').every((n) => n.kind === 'city'));
  assert.ok(parentCandidates(dataset.nodes, 'router').every((n) => n.kind === 'aggregation' || n.kind === 'station'));

  assert.ok(validateCreateNode(dataset.nodes, { kind: 'city', name: '', parentId: '' }).name);
  assert.ok(validateCreateNode(dataset.nodes, { kind: 'station', name: 'ایستگاه', parentId: '' }).parentId);
  assert.ok(
    validateCreateNode(dataset.nodes, { kind: 'router', name: 'روتر', parentId: 'city-thr' }).parentId,
    'والد تجهیز باید مرکز/ایستگاه باشد'
  );
  const existingName = dataset.nodes.find((n) => n.parentId === 'city-thr')!.name;
  assert.ok(
    validateCreateNode(dataset.nodes, { kind: 'aggregation', name: existingName, parentId: 'city-thr' }).name,
    'نام تکراری در همان شاخه رد می‌شود'
  );
  assert.deepEqual(validateCreateNode(dataset.nodes, { kind: 'station', name: 'ایستگاه تازه', parentId: 'city-thr' }), {});
});
