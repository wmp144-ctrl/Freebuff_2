# سیاست نگهداری داده (Data Retention Policy)

**NetWatch — فاز ۲** · نسخهٔ سیاست: ۱٫۰ · تاریخ: ۲۰۲۶‑۱۰‑۱۹

این سند **سیاست رسمی** نگهداری داده است. همهٔ مقادیر از صفحهٔ
«تنظیمات → داده‌ها و نگهداری» یا `PUT /api/settings` قابل تغییرند و پس از تغییر
در اولین اجرای بعدی اعمال می‌شوند. هیچ حذفی خارج از این سیاست انجام نمی‌شود.

---

## ۱. جدول سیاست پیش‌فرض

| نوع داده | کلید تنظیم | پیش‌فرض | حد مجاز | کف الزامی |
| --- | --- | --- | --- | --- |
| نمونه‌های خام (`samples`) | `samples_retention_days` | **۹۰ روز** | ۱ … ۳۶۵۰ | ۱ روز (و هرگز امروز/دیروز) |
| آمار روزانه (`daily_stats`) | `daily_stats_retention_days` | **۳۶۵ روز** | ۳۶۵ … ۳۶۵۰۰ | ۳۶۵ روز |
| قطعی‌ها (`outages`) | `outages_retention_days` | **۳۶۵ روز** | ۳۶۵ … ۳۶۵۰۰ | ۳۶۵ روز؛ قطعی باز استثناست |
| هشدارها (`alerts`) | `alerts_retention_days` | **۱۸۰ روز** | ۳۰ … ۳۶۵۰ | ۳۰ روز؛ فقط حل‌شده/سرکوب |
| لاگ موتور (`engine_log`) | `engine_log_retention_days` | **۳۰ روز** | ۷ … ۳۶۵۰ | ۷ روز |
| گزارش حسابرسی (`audit_log`) | `audit_retention_days` | **۳۶۵ روز** | ۳۶۵ … ۳۶۵۰۰ | ۳۶۵ روز |
| نسخه‌های پشتیبان | `backup_daily_keep` / `backup_weekly_keep` | **۷ روزانه + ۴ هفتگی** | ۱…۶۰ / ۰…۵۲ | ۱ نسخه |

تنظیمات اجرایی:

| کلید | پیش‌فرض | توضیح |
| --- | --- | --- |
| `retention_enabled` | `true` | خاموش‌کردن موقت اجرای **خودکار** (اجرای دستی مدیر مجاز است) |
| `retention_run_time` | `03:00` | ساعت اجرای روزانه به وقت محلی (`timezone_offset_minutes`) |
| `retention_interval_minutes` | `1440` | حداقل فاصلهٔ دو اجرا |
| `retention_batch_size` | `5000` | رکورد در هر تراکنش |
| `retention_max_rows_per_run` | `100000` | سقف کل رکوردهای هر اجرا (اجرا کوتاه و قابل توقف می‌ماند) |
| `retention_legal_hold` | `false` | الزام قانونی: با `true` هیچ حذفی انجام نمی‌شود |
| `retention_prune_backups` | `false` | Retention **به‌طور پیش‌فرض** به فایل‌های پشتیبان دست نمی‌زند |

> **تقدم سیاست مدیر:** مقادیر جدول بالا قابل تغییرند؛ اگر الزام قانونی/قراردادی
> وجود دارد، یا `retention_legal_hold` را روشن کنید (توقف کامل حذف) یا مقدار روزها
> را بزرگ‌تر بگذارید. کف‌های جدول («کف الزامی») از تنظیم دستکاری‌شده/معیوب هم
> محافظت می‌کنند.

## ۲. قواعد ایمنی (تضمین‌شده در کد و آزمون)

1. **آمار تاریخی هرگز با حذف نمونه از بین نمی‌رود.** پیش از حذف نمونه‌ها، هر روزی
   که نمونه دارد و در `daily_stats` ردیف ندارد، ابتدا تجمیع می‌شود. اگر تجمیع در
   همان اجرا کامل نشود (سقف ۶۲ روز در هر اجرا)، **حذف نمونه‌ها کاملاً متوقف
   می‌شود** و در اجرای بعدی ادامه می‌یابد.
2. **نمونه‌های امروز و دیروز هرگز حذف نمی‌شوند** — حتی با `samples_retention_days=1`؛
   تجمیع روزانه به آن‌ها نیاز دارد.
3. **قطعی باز هرگز حذف نمی‌شود**، هرچند از بازهٔ نگهداری قدیمی‌تر باشد.
4. **قطعی‌ای که سابقهٔ تعمیرات به آن ارجاع می‌دهد** (`maintenance_records.outage_id`)
   و همچنین قطعی‌ای که تجهیزی به آن ارجاع می‌دهد (`devices.current_outage_id`)
   حفظ می‌شود.
5. **هشدار حل‌نشده** (`active`/`acknowledged`) هرگز حذف نمی‌شود؛ فقط
   `resolved`/`suppressed` و آن هم نه برای تجهیزی که قطعی باز دارد.
6. **حسابرسی و قطعی‌ها** حداقل ۳۶۵ روز می‌مانند (کف سخت در لایهٔ تنظیمات).
7. **Legal Hold** کل حذف را متوقف می‌کند؛ تغییر آن فقط با تنظیم صریح مدیر ممکن است.
8. **پشتیبان‌ها** تا وقتی `retention_prune_backups=true` نشود، در این سرویس هرس
   نمی‌شوند.
9. **حذف تکه‌تکه (Batch)** انجام می‌شود؛ هر Batch یک تراکنش مستقل دارد و Crash فقط
   همان Batch را برمی‌گرداند. هیچ حالت «نیمه‌حذف» وجود ندارد.
10. **هر اجرا در Audit Log ثبت می‌شود** (`retention.run` / `retention.dry_run`) با
    تعداد رکوردها، حجم آزادشده، مرحله و سیاست مؤثر.

## ۳. معماری Retention Engine

`server/retention.js` یک سرویس مستقل است:

```
زمان‌بند (هر ۶۰ ثانیه بیدار می‌شود، فقط نمونهٔ رهبر)
   └─ اگر اجرای بعدی رسیده باشد → runRetention({trigger:'scheduled'})
         ├─ بررسی Legal Hold و retention_enabled
         ├─ گرفتن Lease در جدول retention_state (تک‌نمونه، قابل انقضا پس از Crash)
         ├─ ثبت ردیف running در retention_runs
         ├─ preflight: تثبیت daily_stats روزهای در معرض حذف
         ├─ شمارش قابل‌حذف‌ها (برای Dry-Run و گزارش)
         └─ مراحل حذف: samples → outages → alerts → daily_stats → audit_log → engine_log
               هر Batch: transaction مستقل + تجدید Lease + بررسی پرچم توقف
         ├─ Checkpoint PASSIVE + PRAGMA optimize
         └─ ثبت نتیجه و Audit Log
```

**ترتیب مراحل مهم است:** ابتدا تجمیع، سپس حذف نمونه؛ اگر ترتیب برعکس بود با
`samples_retention_days=1` می‌شد آمار روزانه را برای همیشه از دست داد.

**تک‌نمونه بودن:** قفل در `retention_state` با مالک و انقضا (۱۲۰ ثانیه، در هر
Batch تمدید می‌شود) نگهداری می‌شود. اجرای هم‌زمان سرور و `engine-cli` یا دو مدیر،
با خطای `DB_BUSY` (HTTP 409) رد می‌شود. اگر فرآیند با SIGKILL از بین برود، قفل پس
از انقضا آزاد و ردیف `running` در راه‌اندازی بعدی به `interrupted` تغییر می‌کند.

**توقف و ادامه:** توقف در مرز Batch اعمال می‌شود (پرچم در حافظه و در
`retention_state.stop_requested` برای فرآیندهای دیگر). نتیجهٔ اجرا `stopped` ثبت
می‌شود و اجرای بعدی از همان وضعیت معتبر ادامه می‌دهد؛ چون هر Batch خودکفا و
idempotent است، نیازی به Cursor نیست.

## ۴. Dry-Run، وضعیت و اجرای دستی

### رابط کاربری
«تنظیمات → داده‌ها و نگهداری»: ویرایش سیاست + وضعیت زنده (آخرین اجرا، اجرای بعدی،
قفل، رکورد حذف‌شده، حجم آزادشده، حجم DB/WAL) + دکمه‌های **Dry-Run**، **اجرای دستی**
و **توقف**.

### API (فقط Administrator برای عملیات)

| مسیر | کار |
| --- | --- |
| `GET /api/system/retention` | وضعیت، سیاست مؤثر، قفل، ۱۰ اجرای آخر، حجم‌ها |
| `GET /api/system/retention/runs?limit=n` | تاریخچهٔ اجراها |
| `POST /api/system/retention/run` `{dryRun?:true}` | اجرا یا Dry-Run (۴۰۹ در صورت اجرای هم‌زمان) |
| `POST /api/system/retention/stop` | درخواست توقف (۲۰۲ پذیرفته / ۴۰۹ اجرایی نیست) |
| `GET /api/system/restore/status` | وضعیت آخرین بازیابی |

### خط فرمان

```bash
npm run db:retention -- --status     # وضعیت و سیاست مؤثر
npm run db:retention -- --dry-run    # فقط شمارش، بدون تغییر
npm run db:retention                 # اجرای واقعی (مناسب Cron)
npm run db:retention -- --stop       # درخواست توقف اجرای جاری
npm run db:retention -- --force      # اجرا حتی با retention_enabled=false
```

کد خروج `۲` یعنی نمونهٔ دیگری قفل را دارد (اجرای هم‌زمان رد شد).

## ۵. Audit و مشاهده‌پذیری

هر اجرا یک ردیف در `retention_runs` دارد:

| ستون | توضیح |
| --- | --- |
| `trigger`, `actor` | `scheduled` / `manual` / `cli` / `engine` و نام کاربر یا فرآیند |
| `dry_run` | ۱ برای Dry-Run |
| `status` | `running` · `completed` · `stopped` · `failed` · `interrupted` |
| `stage` | مرحلهٔ جاری/پایانی (مثلاً `samples`) |
| `deleted` / `deleted_rows` | تعداد به تفکیک جدول و مجموع |
| `freed_bytes` | تخمین فضای آزادشده (صفحه‌های آزاد × اندازهٔ صفحه) |
| `batches`, `duration_ms`, `error`, `policy` | برای بازبینی و عیب‌یابی |

رویدادهای ساختاریافتهٔ متناظر: `retention_completed`, `retention_dry_run`,
`retention_failed`, `retention_stop_requested`, `retention_runs_interrupted`,
`retention_scheduler_started`.

## ۶. نکات عملیاتی

- **پیش از تغییر سیاست به مقادیر کوچک‌تر، Dry-Run بگیرید** تا حجم حذف را ببینید.
- اگر می‌خواهید داده‌ها را برای مدت نامحدود نگه دارید: `retention_enabled=false`
  (توقف خودکار) و/یا `retention_legal_hold=true` (توقف کامل).
- اجرای دستی روی پایگاه‌دادهٔ بزرگ ممکن است چند ده ثانیه طول بکشد؛ سقف
  `retention_max_rows_per_run` و `retention_batch_size` را برای محیط خود تنظیم کنید.
  در سنجش ۳ میلیون نمونه‌ای، حذف ۱٫۵ میلیون ردیف با Batch ۲۰٬۰۰۰ در **۴۳٫۷ ثانیه**
  (۸۱ Batch) انجام شد.
- هرس پشتیبان‌ها وظیفهٔ زمان‌بند پشتیبان است (۷ روزانه + ۴ هفتگی). اگر می‌خواهید
  Retention هم پشتیبان‌ها را هرس کند، `retention_prune_backups=true` را آگاهانه
  روشن کنید.
- پس از هر اجرا، `PRAGMA optimize` اجرا می‌شود و Checkpoint سبک (`PASSIVE`) می‌گیرد
  تا WAL جمع شود بدون آنکه نوشتن موتور مسدود شود.

## ۷. ارتباط با سایر اسناد

- ساختار جدول‌ها و ایندکس‌ها: [database-schema.md](database-schema.md)
- پشتیبان/بازیابی و Manifest: [backup-restore.md](backup-restore.md)
- آزمون‌های اثبات سیاست: [data-integrity-test-report.md](data-integrity-test-report.md)
- گزارش Migration: [migration-report.md](migration-report.md)
