/**
 * آزمون مسیر تجمیعی گزارش‌ها: شاخص‌های روزهای کامل باید از daily_stats خوانده
 * شوند تا گزارش‌های بلندمدت پس از هرس نمونه‌های خام هم درست بمانند.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, addDevice } from '../helpers.mjs';

const dir = useTempDataDir('daily');
const { db, setSettings, STATUS } = await import('../../db.js');
const { dayStart, dayLabel, splitRange, deviceTotals, dailySeries } = await import('../../daily.js');
const { MonitoringEngine } = await import('../../engine.js');

const DAY = 86400000;
const OFFSET = 0;
setSettings({ timezone_offset_minutes: OFFSET, retention_days: 1 });
const deviceId = addDevice(db, { name: 'daily-1', ip: '10.60.0.1', ping_interval: 3600, status: STATUS.ONLINE });

const insertSample = db.prepare(
  'INSERT INTO samples(device_id, ts, rtt_ms, packets_sent, packets_recv, loss_pct, status, ok, mode) VALUES (?,?,?,?,?,?,?,?,?)'
);

/** سه نمونه موفق و یک نمونه ناموفق در یک روز */
function seedDay(dayStartMs) {
  insertSample.run(deviceId, dayStartMs + 60_000, 10, 1, 1, 0, STATUS.ONLINE, 1, 'test');
  insertSample.run(deviceId, dayStartMs + 120_000, 20, 1, 1, 0, STATUS.ONLINE, 1, 'test');
  insertSample.run(deviceId, dayStartMs + 180_000, null, 1, 0, 100, STATUS.OFFLINE, 0, 'test');
  insertSample.run(deviceId, dayStartMs + 240_000, 30, 1, 1, 0, STATUS.ONLINE, 1, 'test');
}

const now = Date.now();
const todayStart = dayStart(now, OFFSET);
const yesterdayStart = todayStart - DAY;
const twoDaysAgoStart = todayStart - 2 * DAY;
seedDay(twoDaysAgoStart);
seedDay(yesterdayStart);
seedDay(todayStart);

const engine = new MonitoringEngine({ emitToBus: false });
engine.rollupDay(twoDaysAgoStart, OFFSET);
engine.rollupDay(yesterdayStart, OFFSET);

after(() => {
  db.close();
  cleanupDir(dir);
});

test('splitRange separates whole days from partial edges', () => {
  const middleOfToday = todayStart + 5 * 3600_000;
  const s = splitRange(todayStart - DAY, middleOfToday, OFFSET);
  assert.equal(s.fullStart, todayStart - DAY);
  assert.equal(s.fullEnd, todayStart);
  assert.deepEqual(s.edges, [[todayStart, middleOfToday]]);

  // بازهٔ کاملاً داخل یک روز → فقط لبه
  const partial = splitRange(todayStart + 1000, todayStart + 2000, OFFSET);
  assert.equal(partial.hasFullDays, false);
  assert.deepEqual(partial.edges, [[todayStart + 1000, todayStart + 2000]]);

  // بازهٔ چندروزه از وسط روز اول تا وسط روز آخر → دو لبه
  const multi = splitRange(todayStart - 2 * DAY + 3600_000, todayStart + 3600_000, OFFSET);
  assert.equal(multi.fullStart, twoDaysAgoStart + DAY);
  assert.equal(multi.fullEnd, todayStart);
  assert.deepEqual(multi.edges, [
    [todayStart - 2 * DAY + 3600_000, twoDaysAgoStart + DAY - 1],
    [todayStart, todayStart + 3600_000],
  ]);
});

test('deviceTotals aggregates whole days from daily_stats and today from samples', () => {
  const from = twoDaysAgoStart;
  const to = now;
  const totals = deviceTotals({ from, to, offsetMin: OFFSET });
  const t = totals.get(deviceId);
  assert.ok(t, 'device must appear in totals');
  assert.equal(t.checks, 12, `expected 12 checks, got ${t.checks}`);
  assert.equal(t.failed, 3, 'three failing checks (one per day)');
  assert.equal(t.minRtt, 10);
  assert.equal(t.maxRtt, 30);
  assert.equal(t.rttCount, 9);
  assert.equal(Math.round(t.rttSum), 60 * 3, 'sum of rtt for successful checks');
});

test('deviceTotals matches a naive scan of the same samples', () => {
  const from = twoDaysAgoStart;
  const to = now;
  const naive = db
    .prepare(
      `SELECT COUNT(*) AS checks, SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN ok=1 THEN rtt_ms END) AS rtt_sum
         FROM samples WHERE device_id = ? AND ts BETWEEN ? AND ?`
    )
    .get(deviceId, from, to);
  const t = deviceTotals({ from, to, offsetMin: OFFSET }).get(deviceId);
  assert.equal(t.checks, naive.checks);
  assert.equal(t.failed, naive.failed);
  assert.equal(Math.round(t.rttSum), Math.round(naive.rtt_sum));
});

test('days missing from daily_stats fall back to raw samples without double counting', () => {
  const oldId = addDevice(db, { name: 'daily-old', ip: '10.60.0.2', ping_interval: 3600, status: STATUS.ONLINE });
  const fiveDaysAgo = todayStart - 5 * DAY;
  const ins = (ts, rtt, ok) =>
    insertSample.run(oldId, ts, rtt, 1, ok ? 1 : 0, ok ? 0 : 100, ok ? STATUS.ONLINE : STATUS.OFFLINE, ok ? 1 : 0, 'test');
  ins(fiveDaysAgo + 60_000, 7, true);
  ins(fiveDaysAgo + 120_000, 9, true);
  ins(fiveDaysAgo + 180_000, null, false);

  const from = todayStart - 6 * DAY;
  const totals = deviceTotals({ from, to: now, offsetMin: OFFSET });
  assert.equal(totals.get(oldId).checks, 3, 'unrolled day must be read from raw samples');
  assert.equal(totals.get(oldId).failed, 1);
  assert.equal(totals.get(oldId).minRtt, 7);
  assert.equal(totals.get(deviceId).checks, 12, 'rolled-up days must not be counted twice');

  const series = dailySeries({ from, to: now, offsetMin: OFFSET });
  const fiveDayPoint = series.find((p) => p.day === dayLabel(fiveDaysAgo, OFFSET));
  assert.ok(fiveDayPoint, 'chart must include the unrolled day');
  assert.equal(fiveDayPoint.checks, 3);
  assert.equal(series.reduce((sum, p) => sum + p.checks, 0), 15, 'no day may be counted twice or dropped');
});

test('totals survive pruning of the raw samples they were rolled up from', () => {
  const removed = db.prepare('DELETE FROM samples WHERE device_id = ? AND ts < ?').run(deviceId, todayStart).changes;
  assert.equal(removed, 8, 'eight samples of the two complete days are pruned');

  const totals = deviceTotals({ from: twoDaysAgoStart, to: now, offsetMin: OFFSET }).get(deviceId);
  assert.equal(totals.checks, 12, 'daily_stats must keep the checks of pruned days');
  assert.equal(totals.minRtt, 10);
  assert.ok(db.prepare('SELECT COUNT(*) AS c FROM daily_stats WHERE device_id = ?').get(deviceId).c >= 2);

  // سری روزانهٔ نمودار هم باید روزهای هرس‌شده را همچنان نشان دهد
  const series = dailySeries({ from: twoDaysAgoStart, to: now, offsetMin: OFFSET });
  const days = series.map((p) => p.day);
  assert.ok(days.includes(dayLabel(twoDaysAgoStart, OFFSET)));
  assert.ok(days.includes(dayLabel(yesterdayStart, OFFSET)));
  assert.equal(series.reduce((sum, p) => sum + p.checks, 0), 12);
});

test('cleanup job prunes old samples but never the rolled-up daily stats', () => {
  // یک نمونهٔ کهنه (پیش از بازهٔ نگهداری یک‌روزه) در روزی که تجمیع نشده است
  const oldStart = todayStart - 5 * DAY;
  insertSample.run(deviceId, oldStart + 60_000, 5, 1, 1, 0, STATUS.ONLINE, 1, 'test');
  const before = db.prepare('SELECT COUNT(*) AS c FROM samples WHERE device_id = ? AND ts < ?').get(deviceId, todayStart - DAY).c;
  assert.equal(before, 1);
  const dailyRowsBefore = db.prepare('SELECT COUNT(*) AS c FROM daily_stats').get().c;

  engine.cleanup({ retention_days: 1 });
  const after = db.prepare('SELECT COUNT(*) AS c FROM samples WHERE device_id = ? AND ts < ?').get(deviceId, todayStart - DAY).c;
  assert.equal(after, 0, 'samples older than retention must be pruned');
  // سیاست Phase 2: پیش از حذف نمونه، روز تجمیع‌نشده در daily_stats تثبیت می‌شود؛
  // پس هیچ ردیف تجمیعی از دست نمی‌رود و ردیف روز کهنه اضافه می‌شود.
  assert.ok(
    db.prepare('SELECT COUNT(*) AS c FROM daily_stats').get().c >= dailyRowsBefore,
    'daily_stats must not be pruned by the sample retention policy'
  );
  const rolledUp = db.prepare('SELECT checks FROM daily_stats WHERE device_id = ? AND day = ?').get(deviceId, dayLabel(oldStart, OFFSET));
  assert.ok(rolledUp, 'the day of the pruned sample must be rolled up before deletion');
  assert.equal(rolledUp.checks, 1, 'the rolled-up totals of the pruned sample must survive');
});
