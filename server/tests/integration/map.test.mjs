/**
 * آزمون API نقشه و وضعیت:
 *   • تعداد کل / دارای مختصات / بدون مختصات مستقل و درست است.
 *   • بیش از ۵۰۰ تجهیز دارای مختصات برمی‌گردند (محدودیت قبلی حذف شده).
 *   • فیلتر bbox فقط نقاط همان محدوده را برمی‌گرداند ولی آمار سراسری را خراب نمی‌کند.
 *   • پردازش فایل بزرگ در Worker، پاسخ‌دهی API را متوقف نمی‌کند.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, startServer, api, sessionFor } from '../helpers.mjs';

const dir = useTempDataDir('map-api');
let srv;
let baseline;
let expected;

const A_COUNT = 620;
const B_COUNT = 40;
const NO_GEO = 7;

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function devicesCsv(rows) {
  const header = ['name', 'ip', 'group', 'latitude', 'longitude'];
  return [header.join(','), ...rows.map((r) => header.map((k) => csvEscape(r[k])).join(','))].join('\n');
}

async function upload(base, path, content, filename) {
  const session = sessionFor(base);
  const fd = new FormData();
  fd.append('file', new Blob([content], { type: 'text/csv' }), filename);
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, origin: base },
    body: fd,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* پاسخ غیر JSON */
  }
  return { status: res.status, data };
}

function mapCsv() {
  const rows = [];
  for (let i = 0; i < A_COUNT; i++) {
    rows.push({
      name: `map-a-${i}`,
      ip: `10.40.${Math.floor(i / 250)}.${(i % 250) + 1}`,
      group: 'نقشه الف',
      latitude: (35.6 + (i % 20) * 0.01).toFixed(5),
      longitude: (51.3 + (i % 30) * 0.01).toFixed(5),
    });
  }
  for (let i = 0; i < B_COUNT; i++) {
    rows.push({
      name: `map-b-${i}`,
      ip: `10.41.${Math.floor(i / 250)}.${(i % 250) + 1}`,
      group: 'نقشه ب',
      latitude: (40 + i * 0.001).toFixed(5),
      longitude: (44 + i * 0.001).toFixed(5),
    });
  }
  return devicesCsv(rows);
}

before(async () => {
  srv = await startServer({ dataDir: dir, engine: false });
  // seedIfEmpty چند تجهیز نمایشی می‌سازد؛ همهٔ شمارش‌ها نسبت به همین خط پایه‌اند
  const before = await api(srv.base, 'GET', '/api/devices/map');
  const bboxA = await api(srv.base, 'GET', '/api/devices/map?bbox=51.2,35.5,51.7,36.0&zoom=12');
  const bboxB = await api(srv.base, 'GET', '/api/devices/map?bbox=43.5,39.5,45,41&zoom=10');
  const statusBefore = await api(srv.base, 'GET', '/api/status');
  baseline = {
    total: before.data.total,
    withGeo: before.data.withGeo,
    missingGeo: before.data.missingGeo,
    bboxA: bboxA.data.returned,
    bboxB: bboxB.data.returned,
    down: statusBefore.data.devices.down,
    monitoring: statusBefore.data.devices.monitoring,
  };
  const imported = await upload(srv.base, '/api/devices/import/commit', mapCsv(), 'map.csv');
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  assert.equal(imported.data.inserted, A_COUNT + B_COUNT);

  for (let i = 0; i < NO_GEO; i++) {
    const res = await api(srv.base, 'POST', '/api/devices', {
      name: `no-geo-${i}`,
      ip: `10.42.0.${i + 1}`,
    });
    assert.equal(res.status, 201);
  }
  expected = {
    total: baseline.total + A_COUNT + B_COUNT + NO_GEO,
    withGeo: baseline.withGeo + A_COUNT + B_COUNT,
    missingGeo: baseline.missingGeo + NO_GEO,
    addedGeo: A_COUNT + B_COUNT,
    bboxA: baseline.bboxA + A_COUNT,
    bboxB: baseline.bboxB + B_COUNT,
    down: baseline.down,
    monitoring: baseline.monitoring + A_COUNT + B_COUNT + NO_GEO,
  };
});

after(async () => {
  await srv.stop();
  cleanupDir(dir);
});

test('map API reports independent totals and returns more than 500 devices', async () => {
  const started = Date.now();
  const res = await api(srv.base, 'GET', '/api/devices/map');
  const ms = Date.now() - started;
  assert.equal(res.status, 200);
  assert.equal(res.data.total, expected.total, 'total includes devices without coordinates');
  assert.equal(res.data.withGeo, expected.withGeo);
  assert.equal(res.data.missingGeo, expected.missingGeo, 'missing-geo count must be independent of the list total');
  assert.equal(res.data.returned, expected.withGeo);
  assert.ok(res.data.items.length > 500, `expected >500 markers, got ${res.data.items.length}`);
  assert.equal(res.data.truncated, false);
  assert.equal(
    res.data.stats.online + res.data.stats.warning + res.data.stats.offline + res.data.stats.maintenance + res.data.stats.unknown,
    expected.withGeo
  );
  const item = res.data.items[0];
  assert.ok(typeof item.latitude === 'number' && typeof item.longitude === 'number');
  assert.ok(item.name && item.ip, 'lightweight payload keeps the fields needed by popups');
  console.log(`  map payload: ${res.data.returned} markers in ${ms} ms (${(JSON.stringify(res.data).length / 1024).toFixed(1)} KiB)`);
  assert.ok(ms < 4000, `map response too slow: ${ms} ms`);
});

test('bbox limits returned markers but keeps global totals and missing count intact', async () => {
  const a = await api(srv.base, 'GET', '/api/devices/map?bbox=51.2,35.5,51.7,36.0&zoom=12');
  assert.equal(a.status, 200);
  assert.equal(a.data.total, expected.total);
  assert.equal(a.data.withGeo, expected.withGeo);
  assert.equal(a.data.missingGeo, expected.missingGeo);
  assert.equal(a.data.returned, expected.bboxA, 'only cluster A (plus seed devices in the box) is inside the bbox');
  assert.ok(a.data.items.every((d) => d.latitude >= 35.5 && d.latitude <= 36.0));

  const b = await api(srv.base, 'GET', '/api/devices/map?bbox=43.5,39.5,45,41&zoom=10');
  assert.equal(b.data.returned, expected.bboxB, 'only cluster B (plus seed devices in the box) is inside the bbox');
  assert.equal(b.data.missingGeo, expected.missingGeo);
});

test('map filters (search/group) apply to both totals and items', async () => {
  const res = await api(srv.base, 'GET', '/api/devices/map?group=' + encodeURIComponent('نقشه ب'));
  assert.equal(res.status, 200);
  assert.equal(res.data.total, B_COUNT);
  assert.equal(res.data.withGeo, B_COUNT);
  assert.equal(res.data.missingGeo, 0, 'no coordinate-less device belongs to this group');
  assert.equal(res.data.returned, B_COUNT);

  const searched = await api(srv.base, 'GET', '/api/devices/map?search=10.40.0.250');
  assert.equal(searched.status, 200);
  assert.equal(searched.data.total, 1);
  assert.equal(searched.data.returned, 1);
});

test('status endpoint separates server, engine and device state', async () => {
  const res = await api(srv.base, 'GET', '/api/status');
  assert.equal(res.status, 200);
  assert.equal(res.data.server.ok, true);
  assert.equal(res.data.engine.running, false, 'test server starts with the engine disabled');
  assert.equal(res.data.engine.stale, false);
  assert.equal(res.data.devices.total, expected.total);
  assert.equal(res.data.devices.down, expected.down);
  assert.equal(res.data.devices.monitoring, expected.monitoring);
  assert.ok(typeof res.data.generatedAt === 'number');

  const raw = await fetch(`${srv.base}/api/status`);
  assert.ok([401, 403].includes(raw.status), 'status must require an authenticated session');
});

test('a large spreadsheet preview runs in a worker without blocking other API requests', async () => {
  const bigRows = [];
  for (let i = 0; i < 20000; i++) {
    bigRows.push({ name: `bulk-${i}`, ip: `10.50.${Math.floor(i / 250)}.${(i % 250) + 1}` });
  }
  const bigCsv = devicesCsv(bigRows);
  const previewPromise = upload(srv.base, '/api/devices/import/preview', bigCsv, 'big.csv');

  // در حین پارس ۲۰٬۰۰۰ ردیف، سرور باید به درخواست‌های سبک پاسخ دهد
  const latencies = [];
  for (let i = 0; i < 12; i++) {
    const t = Date.now();
    const res = await fetch(`${srv.base}/api/health`);
    await res.text();
    latencies.push(Date.now() - t);
    await new Promise((r) => setTimeout(r, 25));
  }

  const preview = await previewPromise;
  assert.equal(preview.status, 200, JSON.stringify(preview.data).slice(0, 300));
  assert.equal(preview.data.totalRows, 20000);
  assert.equal(preview.data.summary.valid, 20000);
  const max = Math.max(...latencies);
  console.log(`  heavy preview: max health latency ${max} ms across ${latencies.length} probes`);
  assert.ok(max < 2000, `API was blocked during heavy parsing (max ${max} ms)`);
});
