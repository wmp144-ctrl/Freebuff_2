# نصب NetWatch

این سند نصب **تولیدی** NetWatch را روی یک سرور لینوکس توضیح می‌دهد. برای اجرای
سریع روی لپ‌تاپ کافی است `npm install && npm run build && npm start` را اجرا
کنید (بخش ۱ README).

---

## ۱. پیش‌نیازها

| مورد | حداقل | توضیح |
| --- | --- | --- |
| Node.js | **22.12** | برنامه از `node:sqlite` داخلی استفاده می‌کند؛ نیازی به کامپایل بومی نیست |
| سیستم‌عامل | لینوکس (تست‌شده روی Ubuntu 24.04) | برای حالت ICMP به `CAP_NET_RAW` نیاز است |
| RAM | ۵۱۲ MB | برای ۱٬۰۰۰ تجهیز و ۱۰ هزار نمونه در دقیقه، ۱ GB توصیه می‌شود |
| دیسک | ۲ GB آزاد | داده و پشتیبان‌ها در یک فایل/پوشهٔ محلی می‌مانند |
| شبکه | دسترسی به تجهیزات | پورت خروجی ICMP یا TCP (حالت `tcp`) به تجهیزات |
| زمان | همگام (NTP) | ساعت نادرست باعث Backfill و ناسازگاری بازه‌های گزارش می‌شود |

بررسی نسخه:

```bash
node -v      # باید >= v22.12.0 باشد
```

نصب بسته‌های سیستمی برای ICMP واقعی:

```bash
sudo apt-get install -y iputils-ping
```

> اگر `ping` در دسترس نباشد، موتور به‌صورت خودکار به حالت TCP برمی‌گردد؛ این
> وضعیت در «سلامت برنامه» و لاگ موتور دیده می‌شود (`mode: tcp`).

---

## ۲. نصب تمیز (روش پیشنهادی: systemd)

### ۲.۱. کاربر و مسیرها

```bash
sudo useradd --system --home /opt/netwatch --shell /usr/sbin/nologin netwatch
sudo install -d -o netwatch -g netwatch -m 750 /opt/netwatch /var/lib/netwatch
sudo install -d -m 700 /etc/netwatch
```

### ۲.۲. کپی کد و نصب وابستگی‌ها

```bash
sudo -u netwatch tar -xzf netwatch-<version>.tar.gz -C /opt/netwatch --strip-components=1
cd /opt/netwatch
sudo -u netwatch npm ci --omit=dev
sudo -u netwatch npm run build      # ساخت رابط کاربری در web/dist
```

> `npm ci` نیاز به اینترنت دارد. پس از نصب، سامانه کاملاً آفلاین کار می‌کند.
> اگر Artifact `netwatch-web-<version>.tar.gz` را دارید، می‌توانید آن را در
> `web/dist` باز کنید و از اجرای Vite روی سرور صرف‌نظر کنید.

### ۲.۳. فایل پیکربندی

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
| `NETWATCH_ADMIN_PASSWORD` | فقط در نخستین اجرا خوانده می‌شود. اگر تعیین نشود، یک رمز تصادفی ساخته و مسیر فایل آن در لاگ اعلام می‌شود |
| `NETWATCH_ADMIN_ALLOWED_CIDRS` | APIهای مدیریتی (تنظیمات، کاربران، حسابرسی، سیستم) را به شبکهٔ مدیریت محدود می‌کند |
| `NETWATCH_SEED_DEMO=0` | در نصب واقعی، دادهٔ نمایشی بارگذاری نشود (پیش‌فرض `1` برای ارزیابی) |
| `NETWATCH_TRUST_PROXY` | فقط اگر پشت Nginx/HAProxy هستید؛ در غیر این صورت خالی بگذارید |

### ۲.۴. سرویس systemd

```bash
sudo cp deploy/netwatch.service /etc/systemd/system/netwatch.service
sudo systemctl daemon-reload
sudo systemctl enable --now netwatch
systemctl status netwatch --no-pager
```

واحد sample با سخت‌سازی کامل (`ProtectSystem=strict`، `PrivateTmp`،
`NoNewPrivileges`، `ReadWritePaths=/var/lib/netwatch`) ارائه شده است. برای
حالت ICMP واقعی، بخش `CAP_NET_RAW` انتهای فایل واحد را از کامنت خارج کنید.

### ۲.۵. Reverse proxy و TLS

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/netwatch
sudo ln -s /etc/nginx/sites-available/netwatch /etc/nginx/sites-enabled/
```

اگر گواهی داخلی می‌خواهید (بدون اینترنت):

```bash
cd /opt/netwatch
sudo -u netwatch npm run tls:setup -- 192.168.10.20 netwatch.local
# سپس در netwatch.env:
# NETWATCH_TLS_CERT=/var/lib/netwatch/tls/server.crt
# NETWATCH_TLS_KEY=/var/lib/netwatch/tls/server.key
# NETWATCH_TLS_CA=/var/lib/netwatch/tls/ca.crt
sudo systemctl restart netwatch
```

`nginx.conf.example` فایل‌های TLS، هدرهای امنیتی، محدودیت نرخ و
`proxy_buffering off` (لازم برای SSE) را از پیش تنظیم کرده است.

---

## ۳. مجوزهای فایل و پوشه

| مسیر | مالک | مجوز | توضیح |
| --- | --- | --- | --- |
| `/etc/netwatch/netwatch.env` | root | `600` | رمز مدیر و کلیدها |
| `/etc/netwatch/tls/server.key` | root یا netwatch | `600` | کلید خصوصی |
| `/var/lib/netwatch` | netwatch | `750` | داده، WAL، پشتیبان، MBTiles |
| `/var/lib/netwatch/netwatch.db` | netwatch | `600` | پایگاه‌داده (UMask واحد systemd آن را تنظیم می‌کند) |
| `/var/lib/netwatch/backups` | netwatch | `750` | پشتیبان‌های معتبر با checksum |

بررسی سریع:

```bash
namei -l /var/lib/netwatch/netwatch.db
sudo -u netwatch test -w /var/lib/netwatch && echo writable
```

---

## ۴. بررسی پس از نصب

```bash
# ۱) سلامت عمومی (بدون ورود)
curl -fsS http://127.0.0.1:8787/api/health

# ۲) وضعیت دقیق برنامه و پایگاه‌داده (پس از ورود مدیر)
curl -fsS -c /tmp/nw.jar -H 'content-type: application/json' \
  -H 'origin: http://127.0.0.1:8787' \
  -d '{"username":"admin","password":"<رمز>"}' \
  http://127.0.0.1:8787/api/auth/login
curl -fsS -b /tmp/nw.jar http://127.0.0.1:8787/api/system/health

# ۳) بررسی کامل پایگاه‌داده و Migration
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch npm run db:doctor

# ۴) پشتیبان اولیه و اعتبارسنجی آن
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch npm run db:backup
```

انتظار می‌رود:

- `/api/health` مقدار `ok: true` و `status: 200` بدهد.
- `db.doctor` بدون خطا تمام شود و نسخهٔ ساختار (`schemaVersion`) برابر
  `SCHEMA_VERSION` برنامه باشد.
- فایل پشتیبان در `/var/lib/netwatch/backups/netwatch-…` با `netwatch.db` و
  `manifest.json` ساخته و `integrity: ok` گزارش شود.

سپس در مرورگر `https://<host>/` را باز کنید، با حساب مدیر وارد شوید و:

1. از منوی «تنظیمات» بازهٔ پایش، آستانه‌ها و حالت موتور را تنظیم کنید.
2. یک تجهیز آزمایشی (مثلاً `127.0.0.1`) اضافه و «بررسی» را اجرا کنید.
3. در «سلامت برنامه» اتصال SSE و وضعیت پشتیبان را ببینید.

---

## ۵. چک‌لیست انتشار

- [ ] `node -v` ≥ 22.12
- [ ] `npm ci` و `npm run build` بدون خطا
- [ ] `netwatch.env` با مجوز `600` و رمز یکتا
- [ ] `NETWATCH_ADMIN_ALLOWED_CIDRS` تنظیم‌شده (اگر سرویس روی شبکه است)
- [ ] `NETWATCH_SEED_DEMO=0` در نصب واقعی
- [ ] `systemctl enable netwatch` (اجرای خودکار پس از ری‌استارت سرور)
- [ ] `/api/health` سالم و نسخهٔ درست
- [ ] `npm run db:backup` موفق با `integrity: ok`
- [ ] پشتیبان در مسیر جدا از دیسک سرویس، کپی/ارسال می‌شود
- [ ] TLS/پروکسی معکوس کار می‌کند و `Secure` بودن کوکی تأیید شده است
- [ ] «سلامت شبکه» و «سلامت برنامه» در داشبورد داده نشان می‌دهند

---

## ۶. اجرای بدون systemd (اختیاری)

```bash
NETWATCH_DATA_DIR=/var/lib/netwatch NETWATCH_ENGINE=1 npm start
```

برای خاموشی مرتب، همیشه `SIGTERM` بفرستید (`kill -TERM <pid>`). سرویس موتور
بررسی‌های در جریان را تخلیه، WAL را Checkpoint و پایگاه‌داده را می‌بندد.
`SIGKILL` فقط در شرایط اضطراری؛ بازیابی داده در
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) آمده است.

---

## ۷. مستندات مرتبط

- [UPGRADE.md](UPGRADE.md) — ارتقا و بازگشت نسخه
- [OPERATIONS.md](OPERATIONS.md) — کارهای روزمره و رویه‌های اضطراری
- [BACKUP_RESTORE.md](BACKUP_RESTORE.md) — پشتیبان و بازیابی
- [SECURITY.md](SECURITY.md) — مدل تهدید، RBAC و سخت‌سازی
