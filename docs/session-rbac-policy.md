# سیاست Session و RBAC — NetWatch

**نسخه:** 1.1.0 (فاز ۳) · **مخاطب:** مدیر سامانه/تیم عملیات/توسعه‌دهنده
**مرجع کد:** `server/auth.js`، `server/permissions.js`، `server/password-policy.js`،
`server/rate-limit.js`، `server/index.js`.

---

## ۱. نقش‌ها

| نقش | برچسب | خلاصه |
| --- | --- | --- |
| `admin` | Administrator | همهٔ مجوزها؛ کاربران، تنظیمات، حسابرسی، پشتیبان/بازیابی، Reset |
| `operator` | Operator | عملیات روزمره: تجهیزات، هشدارها، تعمیرات، نقشه، Probe، کنترل موتور |
| `viewer` | Viewer | فقط خواندن؛ بدون Probe، بدون هیچ نوشتن/مدیریت |

نام `administrator` به `admin` نرمال می‌شود؛ هر نقش ناشناخته رد می‌شود. نقش
کاربر در جدول `users` و در هر درخواست از پایگاه‌داده خوانده می‌شود؛ بنابراین
تغییر نقش **بلافاصله** روی نشست‌های فعال اثر می‌گذارد (بدون نیاز به ورود مجدد).

### ماتریس مجوزها

| مجوز | admin | operator | viewer |
| --- | :-: | :-: | :-: |
| `dashboard:read` (و SSE) | ✅ | ✅ | ✅ |
| `devices:read` | ✅ | ✅ | ✅ |
| `devices:write` | ✅ | ✅ | ❌ |
| `reports:read` | ✅ | ✅ | ✅ |
| `alerts:read` / `alerts:write` | ✅ | ✅ / ✅ | ✅ / ❌ |
| `maintenance:read` / `maintenance:write` | ✅ | ✅ / ✅ | ✅ / ❌ |
| `inventory:read` / `inventory:write` | ✅ | ✅ / ✅ | ✅ / ❌ |
| `markers:read` / `markers:write` | ✅ | ✅ / ✅ | ✅ / ❌ |
| `ops:read` / `ops:write` | ✅ | ✅ / ✅ | ✅ / ❌ |
| `engine:read` | ✅ | ✅ | ✅ |
| `engine:control` | ✅ | ✅ | ❌ |
| `probe:run` (+ محدودهٔ مقصد) | ✅ | ✅ | ❌ |
| `settings:read` | ✅ | ✅ | ✅ |
| `settings:write` | ✅ | ❌ | ❌ |
| `system:health` | ✅ | ✅ | ❌ |
| `users:manage` | ✅ | ❌ | ❌ |
| `audit:read` | ✅ | ❌ | ❌ |
| `demo:reset` | ✅ | ❌ | ❌ |

**قواعد اجرا:**

1. هر Router یک `routePermission({read,write})` دارد؛ GET/HEAD/OPTIONS با مجوز
   خواندن و بقیه با مجوز نوشتن سنجیده می‌شوند.
2. عملیات حساس‌تر مجوز دقیق اضافه دارند: `users:manage`، `audit:read`،
   `settings:write`، `demo:reset`، `engine:control`، `probe:run`.
3. Probe علاوه بر مجوز، باید مقصدش در allowlist شبکه باشد (دو شرط مستقل).
4. کنترل در Backend است؛ UI فقط برای تجربهٔ کاربر دکمه‌ها را پنهان می‌کند.
5. مسیرهای ناشناختهٔ `/api` → ۴۰۴ JSON؛ مسیر محافظت‌شده بدون نشست → ۴۰۱.

---

## ۲. چرخهٔ عمر نشست

```
Login ──► (حذف نشست کوکی قبلی) ──► صدور توکن ۲۵۶-bit + CSRF
   │
   ├─ هر درخواست: هش توکن → ردیف sessions → بررسی expires_at/last_seen/disabled
   │                └─ idle/expired/disabled ⇒ حذف ردیف ⇒ ۴۰۱
   ├─ هر ۶۰ ثانیه: به‌روزرسانی last_seen_at (کاهش نوشتن WAL)
   ├─ Sweeper ساعتی: حذف expires_at ≤ now یا last_seen_at ≤ now−idle
   ├─ Logout: حذف ردیف جاری + پاک‌کردن کوکی‌ها
   ├─ Logout-all: حذف همهٔ ردیف‌های همان user_id
   └─ تغییر رمز/غیرفعال‌شدن: حذف همهٔ نشست‌های کاربر در همان تراکنش
```

### پارامترها

| پارامتر | پیش‌فرض | بازه | متغیر |
| --- | ---: | --- | --- |
| عمر مطلق | ۱۲ ساعت | ۱..۷۲۰ ساعت | `NETWATCH_SESSION_HOURS` |
| Idle Timeout | ۶۰ دقیقه | ۱..۷۲۰ دقیقه | `NETWATCH_SESSION_IDLE_MINUTES` |
| حداکثر تلاش ناموفق | ۵ | ۳..۱۰۰ | `NETWATCH_LOGIN_MAX_FAILURES` |
| مدت قفل | ۱۵ دقیقه | ۱..۱۴۴۰ | `NETWATCH_LOGIN_LOCKOUT_MINUTES` |
| حداقل طول رمز | ۱۲ | ۸..۱۲۸ | `NETWATCH_PASSWORD_MIN_LENGTH` |
| الزام ترکیب | روشن | ۰/۱ | `NETWATCH_PASSWORD_REQUIRE_COMPLEXITY` |

اگر Idle > عمر مطلق باشد، به عمر مطلق محدود و هشدار داده می‌شود.

### کوکی‌ها

| کوکی | HttpOnly | SameSite | Secure | نقش |
| --- | :-: | :-: | :-: | --- |
| `nw_session` | ✅ | `Strict` | در HTTPS | توکن نشست (فقط هش در DB) |
| `nw_csrf` | ❌ (برای خواندن JS) | `Strict` | در HTTPS | double-submit CSRF |

`Secure` فقط وقتی تنظیم می‌شود که سرویس با TLS اجرا شود یا Express از طریق
Trusted Proxy `req.secure` را تأیید کند؛ هدر `X-Forwarded-Proto` بدون تنظیم
`NETWATCH_TRUST_PROXY` ملاک نیست. `Max-Age` برابر عمر مطلق نشست است.

### Session Fixation

در هر ورود موفق، هر نشستی که کوکی آن همراه درخواست آمده باشد حذف و توکن/CSRF
تازه صادر می‌شود. بنابراین کوکی از پیش تثبیت‌شده پس از Login کار نمی‌کند.

### ابطال (Revocation)

| رویداد | نشست‌های جاری | نشست‌های دیگر کاربر |
| --- | --- | --- |
| Logout | باطل | دست‌نخورده |
| Logout-all | باطل | باطل |
| تغییر رمز توسط Admin | باطل | باطل |
| غیرفعال‌شدن | باطل | باطل |
| تغییر نقش | **معتبر** (نقش جدید فوراً اعمال) | معتبر |
| حذف کاربر | CASCADE در DB | CASCADE |
| انقضا/Idle | باطل + حذف ردیف | مستقل |

> تغییر نقش نشست را باطل نمی‌کند چون مجوزها در هر درخواست از DB خوانده
> می‌شوند؛ این رفتار آزمون شده است (ارتقا → نوشتن مجاز، تنزل → ۴۰۳ فوری).

---

## ۳. سیاست رمز عبور

- حداقل ۱۲ نویسه (قابل تنظیم) و حداکثر ۱۰۲۴ نویسه.
- حداقل سه دسته از چهار دسته (کوچک/بزرگ/رقم/نماد) **یا** عبارت ≥۲۰ نویسه.
- رد رمزهای رایج/تکراری/دنبالهٔ ساده/دارای نویسهٔ کنترلی/فاصلهٔ ابتدا-انتها.
- رد رمز برابر نام کاربری یا «نام کاربری + پسوند کمتر از ۴ نویسه».
- هش Argon2id با `m=19456,t=2,p=1`، نمک تصادفی، مقایسهٔ امن.
- رمز خام هرگز لاگ/حسابرسی/پاسخ API نمی‌شود.
- رمز نخستین مدیر: از `NETWATCH_ADMIN_PASSWORD` (باید سیاست را پاس کند) یا
  تولید تصادفی ۲۴ نویسه با هر چهار دسته در `data/initial-admin-password.txt`
  (۰۶۰۰) که پس از نخستین ورود مدیر حذف می‌شود.

**بازیابی حساب:** قفل خودکار پس از مدت تعیین‌شده برداشته می‌شود. مدیر می‌تواند
با `POST /api/auth/users/:id/unlock` یا هر ویرایش کاربر (نقش/رمز/وضعیت) قفل را
بردارد. تغییر رمز توسط Admin همهٔ نشست‌های کاربر را باطل می‌کند. سرویس
self-service ایمیل/OTP در محیط آفلاین ندارد (ریسک R-06).

---

## ۴. Brute Force و محدودیت نرخ

| لایه | کلید | پیش‌فرض | نتیجه |
| --- | --- | --- | --- |
| Login/IP+Username | IP و `username` | ۱۰ در ۱۵ دقیقه | ۴۲۹ + `Retry-After` |
| Lockout حساب | `users.id` (DB) | ۵ شکست متوالی | ۴۰۱ عمومی تا پایان قفل |
| عمومی API | IP | ۶۰۰/دقیقه | ۴۲۹ |
| Probe/Ping/Engine check | IP + user | ۶۰/دقیقه | ۴۲۹ |
| Import/Export/Reset | IP + user | ۲۰/دقیقه | ۴۲۹ |
| API مدیریتی | IP + user | ۱۲۰/دقیقه | ۴۲۹ |

Lockout در پایگاه‌داده ذخیره می‌شود و با ری‌استارت/چندنمونه از بین نمی‌رود؛
محدودیت نرخ درون‌حافظه‌ای است (R-01). پیام ۴۲۹ شامل جزئیات حساب نیست.

---

## ۵. APIهای مدیریت نشست/کاربر

| متد/مسیر | مجوز | توضیح |
| --- | --- | --- |
| `POST /api/auth/login` | عمومی (Rate Limit) | ورود؛ چرخش نشست |
| `POST /api/auth/logout` | نشست + CSRF | خروج جاری |
| `POST /api/auth/logout-all` | نشست + CSRF | خروج از همهٔ دستگاه‌ها |
| `GET /api/auth/me` | نشست | کاربر/نقش/مجوزها |
| `GET /api/auth/users` | `users:manage` | فهرست + سیاست رمز + وضعیت قفل |
| `POST /api/auth/users` | `users:manage` | ساخت کاربر با سیاست رمز |
| `PUT /api/auth/users/:id` | `users:manage` | نقش/رمز/غیرفعال + رفع قفل |
| `POST /api/auth/users/:id/unlock` | `users:manage` | رفع دستی قفل |
| `DELETE /api/auth/users/:id` | `users:manage` | حذف (آخرین Admin نه) |

همهٔ تغییرها CSRF و Origin معتبر می‌خواهند و در Audit ثبت می‌شوند.

---

## ۶. رویه‌های عملیاتی

### ساخت حساب جدید
1. Admin وارد می‌شود → `POST /api/auth/users` با نقش حداقلی لازم.
2. رمز اولیه را از کانال امن به کاربر بدهید (نه در تیکت/چت گروهی).
3. کاربر وارد شود؛ در صورت نیاز Admin رمز را تغییر دهد (نشست‌ها باطل می‌شوند).

### کاربر مشکوک/گم‌شدن دستگاه
1. `POST /api/auth/logout-all` توسط خود کاربر، یا
2. Admin رمز را تغییر دهد/حساب را غیرفعال کند (همهٔ نشست‌ها باطل).
3. Audit را برای `auth.login`/`auth.logout_all`/`user.manage` بررسی کنید.

### حساب قفل‌شده
- منتظر `NETWATCH_LOGIN_LOCKOUT_MINUTES` بمانید یا `unlock` را اجرا کنید.
- پس از ۵ شکست، بررسی کنید IP/نام کاربری در Audit مشکوک است یا خیر.

### تغییر نقش
- ارتقا/تنزل از `PUT /api/auth/users/:id`؛ اثر فوری روی نشست فعال.
- آخرین Admin فعال را نمی‌توان تنزل/غیرفعال/حذف کرد.

---

## ۷. آزمون‌های مرتبط

- `server/tests/unit/auth.test.mjs` (هش، نشست، CSRF، prune)
- `server/tests/unit/password-policy.test.mjs`
- `server/tests/integration/phase3-security.test.mjs`
  (Lockout، Fixation، Idle/Expiry، Logout-all، نقش فعال، CSRF، RBAC)
- `server/tests/integration/auth.test.mjs` و `security.test.mjs` (پوشش قبلی)
