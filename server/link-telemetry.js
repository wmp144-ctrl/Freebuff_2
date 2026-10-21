/**
 * NetWatch — سنجش ترافیک لینک‌های دیاگرام (SNMPv2c)
 * ----------------------------------------------------------------
 * مرحلهٔ ۲ توپولوژی برای هر لینک می‌تواند پهنای باند اسمی و منبع سنجش
 * اینترفیس داشته باشد. این ماژول فقط لینک‌هایی را می‌خواند که صریحاً
 * `telemetry_enabled` دارند؛ هیچ اسکن خودکاری روی شبکه انجام نمی‌شود.
 *
 * اصول:
 *   • خروجی موتور مانیتورینگ (Ping) دست‌نخورده می‌ماند؛ این سنجش یک مسیر
 *     مستقل و اختیاری است و خطای آن هرگز روی پایش تجهیزات اثر نمی‌گذارد.
 *   • فقط آخرین مقدار در پایگاه‌داده نگه داشته می‌شود (بدون رشد نامحدود).
 *   • مقصد سنجش از همان allowlist پروب (`probe_allowed_cidrs`) عبور می‌کند.
 *   • community از متغیر محیطی خوانده می‌شود و در پایگاه‌داده/دیاگرام ذخیره
 *     نمی‌شود.
 */
import { db, getSettings } from './db.js';
import { isProbeTargetAllowed } from './net-policy.js';
import { logEvent } from './logger.mjs';
import { interfaceOids, snmpGet, SnmpError } from './snmp.js';
import { invalidateLiveCache } from './topology-live.js';

const CONCURRENCY = 4;
const MAX_RATE_BPS = 100 * 1000 * 1000 * 1000; // 100Gbps سقف واقع‌گرایانه برای فیلتر خطا

let timer = null;
let running = false;
let started = false;
let stopped = false;

function snmpConfig() {
  const rawPort = Number(process.env.NETWATCH_SNMP_PORT);
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : 161;
  const community = String(process.env.NETWATCH_SNMP_COMMUNITY || 'public').slice(0, 64) || 'public';
  const rawTimeout = Number(process.env.NETWATCH_SNMP_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) ? Math.min(10000, Math.max(200, rawTimeout)) : 2000;
  return { port, community, timeoutMs };
}

function intervalMs() {
  const raw = Number(process.env.NETWATCH_SNMP_INTERVAL_SEC);
  const sec = Number.isFinite(raw) && raw >= 5 ? Math.min(3600, raw) : 30;
  return sec * 1000;
}

function toBigInt(value) {
  if (value == null || value === '') return null;
  try {
    return BigInt(String(value));
  } catch {
    return null;
  }
}

function operStatus(value) {
  const n = Number(value);
  if (n === 1) return 'up';
  // down(2) و lowerLayerDown(7) یعنی مسیر/لایهٔ پایین در دسترس نیست.
  if (n === 2 || n === 7) return 'down';
  return 'unknown';
}

function upsertSuccess(link, values, { now, previous, capacityMbps }) {
  const previousIn = toBigInt(previous?.in_octets);
  const previousOut = toBigInt(previous?.out_octets);
  const countersAt = Number(previous?.counters_at) || null;
  const dtSec = countersAt ? (now - countersAt) / 1000 : 0;
  let rxBps = null;
  let txBps = null;
  let utilPct = null;

  if (previousIn != null && previousOut != null && dtSec >= 5 && dtSec <= 6 * 3600) {
    const deltaIn = values.inOctets >= previousIn ? values.inOctets - previousIn : null;
    const deltaOut = values.outOctets >= previousOut ? values.outOctets - previousOut : null;
    if (deltaIn != null && deltaOut != null && deltaIn < 10n ** 15n && deltaOut < 10n ** 15n) {
      const rateIn = (Number(deltaIn) * 8) / dtSec;
      const rateOut = (Number(deltaOut) * 8) / dtSec;
      if (rateIn <= MAX_RATE_BPS && rateOut <= MAX_RATE_BPS) {
        rxBps = Math.round(rateIn);
        txBps = Math.round(rateOut);
        if (capacityMbps) utilPct = Math.round((Math.max(rateIn, rateOut) / (capacityMbps * 1e6)) * 1000) / 10;
      }
    }
  }

  db.prepare(
    `INSERT INTO topology_link_telemetry(
       link_id, diagram_id, sampled_at, counters_at, in_octets, out_octets,
       rx_bps, tx_bps, util_pct, capacity_mbps, oper_status, source, error, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'snmp','',?)
     ON CONFLICT(link_id) DO UPDATE SET
       diagram_id=excluded.diagram_id, sampled_at=excluded.sampled_at, counters_at=excluded.counters_at,
       in_octets=excluded.in_octets, out_octets=excluded.out_octets, rx_bps=excluded.rx_bps,
       tx_bps=excluded.tx_bps, util_pct=excluded.util_pct, capacity_mbps=excluded.capacity_mbps,
       oper_status=excluded.oper_status, source='snmp', error='', updated_at=excluded.updated_at`
  ).run(
    link.id,
    link.diagram_id,
    now,
    now,
    values.inOctets.toString(),
    values.outOctets.toString(),
    rxBps,
    txBps,
    utilPct,
    capacityMbps ?? null,
    values.operStatus,
    now
  );

  return { rxBps, txBps, utilPct, operStatus: values.operStatus };
}

function recordError(link, error, now) {
  const exists = db.prepare('SELECT link_id FROM topology_link_telemetry WHERE link_id = ?').get(link.id);
  if (exists) {
    db.prepare('UPDATE topology_link_telemetry SET error = ?, updated_at = ? WHERE link_id = ?').run(
      String(error).slice(0, 400),
      now,
      link.id
    );
  } else {
    db.prepare(
      `INSERT INTO topology_link_telemetry(link_id, diagram_id, sampled_at, oper_status, source, error, updated_at)
       VALUES (?,?,?, 'unknown', 'snmp', ?, ?)`
    ).run(link.id, link.diagram_id, 0, String(error).slice(0, 400), now);
  }
}

/** لینک‌های دارای سنجش فعال همراه با IP پیش‌فرض یکی از دو سر */
function enabledLinks(diagramId = null) {
  const params = [];
  let clause = '';
  if (diagramId != null) {
    clause = ' AND l.diagram_id = ?';
    params.push(Number(diagramId));
  }
  return db
    .prepare(
      `SELECT l.id, l.diagram_id, l.telemetry_agent, l.telemetry_if_index, l.capacity_mbps,
              fd.ip AS from_ip, td.ip AS to_ip, md.ip AS monitor_ip
       FROM topology_links l
       JOIN topology_diagrams d ON d.id = l.diagram_id AND d.is_template = 0
       LEFT JOIN topology_nodes fn ON fn.id = l.from_node_id
       LEFT JOIN devices fd ON fd.id = fn.device_id
       LEFT JOIN topology_nodes tn ON tn.id = l.to_node_id
       LEFT JOIN devices td ON td.id = tn.device_id
       LEFT JOIN devices md ON md.id = l.monitor_device_id
       WHERE l.telemetry_enabled = 1${clause}
       ORDER BY l.id`
    )
    .all(...params);
}

/**
 * یک دور سنجش. خطای هر لینک مستقل ثبت می‌شود و بقیه ادامه می‌یابند.
 * @param {{diagramId?:number|null, now?:number}} options
 */
export async function pollLinkTelemetryOnce({ diagramId = null, now = Date.now() } = {}) {
  const links = enabledLinks(diagramId);
  if (!links.length) {
    return { checked: 0, ok: 0, failed: 0, skipped: 0, results: [] };
  }
  const settings = getSettings();
  const cfg = snmpConfig();
  const results = [];
  let ok = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < links.length; i += CONCURRENCY) {
    const batch = links.slice(i, i + CONCURRENCY);
    // اجرای موازی محدود؛ هر لینک مهلت مستقل دارد.
    const settled = await Promise.all(
      batch.map(async (link) => {
        const agent = String(link.telemetry_agent || link.monitor_ip || link.from_ip || link.to_ip || '').trim();
        const ifIndex = Number(link.telemetry_if_index);
        if (!agent) return { link, error: 'آدرس عامل SNMP تعیین نشده و تجهیزی هم روی دو سر لینک نیست.' };
        if (!Number.isInteger(ifIndex) || ifIndex <= 0) return { link, error: 'شمارهٔ اینترفیس SNMP تعیین نشده است.' };
        const policy = isProbeTargetAllowed(agent, settings);
        if (!policy.allowed) return { link, error: `مقصد سنجش مجاز نیست (${policy.reason}).` };
        const oids = interfaceOids(ifIndex);
        try {
          const response = await snmpGet({
            host: agent,
            port: cfg.port,
            community: cfg.community,
            timeoutMs: cfg.timeoutMs,
            oids: [oids.inOctets, oids.outOctets, oids.highSpeed, oids.operStatus],
          });
          const inOctets = response.values.get(oids.inOctets)?.value;
          const outOctets = response.values.get(oids.outOctets)?.value;
          const highSpeed = response.values.get(oids.highSpeed)?.value;
          const oper = response.values.get(oids.operStatus)?.value;
          if (inOctets == null || outOctets == null) {
            throw new SnmpError('SNMP_RESPONSE', 'شمارندهٔ ورودی/خروجی اینترفیس در پاسخ نبود.');
          }
          const previous = db.prepare('SELECT * FROM topology_link_telemetry WHERE link_id = ?').get(link.id) || null;
          const speedMbps = Number(highSpeed) > 0 ? Number(highSpeed) : null;
          const capacity = Number(link.capacity_mbps) > 0 ? Number(link.capacity_mbps) : speedMbps;
          const saved = upsertSuccess(
            link,
            {
              inOctets: BigInt(inOctets),
              outOctets: BigInt(outOctets),
              operStatus: operStatus(oper),
            },
            { now, previous, capacityMbps: capacity }
          );
          return { link, ...saved };
        } catch (error) {
          return { link, error: String(error?.message || error) };
        }
      })
    );

    for (const item of settled) {
      if (item.error) {
        failed += 1;
        recordError(item.link, item.error, now);
        results.push({ linkId: item.link.id, ok: false, error: item.error });
      } else {
        skipped += item.rxBps == null ? 1 : 0; // نخستین نمونه: مبنای شمارنده، بدون نرخ
        ok += 1;
        results.push({ linkId: item.link.id, ok: true, ...item });
      }
    }
  }

  invalidateLiveCache(diagramId);
  if (failed) logEvent('warn', 'topology_link_telemetry_failed', { checked: links.length, failed });
  return { checked: links.length, ok, failed, skipped, results };
}

/**
 * زمان‌بند سنجش. فقط نمونهٔ رهبر (یا نصب بدون موتور) اجرا می‌کند تا با چند
 * نمونهٔ سرور، هر اینترفیس چندبار خوانده نشود.
 */
export function startLinkTelemetry({ isLeader = () => true } = {}) {
  if (started) return;
  // در آزمون‌ها/استقرارهای خاص می‌توان زمان‌بند را کامل خاموش کرد؛ سنجش
  // دستی از مسیر API همچنان در دسترس است.
  if (String(process.env.NETWATCH_SNMP_DISABLE || '') === '1') {
    logEvent('info', 'topology_link_telemetry_disabled', { source: 'env' });
    return;
  }
  started = true;
  stopped = false;
  const every = intervalMs();
  const run = async () => {
    if (running || stopped) return;
    try {
      if (!isLeader()) return;
      const pending = db
        .prepare(
          `SELECT COUNT(*) AS c FROM topology_links l
           JOIN topology_diagrams d ON d.id = l.diagram_id AND d.is_template = 0
           WHERE l.telemetry_enabled = 1`
        )
        .get().c;
      if (!pending) return;
      running = true;
      const startedAt = Date.now();
      const stats = await pollLinkTelemetryOnce();
      logEvent('info', 'topology_link_telemetry_poll', { ...stats, results: undefined, durationMs: Date.now() - startedAt });
    } catch (e) {
      logEvent('warn', 'topology_link_telemetry_scheduler_error', { message: String(e?.message || e) });
    } finally {
      running = false;
    }
  };
  const initial = setTimeout(run, 4000);
  if (initial.unref) initial.unref();
  timer = setInterval(run, every);
  if (timer.unref) timer.unref();
  logEvent('info', 'topology_link_telemetry_started', { intervalSec: Math.round(every / 1000) });
}

export function stopLinkTelemetry() {
  stopped = true;
  started = false;
  if (timer) clearInterval(timer);
  timer = null;
}

