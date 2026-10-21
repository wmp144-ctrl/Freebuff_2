/**
 * NetWatch — تحلیل وابستگی و تأثیر اختلال در دیاگرام ارتباطات (مرحلهٔ ۳)
 * ----------------------------------------------------------------
 * این ماژول یک موتور گراف خالص است: هیچ پرس‌وجوی پایگاه‌داده‌ای داخل آن نیست
 * تا هم سریع باشد و هم مستقل از HTTP آزمون شود. ورودی، گراف ذخیره‌شدهٔ دیاگرام
 * (گره‌ها + لینک‌ها + وضعیت زندهٔ لینک‌ها) و مسیرهای اصلی/پشتیبان است.
 *
 * تعریف «مرکز زیرساخت»:
 *   • گره‌های «مرکز تجمع» (site) و «ابر/WAN» (cloud) که به گراف متصل‌اند.
 *   • اگر هیچ‌کدام نبود، یک تجهیز مرکزی (Gateway/Router/Firewall با بیشترین
 *     اتصال) به‌عنوان مرکز استنتاج می‌شود و خروجی صریحاً `inferred` می‌گوید
 *     که این انتخاب خودکار است، نه دادهٔ ثبت‌شده.
 *
 * الگوریتم‌ها:
 *   • BFS چندمنبعی از مراکز برای دسترسی و مسیر کوتاه‌ترین به زیرساخت.
 *   • Tarjan برای یال‌های پل (تنها مسیر) و گره‌های برشی (نقاط بحرانی) با
 *     یک ریشهٔ مجازی که همهٔ مراکز را به هم وصل می‌کند. بنابراین «قطع از
 *     دسترسی به هر مرکز» سنجیده می‌شود، نه فقط یک مرکز خاص.
 *   • شبیه‌سازی حذف یک لینک/گره با BFS روی گراف واقعی.
 *
 * هیچ عدد ساختگی تولید نمی‌شود؛ لینک/گره‌ای که وضعیت زنده ندارد «نامشخص»
 * می‌ماند و در تحلیل قطعی به‌عنوان «قطع» فرض نمی‌شود.
 */

const ROLE_LABEL = {
  gateway: 'دروازه',
  router: 'روتر',
  switch: 'سوئیچ',
  firewall: 'فایروال',
  core: 'هسته',
  access: 'دسترسی',
  server: 'سرور',
  site: 'مرکز تجمع',
  cloud: 'شبکهٔ بیرونی',
  device: 'تجهیز',
  group: 'گروه',
};

const SEVERITY_LABEL = {
  critical: 'بحرانی',
  high: 'زیاد',
  medium: 'متوسط',
  low: 'کم',
};

export const TOPOLOGY_ROLE_LABEL = ROLE_LABEL;
export const TOPOLOGY_SEVERITY_LABEL = SEVERITY_LABEL;

/** نقش گره از دادهٔ ثبت‌شده، نوع تجهیز یا عنوان آن استنتاج می‌شود. */
export function inferNodeRole(node) {
  if (!node) return 'device';
  if (node.kind === 'site') return 'site';
  if (node.kind === 'cloud') return 'cloud';
  if (node.kind === 'group') return 'group';
  const explicit = String(node.meta?.role ?? node.role ?? '').trim().toLowerCase();
  const aliases = {
    gw: 'gateway',
    'دروازه': 'gateway',
    'روتر': 'router',
    'سوئیچ': 'switch',
    'فایروال': 'firewall',
    'هسته': 'core',
    'سرور': 'server',
  };
  if (aliases[explicit]) return aliases[explicit];
  if (ROLE_LABEL[explicit]) return explicit;
  const type = [
    node.device?.deviceType,
    node.deviceType,
    node.label,
    node.device?.name,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/gateway|دروازه|اینترنت/.test(type)) return 'gateway';
  if (/router|روتر/.test(type)) return 'router';
  if (/switch|سوئیچ/.test(type)) return 'switch';
  if (/firewall|فایروال|security|امنیت/.test(type)) return 'firewall';
  if (/server|سرور|host/.test(type)) return 'server';
  if (/wireless|access|اکسس|بی.?سیم/.test(type)) return 'access';
  if (/core|هسته/.test(type)) return 'core';
  return 'device';
}

function nodeLabel(node) {
  if (!node) return 'گره';
  if (node.label) return String(node.label);
  if (node.kind === 'device') return node.device?.name || 'تجهیز حذف‌شده';
  if (node.kind === 'site') return node.site?.name || 'مرکز تجمع';
  if (node.kind === 'cloud') return 'شبکهٔ بیرونی / WAN';
  if (node.kind === 'group') return 'گروه';
  return 'گره';
}

function nodeStatus(node) {
  if (!node) return 'unknown';
  if (node.kind === 'device' && !node.device) return 'removed';
  return String(node.device?.status || 'unknown');
}

function linkStatus(link) {
  return String(link?.live?.status || 'unknown');
}

function linkLabel(link, graph) {
  if (!link) return 'لینک';
  if (link.label) return String(link.label);
  const a = graph.nodes.get(link.from);
  const b = graph.nodes.get(link.to);
  return `${nodeLabel(a)} ↔ ${nodeLabel(b)}`;
}

function safeNodeId(value) {
  return typeof value === 'string' && value ? value : '';
}

function buildGraph(nodes, links) {
  const nodeMap = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    // یادداشت‌ها فقط حاشیه‌نویسی‌اند و نباید در دسترسی/وابستگی اثر بگذارند.
    if (!node || !safeNodeId(node.id) || node.kind === 'note') continue;
    nodeMap.set(node.id, node);
  }
  const adjacency = new Map();
  for (const id of nodeMap.keys()) adjacency.set(id, []);
  const linkMap = new Map();
  for (const link of Array.isArray(links) ? links : []) {
    if (!link || !safeNodeId(link.id)) continue;
    if (!nodeMap.has(link.from) || !nodeMap.has(link.to)) continue;
    if (link.from === link.to) continue;
    if (linkMap.has(link.id)) continue;
    linkMap.set(link.id, link);
    adjacency.get(link.from).push({ id: link.id, to: link.to });
    adjacency.get(link.to).push({ id: link.id, to: link.from });
  }
  const order = [...nodeMap.keys()];
  const deviceCount = order.filter((id) => nodeMap.get(id).kind === 'device').length;
  return { nodes: nodeMap, links: linkMap, adjacency, order, deviceCount };
}

function degreeOf(graph, id) {
  return graph.adjacency.get(id)?.length || 0;
}

function chooseAnchors(graph) {
  const explicit = graph.order.filter((id) => {
    const node = graph.nodes.get(id);
    return (node.kind === 'site' || node.kind === 'cloud') && degreeOf(graph, id) > 0;
  });
  if (explicit.length) {
    return {
      source: 'explicit',
      ids: explicit.sort((a, b) => graph.order.indexOf(a) - graph.order.indexOf(b)),
    };
  }
  const coreRoles = new Set(['gateway', 'router', 'firewall', 'core']);
  const core = graph.order
    .filter((id) => graph.nodes.get(id).kind === 'device' && degreeOf(graph, id) > 0)
    .filter((id) => coreRoles.has(inferNodeRole(graph.nodes.get(id))))
    .sort((a, b) => degreeOf(graph, b) - degreeOf(graph, a));
  if (core.length) return { source: 'inferred', ids: [core[0]] };
  const anyDevice = graph.order
    .filter((id) => graph.nodes.get(id).kind === 'device' && degreeOf(graph, id) > 0)
    .sort((a, b) => degreeOf(graph, b) - degreeOf(graph, a));
  if (anyDevice.length) return { source: 'inferred', ids: [anyDevice[0]] };
  return { source: 'none', ids: [] };
}

/**
 * BFS چندمنبعی. لینک/گره‌های مسدود (قطع واقعی یا شبیه‌سازی) وارد مسیر نمی‌شوند.
 * خروجی شامل والد هر گره و لینک ورودی است تا مسیر تا مرکز بازسازی شود.
 */
function reachFromAnchors(graph, anchorIds, { blockedLinks = null, blockedNodes = null } = {}) {
  const reached = new Set();
  const parent = new Map();
  const parentLink = new Map();
  const queue = [];
  for (const id of anchorIds) {
    if (blockedNodes?.has(id) || !graph.nodes.has(id)) continue;
    if (reached.has(id)) continue;
    reached.add(id);
    queue.push(id);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    for (const edge of graph.adjacency.get(current) || []) {
      if (blockedLinks?.has(edge.id)) continue;
      if (blockedNodes?.has(edge.to) || reached.has(edge.to)) continue;
      reached.add(edge.to);
      parent.set(edge.to, current);
      parentLink.set(edge.to, edge.id);
      queue.push(edge.to);
    }
  }
  return { reached, parent, parentLink };
}

function pathFromParents(victim, parent, parentLink) {
  if (!parentLink.has(victim)) return null;
  const nodeIds = [victim];
  const linkIds = [];
  let current = victim;
  let guard = 0;
  while (parent.has(current) && guard < 100000) {
    linkIds.push(parentLink.get(current));
    current = parent.get(current);
    nodeIds.push(current);
    guard += 1;
  }
  return { nodeIds, linkIds };
}

function nodeInfo(node) {
  return {
    id: node.id,
    kind: node.kind,
    label: nodeLabel(node),
    role: inferNodeRole(node),
    roleLabel: ROLE_LABEL[inferNodeRole(node)] || ROLE_LABEL.device,
    deviceId: node.deviceId ?? node.device_id ?? null,
    ip: node.device?.ip || '',
    status: nodeStatus(node),
    siteId: node.siteId ?? node.site_id ?? null,
  };
}

function linkInfo(link, graph) {
  return {
    id: link.id,
    from: link.from,
    to: link.to,
    fromLabel: nodeLabel(graph.nodes.get(link.from)),
    toLabel: nodeLabel(graph.nodes.get(link.to)),
    label: linkLabel(link, graph),
    kind: link.kind || 'ethernet',
    status: linkStatus(link),
    capacityMbps: Number.isFinite(Number(link.capacityMbps)) ? Number(link.capacityMbps) : null,
  };
}

/**
 * Tarjan روی گراف ناشناس‌گرا با ریشهٔ مجازی مراکز.
 * خروجی: مجموعهٔ پل‌ها و گره‌های برشی با شمارش گره/تجهیز سمت قطع‌شده.
 */
function connectivityRisks(graph, anchorIds) {
  const ids = graph.order;
  const index = new Map(ids.map((id, i) => [id, i]));
  const superIndex = ids.length;
  const size = ids.length + 1;
  const adjacency = ids.map((id) =>
    (graph.adjacency.get(id) || []).map((edge) => ({ to: index.get(edge.to), edgeId: edge.id }))
  );
  adjacency.push(
    anchorIds
      .filter((id) => index.has(id))
      .map((id) => ({ to: index.get(id), edgeId: `__anchor__:${id}`, anchor: true }))
  );

  const disc = new Int32Array(size).fill(-1);
  const low = new Int32Array(size);
  const parent = new Int32Array(size).fill(-1);
  const parentEdge = new Array(size).fill(null);
  const subtreeNodes = new Int32Array(size);
  const subtreeDevices = new Int32Array(size);
  const subtreeSites = new Int32Array(size);
  const artNodes = new Int32Array(size);
  const artDevices = new Int32Array(size);
  const artSites = new Int32Array(size);
  const bridges = new Map();

  if (!anchorIds.length) {
    return { bridges, articulation: new Map(), reachedCount: 0 };
  }

  const isDevice = (idx) => idx < ids.length && graph.nodes.get(ids[idx]).kind === 'device';
  const isSite = (idx) => idx < ids.length && graph.nodes.get(ids[idx]).kind === 'site';

  disc[superIndex] = 0;
  low[superIndex] = 0;
  subtreeNodes[superIndex] = 0;
  let timer = 1;
  const stack = [{ u: superIndex, i: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const list = adjacency[frame.u] || [];
    if (frame.i < list.length) {
      const edge = list[frame.i];
      frame.i += 1;
      if (parentEdge[frame.u] === edge.edgeId) continue;
      const v = edge.to;
      if (disc[v] === -1) {
        parent[v] = frame.u;
        parentEdge[v] = edge.edgeId;
        disc[v] = timer;
        low[v] = timer;
        timer += 1;
        subtreeNodes[v] = 1;
        subtreeDevices[v] = isDevice(v) ? 1 : 0;
        subtreeSites[v] = isSite(v) ? 1 : 0;
        stack.push({ u: v, i: 0 });
      } else {
        low[frame.u] = Math.min(low[frame.u], disc[v]);
      }
      continue;
    }
    stack.pop();
    const u = frame.u;
    if (u === superIndex) continue;
    const p = parent[u];
    if (p === -1) continue;
    low[p] = Math.min(low[p], low[u]);
    subtreeNodes[p] += subtreeNodes[u];
    subtreeDevices[p] += subtreeDevices[u];
    subtreeSites[p] += subtreeSites[u];
    if (p !== superIndex) {
      if (low[u] >= disc[p]) {
        artNodes[p] += subtreeNodes[u];
        artDevices[p] += subtreeDevices[u];
        artSites[p] += subtreeSites[u];
      }
      if (low[u] > disc[p] && !String(parentEdge[u]).startsWith('__anchor__:')) {
        bridges.set(parentEdge[u], {
          child: u,
          nodes: subtreeNodes[u],
          devices: subtreeDevices[u],
          sites: subtreeSites[u],
        });
      }
    }
  }

  const articulation = new Map();
  for (let i = 0; i < ids.length; i += 1) {
    if (artNodes[i] > 0) {
      articulation.set(ids[i], {
        nodes: artNodes[i],
        devices: artDevices[i],
        sites: artSites[i],
      });
    }
  }
  return { bridges, articulation };
}

function severityOf(deviceCount, totalDevices) {
  if (!deviceCount) return 'low';
  if (deviceCount >= 10 || (totalDevices > 0 && deviceCount / totalDevices >= 0.25)) return 'critical';
  if (deviceCount >= 4) return 'high';
  if (deviceCount >= 1) return 'medium';
  return 'low';
}

function pathLinkIds(nodeIds, graph) {
  const ids = [];
  const missing = [];
  for (let i = 0; i < nodeIds.length - 1; i += 1) {
    const from = nodeIds[i];
    const to = nodeIds[i + 1];
    const edge = (graph.adjacency.get(from) || []).find((item) => item.to === to);
    if (edge) ids.push(edge.id);
    else missing.push(`${from}→${to}`);
  }
  return { linkIds: ids, missing };
}

function routeStatus(linkIds, graph, overrides = null, blockedNode = null, pathNodes = []) {
  if (!linkIds.length) return 'unknown';
  if (blockedNode && pathNodes.includes(blockedNode)) return 'down';
  let anyUnknown = false;
  for (const id of linkIds) {
    const link = graph.links.get(id);
    if (!link) return 'down';
    const status = overrides?.get(id) ?? linkStatus(link);
    if (status === 'down') return 'down';
    if (status === 'degraded') return 'degraded';
    if (status !== 'up') anyUnknown = true;
  }
  return anyUnknown ? 'unknown' : 'up';
}

function pathView(path, graph, overrides = null, blockedNode = null) {
  const nodeIds = (Array.isArray(path.nodeIds) ? path.nodeIds : []).filter((id) => graph.nodes.has(id));
  const fromNode = graph.nodes.get(nodeIds[0]);
  const toNode = graph.nodes.get(nodeIds[nodeIds.length - 1]);
  const { linkIds, missing } = pathLinkIds(nodeIds, graph);
  // تجهیز واسطِ حذف‌شده یا offline مسیر را قطع می‌کند، حتی اگر وضعیت لینک
  // مجاور هنوز دادهٔ تازه‌ای نداشته باشد.
  const unavailableNode = nodeIds.some((id) => {
    const node = graph.nodes.get(id);
    return node?.kind === 'device' && !node.device;
  });
  const offlineNode = nodeIds.some((id) => nodeStatus(graph.nodes.get(id)) === 'offline');
  const status =
    missing.length || unavailableNode
      ? 'down'
      : offlineNode
        ? 'down'
        : routeStatus(linkIds, graph, overrides, blockedNode, nodeIds);
  return {
    id: path.id || `${path.name || 'path'}:${path.role || 'primary'}`,
    name: String(path.name || ''),
    role: path.role === 'backup' ? 'backup' : 'primary',
    nodeIds,
    linkIds,
    fromNodeId: nodeIds[0] || null,
    toNodeId: nodeIds[nodeIds.length - 1] || null,
    fromLabel: nodeLabel(fromNode),
    toLabel: nodeLabel(toNode),
    hops: Math.max(0, nodeIds.length - 1),
    status,
    broken: missing.length > 0 || unavailableNode || nodeIds.length < 2,
    missingSegments: missing,
    active: false,
  };
}

function groupPaths(paths, graph, overrides = null, blockedNode = null) {
  const groups = new Map();
  for (const raw of Array.isArray(paths) ? paths : []) {
    if (!raw || !Array.isArray(raw.nodeIds) || raw.nodeIds.length < 2) continue;
    const name = String(raw.name || 'مسیر بدون نام').trim().slice(0, 120) || 'مسیر بدون نام';
    const role = raw.role === 'backup' ? 'backup' : 'primary';
    const view = pathView({ ...raw, name }, graph, overrides, blockedNode);
    let group = groups.get(name);
    if (!group) {
      group = { name, primary: null, backup: null, activeRole: null, failover: false, status: 'unknown' };
      groups.set(name, group);
    }
    // یک نقش در هر گروه فقط یک مسیر دارد؛ آخرین تعریف معتبر جای قبلی را می‌گیرد.
    group[role] = view;
  }
  const list = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'fa'));
  for (const group of list) {
    const primaryUp = group.primary?.status === 'up';
    const primaryDown = group.primary?.status === 'down';
    const backupUp = group.backup?.status === 'up';
    // فقط «قطع» اصلی باعث failover می‌شود؛ اختلال یا دادهٔ نامشخص، مسیر را
    // جابه‌جا نمی‌کند تا یک Snapshot قدیمی ترافیک را بی‌دلیل به پشتیبان نفرستد.
    if (primaryDown && backupUp) group.activeRole = 'backup';
    else if (group.primary) group.activeRole = 'primary';
    else if (!group.primary && backupUp) group.activeRole = 'backup';
    else group.activeRole = null;
    group.failover = group.activeRole === 'backup';
    if (group.primary) group.primary.active = group.activeRole === 'primary';
    if (group.backup) group.backup.active = group.activeRole === 'backup';
    if (!group.primary && !group.backup) group.status = 'unknown';
    else if (primaryUp) group.status = 'normal';
    else if (group.activeRole === 'backup') group.status = 'failover';
    else if (primaryDown) group.status = 'critical';
    else if (!group.primary && group.backup?.status === 'down') group.status = 'critical';
    else group.status = 'degraded';
  }
  return list;
}

/**
 * تحلیل کامل دیاگرام. ورودی خالص و قابل آزمون است.
 * @param {{nodes: any[], links: any[], paths?: any[], now?: number}} input
 */
export function analyzeTopology({ nodes = [], links = [], paths = [], now = Date.now() } = {}) {
  const graph = buildGraph(nodes, links);
  const anchors = chooseAnchors(graph);
  const full = reachFromAnchors(graph, anchors.ids);
  const { bridges, articulation } = connectivityRisks(graph, anchors.ids);

  const blockedLiveNodes = new Set(
    graph.order.filter((id) => nodeStatus(graph.nodes.get(id)) === 'offline')
  );
  const blockedLiveLinks = new Set(
    [...graph.links.values()].filter((link) => linkStatus(link) === 'down').map((link) => link.id)
  );
  const current = reachFromAnchors(graph, anchors.ids, {
    blockedLinks: blockedLiveLinks,
    blockedNodes: blockedLiveNodes,
  });

  // گره‌هایی که با وضعیت فعلی به هیچ مرکز زیرساختی نمی‌رسند.
  const currentUnreachable = new Set();
  for (const id of graph.order) {
    if (full.reached.has(id) && !current.reached.has(id)) currentUnreachable.add(id);
  }
  const affectedNow = new Set(currentUnreachable);
  for (const id of blockedLiveNodes) {
    if (full.reached.has(id)) affectedNow.add(id);
  }

  // مسیرهای مشکل‌دار: مسیر کوتاه هر گرهٔ متأثر تا نزدیک‌ترین مرکز، روی گراف
  // کامل. این مسیر شامل لینک خراب/دستگاه قطع‌شده است و محل قطع را نشان می‌دهد.
  const problemPathLinks = new Set();
  const problemPathNodes = new Set();
  const affectedOrdered = graph.order
    .filter((id) => affectedNow.has(id))
    .sort((a, b) => {
      const da = graph.nodes.get(a).kind === 'device' ? 0 : 1;
      const db = graph.nodes.get(b).kind === 'device' ? 0 : 1;
      return da - db;
    });
  for (const id of affectedOrdered) {
    const path = pathFromParents(id, full.parent, full.parentLink);
    if (!path) continue;
    for (const nodeId of path.nodeIds) problemPathNodes.add(nodeId);
    for (const linkId of path.linkIds) problemPathLinks.add(linkId);
  }

  const criticalNodes = [];
  for (const [id, counts] of articulation) {
    const node = graph.nodes.get(id);
    if (!node) continue;
    const info = nodeInfo(node);
    // «تجهیز وابسته» شامل خود گره نمی‌شود؛ تعداد تجهیزاتِ پایین‌دست مهم است.
    if (counts.devices <= 0) continue;
    criticalNodes.push({
      ...info,
      dependentNodeCount: counts.nodes,
      dependentDeviceCount: counts.devices,
      dependentSiteCount: counts.sites,
      severity: severityOf(counts.devices, graph.deviceCount),
      severityLabel: SEVERITY_LABEL[severityOf(counts.devices, graph.deviceCount)],
      isArticulation: true,
    });
  }
  criticalNodes.sort(
    (a, b) => b.dependentDeviceCount - a.dependentDeviceCount || a.label.localeCompare(b.label, 'fa')
  );

  const riskyLinks = [];
  for (const [linkId, counts] of bridges) {
    const link = graph.links.get(linkId);
    if (!link) continue;
    const info = linkInfo(link, graph);
    const severity = severityOf(counts.devices, graph.deviceCount);
    riskyLinks.push({
      ...info,
      bridge: true,
      redundancy: false,
      dependentNodeCount: counts.nodes,
      dependentDeviceCount: counts.devices,
      dependentSiteCount: counts.sites,
      severity,
      severityLabel: SEVERITY_LABEL[severity],
    });
  }
  riskyLinks.sort(
    (a, b) => b.dependentDeviceCount - a.dependentDeviceCount || a.label.localeCompare(b.label, 'fa')
  );

  // مسیرهای اصلی/پشتیبان با وضعیت زنده.
  const redundancyGroups = groupPaths(paths, graph);
  const activeBackups = redundancyGroups.filter((group) => group.failover);

  // رخدادهای فعال: هر لینک قطع/دارای اختلال و هر تجهیز offline.
  // تعداد اثر هر رخداد با BFS واقعی (نه تخمین) محاسبه می‌شود؛ سقف ۲۰ رخداد
  // برای جلوگیری از پاسخ چندمگابایتی در شبکه‌های بزرگ.
  const incidents = [];
  const incidentLimit = 20;
  for (const link of graph.links.values()) {
    if (linkStatus(link) !== 'down' && linkStatus(link) !== 'degraded') continue;
    if (incidents.length >= incidentLimit) break;
    const reachedWithout = reachFromAnchors(graph, anchors.ids, {
      blockedLinks: new Set([link.id]),
      blockedNodes: blockedLiveNodes,
    });
    let count = 0;
    for (const id of full.reached) if (!reachedWithout.reached.has(id)) count += 1;
    const info = linkInfo(link, graph);
    incidents.push({
      type: 'link',
      id: info.id,
      label: info.label,
      status: info.status,
      reason: link.live?.reason || (info.status === 'down' ? 'این لینک در وضعیت قطع است.' : 'این لینک اختلال دارد.'),
      endpoints: [info.fromLabel, info.toLabel],
      affectedNodeCount: count,
      affectedDeviceCount: count ? countDevicesInGraph(graph, full, reachedWithout) : 0,
    });
  }
  for (const id of blockedLiveNodes) {
    if (incidents.length >= incidentLimit) break;
    if (!full.reached.has(id)) continue;
    const reachedWithout = reachFromAnchors(graph, anchors.ids, {
      blockedLinks: blockedLiveLinks,
      blockedNodes: new Set([...blockedLiveNodes, id]),
    });
    let count = 0;
    for (const nodeId of full.reached) {
      if (!reachedWithout.reached.has(nodeId)) count += 1;
    }
    const node = graph.nodes.get(id);
    const info = nodeInfo(node);
    incidents.push({
      type: 'node',
      id,
      label: info.label,
      status: 'offline',
      reason: node.device?.statusReason || 'این تجهیز در وضعیت قطع است.',
      endpoints: [info.ip || ''],
      affectedNodeCount: count,
      affectedDeviceCount: count,
    });
  }

  const cutPaths = affectedOrdered
    .filter((id) => graph.nodes.get(id).kind === 'device')
    .slice(0, 12)
    .map((id) => {
      const path = pathFromParents(id, full.parent, full.parentLink);
      if (!path) return null;
      const cutLink = path.linkIds
        .map((linkId) => graph.links.get(linkId))
        .find((link) => link && (linkStatus(link) === 'down' || linkStatus(link) === 'degraded'));
      const cutNode = path.nodeIds.find((nodeId) => blockedLiveNodes.has(nodeId));
      return {
        nodeId: id,
        label: nodeLabel(graph.nodes.get(id)),
        nodeIds: path.nodeIds,
        linkIds: path.linkIds,
        cutLinkId: cutLink?.id || null,
        cutLinkLabel: cutLink ? linkLabel(cutLink, graph) : '',
        cutNodeId: cutNode || null,
        cutNodeLabel: cutNode ? nodeLabel(graph.nodes.get(cutNode)) : '',
        pathLabels: path.nodeIds.map((nodeId) => nodeLabel(graph.nodes.get(nodeId))),
      };
    })
    .filter(Boolean);

  const anchorRecords = anchors.ids.map((id) => {
    const info = nodeInfo(graph.nodes.get(id));
    return { ...info, reason: anchors.source };
  });

  const unreachableDevices = [...currentUnreachable].filter(
    (id) => graph.nodes.get(id).kind === 'device'
  ).length;
  const isolatedDevices = graph.order.filter(
    (id) => graph.nodes.get(id).kind === 'device' && !full.reached.has(id)
  ).length;

  return {
    generatedAt: now,
    anchorSource: anchors.source,
    anchors: anchorRecords,
    warning:
      anchors.source === 'inferred'
        ? 'هیچ مرکز تجمع یا ابر متصلی ثبت نشده است؛ تجهیز مرکزی با بیشترین اتصال به‌صورت خودکار مبنای تحلیل قرار گرفت.'
        : anchors.source === 'none'
          ? 'مرکز زیرساختی برای تحلیل دسترسی وجود ندارد؛ ابتدا مرکز تجمع/ابر را به دیاگرام متصل کنید.'
          : '',
    summary: {
      nodeCount: graph.order.length,
      linkCount: graph.links.size,
      deviceCount: graph.deviceCount,
      anchorCount: anchors.ids.length,
      reachableDeviceCount: graph.order.filter(
        (id) => graph.nodes.get(id).kind === 'device' && full.reached.has(id)
      ).length,
      affectedDeviceCount: affectedNow.size
        ? [...affectedNow].filter((id) => graph.nodes.get(id).kind === 'device').length
        : 0,
      unreachableDeviceCount: unreachableDevices,
      isolatedDeviceCount: isolatedDevices,
      criticalNodeCount: criticalNodes.length,
      riskyLinkCount: riskyLinks.length,
      redundancyGroupCount: redundancyGroups.length,
      activeBackupCount: activeBackups.length,
      incidentCount: incidents.length,
    },
    criticalNodes,
    riskyLinks,
    live: {
      affectedNodeIds: [...affectedNow],
      affectedDeviceCount: [...affectedNow].filter((id) => graph.nodes.get(id).kind === 'device').length,
      unreachableNodeIds: [...currentUnreachable],
      offlineNodeIds: [...blockedLiveNodes],
      problemLinkIds: [...blockedLiveLinks],
      degradedLinkIds: [...graph.links.values()]
        .filter((link) => linkStatus(link) === 'degraded')
        .map((link) => link.id),
      problemPathLinkIds: [...problemPathLinks],
      problemPathNodeIds: [...problemPathNodes],
      incidents,
      cutPaths,
    },
    redundancy: {
      groups: redundancyGroups,
      activeBackups: activeBackups.map((group) => group.name),
    },
  };
}

function countDevicesInGraph(graph, baseline, after) {
  let count = 0;
  for (const id of baseline.reached) {
    if (graph.nodes.get(id).kind !== 'device') continue;
    if (!after.reached.has(id)) count += 1;
  }
  return count;
}

/**
 * شبیه‌سازی تأثیر قطع یک لینک یا یک گره.
 * @param {{nodes:any[],links:any[],paths?:any[],target:{type:'link'|'node',id:string},now?:number}} input
 */
export function simulateTopologyImpact({
  nodes = [],
  links = [],
  paths = [],
  target,
  now = Date.now(),
} = {}) {
  const graph = buildGraph(nodes, links);
  const anchors = chooseAnchors(graph);
  if (!target || !target.id || (target.type !== 'link' && target.type !== 'node')) {
    return { error: 'هدف شبیه‌سازی معتبر نیست' };
  }
  if (!anchors.ids.length) {
    return { error: 'مرکز زیرساختی برای شبیه‌سازی وجود ندارد', anchorSource: anchors.source };
  }
  const full = reachFromAnchors(graph, anchors.ids);
  if (target.type === 'link' && !graph.links.has(target.id)) return { error: 'لینک یافت نشد' };
  if (target.type === 'node' && !graph.nodes.has(target.id)) return { error: 'گره یافت نشد' };

  const blockedLinks = target.type === 'link' ? new Set([target.id]) : null;
  const blockedNodes = target.type === 'node' ? new Set([target.id]) : null;
  const after = reachFromAnchors(graph, anchors.ids, { blockedLinks, blockedNodes });
  const affected = new Set();
  for (const id of full.reached) {
    if (!after.reached.has(id)) affected.add(id);
  }
  // خود تجهیزِ شبیه‌سازی‌شده در تأثیر خرابی حساب می‌شود.
  if (target.type === 'node' && full.reached.has(target.id)) affected.add(target.id);

  const targetNode = target.type === 'node' ? graph.nodes.get(target.id) : null;
  const targetLink = target.type === 'link' ? graph.links.get(target.id) : null;
  const info =
    target.type === 'link'
      ? {
          ...linkInfo(targetLink, graph),
          type: 'link',
        }
      : {
          ...nodeInfo(targetNode),
          type: 'node',
        };

  const affectedOrdered = graph.order.filter((id) => affected.has(id));
  const affectedDevices = affectedOrdered
    .filter((id) => graph.nodes.get(id).kind === 'device')
    .map((id) => {
      const infoNode = nodeInfo(graph.nodes.get(id));
      return { ...infoNode, isTarget: id === target.id };
    });
  const downstreamDevices = affectedDevices.filter((item) => !item.isTarget);
  const affectedSites = new Set();
  for (const id of affectedOrdered) {
    const node = graph.nodes.get(id);
    if (node.kind === 'site') affectedSites.add(id);
    const siteId = node.siteId ?? node.site_id;
    if (siteId != null) affectedSites.add(`site:${siteId}`);
  }

  // مسیرهای نمونه از تجهیزات متأثر تا نزدیک‌ترین مرکز (حداکثر ۱۰ مسیر).
  const pathLinkIds = new Set();
  const pathNodeIds = new Set();
  const previewPaths = affectedDevices.slice(0, 10).map((device) => {
    const path = pathFromParents(device.id, full.parent, full.parentLink);
    if (!path) return null;
    for (const id of path.nodeIds) pathNodeIds.add(id);
    for (const id of path.linkIds) pathLinkIds.add(id);
    return {
      nodeId: device.id,
      label: device.label,
      nodeIds: path.nodeIds,
      linkIds: path.linkIds,
      pathLabels: path.nodeIds.map((id) => nodeLabel(graph.nodes.get(id))),
      cutLinkId: target.type === 'link' ? target.id : null,
      cutNodeId: target.type === 'node' ? target.id : null,
    };
  }).filter(Boolean);
  if (target.type === 'link') pathLinkIds.add(target.id);

  // وضعیت مسیرهای جایگزین در همین سناریو: اگر هدف قطع شود، کدام پشتیبان فعال می‌شود؟
  const overrides = target.type === 'link' ? new Map([[target.id, 'down']]) : null;
  const simulatedGroups = groupPaths(
    paths,
    graph,
    overrides,
    target.type === 'node' ? target.id : null
  );
  const backupActivated = simulatedGroups
    .filter((group) => group.failover)
    .map((group) => ({
      name: group.name,
      primaryStatus: group.primary?.status || 'unknown',
      backupStatus: group.backup?.status || 'unknown',
      backupPathId: group.backup?.id || null,
      backupHops: group.backup?.hops ?? 0,
    }));

  const affectedWithoutTarget = target.type === 'node'
    ? affectedDevices.filter((device) => !device.isTarget).length
    : affectedDevices.length;

  return {
    generatedAt: now,
    anchorSource: anchors.source,
    target: info,
    summary: {
      affectedNodeCount: affectedOrdered.length,
      affectedDeviceCount: affectedDevices.length,
      downstreamDeviceCount: downstreamDevices.length,
      affectedSiteCount: affectedSites.size,
      severity: severityOf(affectedDevices.length, graph.deviceCount),
      severityLabel: SEVERITY_LABEL[severityOf(affectedDevices.length, graph.deviceCount)],
      alternateRoute: affectedWithoutTarget === 0,
      baselineReachable: full.reached.size,
      alreadyAffected: target.type === 'node'
        ? nodeStatus(targetNode) === 'offline'
        : linkStatus(targetLink) === 'down',
    },
    affected: {
      nodeIds: affectedOrdered,
      devices: affectedDevices.slice(0, 200),
      deviceCount: affectedDevices.length,
      truncated: affectedDevices.length > 200,
      siteCount: affectedSites.size,
    },
    paths: previewPaths,
    pathLinkIds: [...pathLinkIds],
    pathNodeIds: [...pathNodeIds],
    backupActivated,
  };
}

export { buildGraph as buildTopologyGraph, chooseAnchors as chooseTopologyAnchors };
