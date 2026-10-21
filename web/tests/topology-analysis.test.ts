/** آزمون کمک‌تابع‌های نمایش تحلیل مرحلهٔ ۳ */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTopologyOverlay,
  removePathGroup,
  selectedNodePath,
  upsertPath,
} from '../src/lib/topology-analysis.ts';
import type { TopoAnalysis, TopoImpact } from '../src/lib/types.ts';

const analysis = {
  revision: 4,
  generatedAt: 1000,
  paths: [],
  anchorSource: 'explicit',
  anchors: [],
  warning: '',
  summary: {
    nodeCount: 4,
    linkCount: 3,
    deviceCount: 3,
    anchorCount: 1,
    reachableDeviceCount: 3,
    affectedDeviceCount: 1,
    unreachableDeviceCount: 1,
    isolatedDeviceCount: 0,
    criticalNodeCount: 1,
    riskyLinkCount: 1,
    redundancyGroupCount: 1,
    activeBackupCount: 1,
    incidentCount: 1,
  },
  criticalNodes: [
    {
      id: 'core', kind: 'device', label: 'Core', role: 'router', roleLabel: 'روتر',
      deviceId: 1, ip: '10.0.0.1', status: 'online', siteId: null,
      dependentNodeCount: 2, dependentDeviceCount: 2, dependentSiteCount: 0,
      severity: 'critical', severityLabel: 'بحرانی', isArticulation: true,
    },
  ],
  riskyLinks: [],
  live: {
    affectedNodeIds: ['leaf'],
    affectedDeviceCount: 1,
    unreachableNodeIds: ['leaf'],
    offlineNodeIds: [],
    problemLinkIds: ['l2'],
    degradedLinkIds: ['l3'],
    problemPathLinkIds: ['l1', 'l2'],
    problemPathNodeIds: ['leaf', 'core', 'site'],
    incidents: [],
    cutPaths: [],
  },
  redundancy: {
    groups: [
      {
        name: 'مسیر اصلی',
        primary: { id: 'p', name: 'مسیر اصلی', role: 'primary', nodeIds: ['site', 'core'], linkIds: ['l1'], status: 'down', active: false },
        backup: { id: 'b', name: 'مسیر اصلی', role: 'backup', nodeIds: ['site', 'alt'], linkIds: ['l4'], status: 'up', active: true },
        activeRole: 'backup',
        failover: true,
        status: 'failover',
      },
    ],
    activeBackups: ['مسیر اصلی'],
  },
} as unknown as TopoAnalysis;

const impact = {
  revision: 4,
  generatedAt: 1001,
  target: { id: 'l2', type: 'link', label: 'uplink', status: 'down' },
  summary: {
    affectedNodeCount: 2, affectedDeviceCount: 1, downstreamDeviceCount: 1,
    affectedSiteCount: 0, severity: 'medium', severityLabel: 'متوسط',
    alternateRoute: false, baselineReachable: 4, alreadyAffected: false,
  },
  affected: { nodeIds: ['leaf', 'sw'], devices: [], deviceCount: 1, truncated: false, siteCount: 0 },
  paths: [],
  pathLinkIds: ['l2', 'l3'],
  pathNodeIds: ['leaf', 'sw', 'core'],
  backupActivated: [],
} as unknown as TopoImpact;

test('overlay combines live problem paths, impact and critical nodes', () => {
  const overlay = buildTopologyOverlay(analysis, impact, { showCritical: true, activeGroupName: 'مسیر اصلی' });
  assert.deepEqual([...overlay.criticalNodeIds], ['core']);
  assert.deepEqual([...overlay.affectedNodeIds].sort(), ['leaf', 'sw']);
  assert.deepEqual([...overlay.affectedLinkIds].sort(), ['l2', 'l3']);
  assert.deepEqual([...overlay.problemPathLinkIds].sort(), ['l1', 'l2', 'l3']);
  assert.deepEqual([...overlay.primaryPathLinkIds], ['l1']);
  assert.deepEqual([...overlay.backupPathLinkIds], ['l4']);
});

test('critical rings can be hidden while problem paths stay visible', () => {
  const overlay = buildTopologyOverlay(analysis, null, { showCritical: false });
  assert.equal(overlay.criticalNodeIds.size, 0);
  assert.deepEqual([...overlay.problemPathLinkIds].sort(), ['l1', 'l2']);
  assert.deepEqual([...overlay.affectedLinkIds].sort(), ['l2', 'l3']);
  assert.equal(overlay.primaryPathLinkIds.size, 0);
});

test('selected nodes keep click order and show readable labels', () => {
  const nodes = [
    { id: 'b', kind: 'device', label: '', device: { name: 'Switch B' }, site: null },
    { id: 'a', kind: 'device', label: 'Router A', device: { name: 'x' }, site: null },
    { id: 's', kind: 'site', label: '', device: null, site: { name: 'مرکز' } },
  ];
  const picked = selectedNodePath(nodes, ['a', 's', 'b']);
  assert.deepEqual(picked.map((item) => item.id), ['a', 's', 'b']);
  assert.deepEqual(picked.map((item) => item.label), ['Router A', 'مرکز', 'Switch B']);
});

test('upsertPath replaces only the same role in the same group', () => {
  const paths = [
    { id: 'p1', name: 'مسیر A', role: 'primary' as const, nodeIds: ['s', 'a'], linkIds: ['l1'] },
    { id: 'b1', name: 'مسیر A', role: 'backup' as const, nodeIds: ['s', 'b'], linkIds: ['l2'] },
  ];
  const next = upsertPath(paths, { name: ' مسیر A ', role: 'primary', nodeIds: ['s', 'c'] });
  assert.equal(next.length, 2);
  assert.deepEqual(next.find((path) => path.role === 'primary')?.nodeIds, ['s', 'c']);
  assert.deepEqual(next.find((path) => path.role === 'backup')?.nodeIds, ['s', 'b']);
});

test('removing a group removes both primary and backup without touching others', () => {
  const paths = [
    { id: 'p1', name: 'مسیر A', role: 'primary' as const, nodeIds: ['s', 'a'], linkIds: [] },
    { id: 'b1', name: 'مسیر A', role: 'backup' as const, nodeIds: ['s', 'b'], linkIds: [] },
    { id: 'p2', name: 'مسیر C', role: 'primary' as const, nodeIds: ['s', 'c'], linkIds: [] },
  ];
  const next = removePathGroup(paths, 'مسیر A');
  assert.equal(next.length, 1);
  assert.equal(next[0].name, 'مسیر C');
});
