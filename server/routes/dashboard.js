/**
 * NetWatch — API داشبورد مدیریتی
 */
import express from 'express';
import { db, getSettings } from '../db.js';
import { engine } from '../engine.js';

const router = express.Router();

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
  const s = getSettings();
  const now = Date.now();
  const since24 = now - 24 * 3600 * 1000;
  const mod = tzModifier(s.timezone_offset_minutes);

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
  const score = healthScore({
    availability,
    onlineRatio: active ? online / active : 1,
    warningRatio: active ? warning / active : 0,
    avgRtt: agg.avg_rtt,
    threshold: s.latency_threshold,
    lossAvg: agg.loss || 0,
  });

  // روند تعداد تجهیزات قطع‌شده در ۲۴ ساعت گذشته (۱۵ دقیقه‌ای)
  const offlineTrend = db
    .prepare(
      `SELECT bucket, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS offline, COUNT(*) AS devices
       FROM (
         SELECT device_id, (ts / ?) * ? AS bucket, ok,
                ROW_NUMBER() OVER (PARTITION BY device_id, (ts / ?) * ? ORDER BY ts DESC) AS rn
         FROM samples WHERE ts >= ?
       ) WHERE rn = 1 GROUP BY bucket ORDER BY bucket`
    )
    .all(900000, 900000, 900000, 900000, since24)
    .map((r) => ({ t: r.bucket, offline: r.offline, devices: r.devices }));

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

  const topDowntime = db
    .prepare(
      `SELECT d.id, d.name, d.ip, d.status, g.name AS groupName, g.color AS groupColor,
              COUNT(o.id) AS outages,
              COALESCE(SUM(COALESCE(o.duration_sec,0)),0) AS downtimeSec
       FROM devices d LEFT JOIN groups g ON g.id = d.group_id
       LEFT JOIN outages o ON o.device_id = d.id AND o.started_at >= ?
       WHERE d.enabled = 1
       GROUP BY d.id HAVING outages > 0
       ORDER BY downtimeSec DESC, outages DESC LIMIT 10`
    )
    .all(now - 7 * 86400000)
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

  // روند شاخص سلامت در ۷ روز گذشته
  const trend = db
    .prepare(
      `SELECT date(ts/1000,'unixepoch',?) AS day,
              ROUND(AVG(ok) * 100, 2) AS availability,
              COUNT(*) AS checks
       FROM samples WHERE ts >= ? GROUP BY day ORDER BY day`
    )
    .all(mod, now - 7 * 86400000)
    .map((r) => ({ day: r.day, availability: r.availability, checks: r.checks }));

  const dailyOutageTrend = db
    .prepare(
      `SELECT date(ts/1000,'unixepoch',?) AS day, ROUND(AVG(CASE WHEN ok=1 THEN rtt_ms END),1) AS avgRtt
       FROM samples WHERE ts >= ? GROUP BY day ORDER BY day`
    )
    .all(mod, now - 7 * 86400000)
    .map((r) => ({
      day: r.day,
      health: healthScore({
        availability: trend.find((t) => t.day === r.day)?.availability ?? 100,
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

  res.json({
    kpis: {
      total,
      active,
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
  });
});

export default router;
