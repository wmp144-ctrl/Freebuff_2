/**
 * NetWatch — آزمون دود (Smoke Test)
 * ----------------------------------------------------------------
 * رفتارهای کلیدی را روی پایگاه‌دادهٔ موقت بررسی می‌کند؛ داده‌های واقعی
 * پوشهٔ data/ دست‌نخورده می‌مانند.
 *
 * اجرا:  npm test
 *
 * پوشش:
 *   • ریتم بررسی موتور (بازهٔ تنظیم‌شده واقعاً رعایت شود)
 *   • زنجیرهٔ در دسترس → قطعی → هشدار → بازگشت، و قاعدهٔ «تعداد موفقیت برای بازگشت»
 *   • برابری عددی سری روزانه (daily_stats) با محاسبهٔ مستقیم روی نمونه‌ها
 *   • اعتبارسنجی تنظیمات و پارامترهای Ping دستی
 *   • گارد same-origin، هدرهای امنیتی، سقف اتصال‌های زنده
 *   • سلامت داشبورد، گزارش‌ها و خروجی‌های CSV/XLSX
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SERVER_DIR, '..');

let pass = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${extra ? `  ← ${extra}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `netwatch-${tag}-`));

/* ------------------------------------------------------------------ */
/* ۱) موتور: ریتم بررسی، زنجیرهٔ قطعی و بازگشت                          */
/* ------------------------------------------------------------------ */

console.log('\n— موتور پایش —');
const engineDir = tmpDir('engine');
process.env.NETWATCH_DATA_DIR = engineDir;

const { db, setSettings } = await import('../db.js');
const { engine } = await import('../engine.js');
const { dailySeries, dayStart, DAY_MS } = await import('../daily.js');

// -- ریتم: پنج تجهیز با بازهٔ ۵ ثانیه --
{
  const now = Date.now();
  const ids = [];
  for (let i = 1; i <= 5; i++) {
    ids.push(
      Number(
        db
          .prepare("INSERT INTO devices(name, ip, status, enabled, monitoring_enabled, ping_interval, next_check_at, created_at, updated_at) VALUES (?,?,?,1,1,5,0,?,?)")
          .run(`cad-${i}`, `10.7.0.${i}`, 'unknown', now, now).lastInsertRowid
      )
    );
  }
  const t0 = Date.now();
  await engine.start();
  await sleep(13000);
  engine.stop();
  const seconds = (Date.now() - t0) / 1000;
  let worst = 0;
  for (const id of ids) {
    const rows = db.prepare('SELECT ts FROM samples WHERE device_id=? ORDER BY ts').all(id);
    const gaps = rows.slice(1).map((r, i) => (r.ts - rows[i].ts) / 1000);
    if (gaps.length) worst = Math.max(worst, Math.abs(gaps.reduce((a, b) => a + b, 0) / gaps.length - 5));
  }
  ok('هر تجهیز در ۱۳ ثانیه با بازهٔ ۵ ثانیه، ۲ تا ۴ بار بررسی شد', db.prepare('SELECT device_id, COUNT(*) c FROM samples GROUP BY device_id HAVING c < 2 OR c > 4').all().length === 0, `ثانیه=${seconds.toFixed(1)}`);
  ok('بازهٔ واقعی بررسی‌ها با تنظیمات هم‌خوان است (±۰٫۵ ثانیه)', worst < 0.5, `بیشترین اختلاف=${worst.toFixed(2)}s`);
  ok('پس از توقف موتور، بررسی در جریانی نمی‌ماند', engine.getStatus().inflight === 0);
}

// -- زنجیرهٔ کامل با پروب TCP روی یک پورت محلی --
{
  const PORT = 18099;
  let listener = null;
  const openPort = () =>
    new Promise((res) => {
      listener = net.createServer((s) => s.end());
      listener.listen(PORT, '127.0.0.1', () => res(true));
    });
  const closePort = () => new Promise((res) => (listener ? listener.close(() => res(true)) : res(true)));

  await openPort();
  setSettings({
    engine_mode: 'tcp',
    tcp_port: PORT,
    ping_interval: 5,
    timeout_ms: 800,
    retries: 0,
    packet_count: 1,
    failures_for_offline: 3,
    successes_for_online: 2,
  });
  // مسیر PUT /api/settings هم همین کار را می‌کند (کش موتور را باطل می‌کند)؛
  // تغییر مستقیم تنظیمات در پایگاه‌داده باید خودش کش را تازه کند.
  engine.invalidate();

  const now = Date.now();
  const id = Number(
    db
      .prepare("INSERT INTO devices(name, ip, status, enabled, monitoring_enabled, next_check_at, created_at, updated_at) VALUES (?,?,?,1,1,0,?,?)")
      .run('chain-test', '127.0.0.1', 'unknown', now, now).lastInsertRowid
  );
  const row = () => db.prepare('SELECT * FROM devices WHERE id=?').get(id);
  const check = () => engine.checkDevice(row(), { manual: true, source: 'manual' });

  await check();
  ok('پورت باز → وضعیت در دسترس', row().status === 'online', `status=${row().status}`);

  await closePort();
  for (let i = 0; i < 3; i++) await check();
  ok('سه شکست متوالی → وضعیت قطع‌شده', row().status === 'offline', `status=${row().status}`);
  ok('رکورد قطعی باز ساخته می‌شود', db.prepare('SELECT COUNT(*) c FROM outages WHERE device_id=? AND open=1').get(id).c === 1);
  ok('علت قطعی ثبت می‌شود', String(db.prepare('SELECT cause FROM outages WHERE device_id=? ORDER BY id DESC LIMIT 1').get(id)?.cause || '').length > 0);
  ok('هشدار بحرانی فعال ثبت می‌شود', db.prepare("SELECT COUNT(*) c FROM alerts WHERE device_id=? AND status='active' AND severity='critical'").get(id).c === 1);
  ok('تجهیز سالم هیچ‌گاه رکورد قطعی باز ندارد', db.prepare("SELECT COUNT(*) c FROM outages o JOIN devices d ON d.id=o.device_id WHERE o.open=1 AND d.status!='offline'").get().c === 0);

  await openPort();
  await check();
  ok('یک پاسخ موفق با تنظیم «۲ موفقیت» کافی نیست', row().status === 'offline', `status=${row().status}`);
  await check();
  ok('پس از دو موفقیت وضعیت در دسترس می‌شود', row().status === 'online', `status=${row().status}`);
  const closed = db.prepare('SELECT * FROM outages WHERE device_id=? ORDER BY id DESC LIMIT 1').get(id) || {};
  ok('رکورد قطعی بسته و مدت آن ثبت می‌شود', closed.open === 0 && closed.duration_sec >= 1, `open=${closed.open} dur=${closed.duration_sec}`);
  ok('هشدار قطعی حل‌شده علامت می‌خورد', db.prepare("SELECT COUNT(*) c FROM alerts WHERE device_id=? AND kind='offline' AND status='resolved'").get(id).c === 1);
  ok('هشدار بازگشت به حالت عادی ثبت می‌شود', db.prepare("SELECT COUNT(*) c FROM alerts WHERE device_id=? AND kind='recovery'").get(id).c >= 1);
  await closePort();
}

/* ------------------------------------------------------------------ */
/* ۲) سری روزانه: برابری با محاسبهٔ مستقیم روی نمونه‌ها                  */
/* ------------------------------------------------------------------ */

console.log('\n— تجمیع روزانه —');
{
  const OFFSET = 210;
  const now = Date.now();
  const today = dayStart(now, OFFSET);
  const ids = [];
  for (let i = 1; i <= 3; i++) {
    ids.push(
      Number(
        db
          .prepare('INSERT INTO devices(name, ip, status, enabled, monitoring_enabled, created_at, updated_at) VALUES (?,?,?,1,1,?,?)')
          .run(`day-${i}`, `10.8.0.${i}`, 'online', now, now).lastInsertRowid
      )
    );
  }
  const ins = db.prepare(
    'INSERT INTO samples(device_id, ts, rtt_ms, packets_sent, packets_recv, loss_pct, status, ok, mode) VALUES (?,?,?,3,?,?,?,?,?)'
  );
  let seed = 987654321;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let day = 5; day >= 0; day--) {
    const start = today - day * DAY_MS;
    for (let t = start; t < start + DAY_MS; t += 30000) {
      if (t > now) break;
      for (const id of ids) {
        const good = rnd() > 0.12;
        ins.run(id, t, good ? 2 + rnd() * 40 : null, good ? 3 : 0, good ? 0 : 100, good ? 'online' : 'offline', good, 'simulate');
      }
    }
  }
  for (let d = 5; d >= 1; d--) engine.rollupDay(today - d * DAY_MS, OFFSET);

  const from = today - 6 * DAY_MS;
  const to = today - 1;
  const fromStats = dailySeries({ from, to, offsetMin: OFFSET });
  const fromSamples = db
    .prepare(
      `SELECT date(s.ts/1000,'unixepoch','+210 minutes') AS day, COUNT(*) AS checks, SUM(s.ok) AS okCount,
              AVG(CASE WHEN s.ok=1 THEN s.rtt_ms END) AS avgRtt,
              AVG(CASE WHEN s.ok=1 THEN 0 ELSE 100 END) AS loss
       FROM samples s JOIN devices d ON d.id = s.device_id
       WHERE s.ts BETWEEN ? AND ? GROUP BY day ORDER BY day`
    )
    .all(from, to)
    .map((r) => ({
      day: r.day,
      checks: r.checks,
      availability: Math.round(((r.okCount || 0) / r.checks) * 10000) / 100,
      avgRtt: r.avgRtt == null ? null : Math.round(r.avgRtt * 100) / 100,
      lossPct: r.loss == null ? null : Math.round(r.loss * 100) / 100,
    }));

  ok('تعداد روزهای دو مسیر یکسان است', fromStats.length === fromSamples.length && fromStats.length === 5, `${fromStats.length} / ${fromSamples.length}`);
  const mismatch = fromStats.filter((a, i) => {
    const b = fromSamples[i] || {};
    return (
      a.day !== b.day ||
      a.checks !== b.checks ||
      Math.abs((a.availability ?? 0) - (b.availability ?? 0)) >= 0.01 ||
      Math.abs((a.avgRtt ?? 0) - (b.avgRtt ?? 0)) >= 0.02 ||
      Math.abs((a.lossPct ?? 0) - (b.lossPct ?? 0)) >= 0.01
    );
  });
  ok('مقادیر روزانه دقیقاً با محاسبهٔ روی نمونه‌های خام برابر است', mismatch.length === 0, JSON.stringify(mismatch.slice(0, 2)));

  const one = dailySeries({ from, to, offsetMin: OFFSET, clause: ' AND d.id = ?', params: [ids[2]] });
  const oneCount = db
    .prepare('SELECT COUNT(*) c FROM samples s JOIN devices d ON d.id = s.device_id WHERE s.ts BETWEEN ? AND ? AND d.id = ?')
    .get(from, to, ids[2]).c;
  ok('فیلتر تجهیز در مسیر تجمیعی درست اعمال می‌شود', one.reduce((s, r) => s + r.checks, 0) === oneCount);
}

/* ------------------------------------------------------------------ */
/* ۳) API: امنیت، اعتبارسنجی و مسیرهای اصلی                            */
/* ------------------------------------------------------------------ */

console.log('\n— API —');
const apiDir = tmpDir('api');
const PORT = 18877;
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, NETWATCH_DATA_DIR: apiDir, PORT: String(PORT), NETWATCH_SSE_MAX: '2' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => (serverLog += d.toString()));
child.stderr.on('data', (d) => (serverLog += d.toString()));

async function req(method, url, body, headers = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* بدنهٔ غیر JSON */
  }
  return { status: res.status, data, headers: res.headers };
}

try {
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    try {
      ready = (await fetch(`${BASE}/api/health`)).ok;
    } catch {
      await sleep(250);
    }
  }
  ok('سرور بالا آمد و /api/health پاسخ داد', ready);

  if (ready) {
    const health = await req('GET', '/api/health');
    ok('هدر nosniff', health.headers.get('x-content-type-options') === 'nosniff');
    ok('هدر CSP در حالت تولیدی', (health.headers.get('content-security-policy') || '').includes("default-src 'self'"));
    ok('هدر frame-ancestors', (health.headers.get('content-security-policy') || '').includes('frame-ancestors'));

    ok('درخواست تغییردهنده از مبدأ بیگانه → ۴۰۳', (await req('POST', '/api/devices', { name: 'x', ip: '10.9.9.9' }, { origin: 'http://evil.example' })).status === 403);

    // پشت پروکسی معکوس، Host بازنویسی می‌شود؛ Origin با X-Forwarded-Host هم‌خوان است
    const proxied = await req(
      'POST',
      '/api/devices',
      { name: 'proxy-test', ip: '10.9.9.7' },
      { origin: 'https://pv-example.style.dev', 'x-forwarded-host': 'pv-example.style.dev' }
    );
    ok('پشت پروکسی معکوس، درخواست همان مبدأ پذیرفته می‌شود', proxied.status === 201, `status=${proxied.status}`);
    if (proxied.data?.id) await req('DELETE', `/api/devices/${proxied.data.id}`, null, { origin: 'https://pv-example.style.dev', 'x-forwarded-host': 'pv-example.style.dev' });

    const noOrigin = await req('POST', '/api/devices', { name: 'cli-test', ip: '10.9.9.6' });
    ok('کلاینت بدون Origin (curl/اسکریپت) مسدود نمی‌شود', noOrigin.status === 201, `status=${noOrigin.status}`);
    if (noOrigin.data?.id) await req('DELETE', `/api/devices/${noOrigin.data.id}`);

    const created = await req('POST', '/api/devices', { name: 'آزمون', ip: '10.9.9.8', ping_interval: 60 }, { origin: BASE });
    ok('ساخت تجهیز → ۲۰۱', created.status === 201, `status=${created.status}`);
    const devId = created.data?.id;

    const bad = await req(
      'PUT',
      '/api/settings',
      {
        ping_interval: -5,
        max_workers: 999999,
        retention_days: -3,
        engine_mode: 'nope',
        suppression_start: 'zz:99',
        map_default_center: [999, 999],
        site_name: '   ',
      },
      { origin: BASE }
    );
    const s = bad.data?.settings || {};
    ok('بازهٔ منفی Ping مرزگذاری شد', s.ping_interval === 5, `ping_interval=${s.ping_interval}`);
    ok('هم‌زمانی بیش از حد مرزگذاری شد', s.max_workers === 512, `max_workers=${s.max_workers}`);
    ok('نگهداری منفی رد شد (جلوگیری از حذف همهٔ تاریخچه)', s.retention_days === 1, `retention_days=${s.retention_days}`);
    ok('حالت موتور نامعتبر رد شد', s.engine_mode === 'simulate', `engine_mode=${s.engine_mode}`);
    ok('فهرست مقادیر ردشده برگردانده شد', Array.isArray(bad.data?.rejected) && bad.data.rejected.includes('engine_mode'));
    ok('مقدار معتبر ذخیره می‌شود', (await req('PUT', '/api/settings', { ping_interval: 45 }, { origin: BASE })).data?.settings?.ping_interval === 45);
    await req('PUT', '/api/settings', { ping_interval: 30, retention_days: 14, max_workers: 128 }, { origin: BASE });

    const t0 = Date.now();
    const ping = await req('POST', `/api/devices/${devId}/ping`, { mode: 'icmp', count: 100000, timeout: -5, port: 999999 }, { origin: BASE });
    ok('پارامترهای ورودی Ping دستی مرزگذاری می‌شوند', ping.status === 200 && Date.now() - t0 < 15000, `status=${ping.status} مدت=${Date.now() - t0}ms`);

    ok('check-all فوری پاسخ می‌دهد و صف را به موتور می‌سپارد', (await req('POST', '/api/engine/check-all', null, { origin: BASE })).data?.queued >= 1);

    const before = await req('GET', '/api/health');
    await sleep(6000);
    const after = await req('GET', '/api/health');
    ok('چرخه و بررسی‌های موتور افزایش می‌یابد', after.data.engine.checksRun > before.data.engine.checksRun, `${before.data.engine.checksRun} → ${after.data.engine.checksRun}`);
    ok('خطای موتور صفر است', after.data.engine.errors === 0, `errors=${after.data.engine.errors}`);

    const dash = await req('GET', '/api/dashboard/summary');
    ok('داشبورد → ۲۰۰ با روند قطعی', dash.status === 200 && Array.isArray(dash.data?.offlineTrend) && dash.data.offlineTrend.length >= 96, `points=${dash.data?.offlineTrend?.length}`);
    ok('روند قطعی از جدول قطعی‌ها ساخته می‌شود', (dash.data?.offlineTrend || []).some((p) => p.offline > 0));
    ok('مدت قطعی‌های باز در گزارش رتبه‌بندی محاسبه شده', (dash.data?.topDowntime || []).every((t) => t.downtimeSec > 0));
    const dash2 = await req('GET', '/api/dashboard/summary');
    ok('داشبورد از کش کوتاه‌مدت استفاده می‌کند', dash2.headers.get('x-cache') === 'hit');

    for (const range of ['24h', '7d', '90d']) {
      const r = await req('GET', `/api/reports/summary?range=${range}`);
      ok(`گزارش ${range} → ۲۰۰ با روزها و تجهیزات`, r.status === 200 && Array.isArray(r.data?.days) && r.data?.items?.length > 0, `status=${r.status}`);
    }
    const health7 = await req('GET', `/api/devices/${dash.data.items?.[0]?.id ?? 1}/health`);
    ok('سلامت تجهیز از آمار روزانه خوانده می‌شود', health7.status === 200 && Array.isArray(health7.data?.daily) && health7.data.daily.length > 0);

    const csv = await fetch(`${BASE}/api/reports/export?range=7d&format=csv`);
    ok('خروجی CSV سالم است', csv.status === 200 && (await csv.text()).includes('نام تجهیز'));
    const xlsx = await fetch(`${BASE}/api/reports/export?range=7d&format=xlsx`);
    ok('خروجی XLSX معتبر است', xlsx.status === 200 && Buffer.from(await xlsx.arrayBuffer()).subarray(0, 2).toString() === 'PK');

    const tpl = await fetch(`${BASE}/api/devices/template?format=xlsx`);
    const tplBuf = Buffer.from(await tpl.arrayBuffer());
    const form = new FormData();
    form.append('file', new Blob([tplBuf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'template.xlsx');
    const preview = await fetch(`${BASE}/api/devices/import/preview`, { method: 'POST', body: form });
    const previewData = await preview.json().catch(() => null);
    ok('ورود فایل نمونه (پیش‌نمایش) کار می‌کند', preview.status === 200 && previewData?.summary?.valid >= 1);

    const badForm = new FormData();
    badForm.append('file', new Blob([Buffer.from('not a map')]), 'map.zip');
    const badUpload = await fetch(`${BASE}/api/layers/upload`, { method: 'POST', body: badForm });
    ok('بارگذاری فایل با پسوند نامعتبر پیش از نوشتن رد می‌شود', badUpload.status === 400);

    ok('کاشی ناموجود → ۴۰۴', (await fetch(`${BASE}/api/tiles/1/0/0/0`)).status === 404);
    ok('مختصات کاشی نامعتبر رد می‌شود', (await fetch(`${BASE}/api/tiles/1/99/1e9/-4`)).status === 404);

    // -- علامت‌های نقشه: تعریف نوع، جانمایی با نام و مختصات، خروجی و ورود --
    const mType = await req('POST', '/api/marker-types', { name: 'علامت آزمون دود', color: '#f59e0b' }, { origin: BASE });
    ok('تعریف نوع علامت نقشه → ۲۰۱', mType.status === 201 && mType.data?.name === 'علامت آزمون دود', `status=${mType.status}`);
    ok('تعریف نوع تکراری رد می‌شود', (await req('POST', '/api/marker-types', { name: 'علامت آزمون دود' }, { origin: BASE })).status === 400);
    const mk = await req('POST', '/api/markers', { name: 'نصب آنتن ۱', type_id: mType.data?.id, latitude: 35.7, longitude: 51.4 }, { origin: BASE });
    ok('جانمایی علامت با نام و مختصات → ۲۰۱', mk.status === 201 && mk.data?.latitude === 35.7 && mk.data?.name === 'نصب آنتن ۱', `status=${mk.status}`);
    ok(
      'مختصات نامعتبر علامت رد می‌شود',
      (await req('POST', '/api/markers', { name: 'x', type: 'تجهیز در حال نصب', latitude: 200, longitude: 51 }, { origin: BASE })).status === 400
    );
    const mkList = await req('GET', '/api/markers');
    const mine = (mkList.data?.items || []).find((m) => m.id === mk.data?.id);
    const myType = (mkList.data?.types || []).find((t) => t.id === mType.data?.id);
    ok(
      'فهرست علامت‌ها با نوع و شمارش برمی‌گردد',
      !!mine && mine.typeName === 'علامت آزمون دود' && myType?.markerCount === 1,
      `type=${mine?.typeName} count=${myType?.markerCount}`
    );

    const mkTpl = await fetch(`${BASE}/api/markers/template?format=csv`);
    const mkTplRaw = Buffer.from(await mkTpl.arrayBuffer());
    const mkTplText = mkTplRaw.toString('utf8');
    ok(
      'فایل نمونهٔ ورود علامت‌ها با BOM و سرستون‌های فارسی ساخته می‌شود',
      mkTpl.status === 200 && mkTplRaw.subarray(0, 3).toString('hex') === 'efbbbf' && mkTplText.includes('نام علامت') && mkTplText.includes('عرض جغرافیایی')
    );
    const mkForm = (mode, body = mkTplRaw) => {
      const f = new FormData();
      f.append('file', new Blob([body], { type: 'text/csv' }), 'markers.csv');
      if (mode) f.append('mode', mode);
      return f;
    };
    const mkPreview = await fetch(`${BASE}/api/markers/import/preview`, { method: 'POST', body: mkForm() });
    const mkPreviewData = await mkPreview.json().catch(() => null);
    ok('پیش‌نمایش ورود علامت‌ها ردیف‌های معتبر را می‌شمارد', mkPreview.status === 200 && mkPreviewData?.valid === mkPreviewData?.totalRows, `valid=${mkPreviewData?.valid}`);
    // CSV بدون BOM (خروجی Excel/ویرایشگر متن) هم باید با UTF-8 خوانده شود
    const noBom = Buffer.from(mkTplText.replace(/^\uFEFF/, ''), 'utf8');
    const mkPreviewNoBom = await fetch(`${BASE}/api/markers/import/preview`, { method: 'POST', body: mkForm(null, noBom) });
    const mkNoBomData = await mkPreviewNoBom.json().catch(() => null);
    ok('CSV بدون BOM با متن فارسی درست خوانده می‌شود', mkPreviewNoBom.status === 200 && mkNoBomData?.valid === mkNoBomData?.totalRows && mkNoBomData?.valid >= 1, `valid=${mkNoBomData?.valid}`);
    const beforeImport = (await req('GET', '/api/markers')).data?.items?.length || 0;
    const mkImp = await fetch(`${BASE}/api/markers/import`, { method: 'POST', body: mkForm('append') });
    const mkImpData = await mkImp.json().catch(() => null);
    ok('ورود علامت‌ها ردیف‌های معتبر را ثبت می‌کند', mkImp.status === 200 && mkImpData?.inserted >= 1, `inserted=${mkImpData?.inserted}`);
    const afterImport = (await req('GET', '/api/markers')).data?.items?.length || 0;
    ok('علامت‌های واردشده به فهرست اضافه می‌شوند', afterImport === beforeImport + (mkImpData?.inserted || 0), `${beforeImport} → ${afterImport}`);
    const mkCsv = await fetch(`${BASE}/api/markers/export?format=csv`);
    const mkCsvText = await mkCsv.text();
    ok('خروجی CSV علامت‌ها شامل نام، نوع و مختصات است', mkCsv.status === 200 && mkCsvText.includes('نام علامت') && mkCsvText.includes('51.4'));

    // -- رویدادهای قطع و وصل --
    const flaps = await req('GET', '/api/events/flaps?hours=24');
    ok('لاگ قطع/وصل → سری نمودار زمانی', flaps.status === 200 && Array.isArray(flaps.data?.series) && flaps.data.series.length > 0, `status=${flaps.status}`);
    const sim = await req('GET', '/api/events/simultaneous?hours=24');
    ok('قطعی‌های هم‌زمان → سری هم‌زمانی', sim.status === 200 && Array.isArray(sim.data?.series) && 'concurrent' in (sim.data.series[0] || {}), `status=${sim.status}`);
    const tl = await req('GET', '/api/events/timeline?hours=24');
    ok('تایم‌لاین قطعی‌ها → بازه‌های هر تجهیز', tl.status === 200 && Array.isArray(tl.data?.devices), `status=${tl.status}`);
    const top = await req('GET', '/api/events/top-outage-devices?days=7');
    ok('آمار تجهیزات با قطع زیاد → فهرست رتبه‌بندی', top.status === 200 && Array.isArray(top.data?.items), `status=${top.status}`);

    // -- چیدمان ویجت‌ها در تنظیمات --
    const wl = await req('PUT', '/api/settings', { device_detail_widgets: [{ id: 'info', size: 'lg', visible: true }] }, { origin: BASE });
    ok('چیدمان ویجت‌های صفحه جزئیات ذخیره می‌شود', wl.data?.settings?.device_detail_widgets?.[0]?.id === 'info' && wl.data.settings.device_detail_widgets[0].size === 'lg');
    const wlBad = await req('PUT', '/api/settings', { dashboard_widgets: [{ id: 'a', size: 'huge' }] }, { origin: BASE });
    ok('اندازهٔ نامعتبر ویجت به مقدار مجاز مرزگذاری می‌شود', wlBad.data?.settings?.dashboard_widgets?.[0]?.size === 'md', `size=${wlBad.data?.settings?.dashboard_widgets?.[0]?.size}`);

    // -- تعمیر و نگهداری فقط با ثبت کاربر --
    ok('پس از قطعی‌های موتور، سابقهٔ تعمیرات خودکار ساخته نمی‌شود', (await req('GET', '/api/maintenance?limit=1')).data?.total === 0);
    const maint = await req('POST', '/api/maintenance', { device_id: devId, title: 'تعویض سوئیچ', cause: 'خرابی پورت', action: 'تعویض تجهیز' }, { origin: BASE });
    ok('ثبت دستی سابقهٔ تعمیرات → ۲۰۱ و در فهرست دیده می‌شود', maint.status === 201 && (await req('GET', '/api/maintenance?limit=5')).data?.total === 1, `status=${maint.status}`);

    // -- بازنشانی داده‌های نمونه روی پایگاه‌دادهٔ پر (کلید بیرونی) --
    const reset = await req('POST', '/api/settings/reset-demo', { confirm: 'reset' }, { origin: BASE });
    ok('بازنشانی داده‌های نمونه روی پایگاه‌دادهٔ پر خطا نمی‌دهد', reset.status === 200 && reset.data?.ok === true, `status=${reset.status}`);

    ok('مسیر ناشناختهٔ API → ۴۰۴ JSON', (await req('GET', '/api/does-not-exist')).status === 404);
    const spa = await fetch(`${BASE}/devices/12`);
    ok('مسیر عمیق SPA با HTML پاسخ می‌دهد', spa.status === 200 && (await spa.text()).includes('<div id="root">'));
    ok('بررسی‌های تغییردهنده سطر خطا در لاگ سرور نمی‌سازد', !serverLog.includes('خطای مهارنشده'), serverLog.slice(-200));
  }
} finally {
  child.kill('SIGTERM');
  await sleep(500);
  if (!child.killed) child.kill('SIGKILL');
  fs.rmSync(engineDir, { recursive: true, force: true });
  fs.rmSync(apiDir, { recursive: true, force: true });
}

console.log(`\n${failures.length ? '❌' : '✅'} نتیجه: ${pass} موفق، ${failures.length} ناموفق`);
if (failures.length) {
  console.log('موارد ناموفق:');
  for (const f of failures) console.log(`  • ${f}`);
}
process.exit(failures.length ? 1 : 0);
