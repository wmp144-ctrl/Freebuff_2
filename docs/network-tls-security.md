# امنیت شبکه و TLS — NetWatch

**نسخه:** 1.1.0 (فاز ۳) · **مرجع:** `server/config.js`، `server/net-policy.js`،
`server/probe-guard.js`، `server/network-access.js`، `deploy/`.

---

## ۱. مدل استقرار

NetWatch یک فرآیند Node.js است که API، رابط SPA، SSE و موتور پایش را در همان
پورت سرو می‌کند. پیش‌فرض امن: فقط روی `127.0.0.1` گوش می‌دهد. انتشار روی شبکه
باید آگاهانه و همراه با TLS/فایروال باشد.

```
[کاربران شبکهٔ مجاز] ──TLS──► [nginx/پروکسی معکوس] ──HTTP/loopback──► [NetWatch]
                                      │
                                      └─ هدرهای X-Forwarded-* فقط از Trusted Proxy
```

| کنترل | پیش‌فرض | متغیر |
| --- | --- | --- |
| Bind address | `127.0.0.1` | `HOST` |
| پورت | `8787` (توسعه ۳۰۰۰) | `PORT` |
| TLS | خاموش | `NETWATCH_TLS_DIR` یا CERT/KEY |
| HSTS | روشن در HTTPS | `NETWATCH_HSTS` |
| ریدایرکت HTTP→HTTPS | خاموش | `NETWATCH_HTTP_PORT` |
| Trusted Proxy | خاموش | `NETWATCH_TRUST_PROXY` |
| شبکهٔ مجاز API مدیریتی | بدون محدودیت | `NETWATCH_ADMIN_ALLOWED_CIDRS` |
| شبکهٔ مجاز Probe | شبکه‌های خصوصی | `NETWATCH_PROBE_ALLOWED_CIDRS` |

**هشدار:** اگر `HOST` غیر loopback باشد و `NETWATCH_ADMIN_ALLOWED_CIDRS` تنظیم
نشده باشد، در راه‌اندازی هشدار ثبت می‌شود. در استقرار واقعی این متغیر را تنظیم
کنید.

---

## ۲. TLS

### الف) گواهی محلی (شبکهٔ آفلاین)

```bash
npm run tls:setup -- --out data/tls netwatch.local 192.168.10.20
# خروجی: data/tls/server.crt، server.key، ca.crt
```

```bash
NETWATCH_TLS_DIR=data/tls
# یا صریح:
NETWATCH_TLS_CERT=/etc/netwatch/tls/server.crt
NETWATCH_TLS_KEY=/etc/netwatch/tls/server.key
NETWATCH_TLS_CA=/etc/netwatch/tls/ca.crt   # اختیاری برای اعتماد کلاینت
```

- تنظیم ناقص (فقط CERT یا فقط KEY) راه‌اندازی را متوقف می‌کند.
- فایل گواهی/کلید باید فقط برای مالک سرویس خواندنی باشد (۰۶۰۰).
- برای ریدایرکت پورت ۸۰ به HTTPS: `NETWATCH_HTTP_PORT=80`.
- HSTS به‌طور پیش‌فرض `max-age=15552000` دارد؛ فقط در آزمایش با گواهی
  خودامضا می‌توان `NETWATCH_HSTS=0` گذاشت.
- کوکی نشست در HTTPS `Secure` می‌شود (بر اساس سوکت TLS یا `req.secure`).

### ب) پروکسی معکوس

نمونهٔ `deploy/nginx.conf.example` را ببینید. نکات الزامی:

1. TLS را در nginx terminate کنید و `NETWATCH_TRUST_PROXY=loopback` بگذارید تا
   `req.secure`/`req.ip` از هدرهای پروکسی معتبر شوند.
2. `X-Forwarded-For`/`X-Forwarded-Proto`/`X-Forwarded-Host` را **بازنویسی**
   کنید (نه append کورکورانه) تا کلاینت نتواند جعل کند.
3. `client_max_body_size` را کمی بالاتر از سقف فایل Import تنظیم کنید (فایل MBTiles
   سقف حجم ندارد؛ برای آن `0` بگذارید).
4. برای SSE: `proxy_buffering off; proxy_read_timeout 3600s;`.
5. فقط مسیر سرویس را publish کنید؛ پورت داخلی NetWatch نباید از شبکه باز شود.

> `X-Forwarded-Host` فقط وقتی در بررسی Origin پذیرفته می‌شود که
> `NETWATCH_TRUST_PROXY` تنظیم شده باشد؛ در غیر این صورت هدر نادیده گرفته
> می‌شود. مقدار نامعتبر `NETWATCH_TRUST_PROXY` (مثل `*`) راه‌اندازی را متوقف
> می‌کند.

---

## ۳. محدودیت شبکه‌ای APIهای مدیریتی

```bash
# فقط شبکهٔ مدیریت و loopback (برای healthcheck محلی)
NETWATCH_ADMIN_ALLOWED_CIDRS=10.20.0.0/24,127.0.0.1/32
```

مسیرهای مشمول (`server/rate-limit.js::isAdminRequest`):

- `/api/settings*`
- `/api/auth/users*` (شامل unlock)
- `/api/audit*`
- `/api/system/*` (سلامت تفصیلی، پشتیبان/بازیابی، Retention)
- `/api/engine/control/*`

درخواست از شبکهٔ دیگر با ۴۰۳ و رویداد `admin_api_network_denied` (IP/مسیر/کاربر)
رد می‌شود. این کنترل **جایگزین RBAC نیست**؛ هر دو مستقل اعمال می‌شوند. ورود
(`POST /api/auth/login`) و مسیرهای عملیاتی از این محدودیت مستثنا هستند تا
اپراتورها از شبکهٔ عملیاتی کار کنند.

**توصیه:** CIDR را با شبکهٔ واقعی مدیریت تنظیم کنید و در صورت استفاده از
پروکسی، آدرس loopback پروکسی را هم اضافه کنید (چون `req.ip` آدرس پروکسی است
مگر XFF معتبر باشد).

---

## ۴. سیاست Probe و مقاصد ممنوع

Probe/Ping یک عملیات فعال است و فقط با دو شرط اجرا می‌شود:

1. مجوز نقش `probe:run` (Admin/Operator).
2. مقصد در allowlist باشد.

| محدوده | پیش‌فرض | توضیح |
| --- | --- | --- |
| شبکه‌های خصوصی/loopback | ✅ مجاز | `10/8`, `172.16/12`, `192.168/16`, `127/8`, `::1`, `fc00::/7` |
| Link-Local (`169.254/16`, `fe80::/10`) | ❌ مسدود | فقط با `NETWATCH_PROBE_ALLOW_LINK_LOCAL=1` |
| Cloud Metadata (`169.254.169.254`, …) | ❌ مسدود | فقط با `NETWATCH_PROBE_ALLOW_METADATA=1` |
| 6to4/Teredo/NAT64 | ❌ مسدود | فقط با `NETWATCH_PROBE_ALLOW_TRANSITION=1` |
| Multicast/رزرو/`0.0.0.0` | ❌ همیشه | `ALWAYS_BLOCKED_CIDRS` |
| خارج از allowlist | ❌ مسدود | ۴۰۳ + دلیل |

سخت‌سازی‌های آدرس:

- IPv4-mapped (`::ffff:10.0.0.1`) و IPv4-compatible به IPv4 نرمال می‌شوند؛
  محدودیت IPv4 با نوشتن آدرس به شکل IPv6 دور زده نمی‌شود.
- Zone ID (`fe80::1%eth0`) رد می‌شود.
- اگر نام میزبان استفاده شود، **همهٔ** آدرس‌های DNS باید مجاز باشند؛ یک آدرس
  غیرمجاز کل درخواست را رد می‌کند (DNS Rebinding).
- تجهیزات در این نسخه IP ذخیره می‌کنند (اعتبارسنجی `net.isIP`)، بنابراین
  TOCTOU نام میزبان بین بررسی و Ping وجود ندارد.
- Probe فقط ICMP/TCP مستقیم است؛ redirect HTTP دنبال نمی‌شود.

---

## ۵. فایروال و سرویس‌های غیرضروری

```bash
# فقط پورت سرویس برای شبکهٔ مجاز
sudo ufw default deny incoming
sudo ufw allow from 10.20.0.0/24 to any port 8787 proto tcp
sudo ufw enable
```

- فقط یک پورت Node در حال listen باشد (`ss -lntp | grep node`).
- سرویس را با کاربر غیرروت و `deploy/netwatch.service` اجرا کنید
  (`ProtectSystem=strict`, `PrivateTmp=yes`, `NoNewPrivileges=yes`,
  `ReadWritePaths` فقط پوشهٔ داده).
- پوشهٔ `data/` را هرگز در ریشهٔ وب/nginx قرار ندهید.
- سرویس‌های اضافی (تلنت، FTP، SMB، پنل‌های وب) را روی همان میزبان خاموش کنید.
- SSH را به شبکهٔ مدیریت محدود و با کلید کنید.

---

## ۶. محدودیت‌های HTTP و DoS

| تنظیم | پیش‌فرض | متغیر |
| --- | ---: | --- |
| `requestTimeout` | ۱۲۰s | `NETWATCH_REQUEST_TIMEOUT_MS` |
| `headersTimeout` | ۳۰s | `NETWATCH_HEADERS_TIMEOUT_MS` |
| `keepAliveTimeout` | ۵s | `NETWATCH_KEEPALIVE_TIMEOUT_MS` |
| حداکثر هدرها | ۱۰۰ | ثابت |
| بدنهٔ JSON | ۲MB | ثابت |
| Import | ۱۰MB | `NETWATCH_MAX_IMPORT_BYTES` |
| MBTiles | بدون محدودیت حجم (فقط فضای آزاد دیسک) | — |
| XLSX بازشده | ۶۴MB | `NETWATCH_MAX_XLSX_UNCOMPRESSED_BYTES` |
| SSE | ۳۲ اتصال / ۱MB بافر | `NETWATCH_SSE_*` |

`headersTimeout` باید کمتر از `requestTimeout` باشد؛ در غیر این صورت
راه‌اندازی با `ConfigError` متوقف می‌شود.

---

## ۷. مانیتورینگ شبکه/امنیت

- `GET /api/system/health` (فقط `system:health`) شامل TLS، DB، موتور، صف Worker،
  دیسک و AI نیست؛ مسیر فایل افشا نمی‌شود.
- رویدادهای امنیتی در stdout/journald: `auth_login_failed`، `auth_account_locked`،
  `auth_csrf_rejected`، `admin_api_network_denied`، `request_error`، `http_request`
  (فقط خطا/کند/۴۲۹).
- برای SIEM: خروجی JSON یک‌خطی را به Loki/ELK بفرستید؛ کلیدهای حساس redact
  می‌شوند.
- هشدار پیشنهادی: نرخ `auth_login_failed`، `admin_api_network_denied`،
  `429`های مکرر، خطای TLS و قطع Healthcheck.

---

## ۸. چک‌لیست پذیرش شبکه/TLS

- [ ] `HOST` و فایروال فقط شبکهٔ لازم را باز می‌کند.
- [ ] TLS فعال است و گواهی/کلید ۰۶۰۰ و معتبر است.
- [ ] HSTS روشن است (به‌جز آزمون خودامضا).
- [ ] پشت پروکسی: `NETWATCH_TRUST_PROXY` صریح و هدرها بازنویسی می‌شوند.
- [ ] `NETWATCH_ADMIN_ALLOWED_CIDRS` تنظیم و آزمون شده است.
- [ ] `NETWATCH_PROBE_ALLOWED_CIDRS` متناسب با شبکه و Metadata مسدود است.
- [ ] پورت‌های غیرضروری و سرویس‌های اضافی بسته/خاموش‌اند.
- [ ] `data/` خارج از web root و با مجوز ۰۷۰۰/۰۶۰۰ است.
- [ ] Timeoutها و سقف‌های حجم/اتصال با ظرفیت میزبان تناسب دارند.
