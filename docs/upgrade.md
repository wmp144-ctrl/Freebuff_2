# ارتقای NetWatch

این سند رویهٔ ارتقای نسخه، رفتار Migration و مسیر بازگشت (Rollback) را توضیح
می‌دهد. **هیچ آزمایش ارتقایی روی پایگاه‌دادهٔ Production اصلی انجام نمی‌شود**؛
ابتدا روی یک کپی تمرین کنید (بخش ۳).

---

## ۱. قواعد کلی

1. **همیشه از نسخهٔ فعلی پشتیبان بگیرید.** `npm run db:backup` پیش از هر
   تغییری اجرا می‌شود و خروجی JSON آن باید `ok: true` بدهد.
2. **Migration فقط رو به جلوست.** نسخهٔ جدید ساختار را با گام‌های شماره‌دار
   (`schema_migrations` + `PRAGMA user_version`) ارتقا می‌دهد. هر گام داخل یک
   تراکنش اجرا می‌شود: یا کامل اعمال می‌شود یا هیچ اثری نمی‌گذارد.
3. **پیش از Migration یک نسخهٔ فایلی ساخته می‌شود**:
   `<DATA_DIR>/netwatch.db.pre-migration-v<old>-<timestamp>` با مجوز `600`.
   این فایل نقطهٔ بازگشت سریع است.
4. **تنها کاهش نسخه (Downgrade) پشتیبانی‌شده** بازگرداندن همین فایل یا
   پشتیبان پیش از ارتقاست؛ اجرای کد قدیمی روی پایگاه‌دادهٔ ارتقایافته
   پشتیبانی نمی‌شود (اگر لازم شد، ابتدا پشتیبان را بازیابی کنید).
5. **زمان توقف** برای نصب‌های کوچک (پایگاه‌دادهٔ < ۱ GB) کمتر از یک دقیقه است:
   توقف سرویس، جایگزینی کد، `npm ci`، `npm run build`، راه‌اندازی و اجرای
   Migration.

---

## ۲. رویهٔ استاندارد ارتقا

```bash
# ۰) آماده‌سازی: نسخهٔ فعلی و سالم‌بودن پایگاه‌داده
cd /opt/netwatch
node -p "require('./package.json').version"
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch npm run db:doctor

# ۱) پشتیبان و نقطهٔ بازگشت نسخهٔ فعلی (کد + داده)
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch npm run release:prepare
#    خروجی: releases/<version>-<timestamp>/release.json + آرشیو tar.gz + SHA-256

# ۲) توقف سرویس
sudo systemctl stop netwatch

# ۳) جایگزینی کد (نسخهٔ جدید)
sudo -u netwatch tar -xzf netwatch-<new-version>.tar.gz -C /opt/netwatch --strip-components=1
cd /opt/netwatch
sudo -u netwatch npm ci --omit=dev
sudo -u netwatch npm run build

# ۴) راه‌اندازی: Migration خودکار اجرا می‌شود
sudo systemctl start netwatch
sudo journalctl -u netwatch -n 100 --no-pager | grep -E "db_migration|db_pre_migration_backup|db_health"

# ۵) تأیید
curl -fsS http://127.0.0.1:8787/api/health
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch npm run db:doctor
```

خروجی مورد انتظار در لاگ:

```json
{"event":"db_pre_migration_backup","fromVersion":5,"toVersion":6,"file":"netwatch.db.pre-migration-v5-...."}
{"event":"db_migration_applied","version":6,"name":"...","durationMs":123}
{"event":"db_health_ok","ok":true,"mode":"quick_check"}
```

---

## ۳. تمرین ارتقا روی کپی دادهٔ واقعی

هرگز اولین اجرای Migration را روی Production انجام ندهید:

```bash
sudo systemctl stop netwatch      # یا اجرای هم‌زمان روی کپی، بدون توقف سرویس
sudo -u netwatch cp -a /var/lib/netwatch /var/lib/netwatch-upgrade-test
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch-upgrade-test \
  PORT=8788 NETWATCH_ENGINE=0 node server/index.js &
sleep 5
curl -fsS http://127.0.0.1:8788/api/health
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch-upgrade-test npm run db:doctor
kill %1
```

سپس شمارش‌های کلیدی را با Production مقایسه کنید (تعداد تجهیزات، قطعی‌های باز،
هشدارهای فعال، تعداد کاربران). این همان چیزی است که آزمون خودکار
`server/tests/integration/upgrade-and-install.test.mjs` نیز بررسی می‌کند.

---

## ۴. رفتار Migration در خطا

| وضعیت | رفتار برنامه |
| --- | --- |
| شکست یک گام | همان گام Rollback می‌شود؛ نسخه در آخرین گام موفق می‌ماند؛ سرویس بالا نمی‌آید و پیام فارسی روشن در لاگ ثبت می‌شود (`MIGRATION_FAILED`) |
| قطع برق وسط Migration | تراکنش ناتمام با بازگشایی بعدی Rollback می‌شود؛ `user_version` تغییر نکرده است |
| شکست ساخت پشتیبان پیش از Migration | Migration شروع نمی‌شود (`BACKUP_INVALID`) تا هیچ تغییر غیرقابل‌بازگشتی رخ ندهد |
| ساختار «نیمه‌مهاجرت‌شده» از نسخه‌های قدیمی | گام‌ها idempotent هستند (`CREATE … IF NOT EXISTS`، بررسی ستون) و با اجرای دوباره کامل می‌شوند |

پس از رفع علت (مثلاً تعارض نام ایندکس یا نبود فضای دیسک)، فقط سرویس را دوباره
راه‌اندازی کنید؛ Migration از همان گام ادامه می‌یابد.

اگر رفع علت ممکن نبود:

```bash
sudo systemctl stop netwatch
sudo -u netwatch cp /var/lib/netwatch/netwatch.db.pre-migration-v<old>-<ts> \
  /var/lib/netwatch/netwatch.db
sudo systemctl start netwatch
```

---

## ۵. Rollback نسخه

دو مسیر دارید:

### الف) بازگشت کامل کد و داده (توصیه‌شده)

```bash
sudo systemctl stop netwatch
cd /opt/netwatch
# کد نسخهٔ قبلی
sudo -u netwatch tar -xzf /var/lib/netwatch/releases/<old-version>-<ts>/netwatch-<old-version>.tar.gz \
  -C /opt/netwatch --strip-components=1
sudo -u netwatch npm ci --omit=dev && sudo -u netwatch npm run build
# دادهٔ نسخهٔ قبلی (پشتیبان پیش از ارتقا یا پشتیبان دستی)
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch npm run db:restore -- \
  /var/lib/netwatch/backups/netwatch-<backup-name> --no-mbtiles
sudo systemctl start netwatch
```

### ب) بازگشت فقط داده (کد جدید، دادهٔ قبلی)

اگر نسخهٔ جدید سازگاری عقب‌رو دارد و مشکل داده‌ای است، همان فایل
`netwatch.db.pre-migration-v<old>` را جایگزین کنید. کد جدید ممکن است در اولین
راه‌اندازی دوباره Migration را اجرا کند؛ بنابراین این روش فقط وقتی مناسب است
که کد قدیمی هم نصب شود.

### بررسی پس از Rollback

```bash
curl -fsS http://127.0.0.1:8787/api/health
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch npm run db:doctor
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch npm run db:retention -- --status
```

---

## ۶. سازگاری پشتیبان با نسخهٔ جدید

- پشتیبان شامل `manifest.json` با `appVersion`، `schemaVersion`، حجم و
  SHA-256 هر فایل است.
- بازیابی پشتیبان **قدیمی‌تر** روی نسخهٔ جدید مجاز است: پس از بازیابی،
  Migration در اولین راه‌اندازی اجرا می‌شود.
- بازیابی پشتیبان **جدیدتر** روی نسخهٔ قدیمی‌تر مجاز نیست؛ `db:restore` با
  بررسی `schemaVersion` و پیام روشن رد می‌کند.

---

## ۷. چک‌لیست ارتقا

- [ ] نسخهٔ هدف و یادداشت انتشار خوانده شد (`RELEASE_NOTES.md`)
- [ ] `db:doctor` روی نسخهٔ فعلی سالم است
- [ ] `db:backup` موفق و پشتیبان به مقصد جداگانه کپی شد
- [ ] `release:prepare` آرشیو و SHA-256 نسخهٔ فعلی را ساخت
- [ ] Migration روی کپی دادهٔ واقعی تمرین شد
- [ ] فضای دیسک ≥ ۲ برابر حجم پایگاه‌داده آزاد است
- [ ] سرویس با `systemctl` متوقف/شروع شد (نه `kill -9`)
- [ ] پس از ارتقا: `/api/health`، `db:doctor`، «سلامت برنامه» و داشبورد سالم‌اند
- [ ] پیام‌های `db_migration_applied` و `db_pre_migration_backup` در لاگ دیده شدند
