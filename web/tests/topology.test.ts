import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SIZE,
  edgeGeometry,
  fitViewport,
  graphBounds,
  layoutGraph,
  nodeMatches,
  screenToWorld,
  snap,
  toGraphPayload,
  worldToScreen,
  zoomAt,
} from '../src/lib/topology.ts';
import type { TopoLink, TopoNode } from '../src/lib/types.ts';

let seq = 0;
function node(partial: Partial<TopoNode> & { id: string }): TopoNode {
  const kind = partial.kind ?? 'device';
  const size = DEFAULT_SIZE[kind];
  const deviceId = partial.deviceId ?? (kind === 'device' ? ++seq : null);
  return {
    kind,
    deviceId,
    siteId: null,
    label: '',
    notes: '',
    x: 0,
    y: 0,
    width: size.width,
    height: size.height,
    color: '',
    z: 0,
    meta: {},
    device:
      kind === 'device'
        ? {
            id: deviceId ?? 1,
            name: partial.label || `dev-${deviceId}`,
            ip: `10.0.0.${deviceId ?? 1}`,
            deviceType: 'سوئیچ',
            status: 'online',
            lastRtt: 4,
            lossPct: 0,
            lastCheckAt: Date.now(),
            location: '',
            groupId: 1,
            groupName: 'هسته',
            groupColor: '#2563eb',
            priority: 'normal',
          }
        : null,
    site: null,
    ...partial,
  };
}

function link(id: string, from: string, to: string): TopoLink {
  return { id, from, to, kind: 'ethernet', label: '', notes: '', color: '', style: 'solid', meta: {} };
}

function overlaps(a: TopoNode, pa: { x: number; y: number }, b: TopoNode, pb: { x: number; y: number }, gap = 0): boolean {
  return (
    pa.x < pb.x + b.width + gap &&
    pb.x < pa.x + a.width + gap &&
    pa.y < pb.y + b.height + gap &&
    pb.y < pa.y + a.height + gap
  );
}

test('zoom at a cursor point keeps the world point under the cursor fixed', () => {
  const view = { x: 40, y: -20, zoom: 1 };
  const point = { x: 300, y: 180 };
  const before = screenToWorld(view, point.x, point.y);
  const next = zoomAt(view, 2.1, point.x, point.y);
  const after = screenToWorld(next, point.x, point.y);
  assert.ok(Math.abs(before.x - after.x) < 1e-9, 'world x must stay under the cursor');
  assert.ok(Math.abs(before.y - after.y) < 1e-9, 'world y must stay under the cursor');
  assert.equal(next.zoom, 2.1);
});

test('screen/world transforms are inverse operations', () => {
  const view = { x: 120, y: 55, zoom: 0.75 };
  const screen = worldToScreen(view, 420, -80);
  const world = screenToWorld(view, screen.x, screen.y);
  assert.ok(Math.abs(world.x - 420) < 1e-9);
  assert.ok(Math.abs(world.y + 80) < 1e-9);
});

test('fit viewport centers all nodes and respects canvas bounds', () => {
  const nodes = [
    node({ id: 'a', x: 100, y: 100 }),
    node({ id: 'b', x: 900, y: 500 }),
  ];
  const view = fitViewport(nodes, 1200, 700, 50);
  const b = graphBounds(nodes, 50);
  const centerScreen = worldToScreen(view, b.x + b.width / 2, b.y + b.height / 2);
  assert.ok(Math.abs(centerScreen.x - 600) < 0.001);
  assert.ok(Math.abs(centerScreen.y - 350) < 0.001);
  assert.ok(b.width * view.zoom <= 1200 + 0.001);
  assert.ok(b.height * view.zoom <= 700 + 0.001);
});

test('vertical hierarchy puts each level below its parent without overlap', () => {
  const nodes = [
    node({ id: 'root', x: 999, y: -999 }),
    node({ id: 'a', x: 0, y: 0 }),
    node({ id: 'b', x: 0, y: 0 }),
    node({ id: 'c', x: 0, y: 0 }),
  ];
  const links = [link('l1', 'root', 'a'), link('l2', 'root', 'b'), link('l3', 'a', 'c')];
  const positions = layoutGraph(nodes, links, 'hierarchy-tb');
  assert.equal(Object.keys(positions).length, 4);
  const root = positions.root;
  assert.ok(positions.a.y > root.y, 'level 1 must be below root');
  assert.ok(positions.c.y > positions.a.y, 'level 2 must be below level 1');
  assert.ok(Math.abs(positions.a.y - positions.b.y) < 0.001, 'same level shares a row');
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const first = nodes[i];
      const second = nodes[j];
      assert.equal(
        overlaps(first, positions[first.id], second, positions[second.id]),
        false,
        `${first.id} overlaps ${second.id}`
      );
    }
  }
});

test('horizontal hierarchy grows along the x axis', () => {
  const nodes = [node({ id: 'r' }), node({ id: 'a' }), node({ id: 'b' })];
  const links = [link('l1', 'r', 'a'), link('l2', 'a', 'b')];
  const positions = layoutGraph(nodes, links, 'hierarchy-lr');
  assert.ok(positions.a.x > positions.r.x);
  assert.ok(positions.b.x > positions.a.x);
  assert.equal(overlaps(nodes[0], positions.r, nodes[1], positions.a), false);
  assert.equal(overlaps(nodes[1], positions.a, nodes[2], positions.b), false);
});

test('grid layout places every node on a non-overlapping lattice', () => {
  const nodes = Array.from({ length: 12 }, (_, i) => node({ id: `n${i}` }));
  const positions = layoutGraph(nodes, [], 'grid');
  const cells = nodes.map((n) => positions[n.id]);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      assert.equal(overlaps(nodes[i], cells[i], nodes[j], cells[j]), false, `grid overlap ${i}/${j}`);
    }
  }
});

test('radial layout spreads levels around a center and keeps nodes distinct', () => {
  const nodes = [node({ id: 'core' }), ...Array.from({ length: 8 }, (_, i) => node({ id: `leaf${i}` }))];
  const links = nodes.slice(1).map((n, i) => link(`l${i}`, 'core', n.id));
  const positions = layoutGraph(nodes, links, 'radial');
  const leaves = nodes.slice(1).map((n) => positions[n.id]);
  const unique = new Set(leaves.map((p) => `${Math.round(p.x)}:${Math.round(p.y)}`));
  assert.equal(unique.size, leaves.length);
  const distances = leaves.map((p) => Math.hypot(p.x - positions.core.x, p.y - positions.core.y));
  assert.ok(Math.max(...distances) - Math.min(...distances) < 1, 'leaves share one ring');
  assert.ok(Math.min(...distances) > 100);
});

test('auto layout is deterministic and does not mutate nodes', () => {
  const nodes = [node({ id: 'a', x: 5, y: 6 }), node({ id: 'b', x: 7, y: 8 })];
  const before = nodes.map((n) => ({ x: n.x, y: n.y }));
  const first = layoutGraph(nodes, [link('l', 'a', 'b')], 'hierarchy-tb');
  const second = layoutGraph(nodes, [link('l', 'a', 'b')], 'hierarchy-tb');
  assert.deepEqual(first, second);
  assert.deepEqual(nodes.map((n) => ({ x: n.x, y: n.y })), before);
});

test('edge geometry starts and ends on node borders', () => {
  const left = node({ id: 'left', x: 0, y: 0 });
  const right = node({ id: 'right', x: 500, y: 0 });
  const geo = edgeGeometry(left, right);
  assert.ok(Math.abs(geo.from.x - (left.x + left.width)) < 0.001, 'source anchor is on right border');
  assert.ok(Math.abs(geo.to.x - right.x) < 0.001, 'target anchor is on left border');
  assert.ok(geo.from.y >= left.y && geo.from.y <= left.y + left.height);
  assert.ok(geo.d.startsWith('M '));

  const vertical = edgeGeometry(left, node({ id: 'below', x: 0, y: 400 }), 'orthogonal');
  assert.ok(vertical.d.includes('V '));
  assert.equal(vertical.from.y, left.y + left.height);
});

test('node filter matches device fields and respects status/group filters', () => {
  const sw = node({ id: 'sw' });
  sw.device!.name = 'سوئیچ طبقه دو';
  sw.device!.ip = '192.168.10.22';
  sw.device!.status = 'offline';
  sw.device!.groupId = 4;
  sw.notes = 'اتاق سرور';
  assert.equal(nodeMatches(sw, { query: 'سوئیچ' }), true);
  assert.equal(nodeMatches(sw, { query: '192.168 10.22' }), true);
  assert.equal(nodeMatches(sw, { query: 'اتاق سرور' }), true);
  assert.equal(nodeMatches(sw, { query: 'ناموجود' }), false);
  assert.equal(nodeMatches(sw, { statuses: ['offline'] }), true);
  assert.equal(nodeMatches(sw, { statuses: ['online'] }), false);
  assert.equal(nodeMatches(sw, { groupId: 4 }), true);
  assert.equal(nodeMatches(sw, { groupId: 2 }), false);

  const site = node({ id: 'site', kind: 'site', siteId: 2, deviceId: null, device: null, label: 'دیتاسنتر' });
  assert.equal(nodeMatches(site, { query: 'دیتاسنتر' }), true);
  assert.equal(nodeMatches(site, { query: 'دیتاسنتر', statuses: ['offline'] }), true, 'non-device nodes are not filtered by status');
});

test('save payload strips live device data and keeps editable graph fields', () => {
  const n = node({ id: 'n1', x: 30, y: 40 });
  n.notes = 'یادداشت';
  const l = link('l1', 'n1', 'n1');
  const payload = toGraphPayload([n], [l]);
  const saved = payload.nodes[0] as Record<string, unknown>;
  assert.equal(saved.id, 'n1');
  assert.equal(saved.x, 30);
  assert.equal(saved.notes, 'یادداشت');
  assert.equal('device' in saved, false);
  assert.equal(payload.links[0].id, 'l1');
  assert.equal(snap(33, 20), 40);
  assert.equal(snap(29, 20), 20);
});
