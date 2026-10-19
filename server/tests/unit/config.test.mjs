/**
 * آزمون منبع مرکزی پیکربندی:
 *   • پیش‌فرض‌ها همان مقادیر واقعی برنامه‌اند (HOST=127.0.0.1، PORT=8787).
 *   • مقدار حیاتی نامعتبر ⇒ خطا و جلوگیری از راه‌اندازی.
 *   • مقدار نامعتبر غیرحیاتی ⇒ خطای مشخص، نه سقوط بی‌صدا.
 *   • خلاصهٔ لاگ هیچ مقدار حساسی ندارد.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createConfig, configSummary, parseTrustProxy } from '../../config.js';

test('defaults match the documented production behavior', () => {
  const cfg = createConfig({}, { dev: false });
  assert.deepEqual(cfg.errors, []);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.port, 8787);
  assert.equal(cfg.engine.enabled, true);
  assert.equal(cfg.engine.lockTtlMs, 15000);
  assert.equal(cfg.shutdownTimeoutMs, 5000);
  assert.equal(cfg.stopDrainMs, 0, 'a plain stop cancels/fences immediately');
  assert.equal(cfg.probe.allowMetadata, false);
  assert.equal(cfg.probe.allowLinkLocal, false);
  assert.match(cfg.dbPath, /netwatch\.db$/);
  assert.equal(path.dirname(cfg.backupDir), cfg.dataDir);
  assert.equal(cfg.dev, false);
});

test('development uses the dev port unless PORT is explicit', () => {
  assert.equal(createConfig({}, { dev: true }).port, 3000);
  assert.equal(createConfig({ PORT: '9000' }, { dev: true }).port, 9000);
});

test('critical invalid settings are reported and stop unsafe startup', () => {
  const cfg = createConfig(
    {
      PORT: 'not-a-port',
      HOST: 'bad host!',
      NETWATCH_TRUST_PROXY: '${evil}',
      NETWATCH_PROBE_ALLOWED_CIDRS: '10.0.0.0/99',
      NETWATCH_TLS_CERT: '/tmp/only-cert.pem',
      NETWATCH_ENGINE_LOCK_TTL_MS: '10',
      NETWATCH_RATE_LIMIT_MAX: '0',
      NETWATCH_SHUTDOWN_TIMEOUT_MS: '-5',
    },
    { dev: false }
  );
  assert.ok(cfg.errors.length >= 8, `expected many errors, got: ${JSON.stringify(cfg.errors)}`);
  assert.ok(cfg.errors.some((e) => e.includes('PORT')));
  assert.ok(cfg.errors.some((e) => e.includes('HOST')));
  assert.ok(cfg.errors.some((e) => e.includes('NETWATCH_TRUST_PROXY')));
  assert.ok(cfg.errors.some((e) => e.includes('NETWATCH_PROBE_ALLOWED_CIDRS')));
  assert.ok(cfg.errors.some((e) => e.includes('NETWATCH_TLS_CERT')));
});

test('trust proxy accepts only explicit, validated forms', () => {
  const errors = [];
  assert.equal(parseTrustProxy(undefined, errors), null);
  assert.equal(parseTrustProxy('loopback', errors), 'loopback');
  assert.equal(parseTrustProxy('1', errors), 1);
  assert.equal(parseTrustProxy('10.0.0.0/8,192.168.1.1', errors), '10.0.0.0/8,192.168.1.1');
  assert.equal(errors.length, 0);
  assert.equal(parseTrustProxy('*', errors), null);
  assert.equal(parseTrustProxy('999.1.1.1', errors), null);
  assert.equal(errors.length, 2);
});

test('valid probe CIDRs are normalized and link-local stays opt-in', () => {
  const cfg = createConfig({ NETWATCH_PROBE_ALLOWED_CIDRS: '10.0.0.0/8, 192.168.0.0/16, 10.0.0.0/8' }, { dev: false });
  assert.deepEqual(cfg.errors, []);
  assert.deepEqual(cfg.probe.cidrs, ['10.0.0.0/8', '192.168.0.0/16']);
  assert.equal(cfg.probe.allowLinkLocal, false);
  assert.equal(createConfig({ NETWATCH_PROBE_ALLOW_LINK_LOCAL: '1' }, { dev: false }).probe.allowLinkLocal, true);
});

test('safe summary never contains secrets or key material', () => {
  const cfg = createConfig(
    {
      NETWATCH_ADMIN_PASSWORD: 'super-secret-password',
      NETWATCH_TLS_DIR: '/etc/netwatch/tls',
    },
    { dev: false }
  );
  const summary = JSON.stringify(configSummary(cfg));
  assert.equal(summary.includes('super-secret-password'), false);
  assert.equal(summary.includes('server.key'), false);
  assert.equal(summary.includes('PRIVATE KEY'), false);
  assert.match(summary, /127\.0\.0\.1/);
});
