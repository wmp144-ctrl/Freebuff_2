/**
 * NetWatch — موتور مانیتورینگ
 * ----------------------------------------------------------------
 * موتور به‌صورت کامل مستقل از رابط کاربری کار می‌کند. می‌تواند داخل
 * همان فرآیند سرور اجرا شود یا به شکل یک سرویس جداگانه:
 *      node server/engine-cli.js
 */
import { EventEmitter } from 'node:events';
import { db, getSettings, log, STATUS } from './db.js';
import { probeIcmp, icmpStatus, icmpPing, tcpPing } from './ping.js';

export const bus = new EventEmitter();
bus.setMaxListeners(200);

const PRIORITY_ORDER = { critical: 0, high: 1, normal: 2, low: 3 };

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/* ------------------------------------------------------------------ */
/* قالب پرس‌وجوهای آماده                                               */
/* ------------------------------------------------------------------ */
let stmt = null;
function S() {
  if (stmt) return stmt;
  stmt = {
    due: db.prepare('SELECT * FROM devices WHERE enabled = 1 AND monitoring_enabled = 1'),
    insertSample: db.prepare(
      'INSERT INTO samples(device_id, ts, rtt_ms, packets_sent, packets_recv, loss_pct, status, ok, mode) VALUES (?,?,?,?,?,?,?,?,?)'
    ),
    openOutage: db.prepare(
      'INSERT INTO outages(device_id, started_at, ended_at, duration_sec, cause, detail, lat, lng, open) VALUES (?,?,?,?,?,?,?,?,1)'
    ),
    closeOutage: db.prepare('UPDATE outages SET ended_at=?, duration_sec=?, open=0 WHERE id=?'),
    updateDevice: db.prepare(`UPDATE devices SET
        status=?, status_reason=?, last_check_at=?, last_status_change_at=?, last_rtt_ms=?, loss_pct=?,
        success_count=?, fail_count=?, total_checks=?, consecutive_failures=?, consecutive_successes=?,
        last_outage_at=?, current_outage_id=?, current_outage_started_at=?, last_recovery_at=?, min_rtt_ms=?, max_rtt_ms=?, avg_rtt_ms=?
      WHERE id=?`),
    recentAlert: db.prepare('SELECT id, created_at FROM alerts WHERE duplicate_key = ? ORDER BY created_at DESC LIMIT 1'),
    insertAlert: db.prepare(
      'INSERT INTO alerts(device_id, rule_id, severity, kind, title, message, value, created_at, status, notified, duplicate_key) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ),
    resolveAlerts: db.prepare(
      "UPDATE alerts SET status='resolved', resolved_at=? WHERE device_id=? AND status IN ('active','acknowledged') AND kind IN ('offline','latency','loss')"
    ),
    // یک قطعی «باز» تنها می‌تواند متعلق به تجهیزی باشد که در وضعیت Offline است
    closeStaleOpen: db.prepare(
      'UPDATE outages SET ended_at=?, duration_sec=MAX(1, CAST((?-started_at)/1000 AS INTEGER)), open=0 WHERE device_id=? AND open=1'
    ),
    rules: db.prepare('SELECT * FROM alert_rules WHERE enabled = 1'),
    windows: db.prepare('SELECT * FROM maintenance_windows WHERE enabled = 1'),
    deviceTags: db.prepare('SELECT t.name FROM device_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.device_id = ?'),
    pruneSamples: db.prepare('DELETE FROM samples WHERE ts < ?'),
    pruneOutages: db.prepare('DELETE FROM outages WHERE open = 0 AND started_at < ?'),
    pruneAlertsRow: db.prepare("DELETE FROM alerts WHERE created_at < ? AND status IN ('resolved','suppressed')"),
    recompute: db.prepare(
      `SELECT device_id,
              COUNT(*) AS checks,
              SUM(ok) AS ok_count,
              MIN(CASE WHEN ok=1 THEN rtt_ms END) AS min_rtt,
              MAX(CASE WHEN ok=1 THEN rtt_ms END) AS max_rtt,
              AVG(CASE WHEN ok=1 THEN rtt_ms END) AS avg_rtt
       FROM samples WHERE ts >= ? GROUP BY device_id`
    ),
    setUptime: db.prepare('UPDATE devices SET uptime_pct=? WHERE id=?'),
    rollDay: db.prepare(
      `INSERT INTO daily_stats(device_id, day, checks, failed, avg_rtt, max_rtt, loss_pct, outages, downtime_sec, uptime_pct)
       SELECT s.device_id, ?, COUNT(*), SUM(CASE WHEN s.ok=0 THEN 1 ELSE 0 END),
              AVG(CASE WHEN s.ok=1 THEN s.rtt_ms END), MAX(CASE WHEN s.ok=1 THEN s.rtt_ms END),
              AVG(CASE WHEN s.ok=0 THEN 100 ELSE 0 END),
              (SELECT COUNT(*) FROM outages o WHERE o.device_id = s.device_id AND date(o.started_at/1000,'unixepoch') = ?),
              (SELECT COALESCE(SUM(o.duration_sec),0) FROM outages o WHERE o.device_id = s.device_id AND date(o.started_at/1000,'unixepoch') = ?),
              NULL
       FROM samples s WHERE s.ts >= ? AND s.ts < ? GROUP BY s.device_id
       ON CONFLICT(device_id, day) DO UPDATE SET checks=excluded.checks, failed=excluded.failed,
         avg_rtt=excluded.avg_rtt, max_rtt=excluded.max_rtt, loss_pct=excluded.loss_pct,
         outages=excluded.outages, downtime_sec=excluded.downtime_sec, uptime_pct=excluded.uptime_pct`),
    setDailyUptime: db.prepare('UPDATE daily_stats SET uptime_pct = CASE WHEN checks>0 THEN ROUND((checks-failed)*100.0/checks,2) ELSE NULL END WHERE day = ?'),
  };
  return stmt;
}

/* ------------------------------------------------------------------ */
/* شبیه‌سازی (برای دمو و آموزش)                                        */
/* ------------------------------------------------------------------ */
const simState = new Map();
function simProfile(device) {
  let s = simState.get(device.id);
  if (!s) {
    const r1 = hash(`${device.ip}:a`);
    const r2 = hash(`${device.ip}:b`);
    const r3 = hash(`${device.ip}:c`);
    const base = r1 > 0.93 ? 120 + r1 * 160 : 2 + r1 * 55;
    // «chronic»: تجهیزات دارای خرابی پایدار (بازتاب واقعی شبکه‌هایی که تجهیز معیوب در انتظار تعمیر دارند)
    const chronic = r3 > 0.93;
    s = {
      base,
      drift: 0,
      jitter: 1 + r2 * 14,
      lossProb: chronic ? 0.35 : r3 > 0.82 ? 0.16 + r3 * 0.25 : r3 * 0.03,
      outageChance: chronic ? 0.22 : r3 > 0.6 ? 0.01 : 0.0025,
      chronic,
      downTicks: chronic ? 45 + Math.floor(r1 * 120) : 0,
    };
    simState.set(device.id, s);
  }
  return s;
}

const DOWN_RESULT = (count) => ({
  ok: false,
  rtt: null,
  packetsSent: count,
  packetsRecv: 0,
  lossPct: 100,
  mode: 'simulate',
  error: 'TIMEOUT',
});

function simulateCheck(device, count) {
  const s = simProfile(device);
  if (s.downTicks > 0) {
    s.downTicks--;
    return DOWN_RESULT(count);
  }
  if (Math.random() < s.outageChance) {
    s.downTicks = s.chronic ? 40 + Math.floor(Math.random() * 90) : 1 + Math.floor(Math.random() * 8);
    return DOWN_RESULT(count);
  }

  s.drift = s.drift * 0.9 + (Math.random() - 0.5) * s.jitter * 0.6;
  const rtt = Math.max(0.3, s.base + s.drift + (Math.random() - 0.5) * s.jitter);
  let recv = count;
  if (Math.random() < s.lossProb) recv = Math.max(0, count - (1 + Math.floor(Math.random() * (count - 1 || 1))));
  const lossPct = Math.round(((count - recv) / count) * 1000) / 10;
  return {
    ok: recv > 0,
    rtt: Math.round(rtt * 100) / 100,
    packetsSent: count,
    packetsRecv: recv,
    lossPct,
    mode: 'simulate',
    error: recv > 0 ? undefined : 'TIMEOUT',
  };
}

/* ------------------------------------------------------------------ */
/* موتور                                                               */
/* ------------------------------------------------------------------ */
export class MonitoringEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.emitToBus = options.emitToBus !== false;
    this.running = false;
    this.timer = null;
    this.interval = 1000;
    this.inflight = new Set();
    this.settingsCache = { at: 0, value: getSettings() };
    this.lastMaintenanceSweep = 0;
    this.lastRollup = 0;
    this.lastCleanup = 0;
    this.stats = { cycles: 0, checksRun: 0, lastRunAt: null, startedAt: null, errors: 0, skipped: 0 };
    this.rulesCache = { at: 0, rows: [] };
    this.windowsCache = { at: 0, rows: [] };
  }

  settings() {
    if (Date.now() - this.settingsCache.at > 5000) {
      this.settingsCache = { at: Date.now(), value: getSettings() };
    }
    return this.settingsCache.value;
  }

  rules() {
    if (Date.now() - this.rulesCache.at > 10000) {
      this.rulesCache = { at: Date.now(), rows: S().rules.all() };
    }
    return this.rulesCache.rows;
  }

  windows() {
    if (Date.now() - this.windowsCache.at > 30000) {
      this.windowsCache = { at: Date.now(), rows: S().windows.all() };
    }
    return this.windowsCache.rows;
  }

  async start() {
    if (this.running) return this.getStatus();
    this.running = true;
    this.stats.startedAt = Date.now();
    probeIcmp().then((ok) => {
      log('engine', ok ? 'ICMP در دسترس است؛ حالت واقعی آماده به کار است.' : 'ICMP در دسترس نیست؛ درخواست‌ها روی TCP انجام می‌شود.');
    });
    this.timer = setInterval(() => {
      this.tick().catch((e) => {
        this.stats.errors++;
        log('error', `خطای چرخه موتور: ${e.message}`);
      });
    }, this.interval);
    if (this.timer.unref) this.timer.unref();
    log('info', 'موتور مانیتورینگ راه‌اندازی شد.');
    if (this.emitToBus) bus.emit('engine', this.getStatus());
    return this.getStatus();
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    log('info', 'موتور مانیتورینگ متوقف شد.');
    if (this.emitToBus) bus.emit('engine', this.getStatus());
    return this.getStatus();
  }

  getStatus() {
    const s = this.settings();
    return {
      running: this.running,
      mode: s.engine_mode,
      icmpAvailable: icmpStatus(),
      interval: s.ping_interval,
      maxWorkers: s.max_workers,
      inflight: this.inflight.size,
      ...this.stats,
    };
  }

  /* ---------------- چرخه اصلی ---------------- */
  async tick() {
    if (!this.running) return;
    const s = this.settings();
    this.stats.cycles++;
    this.stats.lastRunAt = Date.now();

    if (Date.now() - this.lastCleanup > 10 * 60 * 1000) {
      this.lastCleanup = Date.now();
      this.cleanup(s);
    }
    if (Date.now() - this.lastRollup > 60 * 1000) {
      this.lastRollup = Date.now();
      this.rollup(s);
    }

    if (!s.engine_enabled) return;

    const now = Date.now();
    const devices = S().due.all();
    const due = [];
    for (const d of devices) {
      const iv = (d.ping_interval || s.ping_interval) * 1000;
      if (!d.last_check_at || now - d.last_check_at >= iv) {
        if (!this.inflight.has(d.id)) due.push(d);
      }
    }
    due.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2));

    const capacity = Math.max(1, s.max_workers - this.inflight.size);
    const batch = due.slice(0, capacity);
    await Promise.all(batch.map((d) => this.checkDevice(d).catch(() => {})));
  }

  /** بررسی یک تجهیز و ثبت کامل نتیجه */
  async checkDevice(device, { manual = false, source = 'engine' } = {}) {
    if (this.inflight.has(device.id)) return null;
    this.inflight.add(device.id);
    try {
      const s = this.settings();
      const inWindow = this.inMaintenanceWindow(device.id);
      if (inWindow && !manual) {
        this.stats.skipped++;
        db.prepare("UPDATE devices SET status=?, status_reason=? WHERE id=? AND status != ?").run(
          STATUS.MAINTENANCE,
          'در پنجره تعمیرات — بررسی موقتاً متوقف است',
          device.id,
          STATUS.MAINTENANCE
        );
        return null;
      }

      const interval = (device.ping_interval || s.ping_interval) * 1000;
      const timeoutMs = device.timeout_ms || s.timeout_ms;
      const count = Math.max(1, device.packet_count || s.packet_count);
      const retries = device.retries ?? s.retries;
      const latencyThreshold = device.latency_threshold ?? s.latency_threshold;
      const lossThreshold = device.loss_threshold ?? s.loss_threshold;

      let result = await this.probe(device, { timeoutMs, count, retries, mode: s.engine_mode });
      const ts = Date.now();

      const failures = result.ok ? 0 : (device.consecutive_failures || 0) + 1;
      const successes = result.ok ? (device.consecutive_successes || 0) + 1 : 0;
      const prevStatus = device.status;

      let status = device.status;
      let reason = device.status_reason || '';
      let outageId = device.current_outage_id || null;
      let outageStart = device.current_outage_started_at || null;
      let lastOutageAt = device.last_outage_at || null;
      let lastRecoveryAt = device.last_recovery_at || null;
      let statusChanged = false;

      const isUnreachable = !result.ok;
      let isDegraded = false;
      if (result.ok) {
        const effRtt = result.rtt ?? 0;
        if (effRtt > latencyThreshold) isDegraded = true;
        if (result.lossPct > lossThreshold) isDegraded = true;
      }

      // ---- گذارها ----
      if (isUnreachable && device.status !== STATUS.OFFLINE && failures >= s.failures_for_offline) {
        status = STATUS.OFFLINE;
        reason = result.error === 'TIMEOUT' || result.error === 'HARD_TIMEOUT' ? 'Ping Timeout' : `عدم پاسخ (${result.error || 'خطای شبکه'})`;
        const cause = this.guessCause(result, failures);
        const res = S().openOutage.run(device.id, ts, null, null, cause, '', device.latitude, device.longitude);
        outageId = Number(res.lastInsertRowid);
        outageStart = ts;
        lastOutageAt = ts;
        statusChanged = true;
        this.raiseAlert('offline', device, {
          severity: 'critical',
          title: `قطع ارتباط — ${device.name}`,
          message: `تجهیز ${device.name} (${device.ip}) پس از ${failures} بررسی ناموفق متوالی از دسترس خارج شد. علت تخمینی: ${cause}`,
          value: failures,
          ts,
        });
      } else if (isUnreachable && device.status === STATUS.OFFLINE) {
        status = STATUS.OFFLINE;
      } else if (result.ok && device.status === STATUS.OFFLINE && successes >= s.successes_for_online) {
        status = isDegraded ? STATUS.WARNING : STATUS.ONLINE;
        if (prevStatus === STATUS.OFFLINE) {
          const dur = outageId ? Math.max(1, Math.round((ts - (outageStart || ts)) / 1000)) : null;
          if (outageId) S().closeOutage.run(ts, dur, outageId);
          if (outageId) this.attachMaintenanceSuggestion(device, outageId, outageStart || ts, ts, dur);
          outageId = null;
          outageStart = null;
          this.resolveDeviceAlerts(device.id, ts);
          this.raiseAlert('recovery', device, {
            severity: 'info',
            title: `بازگشت به حالت عادی — ${device.name}`,
            message: `تجهیز ${device.name} (${device.ip}) مجدداً در دسترس است.${dur ? ` مدت قطعی: ${dur} ثانیه.` : ''}`,
            value: successes,
            ts,
          });
        }
        lastRecoveryAt = ts;
        reason = isDegraded ? 'تأخیر یا افت بسته بیش از حد مجاز' : '';
        statusChanged = true;
      } else if (result.ok) {
        const next = isDegraded ? STATUS.WARNING : STATUS.ONLINE;
        if (next !== device.status && prevStatus !== STATUS.OFFLINE) statusChanged = true;
        status = next;
        reason = isDegraded
          ? result.rtt > latencyThreshold
            ? `تأخیر بالا (${Math.round(result.rtt)} میلی‌ثانیه)`
            : `افت بسته (${result.lossPct}٪)`
          : '';
        if (isDegraded) {
          if (result.rtt > latencyThreshold)
            this.raiseAlert('latency', device, {
              severity: Math.round(result.rtt) > latencyThreshold * 2 ? 'critical' : 'warning',
              title: `تأخیر بالا — ${device.name}`,
              message: `تأخیر تجهیز ${device.name} (${device.ip}) ${Math.round(result.rtt)} میلی‌ثانیه است (آستانه: ${latencyThreshold}).`,
              value: result.rtt,
              ts,
            });
          if (result.lossPct > lossThreshold)
            this.raiseAlert('loss', device, {
              severity: 'warning',
              title: `افت بسته — ${device.name}`,
              message: `افت بسته تجهیز ${device.name} (${device.ip}) ${result.lossPct}٪ است (آستانه: ${lossThreshold}٪).`,
              value: result.lossPct,
              ts,
            });
        } else {
          this.resolveDeviceAlerts(device.id, ts);
        }
      }

      // اصلاح ناسازگاری احتمالی: تجهیز در دسترس نباید قطعیِ باز داشته باشد
      if (status !== STATUS.OFFLINE) {
        const closed = S().closeStaleOpen.run(ts, ts, device.id);
        if (closed.changes > 0 && outageId) {
          outageId = null;
          outageStart = null;
        }
      } else if (!outageId) {
        // تجهیز قطع است اما رکورد قطعی بازی ندارد (مثلاً پس از بازنشانی داده‌ها)
        const started = device.current_outage_started_at || device.last_outage_at || ts;
        const res = S().openOutage.run(device.id, started, null, null, device.status_reason || 'Ping Timeout', '', device.latitude, device.longitude);
        outageId = Number(res.lastInsertRowid);
        outageStart = started;
      }

      const okInt = result.ok ? 1 : 0;
      S().insertSample.run(
        device.id,
        ts,
        result.rtt ?? null,
        result.packetsSent ?? count,
        result.packetsRecv ?? 0,
        result.lossPct ?? (okInt ? 0 : 100),
        status,
        okInt,
        result.mode
      );

      const hasRtt = result.ok && result.rtt != null;
      const nextMin = hasRtt ? Math.min(device.min_rtt_ms ?? result.rtt, result.rtt) : device.min_rtt_ms ?? null;
      const nextMax = hasRtt ? Math.max(device.max_rtt_ms ?? result.rtt, result.rtt) : device.max_rtt_ms ?? null;
      const nextAvg = hasRtt
        ? device.avg_rtt_ms == null
          ? result.rtt
          : Math.round((device.avg_rtt_ms * 0.98 + result.rtt * 0.02) * 100) / 100
        : device.avg_rtt_ms ?? null;

      S().updateDevice.run(
        status,
        reason,
        ts,
        statusChanged ? ts : device.last_status_change_at ?? ts,
        result.rtt ?? null,
        result.lossPct ?? (okInt ? 0 : 100),
        (device.success_count || 0) + okInt,
        (device.fail_count || 0) + (okInt ? 0 : 1),
        (device.total_checks || 0) + 1,
        failures,
        successes,
        lastOutageAt,
        outageId,
        outageStart,
        lastRecoveryAt,
        nextMin,
        nextMax,
        nextAvg,
        device.id
      );

      // مقدار واقعی برای نمایش فوری در UI
      const payload = {
        deviceId: device.id,
        ts,
        status,
        rtt: result.rtt,
        lossPct: result.lossPct,
        ok: result.ok,
        mode: result.mode,
        source,
        manual,
        interval,
      };
      this.stats.checksRun++;
      this.emit('sample', payload);
      if (this.emitToBus) bus.emit('sample', payload);
      if (statusChanged) {
        this.emit('status', payload);
        if (this.emitToBus) bus.emit('status', payload);
      }
      return payload;
    } finally {
      this.inflight.delete(device.id);
    }
  }

  async probe(device, { timeoutMs, count, retries, mode }) {
    const attempts = Math.max(1, (retries || 0) + 1);
    let last = null;
    for (let i = 0; i < attempts; i++) {
      const effective = mode === 'auto' ? (icmpStatus() === false ? 'tcp' : 'icmp') : mode;
      last =
        effective === 'simulate'
          ? simulateCheck(device, count)
          : effective === 'tcp'
            ? await tcpPing(device.ip, { timeoutMs, count: Math.min(count, 3), port: 80 })
            : await icmpPing(device.ip, { timeoutMs, count });
      if (last.ok) return last;
      // اگر ICMP به دلیل مجوزها مسدود است، به TCP سقوط کن
      if (last.error === 'ICMP_BLOCKED') {
        last = await tcpPing(device.ip, { timeoutMs, count: Math.min(count, 3), port: 80 });
        if (last.ok) return last;
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 200));
    }
    return last;
  }

  guessCause(result, failures) {
    if (result.error === 'TIMEOUT' || result.error === 'HARD_TIMEOUT') return 'Ping Timeout';
    if (result.error === 'ECONNREFUSED') return 'مشکل شبکه';
    if (result.error === 'EHOSTUNREACH' || result.error === 'ENETUNREACH') return 'اختلال در زیرساخت فیبر نوری';
    if (failures >= 10) return 'هنگ کردن سوئیچ';
    return 'مشکل شبکه';
  }

  /* ---------------- هشدارها ---------------- */
  raiseAlert(kind, device, { severity, title, message, value, ts }) {
    const s = this.settings();
    if (!s.alerting_enabled) return null;
    const rules = this.rules();
    const mapped = { offline: 'offline', latency: 'latency', loss: 'loss', recovery: 'recovery' }[kind];
    const rule =
      rules.find((r) => r.metric === mapped && (!r.scope_group_id || r.scope_group_id === device.group_id)) ||
      rules.find((r) => r.metric === mapped) ||
      null;
    if (rule && rule.silent && this.inQuietHours(s)) {
      db.prepare(
        'INSERT INTO alerts(device_id, rule_id, severity, kind, title, message, value, created_at, status, notified, duplicate_key) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      ).run(device.id, rule.id, severity, kind, title, message, value ?? null, ts, 'suppressed', 1, `${kind}:${device.id}`);
      return null;
    }
    const cooldown = (rule?.cooldown_sec ?? s.alert_cooldown) * 1000;
    const key = `${kind}:${device.id}`;
    if (cooldown > 0) {
      const prev = S().recentAlert.get(key);
      if (prev && ts - prev.created_at < cooldown) return null;
    }
    const res = S().insertAlert.run(
      device.id,
      rule ? rule.id : null,
      severity,
      kind,
      title,
      message,
      value ?? null,
      ts,
      'active',
      1,
      key
    );
    const alert = { id: Number(res.lastInsertRowid), deviceId: device.id, deviceName: device.name, severity, kind, title, message, created_at: ts, status: 'active' };
    this.emit('alert', alert);
    if (this.emitToBus) bus.emit('alert', alert);
    return alert;
  }

  resolveDeviceAlerts(deviceId, ts) {
    const r = S().resolveAlerts.run(ts, deviceId);
    if (r.changes > 0) {
      this.emit('alert-resolved', { deviceId, ts });
      if (this.emitToBus) bus.emit('alert-resolved', { deviceId, ts });
    }
  }

  attachMaintenanceSuggestion(device, outageId, startedAt, endedAt, durationSec) {
    try {
      const exists = db.prepare('SELECT id FROM maintenance_records WHERE outage_id = ?').get(outageId);
      if (exists) return;
      const cause = db.prepare('SELECT cause FROM outages WHERE id = ?').get(outageId)?.cause || 'سایر';
      db.prepare(
        'INSERT INTO maintenance_records(device_id, outage_id, title, cause, action, started_at, ended_at, downtime_sec, technician, cost, description, notes, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(
        device.id,
        outageId,
        `قطعی شناسایی‌شده توسط موتور مانیتورینگ`,
        cause,
        'سایر',
        startedAt,
        endedAt,
        durationSec || 0,
        '',
        0,
        `این رکورد به‌صورت خودکار پس از پایان قطعی ایجاد شد. علت تخمینی: ${cause}`,
        'برای تکمیل سوابق نگهداری، اقدام انجام‌شده را ویرایش کنید.',
        'open',
        Date.now()
      );
      log('info', `رکورد تعمیرات خودکار برای تجهیز ${device.name} ساخته شد.`);
    } catch (e) {
      /* بی‌اثر */
    }
  }

  /* ---------------- پنجره تعمیرات و سکوت ---------------- */
  inMaintenanceWindow(deviceId) {
    const rows = this.windows();
    if (!rows.length) return false;
    const now = new Date();
    const day = now.getDay();
    const minutes = now.getHours() * 60 + now.getMinutes();
    for (const w of rows) {
      if (w.device_id && w.device_id !== deviceId) continue;
      const days = String(w.days || '').split(',').map((x) => Number(x.trim()));
      if (!days.includes(day)) continue;
      const [sh, sm] = String(w.start_time || '00:00').split(':').map(Number);
      const [eh, em] = String(w.end_time || '00:00').split(':').map(Number);
      const start = sh * 60 + (sm || 0);
      const end = eh * 60 + (em || 0);
      if (start <= end ? minutes >= start && minutes <= end : minutes >= start || minutes <= end) return true;
    }
    return false;
  }

  inQuietHours(s) {
    if (!s.suppression_enabled) return false;
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = String(s.suppression_start).split(':').map(Number);
    const [eh, em] = String(s.suppression_end).split(':').map(Number);
    const start = sh * 60 + (sm || 0);
    const end = eh * 60 + (em || 0);
    return start <= end ? minutes >= start && minutes <= end : minutes >= start || minutes <= end;
  }

  /* ---------------- نگهداری دوره‌ای ---------------- */
  rollup(s) {
    try {
      const now = Date.now();
      const dayStart = new Date(new Date(now).setUTCHours(0, 0, 0, 0)).getTime();
      const day = new Date(dayStart).toISOString().slice(0, 10);
      S().rollDay.run(day, day, day, dayStart, dayStart + 86400000);
      S().setDailyUptime.run(day);
    } catch (e) {
      this.stats.errors++;
      log('error', `خطا در تجمیع روزانه: ${e.message}`);
    }
    try {
      const s2 = this.settings();
      const since = Date.now() - 24 * 3600 * 1000;
      const rows = S().recompute.all(since);
      for (const r of rows) {
        const uptime = r.checks ? ((r.ok_count || 0) / r.checks) * 100 : 100;
        db.prepare('UPDATE devices SET uptime_pct=?, min_rtt_ms=?, max_rtt_ms=?, avg_rtt_ms=? WHERE id=?').run(
          Number(uptime.toFixed(2)),
          r.min_rtt == null ? null : Number(r.min_rtt),
          r.max_rtt == null ? null : Number(r.max_rtt),
          r.avg_rtt == null ? null : Number(Number(r.avg_rtt).toFixed(2)),
          r.device_id
        );
      }
    } catch (e) {
      this.stats.errors++;
      log('error', `خطا در بازمحاسبه شاخص‌ها: ${e.message}`);
    }
  }

  cleanup(s) {
    try {
      const cutoff = Date.now() - Math.max(1, s.retention_days) * 86400000;
      S().pruneSamples.run(cutoff);
      S().pruneOutages.run(cutoff);
      S().pruneAlertsRow.run(cutoff);
      db.prepare('DELETE FROM engine_log WHERE ts < ?').run(Date.now() - 14 * 86400000);
      log('engine', 'پاک‌سازی رکوردهای قدیمی انجام شد.');
    } catch (e) {
      log('error', `خطا در پاک‌سازی: ${e.message}`);
    }
  }
}

export const engine = new MonitoringEngine();
export default engine;
