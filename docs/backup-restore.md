# مستند پشتیبان‌گیری و بازیابی

**NetWatch — فاز ۲** · تاریخ: ۲۰۲۶‑۱۰‑۱۹ · دامنه: `server/backup.js`،
`server/scripts/db-backup.mjs`، `server/scripts/db-restore.mjs`

هدف: **هیچ پشتیبانی تأییدنشده معتبر شمرده نشود و هیچ بازیابی‌ای داده را خراب
نکند — حتی با SIGKILL در هر مرحله.**

---

## ۱. اصول

1. **سازگاری با WAL:** پیش از هر پشتیبان، `PRAGMA wal_checkpoint(TRUNCATE)` اجرا
   می‌شود و سپس `VACUUM INTO` یک عکس لحظه‌ای تراکنشی می‌سازد. نوشتن هم‌زمان
   موتور، نسخهٔ پشتیبان را خراب نمی‌کند (آزمون `db-backup-restore.test.mjs`).
2. **هیچ پشتیبان نیمه‌کاره‌ای دیده نمی‌شود:** ساخت در پوشهٔ `.partial-*` انجام و در
   پایان با `rename` اتمیک به پوشهٔ نهایی تبدیل می‌شود.
3. **هر مجموعه یک Manifest دارد** و تا تأیید کامل، معتبر نیست.
4. **بازیابی ابتدا در مسیر موقت** کپی و همان کپی هم اعتبارسنجی می‌شود.
5. **نسخهٔ ایمنی پیش از جای‌گذاری** با `fsync` ساخته می‌شود.
6. **جای‌گذاری اتمیک** با `rename`؛ حذف `-wal`/`-shm` **پیش از** جای‌گذاری، تا WAL
   قدیمی هرگز روی فایل جدید بازپخش نشود.
7. **دفتر وضعیت بازیابی** (`.restore-state.json`) پیش از هر مرحله روی دیسک
   نوشته می‌شود؛ `db.js` پیش از بازکردن اتصال آن را می‌خواند و بازیابی نیمه‌کاره را
   ترمیم می‌کند.

## ۲. Manifest

نمونه:

```json
{
  "format": 1,
  "app": "netwatch",
  "appVersion": "1.1.0",
  "schemaVersion": 3,
  "name": "netwatch-20261019-120012-ab12cd",
  "reason": "scheduled | manual | api:<user> | pre-migration",
  "createdAt": "2026-10-19T12:00:12.345Z",
  "createdAtMs": 1792411212345,
  "dbPath": "/data/netwatch.db",
  "db": {
    "file": "netwatch.db",
    "size": 188424192,
    "sha256": "0172971…",
    "integrity": "ok",
    "pageCount": 46002,
    "userVersion": 3,
    "counts": { "devices": 1000, "samples": 1501500, "outages": 20000, "openOutages": 0, "alerts": 12060, "users": 1 }
  },
  "mbtiles": [ { "name": "city.mbtiles", "size": 1048576, "sha256": "…", "sourceSize": 1048576, "sourceMtimeMs": 1792… } ],
  "checkpoint": { "mode": "TRUNCATE", "busy": 0, "logFrames": 0, "checkpointedFrames": 0 },
  "settings": { "journalMode": "wal", "synchronous": 2 },
  "durationMs": 16183
}
```

**معیار اعتبار:** وجود دارایی‌های اجباری (`settings`, `devices`, `samples`,
`outages`, `daily_stats`, `alerts`)، تطبیق SHA‑256 و اندازه، `integrity_check` و
`foreign_key_check` موفق، و **`schemaVersion` بزرگ‌تر از نسخهٔ برنامه نباشد**
(جلوگیری از Downgrade). فایل MBTiles نیز با checksum بررسی می‌شود.

## ۳. سیاست نگهداری نسخه‌ها (GFS)

- `backup_daily_keep = 7` → تازه‌ترین نسخهٔ هر روز تقویمی (UTC) برای ۷ روز
- `backup_weekly_keep = 4` → تازه‌ترین نسخهٔ هر هفتهٔ ISO برای ۴ هفته
- در هر حالت **جدیدترین نسخه حفظ می‌شود** و مجموع نسخه‌ها منطقی می‌ماند.
- `backup_prune_enabled` (پیش‌فرض روشن) هرس را در پایان پشتیبان‌گیری خودکار انجام
  می‌دهد؛ `npm run db:backup -- --keep=N` رفتار سقف کل (سازگار با نسخهٔ قبلی) دارد.
- **Retention Engine به‌طور پیش‌فرض به پشتیبان‌ها دست نمی‌زند**
  (`retention_prune_backups=false`).

اندازه‌گیری: پشتیبان ۱۸۸MB (۱٫۵ میلیون نمونه) در **۱۶٫۲ ثانیه** ساخته و در
**۱۴٫۰ ثانیه** اعتبارسنجی شد (تکرار در گزارش عملکرد).

## ۴. بازیابی: ترتیب دقیق و پنجره‌های Crash

| گام | عملیات | اگر Crash رخ دهد |
| --- | --- | --- |
| ۰ | `verifyBackup` (checksum/integrity/FK/نسخه) | هیچ تغییری در داده نشده است |
| ۱ | بررسی فضای دیسک + `onBeforeRestore` (توقف موتور) | سرویس باید دوباره راه‌اندازی شود؛ داده سالم |
| ۲ | `checkpoint(TRUNCATE)` و کپی **نسخهٔ ایمنی** با fsync | داده دست‌نخورده |
| ۳ | دفتر وضعیت: `phase=safety_ready` | در راه‌اندازی: فایل اصلی موجود است → فقط پاک‌سازی موقت‌ها |
| ۴ | کپی پشتیبان به `<db>.restore-stage-<pid>` و اعتبارسنجی همان کپی (شامل تعداد رکوردها) | فایل اصلی دست‌نخورده؛ فایل موقت پاک می‌شود |
| ۵ | بستن اتصال، حذف `-wal`/`-shm` (پس از Checkpoint)، دفتر: `phase=installing` | فایل اصلی کامل و سالم است (Checkpoint انجام شده) |
| ۶ | `rename` اتمیک فایل موقت → فایل اصلی + fsync پوشه | یا فایل قدیم یا فایل جدید معتبر است؛ هر دو کامل‌اند |
| ۷ | بازگشایی، Migration، `integrity_check` + `foreign_key_check` + تطبیق تعداد رکوردها با Manifest | در صورت ناسالم‌بودن: نسخهٔ ایمنی بازگردانده می‌شود |
| ۸ | نصب فایل‌های نقشهٔ از پیش تأییدشده | پایگاه‌داده سالم می‌ماند؛ خطا گزارش می‌شود |
| ۹ | دفتر: `status=completed` + خلاصه | — |

**شفافیت:** پس از بازیابی موفق، `restoreStatus()` (و `GET /api/system/restore/status`)
وضعیت `completed` با زمان پایان، تعداد رکوردها، فایل‌های نقشه و مسیر نسخهٔ ایمنی را
برمی‌گرداند. در «داشبورد سلامت پایگاه‌داده» و در صفحهٔ «داده‌ها و نگهداری» هم
نمایش داده می‌شود.

### پنجرهٔ بحرانی و ترمیم خودکار

تنها پنجرهٔ واقعی، فاصلهٔ کوتاه بین حذف `-wal` و `rename` است. اگر فرآیند دقیقاً
آنجا از بین برود، فایل اصلی **موجود و کامل** است (Checkpoint قبل انجام شده) و
db.js فقط فایل‌های موقت را پاک می‌کند. اگر به هر دلیلی فایل اصلی غایب باشد،
`recoverInterruptedRestoreBeforeOpen()` نسخهٔ ایمنی را با `fsync` بازمی‌گرداند و
وضعیت را `recovered_interrupted` ثبت می‌کند (آزمون `db-backup-policy.test.mjs`).

## ۵. fsync و خطاهای ذخیره‌سازی

- هر فایل نوشته‌شده (پشتیبان، Manifest، کپی ایمنی، فایل موقت بازیابی) با
  `fsync` روی فایل و سپس `fsync` روی پوشه تأیید می‌شود.
- خطای fsync/IO باعث شکست همان عملیات و پاک‌سازی فایل نیمه‌کاره می‌شود؛ هیچ
  پشتیبان یا بازیابی نیمه‌کاره‌ای باقی نمی‌ماند.
- کمبود فضا پیش از هر عملیات با `NETWATCH_MIN_FREE_BYTES` (پیش‌فرض ۶۴MB) بررسی
  و با خطای `DB_DISK_FULL` (HTTP 507) رد می‌شود.

## ۶. عملیات

```bash
# پشتیبان کامل (پایگاه‌داده + MBTiles)
npm run db:backup

# پشتیبان بدون نقشه‌ها با سقف کل
npm run db:backup -- --no-mbtiles --keep=14

# اعتبارسنجی بدون تغییر
npm run db:restore -- <backup-dir> --dry-run

# بازیابی (سرویس را متوقف کنید یا از مسیر API با توقف خودکار موتور استفاده کنید)
npm run db:restore -- data/backups/netwatch-20261019-120012-ab12cd --force

# بررسی سلامت، Migrationها، پلن پرس‌وجوها و وضعیت Retention
npm run db:doctor
```

| مسیر API | دسترسی | کار |
| --- | --- | --- |
| `GET /api/system/backups` | `system:health` | فهرست نسخه‌ها + سیاست + وضعیت بازیابی |
| `POST /api/system/backups` | admin | ساخت پشتیبان |
| `POST /api/system/backups/verify` | admin | اعتبارسنجی |
| `POST /api/system/backups/restore` | admin | بازیابی (موتور خودکار متوقف/راه‌اندازی می‌شود؛ `dryRun` پشتیبانی می‌شود) |
| `POST /api/system/backups/prune` | admin | هرس دستی |
| `GET /api/system/restore/status` | `system:health` | وضعیت آخرین/جاری بازیابی |
| `GET /api/system/db/health` | `system:health` | سلامت + WAL + دیسک + وضعیت پشتیبان/بازیابی/Retention |

## ۷. چک‌لیست پذیرش بازیابی

- [x] Backups قابل بازیابی‌اند: بازیابی دقیقاً وضعیت پشتیبان را برمی‌گرداند
      (تعداد devices/samples/outages/alerts و مقدار یکتای قبل از پشتیبان).
- [x] Restore خرابی ایجاد نمی‌کند: `integrity_check` کامل + `foreign_key_check` صفر.
- [x] پشتیبان خراب/دست‌کاری‌شده پیش از هر تغییر رد می‌شود و دادهٔ فعلی دست‌نخورده می‌ماند.
- [x] نسخهٔ ایمنی پیش از بازیابی ساخته و در صورت خطا بازگردانده می‌شود.
- [x] Dry-Run هیچ تغییری نمی‌دهد.
- [x] MBTiles هماهنگ با پایگاه‌داده پشتیبان/بازیابی می‌شوند.
- [x] Crash در میانهٔ Restore در راه‌اندازی بعدی ترمیم می‌شود (نسخهٔ ایمنی).
- [x] پشتیبان با Schema جدیدتر رد می‌شود.
- [x] تعداد رکوردها قبل و بعد از Backup/Restore مطابقت دارد (در Manifest و پس از بازیابی).

جزئیات آزمون‌ها: [data-integrity-test-report.md](data-integrity-test-report.md).
