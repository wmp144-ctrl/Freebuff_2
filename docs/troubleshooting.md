# عیب‌یابی و بازیابی از خرابی

این سند بر اساس **نشانه** تنظیم شده است: ابتدا نشانه را پیدا کنید، سپس علت و
اقدام. برای رویه‌های نصب/ارتقا/بازیابی به [INSTALL.md](install.md)،
[UPGRADE.md](upgrade.md) و [BACKUP_RESTORE.md](backup-restore.md) مراجعه کنید.

> پیش از هر اقدام: `sudo journalctl -u netwatch -n 200 --no-pager` و
> `npm run db:doctor` را بگیرید. لاگ‌ها ساختاریافته (JSON) هستند و فیلد
> `event` بهترین نقطهٔ شروع است.

---

## ۱. سرویس بالا نمی‌آید

| نشانه | علت احتمالی | اقدام |
| --- | --- | --- |
| `ConfigError: پیکربندی نامعتبر است` | `PORT`/`HOST`/CIDR/TLS/نرخ نامعتبر | پیام دقیق را بخوانید؛ فقط نام کلید و بازه مجاز چاپ می‌شود |
| `EADDRINUSE` | پورت اشغال (نمونهٔ قدیمی زنده است) | `ss -ltnp \| grep 8787`؛ سرویس قبلی را متوقف کنید |
| `EACCES` / `EPERM` | مالکیت داده/کلید اشتباه | `chown -R netwatch:netwatch /var/lib/netwatch` |
| `پایگاه‌داده آسیب دیده است` (`DB_CORRUPT`) | خرابی فایل/WAL | بازگشت به پشتیبان معتبر (بخش ۳) |
| `مهاجرت ساختار داده ... ناموفق` | تعارض ساختار/فضای دیسک | لاگ `db_migration_applied` و پیام گام را ببینید (بخش ۴) |
| `TLS` | گواهی/کلید ناقص یا ناخوانا | مسیر و مجوز `server.key` (`600`) را بررسی کنید |

نکته: اگر عمداً می‌خواهید روی پایگاه‌دادهٔ ناسالم سرویس را برای بازیابی بالا
بیاورید، فقط و فقط به‌طور موقت `NETWATCH_DB_CHECK=warn` بگذارید.

---

## ۲. ورود ناموفق است

| نشانه | علت | اقدام |
| --- | --- | --- |
| «نام کاربری یا رمز نادرست» با رمز درست | حساب قفل شده | با Admin: `POST /api/auth/users/<id>/unlock` |
| `429` + `Retry-After` | سقف نرخ ورود | چند دقیقه صبر کنید؛ `NETWATCH_LOGIN_RATE_LIMIT_MAX` را بازبینی کنید |
| پس از ورود بلافاصله خارج می‌شود | کوکی `Secure` روی HTTP | از HTTPS استفاده کنید یا پروکسی را درست تنظیم کنید |
| `403` روی APIهای مدیریتی | محدودیت شبکهٔ مدیریت | `NETWATCH_ADMIN_ALLOWED_CIDRS` و IP واقعی (`NETWATCH_TRUST_PROXY`) را بررسی کنید |
| `CSRF` نامعتبر | هدر `X-CSRF-Token` جا افتاده | توکن کوکی `nw_csrf` را در هر درخواست تغییردهنده بفرستید |
| `401` برای همهٔ APIها | نشست منقضی/باطل‌شده | دوباره وارد شوید؛ Idle Timeout پیش‌فرض ۶۰ دقیقه است |

---

## ۳. خرابی پایگاه‌داده

نشانه‌ها: `DB_CORRUPT`، `database disk image is malformed`، `quick_check` ناموفق،
`db:doctor` با خطا.

```bash
sudo systemctl stop netwatch
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch npm run db:doctor -- --json

# آخرین پشتیبان معتبر را پیدا و بررسی کنید
ls -1t /var/lib/netwatch/backups | head -5
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch npm run db:restore -- \
  /var/lib/netwatch/backups/<backup> --dry-run --no-mbtiles

# بازیابی و راه‌اندازی
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch npm run db:restore -- \
  /var/lib/netwatch/backups/<backup> --no-mbtiles
sudo systemctl start netwatch
```

اگر پشتیبان ندارید:

1. سرویس را با `NETWATCH_DB_CHECK=warn` موقتاً بالا بیاورید تا داده‌های قابل‌خواندن
   را استخراج کنید (`npm run db:doctor`، گزارش‌ها، خروجی Excel).
2. از فایل خراب یک کپی نگه دارید (برای بازیابی تخصصی).
3. پایگاه‌دادهٔ تازه بسازید و داده‌ها را از Import بازگردانید.

---

## ۴. خطای Migration در ارتقا

```bash
sudo journalctl -u netwatch | grep -E "db_migration|MIGRATION_FAILED|Migration"
```

1. **علت را رفع کنید**: فضای دیسک، تعارض نام شیء، مجوز فایل.
2. **دوباره راه‌اندازی کنید**: Migration از آخرین گام موفق ادامه می‌یابد.
3. **اگر رفع ممکن نیست**: فایل `netwatch.db.pre-migration-v<old>-<ts>` را
   جایگزین کنید و کد نسخهٔ قبلی را نصب کنید (بخش ۵ [UPGRADE.md](upgrade.md)).

گام شکست‌خورده Rollback شده است؛ نیازی به پاک‌کردن دستی جدول‌ها نیست.

---

## ۵. موتور بررسی نمی‌کند

| نشانه | بررسی | اقدام |
| --- | --- | --- |
| `running=false` | `GET /api/engine/status` | `POST /api/engine/control/start` |
| `leader=false` و نمونهٔ دیگر رهبر است | `epoch`, `lock.owner` | طبیعی است؛ فقط یک رهبر مجاز است |
| `mode=tcp` به‌جای icmp | `icmpAvailable` | نصب `iputils-ping` و اعطای `CAP_NET_RAW` |
| `stalled=true` / `tickLagMs` بزرگ | backlog و تعداد تجهیزات | `max_workers` یا `ping_interval` را تنظیم کنید |
| `backlog` صعودی | `max_workers × interval < devices` | ظرفیت را افزایش دهید |
| همهٔ تجهیزات `offline` | فایروال/مسیر شبکه/`PROBE_ALLOWED_CIDRS` | از خود سرور `ping`/`nc` بزنید؛ محدودهٔ Probe را بررسی کنید |
| `ENGINE_NOT_LEADER` در بررسی دستی | این نمونه رهبر نیست | بررسی را از نمونهٔ رهبر اجرا کنید |

---

## ۶. داده زنده در UI به‌روز نمی‌شود

| نشانه | علت | اقدام |
| --- | --- | --- |
| نشان «اتصال قطع است» و «داده کهنه» | SSE قطع شده | شبکه/پروکسی؛ `proxy_buffering off` در Nginx |
| نشان «در حال اتصال…» پایدار | مسدودشدن `/api/events` | فایروال/پروکسی و `NETWATCH_SSE_MAX` را بررسی کنید |
| کلاینت‌ها مرتب قطع می‌شوند | بافر/شبکهٔ کند | `NETWATCH_SSE_MAX_BUFFER`؛ لاگ `sse_client_dropped` |
| داشبورد قدیمی ولی تجهیزات تازه | کش مرورگر/سرویس‌ورکر | Hard Reload؛ APIها `no-store` هستند |

SSE در NetWatch پس از قطع، با Backoff نمایی + Jitter دوباره وصل می‌شود و پس
از اتصال، Snapshotها را دوباره می‌گیرد (تا دادهٔ قدیمی «زنده» نمایش داده نشود).

---

## ۷. ورود گروهی (Import) کار نمی‌کند

| نشانه | علت | اقدام |
| --- | --- | --- |
| `413` | حجم فایل بیش از سقف | `NETWATCH_MAX_IMPORT_BYTES` |
| `400` با فهرست خطا | ستون/مقدار نامعتبر | فایل نمونه (`/api/devices/template`) را بگیرید |
| `429` | سقف نرخ Import | `NETWATCH_IMPORT_RATE_LIMIT_MAX` |
| `503` | صف پردازش پر است | `NETWATCH_JOB_CONCURRENCY` / صبر و تلاش دوباره |
| ردیف‌های تکراری ثبت نمی‌شوند | IP تکراری | پیش‌نمایش (`import/preview`) دلایل را نشان می‌دهد |
| متن فارسی خراب | نبود BOM/UTF-8 | فایل را با BOM ذخیره کنید یا از فایل نمونه استفاده کنید |

---

## ۸. پشتیبان‌گیری یا بازیابی ناموفق

| نشانه | علت | اقدام |
| --- | --- | --- |
| `فضای دیسک کافی نیست` | کمتر از نیاز `VACUUM INTO` | آزادسازی فضا؛ `NETWATCH_MIN_FREE_BYTES` |
| `پشتیبان ساخته‌شده معتبر نیست` | فایل ناقص/خراب | دیسک و فضای آزاد را بررسی کنید؛ پشتیبان قبلی را نگه دارید |
| `409` در بازیابی | بازیابی/پشتیبان‌گیری هم‌زمان | چند لحظه صبر و تلاش دوباره |
| `بازیابی ... مجاز نیست` | نسخهٔ پشتیبان جدیدتر از برنامه | نسخهٔ برنامه را ارتقا دهید |
| `db:restore` امتناع می‌کند | سرویس در حال اجراست | `systemctl stop netwatch` |

---

## ۹. Retention متوقف می‌شود

| نشانه | علت | اقدام |
| --- | --- | --- |
| `blocked.samples = missing_daily_stats:N` | روز تجمیع‌نشده در بازهٔ حذف | عادی است؛ اجرای بعدی پس از تجمیع ادامه می‌دهد |
| `status: skipped` با `reason: legal_hold` | Legal Hold فعال | اگر قانونی نیست، در تنظیمات خاموش کنید |
| `409` | اجرای هم‌زمان/قفل نمونهٔ دیگر | `--status` را ببینید؛ قفل پس از انقضا آزاد می‌شود |
| `status: interrupted` | Crash در اجرای قبلی | خودکار در راه‌اندازی بعدی علامت می‌خورد؛ اجرای دستی بزنید |
| رشد دیسک با وجود Retention | `samples_retention_days` بزرگ یا سقف `max_rows_per_run` | سیاست/سقف را تنظیم کنید |

---

## ۱۰. خطاهای پرتکرار API

| کد | معنی | اقدام |
| --- | --- | --- |
| `400` | ورودی نامعتبر | بدنه/پارامتر را با مستندات API تطبیق دهید |
| `401` | بدون نشست معتبر | ورود دوباره |
| `403` | نبود مجوز یا شبکهٔ غیرمجاز | نقش کاربر و `NETWATCH_ADMIN_ALLOWED_CIDRS` |
| `404` | منبع یافت نشد | شناسه را بررسی کنید |
| `409` | تعارض وضعیت (قفل/بازیابی/نسخهٔ رهبری) | چند لحظه بعد تلاش کنید |
| `413` | حجم بیش از حد | سقف فایل Import (فایل MBTiles سقف حجم ندارد) |
| `429` | سقف نرخ | `Retry-After` را رعایت کنید |
| `503` | صف پر/سرویس در حال بازیابی | بعداً تلاش کنید |
| `504` | مهلت سخت Probe | تنظیم `NETWATCH_PROBE_TIMEOUT_MS` یا بررسی مقصد |

خطاهای Probe: `429` یعنی سهمیهٔ Probe (`NETWATCH_PROBE_RATE_LIMIT_MAX`)؛ `503`
با کد `PROBE_QUEUE_FULL` یعنی ظرفیت صف مرکزی پر است؛ `504` با کد
`PROBE_TIMEOUT` یعنی کار Abort شد. Ping گروهی `202` برمی‌گرداند و نتیجه از
`GET /api/devices/bulk/probe/:jobId` خوانده می‌شود.

آزمون `server/tests/integration/api-contract.test.mjs` تضمین می‌کند شکل پاسخ‌ها با
تایپ‌های رابط کاربری هم‌خوان بماند؛ اگر فیلدی حذف/تغییر نام دهد، Pipeline شکست
می‌خورد.

---

## ۱۱. سناریوهای بازیابی سریع

| سناریو | اقدام کوتاه |
| --- | --- |
| Restart ناگهانی سرویس | `systemctl status`؛ اگر خارج شد `systemctl start`؛ WAL خودکار Replay می‌شود |
| SIGTERM | تخلیهٔ مرتب؛ کد خروج `0`؛ دادهٔ تأییدشده حفظ می‌شود |
| SIGKILL | پس از راه‌اندازی، `db:doctor` بزنید؛ تراکنش نیمه‌کاره Rollback شده است |
| قطع شبکهٔ داخلی | دادهٔ محلی سالم است؛ پس از بازگشت شبکه، موتور ادامه می‌دهد و SSE دوباره وصل می‌شود |
| از دست رفتن Lease رهبری | نمونهٔ دیگر رهبر می‌شود؛ نتایج دیررس با Fencing رد می‌شوند (بدون دادهٔ متناقض) |
| فایل Import خراب | درخواست `400` با فهرست خطا؛ هیچ ردیفی ثبت نمی‌شود |
| توقف Engine در حین بررسی | بررسی‌های در جریان تخلیه/ابطال می‌شوند؛ رکورد نیمه‌کاره ساخته نمی‌شود |

---

## ۱۲. جمع‌آوری اطلاعات برای پشتیبانی

```bash
{
  date -Is; node -v; uname -a
  sudo systemctl status netwatch --no-pager | head -20
  curl -fsS http://127.0.0.1:8787/api/health
  sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch npm run db:doctor -- --json
  sudo journalctl -u netwatch -n 300 --no-pager
} > /tmp/netwatch-support.txt 2>&1
```

پیش از ارسال، مطمئن شوید فایل شامل رمز، توکن یا کلید خصوصی نیست؛ لاگ‌ها این
مقادیر را ثبت نمی‌کنند.
