import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LINK_STATUS_META,
  applyLinkSnapshot,
  applyNodeSnapshot,
  attentionLinks,
  fmtBandwidth,
  fmtLoss,
  fmtUtil,
  linkMetricText,
  linkStatus,
  linkStrokeWidth,
  liveLinkColor,
  summarizeLinks,
  utilBarPct,
} from '../src/lib/topology-live.ts';
import type { TopoLink, TopoLinkLive, TopoNode, TopoStatusSnapshot } from '../src/lib/types.ts';

function live(overrides: Partial<TopoLinkLive> = {}): TopoLinkLive {
  return {
    id: 'l1',
    status: 'up',
    reasonCode: 'healthy',
    reason: 'ok',
    latencyMs: 12,
    lossPct: 0,
    jitterMs: 2,
    capacityMbps: 1000,
    utilPct: null,
    rxMbps: null,
    txMbps: null,
    saturation: 'unmeasured',
    telemetryAt: null,
    telemetryStale: true,
    telemetryError: '',
    operStatus: 'unknown',
    sourceCount: 2,
    reportingCount: 2,
    stale: false,
    updatedAt: 1000,
    sources: [],
    ...overrides,
  };
}

function link(overrides: Partial<TopoLink> = {}): TopoLink {
  return {
    id: 'l1',
    from: 'a',
    to: 'b',
    kind: 'fiber',
    label: 'فیبر',
    notes: '',
    color: '',
    style: 'solid',
    meta: {},
    capacityMbps: 1000,
    ...overrides,
  };
}

test('link colour is driven only by live status when present', () => {
  const base = link({ live: live({ status: 'up' }) });
  assert.equal(liveLinkColor(base, '#000000'), LINK_STATUS_META.up.color);
  assert.equal(liveLinkColor(link({ live: live({ status: 'down' }) }), '#000000'), LINK_STATUS_META.down.color);
  assert.equal(liveLinkColor(link({ live: live({ status: 'degraded' }) }), '#000000'), LINK_STATUS_META.degraded.color);
  assert.equal(liveLinkColor(link({ live: live({ status: 'unknown' }) }), '#000000'), LINK_STATUS_META.unknown.color);
  assert.equal(liveLinkColor(link(), '#123456'), '#123456', 'بدون دادهٔ زنده، رنگ نوع لینک حفظ می‌شود');
  assert.equal(linkStatus(link()), 'unknown');
});

test('bandwidth and utilisation formatting never invents a value', () => {
  assert.equal(fmtBandwidth(1000), '۱ Gbps');
  assert.equal(fmtBandwidth(100), '۱۰۰ Mbps');
  assert.equal(fmtBandwidth(null), 'نامشخص');
  assert.equal(fmtUtil(null), '—');
  assert.equal(fmtUtil(82.5), '۸۲.۵٪');
  assert.equal(fmtLoss(0), '۰٪');
  assert.equal(utilBarPct(120), 100);
  assert.equal(utilBarPct(null), 0);
});

test('metric text shows capacity even when traffic was never measured', () => {
  const noTraffic = link({ live: live({ utilPct: null, latencyMs: 12 }) });
  assert.equal(linkMetricText(noTraffic), '۱ Gbps · بدون سنجش · ۱۲ms');
  const measured = link({ live: live({ utilPct: 42, latencyMs: 20 }) });
  assert.equal(linkMetricText(measured), '۱ Gbps · ۴۲٪ · ۲۰ms');
});

test('stroke width grows with real utilisation only', () => {
  assert.equal(linkStrokeWidth(link({ live: live({ utilPct: null }) })), 1.7);
  assert.ok(linkStrokeWidth(link({ live: live({ utilPct: 95 }) })) > 3);
  assert.equal(linkStrokeWidth(link({ live: live() }), true), 3.1);
});

test('summary and attention list rank down before degraded before unknown', () => {
  const links = [
    link({ id: 'a', live: live({ id: 'a', status: 'up' }) }),
    link({ id: 'b', live: live({ id: 'b', status: 'degraded', utilPct: 78, saturation: 'high' }) }),
    link({ id: 'c', live: live({ id: 'c', status: 'down' }) }),
    link({ id: 'd' }),
  ];
  const stats = summarizeLinks(links);
  assert.deepEqual(stats, { up: 1, down: 1, degraded: 1, unknown: 1, highLoad: 1, saturated: 0 });
  assert.deepEqual(attentionLinks(links).map((l) => l.id), ['c', 'b']);
});

test('snapshot merge updates links/nodes without touching graph structure', () => {
  const links = [link({ live: live({ status: 'up' }) }), link({ id: 'l2' })];
  const snapshot = {
    revision: 3,
    generatedAt: 5000,
    nodes: [],
    links: [live({ id: 'l1', status: 'down', reasonCode: 'endpoint-offline' }), live({ id: 'l2', status: 'unknown' })],
    sites: [],
    summary: { up: 0, down: 1, degraded: 0, unknown: 1, highLoad: 0, saturated: 0 },
  } satisfies TopoStatusSnapshot;
  const next = applyLinkSnapshot(links, snapshot);
  assert.equal(next[0].live?.status, 'down');
  assert.equal(next[0].from, 'a');
  assert.equal(next[1].live?.status, 'unknown');
  assert.equal(applyLinkSnapshot(next, snapshot), next, 'بدون تغییر، همان آرایه برمی‌گردد');

  const nodes: TopoNode[] = [
    {
      id: 'n1',
      kind: 'device',
      deviceId: 7,
      siteId: null,
      label: '',
      notes: '',
      x: 0,
      y: 0,
      width: 190,
      height: 72,
      color: '',
      z: 0,
      meta: {},
      site: null,
      device: {
        id: 7,
        name: 'sw',
        ip: '10.0.0.7',
        deviceType: 'سوئیچ',
        status: 'online',
        lastRtt: 4,
        lossPct: 0,
        lastCheckAt: 10,
        location: '',
        groupId: null,
        groupName: null,
        groupColor: null,
        priority: 'normal',
        vendor: 'Cisco',
      },
    },
  ];
  const nodeSnapshot = {
    ...snapshot,
    nodes: [
      {
        id: 'n1',
        deviceId: 7,
        kind: 'device',
        name: 'sw',
        ip: '10.0.0.7',
        status: 'offline' as const,
        reportedStatus: 'offline' as const,
        statusReason: 'TIMEOUT',
        stale: false,
        lastRtt: null,
        lossPct: 100,
        jitterMs: null,
        lastCheckAt: 20,
      },
    ],
  };
  const merged = applyNodeSnapshot(nodes, nodeSnapshot);
  assert.equal(merged[0].device?.status, 'offline');
  assert.equal(merged[0].device?.statusReason, 'TIMEOUT');
  assert.equal(merged[0].device?.vendor, 'Cisco', 'مشخصات فنی حفظ می‌شود');
  assert.equal(merged[0].x, 0);
});
