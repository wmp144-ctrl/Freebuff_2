/**
 * API کشف شبکه — مرز سقف محدوده‌ها و انتخاب محدودهٔ غیرفعال (BUG-15/BUG-16)
 * ----------------------------------------------------------------
 * سناریوی واقعی: مدیر ۳۲ محدوده دارد و می‌خواهد یکی را ویرایش کند؛ پیش‌تر
 * validateRangeInput تعداد کل را می‌شمرد و ویرایش را با خطای «حداکثر ۳۲ محدوده»
 * رد می‌کرد. همچنین اسکن دستی چند محدوده، محدودهٔ غیرفعال را هم می‌سنجید.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, cleanupDir, login, startServer, useTempDataDir, waitFor } from '../helpers.mjs';

const dir = useTempDataDir('discovery-api');
let srv;
const created = [];

before(async () => {
  srv = await startServer({ dataDir: dir, engine: false, env: { NETWATCH_SEED_DEMO: '0' } });
  await login(srv.base);
});

after(async () => {
  if (srv) await srv.stop().catch(() => {});
  cleanupDir(dir);
});

async function createRange(body) {
  const res = await api(srv.base, 'POST', '/api/discovery/ranges', body);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  created.push(res.data.id);
  return res.data;
}

test('editing an existing range still works when the 32-range cap is reached', async () => {
  // ۳۲ محدودهٔ تک‌آدرسی و بی‌هم‌پوشان (۰٫۰٫۰٫۰/32 قابل استفاده نیست؛ از
  // شبکهٔ خصوصی مجاز استفاده می‌شود).
  for (let i = 1; i <= 32; i++) {
    await createRange({ name: `range-${i}`, cidr: `192.168.${i}.10/32`, enabled: i !== 32 });
  }
  const list = await api(srv.base, 'GET', '/api/discovery/ranges');
  assert.equal(list.status, 200);
  assert.equal(list.data.items.length, 32);
  assert.equal(list.data.limits.maxRanges, 32);

  // افزودن محدودهٔ سی‌وسوم باید با ۴۰۹ رد شود.
  const overflow = await api(srv.base, 'POST', '/api/discovery/ranges', { name: 'overflow', cidr: '192.168.200.10/32', enabled: true });
  assert.equal(overflow.status, 409);
  assert.match(String(overflow.data?.error), /حداکثر/);

  // ویرایش محدودهٔ موجود در همین وضعیت باید موفق باشد (BUG-15).
  const first = created[0];
  const edited = await api(srv.base, 'PUT', `/api/discovery/ranges/${first}`, { name: 'renamed-at-cap', notes: 'ویرایش در سقف' });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.name, 'renamed-at-cap');
  assert.equal(edited.data.notes, 'ویرایش در سقف');
  assert.equal(edited.data.cidr, '192.168.1.10/32');

  // تغییر CIDR به محدودهٔ تکراری باید ۴۰۹ بدهد، نه ۴۰۰ مبهم.
  const duplicate = await api(srv.base, 'PUT', `/api/discovery/ranges/${first}`, { cidr: '192.168.2.10/32' });
  assert.equal(duplicate.status, 409);
});

test('manual scan ignores disabled ranges and refuses an all-disabled selection', async () => {
  const enabledId = created[0];
  const disabledId = created[31];
  const onlyDisabled = await api(srv.base, 'POST', '/api/discovery/scan', { rangeIds: [disabledId] });
  assert.equal(onlyDisabled.status, 400);
  assert.match(String(onlyDisabled.data?.error), /فعالی/);

  // با انتخاب مختلط، فقط محدودهٔ فعال باید اسکن شود.
  const mixed = await api(srv.base, 'POST', '/api/discovery/scan', { rangeIds: [enabledId, disabledId] });
  assert.equal(mixed.status, 202);
  assert.equal(mixed.data?.started, true);

  await waitFor(
    async () => {
      const status = await api(srv.base, 'GET', '/api/discovery/status');
      return status.data?.scan && status.data.scan.running === false;
    },
    15000
  );
  const status = await api(srv.base, 'GET', '/api/discovery/status');
  assert.equal(status.data.scan.running, false);
  assert.equal(status.data.scan.ranges, 1, 'فقط یک محدودهٔ فعال اسکن شد');
  assert.equal(status.data.scan.skippedDisabled, 1);

  const list = await api(srv.base, 'GET', '/api/discovery/ranges');
  const disabled = list.data.items.find((r) => r.id === disabledId);
  assert.equal(disabled.lastScanAt, null, 'محدودهٔ غیرفعال اثری از اسکن ندارد');
  const enabled = list.data.items.find((r) => r.id === enabledId);
  assert.equal(enabled.lastScanStatus, 'ok');
});
