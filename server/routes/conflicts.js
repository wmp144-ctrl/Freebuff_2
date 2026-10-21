/**
 * NetWatch — API تشخیص تعارض IP (مشکوک، نه قطعی)
 */
import express from 'express';
import { db } from '../db.js';
import { routePermission } from '../permissions.js';
import { detectConflicts } from '../management.js';

const router = express.Router();

router.use(routePermission({ read: 'devices:read', write: 'devices:write' }));

router.get('/', (_req, res) => {
  const report = detectConflicts();
  const summary = report.items.reduce(
    (acc, it) => {
      acc.total += 1;
      acc[it.severity] = (acc[it.severity] || 0) + 1;
      return acc;
    },
    { total: 0, info: 0, warning: 0, critical: 0 }
  );
  // اعلان مدیریتی یک‌بار در هر ۲۴ ساعت (نه با هر بازخوانی صفحه). موارد
  // همچنان «مشکوک» می‌مانند و متن هشدار هم همین را روشن می‌کند.
  if (summary.total > 0) {
    try {
      const now = Date.now();
      const key = `ip-conflict:${new Date(now).toISOString().slice(0, 10)}:${summary.total}`;
      const seen = db
        .prepare("SELECT id FROM alerts WHERE kind='conflict' AND duplicate_key=? AND created_at > ?")
        .get(key, now - 24 * 3600 * 1000);
      if (!seen) {
        db.prepare(
          `INSERT INTO alerts(device_id, rule_id, severity, kind, title, message, created_at, status, notified, duplicate_key)
           VALUES (NULL, NULL, 'warning', 'conflict', ?, ?, ?, 'active', 0, ?)`
        ).run(
          `${summary.total} مورد مشکوک تعارض IP شناسایی شد`,
          'موارد با شاهد (سریال/نام هاست تکراری یا تلاقی با کشف) نیازمند تأیید مدیر هستند و هیچ‌کدام قطعی اعلام نشده‌اند.',
          now,
          key
        );
      }
    } catch {
      /* اعلان نباید پاسخ بررسی تعارض را خراب کند */
    }
  }
  res.json({ ...report, summary });
});

export default router;
