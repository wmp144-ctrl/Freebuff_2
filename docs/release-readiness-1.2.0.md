# گزارش آمادگی انتشار NetWatch 1.2.0

نقش: Release Manager / Senior Software Architect
تاریخ: 2026-10-20
محدوده: همهٔ فازهای ۱ تا ۶ (پایداری، داده، امنیت، رابط کاربری، عملکرد، یکپارچه‌سازی)
محیط اجرا: Linux (Ubuntu 24.04)، Node.js **24.21.0** (سازگار با حداقل اعلام‌شده 22.12)

---

## ۱. نسخهٔ نهایی

| مورد | مقدار |
| --- | --- |
| نسخه | **1.2.0** |
| نسخهٔ ساختار داده | `SCHEMA_VERSION = 5` (بدون Migration جدید در این نسخه) |
| پشتیبانی از ارتقا | `1.1.0` (بدون تغییر ساختار) و `1.0.0` (Migrationهای ۲–۵) |
| سازگاری پشتیبان | پشتیبان `schemaVersion ≤ 5` قابل بازیابی؛ نسخه‌های بالاتر رد می‌شوند |
| نقطهٔ بازگشت | `npm run release:prepare` + فایل `netwatch.db.pre-migration-v<old>` |

---

## ۲. فهرست تغییرات

### اصلاح باگ (کاربرمحور)

| # | باگ | شدت | وضعیت |
| --- | --- | --- | --- |
| 1 | گم‌شدن پارامتر جست‌وجو هنگام کلیک سریع فیلتر در «تجهیزات» و «نقشه» (نتیجه با فیلتر کهنه) | P1 | اصلاح + آزمون |
| 2 | صفحهٔ «سلامت برنامه» هم‌نام با مسیر JSON `/health`؛ بارگذاری مستقیم خروجی ماشین می‌داد | P1 | اصلاح (مسیر `/app-health`) + آزمون API و مرورگر |
| 3 | گزارش نسخهٔ نادرست (`1.0.0`) وقتی سرویس با systemd اجرا می‌شود | P2 | اصلاح + آزمون قرارداد |
| 4 | ناسازگاری تایپ پاسخ `/api/settings` با قرارداد واقعی | P2 | اصلاح |
| 5 | آسیب‌پذیری High در `@playwright/test` (GHSA-7mvr-c777-76hp) | P1 (زنجیرهٔ ابزار) | ارتقا به `1.55.1`؛ `npm audit` صفر |

### آزمون‌ها و زیرساخت

- `rbac-matrix`: مرز دسترسی همهٔ مسیرها از روی خود روترها (بدون فهرست دستی).
- `api-contract`: هم‌خوانی پاسخ ۹ گروه API با تایپ‌های UI + مسیرهای سلامت.
- `release-scenario`: نصب تازه تا Restore/Restart و تأیید داده.
- `upgrade-and-install`: نصب تمیز بدون دادهٔ نمایشی، ارتقا v3→v5 با نقطهٔ بازگشت،
  شکست اتمیک Migration، پایگاه‌دادهٔ خراب (توقف پیش‌فرض و `warn`).
- `params.test.ts`: آزمون تابع خالص ادغام پارامترهای آدرس.
- Playwright: ۱۰ سناریو شامل بارگذاری مستقیم `/app-health` و نقش Viewer.
- CI استاندارد + Workflow عملکرد + Workflow انتشار (Artifact و SHA-256).

### قابلیت/پیکربندی

- `NETWATCH_SEED_DEMO=0` برای نصب Production بدون دادهٔ نمایشی.
- مستندات عملیاتی جدید (۸ سند ریشه).

---

## ۳. نتایج آزمون‌ها

| مجموعه | فرمان | نتیجه | مدت |
| --- | --- | --- | --- |
| Lint | `npm run lint` | ✅ 0 خطا | ~12s |
| Typecheck | `npm run typecheck` | ✅ 0 خطا | ~8s |
| Build | `npm run build` | ✅ موفق | ~2s |
| Unit (server) | `npm run test:unit` | ✅ **197/197** | 25.3s |
| Web unit | `npm run test:web` | ✅ **20/20** | 0.6s |
| Integration | `npm run test:integration` | ✅ **122/122** | 117s |
| E2E (flows) | `npm run test:e2e` | ✅ **11/11** | 5.3s |
| E2E (smoke) | بخشی از `test:e2e` | ✅ **87/87** | — |
| Browser E2E | `npm run test:ui` | ✅ **10/10** | 72s |
| DB suite | `npm run test:db` | ✅ **63/63** | 10.9s |
| Engine suite | `npm run test:engine` | ✅ **49/49** | 13.4s |
| Heavy (50k rows) | `npm run test:heavy` | ✅ **1/1** (11.1s) | 11.2s |
| Security audit | `npm audit` | ✅ **0 آسیب‌پذیری** | — |

**جمع بررسی‌های مستقل:** ۱۹۷ + ۲۰ + ۱۲۲ + ۱۱ + ۸۷ + ۱۰ = **۴۴۷ بررسی موفق، ۰ ناموفق**.
(`test:db` و `test:engine` زیرمجموعهٔ همان فایل‌ها هستند و دوباره شمرده نشدند.)

هیچ آزمونی حذف یا `skip` نشد. دو آزمون قبلی که به‌دلیل تغییر رفتار UI شکست
خورده بودند، با انتخابگر دقیق‌تر (بدون کاهش پوشش) اصلاح شدند و علت در
`RELEASE_NOTES.md` مستند شده است.

---

## ۴. پوشش تست

| سنجه | مقدار | روش |
| --- | --- | --- |
| پوشش خط (Unit، فایل‌های `server/`) | **۸۳٫۵۵٪** | `node --test --experimental-test-coverage` |
| پوشش شاخه | **۶۹٫۸۷٪** | همان |
| پوشش تابع | **۷۸٫۰۴٪** | همان |
| پوشش مسیرهای API | **۱۰۷/۱۰۷** | `endpoints.test.mjs` (فهرست بسته) |
| پوشش RBAC مسیرها | **۱۰۰٪ مسیرهای تغییردهنده** | `rbac-matrix.test.mjs` |
| پوشش قرارداد پاسخ | ۹ گروه اصلی + زیرمنابع جزئیات | `api-contract.test.mjs` |
| سناریوی سرتاسری انتشار | ۱۷ گام (نصب → Restart) | `release-scenario.test.mjs` |

پوشش بالا فقط آزمون‌های Unit را می‌شمارد (ابزار پوشش برای سرورهای فرزند فعال
نیست)؛ آزمون‌های Integration/E2E مسیرهای واقعی HTTP را پوشش می‌دهند.

---

## ۵. مشکلات باقی‌مانده

| # | مورد | شدت | اثر | برنامه |
| --- | --- | --- | --- | --- |
| 1 | Soak ۲۴/۷۲ ساعته روی سرور اختصاصی اجرا نشده (هارنس با اجرای کوتاه تأیید شده) | ریسک عملیاتی (نه باگ) | احتمال نشتی حافظهٔ بلندمدت ناشناخته | اجرای `npm run qa:soak72` پیش از بهره‌برداری گسترده |
| 2 | آزمون مرورگر فقط Chromium | محدودیت پوشش | تفاوت‌های Safari/Firefox دیده نمی‌شود | افزودن WebKit/Firefox به CI در نسخهٔ بعد |
| 3 | ICMP واقعی در این محیط آزمون نشد (بدون `CAP_NET_RAW`) | محدودیت محیط | رفتار حالت `icmp` فقط با mock/TCP آزمون شده | آزمون دستی روی سرور با `CAP_NET_RAW` |
| 4 | اجرای چندنمونه‌ای افقی پشتیبانی نمی‌شود | محدودیت معماری | مقیاس فقط عمودی | خارج از دامنهٔ 1.2.0 |
| 5 | مدیریت Secret خارجی (Vault/KMS) ندارد | محدودیت | Secret در فایل محیطی با مجوز 600 | ارزیابی در نسخهٔ بعد |

**باگ باز P0/P1: هیچ.** موارد بالا محدودیت محیط/معماری یا بدهی فنی‌اند.

---

## ۶. نتایج امنیت

| بررسی | نتیجه |
| --- | --- |
| `npm audit --audit-level=high` | ✅ ۰ آسیب‌پذیری |
| RBAC: Viewer روی همهٔ مسیرهای تغییردهنده | ✅ ۴۰۳ (با نشست + CSRF + Origin معتبر) |
| RBAC: Operator روی تنظیمات/کاربران/حسابرسی/پشتیبان | ✅ ۴۰۳ |
| مسیر بدون گارد ماژولی | ✅ هیچ (آزمون ساختاری) |
| دسترسی ناشناس به APIهای خواندنی | ✅ ۴۰۱/۴۰۳ (به‌جز `/health`، `/api/health`، `/auth/login`) |
| CSRF / Origin بیگانه | ✅ رد می‌شود |
| قفل حساب و سقف نرخ ورود | ✅ آزمون‌شده (`phase3-security`) |
| Probe به Metadata/Link-Local | ✅ مسدود |
| افشای Secret در لاگ/Audit | ✅ آزمون `secrets never leak...` |
| Secret در مخزن | ✅ فقط مقادیر آزمون؛ کلید خصوصی/توکن واقعی وجود ندارد |
| مسیرهای Health عمومی | ✅ حداقلی: `{ok,status,ts}` |

---

## ۷. نتایج عملکرد (اندازه‌گیری این دوره)

بدون شبکهٔ واقعی، با Probe شبیه‌سازی‌شده (تأخیر ۲ms) و SQLite محلی:

| سناریو | چرخهٔ کامل | نرخ | CPU | حافظه | p99 حلقهٔ رویداد |
| --- | --- | --- | --- | --- | --- |
| ۳۰۰ تجهیز / ۶۴ هم‌زمان | **1.305s** | ۲۲۹٫۹ بررسی/ثانیه | 1.142 ms/بررسی | 93.7→103.4 MB | 37.4 ms |
| ۱٬۰۰۰ تجهیز / ۱۲۸ هم‌زمان | **1.936s** | ۵۱۶٫۵ بررسی/ثانیه | 0.994 ms/بررسی | 94.7→121 MB | 60.6 ms |

- خطای موتور در هر دو اجرا: **۰**
- تجمیع روزانه (۲۸۸ هزار نمونه): ۵۲۰ms؛ گزارش ۷d: ۱۵۷ms؛ کوئری نمودار: ۲ms
- ورود ۵۰٬۰۰۰ ردیف: **۱۱٫۱s**، اتمیک، صفر خطا
- هزینهٔ هر بررسی با افزایش تجهیزات **کاهش** می‌یابد (Batch و صف مؤثر)

مقایسه با گزارش فاز ۵ (docs/performance-report.md) بدون رگرسیون قابل‌توجه است؛
اختلاف اعداد ناشی از تأخیر Probe mock و بار VM مشترک است.

---

## ۸. نتایج Backup و Restore

| گام | نتیجه |
| --- | --- |
| `db:backup` (VACUUM INTO + manifest + checksum) | ✅ `ok:true`، `integrity:ok` |
| تأیید شمارش‌ها با پایگاه‌داده | ✅ devices/samples/alerts/outages برابر |
| `db:restore --dry-run` | ✅ اعتبارسنجی بدون تغییر |
| `db:restore` پس از توقف سرویس | ✅ بازیابی کامل، نسخهٔ ایمنی `pre-restore` ساخته شد |
| Restart پس از Restore | ✅ داده و schema یکسان؛ ورود مجدد و مشاهدهٔ تاریخچهٔ قطعی موفق |
| Retention (dry-run) پس از پشتیبان | ✅ هیچ ردیفی حذف نشد |
| پشتیبان نامعتبر | ✅ رد می‌شود (checksum/manifest/integrity) |

نمونهٔ خروجی بازیابی واقعی در آزمون: `devices:50, samples:84674, outages:1292,
alerts:77, users:3, schemaVersion:5, health:ok` سپس تأیید همان مقادیر پس از Restart.

---

## ۹. وضعیت Migration

| بررسی | نتیجه |
| --- | --- |
| Migration جدید در 1.2.0 | ندارد (schema 5) |
| ارتقا از v3 روی دادهٔ پرشده | ✅ داده حفظ شد؛ schema=5؛ ستون‌ها/ایندکس‌ها ساخته شد |
| پشتیبان پیش از Migration | ✅ `pre-migration-v3-*` با نسخهٔ ۳ و همان داده (قابل Rollback) |
| شکست Migration (تعارض ساختار) | ✅ گام اتمیک برگشت؛ `user_version` در آخرین گام موفق ماند؛ سرویس بالا نیامد؛ پس از رفع تعارض ادامه یافت |
| Migration مخرب | ✅ هیچ (فقط `ALTER TABLE ADD COLUMN`/`CREATE INDEX IF NOT EXISTS`) |
| پایگاه‌دادهٔ جدید | ✅ همهٔ گام‌ها در نصب تازه اعمال و ثبت شدند |

---

## ۱۰. وضعیت Data Retention

| بررسی | نتیجه |
| --- | --- |
| اجرای آزمایشی | ✅ `counts` گزارش شد، صفر حذف |
| ترتیب صحیح | ✅ تجمیع روزانه پیش از حذف نمونه |
| روز تجمیع‌نشده | ✅ حذف نمونه متوقف می‌شود (`blocked: missing_daily_stats`) |
| Legal Hold | ✅ اجرای خودکار و دستی رد می‌شود |
| خاموش‌بودن سیاست | ✅ اجرای خودکار رد؛ اجرای دستی صریح مجاز |
| توقف بین Batch | ✅ `status: stopped` و ادامه در اجرای بعد |
| اجرای هم‌زمان | ✅ `409` با قفل پایگاه‌داده |
| Crash وسط اجرا | ✅ `interrupted` و آزادسازی قفل منقضی |
| حذف پشتیبان | ✅ فقط با `retention_prune_backups=true` |
| حذف ناخواسته داده | ✅ مشاهده نشد |

---

## ۱۱. دستورالعمل نصب و ارتقا

### نصب (خلاصهٔ اجرایی)

```bash
# پیش‌نیاز: Node.js ≥ 22.12
npm ci
npm run build
NETWATCH_DATA_DIR=/var/lib/netwatch \
NETWATCH_ADMIN_PASSWORD='<قوی>' \
NETWATCH_SEED_DEMO=0 \
HOST=0.0.0.0 PORT=8787 \
npm start
```

تولیدی با systemd، TLS و مجوزها: [INSTALL.md](../INSTALL.md).

### ارتقا

```bash
npm run release:prepare                 # پشتیبان + آرشیو + SHA-256 نسخهٔ فعلی
sudo systemctl stop netwatch
tar -xzf netwatch-1.2.0.tar.gz -C /opt/netwatch --strip-components=1
npm ci --omit=dev && npm run build
sudo systemctl start netwatch          # Migration خودکار + pre-migration backup
curl -fsS http://127.0.0.1:8787/api/health
npm run db:doctor
```

Rehearsal روی کپی داده و مسیر بازگشت: [UPGRADE.md](../UPGRADE.md).

### بررسی پس از انتشار

```bash
curl -fsS http://127.0.0.1:8787/api/system/health   # پس از ورود، version=1.2.0
npm run db:doctor
npm run db:backup
```

---

## ۱۲. تصمیم نهایی

# ✅ GO — انتشار 1.2.0 تأیید می‌شود

دلایل:

1. تمام آزمون‌های ضروری سبز است (۴۴۷ بررسی، ۰ شکست) و هیچ آزمونی حذف/غیرفعال نشده.
2. هیچ باگ P0 یا P1 باز وجود ندارد؛ ۵ باگ شناسایی‌شده در این فاز اصلاح و آزمون شدند.
3. `npm audit` صفر آسیب‌پذیری؛ RBAC همهٔ مسیرها با آزمون مستقل از فهرست دستی تأیید شد.
4. Backup/Restore و Restart با دادهٔ واقعی (۵۰ تجهیز، ۸۴k نمونه) تأیید شد.
5. Retention بدون حذف ناخواسته کار می‌کند و پیش‌شرط تجمیع را رعایت می‌کند.
6. ارتقا از schema v3 و نصب تمیز موفق؛ Migration مخرب وجود ندارد و نقطهٔ بازگشت معتبر است.
7. رابط کاربری در سناریوهای اصلی (ورود، CRUD، Import، نقشه، SSE/کهنه، خطا، Viewer،
   موبایل) بدون خطا اجرا شد.

شرایط همراه انتشار (خارج از دامنهٔ کد):

- اجرای `npm run qa:soak72` روی سرور اختصاصی پیش از بهره‌برداری گسترده.
- کپی پشتیبان‌ها به مقصد جدا از دیسک سرویس.
- تنظیم `NETWATCH_ADMIN_ALLOWED_CIDRS` و `NETWATCH_SEED_DEMO=0` در Production.

---

## پیوست A: ماتریس سناریوهای خرابی

| سناریو | آزمون | رفتار تأییدشده |
| --- | --- | --- |
| Restart ناگهانی | `db-crash-recovery` | WAL replay، دادهٔ تأییدشده سالم |
| SIGTERM | `shutdown-resources`, `release-scenario` | خروج ۰، تخلیه، Checkpoint |
| SIGKILL | `db-crash-recovery`, `engine-crash` | تراکنش نیمه‌کاره Rollback، قفل با Fencing آزاد |
| دیتابیس خراب | `upgrade-and-install` | توقف با پیام روشن؛ `warn` فقط با تصمیم صریح |
| فضای دیسک ناکافی | `disk-full` (unit + integration) | `507`/خطای روشن، بدون نوشتن ناقص |
| فایل Backup نامعتبر | `backup-conditions` | رد با checksum/integrity، بدون تغییر داده |
| فایل Import خراب | `malicious`, `security`, `endpoints` | `400/413/415`، بدون ردیف ناقص |
| قطع شبکهٔ داخلی | `ping`, `net-policy-hardening`, `sse-reconnect` | خطای شبکه ≠ قطعی سرویس؛ SSE بازمی‌گردد |
| توقف Engine | `engine-lifecycle`, `engine-resilience` | تخلیه/ابطال، بدون رکورد نیمه‌کاره |
| از دست رفتن Lease | `leader-fencing`, `engine-fencing` | Fencing Token مانع نوشتن رهبر قدیم |
| خطای Migration | `upgrade-and-install`, `db-migration` | گام اتمیک، توقف، ادامه پس از رفع، پشتیبان بازگشت |

## پیوست B: فایل‌های تغییر‌یافتهٔ اصلی

| فایل | تغییر |
| --- | --- |
| `web/src/lib/params.ts` (جدید) | قلاب و تابع خالص ادغام پارامترهای آدرس |
| `web/src/pages/Devices.tsx`, `MapPage.tsx` | استفاده از قلاب جدید (رفع باگ فیلتر) |
| `web/src/App.tsx`, `components/Layout.tsx` | مسیر `/app-health` |
| `web/src/lib/api.ts` | اصلاح قرارداد `/api/settings` |
| `server/index.js` | نسخه از `package.json` + `NETWATCH_SEED_DEMO` |
| `server/config.js` | گزینهٔ `seedDemo` |
| `server/scripts/e2e-server.mjs` | سقف نرخ ورود مخصوص محیط آزمون UI |
| `.github/workflows/*` (جدید) | CI، Performance، Release |
| `server/tests/**` (چهار فایل جدید) | RBAC Matrix، Contract، Release Scenario، Upgrade/Install |
| مستندات ریشه | ۸ سند جدید + به‌روزرسانی README/SECURITY |
