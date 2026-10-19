# بازبینی امنیتی فاز ۳ — NetWatch

**تاریخ:** ۲۰۲۶‑۱۰‑۱۹ · **نسخه:** 1.1.0 · **نقش:** Application Security Engineer
**دامنه:** Backend (Express/SQLite)، Frontend (React/Vite)، نشست کاربران،
کنترل دسترسی، API، فایل‌های ورودی، شبکه/Probe، Audit/Log و وابستگی‌ها.

این سند نتیجهٔ بازبینی کامل و اقدامات اصلاحی فاز ۳ است. فهرست آسیب‌پذیری‌ها با
شدت و وضعیت در [phase3-vulnerabilities.md](phase3-vulnerabilities.md)، سیاست
نشست/RBAC در [session-rbac-policy.md](session-rbac-policy.md)، امنیت شبکه/TLS در
[network-tls-security.md](network-tls-security.md) و ریسک‌های باقی‌مانده در
[phase3-remaining-risks.md](phase3-remaining-risks.md) آمده است.

---

## ۱. خلاصهٔ مدیریتی

| شدت | یافته | اصلاح‌شده | باقی‌مانده |
| --- | ---: | ---: | ---: |
| Critical | ۰ | ۰ | ۰ |
| High | ۱ | ۱ | ۰ |
| Medium | ۶ | ۶ | ۰ |
| Low | ۶ | ۶ | ۰ |
| کنترل‌های قبلی بازبینی/تثبیت‌شده | ۳ | ۳ | ۰ |
| ریسک عملیاتی/پذیرفته‌شده | ۱۵ | — | ۱۵ (مستند) |

هیچ Endpoint مدیریتی بدون احراز هویت و مجوز باقی نمانده است؛ همهٔ مسیرهای
`/api` (به‌جز `POST /api/auth/login` و سلامت حداقلی) به نشست معتبر نیاز دارند و
هر مسیر تغییردهنده علاوه بر آن CSRF و بررسی Origin دارد. کنترل دسترسی در
Backend اعمال می‌شود و مخفی‌کردن دکمه در UI هیچ‌گاه جای آن را نمی‌گیرد.

**معیار پذیرش:** همهٔ موارد بخش ۱۱ درخواست با آزمون خودکار پاس شده‌اند
(جدول بخش ۷). آزمون‌های امنیتی جدید در
`server/tests/integration/phase3-security.test.mjs` و سه آزمون واحد
`password-policy`، `file-guard` و `network-access` قرار دارند.

---

## ۲. روش بازبینی

1. **مدل تهدید:** سامانهٔ آفلاین روی شبکهٔ داخلی؛ مهاجم ممکن است کاربر معتبر با
   نقش پایین، مهاجم شبکه‌ای، فایل مخرب، یا دارندهٔ یک نشست دزدیده‌شده باشد.
2. **ردیابی داده:** از هر ورودی HTTP تا پرس‌وجوی SQL، مسیر فایل، لاگ و پاسخ.
3. **کنترل لایه‌ای:** AuthN → Session → RBAC → CSRF/Origin → Validation →
   Rate Limit → File Guard → Network Policy → Audit → Error Handling.
4. **آزمون:** اجرای سوئیت کامل + آزمون‌های هدفمند جدید (Brute Force، Fixation،
   Idle/Expiry، CSRF، XSS، SQLi، Path Traversal، Privilege Escalation، Upload
   Abuse، Oversized/Deep JSON، Rate Limit، دسترسی غیرمجاز، نشت Log، مقصد ممنوع).
5. **بازبینی وابستگی:** `npm ci` با lockfile، `npm audit`، بررسی مجوز بسته‌ها.

---

## ۳. احراز هویت و رمز عبور

| کنترل | وضعیت | پیاده‌سازی/شاهد |
| --- | :-: | --- |
| Argon2id با پارامتر OWASP `m=19456,t=2,p=1` | ✅ | `server/auth.js`؛ آزمون واحد هش/verify |
| ارتقای خودکار هش قدیمی scrypt | ✅ | `needsRehash` در نخستین ورود موفق |
| سیاست رمز قابل تنظیم (طول/ترکیب/رمز رایج/شباهت به نام کاربری) | ✅ | `server/password-policy.js` + `NETWATCH_PASSWORD_*` |
| رد رمز خالی/بیش‌از‌حد/کنترلی/تکراری/دنبالهٔ ساده | ✅ | `validatePassword` |
| قفل حساب پس از تلاش ناموفق (پایدار در DB) | ✅ | `failed_login_count`، `locked_until`؛ مهاجرت v4 |
| محدودیت بر اساس IP **و** نام کاربری | ✅ | `loginLimiter` (accountKey) + Lockout حساب |
| پیام یکسان برای «کاربر ناموجود»، «رمز غلط»، «حساب قفل/غیرفعال» | ✅ | `LOGIN_FAILED_MESSAGE` |
| زمان پاسخ یکسان برای کاربر ناموجود | ✅ | اجرای Argon2id روی `DUMMY_HASH` |
| ابطال نشست پس از تغییر رمز/غیرفعال‌شدن | ✅ | حذف همهٔ نشست‌های کاربر در تراکنش |
| بازیابی حساب/Lockout | ✅ | انقضای خودکار + `POST /api/auth/users/:id/unlock` (Admin) |

**سیاست پیش‌فرض:** حداقل ۱۲ نویسه؛ حداقل سه دسته از چهار دسته (کوچک/بزرگ/رقم/
نماد) یا عبارت حداقل ۲۰ نویسه‌ای. رمز بوت‌استرپ تولیدی ۲۴ نویسه و تضمین‌شده از
هر چهار دسته است. رمز خام هرگز ذخیره/لاگ نمی‌شود و پیام خطا آن را بازگو نمی‌کند.

**رفتار Lockout:** پس از `NETWATCH_LOGIN_MAX_FAILURES` (پیش‌فرض ۵) شکست متوالی،
حساب برای `NETWATCH_LOGIN_LOCKOUT_MINUTES` (پیش‌فرض ۱۵) قفل می‌شود. در بازهٔ قفل
حتی رمز صحیح هم پذیرفته نمی‌شود و پاسخ همان ۴۰۱ عمومی است (افشای وضعیت قفل
مجاز نیست). ورود موفق، شمارنده را صفر می‌کند. مدیر می‌تواند از مسیر `unlock`
یا با هر ویرایش کاربر (تغییر نقش/رمز/وضعیت) قفل را بردارد.

---

## ۴. مدیریت نشست

| کنترل | وضعیت | جزئیات |
| --- | :-: | --- |
| بازتولید Session ID پس از Login | ✅ | نشست ارائه‌شده حذف و توکن ۲۵۶ بیتی تازه صادر می‌شود |
| کنترل Session Fixation | ✅ | آزمون «ورود با کوکی قبلی → کوکی قبلی ۴۰۱» |
| انقضای مطلق | ✅ | `NETWATCH_SESSION_HOURS` (پیش‌فرض ۱۲) |
| Idle Timeout | ✅ | `NETWATCH_SESSION_IDLE_MINUTES` (پیش‌فرض ۶۰)؛ ردیف حذف می‌شود |
| پاک‌سازی دوره‌ای نشست‌های منقضی/بی‌فعالیت | ✅ | Sweeper ساعتی + `pruneSessions` |
| Logout جاری | ✅ | حذف ردیف بر اساس هش توکن |
| Logout همهٔ دستگاه‌ها | ✅ | `POST /api/auth/logout-all` |
| Cookie: `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` در HTTPS | ✅ | `Secure` فقط از `req.secure`/TLS خود سرویس |
| ذخیرهٔ فقط SHA-256 توکن/CSRF | ✅ | نشت فایل DB نشست‌ها را قابل استفاده نمی‌کند |
| اعمال فوری تغییر نقش/مجوز | ✅ | نقش از `users` در هر درخواست خوانده می‌شود؛ آزمون ارتقا/تنزل |
| عدم ثبت Session/Token در Log | ✅ | Redaction در `logger.mjs` + آزمون نشت |

> نکته: `Secure` صرفاً بر اساس سوکت TLS یا `req.secure` (که فقط با
> `NETWATCH_TRUST_PROXY` معتبر از هدر ساخته می‌شود) تعیین می‌شود؛ هدر
> `X-Forwarded-Proto` بدون Trusted Proxy قابل جعل است و ملاک نیست.

---

## ۵. کنترل دسترسی (RBAC)

مدل: سه نقش `admin` / `operator` / `viewer` با مجوزهای `<resource>:<action>` در
`server/permissions.js`. ماتریس کامل در [session-rbac-policy.md](session-rbac-policy.md).

| آزمون | انتظار | نتیجه |
| --- | --- | :-: |
| Viewer: تمام GETهای عملیاتی | ۲۰۰ | ✅ |
| Viewer: هر نوشتن (دستگاه، تنظیمات، هشدار، …) | ۴۰۳ | ✅ |
| Viewer: Probe/Ping/Engine Control | ۴۰۳ | ✅ |
| Viewer: کاربران/حسابرسی/سلامت تفصیلی | ۴۰۳ | ✅ |
| Operator: عملیات روزمره (دستگاه/هشدار/تعمیرات/Probe) | ۲۰۰/۲۰۱ | ✅ |
| Operator: تنظیمات مدیریتی، کاربران، حسابرسی، Reset | ۴۰۳ | ✅ |
| Admin: تنظیمات/کاربران/حسابرسی/پشتیبان | ۲۰۰ | ✅ |
| درخواست مستقیم HTTP (بدون UI) | همان محدودیت | ✅ |
| تلاش برای ارسال `role`/`permissions` اضافی در بدنه | نادیده/۴۰۳ | ✅ |
| تغییر نقش روی نشست فعال | فوراً اعمال | ✅ |
| حذف/تنزل آخرین Admin | ۴۰۰ | ✅ |
| محدودیت شبکه‌ای APIهای مدیریتی | ۴۰۳ بیرون از CIDR | ✅ (اختیاری) |

**نکته:** هیچ مسیر `/api` بدون `requireAuth` نیست؛ ترتیب میدل‌ورها در
`server/index.js` (attachUser → audit → requireAuth/CSRF → admin network →
rate limits → routers) عمداً ثابت است. `audit` قبل از گارد مجوز اجرا می‌شود تا
تلاش‌های ۴۰۱/۴۰۳ هم ثبت شوند.

---

## ۶. CSRF، XSS و امنیت مرورگر

| کنترل | وضعیت | جزئیات |
| --- | :-: | --- |
| Double-submit CSRF روی همهٔ تغییرها | ✅ | هدر `X-CSRF-Token` = کوکی `nw_csrf` = هش ذخیره‌شده در نشست |
| رد توکن نامعتبر/جا‌افتاده/تکراری | ✅ | آزمون‌های CSRF؛ توکن قدیمی پس از چرخش نشست رد می‌شود |
| بررسی Origin/Host برای تغییرها | ✅ | `sameOriginOnly`؛ `X-Forwarded-Host` فقط با Trusted Proxy |
| اعتبارسنجی ورودی (شیء ساده، Content-Type، کلیدهای خطرناک) | ✅ | `validation.js` |
| Escape خروجی | ✅ | React به‌صورت پیش‌فرض escape می‌کند؛ JSON با `json escape` |
| `dangerouslySetInnerHTML` / `innerHTML` / `eval` | ✅ صفر مورد | جست‌وجوی کد |
| CSP سخت‌گیرانه در تولید | ✅ | `default-src 'self'`، `script-src 'self'`، `object-src 'none'`، `frame-ancestors 'none'` |
| اسکریپت خارجی/CDN | ✅ صفر | همهٔ دارایی‌ها محلی؛ SheetJS از tarball رسمی pin‌شده |
| هدرهای امنیتی | ✅ | `nosniff`, `DENY`, `Referrer-Policy`, COOP, Permissions-Policy, HSTS در HTTPS |

`style-src 'unsafe-inline'` تنها استثنای CSP است (استایل‌های inline کامپوننت‌ها/
نقشه)؛ هیچ اسکریپت inline مجاز نیست.

---

## ۷. امنیت API

| کنترل | وضعیت | جزئیات |
| --- | :-: | --- |
| اعتبارسنجی تمام Endpointها | ✅ | دامنه‌ای در ماژول‌ها + گارد عمومی؛ تست پوشش Endpointها |
| سقف حجم بدنهٔ JSON | ✅ | `express.json({limit:'2mb'})` → ۴۱۳ |
| JSON ناقص/عمیق/آلوده | ✅ | ۴۰۰ با پیام فارسی، بدون Stack |
| Prepared Statement | ✅ | همهٔ پرس‌وجوها پارامتری؛ شناسه‌های SQL فقط از allowlist |
| عدم افشای خطا/Stack/مسیر/SQL | ✅ | هندلر مرکزی؛ خطاهای ۵۰۰ عمومی |
| Rate Limit عمومی + Probe + Import + Admin + Login | ✅ | ۶۰۰/۶۰/۲۰/۱۲۰/۱۰ در دقیقه (قابل تنظیم) |
| محدودیت درخواست‌های طولانی | ✅ | `requestTimeout=120s`، `headersTimeout=30s`، `keepAlive=5s` |
| سقف اتصال SSE و فشار برگشتی | ✅ | `sse.js` (قبلاً فاز ۱/۲) |
| `Cache-Control: no-store` برای API | ✅ | همهٔ پاسخ‌های `/api` |

---

## ۸. امنیت فایل‌ها (CSV/XLSX/Backup/MBTiles)

| کنترل | وضعیت | جزئیات |
| --- | :-: | --- |
| سقف حجم | ✅ | Import 10MB، MBTiles 1GB (قابل تنظیم) + بررسی فضای دیسک |
| پسوند **و** MIME **و** محتوای واقعی | ✅ | `file-guard.js`: امضای ZIP/OLE، UTF-8 معتبر، ساختار workbook |
| رد فایل اجرایی/تغییرنام‌داده | ✅ | آزمون‌های `malicious` و `phase3` |
| ZIP Bomb / نسبت فشرده‌سازی | ✅ | بازرسی Central Directory، سقف ۶۴MB بازشده، نسبت >۲۰۰ رد |
| مسیر پیمایشی داخل ZIP/نام فایل | ✅ | `..`/مسیر مطلق/backslash رد؛ نام ذخیره کاملاً تولیدی |
| Path Traversal در ذخیره/حذف/بازیابی | ✅ | `basename`, regex نام پشتیبان, allowlist داخل `BACKUP_DIR` |
| فایل موقت | ✅ | `data/tmp` با ۰۷۰۰؛ اعتبارسنجی → rename؛ پاک‌سازی شروع به‌کار |
| فایل خراب → Crash | ✅ | خطای ۴۰۰/۵۰۴؛ Worker جدا با مهلت؛ آزمون سلامت پس از فایل مخرب |
| مجوز فایل/پوشه | ✅ | `data`/`mbtiles`/`backups` = 0700؛ DB/پشتیبان/نقشه = 0600 |
| MBTiles معتبر | ✅ | امضای `SQLite format 3` + بازکردن read-only و خواندن جدول tiles در Worker |
| CSV Formula Injection | ✅ | پیشوند آپاستروف در خروجی (قبلاً فاز ۱) |

---

## ۹. امنیت شبکه و Probe

| کنترل | وضعیت | جزئیات |
| --- | :-: | --- |
| پیش‌فرض Bind روی loopback | ✅ | `HOST=127.0.0.1` |
| TLS و HSTS | ✅ | `NETWATCH_TLS_*`، گواهی محلی، ریدایرکت HTTP→HTTPS |
| Trusted Proxy مشخص | ✅ | فقط مقادیر Express/لیست IP؛ `*` باعث توقف راه‌اندازی |
| محدودیت شبکه‌ای APIهای مدیریتی | ✅ | `NETWATCH_ADMIN_ALLOWED_CIDRS` |
| Probe فقط به مقاصد مجاز | ✅ | CIDR allowlist؛ پیش‌فرض شبکه‌های خصوصی |
| مسدودبودن Metadata/Link-Local/Transition | ✅ | `net-policy.js`؛ تست `169.254.169.254` و Multicast |
| DNS Rebinding | ✅ | همهٔ آدرس‌های DNS باید مجاز باشند؛ مقصد واقعی IP تجهیز است |
| Redirect | ✅ | Probe فقط ICMP/TCP مستقیم است؛ دنبال‌کردن HTTP Redirect وجود ندارد |
| سرویس‌های غیرضروری | ✅ | فقط یک پورت HTTP(S)؛ systemd با `ProtectSystem`/`PrivateTmp` |

جزئیات استقرار و نمونهٔ nginx/systemd در [network-tls-security.md](network-tls-security.md).

---

## ۱۰. Audit و Log

| کنترل | وضعیت | جزئیات |
| --- | :-: | --- |
| Login موفق/ناموفق/قفل | ✅ | `audit_log` + رویداد ساختاریافته |
| تغییر نقش/کاربر/تنظیمات | ✅ | `user.manage`, `settings.update` با actor/role |
| Import/Delete/Restore/Retention | ✅ | `data.import`, `data.delete`, restore/retention رویداد دارند |
| عدم ثبت رمز/توکن/کوکی | ✅ | Redaction کلیدهای حساس + سانسور مقادیر + آزمون نشت |
| Log Injection | ✅ | حذف C0/C1 و `\n`/`\r` از همهٔ مقادیر؛ JSON یک‌خطی |
| حجم/مدت نگهداری | ✅ | Audit حداقل ۳۶۵ روز؛ هرس از Retention Engine |
| غیرقابل‌تغییر برای کاربر عادی | ✅ | فقط `GET /api/audit` با `audit:read`؛ هیچ مسیر حذف/ویرایش |
| سقف حجم لاگ | ✅ | فیلدها/آرایه‌ها/عمق/طول مرزگذاری شده؛ خروجی stdout/journald |

---

## ۱۱. وابستگی‌ها و زنجیرهٔ تأمین

| بررسی | نتیجه |
| --- | --- |
| `npm ci` با lockfile | ✅ ۲۸۷ بسته، نصب تکرارپذیر |
| `npm audit` | ✅ ۰ آسیب‌پذیری (Critical/High/Medium/Low) |
| بستهٔ جدید در فاز ۳ | ✅ هیچ (فقط کد داخلی) |
| وابستگی بلااستفاده | ✅ `depcheck` معیار نیست؛ همهٔ deps در build/server استفاده می‌شوند |
| Pin بودن SheetJS | ✅ tarball رسمی 0.20.3 در lockfile |
| مجوز کتابخانه‌ها | ✅ MIT/ISC/Apache-2.0/BSD؛ بدون مجوز کپی‌لفت محدودکننده |
| اسکریپت نصب | ✅ `npm ci --ignore-scripts` قابل استفاده در CI سخت‌گیرانه |

---

## ۱۲. آزمون‌های امنیتی و نتیجه

| معیار | آزمون | نتیجه |
| --- | --- | :-: |
| Brute Force + Lockout + Recovery | `brute force locks the account…` | ✅ |
| Session Fixation | `session fixation is prevented…` | ✅ |
| Session Expiration/Idle | `absolute expiration and idle timeout…` | ✅ |
| Logout All | `logout-all revokes every session…` | ✅ |
| تغییر نقش روی نشست فعال | `role changes take effect immediately…` | ✅ |
| CSRF نامعتبر/تکراری/Origin | `CSRF tokens that are missing…` | ✅ |
| XSS/SQLi/Path Traversal | `XSS, SQL injection and path traversal…` | ✅ |
| Privilege Escalation | `RBAC blocks direct HTTP privilege escalation…` | ✅ |
| File Upload Abuse/ZIP Bomb | `file upload abuse is rejected…` | ✅ |
| Oversized/Incomplete/Deep JSON | `oversized, incomplete and deeply nested JSON…` | ✅ |
| Rate Limiting | `login attempts are rate limited…` | ✅ |
| دسترسی غیرمجاز به API | `every operational API rejects anonymous requests` | ✅ |
| نشت اطلاعات در Log/Audit | `secrets never leak into logs or audit rows` | ✅ |
| مقصد شبکهٔ ممنوع | `Probe to cloud metadata…` | ✅ |
| محدودیت شبکهٔ مدیریتی | `administrative APIs are restricted…` | ✅ |
| سیاست رمز | `password policy rejects weak…` + Unit | ✅ |
| محتوای فایل (واحد) | `file-guard.test.mjs` | ✅ |
| گارد شبکه (واحد) | `network-access.test.mjs` | ✅ |

فرمان‌های پذیرش:

```bash
npm run lint
npm run typecheck
npm run build
npm run test:unit
npm run test:web
npm run test:integration
npm run test:e2e
npm audit
```

---

## ۱۳. چک‌لیست استقرار امن

- [ ] `NETWATCH_ADMIN_PASSWORD` قوی و یکتا (یا اجازهٔ تولید رمز تصادفی).
- [ ] `HOST` فقط در صورت نیاز؛ پشت فایروال/پروکسی معکوس.
- [ ] TLS فعال و `NETWATCH_TRUST_PROXY=loopback` در حالت پروکسی.
- [ ] `NETWATCH_ADMIN_ALLOWED_CIDRS` متناسب با شبکهٔ مدیریت.
- [ ] `NETWATCH_PROBE_ALLOWED_CIDRS` محدود به شبکهٔ واقعی.
- [ ] `NETWATCH_LOGIN_MAX_FAILURES`/`LOCKOUT` و سیاست رمز مطابق خط‌مشی سازمان.
- [ ] داده/پشتیبان روی فایل‌سیستم با دسترسی محدود (۰۷۰۰/۰۶۰۰).
- [ ] Journald/ELK با نگهداری و دسترسی محدود؛ بدون ارسال رمز/توکن.
- [ ] پشتیبان رمزنگاری‌شده در رسانهٔ جدا (ریسک باقی‌مانده R-04).

---

## ۱۴. محدودیت‌های این بازبینی

- آزمون‌های مرورگر واقعی (CSP/XSS در DOM) در این محیط اجرا نشد؛ Escape مبتنی بر
  React و نبود `dangerouslySetInnerHTML` به‌صورت ایستا بررسی شد. پیشنهاد: اجرای
  Playwright در CI با CSP واقعی.
- Rate Limit درون‌حافظه‌ای است و بین چند نمونه مشترک نیست (R-01).
- TLS/گواهی در آزمون با CA محلی بررسی شد، نه با گواهی عمومی/ACME.
- نفوذ شبکه‌ای واقعی (Port Scan/DAST) انجام نشده؛ دامنه آفلاین است.
