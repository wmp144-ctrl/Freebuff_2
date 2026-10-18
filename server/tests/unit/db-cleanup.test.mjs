/**
 * آزمون پاک‌سازی رکوردهای قدیمی.
 *
 * معیارهای پذیرش:
 *   • قطعی «باز» هرگز حذف نمی‌شود، حتی اگر از بازهٔ نگهداری قدیمی‌تر باشد
 *   • قطعی‌ای که سابقهٔ تعمیرات به آن ارجاع دارد حذف نمی‌شود
 *   • هشدار فعال/تأییدشده حذف نمی‌شود و هشدار تجهیز قطع‌شده تا بازیابی می‌ماند
 *   • نمونه‌های امروز/دیروز برای تجمیع روزانه حفظ می‌شوند
 *   • هرس در یک تراکنش انجام می‌شود؛ شکست میانی چیزی را نیمه‌حذف نمی‌کند
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir, addDevice } from '../helpers.mjs';

const dir = useTempDataDir('db-cleanup');
const { db, setSettings, transaction } = await import('../../db.js');
const { engine } = await import('../../engine.js');

setSettings({ retention_days: 1 });

const DAY = 86400000;
const now = Date.now();
const old = now - 30 * DAY;

const deviceId = addDevice(db, { name: 'cleanup-device', ip: '10.88.0.1', status: 'offline' });
const otherId = addDevice(db, { name: 'cleanup-device-2', ip: '10.88.0.2', status: 'online' });

const openOutageId = Number(db.prepare('INSERT INTO outages(device_id, started_at, cause, open) VALUES (?,?,?,1)').run(deviceId, old, 'Ping Timeout').lastInsertRowid);
const closedOutageId = Number(db.prepare('INSERT INTO outages(device_id, started_at, ended_at, duration_sec, cause, open) VALUES (?,?,?,?,?,0)').run(deviceId, old - DAY, old - DAY + 60000, 60, 'قطعی برق').lastInsertRowid);
const linkedOutageId = Number(db.prepare('INSERT INTO outages(device_id, started_at, ended_at, duration_sec, cause, open) VALUES (?,?,?,?,?,0)').run(otherId, old - 2 * DAY, old - 2 * DAY + 60000, 60, 'مشکل شبکه').lastInsertRowid);
db.prepare(
  "INSERT INTO maintenance_records(device_id, outage_id, cause, action, started_at, ended_at, downtime_sec, status, created_at) VALUES (?,?,?,?,?,?,?, 'closed', ?)"
).run(otherId, linkedOutageId, 'مشکل شبکه', 'رفع مشکل', old - 2 * DAY, old - 2 * DAY + 60000, 60, old);

const activeAlertId = Number(db.prepare("INSERT INTO alerts(device_id, severity, kind, title, created_at, status) VALUES (?,?,?,?,?, 'active')").run(deviceId, 'critical', 'offline', 'هشدار فعال', old).lastInsertRowid);
const ackAlertId = Number(db.prepare("INSERT INTO alerts(device_id, severity, kind, title, created_at, status, acknowledged_at) VALUES (?,?,?,?,?, 'acknowledged', ?)").run(deviceId, 'warning', 'latency', 'هشدار تأییدشده', old, old).lastInsertRowid);
db.prepare("INSERT INTO alerts(device_id, severity, kind, title, created_at, status) VALUES (?,?,?,?,?, 'resolved')").run(deviceId, 'info', 'recovery', 'هشدار حل‌شده تجهیز قطع', old);
db.prepare("INSERT INTO alerts(device_id, severity, kind, title, created_at, status) VALUES (?,?,?,?,?, 'resolved')").run(otherId, 'info', 'recovery', 'هشدار حل‌شده تجهیز سالم', old);

// نمونه‌های قدیمی (باید هرس شوند) و نمونه‌های امروز/دیروز (باید بمانند)
const insertSample = (device, ts) => db.prepare('INSERT INTO samples(device_id, ts, status, ok) VALUES (?,?,?,?)').run(device, ts, 'online', 1);
// ظهر دیروز (UTC): همیشه بعد از شروع دیروز است، پس نباید هرس شود
const yesterdayNoon = Math.floor(now / DAY) * DAY - DAY + 12 * 3600000;
for (let i = 0; i < 5; i++) insertSample(deviceId, old - i * 1000);
insertSample(deviceId, yesterdayNoon);
insertSample(deviceId, now - 3600000); // امروز

const rowsIn = (table, where = '') => db.prepare(`SELECT COUNT(*) AS c FROM ${table} ${where}`).get().c;

test('cleanup keeps open outages, maintenance-linked outages and essential alerts', () => {
  engine.cleanup({ retention_days: 1, timezone_offset_minutes: 0 });

  assert.ok(db.prepare('SELECT id FROM outages WHERE id = ?').get(openOutageId), 'قطعی باز باید حفظ شود');
  assert.ok(db.prepare('SELECT id FROM outages WHERE id = ?').get(linkedOutageId), 'قطعی مرتبط با سابقهٔ تعمیرات باید حفظ شود');
  assert.equal(db.prepare('SELECT id FROM outages WHERE id = ?').get(closedOutageId), undefined, 'قطعی بستهٔ بی‌ارجاع باید هرس شود');

  assert.ok(db.prepare('SELECT id FROM alerts WHERE id = ?').get(activeAlertId), 'هشدار فعال نباید حذف شود');
  assert.ok(db.prepare('SELECT id FROM alerts WHERE id = ?').get(ackAlertId), 'هشدار تأییدشده نباید حذف شود');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE title='هشدار حل‌شده تجهیز سالم'").get().c, 0, 'هشدار حل‌شده تجهیز سالم هرس می‌شود');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE title='هشدار حل‌شده تجهیز قطع'").get().c, 1, 'هشدار حل‌شدهٔ تجهیز با قطعی باز می‌ماند');
});

test('samples of today and yesterday survive for the daily rollup', () => {
  assert.equal(rowsIn('samples', `WHERE device_id=${deviceId} AND ts <= ${old}`), 0, 'نمونه‌های ۳۰ روز پیش باید هرس شوند');
  assert.equal(rowsIn('samples', `WHERE device_id=${deviceId} AND ts = ${yesterdayNoon}`), 1, 'نمونهٔ دیروز باید برای تجمیع حفظ شود');
  assert.equal(rowsIn('samples', `WHERE device_id=${deviceId} AND ts = ${now - 3600000}`), 1, 'نمونهٔ امروز باید بماند');
});

test('cleanup is transactional: a failure inside the run leaves every record untouched', () => {
  const sample = db.prepare('INSERT INTO samples(device_id, ts, status, ok) VALUES (?,?,?,?)').run(otherId, old - 5 * DAY, 'offline', 0).lastInsertRowid;
  const before = rowsIn('samples');
  assert.throws(() =>
    transaction(() => {
      db.prepare('DELETE FROM samples WHERE device_id = ?').run(otherId);
      throw new Error('failure-after-delete');
    })
  );
  assert.equal(rowsIn('samples'), before, 'حذف نیمه‌کاره نباید باقی بماند');
  assert.ok(db.prepare('SELECT id FROM samples WHERE id = ?').get(Number(sample)));
});

after(() => {
  db.close();
  cleanupDir(dir);
});
