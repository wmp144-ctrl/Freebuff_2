# پشتیبان‌گیری و بازیابی

NetWatch همهٔ داده را در یک فایل SQLite (به‌همراه WAL) و فایل‌های MBTiles نگه
می‌دارد. پشتیبان‌گیری **نسخه‌دار، اعتبارسنجی‌شده و اتمیک** است: پشتیبان نیمه‌کاره
هرگز با نام معتبر دیده نمی‌شود و تا زمانی که `integrity_check` و checksum تأیید
نشوند، موفق اعلام نمی‌شود.

| مورد | مقدار |
| --- | --- |
| مسیر پیش‌فرض | `<DATA_DIR>/backups` (`NETWATCH_BACKUP_DIR`) |
| نام پوشهٔ پشتیبان | `netwatch-YYYYMMDD-HHMMSS-<rand6>` |
| محتوای پشتیبان | `netwatch.db` + `manifest.json` + `mbtiles/*.mbtiles` (اختیاری) |
| سیاست نگهداری پیش‌فرض | `backup_keep=7`، هرس روزانه/هفتگی (`backup_daily_keep`, `backup_weekly_keep`) |
| بازهٔ خودکار | `backup_interval_hours` (پیش‌فرض ۲۴ ساعت، `backup_enabled`) |

---

## ۱. پشتیبان دستی

```bash
# پشتیبان کامل (DB + MBTiles) با اعتبارسنجی
npm run db:backup

# فقط پایگاه‌داده (سریع‌تر؛ برای پشتیبان ساعتی)
npm run db:backup -- --no-mbtiles --keep=14
```

خروجی JSON است و کد خروج `0` تنها وقتی برمی‌گردد که پشتیبان ساخته و تأیید شده
باشد:

```json
{
  "ok": true,
  "name": "netwatch-20261020-122824-fa813b",
  "dir": "/var/lib/netwatch/backups/netwatch-20261020-122824-fa813b",
  "dbBytes": 9097216,
  "counts": { "devices": 50, "samples": 84674, "outages": 1292, "alerts": 77, "users": 3 },
  "backups": 4
}
```

### از API (پنل «سلامت برنامه» یا اتوماسیون)

```bash
# وضعیت و فهرست
curl -fsS -b /tmp/nw.jar http://127.0.0.1:8787/api/system/backups

# ساخت پشتیبان
curl -fsS -b /tmp/nw.jar -H 'x-csrf-token: <token>' -H 'content-type: application/json' \
  -H 'origin: http://127.0.0.1:8787' -d '{}' \
  http://127.0.0.1:8787/api/system/backups

# اعتبارسنجی یک پشتیبان
curl -fsS -b /tmp/nw.jar -X POST -H 'x-csrf-token: <token>' -H 'content-type: application/json' \
  -H 'origin: http://127.0.0.1:8787' \
  -d '{"name":"netwatch-20261020-122824-fa813b"}' \
  http://127.0.0.1:8787/api/system/backups/verify

# هرس پشتیبان‌های قدیمی (نگه‌داشتن ۱۰ مورد آخر)
curl -fsS -b /tmp/nw.jar -X POST -H 'x-csrf-token: <token>' -H 'content-type: application/json' \
  -H 'origin: http://127.0.0.1:8787' -d '{"keep":10}' \
  http://127.0.0.1:8787/api/system/backups/prune
```

این APIها به مجوز `system:health` (نقش‌های Operator/Admin) نیاز دارند و در
`NETWATCH_ADMIN_ALLOWED_CIDRS` محدود می‌شوند.

---

## ۲. بازیابی

### الف) بازیابی بدون توقف سرویس (از پنل)

```bash
curl -fsS -b /tmp/nw.jar -X POST -H 'x-csrf-token: <token>' -H 'content-type: application/json' \
  -H 'origin: http://127.0.0.1:8787' \
  -d '{"name":"netwatch-20261020-122824-fa813b","dryRun":true}' \
  http://127.0.0.1:8787/api/system/backups/restore
```

`dryRun: true` فقط بررسی می‌کند: checksum، `integrity_check`، وجود جدول‌ها و
تعداد ردیف‌ها. برای بازیابی واقعی همان درخواست را با `dryRun: false` بفرستید.
برنامه پیش از بازیابی موتور را متوقف می‌کند، از پایگاه‌دادهٔ فعلی یک نسخهٔ
ایمنی (`netwatch.db.pre-restore-<ts>`) می‌سازد، سپس فایل را جایگزین و پس از
موفقیت موتور را دوباره راه‌اندازی می‌کند.

### ب) بازیابی کامل روی سرور (توصیه‌شده برای خرابی)

```bash
sudo systemctl stop netwatch

# بررسی پیش از بازیابی
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch npm run db:restore -- \
  /var/lib/netwatch/backups/netwatch-20261020-122824-fa813b --dry-run --no-mbtiles

# بازیابی واقعی
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch npm run db:restore -- \
  /var/lib/netwatch/backups/netwatch-20261020-122824-fa813b --no-mbtiles

sudo systemctl start netwatch
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch npm run db:doctor
```

اگر سرویس در حال اجراست، اسکریپت بازیابی امتناع می‌کند؛ `--force` فقط برای
محیط آزمایشی است (خطر نوشتن هم‌زمان دو فرآیند).

---

## ۳. اعتبارسنجی پشتیبان (پیش از اعتماد)

هر پشتیبان باید سه شرط را داشته باشد:

1. `manifest.json` با `appVersion`، `schemaVersion`، حجم و `sha256` هر فایل.
2. checksum فایل SQLite با manifest بخواند.
3. `PRAGMA integrity_check` مقدار `ok` بدهد و جدول‌های الزامی موجود باشند.

بررسی سریع بدون بازیابی:

```bash
npm run db:restore -- <backup-dir> --dry-run
```

پشتیبان نامعتبر (checksum نادرست، فایل ناقص، manifest مفقود، schema ناشناخته)
با پیام روشن رد می‌شود و **هیچ فایلی جایگزین نمی‌شود**.

---

## ۴. سیاست نگهداری پشتیبان

| تنظیم | پیش‌فرض | معنی |
| --- | --- | --- |
| `backup_enabled` | `1` | زمان‌بند خودکار |
| `backup_interval_hours` | `24` | فاصلهٔ پشتیبان کامل |
| `backup_keep` | `7` | تعداد پشتیبان نگه‌داشته‌شده |
| `backup_prune_enabled` | `1` | هرس خودکار پس از هر پشتیبان |
| `backup_daily_keep` / `backup_weekly_keep` | — | سیاست روزانه/هفتگی |
| `retention_prune_backups` | `0` | اجازهٔ حذف پشتیبان‌های قدیمی توسط Retention |

نکته: Retention به‌طور پیش‌فرض **پشتیبان‌ها را حذف نمی‌کند**؛ این کار فقط با
`retention_prune_backups=1` و پس از پایان موفقیّت‌آمیز چرخهٔ تجمیع انجام
می‌شود. جزئیات در [DATA_RETENTION.md](DATA_RETENTION.md).

---

## ۵. کپی خارج از سرور (الزام تولیدی)

پشتیبان روی همان دیسک، در برابر خرابی دیسک محافظت نمی‌کند. یکی از این‌ها را
انتخاب کنید:

```bash
# کپی شبانه به مسیر شبکه/دیسک دوم
rsync -a --delete /var/lib/netwatch/backups/ /mnt/backup/netwatch/

# یا با Cron و فقط آخرین پشتیبان تأییدشده
0 1 * * * cd /opt/netwatch && sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch npm run db:backup && \
  rsync -a /var/lib/netwatch/backups/ /mnt/backup/netwatch/
```

پشتیبان را دوره‌ای روی یک ماشین دیگر بازیابی و با `db:doctor` بررسی کنید؛
پشتیبانی که هرگز بازیابی نشده، پشتیبان محسوب نمی‌شود.

---

## ۶. اهداف بازیابی

| مورد | مقدار هدف | توضیح |
| --- | --- | --- |
| RPO (حداکثر دادهٔ ازدست‌رفته) | ۲۴ ساعت با پشتیبان پیش‌فرض؛ کمتر با `backup_interval_hours` | نمونه‌های خام پس از پشتیبان از دست می‌روند |
| RTO (زمان بازگشت) | < ۵ دقیقه برای پایگاه‌دادهٔ < ۱ GB | توقف، بازیابی، راه‌اندازی، `db:doctor` |
| زمان ساخت پشتیبان | ~۰٫۲ ثانیه برای ۹ MB؛ خطی با حجم | `VACUUM INTO` بدون قفل طولانی نوشتن |

---

## ۷. سناریوهای خرابی

| سناریو | اقدام |
| --- | --- |
| فایل پایگاه‌داده خراب (`quick_check` خطا) | توقف سرویس → `db:restore --dry-run` روی آخرین پشتیبان معتبر → بازیابی → `db:doctor` |
| فضای دیسک تمام‌شده | آزادسازی/افزایش دیسک؛ پشتیبان‌گیری تا رسیدن به `NETWATCH_MIN_FREE_BYTES` انجام نمی‌شود |
| فایل پشتیبان ناقص | با `--dry-run` رد می‌شود؛ از پشتیبان قبلی استفاده کنید |
| بازیابی اشتباه | فایل `netwatch.db.pre-restore-<ts>` در همان پوشهٔ داده موجود است |
| قطع برق در حین بازیابی | سرویس را دوباره اجرا و بازیابی را تکرار کنید؛ نسخهٔ ایمنی موجود است |

برای رویهٔ گام‌به‌گام اضطراری [OPERATIONS.md](OPERATIONS.md) و برای علت‌یابی
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) را ببینید.
