/**
 * NetWatch — محدودیت شبکهٔ APIهای مدیریتی (Phase 3)
 * ----------------------------------------------------------------
 * احراز هویت و RBAC تنها لایهٔ حفاظتی نیستند: اگر یک حساب Administrator
 * دزدیده شود، مهاجم از هر شبکه‌ای می‌تواند تنظیمات را عوض کند. با تنظیم
 * `NETWATCH_ADMIN_ALLOWED_CIDRS` دسترسی به مسیرهای مدیریتی (تنظیمات، کاربران،
 * حسابرسی، سلامت تفصیلی، کنترل موتور و پشتیبان/بازیابی) به شبکه‌های صریحاً
 * مجاز محدود می‌شود.
 *
 * نکته‌های امنیتی:
 *   • CIDR پیش از استفاده در config.js اعتبارسنجی شده است؛ مقدار نامعتبر
 *     راه‌اندازی را متوقف می‌کند تا محدودیت به‌صورت بی‌صدا اعمال نشود.
 *   • IP از `req.ip` و با اعتماد محدود به Trusted Proxy خوانده می‌شود؛ هدر
 *     X-Forwarded-For جعلی وقتی NETWATCH_TRUST_PROXY تنظیم نشده باشد نادیده
 *     می‌ماند.
 *   • پیش‌فرض (تنظیم‌نشده) محدودیت شبکه‌ای ندارد و کنترل نقش سر جایش است؛
 *     استقرار روی شبکه باید این متغیر را تنظیم کند (هشدار در config).
 *   • این گارد جایگزین RBAC نیست؛ بعد از احراز هویت و پیش از مسیرها اجرا
 *     می‌شود تا هم Administrator و هم Operator/Viewer مشمول شوند.
 */
import { isAdminRequest, clientIp } from './rate-limit.js';
import { ipInAnyCidr } from './net-policy.js';
import { logEvent } from './logger.mjs';

export function createAdminNetworkGuard({ adminCidrs = null } = {}) {
  const cidrs = Array.isArray(adminCidrs) && adminCidrs.length ? adminCidrs : null;
  return function adminNetworkGuard(req, res, next) {
    if (!cidrs || !isAdminRequest(req)) return next();
    const ip = clientIp(req);
    if (ipInAnyCidr(ip, cidrs)) return next();
    logEvent('warn', 'admin_api_network_denied', {
      ip,
      method: req.method,
      path: req.path,
      user: req.user?.username || null,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(403).json({ error: 'دسترسی به APIهای مدیریتی از این شبکه مجاز نیست.' });
  };
}

export default { createAdminNetworkGuard };
