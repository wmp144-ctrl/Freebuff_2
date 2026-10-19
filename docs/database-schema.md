# مستند ساختار پایگاه‌داده NetWatch

**فاز ۲ — تثبیت دیتابیس، صحت اطلاعات و Data Retention** · نسخهٔ Schema: **۳**
موتور: `node:sqlite` (ماژول داخلی Node ≥ ۲۲٫۱۲، بدون وابستگی بومی) · تاریخ: ۲۰۲۶‑۱۰‑۱۹

---

## ۱. اصول کلی

| اصل | تصمیم | دلیل |
| --- | --- | --- |
| مکان داده | یک فایل SQLite: `data/netwatch.db` | سامانه کاملاً آفلاین؛ پشتیبان‌گیری/بازیابی یک فایل + MBTiles |
| کلید اصلی | `INTEGER PRIMARY KEY AUTOINCREMENT` (یا کلید ترکیبی طبیعی) | پایدار ماندن ارجاع‌ها پس از حذف ردیف‌های میانی |
| کلید خارجی | فعال (`PRAGMA foreign_keys = ON`) با سیاست صریح | جلوگیری از رکورد یتیم |
| زمان | **epoch milliseconds (INTEGER، UTC)** برای همهٔ رخدادها | مقایسه/مرتب‌سازی مستقل از منطقهٔ زمانی و تغییر ساعت |
| «روز» تجمیعی | متن `YYYY-MM-DD` بر پایهٔ **نیمه‌شب محلی** (`timezone_offset_minutes`) | تطبیق گزارش‌ها با نمودارها و برچسب‌های UI |
| متن | UTF‑8؛ `COLLATE NOCASE` فقط برای یکتایی نام کاربری | یکتایی `admin`/`Admin` بدون تغییر رفتار مقایسهٔ متن فارسی |
| بولی | `INTEGER 0/1` با `NOT NULL DEFAULT` | SQLite نوع BOOLEAN ندارد |
| Migration | گام‌های نسخه‌بندی‌شده در جدول `schema_migrations` + `PRAGMA user_version` | هیچ تغییر ساختاری بدون ثبت و پشتیبان پیش از مهاجرت انجام نمی‌شود |

## ۲. نمودار روابط

```
groups ──< devices >── map_layers
   │            │  │
   │            │  └──< device_tags >── tags
   │            │
   │            ├──< samples          (ON DELETE CASCADE)
   │            ├──< outages ──< maintenance_records (ON DELETE SET NULL)
   │            ├──< alerts  >── alert_rules ──> groups (SET NULL)
   │            ├──< daily_stats      (CASCADE)
   │            └──< maintenance_windows (CASCADE)
marker_types ──< map_markers (SET NULL)
users ──< sessions (CASCADE)
audit_log / engine_log / settings / engine_lock / engine_meta / runtime_state
retention_runs / retention_state / schema_migrations
```

## ۳. جدول‌ها (۲۵ جدول)

### ۳٫۱ حوزهٔ پایش

| جدول | نقش | کلیدها و قیدهای مهم |
| --- | --- | --- |
| `devices` | هر تجهیز و آخرین وضعیت پایش | `PRIMARY KEY(id)`؛ **`idx_devices_ip` یکتا** روی `ip`؛ `UNIQUE` مستقیم ندارد اما `ip` یکتاست؛ `group_id`/`map_layer_id` با `SET NULL` |
| `samples` | نتیجهٔ هر بررسی | FK `device_id → devices` (CASCADE)؛ **قید جزئی یکتا `idx_samples_operation` روی `(device_id, started_at) WHERE started_at IS NOT NULL`** ⇒ «یک نتیجه برای هر عملیات» |
| `outages` | بازه‌های قطعی | FK `device_id` (CASCADE)؛ **قید جزئی یکتا `idx_outages_open` روی `(device_id) WHERE open = 1`** ⇒ حداکثر یک قطعی باز برای هر تجهیز (نه فقط قاعدهٔ کد) |
| `daily_stats` | تجمیع روزانه (منبع گزارش بلندمدت) | `PRIMARY KEY(device_id, day)`؛ نگهداری حداقل ۳۶۵ روز |
| `maintenance_records` | سوابق تعمیرات و علت/اقدام | FK `device_id` (CASCADE)، FK `outage_id` (**SET NULL**) — پیوند سند با قطعی هرگز یتیم نمی‌شود |
| `maintenance_windows` | پنجره‌های توقف بررسی | FK `device_id` (CASCADE)، `device_id = NULL` یعنی سراسری |
| `alert_rules` | قواعد هشدار | FK `scope_group_id → groups` (SET NULL) |
| `alerts` | هشدارها | FK `device_id` (CASCADE)، `rule_id` (SET NULL)؛ `duplicate_key` برای ضدتکرار |
| `engine_log` | لاگ رویدادهای موتور | نگهداری ۳۰ روز (قابل تنظیم) |
| `groups` / `tags` / `device_tags` | دسته‌بندی | `name` یکتا؛ `device_tags` کلید ترکیبی و CASCADE دوطرفه |

### ۳٫۲ حوزهٔ نقشه

| جدول | نکته |
| --- | --- |
| `map_layers` | لایه‌های داخلی/MBTiles؛ حذف لایه تجهیزات را یتیم نمی‌کند (`SET NULL`) |
| `marker_types` | نام یکتا |
| `map_markers` | `type_id` با `SET NULL`؛ مختصات اجباری |

### ۳٫۳ حوزهٔ امنیت و زمان اجرا

| جدول | نکته |
| --- | --- |
| `users` | `username` یکتا با `COLLATE NOCASE`؛ فقط هش Argon2id/scrypt |
| `sessions` | کلید اصلی = SHA‑256 توکن؛ FK `user_id` (CASCADE) |
| `audit_log` | `ts` + کنش/کاربر/هدف/IP/وضعیت/جزئیات؛ نگهداری حداقل ۳۶۵ روز؛ هیچ Secret ذخیره نمی‌شود |
| `settings` | `key` یکتا، مقدار JSON متنی |
| `engine_lock` / `engine_meta` | قفل رهبری + Fencing Token (`epoch`) |
| `runtime_state` | وضعیت کوچک زمان اجرا (مثلاً آخرین ساعت مشاهده‌شده) |
| `schema_migrations` | نسخه، نام، زمان و مدت هر مهاجرت |
| `retention_runs` | یک ردیف برای هر اجرای Retention (Dry-Run هم ثبت می‌شود) |
| `retention_state` | قفل تک‌نمونه، پرچم توقف، آخرین نتیجه و `next_run_at` |

## ۴. فهرست ایندکس‌ها و دلیل هر یک (۳۹ ایندکس)

| ایندکس | پرس‌وجوی پشتیبانی‌شده |
| --- | --- |
| `idx_devices_ip` (یکتا) | یکتایی IP + جست‌وجوی تجهیز با IP |
| `idx_devices_due` | انتخاب تجهیزات سررسیدشده در هر چرخهٔ موتور |
| `idx_devices_status` / `idx_devices_group` / `idx_devices_type` / `idx_devices_priority` | فیلترهای فهرست تجهیزات |
| `idx_devices_geo` (جزئی) | bbox نقشه؛ فقط تجهیزات دارای مختصات |
| `idx_devices_layer` | حذف/به‌روزرسانی لایهٔ نقشه (ایندکس FK) |
| `idx_samples_device_ts` | سری نمودار یک تجهیز |
| `idx_samples_device_ok` (covering) | شمارش موفق/ناموفق یک تجهیز |
| `idx_samples_ts` | هرس بر اساس زمان و شمارش بازه‌ای |
| `idx_samples_operation` (یکتا، جزئی) | ضدثبت دوبارهٔ نتیجهٔ یک عملیات |
| `idx_outages_device` | تایم‌لاین قطعی‌های هر تجهیز |
| `idx_outages_open` (یکتا، جزئی) | «قطعی باز» و تضمین حداکثر یکی |
| `idx_outages_closed_started` (جزئی) | هرس قطعی‌های بسته |
| `idx_outages_started` | گزارش‌های بازه‌ای سراسری و رخدادهای هم‌زمان |
| `idx_outages_device_window` | تجمیع قطعی‌ها در بازهٔ گزارش |
| `idx_outages_ended` (جزئی) | بازه‌های مبتنی بر پایان قطعی |
| `idx_daily_day` | گزارش‌های روزانه و هرس آمار روزانه |
| `idx_alerts_status` | هشدارهای فعال داشبورد |
| `idx_alerts_device_status` | هشدارهای هر تجهیز با وضعیت |
| `idx_alerts_device_created` | تجمیع هشدارها در بازه |
| `idx_alerts_created` | فهرست تازه‌ترین هشدارها |
| `idx_alerts_duplicate` (covering) | ضدتکرار هشدار |
| `idx_alerts_rule` | ایندکس FK برای حذف قاعده |
| `idx_audit_ts` / `idx_audit_action` / `idx_audit_actor` | فیلترهای گزارش حسابرسی |
| `idx_engine_log_ts` | فهرست/هرس لاگ موتور |
| `idx_sessions_user` / `idx_sessions_expires` | مدیریت و پاک‌سازی نشست‌ها |
| `idx_maint_device` / `idx_maint_outage` | سوابق تعمیرات و حفظ پیوند قطعی |
| `idx_windows_device` | پنجره‌های تعمیرات فعال |
| `idx_map_markers_type` | علامت‌های هر نوع |
| `idx_alert_rules_group` | ایندکس FK گروه در قواعد |
| `idx_users_username_nocase` (یکتا) | یکتایی نام کاربری بی‌اعتنا به بزرگی/کوچکی |
| `idx_retention_runs_started` / `idx_retention_runs_status` | فهرست و پایش اجراهای Retention |

**ایندکس‌های حذف‌شده:** هیچ ایندکسی بدون بررسی حذف نشد؛ در بازبینی، هیچ ایندکس
کاملاً بی‌مصرفی یافت نشد که پرس‌وجویی نداشته باشد. موارد «کم‌مصرف اما لازم»:

- `idx_outages_started` و `idx_outages_closed_started` با هم حفظ می‌شوند چون اولی
  بازه‌های سراسری/ترتیب زمانی و دومی هرس قطعی‌های بسته را پوشش می‌دهد.
- `idx_alerts_created` در کنار `idx_alerts_status`: SQLite می‌تواند برای فهرست
  «فعال + تازه‌ترین» از هر دو استفاده کند؛ هزینهٔ نگهداری آن کم است.

**ایندکس‌های افزوده در این فاز:** `idx_devices_layer`, `idx_alerts_rule`,
`idx_alert_rules_group` (ایندکس کلیدهای خارجی که SQLite خودکار نمی‌سازد) و
`idx_outages_ended`.

## ۵. پرس‌وجوهای پرتکرار و پلن اجرا (EXPLAIN QUERY PLAN)

خروجی واقعی `npm run db:doctor` روی پایگاه‌دادهٔ ۳ میلیون نمونه‌ای (آمار کامل در
[گزارش بهینه‌سازی](query-optimization-report.md)):

| پرس‌وجو | پلن |
| --- | --- |
| تجهیزات سررسیدشده | `SEARCH devices USING INDEX idx_devices_due` |
| سری نمودار یک تجهیز | `SEARCH samples USING INDEX idx_samples_device_ts` |
| شمارش موفقیت‌ها | `SEARCH samples USING COVERING INDEX idx_samples_device_ok` |
| قطعی‌های یک تجهیز | `SEARCH outages USING INDEX idx_outages_device` |
| قطعی باز | `SEARCH outages USING INDEX idx_outages_open` |
| ضدتکرار هشدار | `SEARCH alerts USING COVERING INDEX idx_alerts_duplicate` |
| هشدارهای فعال | `SEARCH alerts USING INDEX idx_alerts_status` |
| آمار روزانه | `SEARCH daily_stats USING INDEX idx_daily_day` |
| شمارش قابل‌حذف نمونه | `SEARCH samples USING INDEX idx_samples_ts` |
| شمارش قابل‌حذف قطعی | `SEARCH o USING INDEX idx_outages_closed_started` + `SEARCH m/ d USING COVERING INDEX` |
| شمارش قابل‌حذف هشدار | `SEARCH a USING INDEX idx_alerts_status` + `SEARCH o USING INDEX idx_outages_open` |
| هرس آمار روزانه | `SEARCH daily_stats USING INDEX idx_daily_day` |
| هرس حسابرسی | `SCAN audit_log USING INDEX idx_audit_ts` (اسکن ایندکس، نه جدول) |

هیچ پرس‌وجوی داغی روی جدول بزرگ **پیمایش کامل جدول** ندارد؛ این موضوع در
`db-query-plan.test.mjs` به‌صورت خودکار تست می‌شود و `db:doctor` هر رگرسیون را با
کد خروج ۱ گزارش می‌کند.

دو پرس‌وجوی تجمیعی که ماهیتاً «اسکن پوششی ایندکس» دارند (نه SCAN جدول) و در مقیاس
۳ میلیون ردیف اندازه‌گیری شده‌اند:

- `SELECT device_id, COUNT(*) … WHERE ts >= ? GROUP BY device_id` (۲۴ ساعت):
  **۱۸۵ms** روی ۱٫۵ میلیون ردیف باقی‌مانده — با تخمین بازه استفاده می‌شود، نه هر چرخه.
- `SELECT … FROM daily_stats WHERE day >= ? AND day < ?`: **۳۴ms** برای ۲۶٬۰۰۰ ردیف.

## ۶. سیاست دوام، WAL و Checkpoint

| تنظیم | مقدار | دلیل |
| --- | --- | --- |
| `journal_mode` | `WAL` | خواندن هم‌زمان با نوشتن |
| `synchronous` | **`FULL`** | تراکنش تأییدشده پس از قطع برق از دست نرود (`NETWATCH_SQLITE_SYNC=NORMAL` برای کاهش آگاهانه) |
| `foreign_keys` | `ON` | جلوگیری از رکورد یتیم |
| `busy_timeout` | ۵۰۰۰ms | نوشتن هم‌زمان سرور/engine-cli با تلاش دوباره |
| `wal_autocheckpoint` | ۱۰۰۰ صفحه (≈۴MB) | جلوگیری از رشد بی‌مرز WAL |
| `journal_size_limit` | ۶۴MB | سقف رشد WAL در نوشتن‌های پرحجم |
| `trusted_schema` | `OFF` | کاهش سطح حملهٔ توابع/ویوهای دستکاری‌شده |
| Checkpoint دوره‌ای | ۱۵ دقیقه (`checkpoint_interval_minutes`) | بازگشایی سریع پس از Crash |
| Checkpoint پیش از پشتیبان‌گیری | `TRUNCATE` | سازگاری WAL با نسخهٔ پشتیبان |

اندازه‌گیری: WAL پس از درج ۳ میلیون ردیف ≈ **۱۶MB** و Checkpoint کامل در
**۲٫۷ms** انجام شد؛ پس از Checkpoint حجم WAL صفر و فایل اصلی بدون تغییر باقی ماند
(آمار کامل در گزارش عملکرد).

## ۷. تراکنش‌ها و اتمیک بودن

- همهٔ عملیات چندمرحله‌ای از `transaction(fn)` عبور می‌کنند: ثبت هر بررسی موتور
  (قطعی/بازیابی + هشدار + نمونه + شاخص‌ها)، عملیات گروهی تجهیزات، ورود Excel/CSV،
  ورود علامت‌ها، پنجرهٔ تعمیرات، تنظیمات، و هر Batch از Retention.
- `BEGIN IMMEDIATE` فقط برای تراکنش بیرونی و `SAVEPOINT` برای بلوک‌های تودرتو؛ خطا
  در هر مرحله Rollback کامل می‌دهد و خطاهای کسب‌وکار (۴۰۰) بدون تبدیل به خطای
  پایگاه‌داده عبور می‌کنند.
- حذف تجهیز یک عملیات اتمیک است و فرزندان (samples/outages/alerts/daily_stats/
  maintenance/tags) با CASCADE پاک می‌شوند؛ حذف گروه/لایه/نوع علامت ارجاع‌ها را
  `SET NULL` می‌کند و سند عملیاتی را از بین نمی‌برد.
- انتخاب/حذف Batchها با `LIMIT` و داخل تراکنش مستقل انجام می‌شود؛ Crash فقط همان
  Batch را برمی‌گرداند.

## ۸. سیاست زمان واحد

1. تمام ستون‌های زمانی `INTEGER` و **epoch ms UTC** هستند (`ts`, `created_at`,
   `started_at`, `expires_at`, …). هیچ رشتهٔ تاریخ محلی در داده ذخیره نمی‌شود.
2. تنها استثنا برچسب روز در `daily_stats.day` است که با
   `timezone_offset_minutes` ساخته می‌شود؛ همان مرزی که گزارش‌ها استفاده می‌کنند.
3. `server/clock.js` تضمین می‌کند:
   - `monotonicNow()` هرگز زمانی کوچک‌تر از آخرین زمان صادرشده برنمی‌گرداند؛
     عقب‌رفتن ساعت سرور باعث ثبت نمونهٔ «گذشته» یا مدت قطعی منفی نمی‌شود.
   - `observeClock()` آخرین ساعت دیوار را در `runtime_state` نگه می‌دارد و جهش
     بزرگ به عقب/جلو را در رویدادها (`clock_jump_detected`) ثبت می‌کند.
4. بازه‌های قطعی همیشه با `MAX(1, …)` محاسبه می‌شوند؛ حتی با دادهٔ ناسازگار قدیمی
   مقدار منفی ثبت نمی‌شود.

## ۹. نسخه‌بندی Schema

| نسخه | نام | محتوا |
| --- | --- | --- |
| ۱ | `baseline` | ساختار پایه (جدول‌های پایش، امنیت، نقشه، لاگ) |
| ۲ | `resilience` | `next_check_at` و ایندکس سررسید، `min_rtt`، ستون‌های زمان‌بندی نمونه، `epoch`، قیدهای یکتا و ایندکس‌های پرس‌وجو-محور |
| ۳ | `retention-policy` | `schema_migrations`, `retention_runs`, `retention_state`, `runtime_state`, ایندکس‌های FK و قطعی‌های پایان‌یافته |

هر گام در `schema_migrations` ثبت می‌شود و `PRAGMA user_version` در همان تراکنش
به‌روز می‌شود؛ شکست یک گام، تمام آن گام را Rollback می‌کند و برنامه با خطای روشن
`DB_MIGRATION_FAILED` متوقف می‌شود. پیش از هر مهاجرت روی پایگاه‌دادهٔ موجود، یک
نسخهٔ فایلی `<db>.pre-migration-vN-<ts>` ساخته می‌شود.

## ۱۰. بازبینی کلیدهای خارجی و یتیم‌ها

`checkDatabaseHealth({full:true})` در هر بررسی، `PRAGMA foreign_key_check` را اجرا
می‌کند و تعداد نقض‌ها را گزارش می‌دهد؛ مقدار مورد انتظار **صفر** است (در آزمون‌ها و
در سنجش ۳ میلیون ردیفی: صفر). مسیر `GET /api/system/db/health` و `npm run db:doctor`
همین مقدار را نشان می‌دهند. یک ارجاع بدون قید FK باقی مانده است —
`devices.current_outage_id` — که موتور در هر راه‌اندازی اعتبارسنجی و اصلاح می‌کند
(بازیافت قطعی یتیم، پاک‌سازی ارجاع معلق) و Retention هم ردیف قطعی‌ای که تجهیزی به
آن ارجاع می‌دهد حذف نمی‌کند.
