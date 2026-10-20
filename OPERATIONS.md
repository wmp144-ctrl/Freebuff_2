# راهنمای عملیات (Operations Runbook)

این سند کارهای روزمرهٔ بهره‌بردار را پوشش می‌دهد: کنترل سرویس، پایش سلامت،
مدیریت کاربران، رسیدگی به حادثه و رویه‌های اضطراری. نصب در
[INSTALL.md](INSTALL.md) و ارتقا در [UPGRADE.md](UPGRADE.md) آمده است.

---

## ۱. کنترل سرویس

```bash
sudo systemctl status netwatch --no-pager
sudo systemctl restart netwatch          # پس از تغییر تنظیمات محیطی
sudo systemctl stop netwatch             # SIGTERM: تخلیهٔ بررسی‌ها + Checkpoint + بستن DB
sudo journalctl -u netwatch -f           # لاگ ساختاریافتهٔ JSON
sudo journalctl -u netwatch --since "1 hour ago" | grep -E '"level":"(warn|error)"'
```

**هرگز `kill -9` نزنید** مگر در شرایط اضطراری؛ SIGTERM مسیر خاموشی مرتب است
(تخلیهٔ بررسی‌های در جریان، بستن SSE، Checkpoint WAL، ثبت `shutdown_done`).

`systemctl enable netwatch` اجرای خودکار پس از ری‌استارت سرور را تضمین می‌کند.

---

## ۲. پایش سلامت

| نقطهٔ پایانی | دسترسی | محتوا |
| --- | --- | --- |
| `GET /api/health` | عمومی | `ok`, `status`, `uptime`, `version`, `db`, `engine` |
| `GET /api/status` | `dashboard:read` | تفکیک سلامت سرور/شبکه/برنامه + `app` (DB، SSE، پشتیبان، دیسک، Probe، صف) |
| `GET /api/system/health` | `system:health` | جزئیات: DB health، WAL، دیسک، پشتیبان، TLS، SSE، صف، لاگ اخیر |
| `GET /api/system/db/health` | `system:health` | نتیجهٔ `quick_check`، تعداد جدول‌ها، اندازه |
| `GET /api/system/app-health` | `system:health` | CPU/RAM/Heap/Event Loop، تأخیر API و DB، تاریخچهٔ نمودار |
| `GET /api/engine/status` | `ops:read` | وضعیت موتور، رهبری، backlog، تأخیر زمان‌بندی |
| `GET /api/system/retention` | `system:health` | سیاست، قفل و اجراهای Retention |
| `GET /api/system/backups` | `system:health` | فهرست و وضعیت پشتیبان |

### پایش خودکار (نمونه)

```bash
# Cron هر ۵ دقیقه: اگر health خطا داد یا ok=false بود، هشدار بده
*/5 * * * * curl -fsS http://127.0.0.1:8787/api/health >/dev/null || \
  echo "NetWatch health FAILED at $(date -Is)" | mail -s "ALERT netwatch" ops@example.com
```

شاخص‌های کلیدی برای هشدار:

| شاخص | آستانهٔ پیشنهادی |
| --- | --- |
| `status != ok` در `/api/system/health` | فوری |
| `engine.stale == true` | بیش از ۳ بازه بدون بررسی |
| `engine.backlog` صعودی/بزرگ | متناسب با تعداد تجهیزات |
| `db.disk.freeBytes` کمتر از `minFreeBytes` | فوری (پشتیبان‌گیری متوقف می‌شود) |
| `app.jobs.rejected > 0` | بررسی هم‌زمانی Import/Map |
| `sse.droppedClients > 0` به‌طور مکرر | کلاینت کند یا شبکه |
| `retention.lastStatus` ناموفق | بررسی لاگ و فضای دیسک |

---

## ۳. مدیریت کاربران و نقش‌ها

| نقش | مجوزها |
| --- | --- |
| `admin` | همه: تنظیمات، کاربران، حسابرسی، پشتیبان/بازیابی، Retention، بازنشانی دمو |
| `operator` | عملیات روزمره: تجهیزات، هشدارها، تعمیرات، گروه/تگ/نقشه، Probe، کنترل موتور، خواندن سلامت برنامه |
| `viewer` | فقط خواندن داشبورد، تجهیزات، گزارش‌ها، هشدارها، تنظیمات (نمایش) |

رویه‌ها:

```bash
# ساخت کاربر (Admin)
curl -fsS -b /tmp/nw.jar -X POST -H 'x-csrf-token: <token>' -H 'content-type: application/json' \
  -H 'origin: https://netwatch.local' \
  -d '{"username":"ali","password":"<قوی>","role":"operator","displayName":"علی"}' \
  https://netwatch.local/api/auth/users

# تغییر نقش / غیرفعال‌سازی / بازکردن قفل حساب
curl -fsS -b /tmp/nw.jar -X PUT ... /api/auth/users/<id>
curl -fsS -b /tmp/nw.jar -X POST ... /api/auth/users/<id>/unlock

# خروج از همهٔ نشست‌های یک کاربر (پس از تغییر نقش یا حادثه)
```

قواعد عملیاتی:

- حداقل یک حساب `admin` فعال نگه دارید؛ حذف آخرین Admin ممکن نیست.
- تغییر نقش **بلافاصله** روی نشست فعال اثر می‌گذارد (مجوزها از DB خوانده می‌شوند).
- رخدادهای حساس (تغییر تنظیمات، حذف، تغییر کاربر، بازیابی) در `audit_log` ثبت
  می‌شوند؛ برای بازبینی: «تنظیمات ← حسابرسی» یا `GET /api/audit`.
- قفل حساب پس از `NETWATCH_LOGIN_MAX_FAILURES` تلاش ناموفق اعمال می‌شود و
  می‌تواند توسط Admin باز شود.

---

## ۴. موتور پایش

- فقط یک نمونه «رهبر» Ping می‌زند؛ نمونه‌های دیگر در حالت آماده‌به‌کار هستند.
  قفل با `engine_lock` و Fencing Token (`epoch`) محافظت می‌شود.
- توقف/شروع از UI یا API:

```bash
curl -fsS -b /tmp/nw.jar -X POST -H 'x-csrf-token: <token>' -H 'content-type: application/json' \
  -H 'origin: https://netwatch.local' -d '{}' \
  https://netwatch.local/api/engine/control/stop   # یا start | restart | recover
```

- `POST /api/engine/check-all` یک چرخهٔ کامل فوری صف می‌کند (مجوز `probe:run`).
- اگر `icmpAvailable=false` است، حالت `auto` به TCP برمی‌گردد؛ برای ICMP واقعی
  `cap_net_raw` را به سرویس بدهید.
- شاخص‌های سلامت موتور: `leader`, `tickLagMs`, `stalled`, `backlog`, `fencing`.

---

## ۵. کارهای زمان‌بندی‌شدهٔ درون برنامه

| کار | بازه | توضیح |
| --- | --- | --- |
| بررسی تجهیزات | `ping_interval` (پیش‌فرض ۳۰s) | موتور، با `max_workers` هم‌زمان |
| تجمیع روزانه | دوره‌ای | پر کردن `daily_stats` پیش از هرس نمونه |
| Retention | `retention_run_time` / `retention_interval_minutes` | پیش‌فرض روزانه ۰۳:۰۰ |
| پشتیبان خودکار | `backup_interval_hours` | پیش‌فرض ۲۴ ساعت |
| Checkpoint WAL | `checkpoint_interval_minutes` | کنترل رشد WAL |
| پاک‌سازی نشست‌ها و فایل‌های موقت | دوره‌ای | جلوگیری از انباشت |

---

## ۶. رویه‌های حادثه

### الف) سرویس بالا نمی‌آید

```bash
sudo journalctl -u netwatch -n 200 --no-pager
sudo -u netwatch env NETWATCH_DATA_DIR=/var/lib/netwatch npm run db:doctor
```

| پیام | معنی | اقدام |
| --- | --- | --- |
| `CONFIG_INVALID` | مقدار محیطی نامعتبر | پیام دقیق را بخوانید و `netwatch.env` را اصلاح کنید |
| `پایگاه‌داده آسیب دیده` / `DB_CORRUPT` | خرابی فایل | بازیابی از آخرین پشتیبان (BACKUP_RESTORE.md) |
| `مهاجرت ... ناموفق` | Migration شکست خورد | علت را رفع یا پشتیبان پیش از Migration را بازگردانید (UPGRADE.md) |
| `EADDRINUSE` | پورت اشغال است | سرویس دیگر/پورت را بررسی کنید |
| `EACCES` روی داده | مجوز فایل | مالکیت `/var/lib/netwatch` را به `netwatch` بدهید |

### ب) موتور متوقف یا کهنه است

1. `GET /api/status` → `engine.running` و `engine.stale`.
2. اگر `leader=false` است، نمونهٔ دیگری رهبر است؛ اگر هیچ نمونه‌ای رهبر نیست،
   قفل منقضی می‌شود و نمونهٔ آماده‌به‌کار آن را می‌گیرد (تا `NETWATCH_ENGINE_LOCK_TTL_MS`).
3. اگر `stalled=true` و `tickLagMs` بزرگ است، بار را بررسی کنید (`max_workers`،
   بازهٔ پایش، تعداد تجهیزات) و در صورت نیاز موتور را restart کنید.

### ج) دیسک پر شده

1. `df -h` و `GET /api/system/health` (`db.disk`).
2. پشتیبان‌های قدیمی را با `POST /api/system/backups/prune` یا
   `npm run db:retention -- --dry-run` بررسی کنید.
3. WAL بزرگ: `POST /api/system/db/checkpoint` (Admin).
4. هرگز فایل `netwatch.db-wal` را دستی حذف نکنید.

### د) دادهٔ اشتباه وارد شده / حذف ناخواسته

- اگر پشتیبان نزدیک دارید: بازیابی کامل (BACKUP_RESTORE.md).
- حذف تجهیز، هشدارها/نمونه‌های آن را هم حذف می‌کند؛ برای بازگردانی به پشتیبان
  نیاز است.
- نوشتن روی Production بدون تأیید مالک داده انجام نشود.

### ه) بازیابی و بازگشت

مراحل دقیق در [BACKUP_RESTORE.md](BACKUP_RESTORE.md) و [UPGRADE.md](UPGRADE.md).

---

## ۷. ظرفیت و مقیاس

| منبع | راهنمای سریع |
| --- | --- |
| هم‌زمانی بررسی | `max_workers × ping_interval ≥ تعداد تجهیزات` |
| رشد داده | هر تجهیز ≈ `86400 / interval` نمونه در روز؛ با `samples_retention_days` محدود کنید |
| گزارش‌های بلندمدت | از `daily_stats` می‌خوانند؛ کاهش `samples_retention_days` گزارش را نمی‌شکند |
| SSE | `NETWATCH_SSE_MAX` (پیش‌فرض ۳۲)؛ کلاینت کند پس از سقف بافر بسته می‌شود |
| Import/MBTiles | `NETWATCH_JOB_CONCURRENCY` و سقف صف؛ بار بیشتر `503` می‌گیرد |
| پشتیبان | به اندازهٔ حجم DB + MBTiles فضای آزاد لازم است (دو برابر برای `VACUUM INTO`) |

اندازه‌گیری:

```bash
npm run load -- --devices 1000 --workers 128
npm run qa:load        # ماتریس ۱۰۰/۵۰۰/۱۰۰۰/۵۰۰۰
npm run qa:soak        # نشتی حافظه/رشد WAL
```

---

## ۸. چک‌لیست روزانه / هفتگی

**روزانه**

- [ ] `/api/health` و `status` سبز
- [ ] خطای `level:"error"` جدید در لاگ
- [ ] فضای دیسک بالای `minFreeBytes`
- [ ] پشتیبان شبانه ساخته و `ok:true`

**هفتگی**

- [ ] `npm run db:doctor` (روی سرور، بدون توقف سرویس)
- [ ] بازیابی آزمایشی آخرین پشتیبان روی محیط تست
- [ ] بازبینی `audit_log` برای تغییرات حساس
- [ ] بازبینی کاربران فعال و نقش‌ها
- [ ] `npm audit` روی نسخهٔ نصب‌شده (اگر وابستگی جدید اضافه شده)

**ماهانه**

- [ ] بررسی روند رشد DB و تنظیم سیاست Retention
- [ ] بازبینی اعتبار گواهی TLS
- [ ] تمرین سناریوی بازیابی از خرابی دیسک
