# NetWatch — امنیت، کنترل دسترسی و گزارش آزمون (P0)

این سند مرجع امنیتی نسخهٔ P0 است: نقش‌ها و مجوزها، فهرست APIهای محافظت‌شده،
سازوکارهای امنیتی پیاده‌شده، تنظیمات استقرار امن و گزارش آزمون.

> وضعیت: همهٔ معیارهای پذیرش P0 پیاده و با آزمون خودکار تأیید شده‌اند
> (۷۱ آزمون واحد، ۴۰ آزمون یکپارچه، ۳ آزمون E2E و ۸۷ بررسی دود).

---

## ۱. نقش‌ها (RBAC)

سه نقش پایه تعریف شده است. نقش‌ها در جدول `users` ذخیره می‌شوند و مقدار
`administrator` هم به‌عنوان نام مستعار پذیرفته و به `admin` نرمال می‌شود.

| نقش | نام | خلاصه |
| --- | --- | --- |
| `admin` | Administrator | همهٔ مجوزها؛ مدیریت کاربران، تنظیمات، حسابرسی و بازنشانی داده |
| `operator` | Operator | عملیات روزمره: تجهیزات، هشدارها، تعمیرات، نقشه، Probe و کنترل موتور |
| `viewer` | Viewer | فقط مشاهده (تمام GETهای عملیاتی، بدون Probe و بدون هیچ تغییر) |

نخستین مدیر در اولین راه‌اندازی ساخته می‌شود (`NETWATCH_ADMIN_PASSWORD`)؛ در
غیر این صورت رمز تصادفی یک‌بار در `data/initial-admin-password.txt` با دسترسی
`0600` نوشته و **پس از نخستین ورود موفق مدیر حذف** می‌شود.

### ماتریس مجوزها

| مجوز | admin | operator | viewer |
| --- | :-: | :-: | :-: |
| `dashboard:read` (شامل SSE) | ✅ | ✅ | ✅ |
| `devices:read` | ✅ | ✅ | ✅ |
| `devices:write` | ✅ | ✅ | ❌ |
| `reports:read` | ✅ | ✅ | ✅ |
| `alerts:read` / `alerts:write` | ✅ | ✅ / ✅ | ✅ / ❌ |
| `maintenance:read` / `maintenance:write` | ✅ | ✅ / ✅ | ✅ / ❌ |
| `inventory:read` / `inventory:write` | ✅ | ✅ / ✅ | ✅ / ❌ |
| `markers:read` / `markers:write` | ✅ | ✅ / ✅ | ✅ / ❌ |
| `ops:read` / `ops:write` | ✅ | ✅ / ✅ | ✅ / ❌ |
| `engine:read` | ✅ | ✅ | ✅ |
| `engine:control` | ✅ | ✅ | ❌ |
| `probe:run` (و محدودهٔ مقصد) | ✅ | ✅ | ❌ |
| `settings:read` | ✅ | ✅ | ✅ |
| `settings:write` | ✅ | ❌ | ❌ |
| `system:health` (سلامت تفصیلی) | ✅ | ✅ | ❌ |
| `users:manage` | ✅ | ❌ | ❌ |
| `audit:read` | ✅ | ❌ | ❌ |
| `demo:reset` | ✅ | ❌ | ❌ |

پیاده‌سازی: `server/permissions.js` (مدل نقش/مجوز و میدل‌ورهای `requirePermission`
و `routePermission`).

---

## ۲. فهرست APIهای محافظت‌شده

همهٔ مسیرهای زیر `/api` به‌جز مسیرهای عمومی، به احراز هویت نیاز دارند و برای
درخواست‌های تغییردهنده، توکن CSRF الزامی است. `GET /health` و `GET /api/health`
عمومی (حداقلی) و `POST /api/auth/login` عمومی (با سقف نرخ سخت‌گیرانه) است.

| مسیرها | متد | مجوز لازم |
| --- | --- | --- |
| `/api/auth/login` | POST | عمومی (Rate Limit ورود) |
| `/api/auth/logout` | POST | نشست + CSRF |
| `/api/auth/me` | GET | نشست |
| `/api/auth/users`، `/api/auth/users/:id` | GET/POST/PUT/DELETE | `users:manage` |
| `/api/devices`، `/meta`، `/export`، `/template`، `/:id`، `/:id/series`، `/:id/outages`، `/:id/availability`، `/:id/samples`، `/:id/health`، `/:id/maintenance`، `/sparklines` | GET | `devices:read` |
| `/api/devices`، `/bulk`، `/positions`، `/import/preview`، `/import/commit`، `/import/geo`، `/:id` (PUT/PATCH/DELETE) | POST/PUT/PATCH/DELETE | `devices:write` |
| `/api/devices/:id/probe` | GET | `probe:run` + محدودهٔ مقصد |
| `/api/devices/:id/ping` | POST | `devices:write` + `probe:run` + محدودهٔ مقصد |
| `/api/dashboard/summary`، `/api/events` (SSE) | GET | `dashboard:read` |
| `/api/reports/summary`، `/api/reports/export` | GET | `reports:read` |
| `/api/alerts`، `/api/alerts/:id`، `/api/alert-rules`، `/api/maintenance`، `/api/maintenance-windows`، `/api/events/*`، `/api/engine/status` | GET | `ops:read` |
| `/api/alerts/:id/ack`، `/resolve`، `/alerts/bulk`، `/alert-rules*`، `/maintenance*`، `/maintenance-windows*` | POST/PUT/DELETE | `ops:write` |
| `/api/engine/control/:action` | POST | `engine:control` |
| `/api/engine/check/:id`، `/api/engine/check-all` | POST | `probe:run` + محدودهٔ مقصد |
| `/api/engine/log` | GET | `system:health` |
| `/api/settings` | GET / PUT | `settings:read` / `settings:write` |
| `/api/settings/reset-demo` | POST | `demo:reset` + `NETWATCH_ALLOW_RESET=1` |
| `/api/groups`، `/api/tags`، `/api/layers`، `/api/layers/:id/info`، `/api/tiles/...`، `/api/mbtiles/files` | GET | `inventory:read` |
| `/api/groups*`، `/api/tags*`، `/api/tags/:tagId/devices`، `/api/layers*`، `/api/layers/upload`، `/api/mbtiles/files/:name` | POST/PUT/DELETE | `inventory:write` |
| `/api/marker-types`، `/api/markers`، `/api/markers/export`، `/api/markers/template` | GET | `markers:read` |
| `/api/marker-types*`، `/api/markers*`، `/api/markers/import*` | POST/PUT/DELETE | `markers:write` |
| `/api/system/health` | GET | `system:health` |
| `/api/audit` | GET | `audit:read` |

مسیرهای ناشناختهٔ `/api` پاسخ `404` JSON می‌دهند؛ هیچ مسیر عملیاتی بدون
احراز هویت باقی نمانده است (آزمون `every operational API rejects anonymous requests`).

---

## ۳. سازوکارهای امنیتی

- **رمز عبور:** `Argon2id` با پارامترهای OWASP
  (`m=19456,t=2,p=1`)، نمک تصادفی برای هر کاربر، مقایسهٔ امن. هش‌های قدیمی
  `scrypt` در نخستین ورود موفق به‌صورت خودکار و شفاف ارتقا می‌یابند.
  برای نام کاربری ناموجود هم یک Argon2id اجرا می‌شود تا شمارش کاربران ممکن نباشد.
- **نشست:** کوکی `nw_session` با `HttpOnly` + `SameSite=Strict` + `Path=/`
  (و `Secure` روی HTTPS)؛ توکن ۲۵۶ بیتی و ذخیرهٔ فقط هش SHA-256 در پایگاه‌داده.
  تغییر رمز/غیرفعال‌شدن کاربر همهٔ نشست‌های او را باطل می‌کند.
- **CSRF:** گارد همان‌مبدأ مستقل **به‌علاوهٔ** الگوی double-submit؛ درخواست
  تغییردهنده باید هدر `X-CSRF-Token` هم‌خوان با کوکی `nw_csrf` و با هش
  ذخیره‌شده در نشست داشته باشد. خروج هم اکنون محافظت‌شده است.
- **Origin:** بررسی Origin برای همهٔ درخواست‌های تغییردهنده روی `/api` حفظ شده
  اما جایگزین احراز هویت نیست.
- **سقف نرخ:** ۶۰۰ درخواست عمومی در دقیقه برای هر IP، ۶۰ درخواست سنگین
  (Probe/Ping/ورود فایل/بارگذاری نقشه) و ۱۰ تلاش ورود در ۱۵ دقیقه؛ پاسخ‌های
  `429` هدرهای `Retry-After` و `X-RateLimit-*` دارند.
- **اعتبارسنجی ورودی:** بدنهٔ JSON باید شیء ساده باشد، `Content-Type` الزامی
  است (`415`)، کلیدهای خطرناک نمونه‌سازی (`__proto__`/`prototype`/`constructor`)
  رد می‌شوند و طول آدرس محدود است. اعتبارسنجی دامنه‌ای (IP، مختصات، بازهٔ
  اعداد، فهرست‌های مجاز تنظیمات) در ماژول‌های خودشان انجام می‌شود.
- **محدودیت فایل:** Excel/CSV فقط با پسوند مجاز، سقف ۱۰ مگابایت
  (`NETWATCH_MAX_IMPORT_BYTES`) و حداکثر ۵۰٬۰۰۰ ردیف (`NETWATCH_MAX_IMPORT_ROWS`).
  MBTiles فقط با پسوند `.mbtiles`، سقف ۱ گیگابایت
  (`NETWATCH_MAX_MBTILES_BYTES`)، بررسی فضای آزاد دیسک و اعتبارسنجی هدر
  `SQLite format 3` پیش از ثبت.
- **CSV Formula Injection:** هر سلول متنی که با `= + - @` یا tab/CR آغاز شود
  پیش از خروجی Excel/CSV با آپاستروف خنثی می‌شود (`impexp.js`).
- **سلامت:** `GET /health` و `GET /api/health` عمومی فقط `{ok,status,ts}`
  برمی‌گردانند؛ جزئیات (نسخه، موتور، SSE، تعداد تجهیزات) فقط در
  `GET /api/system/health` برای `system:health` است و هیچ مسیر داخلی فایل افشا نمی‌شود.
- **حسابرسی (Audit Log):** جدول `audit_log` شامل زمان، کاربر، نقش، کنش، هدف،
  متد/مسیر، IP، User-Agent، کد وضعیت، موفقیت و جزئیات است. ورود/خروج، تغییر
  تنظیمات، مدیریت کاربران، حذف اطلاعات، Probe، خروجی‌گیری و همهٔ درخواست‌های
  ردشده (۴۰۱/۴۰۳/۴۲۹) ثبت می‌شوند. **هیچ رمز، توکن یا Secret ذخیره نمی‌شود؛**
  فقط نام کلیدهای بدنه (بدون مقدار) و شناسهٔ هدف. نگهداری پیش‌فرض ۱۸۰ روز
  (`audit_retention_days`) و پاک‌سازی روزانه. دسترسی: `GET /api/audit` فقط Administrator.
- **Probe کنترل‌شده:** علاوه بر مجوز `probe:run`، مقصد Probe باید در محدودهٔ
  CIDR مجاز باشد (`probe_allowed_cidrs` در تنظیمات یا
  `NETWATCH_PROBE_ALLOWED_CIDRS` در محیط). پیش‌فرض فقط شبکه‌های خصوصی/loopback.
  اسکن گروهی و «بررسی همه» هم فهرست مجاز را رعایت می‌کنند.
- **رازها:** هیچ رمز/توکن/Secret در کد منبع نیست؛ رمز مدیر از محیط یا فایل
  `0600` موقت خوانده می‌شود. `.env` در `.gitignore` است و فقط `.env.example`
  بدون مقدار حساس نگهداری می‌شود.
- **هدرهای امنیتی:** `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, `Cross-Origin-Opener-Policy`, `Permissions-Policy`,
  `X-Permitted-Cross-Domain-Policies: none`, CSP سخت‌گیرانه در تولید و HSTS در HTTPS.
  پاسخ‌های API با `Cache-Control: no-store` ارسال می‌شوند.
- **پیش‌فرض امن استقرار:** سرور به‌صورت پیش‌فرض فقط روی `127.0.0.1` گوش می‌دهد؛
  انتشار نیازمند `HOST=0.0.0.0` است. `NETWATCH_TRUST_PROXY` فقط برای پروکسی
  معکوس مورد اعتماد تنظیم می‌شود.

---

## ۴. استقرار امن

1. کاربر سیستمی غیرروت بسازید و سرویس را با
   `deploy/netwatch.service` (شامل `ProtectSystem`, `PrivateTmp`,
   `ReadWritePaths` فقط پوشهٔ داده) اجرا کنید.
2. متغیرها را در `/etc/netwatch/netwatch.env` با دسترسی `0600` نگه دارید
   (نمونه: `.env.example`).
3. TLS را یا با گواهی محلی (`npm run tls:setup`) یا با پروکسی معکوس
   (`deploy/nginx.conf.example`) فعال کنید و در حالت پروکسی
   `NETWATCH_TRUST_PROXY=loopback` را تنظیم کنید.
4. در فایروال فقط پورت سرویس را برای شبکهٔ مجاز باز کنید؛ پوشهٔ `data/` را از
   دسترس وب سرور بیرون نگه دارید.
5. رمز مدیر اولیه را بلافاصله تغییر دهید و برای هر اپراتور حساب جدا با نقش
   `operator` بسازید؛ رمزها را به‌اشتراک نگذارید.
6. محدودهٔ Probe را در تنظیمات یا با `NETWATCH_PROBE_ALLOWED_CIDRS` متناسب با
   شبکهٔ خود محدود نگه دارید.

---

## ۵. گزارش آزمون امنیتی

تاریخ اجرا: ۱۴۰۵-۰۷-۲۷ (2026-10-19) — محیط: Node.js 24.21، Linux.

| فرمان | نتیجه |
| --- | --- |
| `npm run lint` | ✅ بدون خطا |
| `npm run typecheck` | ✅ بدون خطا |
| `npm run build` | ✅ موفق |
| `npm run test:unit` | ✅ ۱۳۲ از ۱۳۲ |
| `npm run test:web` | ✅ ۱۴ از ۱۴ |
| `npm run test:integration` | ✅ ۸۳ از ۸۳ |
| `npm run test:e2e` | ✅ ۳ از ۳ + ۸۷ از ۸۷ بررسی دود |
| `npm run test:heavy` | ✅ ۱ از ۱ (ورود ۵۰٬۰۰۰ ردیف) |
| `npm audit` | ✅ ۰ آسیب‌پذیری (Critical/High/Medium/Low) |

آزمون‌های امنیتی کلیدی و اینکه چه چیزی را ثابت می‌کنند:

| معیار پذیرش | آزمون | نتیجه |
| --- | --- | --- |
| درخواست بدون احراز هویت به APIهای محافظت‌شده رد شود | `every operational API rejects anonymous requests` | ✅ ۴۰۱ برای همهٔ مسیرها |
| Viewer نتواند اطلاعات را تغییر دهد | `viewer can read but cannot mutate, probe, or reach admin APIs` | ✅ ۴۰۳ |
| Operator نتواند تنظیمات مدیریتی را تغییر دهد | `operator performs daily operations but cannot change administrative settings` | ✅ ۴۰۳ برای settings/users/audit/reset |
| Administrator به عملیات مجاز دسترسی داشته باشد | `administrator can change settings, users and read the audit log` | ✅ |
| تست CSRF نتواند اطلاعات را تغییر دهد | `CSRF and foreign Origin cannot change data even with a valid session` | ✅ ۴۰۳ |
| تست Rate Limiting نتواند از محدودیت عبور کند | `expensive endpoints are rate limited...` و `general API rate limit stops abusive clients` | ✅ ۴۲۹ |
| ورودی مخرب و فایل غیرمجاز رد شود | `malicious input, wrong content types and disallowed files are rejected`، `oversized spreadsheet uploads are refused before parsing` و `malicious.test.mjs` (XLSX جعلی، MBTiles جعلی، Path Traversal، ردیف اضافی، CSV Injection) | ✅ ۴۰۰/۴۱۳/۴۱۵ |
| اطلاعات حساس در پاسخ عمومی نباشد | `public health is minimal...` | ✅ فقط `{ok,status,ts}` |
| Audit Log برای عملیات حساس ایجاد شود | `sensitive settings changes and deletes are audited with actor and target` | ✅ با کاربر، نقش، هدف و موفقیت |
| محدودهٔ IP مجاز Probe قابل تنظیم باشد | `probe allowlist can be narrowed through configuration` | ✅ ۴۰۳ خارج از محدوده |
| پرشدن دیسک باعث نوشتن ناقص نشود | `disk-full.test.mjs` | ✅ ۵۰۷ + Rollback کامل |
| هم‌زمانی بالا خطای ۵۰۰ ندهد | `concurrency.test.mjs` | ✅ ۵۰ ثبت/۱۲ مسابقهٔ IP/۲۰ ویرایش |
| ۱۰۰ اتصال SSE مدیریت شود | `sse-load.test.mjs` | ✅ بدون نشتی |
| رمزها با Argon2id ذخیره شوند | unit: `hashPassword stores Argon2id...` + `legacy scrypt hashes still verify...` | ✅ |
| CSV Formula Injection خنثی شود | unit: `spreadsheet exports neutralize CSV formula injection` | ✅ |

### محدودیت‌های شناخته‌شده

- سقف نرخ درون‌حافظه‌ای است؛ با ری‌استارت صفر می‌شود و برای چند نمونه پشت یک
  پروکسی، محدودیت را در پروکسی هم اعمال کنید.
- قفل‌شدن حساب پس از چند تلاش ناموفق پیاده نشده؛ فقط سقف نرخ IP و ثبت
  تلاش‌های ناموفق در حسابرسی وجود دارد.
- رابط گرافیکی مدیریت کاربران/حسابرسی هنوز وجود ندارد و این بخش‌ها از API
  (`/api/auth/users` و `/api/audit`) مدیریت می‌شوند.
- اجرای آزمایشی مرورگر برای فرم‌های ورود/نقش‌ها انجام نشده است؛ آزمون‌ها
  سرور واقعی را با HTTP/HTTPS صدا می‌زنند، اما بررسی دستی UI باقی می‌ماند.
