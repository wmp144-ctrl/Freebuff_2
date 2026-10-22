# سیاست نگهداری داده (Data Retention)

NetWatch در طول زمان حجم زیادی نمونهٔ خام تولید می‌کند. بدون هرس، پایگاه‌داده
بی‌مرز رشد می‌کند و گزارش‌ها کند می‌شوند. Retention این کار را **قابل‌تنظیم،
قابل‌مشاهده و قابل‌توقف** انجام می‌دهد و هرگز دادهٔ تجمیع‌نشده را حذف نمی‌کند.

---

## ۱. سیاست پیش‌فرض

| تنظیم | پیش‌فرض | بازهٔ مجاز | معنی |
| --- | --- | --- | --- |
| `retention_enabled` | `true` | — | اجرای خودکار زمان‌بندی‌شده |
| `retention_run_time` | `03:00` | `HH:MM` | ساعت شروع (به وقت محلی تنظیمات) |
| `retention_interval_minutes` | `1440` | ۱۵ تا ۱۰٬۰۸۰ | حداقل فاصلهٔ دو اجرا |
| `retention_batch_size` | `5000` | ۱۰۰ تا ۵۰٬۰۰۰ | اندازهٔ هر تراکنش حذف |
| `retention_max_rows_per_run` | `100000` | ۱٬۰۰۰ تا ۵٬۰۰۰٬۰۰۰ | سقف کل حذف در یک اجرا |
| `samples_retention_days` | `90` | ۱ تا ۳٬۶۵۰ | نمونه‌های خام |
| `daily_stats_retention_days` | `365` | ۳۶۵ تا ۳۶٬۵۰۰ | تجمیع روزانه |
| `outages_retention_days` | `365` | ۳۶۵ تا ۳۶٬۵۰۰ | قطعی‌ها |
| `alerts_retention_days` | `180` | ۳۰ تا ۳٬۶۵۰ | هشدارها |
| `audit_retention_days` | `365` | ۳۶۵ تا ۳۶٬۵۰۰ | حسابرسی |
| `engine_log_retention_days` | `30` | ۷ تا ۳٬۶۵۰ | لاگ موتور |
| `retention_legal_hold` | `false` | — | توقف کامل هرس |
| `retention_prune_backups` | `false` | — | اجازهٔ هرس پشتیبان‌ها |

مقادیر خارج از بازه با **مرز ایمن** اصلاح می‌شوند (نه حذف ناگهانی داده) و
مقدار مؤثر در `policy` پاسخ `/api/system/retention` دیده می‌شود.

---

## ۲. ترتیب اجرا

1. **قفل اجرا** گرفته می‌شود (Lease در `retention_state`). اجرای هم‌زمان دو
   نمونه/دو فرآیند ممکن نیست و دومی با `409` رد می‌شود.
2. **پیش‌بررسی تجمیع روزانه**: روزهایی که در بازهٔ حذف نمونه قرار دارند باید
   در `daily_stats` تجمیع شده باشند. اگر روزی تجمیع‌نشده باقی بماند، حذف
   نمونه‌ها **متوقف** می‌شود (`blocked.samples = missing_daily_stats:N`) و
   اجرای بعدی پس از تجمیع ادامه می‌دهد. این محافظ، از بین‌رفتن گزارش تاریخی را
   ناممکن می‌کند.
3. **شمارش** ردیف‌های قابل‌حذف (در حالت `dryRun` همین‌جا تمام می‌شود).
4. **حذف مرحله‌به‌مرحله** با Batch: `samples` → `outages` → `alerts` →
   `daily_stats` → `audit_log` → `engine_log`. هر Batch یک تراکنش مستقل است؛
   Crash فقط همان Batch را برمی‌گرداند.
5. **هرس پشتیبان** فقط اگر `retention_prune_backups=true` و اجرا متوقف نشده
   باشد.
6. ثبت نتیجه در `retention_runs` و `audit_log`، به‌روزرسانی
   `retention_state.next_run_at` و آزادسازی قفل.

---

## ۳. حالت‌های ویژه

| وضعیت | رفتار |
| --- | --- |
| `retention_legal_hold = true` | هر اجرای خودکار **و دستی** با `status: skipped` و `reason: legal_hold` رد می‌شود |
| `retention_enabled = false` | اجرای خودکار رد می‌شود؛ اجرای دستی صریح مجاز است |
| درخواست توقف | پس از پایان Batch جاری متوقف می‌شود؛ `status: stopped` و ادامهٔ کار در اجرای بعدی |
| Crash وسط اجرا | در راه‌اندازی بعدی، اجراهای باز با `status: interrupted` علامت می‌خورند و قفل منقضی آزاد می‌شود |
| سقف `max_rows_per_run` | اجرا در همان سقف متوقف و در اجرای بعدی ادامه می‌یابد (پیشرفت گم نمی‌شود) |
| Retention خاموش + پشتیبان‌گیری | مستقل‌اند؛ خاموش‌کردن Retention روی پشتیبان اثر ندارد |

---

## ۴. اجرای دستی

```bash
# پیش‌بینی: چه چیزی و چقدر حذف می‌شود (هیچ تغییری نمی‌دهد)
npm run db:retention -- --dry-run

# اجرای واقعی (مناسب Cron؛ اگر سرویس بالاست، قفل مانع اجرای هم‌زمان می‌شود)
npm run db:retention

# وضعیت سیاست، قفل و آخرین اجراها
npm run db:retention -- --status

# درخواست توقف اجرای جاری
npm run db:retention -- --stop
```

### از API (پنل تنظیمات ← نگهداری داده)

```bash
# وضعیت، سیاست مؤثر، قفل و اجراها (نیازمند نشست)
curl -fsS -b /tmp/nw.jar http://127.0.0.1:8787/api/system/retention

# اجرای آزمایشی
curl -fsS -b /tmp/nw.jar -X POST -H 'x-csrf-token: <token>' -H 'content-type: application/json' \
  -H 'origin: http://127.0.0.1:8787' -d '{"dryRun":true}' \
  http://127.0.0.1:8787/api/system/retention/run

# اجرای واقعی (نقش Admin)
curl -fsS -b /tmp/nw.jar -X POST -H 'x-csrf-token: <token>' -H 'content-type: application/json' \
  -H 'origin: http://127.0.0.1:8787' -d '{"dryRun":false}' \
  http://127.0.0.1:8787/api/system/retention/run

# درخواست توقف
curl -fsS -b /tmp/nw.jar -X POST -H 'x-csrf-token: <token>' -H 'content-type: application/json' \
  -H 'origin: http://127.0.0.1:8787' -d '{}' \
  http://127.0.0.1:8787/api/system/retention/stop
```

اجرای واقعی، درخواست توقف و هرس پشتیبان نیازمند مجوز `system:health`
(نقش‌های Operator/Admin) هستند و در Audit Log ثبت می‌شوند.

---

## ۵. پیش از هر تغییر سیاست

1. `npm run db:retention -- --dry-run` بگیرید و `counts` هر بخش را ببینید.
2. مطمئن شوید پشتیبان تأییدشدهٔ امروز وجود دارد (`npm run db:backup`).
3. کاهش ناگهانی `samples_retention_days` را مرحله‌ای انجام دهید (مثلاً ۳۶۵ → ۱۸۰ → ۹۰).
4. پس از اجرای واقعی، «گزارش‌ها» را برای یک بازهٔ قدیمی بررسی کنید.

---

## ۶. پایش

| شاخص | محل |
| --- | --- |
| آخرین وضعیت/زمان اجرا | `GET /api/system/retention` → `lastStatus`, `lastRun` |
| تعداد و حجم حذف‌شده | `lastDeletedRows`, `lastFreedBytes` |
| اجرای در جریان و فاز آن | `running`, `lastRun.stage` |
| قفل و صاحب آن | `lock.owner`, `lock.expiresAt` |
| حجم پایگاه‌داده و فضای آزاد صفحه‌ها | `storage.dbBytes`, `storage.freeBytes` |
| هشدار اجرای متوقف‌شده/ناتمام | رویدادهای `retention_runs_interrupted` در لاگ |

سیاست کلی این است: **حذف باید قابل‌مشاهده و قابل‌توقف باشد و هرگز دادهٔ
تجمیع‌نشده را هدف نگیرد.** آزمون‌های `retention-engine`, `retention-api` و
`db-cleanup` این قواعد را روی مسیرهای واقعی بررسی می‌کنند.
