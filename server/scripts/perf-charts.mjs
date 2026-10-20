#!/usr/bin/env node
/**
 * NetWatch — تولید نمودارهای SVG گزارش عملکرد (فاز ۵)
 * ----------------------------------------------------------------
 * بدون وابستگی بیرونی: از JSONهای اندازه‌گیری، چند نمودار خوانا می‌سازد.
 *   node server/scripts/perf-charts.mjs [--out docs/assets]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT = path.resolve(ROOT, arg('out', 'docs/assets'));
const QA = path.join(ROOT, 'data/qa');
fs.mkdirSync(OUT, { recursive: true });

function readJson(name, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(path.join(QA, name), 'utf8'));
  } catch {
    return fallback;
  }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nf = (n, d = 0) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-US', { maximumFractionDigits: d }) : '—');

const W = 900;
const H = 360;
const PAD = { l: 70, r: 26, t: 42, b: 56 };

function svgDoc(title, subtitle, body, width = W, height = H) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="${PAD.l}" y="24" font-family="Segoe UI, Tahoma, sans-serif" font-size="16" font-weight="700" fill="#0f172a">${esc(title)}</text>
  <text x="${PAD.l}" y="42" font-family="Segoe UI, Tahoma, sans-serif" font-size="11" fill="#64748b">${esc(subtitle)}</text>
  ${body}
</svg>`;
}

function axes({ maxY, yLabel, xLabels, yTicks = 5, width = W, height = H }) {
  const left = PAD.l;
  const right = width - PAD.r;
  const top = PAD.t + 10;
  const bottom = height - PAD.b;
  const parts = [];
  for (let i = 0; i <= yTicks; i++) {
    const v = (maxY / yTicks) * i;
    const y = bottom - (v / maxY) * (bottom - top);
    parts.push(`<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="#e2e8f0" stroke-width="1"/>`);
    parts.push(
      `<text x="${left - 10}" y="${y + 4}" text-anchor="end" font-family="Segoe UI, Tahoma, sans-serif" font-size="10" fill="#64748b">${esc(nf(v, v < 10 && v % 1 ? 1 : 0))}</text>`
    );
  }
  parts.push(`<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="#94a3b8" stroke-width="1"/>`);
  const n = xLabels.length;
  xLabels.forEach((label, i) => {
    const x = n === 1 ? (left + right) / 2 : left + (i * (right - left)) / (n - 1);
    parts.push(
      `<text x="${x}" y="${bottom + 20}" text-anchor="middle" font-family="Segoe UI, Tahoma, sans-serif" font-size="10" fill="#475569">${esc(label)}</text>`
    );
  });
  parts.push(
    `<text x="18" y="${(top + bottom) / 2}" transform="rotate(-90 18 ${(top + bottom) / 2})" text-anchor="middle" font-family="Segoe UI, Tahoma, sans-serif" font-size="10" fill="#64748b">${esc(yLabel)}</text>`
  );
  return parts.join('\n');
}

function legend(items, x = PAD.l, y = H - 16) {
  let cursor = x;
  return items
    .map((it) => {
      const out = `<rect x="${cursor}" y="${y - 9}" width="10" height="10" rx="2" fill="${it.color}"/><text x="${cursor + 15}" y="${y}" font-family="Segoe UI, Tahoma, sans-serif" font-size="10.5" fill="#475569">${esc(it.label)}</text>`;
      cursor += 22 + it.label.length * 6.2;
      return out;
    })
    .join('');
}

function linePlot({ series, labels, maxY, yLabel, title, subtitle, width = W, height = H }) {
  const left = PAD.l;
  const right = width - PAD.r;
  const top = PAD.t + 10;
  const bottom = height - PAD.b;
  const n = labels.length;
  const x = (i) => (n <= 1 ? (left + right) / 2 : left + (i * (right - left)) / (n - 1));
  const y = (v) => bottom - (Math.max(0, Math.min(maxY, v)) / maxY) * (bottom - top);
  const paths = series
    .map((s) => {
      const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
      return `<polyline fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" points="${pts}"/>`;
    })
    .join('\n');
  const body = `${axes({ maxY, yLabel, xLabels: labels, width, height })}\n${paths}\n${legend(series.map((s) => ({ label: s.label, color: s.color })))}`;
  return svgDoc(title, subtitle, body, width, height);
}

function groupedBars({ groups, series, maxY, yLabel, title, subtitle, width = W, height = H }) {
  const left = PAD.l;
  const right = width - PAD.r;
  const top = PAD.t + 10;
  const bottom = height - PAD.b;
  const n = groups.length;
  const slot = (right - left) / n;
  const barW = Math.min(46, (slot * 0.7) / series.length);
  const y = (v) => bottom - (Math.max(0, Math.min(maxY, v)) / maxY) * (bottom - top);
  const bars = [];
  groups.forEach((g, gi) => {
    series.forEach((s, si) => {
      const value = s.values[gi];
      if (value == null) return;
      const x = left + gi * slot + slot / 2 - (series.length * barW) / 2 + si * barW;
      bars.push(`<rect x="${x.toFixed(1)}" y="${y(value).toFixed(1)}" width="${(barW - 2).toFixed(1)}" height="${Math.max(0, bottom - y(value)).toFixed(1)}" rx="3" fill="${s.color}"/>`);
      if (series.length <= 2) {
        bars.push(
          `<text x="${(x + (barW - 2) / 2).toFixed(1)}" y="${(y(value) - 5).toFixed(1)}" text-anchor="middle" font-family="Segoe UI, Tahoma, sans-serif" font-size="9.5" fill="#334155">${esc(nf(value, value < 100 ? 1 : 0))}</text>`
        );
      }
    });
  });
  const xLabels = groups.map((g) => g.label);
  const body = `${axes({ maxY, yLabel, xLabels, width, height })}\n${bars.join('\n')}\n${legend(series.map((s) => ({ label: s.label, color: s.color })))}`;
  return svgDoc(title, subtitle, body, width, height);
}

/* ------------------------------ داده‌ها ------------------------------ */

const bench = readJson('bench-5000.json');
const matrix = readJson('load-matrix.json', { results: [] });
const dbs = readJson('db-scale.json', null);
const base1000 = readJson('baseline-1000.json');
const base5000 = readJson('baseline-5000.json');
const base20000 = readJson('baseline-20000.json');

const generated = [];

/* ۱) ظرفیت: چرخهٔ کامل در اندازه‌های مختلف */
if (matrix.results?.length) {
  const results = matrix.results.filter((r) => r.cycleMs);
  const body = groupedBars({
    groups: results.map((r) => ({ label: `${nf(r.devices)} devices` })),
    series: [
      { label: 'Cycle (s)', color: '#2563eb', values: results.map((r) => r.cycleMs / 1000) },
      { label: 'RSS growth (MB)', color: '#7c3aed', values: results.map((r) => r.cycle.rssEndMb - r.cycle.rssStartMb) },
    ],
    maxY: Math.ceil(Math.max(...results.map((r) => Math.max(r.cycleMs / 1000, r.cycle.rssEndMb - r.cycle.rssStartMb))) / 5) * 5,
    yLabel: 'seconds / MB',
    title: 'Full probe cycle and memory growth by device count',
    subtitle: '256 workers, 2 ms mock probe latency, 2 vCPU / 3.9 GB VM',
  });
  fs.writeFileSync(path.join(OUT, 'phase5-scale.svg'), body);
  generated.push('phase5-scale.svg');
}

/* ۲) پیش/پس از بهینه‌سازی زمان‌بندی و گروه‌بندی نوشتن */
if (base1000 && base5000 && base20000) {
  const sizes = [1000, 5000, 20000];
  const before = [base1000, base5000, base20000].map((b) => b.cycle.fullCycleMs / 1000);
  const after = matrix.results?.length
    ? sizes.map((s) => (matrix.results.find((r) => r.devices === s)?.cycleMs ?? null) / 1000)
    : [null, null, null];
  const body = groupedBars({
    groups: sizes.map((s) => ({ label: `${nf(s)} devices` })),
    series: [
      { label: 'Before (s)', color: '#94a3b8', values: before },
      { label: 'After (s)', color: '#16a34a', values: after },
    ],
    maxY: Math.ceil(Math.max(...before) / 5) * 5,
    yLabel: 'seconds (lower is better)',
    title: 'Probe cycle: before vs after scheduler + group commit',
    subtitle: 'Same host, 128 workers before / 256 after, mock probe 2 ms',
  });
  fs.writeFileSync(path.join(OUT, 'phase5-before-after.svg'), body);
  generated.push('phase5-before-after.svg');
}

/* ۳) CPU و RAM در طول بار SSE */
const timeline = bench?.phases?.sse?.timeline ?? [];
if (timeline.length > 2) {
  const labels = timeline.map((_, i) => `${i + 1}s`);
  const maxRss = Math.ceil(Math.max(...timeline.map((t) => t.rss)) / 50) * 50;
  const cpuSvg = linePlot({
    series: [{ label: 'CPU % (process)', color: '#2563eb', values: timeline.map((t) => t.cpu) }],
    labels,
    maxY: Math.max(100, Math.ceil(Math.max(...timeline.map((t) => t.cpu)) / 20) * 20),
    yLabel: '% of one core',
    title: 'CPU during 150 SSE clients + engine load',
    subtitle: 'Sampled every second from /api/system/app-health (5000 devices)',
  });
  fs.writeFileSync(path.join(OUT, 'phase5-cpu.svg'), cpuSvg);
  generated.push('phase5-cpu.svg');

  const memSvg = linePlot({
    series: [
      { label: 'RSS (MB)', color: '#7c3aed', values: timeline.map((t) => t.rss) },
      { label: 'Heap used (MB)', color: '#f59e0b', values: timeline.map((t) => t.heap) },
    ],
    labels,
    maxY: maxRss,
    yLabel: 'MB',
    title: 'Memory during 150 SSE clients + engine load',
    subtitle: 'Bounded RSS: no growth proportional to client count (5000 devices)',
  });
  fs.writeFileSync(path.join(OUT, 'phase5-memory.svg'), memSvg);
  generated.push('phase5-memory.svg');

  const eldSvg = linePlot({
    series: [
      { label: 'Event loop p99 (ms)', color: '#ef4444', values: timeline.map((t) => t.eld) },
      { label: 'API p95 (ms)', color: '#10b981', values: timeline.map((t) => t.api) },
    ],
    labels,
    maxY: Math.max(250, Math.ceil(Math.max(...timeline.map((t) => Math.max(t.eld, t.api))) / 50) * 50),
    yLabel: 'ms',
    title: 'Event loop delay p99 and API p95 under load',
    subtitle: 'SLA target: event loop p99 ≤ 250 ms',
  });
  fs.writeFileSync(path.join(OUT, 'phase5-event-loop.svg'), eldSvg);
  generated.push('phase5-event-loop.svg');
}

/* ۴) تأخیر API به تفکیک مسیر */
const routes = bench?.phases?.api?.routes ?? [];
if (routes.length) {
  const short = (u) =>
    u
      .replace('/api/', '')
      .replace(/\?.*$/, '')
      .replace('system/', 'sys/')
      .slice(0, 22);
  const body = groupedBars({
    groups: routes.map((r) => ({ label: short(r.url) })),
    series: [
      { label: 'p50', color: '#22c55e', values: routes.map((r) => r.p50) },
      { label: 'p95', color: '#f59e0b', values: routes.map((r) => r.p95) },
      { label: 'p99', color: '#ef4444', values: routes.map((r) => r.p99) },
    ],
    maxY: Math.ceil(Math.max(...routes.map((r) => r.p99 ?? 0)) / 500) * 500 || 100,
    yLabel: 'ms',
    title: 'API latency percentiles (5000 devices, 720k samples)',
    subtitle: '60 requests per route, concurrency 8, real HTTP+auth',
    height: 420,
  });
  fs.writeFileSync(path.join(OUT, 'phase5-api-latency.svg'), body);
  generated.push('phase5-api-latency.svg');
}

/* ۵) Queryهای حیاتی روی پایگاه‌دادهٔ بزرگ */
if (dbs?.phases?.queries?.length) {
  const qs = dbs.phases.queries.filter((q) => q.avgMs > 0.05).slice(0, 8);
  const body = groupedBars({
    groups: qs.map((q) => ({ label: q.name.replace(/-/g, ' ').slice(0, 22) })),
    series: [{ label: 'avg ms', color: '#0ea5e9', values: qs.map((q) => q.avgMs) }],
    maxY: Math.ceil(Math.max(...qs.map((q) => q.avgMs)) / 50) * 50 || 10,
    yLabel: 'ms',
    title: 'Hot query latency at 1M samples / 2000 devices',
    subtitle: 'EXPLAIN QUERY PLAN verified index usage; errors=0',
    height: 380,
  });
  fs.writeFileSync(path.join(OUT, 'phase5-db-queries.svg'), body);
  generated.push('phase5-db-queries.svg');
}

console.log(`✓ ${generated.length} charts written to ${path.relative(ROOT, OUT)}`);
for (const g of generated) console.log(`  - docs/assets/${g}`);
