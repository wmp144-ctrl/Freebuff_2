/**
 * آزمون موتور تحلیل مرحلهٔ ۳:
 *   • پل‌ها (تنها مسیر) و نقاط برشی (تجهیزات واسط بحرانی)
 *   • شمارش تجهیزات وابسته و اثر قطع لینک/گره
 *   • مسیر مشکل‌دار تا مرکز زیرساخت و محل دقیق قطع
 *   • مسیر اصلی/پشتیبان و فعال‌شدن خودکار پشتیبان
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeTopology,
  simulateTopologyImpact,
  inferNodeRole,
} from '../../topology-analysis.js';

const site = (id, name = 'مرکز') => ({
  id,
  kind: 'site',
  label: '',
  site: { id: 1, name },
  siteId: 1,
  device: null,
});
const device = (id, name, status = 'online', deviceType = 'switch', meta = {}) => ({
  id,
  kind: 'device',
  label: '',
  deviceId: Number(String(id).replace(/\D/g, '')) || 1,
  meta,
  device: { id: 1, name, ip: `10.0.0.${id}`, deviceType, status, statusReason: '' },
});
const link = (id, from, to, status = 'up', label = '') => ({
  id,
  from,
  to,
  kind: 'fiber',
  label,
  live: { status },
});

function chain() {
  const nodes = [
    site('s', 'مرکز اصلی'),
    device('g', 'Core-Router', 'online', 'router'),
    device('sw', 'Edge-Switch', 'online', 'switch'),
    device('d1', 'Access-1', 'online', 'server'),
    device('d2', 'Access-2', 'online', 'server'),
  ];
  const links = [
    link('l1', 's', 'g', 'up', 'uplink'),
    link('l2', 'g', 'sw', 'up', 'core-edge'),
    link('l3', 'sw', 'd1', 'up', 'edge-1'),
    link('l4', 'sw', 'd2', 'up', 'edge-2'),
  ];
  return { nodes, links };
}

test('a linear chain reports bridges, critical nodes and dependent device counts', () => {
  const { nodes, links } = chain();
  const result = analyzeTopology({ nodes, links });
  assert.equal(result.anchorSource, 'explicit');
  assert.deepEqual(result.anchors.map((a) => a.id), ['s']);
  assert.equal(result.summary.deviceCount, 4);
  assert.equal(result.summary.reachableDeviceCount, 4);

  const byNode = new Map(result.criticalNodes.map((n) => [n.id, n]));
  assert.equal(byNode.get('g').dependentDeviceCount, 3);
  assert.equal(byNode.get('sw').dependentDeviceCount, 2);
  assert.equal(byNode.get('g').severity, 'critical');
  assert.equal(byNode.get('sw').severity, 'critical');
  assert.equal(byNode.get('g').role, 'router');
  assert.equal(byNode.get('sw').role, 'switch');

  const byLink = new Map(result.riskyLinks.map((l) => [l.id, l]));
  assert.equal(byLink.get('l1').dependentDeviceCount, 4);
  assert.equal(byLink.get('l2').dependentDeviceCount, 3);
  assert.equal(byLink.get('l2').bridge, true);
  assert.equal(byLink.get('l3').dependentDeviceCount, 1);
});

test('a cycle gives redundant links, so cutting one link disconnects nothing', () => {
  const nodes = [
    site('s'),
    device('a', 'Distribution-A', 'online', 'switch'),
    device('b', 'Distribution-B', 'online', 'switch'),
    device('c', 'Distribution-C', 'online', 'switch'),
  ];
  const links = [
    link('sa', 's', 'a'),
    link('ab', 'a', 'b'),
    link('ac', 'a', 'c'),
    link('bc', 'b', 'c'),
  ];
  const result = analyzeTopology({ nodes, links });
  assert.equal(result.riskyLinks.some((l) => l.id === 'ab'), false);
  assert.equal(result.criticalNodes.find((n) => n.id === 'a').dependentDeviceCount, 2);

  const impact = simulateTopologyImpact({ nodes, links, target: { type: 'link', id: 'ab' } });
  assert.equal(impact.summary.affectedDeviceCount, 0);
  assert.equal(impact.summary.alternateRoute, true);
});

test('current down link marks the affected downstream and shows the exact cut path', () => {
  const { nodes, links } = chain();
  links.find((l) => l.id === 'l2').live.status = 'down';
  const result = analyzeTopology({ nodes, links });
  assert.equal(result.summary.affectedDeviceCount, 3);
  assert.equal(result.live.affectedNodeIds.length, 3);
  assert.ok(result.live.problemLinkIds.includes('l2'));
  assert.ok(result.live.problemPathLinkIds.includes('l2'));
  assert.ok(result.live.problemPathLinkIds.includes('l1'));

  const incident = result.live.incidents.find((item) => item.id === 'l2');
  assert.ok(incident);
  assert.equal(incident.type, 'link');
  assert.equal(incident.affectedDeviceCount, 3);

  const cut = result.live.cutPaths.find((item) => item.nodeId === 'd1');
  assert.ok(cut);
  assert.equal(cut.cutLinkId, 'l2');
  assert.deepEqual(cut.pathLabels, ['Access-1', 'Edge-Switch', 'Core-Router', 'مرکز اصلی']);
});

test('an offline transit device is located as the cut and affects its downstream', () => {
  const { nodes, links } = chain();
  nodes.find((n) => n.id === 'sw').device.status = 'offline';
  const result = analyzeTopology({ nodes, links });
  assert.equal(result.summary.affectedDeviceCount, 3);
  assert.ok(result.live.offlineNodeIds.includes('sw'));
  const incident = result.live.incidents.find((item) => item.id === 'sw');
  assert.equal(incident.type, 'node');
  assert.equal(incident.affectedDeviceCount, 3);
  const cut = result.live.cutPaths.find((item) => item.nodeId === 'd2');
  assert.equal(cut.cutNodeId, 'sw');
});

test('an inferred anchor is used when no site or cloud is connected', () => {
  const nodes = [
    device('g', 'Main-Gateway', 'online', 'gateway'),
    device('sw', 'Switch', 'online', 'switch'),
    device('srv', 'Server', 'online', 'server'),
  ];
  const links = [link('l1', 'g', 'sw'), link('l2', 'sw', 'srv')];
  const result = analyzeTopology({ nodes, links });
  assert.equal(result.anchorSource, 'inferred');
  assert.deepEqual(result.anchors.map((a) => a.id), ['g']);
  assert.match(result.warning, /بیشترین اتصال/);
});

test('primary/backup paths fail over automatically when the primary link is down', () => {
  const nodes = [
    site('s'),
    device('a', 'A', 'online', 'switch'),
    device('b', 'B', 'online', 'switch'),
    device('c', 'C', 'online', 'switch'),
  ];
  const links = [
    link('sa', 's', 'a'),
    link('ab', 'a', 'b'),
    link('sc', 's', 'c'),
    link('cb', 'c', 'b'),
  ];
  const paths = [
    { id: 'p1', name: 'مسیر B', role: 'primary', nodeIds: ['s', 'a', 'b'] },
    { id: 'p2', name: 'مسیر B', role: 'backup', nodeIds: ['s', 'c', 'b'] },
  ];
  const healthy = analyzeTopology({ nodes, links, paths });
  assert.equal(healthy.redundancy.groups.length, 1);
  assert.equal(healthy.redundancy.groups[0].activeRole, 'primary');
  assert.equal(healthy.redundancy.groups[0].primary.status, 'up');
  assert.equal(healthy.redundancy.groups[0].backup.status, 'up');

  links.find((l) => l.id === 'ab').live.status = 'down';
  const result = analyzeTopology({ nodes, links, paths });
  const group = result.redundancy.groups[0];
  assert.equal(group.primary.status, 'down');
  assert.equal(group.backup.status, 'up');
  assert.equal(group.activeRole, 'backup');
  assert.equal(group.failover, true);
  assert.equal(result.summary.activeBackupCount, 1);
  assert.equal(group.backup.active, true);

  // اختلال (نه قطع) مسیر را جابه‌جا نمی‌کند؛ پشتیبان فقط آماده می‌ماند.
  links.find((l) => l.id === 'ab').live.status = 'degraded';
  const degraded = analyzeTopology({ nodes, links, paths }).redundancy.groups[0];
  assert.equal(degraded.primary.status, 'degraded');
  assert.equal(degraded.activeRole, 'primary');
  assert.equal(degraded.failover, false);
  assert.equal(degraded.status, 'degraded');
});

test('simulation lists impacted devices and activates the backup route', () => {
  const nodes = [
    site('s'),
    device('a', 'A', 'online', 'switch'),
    device('b', 'B', 'online', 'switch'),
    device('c', 'C', 'online', 'switch'),
    device('d', 'D', 'online', 'server'),
  ];
  const links = [
    link('sa', 's', 'a'),
    link('ab', 'a', 'b'),
    link('bc', 'b', 'c'),
    link('bd', 'b', 'd'),
    link('ac', 'a', 'c', 'up'),
  ];
  const paths = [
    { id: 'p1', name: 'مسیر C', role: 'primary', nodeIds: ['s', 'a', 'b', 'c'] },
    { id: 'p2', name: 'مسیر C', role: 'backup', nodeIds: ['s', 'a', 'c'] },
  ];
  const impact = simulateTopologyImpact({ nodes, links, paths, target: { type: 'node', id: 'b' } });
  assert.equal(impact.summary.affectedDeviceCount, 2);
  assert.equal(impact.affected.devices.some((item) => item.id === 'b' && item.isTarget), true);
  assert.equal(impact.backupActivated.length, 1);
  assert.equal(impact.backupActivated[0].name, 'مسیر C');
  assert.equal(impact.summary.severity, 'critical');
  const preview = impact.paths.find((item) => item.nodeId === 'd');
  assert.deepEqual(preview.pathLabels, ['D', 'B', 'A', 'مرکز']);
});

test('simulating a non-bridge link reports an alternate route instead of victims', () => {
  const nodes = [
    site('s'),
    device('a', 'A'),
    device('b', 'B'),
    device('c', 'C'),
  ];
  const links = [link('sa', 's', 'a'), link('ab', 'a', 'b'), link('ac', 'a', 'c'), link('bc', 'b', 'c')];
  const impact = simulateTopologyImpact({ nodes, links, target: { type: 'link', id: 'ab' } });
  assert.equal(impact.summary.affectedDeviceCount, 0);
  assert.equal(impact.summary.alternateRoute, true);
  assert.equal(impact.backupActivated.length, 0);
});

test('role inference uses explicit metadata before labels and device type', () => {
  assert.equal(inferNodeRole(device('x', 'Random', 'online', 'switch', { role: 'gateway' })), 'gateway');
  assert.equal(inferNodeRole(device('x', 'Random', 'online', 'router')), 'router');
  assert.equal(inferNodeRole(device('x', 'Core Switch', 'online', 'other')), 'switch');
  assert.equal(inferNodeRole(site('s')), 'site');
});

test('an empty graph returns a clear warning rather than invented data', () => {
  const result = analyzeTopology({ nodes: [], links: [] });
  assert.equal(result.anchorSource, 'none');
  assert.equal(result.summary.deviceCount, 0);
  assert.match(result.warning, /مرکز زیرساخت/);
  assert.equal(simulateTopologyImpact({ nodes: [], links: [], target: { type: 'link', id: 'x' } }).error.includes('مرکز'), true);
});
