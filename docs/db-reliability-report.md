# گزارش پایداری پایگاه‌داده و جلوگیری از خرابی اطلاعات

**بخش دوم (P0)** — تاریخ: ۲۰۲۶‑۱۰‑۱۸ — دامنه: لایهٔ دادهٔ NetWatch (`node:sqlite`)

این گزارش خروجی الزامی کار است: **گزارش تست Transaction، Backup، Restore و Crash Recovery**،
همراه با سیاست دوام، ایندکس‌ها، بررسی SQL Injection و کنترل فضای دیسک.

---

## ۱. خلاصهٔ اجرایی

| معیار پذیرش | وضعیت | شاهد |
| --- | --- | --- |
| شکست در هر مرحله عملیات چندمرحله‌ای ⇒ Rollback کامل | ✅ | `db-transaction.test.mjs` (۸ تست) |
| هیچ رکورد ناقصی پس از شکست عملیات باقی نمی‌ماند | ✅ | همان + `db-stability.test.mjs` (ورود گروهی اتمیک) |
| تست SQLite Binding بدون خطا | ✅ | `db-binding.test.mjs` (۶ تست) |
| تست ثبت هم‌زمان اطلاعات | ✅ | دو فرآیند × ۲۵۰ درج = ۵۰۰ ردیف بدون گم‌شدن |
| اجرای Checkpoint موجب از دست رفتن اطلاعات نمی‌شود | ✅ | `checkpoint does not lose acknowledged data` |
| Backup معتبر تولید می‌شود | ✅ | `db-backup-restore.test.mjs` + `db:backup` |
| Restore روی دیتابیس آزمایشی موفق است | ✅ | Restore با `integrity_check` کامل و بازگشت دقیق داده |
| اطلاعات بازیابی‌شده با Backup مطابقت دارد | ✅ | مقایسهٔ تعداد ردیف‌ها + مقایسهٔ مقدار یکتای «قبل از پشتیبان» |
| قطع ناگهانی فرآیند باعث خرابی دیتابیس نمی‌شود | ✅ | `db-crash-recovery.test.mjs` (kill -9 در نوشتن و داخل تراکنش) |
| پاک‌سازی اطلاعات قدیمی سوابق ضروری را حفظ می‌کند | ✅ | `db-cleanup.test.mjs` (۳ تست) |

جمع تست‌های اختصاصی این بخش: **۴۰ تست، همه سبز** (`npm run test:db`).
کل مجموعهٔ پروژه نیز سبز است: `npm run verify` (lint + typecheck + build + unit + integration + e2e).

---

## ۲. تغییرات اصلی

| فایل | نقش |
| --- | --- |
| `server/db-errors.js` | دسته‌بندی استاندارد خطاهای SQLite (`DB_BUSY`, `DB_DISK_FULL`, `DB_CORRUPT`, `DB_CONSTRAINT`, `DB_BINDING`, …) + ثبت ساختاریافتهٔ SQL و منشأ خطا |
| `server/db-safety.js` | نرمال‌سازی مقادیر Bind، اعتبارسنجی شناسهٔ SQL، بررسی فضای دیسک |
| `server/db.js` | اتصال امن (`DatabaseHandle`)، `transaction()` با SAVEPOINT تودرتو، سیاست WAL/دوام، ایندکس‌های تازه، `checkDatabaseHealth`، `verifyDatabaseAtStartup` |
| `server/backup.js` | پشتیبان WAL‑سازگار (`checkpoint(TRUNCATE)` + `VACUUM INTO`)، مانیفست با SHA‑256، اعتبارسنجی، Restore اتمیک، زمان‌بند خودکار و Checkpoint دوره‌ای |
| `server/routes/system.js` | API سلامت/پشتیبان/بازیابی (فقط Administrator) |
| `server/engine.js` | اتمیک‌شدن ثبت نتیجهٔ بررسی، اتمیک‌شدن پنجرهٔ تعمیرات و هرس؛ حفظ قطعی باز و سوابق تعمیرات |
| `server/store.js` | اتمیک‌شدن `createDevice`, `updateDevice`, `deleteDevices`, `attachTags`, `closeDeviceMonitoringState`, `groupByName` |
| `server/routes/*` | اتمیک‌شدن ورود گروهی، عملیات گروهی، موقعیت نقشه، ورود علامت‌ها، تعمیرات، ویرایش لایه، به‌روزرسانی کاربر |
| `server/scripts/db-{backup,restore,doctor}.mjs` | ابزارهای عملیاتی خط فرمان |
| `server/tests/**/db-*.test.mjs` | ۴۰ تست پایداری داده |

---

## ۳. گزارش تست Transaction

نسخهٔ اجرا: `node --test server/tests/unit/db-transaction.test.mjs` → **۸/۸ موفق**

| تست | چه چیزی را اثبات می‌کند |
| --- | --- |
| `rollback of a multi-step operation leaves no partial record` | درج قطعی + نمونه + تغییر وضعیت در یک تراکنش؛ شکست عمدی در مرحلهٔ سوم ⇒ صفر قطعی، صفر نمونه، وضعیت تجهیز بدون تغییر |
| `nested transaction rolls back only the inner block` | SAVEPOINT: بلوک داخلی برمی‌گردد، بلوک بیرونی commit می‌شود (نمونه‌ها: `[1000, 3000]`) |
| `transaction rethrows business errors unchanged` | خطای اعتبارسنجی (`status: 400`) به خطای پایگاه‌داده تبدیل نمی‌شود |
| `createDevice is atomic` | شکست پس از درج تجهیز ⇒ نه ردیف تجهیز، نه تگ |
| `updateDevice validation failure keeps row and tags intact` | IP تکراری ⇒ تغییرات نیمه‌کارهٔ تگ‌ها هم برنمی‌گردد (برگشت کامل) |
| `closeDeviceMonitoringState ... atomically` | بستن قطعی + حل هشدار + پاک‌سازی وضعیت تجهیز، یک‌جا |
| `settings are written all-or-nothing` | همهٔ کلیدهای تنظیمات یا هیچ‌کدام |
| `connection survives close/reopen` | Prepared Statementهای ماژول‌های دیگر پس از Restore معتبر می‌مانند |

در سطح API: **ورود گروهی اتمیک** — فایل CSV با ۲ ردیف سالم و ۱ ردیف معیوب
(با `onlyValid=0`) ⇒ پاسخ `400`, `rolledBack: true` و صفر ردیف ثبت‌شده
(`server/tests/integration/db-stability.test.mjs`). پیش‌تر ردیف‌های سالم ثبت می‌شدند و
کاربر گمان می‌کرد همه ثبت شده است.

**نقاط چندمرحله‌ای پوشش‌داده‌شده:** ثبت هر بررسی موتور (قطعی/بازیابی + هشدار + نمونه + شاخص‌های تجهیز)،
عملیات گروهی تجهیزات، موقعیت‌های نقشه، ورود Excel/CSV، ورود علامت‌ها، و پنجرهٔ تعمیرات.

---

## ۴. گزارش تست Backup

نسخهٔ اجرا: `node --test server/tests/unit/db-backup-restore.test.mjs` → **۷/۷ موفق**

- **سازگاری با WAL:** پیش از پشتیبان‌گیری `PRAGMA wal_checkpoint(TRUNCATE)` اجرا می‌شود و
  سپس `VACUUM INTO` عکس لحظه‌ای تراکنشی می‌سازد. تجهیزی که «درست پیش از پشتیبان‌گیری»
  نوشته شده بود، داخل پشتیبان موجود است (تست‌شده)؛ حجم WAL پس از پشتیبان‌گیری به ≤۳۲KB می‌رسد.
- **مانیفست و checksum:** هر مجموعه شامل `manifest.json` با SHA‑256 پایگاه‌داده، هر فایل
  MBTiles، اندازه‌ها، تعداد ردیف‌های کلیدی و نتیجهٔ `integrity_check` است.
- **عدم باقی‌ماندن پشتیبان نیمه‌کاره:** نوشتن در پوشهٔ `.partial-*` و تغییر نام اتمیک در پایان؛
  در تست کمبود فضا هیچ پوشه و هیچ مدخلی باقی نمی‌ماند.
- **خروجی اندازه‌گیری‌شده (دادهٔ نمونه، ۸۴٬۶۷۲ نمونه):** ساخت پشتیبان ≈ **۱۸۰–۲۳۰ms** و حجم ≈ **۸.۷MB**.

نمونهٔ فرمان:

```bash
npm run db:backup                  # پشتیبان کامل (پایگاه‌داده + MBTiles)
npm run db:backup -- --no-mbtiles --keep=14
```

---

## ۵. گزارش تست Restore

| تست | نتیجه |
| --- | --- |
| بازیابی وضعیت دقیق پشتیبان | ✅ تعداد ردیف‌های devices/samples/outages/alerts دقیقاً برابر پشتیبان؛ مقدار `name` تا حد «BEFORE-RESTORE» برمی‌گردد و مقدار تغییر یافتهٔ پس از پشتیبان‌گیری ناپدید می‌شود |
| نسخهٔ ایمنی پیش از بازیابی | ✅ `netwatch.db.pre-restore-<ts>` ساخته می‌شود |
| رد پشتیبان خراب | ✅ دست‌کاری یک بایت ⇒ `checksum نامطابقت` + خطای ساختار و **صفر تغییر در دادهٔ فعلی** |
| Dry‑run | ✅ اعتبارسنجی بدون هیچ تغییری |
| بازیابی MBTiles | ✅ فایل نقشه پس از حذف، از پشتیبان بازگردانده می‌شود و SHA‑256 آن مطابق مانیفست است |
| سلامت پس از بازیابی | ✅ `integrity_check` کامل + `foreign_key_check` بدون خطا |
| محافظت مسیر | ✅ `POST /api/system/backups/restore` با نام `../../etc/passwd` ⇒ `400` |
| Restore از خط فرمان | ✅ `node server/scripts/db-restore.mjs <backup-dir> --force` دادهٔ قبلی را دقیقاً برمی‌گرداند |

RBAC: ساخت پشتیبان و بازیابی فقط با نقش `admin`؛ نقش `viewer` پاسخ `403` می‌گیرد (تست‌شده).

---

## ۶. گزارش تست Crash Recovery

نسخهٔ اجرا: `node --test server/tests/unit/db-crash-recovery.test.mjs` → **۳/۳ موفق**

1. **kill -9 در میانهٔ نوشتن‌های پیوسته** (۲۵۰ms پس از شروع درج مداوم):
   پس از قطع، `integrity_check` کامل = `ok`، نقض کلید خارجی = ۰، ردیف‌های commit‌شده سالم و
   هیچ ردیف ناقصی (NULL غیرمجاز) وجود ندارد.
2. **kill -9 داخل یک تراکنش چندمرحله‌ای** (درج + درج فرزند + به‌روزرسانی، سپس توقف):
   پس از قطع، **هیچ‌کدام** از سه تغییر باقی نمی‌ماند؛ SQLite با WAL تراکنش تأییدنشده را برمی‌گرداند.
3. **ادامهٔ کار پس از قطع**: نوشتن تازه موفق است و بررسی سلامت سبز می‌ماند (replay درست WAL).

خاموشی تمیز هم تضمین شده است: در SIGTERM/SIGINT، زمان‌بند متوقف و WAL با
`wal_checkpoint(TRUNCATE)` به فایل اصلی منتقل و اتصال بسته می‌شود (تست موجود `SIGTERM performs a graceful shutdown`).

---

## ۷. Binding، مقادیر ناسازگار و ثبت هم‌زمان

- `undefined` (که درایور با `Provided value cannot be bound` رد می‌کند) → `NULL`
- `NaN`/`Infinity` (که بی‌صدا `NULL` می‌شدند) → `NULL` صریح؛ در ستون `NOT NULL` خطای
  `DB_CONSTRAINT` داده می‌شود، نه رکورد ناقص
- `Boolean` → `0/1` (SQLite نوع BOOLEAN ندارد)
- `Date` → epoch milliseconds؛ `Buffer`/`Uint8Array` → BLOB
- `bigint` خارج از محدودهٔ امن → خطای روشن `DB_BINDING` (پیش‌تر در زمان **خواندن** `RangeError` می‌داد)
- شیء/آرایه/پارامتر نام‌دار → `DB_BINDING` با پیام فارسی، بدون نوشتن نیمه‌کاره
- **ثبت هم‌زمان:** دو فرآیند هم‌زمان روی یک فایل (سرور + engine-cli) هرکدام ۲۵۰ ردیف نوشتند؛
  هر ۵۰۰ ردیف باقی ماند و هیچ خطای `SQLITE_BUSY` رخ نداد (`busy_timeout=5000` + تلاش دوباره).

---

## ۸. ایندکس‌ها و بهینه‌سازی با EXPLAIN QUERY PLAN

ایندکس‌های تازه (همه با `IF NOT EXISTS` وابسته به پرس‌وجوهای واقعی برنامه):

```
idx_alerts_duplicate          alerts(duplicate_key, created_at DESC)
idx_alerts_device_status      alerts(device_id, status, kind)
idx_outages_open              outages(device_id) WHERE open = 1
idx_outages_closed_started    outages(started_at) WHERE open = 0
idx_maint_outage              maintenance_records(outage_id)
idx_windows_device            maintenance_windows(device_id, enabled)
idx_samples_device_ok         samples(device_id, ok, ts DESC)
idx_devices_type              devices(device_type)
idx_devices_priority          devices(priority)
```

نمونهٔ خروجی `npm run db:doctor` (پایگاه‌دادهٔ نمونه، ۸۴٬۶۷۲ نمونه / ۱٬۲۹۱ قطعی):

| پرس‌وجوی داغ | پلن |
| --- | --- |
| تجهیزات سررسیدشده | `SEARCH devices USING INDEX idx_devices_due` |
| سری نمودار | `SEARCH samples USING INDEX idx_samples_device_ts` |
| شمارش موفقیت‌ها | `SEARCH samples USING COVERING INDEX idx_samples_device_ok` |
| قطعی‌های یک تجهیز | `SEARCH outages USING INDEX idx_outages_device` |
| قطعی باز | `SEARCH outages USING INDEX idx_outages_open` |
| ضدتکرار هشدار | `SEARCH alerts USING COVERING INDEX idx_alerts_duplicate` |
| هرس نمونه‌ها | `SEARCH samples USING COVERING INDEX idx_samples_ts` |
| هرس قطعی‌ها | `SEARCH o USING COVERING INDEX idx_outages_closed_started` + `SEARCH m USING COVERING INDEX idx_maint_outage` |
| هرس نشست‌ها | `SEARCH sessions USING COVERING INDEX idx_sessions_expires` |
| سابقهٔ تعمیرات هر قطعی | `SEARCH maintenance_records USING COVERING INDEX idx_maint_outage` |

هیچ پرس‌وجویی روی جدول بزرگ پیمایش کامل (SCAN بدون INDEX) ندارد؛ این موضوع در
`db-query-plan.test.mjs` به‌صورت خودکار تست می‌شود و `npm run db:doctor` با کد خروج ۱
هر رگرسیون را گزارش می‌کند. `PRAGMA optimize` هم در هر راه‌اندازی اجرا می‌شود.

**اندازه‌گیری واقعی** (`COUNT(*) … WHERE device_id = ? AND ok = 1` روی ۸۴٬۶۷۲ نمونه،
۲۰۰۰ اجرا):

| حالت | زمان هر پرس‌وجو |
| --- | --- |
| با `idx_samples_device_ok` | **۰٬۰۶۵ms** |
| بدون ایندکس (اسکن کامل) | **۴٬۴۸ms** |

≈ **۶۸ برابر** سریع‌تر. همچنین ۲۰ سری نمودار با تمام بازهٔ تاریخچه در **۲۷ms** و
۲۰۰۰ جست‌وجوی ضدتکرار هشدار در **۹ms** پاسخ می‌دهند.

---

## ۹. سیاست WAL، Checkpoint و دوام تراکنش‌ها

| تنظیم | مقدار | دلیل |
| --- | --- | --- |
| `journal_mode` | `WAL` | خواندن هم‌زمان بدون قفل نوشتن |
| `synchronous` | **`FULL`** | تراکنش تأییدشده پس از قطع برق از دست نرود؛ با `NETWATCH_SQLITE_SYNC=NORMAL` قابل کاهش آگاهانه |
| `wal_autocheckpoint` | ۱۰۰۰ صفحه (≈۴MB) | جلوگیری از رشد WAL |
| `journal_size_limit` | ۶۴MB | سقف رشد WAL در نوشتن‌های پرحجم |
| `busy_timeout` | ۵۰۰۰ms | نوشتن هم‌زمان سرور/engine-cli |
| Checkpoint دوره‌ای | هر ۱۵ دقیقه (`checkpoint_interval_minutes`) | کوتاه‌ماندن WAL و بازگشایی سریع |
| Checkpoint در خاموشی/پشتیبان‌گیری | `TRUNCATE` | دوام و سازگاری پشتیبان |

`busy` بودن Checkpoint وضعیت خطا نیست؛ به‌عنوان هشدار ثبت و در اجرای بعدی تکرار می‌شود
(نمونه: `wal_checkpoint_busy`). اجرای Checkpoint هیچ رکوردی را حذف نمی‌کند (تست `checkpoint does not lose acknowledged data`).

---

## ۱۰. Backup خودکار و هماهنگی با MBTiles

- زمان‌بند هر ۶۰ ثانیه بیدار می‌شود و بر اساس تنظیمات `backup_enabled`, `backup_interval_hours` (پیش‌فرض ۲۴) و
  `backup_keep` (پیش‌فرض ۷) پشتیبان می‌سازد؛ در نصب تازه، نخستین پشتیبان چند ثانیه پس از راه‌اندازی ساخته می‌شود
  (در لاگ: `backup_scheduler_started` → `backup_created`).
- فقط نمونهٔ رهبر موتور پشتیبان می‌گیرد تا اجرای هم‌زمان سرور و `engine-cli` پشتیبان تکراری نسازد.
- **هماهنگی MBTiles:** فایل‌های `.mbtiles` پس از عکس لحظه‌ای پایگاه‌داده کپی می‌شوند؛ اندازه و `mtime`
  مبدأ پیش و پس از کپی مقایسه و در صورت تغییر، کپی تکرار می‌شود. همهٔ فایل‌ها در همان مانیفست با SHA‑256 ثبت
  و در بازیابی با تأیید checksum بازگردانده می‌شوند.
- نگهداری: پشتیبان‌های قدیمی‌تر از سقف نگهداری (فقط مجموعه‌های معتبر) حذف می‌شوند.

---

## ۱۱. کنترل فضای دیسک

- `NETWATCH_MIN_FREE_BYTES` (پیش‌فرض ۶۴MB) به‌عنوان ذخیرهٔ امن در همهٔ برآوردها لحاظ می‌شود.
- پیش از پشتیبان‌گیری: `۲× حجم پایگاه‌داده + حجم MBTiles + ۸MB` بررسی می‌شود.
- پیش از بازیابی، ورود گروهی و هر عملیات پرحجم دیگر نیز بررسی انجام می‌شود.
- کمبود فضا ⇒ خطای استاندارد `DB_DISK_FULL` (HTTP 507) و **هیچ تغییری ثبت نمی‌شود**؛
  در صورت پر شدن دیسک وسط تراکنش، همان تراکنش یک‌جا Rollback می‌شود.
- تست `db-disk-space.test.mjs`: در شرایط «فضای ناکافی» نه پوشهٔ نیمه‌کاره‌ای باقی می‌ماند و نه مدخلی در فهرست پشتیبان.

---

## ۱۲. پاک‌سازی اطلاعات قدیمی (Retention)

سیاست بازنویسی‌شده در موتور:

1. **ترتیب چرخه:** نخست تجمیع روزانه (`daily_stats`) و سپس هرس — تا نمونه‌های دیروز پیش از
   تجمیع حذف نشوند.
2. **نمونه‌ها:** هرگز جدیدتر از شروع دیروز حذف نمی‌شوند، حتی با `retention_days=1`.
3. **قطعی‌ها:** فقط قطعی‌های **بسته** و قدیمی‌تر از بازهٔ نگهداری؛ **قطعی باز هرگز حذف نمی‌شود** و
   قطعی‌ای که سابقهٔ تعمیرات به آن ارجاع دارد (`maintenance_records.outage_id`) حفظ می‌شود.
4. **هشدارها:** فقط `resolved`/`suppressed`؛ هشدار فعال/تأییدشده و هشدار تجهیزی که قطعی باز دارد باقی می‌ماند.
5. **لاگ موتور:** ۱۴ روز.
6. هرس در یک تراکنش انجام می‌شود (سقف ۵۰٬۰۰۰ ردیف در هر اجرا) تا شکست میانی چیزی را نیمه‌حذف نکند.

آزمون `db-cleanup.test.mjs`: قطعی باز و قطعی متصل به تعمیرات و هشدار ضروری حفظ می‌شوند،
نمونه‌های ۳۰ روز پیش حذف و نمونه‌های دیروز/امروز حفظ می‌شوند، و شکست میانی هیچ حذفی باقی نمی‌گذارد.

---

## ۱۳. بازبینی SQL Injection

- همهٔ مقادیر کاربر با پارامتر (`?`) بایند می‌شوند؛ هیچ مقدار کاربر در متن SQL درج نمی‌شود.
- جاهایی که SQL داینامیک است فقط از فهرست بسته می‌آیند: `DEVICE_SORTS` (نام ستون مرتب‌سازی)،
  `ASC|DESC`, `INSERT_FIELDS`, `UPDATE_FIELDS` و رشته‌های `?,?,…` برای `IN`.
- نام جدول در مهاجرت‌ها با `assertSqlIdentifier()` اعتبارسنجی می‌شود.
- تست خودکار `source audit`: تمام template literalهای حاوی SQL در `server/**` پیمایش می‌شوند و هر
  درج `${…}` که در فهرست سفید مجاز نباشد (یا `?` تولید نکند / با `assertSqlIdentifier` اعتبارسنجی نشود)
  تست را می‌شکند — یعنی افزودن یک درج ناایمن در آینده بلافاصله دیده می‌شود.
- تست رفتاری: چهار حملهٔ تزریق از طریق `search/status/sort/order/group/tag` بی‌اثرند و جدول‌ها سالم می‌مانند.

---

## ۱۴. راهنمای عملیاتی

```bash
# پشتیبان دستی (خروجی JSON برای Cron)
npm run db:backup

# بررسی سلامت و کارایی؛ کد خروج ۱ در صورت مشکل
npm run db:doctor

# اعتبارسنجی بدون تغییر
npm run db:restore -- <backup-dir> --dry-run

# بازیابی (سرویس را متوقف کنید)
npm run db:restore -- data/backups/netwatch-20261018-180809-98f06f --force
```

| متغیر محیطی | پیش‌فرض | توضیح |
| --- | --- | --- |
| `NETWATCH_BACKUP_DIR` | `<DATA_DIR>/backups` | پوشهٔ پشتیبان‌ها |
| `NETWATCH_SQLITE_SYNC` | `FULL` | سیاست دوام (`FULL`/`NORMAL`) |
| `NETWATCH_BUSY_TIMEOUT_MS` | `5000` | انتظار برای قفل نوشتن |
| `NETWATCH_MIN_FREE_BYTES` | `67108864` | ذخیرهٔ امن فضای دیسک |
| `NETWATCH_DB_CHECK` | `quick` | بررسی راه‌اندازی: `quick`/`full`/`warn`/`off` |
| `NETWATCH_LOG_STREAM` | — | با مقدار `stderr` همهٔ لاگ‌ها به stderr (خروجی JSON ابزارهای CLI) |

تنظیمات قابل تغییر از UI: `backup_enabled`, `backup_interval_hours`, `backup_keep`,
`checkpoint_interval_minutes`, `retention_days`.

### API

| مسیر | دسترسی | کار |
| --- | --- | --- |
| `GET /api/system/db/health` | `system:health` | سلامت، WAL، دیسک، فهرست جدول‌ها، وضعیت پشتیبان |
| `POST /api/system/db/checkpoint` | admin | Checkpoint دستی |
| `GET/POST /api/system/backups` | خواندن: `system:health` — ساخت: admin | فهرست/ساخت پشتیبان |
| `POST /api/system/backups/verify` | admin | اعتبارسنجی پیش از بازیابی |
| `POST /api/system/backups/restore` | admin | بازیابی (`dryRun` هم پشتیبانی می‌شود) |

---

## ۱۵. محدودیت‌ها و کارهای بعدی

- `VACUUM INTO` و Checkpoint همگام (synchronous) هستند؛ برای پایگاه‌داده‌های چند گیگابایتی
  اجرای آن‌ها یک وقفهٔ کوتاه در حلقهٔ رویداد ایجاد می‌کند. مقدار اندازه‌گیری‌شده برای ۸.۷MB
  حدود ۲۰۰ms است؛ در صورت رشد داده، انتقال پشتیبان‌گیری به فرآیند فرزند توصیه می‌شود.
- `synchronous=FULL` هزینهٔ نوشتن دارد؛ برای نصب‌های پرنوشت می‌توان (آگاهانه) به `NORMAL` رفت.
- Restore درون‌فرآیندی موتور را متوقف/راه‌اندازی می‌کند؛ اگر نمونهٔ دیگری (engine-cli) فعال باشد
  باید پیش از بازیابی متوقف شود (بازیابی از CLI بدون `--force` این موضوع را تشخیص می‌دهد).
- رمزنگاری فایل‌های پشتیبان در دامنهٔ این بخش نبود؛ پوشهٔ پشتیبان باید روی رسانهٔ محافظت‌شده باشد.
