/**
 * آزمون اجرای HTTPS کاملاً آفلاین:
 *   • اسکریپت `tls:setup` یک CA محلی و گواهی سرور با SAN درست می‌سازد
 *   • سرور با همان گواهی روی HTTPS بالا می‌آید و مرورگر/کلاینت با اعتماد به CA
 *     آن را معتبر می‌بیند (نه با دور زدن بررسی گواهی)
 *   • کوکی نشست Secure می‌شود، HSTS فرستاده می‌شود و ریدایرکت HTTP→HTTPS کار می‌کند
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { useTempDataDir, cleanupDir, freePort, waitFor, ROOT, TEST_ADMIN } from '../helpers.mjs';

const opensslAvailable = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;

function httpsRequest(port, pathname, { ca, headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        ca,
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function httpGet(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
  });
}

test('tls:setup creates a local CA and a server cert with the requested SANs', { skip: !opensslAvailable }, () => {
  const tlsDir = useTempDataDir('tls-cert');
  try {
    const res = spawnSync(
      process.execPath,
      ['server/scripts/tls-setup.mjs', '--out', tlsDir, '192.168.50.10', 'netwatch.local'],
      { cwd: ROOT, encoding: 'utf8' }
    );
    assert.equal(res.status, 0, `tls-setup failed:\n${res.stdout}\n${res.stderr}`);

    for (const f of ['ca.crt', 'ca.key', 'server.crt', 'server.key']) {
      assert.ok(fs.existsSync(path.join(tlsDir, f)), `${f} must be created`);
    }
    if (process.platform !== 'win32') {
      for (const f of ['ca.key', 'server.key']) {
        const mode = fs.statSync(path.join(tlsDir, f)).mode & 0o777;
        assert.equal(mode, 0o600, `${f} must be readable only by its owner (mode=${mode.toString(8)})`);
      }
    }

    const text = spawnSync('openssl', ['x509', '-in', path.join(tlsDir, 'server.crt'), '-noout', '-text'], {
      encoding: 'utf8',
    }).stdout;
    assert.match(text, /DNS:localhost/);
    assert.match(text, /IP Address:127\.0\.0\.1/);
    assert.match(text, /IP Address:192\.168\.50\.10/);
    assert.match(text, /DNS:netwatch\.local/);
    assert.match(text, /Extended Key Usage.*TLS Web Server Authentication/s);

    const verify = spawnSync('openssl', ['verify', '-CAfile', path.join(tlsDir, 'ca.crt'), path.join(tlsDir, 'server.crt')], {
      encoding: 'utf8',
    });
    assert.equal(verify.status, 0, `server cert must chain to the local CA:\n${verify.stdout}${verify.stderr}`);

    // بدون --force، اجرای دوباره نباید گواهی‌های موجود را بی‌صدا بازنویسی کند
    const again = spawnSync(process.execPath, ['server/scripts/tls-setup.mjs', '--out', tlsDir], { cwd: ROOT, encoding: 'utf8' });
    assert.notEqual(again.status, 0);
    assert.match(again.stderr + again.stdout, /--force/);

    // تمدید با --force باید CA را دست‌نخورده نگه دارد تا اعتماد کلاینت‌ها باطل نشود
    const caFingerprint = () =>
      spawnSync('openssl', ['x509', '-in', path.join(tlsDir, 'ca.crt'), '-noout', '-fingerprint', '-sha256'], {
        encoding: 'utf8',
      }).stdout.trim();
    const before = caFingerprint();
    const renew = spawnSync(
      process.execPath,
      ['server/scripts/tls-setup.mjs', '--out', tlsDir, '--force', '192.168.50.10', 'netwatch.local'],
      { cwd: ROOT, encoding: 'utf8' }
    );
    assert.equal(renew.status, 0, `renewal failed:\n${renew.stdout}\n${renew.stderr}`);
    assert.equal(caFingerprint(), before, '--force must reuse the existing CA');
    assert.equal(
      spawnSync('openssl', ['verify', '-CAfile', path.join(tlsDir, 'ca.crt'), path.join(tlsDir, 'server.crt')], { encoding: 'utf8' }).status,
      0
    );

    // و --new-ca مرجع صدور را عوض می‌کند (کلاینت‌ها باید ca.crt جدید را وارد کنند)
    const brandNew = spawnSync(
      process.execPath,
      ['server/scripts/tls-setup.mjs', '--out', tlsDir, '--new-ca', '192.168.50.10', 'netwatch.local'],
      { cwd: ROOT, encoding: 'utf8' }
    );
    assert.equal(brandNew.status, 0, `--new-ca failed:\n${brandNew.stdout}\n${brandNew.stderr}`);
    assert.notEqual(caFingerprint(), before);
  } finally {
    cleanupDir(tlsDir);
  }
});

test('the server serves authenticated traffic over HTTPS and redirects plain HTTP', { skip: !opensslAvailable }, async () => {
  const dir = useTempDataDir('tls-server');
  const tlsDir = useTempDataDir('tls-server-certs');
  const port = await freePort();
  const httpPort = await freePort();

  const gen = spawnSync(
    process.execPath,
    ['server/scripts/tls-setup.mjs', '--out', tlsDir, 'localhost', '127.0.0.1'],
    { cwd: ROOT, encoding: 'utf8' }
  );
  assert.equal(gen.status, 0, `tls-setup failed:\n${gen.stdout}\n${gen.stderr}`);
  // گواهی سرور فقط با همین CA محلی معتبر است؛ تست با اعتماد به همان CA وصل می‌شود
  const caPem = fs.readFileSync(path.join(tlsDir, 'ca.crt'));

  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NETWATCH_DATA_DIR: dir,
      PORT: String(port),
      NETWATCH_HTTP_PORT: String(httpPort),
      NETWATCH_TLS_DIR: tlsDir,
      NETWATCH_ENGINE: '0',
      NETWATCH_ADMIN_USER: TEST_ADMIN.username,
      NETWATCH_ADMIN_PASSWORD: TEST_ADMIN.password,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => (logs += d.toString()));
  child.stderr.on('data', (d) => (logs += d.toString()));

  try {
    const up = await waitFor(
      async () => {
        try {
          const res = await httpsRequest(port, '/api/health', { ca: caPem });
          return res.status === 200;
        } catch {
          return false;
        }
      },
      { timeout: 20000, interval: 200 }
    );
    assert.ok(up, `HTTPS server did not start:\n${logs}`);

    // گواهی با CA محلی معتبر است (بدون rejectUnauthorized:false)
    const health = await httpsRequest(port, '/api/health', { ca: caPem });
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).ok, true);
    assert.equal(JSON.parse(health.body).db, undefined, 'public health must stay minimal over TLS too');
    assert.match(String(health.headers['strict-transport-security']), /max-age=\d+/);

    // صفحهٔ SPA از همان مسیر امن سرو می‌شود
    const root = await httpsRequest(port, '/', { ca: caPem });
    assert.equal(root.status, 200);
    assert.match(root.body, /<div id="root">/);

    // ورود: کوکی نشست باید Secure باشد (فقط روی HTTPS فرستاده می‌شود)
    const loginBody = JSON.stringify(TEST_ADMIN);
    const login = await httpsRequest(port, '/api/auth/login', {
      ca: caPem,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: `https://127.0.0.1:${port}`,
        'content-length': Buffer.byteLength(loginBody),
      },
      body: loginBody,
    });
    assert.equal(login.status, 200, login.body);
    const cookies = [].concat(login.headers['set-cookie'] || []);
    const session = cookies.find((c) => c.startsWith('nw_session='));
    assert.ok(session, 'session cookie expected');
    assert.match(session, /; Secure/);
    assert.match(session, /HttpOnly/);
    assert.match(session, /SameSite=Strict/);

    const csrf = cookies.find((c) => c.startsWith('nw_csrf='))?.split(';')[0];
    const devices = await httpsRequest(port, '/api/devices', {
      ca: caPem,
      headers: { cookie: [session.split(';')[0], csrf].filter(Boolean).join('; ') },
    });
    assert.equal(devices.status, 200);

    // بدون کوکی، API همچنان ۴۰۱ می‌دهد (HTTPS جایگزین احراز هویت نیست)
    const anonymous = await httpsRequest(port, '/api/devices', { ca: caPem });
    assert.equal(anonymous.status, 401);

    // ریدایرکت HTTP → HTTPS
    const redirect = await httpGet(httpPort, '/health', { host: `netwatch.local:${httpPort}` });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.location, `https://netwatch.local:${port}/health`);
    assert.match(String(redirect.headers['cache-control']), /no-store/);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    cleanupDir(dir);
    cleanupDir(tlsDir);
  }
});
