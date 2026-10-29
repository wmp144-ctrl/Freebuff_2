# پایگاه‌داده NetWatch

NetWatch از **SQLite داخلی Node.js** (`node:sqlite`) روی یک فایل محلی استفاده
می‌کند. هیچ سرور دیتابیس جداگانه‌ای لازم نیست و برنامه هیچ ارتباط شبکه‌ای با
دیتابیس ندارد.

| مورد | مقدار |
| --- | --- |
| فایل پیش‌فرض | `<NETWATCH_DATA_DIR>/netwatch.db` (`data/netwatch.db`) |
| حالت Journal | `WAL` |
| `synchronous` | `FULL` (قابل تغییر با `NETWATCH_SQLITE_SYNC`) |
| `foreign_keys` | `ON` |
| `busy_timeout` | `NETWATCH_BUSY_TIMEOUT_MS` (پیش‌فرض ۵٬۰۰۰ms) |
| نسخهٔ ساختار | `SCHEMA_VERSION` در `server/db.js` (`PRAGMA user_version`) |
| Migration | جدول `schema_migrations` + گام‌های تراکنشی |

---

## ۱. جدول‌ها

| جدول | نقش | نکته‌های مهم |
| --- | --- | --- |
| `devices` | تجهیزات و آخرین وضعیت | `next_check_at` برای صف بررسی؛ ایندکس `idx_devices_due` |
| `samples` | هر نتیجهٔ Probe | ایندکس `(device_id, ts)`؛ قید یکتایی `(device_id, started_at)` |
| `outages` | بازه‌های قطعی | ایندکس‌های باز/بسته و `ended_at` |
| `alerts` | هشدارها | `status` (active/acknowledged/resolved/suppressed)، `rule_id` |
| `alert_rules` | قوانین هشدار | `metric`، `threshold`، `duration_sec`، `cooldown_sec`، `scope_group_id` |
| `daily_stats` | تجمیع روزانه | مبنای گزارش‌های بلندمدت پس از هرس نمونه‌های خام |
| `maintenance_records` | سوابق تعمیرات | متصل به `outage_id` و تجهیز |
| `maintenance_windows` | پنجره‌های تعمیرات برنامه‌ریزی‌شده | سرکوب هشدار در بازهٔ مجاز |
| `groups`, `tags`, `device_tags` | سازمان‌دهی تجهیزات | حذف گروه با `moveTo` تجهیزات را جابه‌جا می‌کند |
| `map_layers`, `map_markers`, `marker_types` | نقشه و MBTiles | فایل‌های MBTiles بیرون از DB در `<DATA_DIR>/mbtiles` |
| `diagrams` | دیاگرام‌های ماژولار شبکه | `parent_id` برای ساختار درختی، `data` شامل همهٔ اجزای همان دیاگرام (JSON)، `revision` برای جلوگیری از بازنویسی هم‌زمان؛ حذف والد زیرمجموعه‌ها را Cascade می‌کند |
| `diagram_attachments` | تصویر/لوگوی روی بوم دیاگرام | فایل در همان `<DATA_DIR>/attachments`؛ حذف دیاگرام ردیف‌ها را Cascade می‌کند و فایل بی‌استفاده در Sweep بعدی پاک می‌شود |
| `users`, `sessions` | احراز هویت و نشست | `sessions` با هش توکن؛ قفل حساب در `users` |
| `settings` | تنظیمات برنامه | کلید/مقدار متنی JSON؛ مقدارهای محیطی اولویت بالاتر دارند |
| `audit_log` | حسابرسی تغییرات | هر تغییر حساس با کاربر، IP، هدف و جزئیات |
| `engine_log` | لاگ موتور | هرس دوره‌ای بر اساس `engine_log_retention_days` |
| `engine_lock`, `engine_meta` | رهبری موتور و Fencing Token | `epoch` در هر تصاحب قفل افزایش می‌یابد |
| `retention_runs`, `retention_state` | اجراها و قفل Retention | `stop_requested`، فاز جاری و آمار حذف |
| `runtime_state` | وضعیت کوچک زمان اجرا | مثلاً آخرین مشاهدهٔ ساعت دیوار |
| `schema_migrations` | تاریخچهٔ Migration | `version`, `name`, `applied_at`, `duration_ms` |

جزئیات ستون‌به‌ستون، فهرست Migrationها و نسخهٔ ساختار در ادامهٔ همین سند و در
[راهنمای پایگاه‌دادهٔ فارسی](fa/05-database.md) آمده است.

---

## ۲. Migrationها

`server/db.js` فهرست ثابت `MIGRATIONS` را نگه می‌دارد:

| نسخه | نام | محتوا |
| --- | --- | --- |
| ۱ | `baseline` | ساختار پایه (بدون تغییر؛ برای هم‌ترازی نسخه) |
| ۲ | `resilience` | `next_check_at`، `samples.scheduled_at/started_at`، `engine_lock.epoch`، `engine_meta`، قید یکتایی نتیجهٔ Probe، ایندکس‌های تاب‌آوری |
| ۳ | `retention-policy` | `retention_runs`، `retention_state`، `runtime_state`، ایندکس‌های کلید خارجی |
| ۴ | `auth-security` | `users.failed_login_count/locked_until/password_changed_at`، ایندکس نشست‌ها |
| ۵ | `performance-indexes` | `idx_alerts_status_created`، `idx_outages_ended_open`، `idx_daily_device_day` |
| ۶–۹، ۱۱، ۱۴ | گام‌های بازنشسته | مربوط به ماژول حذف‌شدهٔ توپولوژی؛ فقط برای سازگاری شمارهٔ نسخهٔ پایگاه‌داده‌های موجود نگه داشته شده‌اند و کاری انجام نمی‌دهند |
| ۱۰ | `management-extensions` | تاریخ نصب، تعارض IP، گروه چندگانه، قالب، MTTR و پیوست‌ها |
| ۱۲ | `service-availability` | `devices.service_status`, `service_port`, `service_checked_at` |
| ۱۳ | `attachment-limit-50mb` | بالا بردن سقف پیوست از ۵/۲۰ به ۵۰ مگابایت |
| ۱۵ | `modular-diagrams` | حذف جدول‌های باقی‌ماندهٔ توپولوژی و ساخت جدول `diagrams` برای دیاگرام‌های درختی مستقل |
| ۱۶ | `retired-network-discovery` | حذف جدول‌های `discovery_ranges`/`discovery_results` و کلیدهای تنظیمات ماژول حذف‌شدهٔ کشف شبکه |
| ۱۷ | `diagram-attachments` | ساخت جدول `diagram_attachments` برای تصویر/لوگوی روی بوم دیاگرام |

قواعد:

- هر گام داخل `db.transaction` اجرا می‌شود و در همان تراکنش
  `PRAGMA user_version` و `schema_migrations` را می‌نویسد.
- گام‌ها **idempotent** هستند (بررسی ستون/`IF NOT EXISTS`) تا اجرای دوباره روی
  پایگاه‌داده‌ای که `user_version` ندارد ولی ساختارش کامل است، بی‌خطر باشد.
- پیش از نخستین Migration روی یک پایگاه‌دادهٔ موجود، پشتیبان فایلی
  `netwatch.db.pre-migration-v<old>-<timestamp>` ساخته می‌شود. اگر پشتیبان
  ساخته نشود، Migration انجام نمی‌شود.
- شکست یک گام ⇒ همان گام Rollback و توقف راه‌اندازی با کد خطای
  `MIGRATION_FAILED`. جزئیات در [UPGRADE.md](upgrade.md).

افزودن Migration جدید:

1. مقدار `SCHEMA_VERSION` را یک واحد بالا ببرید.
2. تابع گام را idempotent بنویسید (ستون‌ها را با `hasColumn` بررسی کنید).
3. گام را به `MIGRATIONS` اضافه کنید.
4. آزمون `server/tests/unit/db-migration.test.mjs` و
   `server/tests/integration/upgrade-and-install.test.mjs` را اجرا کنید.

---

## ۳. یکپارچگی و بازیابی

```bash
# بررسی کامل: quick_check/integrity_check، کلید خارجی، جدول‌های الزامی، ایندکس‌ها
npm run db:doctor

# گزارش ماشین‌خوان
npm run db:doctor -- --json

# بررسی در راه‌اندازی (پیش‌فرض quick)
NETWATCH_DB_CHECK=quick|full|warn|off
```

| حالت | رفتار |
| --- | --- |
| `quick` (پیش‌فرض) | اگر `PRAGMA quick_check` خطا بدهد، راه‌اندازی متوقف می‌شود |
| `full` | `integrity_check` کامل (کندتر؛ برای بازبینی دوره‌ای) |
| `warn` | فقط هشدار در لاگ؛ برای بازیابی از پشتیبان روی همان سرور |
| `off` | بدون بررسی (توصیه نمی‌شود) |

خرابی پایگاه‌داده هرگز بی‌صدا نادیده گرفته نمی‌شود: سرویس بالا نمی‌آید و
پیام «فایل پایگاه‌داده آسیب دیده است؛ از نسخهٔ پشتیبان بازیابی کنید» ثبت
می‌شود.

---

## ۴. کارایی و برنامه‌ریز پرس‌وجو

- `ANALYZE` به‌صورت دوره‌ای (و `PRAGMA optimize`) اجرا می‌شود تا برنامه‌ریز
  برای گزارش‌های بازه‌ای ایندکس درست را انتخاب کند.
- گزارش‌های بلندمدت از `daily_stats` خوانده می‌شوند؛ روز جاری و لبه‌های ناقص
  از `samples` پر می‌شوند.
- نمونه‌ها با Batch حذف می‌شوند (`retention_batch_size`) تا قفل نوشتن طولانی
  نشود.
- اگر تعداد تجهیزات زیاد است، `max_workers × ping_interval` را با تعداد
  تجهیزات متناسب کنید؛ شاخص `backlog` در `/api/engine/status` هشدار می‌دهد.

برای بازبینی پلن پرس‌وجوها:

```bash
npm run db:doctor            # شامل EXPLAIN QUERY PLAN پرس‌وجوهای کلیدی
```

---

## ۵. پشتیبان و نگهداری

- پشتیبان با `VACUUM INTO` ساخته می‌شود (عکس لحظه‌ای تراکنشی، بدون قفل طولانی).
- پیش از هر Checkpoint/WAL، پشتیبان سازگار است. جزئیات در
  [BACKUP_RESTORE.md](backup-restore.md).
- سیاست هرس داده در [DATA_RETENTION.md](data-retention.md).
- هرگز فایل‌های `netwatch.db-wal`/`-shm` را به‌تنهایی کپی یا حذف نکنید؛ از
  `db:backup` استفاده کنید.
