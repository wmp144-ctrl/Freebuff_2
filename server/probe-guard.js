/**
 * NetWatch — گارد مقصد Probe
 * ----------------------------------------------------------------
 * «Probe/اسکن فعال» فقط روی محدوده‌های مجاز (probe_allowed_cidrs) انجام
 * می‌شود. این گارد هم برای Ping دستی و هم برای بررسی زنده و بررسی دستی موتور
 * استفاده می‌شود؛ مجوز نقش (`probe:run`) جداگانه در مسیرها بررسی می‌شود.
 */
import { db, getSettings } from './db.js';
import { isProbeTargetAllowed } from './net-policy.js';

export function probeTargetGuard(req, res, next) {
  const id = Number(req.params.id);
  const row = Number.isInteger(id) && id > 0 ? db.prepare('SELECT id, name, ip FROM devices WHERE id = ?').get(id) : null;
  if (!row) return res.status(404).json({ error: 'تجهیز یافت نشد' });
  const policy = isProbeTargetAllowed(row.ip, getSettings());
  if (!policy.allowed) {
    return res.status(403).json({
      error: `Probe به مقصد ${row.ip} مجاز نیست؛ محدودهٔ مقاصد مجاز را در تنظیمات یا NETWATCH_PROBE_ALLOWED_CIDRS بررسی کنید.`,
    });
  }
  req.probeTarget = row;
  return next();
}

/** از میان تجهیزات، فقط شناسه‌هایی را برمی‌گرداند که مقصدشان مجاز است */
export function allowedProbeDeviceIds(rows) {
  const settings = getSettings();
  return rows.filter((r) => isProbeTargetAllowed(r.ip, settings).allowed).map((r) => r.id);
}

export default { probeTargetGuard, allowedProbeDeviceIds };
