# راهنمای نصب، انتشار و بازگشت — NetWatch 1.1.0

این سند دستورهای عملیاتی نصب، پیکربندی، Start/Stop/Restart، Backup، Restore،
ارتقا و Rollback را جمع می‌کند. همهٔ دستورها روی Linux و با کاربر غیرروت
(`netwatch`) اجرا می‌شوند.

---

## ۱. پیش‌نیازها

| مورد | حداقل | تست‌شده |
| --- | --- | --- |
| Node.js | 22.12 | 24.21.0 |
| npm | همراه Node | 11.19.0 |
| RAM | 1GB (۱۰۰ تجهیز) | 3.9GB |
| دیسک | 2GB + فضای داده | 16GB |
| سیستم | Linux با systemd (توصیه) | Linux |

نصب ICMP واقعی (اختیاری):

```bash
sudo setcap cap_net_raw+ep "$(command -v ping)"
# یا اجرای سرویس با CAP_NET_RAW در unit
```

---

## ۲. نصب تمیز

```bash
git clone <repo> /opt/netwatch
cd /opt/netwatch
npm ci
npm run build
```

`npm ci` فقط از `package-lock.json` نصب می‌کند و lockfile را تغییر نمی‌دهد.
برای اجرای آزمون نصب:

```bash
npm run typecheck
npm run build
npm run verify
```

### پیکربندی

```bash
sudo install -d -o netwatch -g netwatch /etc/netwatch /var/lib/netwatch
sudo install -m 600 .env.example /etc/netwatch/netwatch.env
sudo -u netwatch mkdir -p /var/lib/netwatch
```

حداقل متغیرهای ضروری:

```bash
NETWATCH_DATA_DIR=/var/lib/netwatch
HOST=0.0.0.0
PORT=3000
NETWATCH_ADMIN_USER=admin
NETWATCH_ADMIN_PASSWORD=<رمز-قوی-حداقل-۸-نویسه>
NETWATCH_ENGINE_MODE=auto
```

برای TLS داخلی: `npm run tls:setup -- 192.168.10.20 netwatch.local` و
`NETWATCH_TLS_CERT`/`NETWATCH_TLS_KEY`. پشت Nginx از
`deploy/nginx.conf.example` و `NETWATCH_TRUST_PROXY=loopback` استفاده کنید.

رمز اولیه در `data/initial-admin-password.txt` (فقط اگر رمز از قبل تعیین نشده
باشد) ذخیره می‌شود؛ بلافاصله پس از اولین ورود آن را تغییر دهید و فایل را حذف کنید.

---

## ۳. Start / Stop / Restart

### systemd (توصیه‌شده)

```bash
sudo cp deploy/netwatch.service /etc/systemd/system/netwatch.service
sudo systemctl daemon-reload
sudo systemctl enable --now netwatch

sudo systemctl status netwatch
sudo systemctl restart netwatch
sudo systemctl stop netwatch
```

`deploy/netwatch.service` محیط را از `/etc/netwatch/netwatch.env` می‌خواند،
`ReadWritePaths` را به پوشهٔ داده محدود می‌کند و `SIGTERM` را برای خاموشی
مرتب می‌فرستد.

### اجرای مستقیم

```bash
# foreground
set -a; . /etc/netwatch/netwatch.env; set +a
node server/index.js

# پس‌زمینه با لاگ
nohup node server/index.js > /var/log/netwatch.log 2>&1 &
echo $! > /var/lib/netwatch/netwatch.pid

kill -TERM "$(cat /var/lib/netwatch/netwatch.pid)"
```

بررسی سلامت:

```bash
curl -fsS http://127.0.0.1:3000/api/health
```

خروجی مورد انتظار: `{"ok":true,"status":"ok","ts":...}`.
خاموشی مرتب با `SIGTERM` باید کد خروج `0` بدهد (تست‌شده).

---

## ۴. Backup

### دستی

```bash
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch \
  npm run db:backup
```

خروجی JSON شامل نام مجموعه، تعداد رکوردها، حجم و نتیجهٔ اعتبارسنجی است.
فایل‌ها در `<DATA_DIR>/backups/netwatch-YYYYMMDD-HHMMSS-xxxxxx/` قرار می‌گیرند:
`netwatch.db`، `manifest.json`، و در صورت وجود، فایل‌های MBTiles.

### زمان‌بندی خودکار

پشتیبان‌گیری داخلی هر ۲۴ ساعت (قابل تنظیم با `NETWATCH_BACKUP_INTERVAL_HOURS`)
و نگهداری ۷ نسخهٔ آخر اجرا می‌شود. برای Cron بیرونی:

```cron
15 3 * * * netwatch cd /opt/netwatch && NETWATCH_DATA_DIR=/var/lib/netwatch npm run db:backup >> /var/log/netwatch-backup.log 2>&1
```

### Verify / Prune

```bash
sudo -u netwatch npm run db:doctor
# یا از API مدیریتی:
curl -X POST .../api/system/backups/verify -d '{"name":"netwatch-..."}'
curl -X POST .../api/system/backups/prune -d '{"keep":14}'
```

---

## ۵. Restore

**قبل از بازیابی سرویس را متوقف کنید** تا نوشتن هم‌زمان رخ ندهد:

```bash
sudo systemctl stop netwatch
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch \
  npm run db:restore -- /var/lib/netwatch/backups/netwatch-20261019-040516-5cc931
sudo systemctl start netwatch
curl -fsS http://127.0.0.1:3000/api/health
```

- `--dry-run` فقط اعتبارسنجی می‌کند.
- `--no-mbtiles` فایل‌های نقشه را بازیابی نمی‌کند.
- پیش از جای‌گذاری، از دادهٔ فعلی یک نسخهٔ ایمنی
  `netwatch.db.pre-restore-<ts>` ساخته می‌شود.
- Checksum، `integrity_check`، `foreign_key_check` و وجود جدول‌ها پیش از
  بازیابی بررسی می‌شوند؛ پشتیبان دست‌کاری‌شده رد می‌شود.

### بازیابی از API (Admin)

```bash
POST /api/system/backups/restore
{ "name": "netwatch-...", "dryRun": false, "restoreMbtiles": true }
```

موتور به‌طور خودکار متوقف و پس از بازیابی دوباره راه‌اندازی می‌شود.

---

## ۶. ارتقا و انتشار

### گام ۱ — آماده‌سازی نقطهٔ بازگشت (Pre-release)

```bash
cd /opt/netwatch
git fetch --all
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch npm run release:prepare
```

این دستور:

1. از داده و MBTiles پشتیبان WAL-سازگار می‌سازد و اعتبارسنجی می‌کند.
2. از کد کامیت فعلی یک آرشیو `source-<commit>.tar.gz` در
   `<DATA_DIR>/releases/<version>-<timestamp>/` می‌سازد.
3. `release.json` با SHA-256 آرشیو، نسخه، کامیت و دستورهای Rollback می‌نویسد.

> اگر working tree تمیز نباشد، آرشیو فقط کامیت `HEAD` را شامل می‌شود. پیش از
> انتشار واقعی، تغییرات را commit کنید تا نقطهٔ بازگشت دقیق باشد.

### گام ۲ — نصب نسخهٔ جدید

```bash
sudo systemctl stop netwatch
git checkout <new-commit-or-tag>
npm ci
npm run build
npm run verify
sudo systemctl start netwatch
curl -fsS http://127.0.0.1:3000/api/health
```

### گام ۳ — تأیید پس از انتشار

```bash
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS -b cookies.txt http://127.0.0.1:3000/api/status
npm run db:doctor
```

حداقل ۳۰ دقیقه `/api/health` و لاگ سرویس را پایش کنید؛ سپس پایش ۷۲ ساعته را
طبق `qa-acceptance-report.md` کامل کنید.

---

## ۷. Rollback (آزمایش‌شده)

### داده

```bash
sudo systemctl stop netwatch
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch \
  npm run db:restore -- /var/lib/netwatch/backups/<pre-release-backup> --force
```

### کد

```bash
sudo -u netwatch git checkout <previous-commit>
sudo -u netwatch npm ci
sudo -u netwatch npm run build
sudo systemctl start netwatch
curl -fsS http://127.0.0.1:3000/api/health
```

اگر کد از آرشیو `release.json` می‌آید:

```bash
tar -xzf /var/lib/netwatch/releases/<release>/source-<commit>.tar.gz -C /opt/netwatch-old
ln -s /opt/netwatch/node_modules /opt/netwatch-old/node_modules
cd /opt/netwatch-old && npm run build
```

**نتیجهٔ آزمون Rollback در این دوره:** پشتیبان پیش از انتشار با ۴۷ تجهیز و
۸۹٬۱۰۹ نمونه بازیابی شد؛ آرشیو نسخهٔ قبلی استخراج، Build و اجرا شد؛
`/api/health` پاسخ `200` و صفحهٔ اصلی پاسخ `200` داد؛ توقف با `SIGTERM`
کد `0` برگرداند.

---

## ۸. عیب‌یابی

| نشانه | علت احتمالی | راه‌حل |
| --- | --- | --- |
| `EADDRINUSE` | پورت اشغال است | `PORT` دیگر یا توقف سرویس قبلی |
| `503` روی `/` | `web/dist` ساخته نشده | `npm run build` |
| `401` روی همهٔ APIها | نشست منقضی/کوکی ندارد | دوباره وارد شوید |
| `403` روی تغییرات | CSRF یا Origin نامعتبر | هدر `X-CSRF-Token` و Origin را درست کنید |
| `429` | Rate Limit | تا پایان پنجره صبر کنید یا سقف را تنظیم کنید |
| `507` / `DB_DISK_FULL` | فضای دیسک کم | فضا آزاد کنید؛ پشتیبان/ورود گروهی را تکرار کنید |
| `DB_BUSY` | نوشتن هم‌زمان طولانی | `NETWATCH_BUSY_TIMEOUT_MS` را افزایش دهید |
| موتور `leader=false` | نمونهٔ دیگر رهبر است | طبیعی است؛ فقط یک نمونه Probe می‌زند |
| `backlog` بالا | بازهٔ بررسی کمتر از ظرفیت | `max_workers` یا بازه را افزایش دهید |
| `WAL` بزرگ | Checkpoint دیر | `POST /api/system/db/checkpoint` یا `db:doctor` |
| پشتیبان نامعتبر | فایل دست‌کاری‌شده/ناقص | پشتیبان دیگری انتخاب کنید؛ Restore انجام نمی‌شود |
| خطای TLS | گواهی/SAN نامناسب | `npm run tls:setup -- <ip> <host>` را تکرار کنید |

لاگ ساختاریافته: `journalctl -u netwatch -f` یا فایل `NETWATCH_LOG_FILE`.
برای عیب‌یابی عمیق: `npm run db:doctor` و `docs/db-reliability-report.md`.

---

## ۹. چک‌لیست انتشار

- [ ] `npm run verify` با EXIT=0
- [ ] `npm audit` بدون Critical/High
- [ ] `npm run test:heavy` موفق
- [ ] `npm run qa:load` موفق
- [ ] Soak ۷۲ ساعته (`npm run qa:soak72`) با `ok=true` و `leakSuspected=false`
- [ ] `npm run release:prepare` و ثبت `release.json`
- [ ] آزمایش Restore در محیط Staging
- [ ] آزمایش Rollback به نسخهٔ قبلی
- [ ] تأیید تعاملی UI (ورود، نقشه، هشدارها، Reports)
- [ ] پایش ۷۲ ساعتهٔ پس از انتشار
