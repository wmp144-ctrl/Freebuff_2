/**
 * آزمون پیکربندی استقرار
 * ----------------------------------------------------------------
 * فایل‌های `deploy/` بخشی از Artifact تولیدی‌اند؛ اگر کسی گزینهٔ امنیتی را
 * حذف کند یا مسیر اجرا را بشکند، هیچ آزمون رفتاری آن را نمی‌گیرد. این آزمون
 * ایستا (بدون systemd/root) تضمین می‌کند:
 *   • واحد systemd سرویس را پس از بوت فعال می‌کند و در خطا دوباره راه می‌اندازد.
 *   • سخت‌سازی (NoNewPrivileges، ProtectSystem، محدودیت نوشتن) حفظ شده است.
 *   • Nginx بافر SSE را خاموش و هدرهای امنیتی/TLS را تنظیم می‌کند.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../helpers.mjs';

const unit = fs.readFileSync(path.join(ROOT, 'deploy', 'netwatch.service'), 'utf8');
const nginx = fs.readFileSync(path.join(ROOT, 'deploy', 'nginx.conf.example'), 'utf8');

test('systemd unit starts automatically after boot and restarts on failure', () => {
  assert.match(unit, /^\[Unit\]$/m);
  assert.match(unit, /^After=network-online\.target$/m);
  assert.match(unit, /^WantedBy=multi-user\.target$/m, 'enable در بوت باید ممکن باشد');
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node server\/index\.js$/m);
  assert.match(unit, /^Environment=NODE_ENV=production$/m);
  assert.match(unit, /^EnvironmentFile=-\/etc\/netwatch\/netwatch\.env$/m);
  assert.match(unit, /^User=netwatch$/m);
  assert.match(unit, /^WorkingDirectory=\/opt\/netwatch$/m);
});

test('systemd unit keeps its sandbox and write-scope hardening', () => {
  for (const directive of [
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'ProtectSystem=strict',
    'ProtectHome=true',
    'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX',
    'ReadWritePaths=/var/lib/netwatch',
    'UMask=0077',
  ]) {
    assert.ok(unit.includes(directive), `گزینهٔ ${directive} باید حفظ شود`);
  }
  // قابلیت ICMP فقط به‌صورت کامنت (اختیاری) ارائه می‌شود.
  assert.match(unit, /^# CapabilityBoundingSet=CAP_NET_RAW$/m);
  // مسیر دادهٔ قابل‌نوشتن نباید کل سیستم‌فایل باشد.
  assert.equal(/ReadWritePaths=\/(\s|$)/.test(unit), false, 'ReadWritePaths=/ ممنوع است');
});

test('nginx example keeps SSE unbuffered, TLS and security headers', () => {
  assert.match(nginx, /proxy_buffering\s+off;/, 'SSE بدون خاموش‌کردن بافر کار نمی‌کند');
  assert.match(nginx, /proxy_read_timeout\s+\d+[smh];/);
  assert.match(nginx, /ssl_certificate\s+/);
  assert.match(nginx, /ssl_protocols\s+TLSv1\.2 TLSv1\.3;/);
  assert.match(nginx, /add_header X-Content-Type-Options\s+"?nosniff"?/);
  assert.match(nginx, /add_header X-Frame-Options\s+"?DENY"?/);
  // مسیر داده/پشتیبان هرگز نباید از وب سرو شود.
  assert.equal(/location[^{]*\/(data|backups)\b/.test(nginx), false);
});
