/**
 * NetWatch — API داشبورد مدیریتی
 */
import express from 'express';
import { db, getSettings } from '../db.js';
import { engine } from '../engine.js';
import { dailySeries } from '../daily.js';
import { requirePermission } from '../permissions.js';

const router = express.Router();

router.use(requirePermission('dashboard:read'));

// داشبورد هر بار تمام محاسبات را انجام می‌داد؛ با چند تب/کاربر باز، این محاسبات
// تکرار می‌شد. نتیجه چند ثانیه در حافظه نگه داشته می‌شود (داده‌ها زنده از SSE می‌آید).
const CACHE_MS = 5000;
const summaryCache = { at: 0, body: null };

function tzModifier(minutes) {
  const m = Number(minutes) || 0;
  return `${m >= 0 ? '+' : '-'}${Math.abs(m)} minutes`;
}

export function healthScore({ availability, onlineRatio, warningRatio, avgRtt, threshold, lossAvg }) {
  const availScore = Math.max(0, Math.min(1, availability / 100));
  const onlineScore = Math.max(0, Math.min(1, onlineRatio));
  const warningScore = Math.max(0, Math.min(1, 1 - warningRatio));
  const latencyScore = avgRtt == null ? 1 : Math.max(0, Math.min(1, 1 - avgRtt / Math.max(1, threshold * 2)));
  const lossScore = Math.max(0, Math.min(1, 1 - lossAvg / 25));
  const score = availScore * 0.4 + onlineScore * 0.3 + warningScore * 0.12 + latencyScore * 0.1 + lossScore * 0.08;
  return Math.round(Math.max(0, Math.min(100, score * 100)) * 10) / 10;
}

export function grade(score) {
  if (score >= 92) return { label: 'عالی', tone: 'excellent' };
  if (score >= 80) return { label: 'خوب', tone: 'good' };
  if (score >= 65) return { label: 'قابل قبول', tone: 'fair' };
  if (score >= 45) return { label: 'ضعیف', tone: 'poor' };
  return { label: 'بحرانی', tone: 'critical' };
}

router.get('/summary', (_req, res) => {
  if (summaryCache.body && Date.now() - summaryCache.at < CACHE_MS) {
    return res.setHeader('X-Cache', 'hit').json(summaryCache.body);
  }
  const s = getSettings();
  const now = Date.now();
  const since24 = now - 24 * 3600 * 1000;
  const mod = tzModifier(s.timezone_offset_minutes);
  const tzMinutes = Number(s.timezone_offset_minutes) || 0;

  const counts = db
    .prepare("SELECT status, COUNT(*) AS c FROM devices WHERE enabled = 1 GROUP BY status")
    .all()
    .reduce((acc, r) => ({ ...acc, [r.status]: r.c }), {});
  const total = db.prepare('SELECT COUNT(*) AS c FROM devices').get().c;
  const active = Object.values(counts).reduce((a, b) => a + b, 0);
  const disabled = db.prepare('SELECT COUNT(*) AS c FROM devices WHERE enabled = 0').get().c;

  const agg = db
    .prepare(
      `SELECT COUNT(*) AS checks, SUM(ok) AS okc,
              AVG(CASE WHEN ok=1 THEN rtt_ms END) AS avg_rtt,
              AVG(CASE WHEN ok=1 THEN 0 ELSE 100 END) AS loss
       FROM samples WHERE ts >= ?`
    )
    .get(since24);
  const availability = agg.checks ? ((agg.okc || 0) / agg.checks) * 100 : 100;
  const online = counts.online || 0;
  const warning = counts.warning || 0;
  const offline = counts.offline || 0;
  // تفکیک سه‌گانه‌ای که در داشبورد نمایش داده می‌شود: تجهیزات دارای اختلال هم
  // «وصل» حساب می‌شوند. مجموع این سه همیشه دقیقاً برابر تعداد کل تجهیزات است؛
  // تجهیزات در تعمیرات یا با وضعیت نامشخص در سبد «غیرفعال» قرار می‌گیرند.
  const up = online + warning;
  const down = offline;
  const inactive = Math.max(0, total - up - down);
  const score = healthScore({
    availability,
    onlineRatio: active ? online / active : 1,
    warningRatio: active ? warning / active : 0,
    avgRtt: agg.avg_rtt,
    threshold: s.latency_threshold,
    lossAvg: agg.loss || 0,
  });

  // روند تعداد تجهیزات قطع‌شده در ۲۴ ساعت گذشته (بازه‌های ۱۵ دقیقه‌ای).
  // مبنای محاسبه، جدول قطعی‌هاست نه نمونه‌های خام: پرس‌وجوی قبلی با تابع پنجره‌ای
  // روی تمام نمونه‌های ۲۴ ساعت اجرا می‌شد (در نصب‌های بزرگ، میلیون‌ها ردیف).
  const step = 900000;
  const bucketStart = Math.floor(since24 / step) * step;
  const offlineTrend = [];
  const bucketIndex = new Map();
  for (let t = bucketStart; t <= now; t += step) {
    const b = { t, offline: 0, devices: 0 };
    offlineTrend.push(b);
    bucketIndex.set(t, b);
  }
  const monitoredCount = db.prepare('SELECT COUNT(*) AS c FROM devices WHERE enabled=1 AND monitoring_enabled=1').get().c;
  for (const b of offlineTrend) b.devices = monitoredCount;
  // قطعی‌های باز، تا همین لحظه ادامه‌دار حساب می‌شوند
  for (const o of db
    .prepare('SELECT started_at, ended_at FROM outages WHERE started_at <= ? AND COALESCE(ended_at, ?) >= ?')
    .all(now, now, bucketStart)) {
    const from = Math.floor(Math.max(o.started_at, bucketStart) / step) * step;
    const to = Math.min(o.ended_at || now, now);
    for (let t = from; t <= to; t += step) {
      const b = bucketIndex.get(t);
      if (b) b.offline += 1;
    }
  }

  const outagesPerDay = db
    .prepare(
      `SELECT date(started_at/1000,'unixepoch',?) AS day, COUNT(*) AS count,
              COALESCE(SUM(COALESCE(duration_sec, (strftime('%s','now')*1000 - started_at)/1000)),0) AS downtime
       FROM outages WHERE started_at >= ? GROUP BY day ORDER BY day`
    )
    .all(mod, now - 14 * 86400000)
    .map((r) => ({ day: r.day, count: r.count, downtimeSec: Math.round(r.downtime) }));

  const topLatency = db
    .prepare(
      `SELECT d.id, d.name, d.ip, d.status, d.avg_rtt_ms AS avgRtt, d.max_rtt_ms AS maxRtt, d.last_rtt_ms AS lastRtt,
              d.loss_pct AS lossPct, g.name AS groupName, g.color AS groupColor
       FROM devices d LEFT JOIN groups g ON g.id = d.group_id
       WHERE d.enabled = 1 AND d.avg_rtt_ms IS NOT NULL
       ORDER BY d.avg_rtt_ms DESC LIMIT 10`
    )
    .all();

  // مدت قطعی‌های باز (duration_sec پر نشده) با زمان سپری‌شده تا همین لحظه حساب می‌شود
  const topDowntime = db
    .prepare(
      `SELECT d.id, d.name, d.ip, d.status, g.name AS groupName, g.color AS groupColor,
              COUNT(o.id) AS outages,
              COALESCE(SUM(COALESCE(o.duration_sec, (? - o.started_at)/1000)),0) AS downtimeSec
       FROM devices d LEFT JOIN groups g ON g.id = d.group_id
       LEFT JOIN outages o ON o.device_id = d.id AND o.started_at >= ?
       WHERE d.enabled = 1
       GROUP BY d.id HAVING outages > 0
       ORDER BY downtimeSec DESC, outages DESC LIMIT 10`
    )
    .all(now, now - 7 * 86400000)
    .map((r) => ({ ...r, downtimeSec: Math.round(r.downtimeSec) }));

  const groupStatus = db
    .prepare(
      `SELECT g.id, g.name, g.color, COUNT(d.id) AS total,
              SUM(CASE WHEN d.status='online' THEN 1 ELSE 0 END) AS online,
              SUM(CASE WHEN d.status='offline' THEN 1 ELSE 0 END) AS offline,
              SUM(CASE WHEN d.status='warning' THEN 1 ELSE 0 END) AS warning,
              ROUND(AVG(d.uptime_pct),2) AS uptime,
              ROUND(AVG(d.avg_rtt_ms),1) AS avgRtt
       FROM groups g LEFT JOIN devices d ON d.group_id = g.id AND d.enabled = 1
       GROUP BY g.id ORDER BY total DESC`
    )
    .all();

  // روند شاخص سلامت در ۷ روز گذشته — روزهای کامل از جدول تجمیعی روزانه خوانده
  // می‌شوند و فقط روز جاری از نمونه‌های خام محاسبه می‌شود.
  const dayRows = dailySeries({ from: now - 7 * 86400000, to: now, offsetMin: tzMinutes });
  const trend = dayRows.map((r) => ({ day: r.day, availability: r.availability, checks: r.checks }));

  const dailyOutageTrend = dayRows.map((r) => ({
    day: r.day,
    avgRtt: r.avgRtt,
    health: healthScore({
      availability: r.availability ?? 100,
      onlineRatio: 1,
      warningRatio: 0,
      avgRtt: r.avgRtt,
      threshold: s.latency_threshold,
      lossAvg: 0,
    }),
  }));

  const alerts = db
    .prepare(
      `SELECT a.*, d.name AS deviceName, d.ip AS deviceIp FROM alerts a LEFT JOIN devices d ON d.id = a.device_id
       ORDER BY a.created_at DESC LIMIT 8`
    )
    .all();
  const alertCounts = db
    .prepare("SELECT severity, COUNT(*) AS c FROM alerts WHERE status='active' GROUP BY severity")
    .all()
    .reduce((acc, r) => ({ ...acc, [r.severity]: r.c }), {});

  const degraded = db
    .prepare(
      `SELECT d.id, d.name, d.ip, d.status, d.avg_rtt_ms AS avgRtt, d.loss_pct AS lossPct, d.uptime_pct AS uptime
       FROM devices d WHERE d.enabled = 1 AND (d.status='warning' OR d.uptime_pct < 98)
       ORDER BY d.uptime_pct ASC LIMIT 8`
    )
    .all();

  summaryCache.at = Date.now();
  summaryCache.body = {
    kpis: {
      total,
      active,
      up,
      down,
      inactive,
      online,
      offline,
      warning,
      unknown: counts.unknown || 0,
      maintenance: counts.maintenance || 0,
      disabled,
      monitoring: db.prepare('SELECT COUNT(*) AS c FROM devices WHERE enabled=1 AND monitoring_enabled=1').get().c,
    },
    health: {
      score,
      grade: grade(score),
      availability: Math.round(availability * 100) / 100,
      avgRtt: agg.avg_rtt == null ? null : Math.round(agg.avg_rtt * 100) / 100,
      lossAvg: agg.loss == null ? null : Math.round(agg.loss * 100) / 100,
      checks24h: agg.checks,
      alertsActive: Object.values(alertCounts).reduce((a, b) => a + b, 0),
      alertCounts,
    },
    statusDistribution: [
      { key: 'online', label: 'در دسترس', value: online, color: '#16a34a' },
      { key: 'warning', label: 'دارای اختلال', value: warning, color: '#f59e0b' },
      { key: 'offline', label: 'قطع‌شده', value: offline, color: '#dc2626' },
      { key: 'maintenance', label: 'تعمیرات', value: counts.maintenance || 0, color: '#7c3aed' },
      { key: 'unknown', label: 'نامشخص', value: counts.unknown || 0, color: '#94a3b8' },
    ].filter((x) => x.value > 0),
    offlineTrend,
    outagesPerDay,
    topLatency,
    topDowntime,
    groupStatus: groupStatus.map((g) => ({ ...g, total: g.total || 0 })),
    healthTrend: trend.map((t) => ({ ...t, health: dailyOutageTrend.find((d) => d.day === t.day)?.health ?? null, avgRtt: null })),
    avgRttTrend: dailyOutageTrend,
    recentAlerts: alerts.map((a) => ({
      id: a.id,
      deviceId: a.device_id,
      deviceName: a.deviceName,
      severity: a.severity,
      kind: a.kind,
      title: a.title,
      message: a.message,
      createdAt: a.created_at,
      status: a.status,
    })),
    degraded,
    engine: engine.getStatus(),
    settings: { siteName: s.site_name, latencyThreshold: s.latency_threshold, lossThreshold: s.loss_threshold, chartRange: s.chart_default_range, engineMode: s.engine_mode, calendar: s.calendar },
    generatedAt: Date.now(),
  };
  res.json(summaryCache.body);
});

export default router;
