/**
 * NetWatch — گزارش حسابرسی (Audit Log)
 * ----------------------------------------------------------------
 * هر عملیات تغییردهندهٔ داده، ورود/خروج، تغییر تنظیمات، حذف اطلاعات، Probe و
 * خروجی‌گیری در جدول `audit_log` ثبت می‌شود. قواعد مهم:
 *   • مقدار رمز، توکن، CSRF و هر Secret هرگز ذخیره نمی‌شود؛ فقط نام کلیدهای
 *     بدنه (بدون مقدار) و شناسهٔ هدف ثبت می‌شود.
 *   • شکست عملیات (۴۰۱/۴۰۳/۴۲۹/۵۰۰) هم با success=0 ثبت می‌شود.
 *   • خطای نوشتن حسابرسی هرگز پاسخ درخواست را خراب نمی‌کند.
 */
import { db } from './db.js';
import { sanitizeLogText } from './logger.mjs';

const SENSITIVE_KEY = /pass(word)?|secret|token|csrf|cookie|authorization|api[_-]?key|private/i;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SENSITIVE_READ = /\/(probe|export|export\/geo)$/i;
const MAX_DETAILS_CHARS = 4000;

const TARGET_TYPES = {
  auth: 'user',
  devices: 'device',
  device: 'device',
  dashboard: 'dashboard',
  reports: 'report',
  alerts: 'alert',
  'alert-rules': 'alert_rule',
  maintenance: 'maintenance',
  'maintenance-windows': 'maintenance_window',
  events: 'event',
  engine: 'engine',
  settings: 'settings',
  groups: 'group',
  tags: 'tag',
  layers: 'map_layer',
  mbtiles: 'mbtiles',
  markers: 'marker',
  'marker-types': 'marker_type',
  topology: 'topology',
  audit: 'audit',
};

const ACTIONS = [
  [/^\/api\/auth\/login$/, 'auth.login'],
  [/^\/api\/auth\/logout$/, 'auth.logout'],
  [/^\/api\/auth\/logout-all$/, 'auth.logout_all'],
  [/^\/api\/auth\/users(?:\/\d+)?\/unlock$/, 'user.unlock'],
  [/^\/api\/auth\/users(?:\/|$)/, 'user.manage'],
  [/^\/api\/settings\/reset-demo$/, 'data.reset'],
  [/^\/api\/settings$/, 'settings.update'],
  [/^\/api\/system\/backups\/restore$/, 'backup.restore'],
  [/^\/api\/system\/backups\/verify$/, 'backup.verify'],
  [/^\/api\/system\/backups\/prune$/, 'backup.prune'],
  [/^\/api\/system\/backups$/, 'backup.create'],
  [/^\/api\/system\/retention\/run$/, 'retention.run'],
  [/^\/api\/system\/retention\/stop$/, 'retention.stop'],
  [/^\/api\/engine\/control\//, 'engine.control'],
  [/\/probe$/, 'probe.run'],
  [/\/ping$/, 'probe.ping'],
  [/\/import(?:\/|$)/, 'data.import'],
  [/\/export(?:\/geo)?$/, 'data.export'],
  [/^\/api\/audit(?:\/|$)/, 'audit.read'],
];

function pathOnly(url = '') {
  return String(url).split('?')[0].slice(0, 500);
}

function inferAction(method, path) {
  for (const [re, action] of ACTIONS) {
    if (re.test(path)) {
      if (action === 'settings.update' && method === 'GET') return 'settings.read';
      return action;
    }
  }
  if (method === 'DELETE') return 'data.delete';
  const segments = path.split('/').filter(Boolean); // ['api','devices',...]
  const resource = segments[1] || 'api';
  return `${resource}.${String(method || 'unknown').toLowerCase()}`;
}

function inferTarget(path) {
  const segments = path.split('/').filter(Boolean);
  const type = TARGET_TYPES[segments[1]] || segments[1] || '';
  // /api/topology/diagrams/12 → targetId=12 (نه «diagrams»)
  const index = segments[1] === 'topology' ? 3 : 2;
  const candidate = segments[index] && /^\d+$/.test(segments[index]) ? segments[index] : '';
  return { targetType: String(type).slice(0, 40), targetId: candidate };
}

function safeKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value)
    .filter((k) => !SENSITIVE_KEY.test(k))
    .slice(0, 30)
    .map((k) => String(k).slice(0, 60));
}

function detailsFor(req, path) {
  const details = {};
  const queryKeys = safeKeys(req.query);
  if (queryKeys.length) details.queryKeys = queryKeys;
  const bodyKeys = safeKeys(req.body);
  if (bodyKeys.length) details.bodyKeys = bodyKeys;
  if (path === '/api/auth/login' && req.body && typeof req.body.username === 'string') {
    details.username = String(sanitizeLogText(req.body.username, 64));
  }
  // شناسهٔ هدف از مسیر (نه از بدنه) تا قابل جعل نباشد
  const { targetId } = inferTarget(path);
  if (targetId) details.targetId = targetId;
  return details;
}

function capJson(value) {
  let text;
  try {
    text = JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
  return text.length > MAX_DETAILS_CHARS ? `${text.slice(0, MAX_DETAILS_CHARS - 2)}…` : text;
}

function parseDetails(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

/**
 * ثبت یک رخداد حسابرسی.
 * @param {object} entry
 * @param {import('express').Request} [entry.req]
 */
export function recordAudit({ req, action, targetType, targetId, details, status, success, actor } = {}) {
  try {
    const path = req ? pathOnly(req.originalUrl) : '';
    const inferred = inferTarget(path);
    const user = actor || req?.auditActor || req?.user || null;
    const ok = success === undefined ? (status === undefined ? 1 : status < 400) : Boolean(success);
    const payload = details ?? (req ? detailsFor(req, path) : {});
    db.prepare(
      `INSERT INTO audit_log(ts, actor_id, actor_username, actor_role, action, target_type, target_id, method, path, ip, user_agent, status, success, details)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      Date.now(),
      user?.id ?? null,
      String(sanitizeLogText(String(user?.username ?? ''), 64)),
      String(sanitizeLogText(String(user?.role ?? ''), 24)),
      String(sanitizeLogText(String(action ?? 'unknown'), 80)),
      String(sanitizeLogText(String(targetType ?? inferred.targetType ?? ''), 40)),
      String(sanitizeLogText(String(targetId ?? inferred.targetId ?? ''), 64)),
      String(sanitizeLogText(String(req?.method ?? ''), 12)),
      String(sanitizeLogText(path, 500)),
      String(sanitizeLogText(String(req?.ip ?? ''), 64)),
      String(sanitizeLogText(String(req?.get?.('user-agent') ?? ''), 200)),
      status === undefined ? null : Number(status),
      ok ? 1 : 0,
      capJson(payload)
    );
    return true;
  } catch {
    // حسابرسی نباید دسترسی به سرویس را مختل کند؛ خطای آن در لاگ اصلی می‌آید.
    return false;
  }
}

/**
 * میدل‌ور حسابرسی: تغییردهنده‌ها و خواندن‌های حساس (Probe/خروجی) را پس از
 * پایان پاسخ ثبت می‌کند. باید بعد از attachUser و پیش از گاردهای مجوز نصب شود
 * تا درخواست‌های ردشده هم ثبت شوند.
 */
export function auditMutations(req, res, next) {
  const path = pathOnly(req.originalUrl);
  const mutation = !SAFE_METHODS.has(req.method);
  const sensitiveRead = req.method === 'GET' && SENSITIVE_READ.test(path);
  if (!mutation && !sensitiveRead) return next();
  res.on('finish', () => {
    recordAudit({
      req,
      action: inferAction(req.method, path),
      status: res.statusCode,
      success: res.statusCode < 400,
    });
  });
  return next();
}

/** فهرست صفحه‌بندی‌شده برای مدیر */
export function listAudit({ page = 1, pageSize = 50, action = '', username = '', success = '', from = '', to = '' } = {}) {
  const where = [];
  const params = [];
  if (action) {
    where.push('action = ?');
    params.push(String(action).slice(0, 80));
  }
  if (username) {
    where.push('actor_username = ? COLLATE NOCASE');
    params.push(String(username).slice(0, 64));
  }
  if (success === '0' || success === '1') {
    where.push('success = ?');
    params.push(Number(success));
  }
  const fromN = Number(from);
  const toN = Number(to);
  if (Number.isFinite(fromN) && fromN > 0) {
    where.push('ts >= ?');
    params.push(fromN);
  }
  if (Number.isFinite(toN) && toN > 0) {
    where.push('ts <= ?');
    params.push(toN);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const p = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 50));
  const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_log ${clause}`).get(...params).c;
  const items = db
    .prepare(
      `SELECT id, ts, actor_id, actor_username, actor_role, action, target_type, target_id,
              method, path, ip, user_agent, status, success, details
         FROM audit_log ${clause} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, size, (p - 1) * size)
    .map((r) => {
      const details = parseDetails(r.details);
      return {
        id: r.id,
        ts: r.ts,
        actorId: r.actor_id,
        actorUsername: r.actor_username,
        actorRole: r.actor_role,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        method: r.method,
        path: r.path,
        ip: r.ip,
        userAgent: r.user_agent,
        status: r.status,
        success: Boolean(r.success),
        details,
      };
    });
  return { items, total, page: p, pageSize: size, pages: Math.max(1, Math.ceil(total / size)) };
}

/** حذف رکوردهای قدیمی‌تر از دورهٔ نگهداری */
export function pruneAudit(days = 180) {
  const d = Math.min(3650, Math.max(7, Number(days) || 180));
  try {
    return db.prepare('DELETE FROM audit_log WHERE ts < ?').run(Date.now() - d * 86400000).changes;
  } catch {
    return 0;
  }
}

let timer = null;
/** پاک‌سازی روزانهٔ رکوردهای قدیمی حسابرسی */
export function startAuditSweeper(getSettings) {
  if (timer) return timer;
  const sweep = () => {
    try {
      const days = getSettings?.().audit_retention_days ?? 180;
      pruneAudit(days);
    } catch {
      /* بی‌اثر */
    }
  };
  sweep();
  timer = setInterval(sweep, 24 * 3600 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

/** آزادسازی تایمر پاک‌سازی حسابرسی هنگام خاموشی سرور */
export function stopAuditSweeper() {
  if (timer) clearInterval(timer);
  timer = null;
}

export default { recordAudit, auditMutations, listAudit, pruneAudit, startAuditSweeper, stopAuditSweeper };
