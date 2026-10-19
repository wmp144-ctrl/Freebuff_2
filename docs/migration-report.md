# گزارش Migration ساختار داده

**NetWatch — فاز ۲** · تاریخ: ۲۰۲۶‑۱۰‑۱۹ · نسخهٔ نهایی Schema: **۳**

قاعدهٔ حاکم: **هیچ تغییر ساختاری بدون Migration نسخه‌بندی‌شده، بدون پشتیبان پیش
از مهاجرت، و بدون بررسی وابستگی‌ها انجام نمی‌شود.**

---

## ۱. سازوکار Migration

`server/db.js` یک چارچوب کوچک و صریح دارد:

1. **جدول `schema_migrations`** (`version`, `name`, `applied_at`, `duration_ms`)
   منبع حقیقت برای «چه چیزی اعمال شده است».
2. **`PRAGMA user_version`** هم در همان تراکنش هر گام به‌روزرسانی می‌شود؛ پس اگر
   فرآیند پیش از COMMIT از بین برود، نه گام اعمال شده و نه نسخه ثبت می‌شود.
3. فهرست گام‌ها در کد ثابت است (`MIGRATIONS`) و هر گام داخل
   `transaction(..., {label: 'migration.vN'})` اجرا می‌شود؛ شکست ⇒ Rollback کل گام
   + خطای `DB_MIGRATION_FAILED` و توقف برنامه.
4. گام‌ها **idempotent** نوشته شده‌اند (`IF NOT EXISTS`، بررسی ستون با
   `PRAGMA table_info`) تا اجرای دوباره روی پایگاه‌داده‌ای که `user_version` ندارد
   بی‌خطر باشد.
5. **پایگاه‌دادهٔ موجود پیش از هر مهاجرت یک نسخهٔ فایلی می‌گیرد:**
   `<db>.pre-migration-v<from>-<ts>` (Checkpoint کامل + کپی + `chmod 600`). اگر این
   پشتیبان ساخته نشود، مهاجرت انجام نمی‌شود.

```
verifyDatabaseAtStartup()  →  quick_check + foreign_key_check + جدول‌های الزامی
backupBeforeMigration(v)   →  فقط اگر فایل وجود داشته باشد و v < SCHEMA_VERSION
runMigrations()            →  ثبت گام‌های اعمال‌شده + اجرای گام‌های جدید (تراکنشی)
applied to user_version    →  در همان تراکنش هر گام
```

## ۲. گام‌ها

### گام ۱ — `baseline`

ساختار پایه (جدول‌های پایش، امنیت، نقشه، لاگ) با `CREATE TABLE IF NOT EXISTS`.
برای پایگاه‌دادهٔ تازه، ساختار در همان بازکردن اولیه ساخته و گام ۱ به‌عنوان
«اعمال‌شده» ثبت می‌شود.

### گام ۲ — `resilience` (فاز ۱)

| تغییر | دلیل |
| --- | --- |
| `devices.next_check_at` + `idx_devices_due` | زمان‌بندی صریح؛ هر چرخه فقط تجهیزات سررسیدشده |
| `daily_stats.min_rtt` | گزارش بلندمدت پس از هرس نمونه |
| `samples.scheduled_at` / `started_at` | سنجش Scheduling Lag |
| `engine_lock.epoch` + `engine_meta` | Fencing Token برای رهبری موتور |
| `idx_samples_operation` (یکتا، جزئی) | «یک نتیجه برای هر عملیات» |
| `idx_outages_open` (یکتا، جزئی) | حداکثر یک قطعی باز برای هر تجهیز + تجمیع ردیف‌های تکراری قدیمی |
| ۱۲ ایندکس پرس‌وجو-محور | حذف SCANهای جدول بزرگ (گزارش فاز ۱) |
| `idx_users_username_nocase` | یکتایی نام کاربری بی‌اعتنا به بزرگی/کوچکی |

### گام ۳ — `retention-policy` (فاز ۲)

| تغییر | دلیل |
| --- | --- |
| `retention_runs` + دو ایندکس | تاریخچهٔ کامل هر اجرا (Dry-Run هم ثبت می‌شود) |
| `retention_state` | قفل تک‌نمونه، پرچم توقف، آخرین نتیجه، `next_run_at` |
| `runtime_state` | وضعیت کوچک زمان اجرا (آخرین ساعت مشاهده‌شده) |
| `idx_devices_layer`, `idx_alerts_rule`, `idx_alert_rules_group` | ایندکس کلیدهای خارجی که SQLite خودکار نمی‌سازد |
| `idx_outages_ended` (جزئی) | بازه‌های مبتنی بر پایان قطعی |
| ترمیم idempotent ستون `stop_requested` | نسخه‌های میانی نباید ستون تازه را کم داشته باشند |

کلیدهای تنظیمات جدید (`samples_retention_days`, `daily_stats_retention_days`,
`outages_retention_days`, `alerts_retention_days`, `engine_log_retention_days`,
`retention_enabled`, `retention_run_time`, `retention_batch_size`,
`retention_max_rows_per_run`, `retention_legal_hold`, `retention_prune_backups`,
`backup_daily_keep`, `backup_weekly_keep`, `backup_prune_enabled`) با
`INSERT OR IGNORE` در نخستین اجرا اضافه می‌شوند؛ مقدارهای قبلی مدیر بازنویسی
نمی‌شوند. `retention_days` قدیمی برای سازگاری حفظ شده است.

## ۳. سازگاری با نسخه‌های قبلی

- پایگاه‌دادهٔ `user_version=1` (بدون `epoch`) ⇒ گام ۲ اعمال و `epoch=0` امن
  اضافه می‌شود؛ ردیف قفل قدیمی حفظ می‌شود (آزمون `db-migration.test.mjs`).
- پایگاه‌دادهٔ `user_version=2` ⇒ فقط گام ۳ اعمال می‌شود.
- پایگاه‌دادهٔ بدون `user_version` ولی با ساختار کامل ⇒ گام‌ها idempotent اجرا و
  ثبت می‌شوند.
- **هیچ جدول یا ستونی بدون بررسی وابستگی حذف/بازسازی نشد.** تنها حذف ایندکس
  موجود، `idx_outages_open` غیریکتا در فاز ۱ بود که با معادل یکتای همان نام جایگزین شد.
- پشتیبان‌های ساخته‌شده پیش از این نسخه (`format=1`, بدون `schemaVersion`) با
  مقدار پیش‌فرض `userVersion` داخل `manifest.db` اعتبارسنجی می‌شوند و بازیابی
  آن‌ها مجاز است (فقط پشتیبان با Schema جدیدتر از برنامه رد می‌شود).

## ۴. شاهد آزمون

| آزمون | چه چیزی را اثبات می‌کند |
| --- | --- |
| `db-migration.test.mjs` | Schema قدیمی (v1) پیش از مهاجرت پشتیبان می‌گیرد؛ داده و ردیف قفل حفظ می‌شود؛ ستون/ایندکس‌های تازه اضافه می‌شوند؛ `user_version` به نسخهٔ جدید می‌رسد |
| `db-doctor` | فهرست `schema_migrations` را با نسخه/نام/زمان/مدت گزارش می‌کند و در صورت مغایرت یا شکست Retention کد خروج ۱ می‌دهد |
| `db-query-plan.test.mjs` | ایندکس‌های الزامی پس از مهاجرت وجود دارند و هیچ پرس‌وجوی داغی SCAN جدول بزرگ ندارد |
| `db-crash-recovery.test.mjs` | مهاجرت/Crash در میانهٔ نوشتن، `integrity_check` و FK را سالم نگه می‌دارد |
| `db-backup-policy.test.mjs` | پشتیبان با Schema جدیدتر رد می‌شود؛ Crash در میانهٔ Restore از نسخهٔ ایمنی ترمیم می‌شود |

خروجی واقعی `npm run db:doctor` روی پایگاه‌دادهٔ موقت:

```json
"migrations": [
  { "version": 1, "name": "baseline",          "duration_ms": 0 },
  { "version": 2, "name": "resilience",        "duration_ms": 3 },
  { "version": 3, "name": "retention-policy",  "duration_ms": 1 }
]
```

## ۵. برنامهٔ بازگشت (Rollback)

1. پیش از مهاجرت، فایل `<db>.pre-migration-v<from>-<ts>` ساخته شده است.
2. در صورت نیاز به بازگشت: سرویس را متوقف کنید، فایل را به `data/netwatch.db`
   بازگردانید و `-wal`/`-shm` را پاک کنید (یا از `npm run db:restore` استفاده کنید).
3. کد نسخهٔ قبلی با پایگاه‌دادهٔ بازگردانده‌شده کار می‌کند، چون هیچ ستون/جدولی که
   نسخهٔ قبلی می‌شناسد حذف یا تغییر نوع نداده است.
4. جدول‌های تازهٔ فاز ۲ (`retention_*`, `runtime_state`) برای نسخهٔ قبلی نادیده
   گرفته می‌شوند و در بازگشت به نسخهٔ جدید دوباره قابل استفاده‌اند.

## ۶. نکات استقرار

- پس از ارتقا، یک‌بار `npm run db:doctor` را اجرا کنید و `warnings` را خالی ببینید.
- توصیه می‌شود پیش از ارتقای نسخهٔ تولیدی، یک پشتیبان دستی هم بگیرید:
  `npm run db:backup`.
- گام ۳ جدول‌های تازه می‌سازد؛ روی پایگاه‌دادهٔ بزرگ این کار در حد میلی‌ثانیه
  است (بدون بازنویسی جدول‌های موجود) و وقفه‌ای در سرویس ایجاد نمی‌کند.
