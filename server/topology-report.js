/**
 * NetWatch — گزارش ساختاریافتهٔ دیاگرام ارتباطات (مرحلهٔ ۴)
 * ----------------------------------------------------------------
 * همهٔ گزارش‌ها از دادهٔ ذخیره‌شدهٔ همین دیاگرام و Snapshot زندهٔ همان لحظه
 * ساخته می‌شوند؛ هیچ عدد یا وضعیتی در این ماژول حدس زده نمی‌شود:
 *   • ساختار گراف و شمارش‌ها از گره/لینک واقعی
 *   • وضعیت لینک از `live` که موتور مانیتورینگ ساخته است
 *   • مسیرها از تعریف ثبت‌شده و تحلیل مرحلهٔ ۳
 *   • نقاط بحرانی از همان موتور Tarjan/شبیه‌سازی
 * اگر داده‌ای نباشد (ظرفیت ثبت‌نشده، دادهٔ کهنه، مرکز نامشخص) مقدار null
 * می‌ماند و در گزارش «بدون داده» نمایش داده می‌شود.
 */
import { inferNodeRole, TOPOLOGY_ROLE_LABEL, TOPOLOGY_SEVERITY_LABEL } from './topology-analysis.js';

export const LINK_STATUS_LABEL = Object.freeze({
  up: 'سالم',
  degraded: 'اختلال',
  down: 'قطع',
  unknown: 'نامشخص',
});

export const ROUTE_STATUS_LABEL = Object.freeze({
  up: 'سالم',
  degraded: 'اختلال',
  down: 'قطع',
  unknown: 'نامشخص',
});

export const GROUP_STATUS_LABEL = Object.freeze({
  normal: 'عادی',
  degraded: 'اختلال',
  critical: 'بحرانی',
  failover: 'پشتیبان فعال',
  unknown: 'نامشخص',
});

const LINK_KIND_LABEL = Object.freeze({
  ethernet: 'اترنت',
  fiber: 'فیبر',
  wireless: 'بی‌سیم',
  vpn: 'VPN',
  logical: 'منطقی',
});

const DEVICE_STATUS_LABEL = Object.freeze({
  online: 'آنلاین',
  offline: 'آفلاین',
  warning: 'هشدار',
  maintenance: 'نگهداری',
  unknown: 'نامشخص',
});

export const REPORT_SECTIONS = Object.freeze([
  { key: 'structure', title: 'ساختار کلی شبکه و توپولوژی' },
  { key: 'devices', title: 'تجهیزات و مراکز تجمع' },
  { key: 'paths', title: 'مسیرهای اصلی و پشتیبان' },
  { key: 'links', title: 'وضعیت لینک‌ها و اختلالات' },
  { key: 'capacity', title: 'ظرفیت اسمی لینک‌ها' },
  { key: 'risks', title: 'نقاط بحرانی و وابستگی تجهیزات' },
]);

function round(value, digits = 2) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function nodeLabel(node) {
  if (!node) return 'گره';
  return node.label || node.device?.name || node.site?.name || (node.kind === 'cloud' ? 'ابر / WAN' : node.id);
}

function linkLabel(link, nodes) {
  if (link.label) return link.label;
  const from = nodes.get(link.from);
  const to = nodes.get(link.to);
  return `${nodeLabel(from)} ↔ ${nodeLabel(to)}`;
}

function degreeMap(nodes, links) {
  const map = new Map(nodes.map((node) => [node.id, 0]));
  for (const link of links) {
    if (map.has(link.from)) map.set(link.from, map.get(link.from) + 1);
    if (map.has(link.to)) map.set(link.to, map.get(link.to) + 1);
  }
  return map;
}

/** تعداد مؤلفه‌های همبند گراف (بدون یادداشت‌ها). */
function connectedComponents(nodes, links) {
  const ids = new Set(nodes.filter((node) => node.kind !== 'note').map((node) => node.id));
  if (!ids.size) return 0;
  const parent = new Map([...ids].map((id) => [id, id]));
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(id) !== id) {
      const next = parent.get(id);
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  for (const link of links) {
    if (!ids.has(link.from) || !ids.has(link.to)) continue;
    const a = find(link.from);
    const b = find(link.to);
    if (a !== b) parent.set(a, b);
  }
  return new Set([...ids].map((id) => find(id))).size;
}

function statusCounts(items, key = 'status') {
  const out = { online: 0, offline: 0, warning: 0, maintenance: 0, unknown: 0 };
  for (const item of items) {
    const value = item?.[key];
    if (value in out) out[value] += 1;
  }
  return out;
}

function linkStatusCounts(links) {
  const out = { up: 0, down: 0, degraded: 0, unknown: 0 };
  for (const link of links) {
    const status = link.live?.status || 'unknown';
    if (status in out) out[status] += 1;
  }
  return out;
}

/**
 * ساخت گزارش کامل و قابل خروجی.
 * @param {{diagram:any, paths:any[], analysis:any, sites:any[], now?:number}} input
 */
export function buildTopologyReport({ diagram, paths = [], analysis = null, sites = [], now = Date.now() } = {}) {
  if (!diagram) return null;
  const nodes = Array.isArray(diagram.nodes) ? diagram.nodes : [];
  const links = Array.isArray(diagram.links) ? diagram.links : [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const degrees = degreeMap(nodes, links);
  const deviceNodes = nodes.filter((node) => node.kind === 'device');
  const siteNodes = nodes.filter((node) => node.kind === 'site');
  const cloudNodes = nodes.filter((node) => node.kind === 'cloud');
  const noteNodes = nodes.filter((node) => node.kind === 'note');
  const groupNodes = nodes.filter((node) => node.kind === 'group');

  const statusCount = statusCounts(deviceNodes.map((node) => node.device || {}));
  const linkCounts = linkStatusCounts(links);
  const linkKinds = {};
  for (const link of links) {
    const kind = LINK_KIND_LABEL[link.kind] ? link.kind : 'ethernet';
    linkKinds[kind] = (linkKinds[kind] || 0) + 1;
  }
  const roleCounts = {};
  for (const node of deviceNodes) {
    const role = inferNodeRole(node);
    roleCounts[role] = (roleCounts[role] || 0) + 1;
  }

  const deviceRows = deviceNodes
    .map((node) => {
      const device = node.device || {};
      const role = inferNodeRole(node);
      return {
        nodeId: node.id,
        deviceId: node.deviceId ?? device.id ?? null,
        label: nodeLabel(node),
        ip: device.ip || '',
        kind: device.deviceType || '',
        role,
        roleLabel: TOPOLOGY_ROLE_LABEL[role] || TOPOLOGY_ROLE_LABEL.device,
        status: device.status || 'unknown',
        statusLabel: DEVICE_STATUS_LABEL[device.status] || DEVICE_STATUS_LABEL.unknown,
        statusReason: device.statusReason || '',
        group: device.groupName || '',
        site: node.site?.name || device.building || device.location || '',
        location: device.location || '',
        vendor: device.vendor || '',
        model: device.model || '',
        serial: device.serial || '',
        monitoringEnabled: device.monitoringEnabled !== false,
        degree: degrees.get(node.id) || 0,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label, 'fa'));

  const siteRows = (Array.isArray(sites) ? sites : []).map((site) => ({
    id: site.id,
    name: site.name,
    code: site.code || '',
    address: site.address || '',
    color: site.color || '#6366f1',
    deviceCount: site.deviceCount ?? 0,
    onlineCount: site.onlineCount ?? 0,
    offlineCount: site.offlineCount ?? 0,
    onDiagram: siteNodes.some((node) => node.siteId === site.id),
  }));

  const analysisGroups = analysis?.redundancy?.groups || [];
  const pathGroups = analysisGroups.map((group) => ({
    name: group.name,
    status: group.status || 'unknown',
    statusLabel: GROUP_STATUS_LABEL[group.status] || GROUP_STATUS_LABEL.unknown,
    activeRole: group.activeRole || null,
    failover: !!group.failover,
    primary: group.primary
      ? {
          id: group.primary.id,
          from: group.primary.fromLabel,
          to: group.primary.toLabel,
          hops: group.primary.hops,
          status: group.primary.status,
          statusLabel: ROUTE_STATUS_LABEL[group.primary.status] || ROUTE_STATUS_LABEL.unknown,
          broken: !!group.primary.broken,
          active: !!group.primary.active,
        }
      : null,
    backup: group.backup
      ? {
          id: group.backup.id,
          from: group.backup.fromLabel,
          to: group.backup.toLabel,
          hops: group.backup.hops,
          status: group.backup.status,
          statusLabel: ROUTE_STATUS_LABEL[group.backup.status] || ROUTE_STATUS_LABEL.unknown,
          broken: !!group.backup.broken,
          active: !!group.backup.active,
        }
      : null,
  }));

  const linkRows = links.map((link) => {
    const live = link.live || {};
    const status = live.status || 'unknown';
    return {
      id: link.id,
      label: linkLabel(link, nodeById),
      from: nodeLabel(nodeById.get(link.from)),
      to: nodeLabel(nodeById.get(link.to)),
      kind: link.kind || 'ethernet',
      kindLabel: LINK_KIND_LABEL[link.kind] || LINK_KIND_LABEL.ethernet,
      status,
      statusLabel: LINK_STATUS_LABEL[status] || LINK_STATUS_LABEL.unknown,
      reason: live.reason || '',
      capacityMbps: round(link.capacityMbps ?? live.capacityMbps, 2),
      latencyMs: round(live.latencyMs, 1),
      lossPct: round(live.lossPct, 1),
      jitterMs: round(live.jitterMs, 1),
      monitored: !!link.monitorDeviceId,
    };
  });

  const configured = linkRows.filter((row) => row.capacityMbps != null);
  const totalCapacity = configured.reduce((sum, row) => sum + row.capacityMbps, 0);
  const capacitySummary = {
    configuredCount: configured.length,
    totalCapacityMbps: configured.length ? round(totalCapacity, 2) : null,
    noCapacityCount: linkRows.filter((row) => row.capacityMbps == null).length,
  };

  const criticalNodes = (analysis?.criticalNodes || []).map((node) => ({
    id: node.id,
    label: node.label,
    role: node.role,
    roleLabel: node.roleLabel || TOPOLOGY_ROLE_LABEL[node.role] || TOPOLOGY_ROLE_LABEL.device,
    ip: node.ip || '',
    status: node.status || 'unknown',
    dependentDeviceCount: node.dependentDeviceCount ?? 0,
    dependentNodeCount: node.dependentNodeCount ?? 0,
    dependentSiteCount: node.dependentSiteCount ?? 0,
    severity: node.severity || 'low',
    severityLabel: node.severityLabel || TOPOLOGY_SEVERITY_LABEL[node.severity] || TOPOLOGY_SEVERITY_LABEL.low,
  }));
  const riskyLinks = (analysis?.riskyLinks || []).map((link) => ({
    id: link.id,
    label: link.label,
    from: link.fromLabel,
    to: link.toLabel,
    status: link.status || 'unknown',
    statusLabel: LINK_STATUS_LABEL[link.status] || LINK_STATUS_LABEL.unknown,
    dependentDeviceCount: link.dependentDeviceCount ?? 0,
    dependentNodeCount: link.dependentNodeCount ?? 0,
    dependentSiteCount: link.dependentSiteCount ?? 0,
    severity: link.severity || 'low',
    severityLabel: link.severityLabel || TOPOLOGY_SEVERITY_LABEL[link.severity] || TOPOLOGY_SEVERITY_LABEL.low,
  }));
  const incidents = (analysis?.live?.incidents || []).map((item) => ({
    type: item.type,
    typeLabel: item.type === 'link' ? 'لینک' : 'تجهیز',
    id: item.id,
    label: item.label,
    status: item.status || 'unknown',
    statusLabel: item.type === 'link'
      ? LINK_STATUS_LABEL[item.status] || LINK_STATUS_LABEL.unknown
      : DEVICE_STATUS_LABEL[item.status] || DEVICE_STATUS_LABEL.unknown,
    reason: item.reason || '',
    affectedDeviceCount: item.affectedDeviceCount ?? 0,
    endpoints: item.endpoints || [],
  }));

  const warnings = [];
  if (analysis?.warning) warnings.push(analysis.warning);
  if (!links.length) warnings.push('هیچ لینکی در دیاگرام ثبت نشده است؛ گزارش ارتباطی خالی است.');
  if (!deviceNodes.length) warnings.push('هیچ تجهیز واقعی به دیاگرام متصل نیست.');
  if (linkRows.some((row) => row.status === 'unknown')) {
    warnings.push('برای بخشی از لینک‌ها دادهٔ تازه/منبع سنجش وجود ندارد؛ وضعیت آن‌ها «نامشخص» گزارش شده است.');
  }
  if (capacitySummary.noCapacityCount) {
    warnings.push(`${capacitySummary.noCapacityCount} لینک ظرفیت اسمی ثبت‌شده ندارد.`);
  }

  return {
    generatedAt: now,
    diagram: {
      id: diagram.id,
      name: diagram.name,
      description: diagram.description || '',
      layout: diagram.layout,
      revision: diagram.revision,
      locked: !!diagram.locked,
      updatedAt: diagram.updatedAt,
      nodes: nodes.length,
      links: links.length,
      paths: paths.length,
    },
    structure: {
      nodeCount: nodes.length,
      deviceNodeCount: deviceNodes.length,
      siteNodeCount: siteNodes.length,
      cloudNodeCount: cloudNodes.length,
      noteCount: noteNodes.length,
      groupNodeCount: groupNodes.length,
      linkCount: links.length,
      connectedComponents: connectedComponents(nodes, links),
      isolatedNodeCount: nodes.filter((node) => node.kind !== 'note' && !(degrees.get(node.id) || 0)).length,
      averageDegree: round(
        nodeNodesDegreeAverage(degrees, nodes),
        2
      ),
      statusCounts: statusCount,
      linkStatusCounts: linkCounts,
      linkKinds: Object.entries(linkKinds).map(([kind, count]) => ({
        kind,
        label: LINK_KIND_LABEL[kind] || kind,
        count,
      })),
      roles: Object.entries(roleCounts).map(([role, count]) => ({
        role,
        label: TOPOLOGY_ROLE_LABEL[role] || role,
        count,
      })),
      siteOnDiagramCount: siteRows.filter((site) => site.onDiagram).length,
    },
    devices: deviceRows,
    sites: siteRows,
    paths: pathGroups,
    pathCounts: {
      groups: pathGroups.length,
      primary: pathGroups.filter((group) => group.primary).length,
      backup: pathGroups.filter((group) => group.backup).length,
      failover: pathGroups.filter((group) => group.failover).length,
      broken: pathGroups.reduce((sum, group) => sum + (group.primary?.broken ? 1 : 0) + (group.backup?.broken ? 1 : 0), 0),
      withoutBackup: pathGroups.filter((group) => group.primary && !group.backup).length,
    },
    links: linkRows,
    capacity: capacitySummary,
    risks: {
      criticalNodes,
      riskyLinks,
      incidents,
      unreachableDeviceCount: analysis?.summary?.unreachableDeviceCount ?? 0,
      isolatedDeviceCount: analysis?.summary?.isolatedDeviceCount ?? 0,
      affectedDeviceCount: analysis?.summary?.affectedDeviceCount ?? 0,
      criticalNodeCount: criticalNodes.length,
      riskyLinkCount: riskyLinks.length,
      incidentCount: incidents.length,
    },
    warnings,
    sources: {
      liveGeneratedAt: diagram.liveGeneratedAt ?? null,
      analysisGeneratedAt: analysis?.generatedAt ?? null,
      anchorSource: analysis?.anchorSource ?? 'none',
    },
  };
}

function nodeNodesDegreeAverage(degrees, nodes) {
  const active = nodes.filter((node) => node.kind !== 'note');
  if (!active.length) return 0;
  return active.reduce((sum, node) => sum + (degrees.get(node.id) || 0), 0) / active.length;
}
