# نصب و راه‌اندازی NetWatch

این سند از پیش‌نیازها تا یک نصب تولیدی سالم را گام‌به‌گام توضیح می‌دهد. برای
آشنایی با برنامه ابتدا [معرفی](01-introduction.md) را ببینید. دستورها برای
لینوکس/Bash نوشته شده‌اند؛ در ویندوز از Git Bash یا معادل PowerShell استفاده کنید.

---

## ۱. پیش‌نیازها

| مورد | حداقل | توصیه | توضیح |
| --- | --- | --- | --- |
| Node.js | `22.12.0` | ۲۴ LTS | `node:sqlite` داخلی؛ بدون کامپایل بومی |
| سیستم‌عامل | لینوکس | Ubuntu 24.04 | برای حالت ICMP به `CAP_NET_RAW` نیاز است |
| RAM | ۵۱۲MB | ۱GB+ | برای ۱٬۰۰۰ تجهیز و داشبورد |
| دیسک | ۲GB آزاد | ۵GB+ | پایگاه‌داده، WAL، پشتیبان و MBTiles |
| ابزار ICMP | `iputils-ping` | — | برای حالت `icmp`؛ در غیر این صورت TCP |
| OpenSSL | نسخهٔ سیستم | — | فقط برای `npm run tls:setup` |
| زمان | همگام با NTP | — | ساعت نادرست باعث ناسازگاری بازه‌ها می‌شود |
| شبکه | دسترسی خروجی به تجهیزات | — | ICMP یا TCP به مقاصد مجاز |

بررسی نسخه:

```bash
node -v      # باید >= v22.12.0 باشد
npm -v
```

نصب ابزار ICMP (در صورت نیاز):

```bash
sudo apt-get update
sudo apt-get install -y iputils-ping
```

> اگر `ping` در دسترس نباشد یا مجوز سوکت خام وجود نداشته باشد، حالت `auto`
> خودکار به TCP می‌رود. این وضعیت در `/api/engine/status` و صفحهٔ «سلامت برنامه»
> دیده می‌شود.

---

## ۲. اجرای سریع روی لپ‌تاپ (توسعه/ارزیابی)

```bash
git clone https://github.com/wmp144-ctrl/Freebuff_2.git
cd Freebuff_2
npm ci                 # نصب دقیق بر پایهٔ package-lock.json
npm run build          # ساخت رابط در web/dist
npm start              # اجرای کامل روی http://localhost:8787
```

در نخستین اجرا:

- اگر پایگاه‌داده خالی باشد، به‌طور پیش‌فرض **دادهٔ نمایشی** بارگذاری می‌شود
  (`NETWATCH_SEED_DEMO=1`).
- یک حساب مدیر ساخته می‌شود. رمز را از قبل بدهید:

```bash
NETWATCH_ADMIN_PASSWORD='یک-رمز-قوی-و-یکتا' npm start
```

یا بدون تعیین رمز، برنامه یک رمز تصادفی می‌سازد و در فایل زیر می‌نویسد:

```bash
cat data/initial-admin-password.txt   # خط ۱ نام کاربری، خط ۲ رمز
```

سپس `http://localhost:8787` را باز کنید. این فایل پس از نخستین ورود موفق مدیر
حذف می‌شود.

### حالت توسعه

```bash
npm run dev        # Node + Vite middleware روی پورت 3000
```

`npm run dev` یک سرور واحد با API و HMR است. `npm run dev:web` فقط Vite مستقل
روی پورت 3000 است و **پروکسی API ندارد**؛ برای توسعهٔ کامل از `npm run dev`
استفاده کنید.

### خاموش‌کردن موتور

```bash
NETWATCH_ENGINE=0 npm start
```

برای اجرای مستقل موتور:

```bash
npm run engine              # اجرای دائمی
npm run engine -- --once    # یک چرخه و خروج (مناسب Cron)
```

---

## ۳. نصب تولیدی با systemd

### ۳.۱. کاربر و مسیرها

```bash
sudo useradd --system --home /opt/netwatch --shell /usr/sbin/nologin netwatch
sudo install -d -o netwatch -g netwatch -m 750 /opt/netwatch /var/lib/netwatch
sudo install -d -m 700 /etc/netwatch
```

### ۳.۲. کپی کد و نصب وابستگی‌ها

```bash
sudo -u netwatch tar -xzf netwatch-1.2.0.tar.gz -C /opt/netwatch --strip-components=1
cd /opt/netwatch

# گزینهٔ الف (توصیه‌شده): نصب کامل، Build، سپس حذف devDependencies
sudo -u netwatch npm ci
sudo -u netwatch npm run build
sudo -u netwatch npm prune --omit=dev

# گزینهٔ ب: اگر web/dist آماده دارید
sudo -u netwatch npm ci --omit=dev
sudo -u netwatch tar -xzf netwatch-web-1.2.0.tar.gz -C web/dist
```

> **نکتهٔ مهم:** `vite` و `typescript` در `devDependencies` هستند. اگر
> `npm ci --omit=dev` بزنید و `web/dist` از قبل وجود نداشته باشد، `npm run build`
> شکست می‌خورد. برای Build روی سرور، ابتدا وابستگی‌های کامل را نصب کنید یا از
> Artifact آمادهٔ `netwatch-web-*.tar.gz` استفاده کنید.

### ۳.۳. فایل محیطی

```bash
sudo cp .env.example /etc/netwatch/netwatch.env
sudo chmod 600 /etc/netwatch/netwatch.env
sudo editor /etc/netwatch/netwatch.env
```

حداقل تنظیمات تولیدی:

```ini
HOST=0.0.0.0
PORT=8787
NETWATCH_DATA_DIR=/var/lib/netwatch
NETWATCH_ADMIN_USER=admin
NETWATCH_ADMIN_PASSWORD=<رمز-قوی-و-یکتا>
NETWATCH_ADMIN_ALLOWED_CIDRS=10.0.0.0/8,192.168.10.0/24
NETWATCH_TRUST_PROXY=loopback
NETWATCH_SEED_DEMO=0
```

| کلید | چرا مهم است |
| --- | --- |
| `NETWATCH_ADMIN_PASSWORD` | فقط در نخستین اجرا؛ اگر نباشد رمز تصادفی ساخته می‌شود |
| `NETWATCH_ADMIN_ALLOWED_CIDRS` | APIهای مدیریتی را به شبکهٔ مدیریت محدود می‌کند |
| `NETWATCH_SEED_DEMO=0` | دادهٔ نمایشی با تجهیزات واقعی قاطی نشود |
| `NETWATCH_TRUST_PROXY` | فقط اگر پشت پروکسی معکوس هستید |

> `NETWATCH_ADMIN_PASSWORD` باید سیاست رمز را رعایت کند: حداقل ۱۲ نویسه و
> حداقل سه دسته از چهار دسته، یا عبارت حداقل ۲۰ نویسه‌ای.

### ۳.۴. سرویس systemd

```bash
sudo cp deploy/netwatch.service /etc/systemd/system/netwatch.service
sudo systemctl daemon-reload
sudo systemctl enable --now netwatch
systemctl status netwatch --no-pager
```

واحد نمونه شامل سخت‌سازی است: `ProtectSystem=strict`، `PrivateTmp`،
`NoNewPrivileges`، `ReadWritePaths=/var/lib/netwatch` و `UMask=0077`.

برای ICMP واقعی، در فایل واحد این خطوط را از کامنت خارج کنید:

```ini
CapabilityBoundingSet=CAP_NET_RAW
AmbientCapabilities=CAP_NET_RAW
NoNewPrivileges=false
```

سپس:

```bash
sudo systemctl daemon-reload
sudo systemctl restart netwatch
```

### ۳.۵. بررسی مجوزها

| مسیر | مالک | مجوز |
| --- | --- | --- |
| `/etc/netwatch/netwatch.env` | root | `600` |
| `/etc/netwatch/tls/server.key` | root/netwatch | `600` |
| `/var/lib/netwatch` | netwatch | `750` |
| `/var/lib/netwatch/netwatch.db` | netwatch | `600` |
| `/var/lib/netwatch/backups` | netwatch | `750` |

```bash
namei -l /var/lib/netwatch/netwatch.db
sudo -u netwatch test -w /var/lib/netwatch && echo writable
```

---

## ۴. بررسی پس از نصب

سلامت عمومی (بدون ورود) فقط سه فیلد برمی‌گرداند:

```bash
curl -fsS http://127.0.0.1:8787/api/health
```

```json
{"ok":true,"status":"ok","ts":1792522000000}
```

ورود و بررسی سلامت تفصیلی:

```bash
curl -fsS -c /tmp/nw.jar \
  -H 'content-type: application/json' \
  -H 'origin: http://127.0.0.1:8787' \
  -d '{"username":"admin","password":"<رمز>"}' \
  http://127.0.0.1:8787/api/auth/login

curl -fsS -b /tmp/nw.jar http://127.0.0.1:8787/api/system/health
```

بررسی پایگاه‌داده:

```bash
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch npm run db:doctor
```

انتظار می‌رود:

- `db.doctor` با `"ok": true` و `schemaVersion` برابر `5` تمام شود؛
- `foreignKeyViolations` صفر باشد؛
- `journalMode` برابر `wal` باشد.

پشتیبان اولیه:

```bash
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch npm run db:backup
```

خروجی باید `"ok": true` و `"errors": []` بدهد و یک پوشه در
`/var/lib/netwatch/backups/netwatch-YYYYMMDD-HHMMSS-xxxxxx` بسازد.

### چک‌لیست پذیرش نصب

- [ ] `node -v` ≥ `22.12`
- [ ] `npm ci` و `npm run build` بدون خطا
- [ ] فایل محیطی با مجوز `600`
- [ ] `NETWATCH_SEED_DEMO=0` در نصب واقعی
- [ ] `systemctl enable netwatch`
- [ ] `/api/health` پاسخ `200` و `ok:true`
- [ ] `db:doctor` سالم
- [ ] `db:backup` موفق و پشتیبان به مقصد جداگانه کپی شده
- [ ] TLS/پروکسی کار می‌کند و کوکی `Secure` است
- [ ] داشبورد و «سلامت برنامه» داده نشان می‌دهند

---

## ۵. HTTPS بدون اینترنت

### ۵.۱. ساخت گواهی محلی

```bash
npm run tls:setup -- 192.168.10.20 netwatch.local
```

- همهٔ IP/نام‌هایی را بنویسید که کاربران در نوار آدرس تایپ می‌کنند؛ همان‌ها در
  SAN قرار می‌گیرند.
- خروجی در `data/tls/`:

| فایل | کاربرد |
| --- | --- |
| `ca.crt` | گواهی مرجع؛ روی کلاینت‌ها نصب شود |
| `ca.key` | کلید CA؛ **فقط روی سرور و محرمانه** |
| `server.crt` | گواهی سرور |
| `server.key` | کلید سرور (`600`) |

### ۵.۲. اعتماد کلاینت‌ها

بدون نصب `ca.crt`، مرورگر هشدار گواهی نشان می‌دهد (سرویس کار می‌کند، اما
اعتماد برقرار نیست).

| سیستم | روش |
| --- | --- |
| ویندوز | `certmgr.msc` → Trusted Root → Import |
| لینوکس | `cp ca.crt /usr/local/share/ca-certificates/netwatch.crt && sudo update-ca-certificates` |
| فایرفاکس | Settings → Privacy & Security → Certificates → Authorities → Import |
| اندروید | Settings → Security → Encryption & credentials → Install a certificate → CA |
| iOS | انتقال فایل → Settings → General → VPN & Device Management → نصب و Trust |

### ۵.۳. اجرا

```bash
NETWATCH_TLS_DIR=data/tls npm start
NETWATCH_TLS_DIR=data/tls NETWATCH_HTTP_PORT=80 npm start   # ریدایرکت 308
sudo PORT=443 NETWATCH_TLS_DIR=data/tls npm start
```

- با TLS فعال، هدر HSTS (پیش‌فرض `max-age=15552000`) و کوکی `Secure` فعال
  می‌شوند. با `NETWATCH_HSTS=0` می‌توان HSTS را خاموش کرد.
- `NETWATCH_HTTP_PORT` یک شنوندهٔ HTTP فقط برای ریدایرکت به HTTPS باز می‌کند.

### ۵.۴. تمدید و چرخش

```bash
npm run tls:setup -- --force 192.168.10.20 netwatch.local   # CA ثابت می‌ماند
npm run tls:setup -- --new-ca 192.168.10.20 netwatch.local  # CA عوض می‌شود
```

با `--force` گواهی سرور تازه می‌شود و `ca.crt` قبلی معتبر می‌ماند. با `--new-ca`
باید `ca.crt` جدید روی همهٔ کلاینت‌ها نصب شود.

---

## ۶. پروکسی معکوس (Nginx)

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/netwatch
sudo ln -s /etc/nginx/sites-available/netwatch /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

نکته‌های نمونهٔ آماده:

- `proxy_buffering off` و `proxy_read_timeout 1h` برای SSE؛
- `client_max_body_size 1g` هم‌خوان با سقف MBTiles؛
- مسدودکردن `data/`، `server/`، `web/src/` و `node_modules/`؛
- هدرهای امنیتی در مرز TLS.

در این حالت در NetWatch تنظیم کنید:

```ini
HOST=127.0.0.1
NETWATCH_TRUST_PROXY=loopback
```

پروکسی باید `Host`، `X-Forwarded-For` و `X-Forwarded-Proto` را بفرستد.

---

## ۷. نصب آفلاین

1. روی سیستمی با اینترنت: `npm ci` و `npm run build` را اجرا کنید؛
2. کل پوشه (شامل `node_modules` و `web/dist`) یا Artifactهای رسمی را منتقل
   کنید؛
3. روی سرور آفلاین `npm start` بزنید.

هیچ وابستگی اینترنتی در زمان اجرا وجود ندارد. برای نصب بسته‌های سیستمی
(`iputils-ping`، `openssl`) از مخزن آفلاین/بستهٔ آمادهٔ توزیع استفاده کنید.

> در نصب کاملاً خالی با `NETWATCH_SEED_DEMO=0`، **ابتدا سرور را یک بار اجرا
> کنید** تا پایگاه‌داده و جدول‌ها ساخته شوند؛ سپس در صورت نیاز `engine-cli` را
> جداگانه اجرا کنید. `engine-cli` پرچم Seed را از `config.js` نمی‌خواند و
> `seedIfEmpty()` را مستقیم صدا می‌زند (جزئیات در
> [Changelog](17-changelog.md)).

---

## ۸. خطاهای رایج نصب

| نشانه | علت احتمالی | اقدام |
| --- | --- | --- |
| `ConfigError: پیکربندی نامعتبر است` | `HOST`/`PORT`/CIDR/TLS/نرخ نامعتبر | پیام دقیق را بخوانید و env را اصلاح کنید |
| `EADDRINUSE` | پورت اشغال است | `ss -ltnp \| grep 8787` |
| `EACCES` روی `data/` | مالکیت اشتباه | `chown -R netwatch:netwatch /var/lib/netwatch` |
| `npm run build` شکست می‌خورد | نبود `vite` (نصب `--omit=dev`) | نصب کامل یا استفاده از `web/dist` آماده |
| `پایگاه‌داده آسیب دیده است` | فایل/WAL خراب | [عیب‌یابی](13-troubleshooting.md) و [بازیابی](11-backup-restore.md) |
| مرورگر هشدار گواهی می‌دهد | `ca.crt` نصب نشده | [بخش HTTPS](#۵-https-بدون-اینترنت) |
| صفحه ۵۰۳ «نسخه تولیدی ساخته نشده» | `web/dist` وجود ندارد | `npm run build` یا `npm run dev` |

---

## ۹. مطالب مرتبط

- [پیکربندی](04-configuration.md)
- [عملیات](10-operations.md)
- [پشتیبان‌گیری](11-backup-restore.md)
- [ارتقا](15-upgrade-release.md)
- [عیب‌یابی](13-troubleshooting.md)
