/**
 * MTTR — فقط قطعی‌های دارای تعمیر ثبت‌شده، با معیار شروع قطعی تا وصل مجدد.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { useTempDataDir, cleanupDir, addDevice } from '../helpers.mjs';

const dir = useTempDataDir('mttr');
const { db } = await import('../../db.js');
const { mttrReport } = await import('../../mttr.js');

test.after(() => {
  db.close();
  cleanupDir(dir);
});

const base = Date.UTC(2026, 0, 10, 8, 0, 0);
const hour = 3600000;

function addOutage(deviceId, startedAt, endedAt) {
  return Number(
    db
      .prepare('INSERT INTO outages(device_id, started_at, ended_at, duration_sec, cause, open) VALUES (?,?,?,?,?,0)')
      .run(deviceId, startedAt, endedAt, endedAt ? Math.round((endedAt - startedAt) / 1000) : null, 'تست').lastInsertRowid
  );
}

function addRepair(deviceId, outageId, action = 'تعمیر تجهیز') {
  return Number(
    db
      .prepare(
        'INSERT INTO maintenance_records(device_id, outage_id, action, cause, started_at, ended_at, status, created_at) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(deviceId, outageId, action, 'قطعی برق', base, base + hour, 'closed', base).lastInsertRowid
  );
}

test('فقط قطعی دارای تعمیر در محاسبه می‌آید و مدت از شروع تا وصل است', () => {
  const d1 = addDevice(db, { name: 'سوئیچ A', ip: '10.20.0.1' });
  const d2 = addDevice(db, { name: 'سوئیچ B', ip: '10.20.0.2' });

  // ۲ ساعت قطعی با تعمیر
  const o1 = addOutage(d1, base, base + 2 * hour);
  addRepair(d1, o1);
  // ۱۰ ساعت قطعی بدون تعمیر — باید حذف شود
  addOutage(d1, base + 5 * hour, base + 15 * hour);
  // ۴ ساعت قطعی با تعمیر
  const o3 = addOutage(d2, base + 20 * hour, base + 24 * hour);
  addRepair(d2, o3, 'تعویض قطعه');
  // قطعی باز (بدون ended_at) — نباید وارد شود
  db.prepare('INSERT INTO outages(device_id, started_at, ended_at, open) VALUES (?,?,NULL,1)').run(d2, base + 30 * hour);

  const report = mttrReport({ from: base - hour, to: base + 40 * hour });
  assert.equal(report.count, 2);
  assert.equal(report.totalOutages, 3, 'قطعی‌های بسته‌شده در بازه');
  assert.equal(report.excluded, 1, 'قطعی بدون تعمیر حذف می‌شود');
  assert.equal(report.avgSec, 3 * 3600, 'میانگین وزنی (۲ و ۴ ساعت) = ۳ ساعت');
  assert.equal(report.minSec, 2 * 3600);
  assert.equal(report.maxSec, 4 * 3600);
  assert.equal(report.events.length, 2);
  assert.ok(report.events.every((e) => e.maintenanceId && e.durationSec > 0));
  assert.equal(report.eventsTruncated, false);
  assert.match(report.criteria, /تعمیر/);
});

test('فیلتر بازه و محدودیت رویدادها اعمال می‌شود', () => {
  const d = addDevice(db, { name: 'روتر C', ip: '10.20.0.3' });
  for (let i = 0; i < 5; i++) {
    const start = base + (40 + i) * hour;
    const o = addOutage(d, start, start + hour);
    addRepair(d, o);
  }
  const only = mttrReport({ from: base + 39 * hour, to: base + 46 * hour, limit: 2 });
  assert.equal(only.count, 5);
  assert.equal(only.events.length, 2);
  assert.equal(only.eventsTruncated, true);
  assert.equal(only.avgSec, 3600);
});
