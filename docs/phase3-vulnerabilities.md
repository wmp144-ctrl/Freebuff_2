# فهرست آسیب‌پذیری‌ها — فاز ۳

**NetWatch 1.1.0** · تاریخ: ۲۰۲۶‑۱۰‑۱۹ · دامنه: Backend/Frontend/DB/فایل/شبکه

وضعیت‌ها: **Fixed** (اصلاح و آزمون‌شده)، **Mitigated** (کاهش ریسک با کنترل
جبرانی)، **Accepted** (پذیرفته‌شده و مستند در ریسک‌های باقی‌مانده).

> هیچ آسیب‌پذیری Critical/High در وضعیت باز باقی نمانده است. ردیف‌های
> «Accepted» ریسک عملیاتی‌اند، نه آسیب‌پذیری قابل‌بهره‌برداری مستقیم.

| # | عنوان | شدت | وضعیت | اثر | اصلاح/شاهد |
| --- | --- | --- | --- | --- | --- |
| V-01 | محتوای صفحه‌گسترده فقط با پسوند/MIME سنجیده می‌شد؛ امکان آپلود فایل جعلی و ZIP Bomb | **High** | Fixed | مصرف حافظه/CPU، خطای ۵۰۰، احتمال DoS | `server/file-guard.js`: امضای ZIP/OLE، ساختار workbook، سقف ۶۴MB بازشده، نسبت >۲۰۰، رد ZIP64/رمزنگاری/مسیر داخلی؛ آزمون‌های `file-guard` و phase3 |
| V-02 | نبود قفل حساب پس از تلاش‌های ناموفق (فقط Rate Limit موقت) | **Medium** | Fixed | Brute Force توزیع‌شده/چند‌نمونه‌ای | ستون‌های `failed_login_count`/`locked_until`، قفل ۵ تلاش/۱۵ دقیقه، پیام عمومی، `unlock` مدیریتی؛ آزمون Lockout |
| V-03 | نبود Idle Timeout؛ کوکی رهاشده تا ۱۲ ساعت معتبر می‌ماند | **Medium** | Fixed | سوءاستفاده از نشست رهاشده | `NETWATCH_SESSION_IDLE_MINUTES` (۶۰)، حذف ردیف در `attachUser` و Sweeper؛ آزمون Idle |
| V-04 | نشست ارائه‌شده هنگام Login بازتولید/باطل نمی‌شد | **Medium** | Fixed | Session Fixation در سناریوی تثبیت کوکی | حذف نشست کوکی قبلی + توکن تازه؛ آزمون Fixation |
| V-05 | APIهای مدیریتی از هر شبکه‌ای قابل دسترسی بودند (با نقش Admin) | **Medium** | Fixed | سوءاستفاده از نشست Admin دزدیده‌شده | `NETWATCH_ADMIN_ALLOWED_CIDRS` + `network-access.js`؛ آزمون شبکهٔ مدیریتی |
| V-06 | فایل MBTiles مستقیماً در پوشهٔ قابل‌سرو نوشته می‌شد و نام از ورودی ساخته می‌شد | **Medium** | Fixed | باقی‌ماندن فایل نیمه‌کاره/نام قابل‌پیش‌بینی، سطح حمله Path | `data/tmp` ۰۷۰۰ → اعتبارسنجی → rename با UUID، chmod 0600، پاک‌سازی شروع؛ آزمون Upload Abuse |
| V-07 | سیاست رمز سخت‌گیرانه/قابل تنظیم نبود (حداقل ۸ نویسه بدون ترکیب) | **Medium** | Fixed | رمز ضعیف قابل حدس آنلاین | `password-policy.js` (۱۲ نویسه + ۳ دسته/عبارت ۲۰+، رمز رایج/نام کاربری)؛ آزمون‌های Unit/API |
| V-08 | `X-Forwarded-Host` بدون Trusted Proxy در بررسی Origin پذیرفته می‌شد | **Low** | Fixed | دورزدن بررسی Origin توسط کلاینت غیرمرورگری | پذیرش فقط با `NETWATCH_TRUST_PROXY`؛ آزمون/تست دود پروکسی |
| V-09 | لاگ ساختاریافته مقادیر حساس/نویسهٔ کنترلی را فیلتر نمی‌کرد | **Low** | Fixed | Log Injection/نشت اتفاقی توکن | Redaction و sanitize در `logger.mjs`، Audit و `engine_log`؛ آزمون نشت |
| V-10 | مجوز فایل‌های داده/پشتیبان/نقشه به umask سیستم وابسته بود | **Low** | Fixed | خواندن DB/پشتیبان توسط کاربر محلی دیگر | ۰۷۰۰ برای پوشه‌ها، ۰۶۰۰ برای DB/پشتیبان/MBTiles |
| V-11 | Timeout صریح HTTP برای Slowloris تعریف نشده بود | **Low** | Fixed | نگه‌داشتن اتصال نیمه‌کاره | `requestTimeout`/`headersTimeout`/`keepAliveTimeout` قابل تنظیم |
| V-12 | خطاهای بدنهٔ JSON/فایل پیام خام کتابخانه را برمی‌گرداندند | **Low** | Fixed | افشای جزئیات داخلی/پیام انگلیسی | نگاشت `entity.too.large`/`parse.failed`/... به ۴۱۳/۴۰۰ فارسی |
| V-13 | خروج از حساب فقط نشست جاری را باطل می‌کرد | **Low** | Fixed | نشست‌های دیگر پس از گم‌شدن دستگاه فعال می‌مانند | `POST /api/auth/logout-all` |
| V-14 | فرمول‌های CSV در خروجی خنثی نمی‌شدند (قبلاً فاز ۱) | Medium | Fixed | Formula Injection در Excel | `sanitizeSpreadsheetValue`؛ آزمون `malicious` |
| V-15 | نشت مسیر داخلی/نسخه در سلامت عمومی (قبلاً فاز ۱) | Low | Fixed | کمک به مهاجم برای نقشه‌برداری | `publicHealthPayload` فقط `{ok,status,ts}` |
| V-16 | پاسخ ۵۰۰ برای فایل خراب (قبلاً فاز ۱) | Low | Fixed | نویز پایش/افشای Stack | نگاشت خطا به ۴۰۰/۵۰۴؛ آزمون فایل خراب |
| R-01 | Rate Limit/Lockout درون‌حافظه‌ای/تک‌نمونه‌ای است | Medium | Accepted | در چند نمونه پشت LB، سقف هر نمونه جدا است | استقرار تک‌نمونه یا Redis/DB مشترک (پیشنهاد فاز بعد) |
| R-02 | MFA/WebAuthn وجود ندارد | Medium | Accepted | رمز لو‌رفته کافی است | سیاست شبکهٔ مدیریتی + Lockout؛ افزودن TOTP در فاز بعد |
| R-03 | رمزنگاری پشتیبان در سطح برنامه نیست | Medium | Accepted | دسترسی فیزیکی به پشتیبان = داده کامل | مجوز ۰۶۰۰ + رسانهٔ محافظت‌شده؛ AES-GCM در فاز بعد |
| R-04 | Audit Log فقط از طریق نقش Admin قابل خواندن است ولی امضای رمزنگاری ندارد | Low | Accepted | مدیر کل/DBA می‌تواند ردیف‌ها را تغییر دهد | ارسال به SIEM/Journald فقط‌افزودنی؛ Hash Chain در فاز بعد |
| R-05 | CSP شامل `style-src 'unsafe-inline'` است | Low | Accepted | ریسک XSS مبتنی بر style محدود | حذف استایل inline در آینده/Nonce؛ اسکریپت inline ممنوع است |
| R-06 | Self-service بازیابی رمز/فراموشی رمز وجود ندارد | Low | Accepted | وابستگی به مدیر برای Recovery | مسیر `unlock`/تغییر رمز توسط Admin مستند شده؛ ایمیل در محیط آفلاین نیست |

## کنترل‌های تأییدشدهٔ قبلی (بدون تغییر در فاز ۳)

- Argon2id + ارتقای scrypt + زمان‌بندی یکسان برای کاربر ناموجود.
- توکن نشست ۲۵۶ بیتی و ذخیرهٔ فقط SHA-256؛ کوکی `HttpOnly/SameSite=Strict`.
- CSRF double-submit + بررسی Origin؛ ۴۰۳ برای توکن جعلی/خارج از مبدأ.
- Prepared Statement در همهٔ پرس‌وجوها؛ اعتبارسنجی دامنه‌ای.
- Probe allowlist + مسدودبودن Metadata/Link-Local/6to4/Teredo/NAT64.
- Audit حداقل ۳۶۵ روز، فقط Admin، بدون رمز/توکن.
- CSP/HSTS/هدرهای امنیتی و `no-store` برای API.
