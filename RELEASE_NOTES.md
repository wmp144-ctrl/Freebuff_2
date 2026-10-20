# یادداشت انتشار NetWatch 1.2.0

| مورد | مقدار |
| --- | --- |
| نسخه | `1.2.0` |
| تاریخ | 2026-10-20 |
| نسخهٔ ساختار داده | `SCHEMA_VERSION = 5` (بدون Migration جدید) |
| سازگاری داده | ارتقا از `1.1.0` بدون تغییر ساختار؛ ارتقا از `1.0.0` با Migrationهای ۲–۵ |
| نقطهٔ بازگشت | `npm run release:prepare` پیش از ارتقا (پشتیبان + آرشیو کد + SHA-256) |
| تصمیم | **Go** برای انتشار، با رعایت موارد بخش ۷ |

این نسخه، نسخهٔ **تثبیت کیفیت و آماده‌سازی Production** است: تمرکز آن روی
یکپارچگی Backend/Frontend، پوشش RBAC همهٔ مسیرها، آزمون سناریوی کامل نصب تا
بازیابی، Pipeline استاندارد و مستندات عملیاتی است. قابلیت جدید کاربری اضافه
نشده؛ بلکه رفتارهای موجود سخت‌تر آزموده و دو باگ واقعی رابط کاربری اصلاح شده
است.

---

## ۱. اصلاح باگ‌ها

| باگ | اثر | اصلاح |
| --- | --- | --- |
| گم‌شدن پارامتر جست‌وجو هنگام کلیک سریع فیلتر (صفحهٔ تجهیزات و نقشه) | فهرست با فیلتر کهنه نمایش داده می‌شد و شمارش اشتباه بود | قلاب مشترک `useUrlParams` با نگه‌داشتن آخرین مقدار در `ref`؛ ادغام پارامترها در تابع خالص و آزمون‌شده |
| ناسازگاری تایپ پاسخ `GET /api/settings` با قرارداد واقعی (`dbSize`/`paths` وجود نداشت) | ریسک خطای زمان اجرا و گمراهی توسعه‌دهنده | تایپ به شکل واقعی (`settings`, `engine`, `icmpAvailable`, `sampleCount`) اصلاح شد |
| مجوز فایل پشتیبان پایگاه‌داده با umask سیستم (روی سرورهای معمول 644) | پشتیبان شامل کاربران و حسابرسی ممکن بود برای گروه/دیگران خواندنی باشد | `chmod 600` پس از `VACUUM INTO` + آزمون مجوز در سناریوی انتشار |
| نمونهٔ Nginx بدون هدرهای امنیتی و آزمون ایستای پیکربندی استقرار | پیکربندی تولیدی مستند، HSTS/nosniff نداشت | هدرهای امنیتی اضافه و آزمون `deploy-config` (systemd + Nginx) اضافه شد |
| نسخهٔ نادرست در `/api/system/health` هنگام اجرا با systemd (`npm_package_version` خالی → `1.0.0`) | گزارش نسخه در پایش و تأیید انتشار نادرست بود | نسخه از `package.json` خوانده می‌شود؛ آزمون قرارداد آن را تضمین می‌کند |

اصلاح‌های آزمون (بدون تضعیف پوشش):

- انتخابگر عنوان «سلامت برنامه» با `getByRole` محدود به همان بخش شد (دو عنصر
  هم‌نام در منو و سرتیتر وجود داشت).
- الگوی مسدودسازی SSE در آزمون Playwright به `**/api/events*` اصلاح شد؛ پیش‌تر
  رشتهٔ پرس‌وجو پوشش داده نمی‌شد و سناریوی «دادهٔ کهنه» واقعاً اتصال را قطع
  نمی‌کرد.

---

## ۲. افزوده‌ها

- `NETWATCH_SEED_DEMO` (پیش‌فرض `1`): در نصب واقعی با `0` هیچ دادهٔ نمایشی
  بارگذاری نمی‌شود و تنها حساب مدیر ساخته می‌شود.
- آزمون `rbac-matrix`: فهرست مسیرها از خود روتر خوانده می‌شود و برای هر مسیر
  تغییردهنده، نبود دسترسی Viewer و مرزهای Operator بررسی می‌شود.
- آزمون `api-contract`: شکل پاسخ ۹ گروه اصلی API با تایپ‌های رابط کاربری تطبیق
  داده می‌شود (دستگاه، داشبورد، وضعیت، تنظیمات، Retention، پشتیبان، گزارش،
  هشدار، زیرمنابع جزئیات تجهیز).
- آزمون `release-scenario`: نصب تازه → Migration → ورود → کاربران/نقش‌ها →
  تجهیز → Probe → Sample → Outage/Alert → داشبورد → SSE و اتصال مجدد → Import
  → Backup → Retention (dry-run) → Restore → Restart → تأیید داده.
- آزمون `upgrade-and-install`: نصب تمیز بدون دادهٔ نمایشی، ارتقا از schema v3
  روی دادهٔ پرشده با نقطهٔ بازگشت، شکست اتمیک Migration، و پایگاه‌دادهٔ خراب.
- Pipeline استاندارد `.github/workflows/ci.yml` (lint/typecheck/build/unit/web/
  integration/e2e/Playwright/audit/db/engine) و Workflow جدا برای آزمون‌های
  سنگین (`performance.yml`) و Artifact/Checksum انتشار (`release.yml`).
- مستندات عملیاتی جدید: `INSTALL.md`، `UPGRADE.md`، `DATABASE.md`،
  `BACKUP_RESTORE.md`، `DATA_RETENTION.md`، `OPERATIONS.md`،
  `TROUBLESHOOTING.md` و همین یادداشت.

---

## ۳. تغییر رفتار مورد انتظار

| مورد | قبل | بعد | دلیل | آزمون جایگزین |
| --- | --- | --- | --- | --- |
| نصب تمیز | همیشه دادهٔ نمایشی | قابل خاموش‌کردن با `NETWATCH_SEED_DEMO=0` | جلوگیری از قاطی‌شدن دادهٔ نمونه با دادهٔ سازمان | `upgrade-and-install` (نصب تمیز) + `config` (پیش‌فرض‌ها) |
| پارامترهای آدرس | آخرین رندر | آخرین مقدار ارسال‌شده (ref) | دو به‌روزرسانی هم‌زمان نباید گم شوند | `web/tests/params.test.ts` + UI test فیلتر/جدول |
| گزارش نسخه | `npm_package_version` | `package.json` | اجرای مستقیم با systemd | `api-contract` |
| `npm run test:ui` | بدون Pin و آسیب‌پذیری High در Playwright | `@playwright/test@1.55.1` | بستن `GHSA-7mvr-c777-76hp` | `npm audit --audit-level=high` در CI |

هیچ آزمون قبلی حذف یا غیرفعال نشده است؛ فقط دو انتخابگر آزمون دقیق‌تر شده‌اند
(جزئیات در بخش ۱).

---

## ۴. نتایج تأیید (چکیده)

| سنجه | نتیجه |
| --- | --- |
| Lint / Typecheck / Build | ✅ |
| Unit / Web / Integration / E2E | ✅ (جزئیات در `docs/release-readiness-1.2.0.md`) |
| Browser E2E (Playwright) | ✅ ۹ سناریو |
| `npm audit` | ✅ ۰ آسیب‌پذیری |
| RBAC همهٔ مسیرها | ✅ Viewer روی هیچ مسیر تغییردهنده موفق نشد |
| Backup/Restore و Retention dry-run | ✅ بدون حذف ناخواسته |
| Migration | ✅ بدون Migration جدید؛ ارتقا v3→v5 آزمون‌شده |
| نصب تمیز و ارتقا | ✅ روی دادهٔ کپی‌شده |

---

## ۵. ارتقا

```bash
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch npm run release:prepare
sudo systemctl stop netwatch
sudo -u netwatch tar -xzf netwatch-1.2.0.tar.gz -C /opt/netwatch --strip-components=1
cd /opt/netwatch && sudo -u netwatch npm ci --omit=dev && sudo -u netwatch npm run build
sudo systemctl start netwatch
curl -fsS http://127.0.0.1:8787/api/health
```

رویهٔ کامل و Rollback: [UPGRADE.md](UPGRADE.md).

---

## ۶. سازگاری پشتیبان

پشتیبان‌های `1.1.0` (schema 5) بدون تغییر روی `1.2.0` بازیابی می‌شوند. پشتیبان
`schemaVersion > 5` روی این نسخه رد می‌شود. ساختار داده تغییر نکرده است.

---

## ۷. موارد باز و محدودیت‌ها

1. **Soak 24/72 ساعته** روی سرور اختصاصی اجرا نشده است؛ هارنس با اجرای کوتاه
   تأیید شده است. توصیه: پیش از بهره‌برداری گسترده، `npm run qa:soak72` اجرا شود.
2. **آزمون مرورگر** در این محیط با Chromium انجام شده؛ Safari/Firefox در CI
   پوشش داده نمی‌شوند (RTL/فونت و Responsive در Chromium تأیید شده است).
3. **ICMP واقعی** نیازمند `CAP_NET_RAW` است؛ در محیط آزمون حالت TCP استفاده شد.
4. بدون تغییر: تک‌نمونه‌ای بودن SQLite و نیاز به دیسک محلی با کارایی مناسب.

هیچ باگ P0/P1 باز شناخته‌شده‌ای وجود ندارد. موارد بالا محدودیت محیط/استقرار
هستند، نه نقص عملکردی.

---

## ۸. فایل‌های انتشار

```text
netwatch-1.2.0.tar.gz        # سورس کامل (git archive)
netwatch-web-1.2.0.tar.gz    # خروجی Build رابط کاربری (web/dist)
SHA256SUMS                   # checksum هر دو فایل
```

```bash
sha256sum -c SHA256SUMS
```
