# گزارش فاز ۱ — اصلاح مشکلات بحرانی و تثبیت هستهٔ NetWatch

**تاریخ:** ۲۰۲۶-۱۰-۱۹ — **دامنه:** Backend (Express + `node:sqlite`)، موتور مانیتورینگ، سیاست شبکه، Rate Limiting، چرخهٔ حیات و مستندات.
**وضعیت:** ✅ تکمیل‌شده — همهٔ آزمون‌های قبلی و جدید سبزند.

---

## ۱. خلاصهٔ اجرایی

| معیار پذیرش | وضعیت | شاهد |
| --- | --- | --- |
| هیچ نتیجه‌ای توسط موتور بدون رهبری ثبت نمی‌شود | ✅ | Fencing Token در `leader.js` + بررسی داخل تراکنش ثبت در `engine.js`؛ `engine-fencing.test.mjs` |
| اجرای هم‌زمان دو موتور ناسازگاری داده نمی‌سازد | ✅ | قفل + epoch اتمی؛ `engine-lock.test.mjs` و `engine-fencing.test.mjs` |
| پس از Shutdown هیچ Timer/Worker بلااستفاده نمی‌ماند | ✅ | `engine-lifecycle.test.mjs`، `jobs-shutdown.test.mjs`، `shutdown-resources.test.mjs` |
| مستندات با رفتار واقعی یکی است | ✅ | `README.md`، `SECURITY.md`، `.env.example` به‌روزرسانی شدند |
| همهٔ تست‌های قبلی و جدید موفق‌اند | ✅ | ۱۶۴ Unit + ۱۴ Web + ۸۴ Integration + ۳ E2E (+۸۷ بررسی Smoke) |
| بدون Regression در عملکرد موجود | ✅ | `npm run verify` سبز؛ رفتار سازگار با پایگاه‌داده‌های قدیمی |

---

## ۲. مشکلات شناسایی‌شده (بر اساس کد واقعی)

### ۲٫۱ چرخهٔ توقف/راه‌اندازی موتور
- `stop()` همگام بود و **قفل رهبری را پیش از پایان Probeهای در جریان آزاد می‌کرد**. موتور دوم می‌توانست رهبر شود و Probeهای موتور اول بعداً نتیجهٔ خود را روی همان تجهیز بنویسند (نوشتن رهبر سابق).
- `restart()` از `stop()` سپس `drain()` جداگانه استفاده می‌کرد و در برابر فراخوانی هم‌زمان (دو Restart یا Restart + Start) سریال نبود.
- تمدید Lease فقط در `tick` انجام می‌شد؛ `tick` تا پایان همهٔ Probeها `await` می‌کرد. Probe طولانی‌تر از TTL باعث انقضای قفل در میانهٔ کار می‌شد.
- `probeIcmp().then(...)` بدون `catch` بود.

### ۲٫۲ Fencing
- قفل فقط `owner` و `expires_at` داشت؛ هیچ شمارندهٔ دورهٔ رهبری وجود نداشت. پس از انتقال رهبری، عملیات قدیمی هیچ راهی برای تشخیص نداشت.

### ۲٫۳ سیاست شبکه
- `DEFAULT_PROBE_CIDRS` شامل `169.254.0.0/16` و `fe80::/10` بود؛ یعنی **Cloud Metadata (`169.254.169.254`) به‌طور پیش‌فرض مجاز بود**.
- تطبیق CIDR خانوادهٔ IPv4/IPv6 را اکیداً جدا می‌کرد و `::ffff:10.0.0.1` با قواعد IPv4 سنجیده نمی‌شد؛ در صورت وجود CIDR نسخهٔ ۶ می‌توانست محدودیت را دور بزند.
- 6to4/Teredo/NAT64 و Zone ID بررسی نمی‌شدند.
- `probe-guard` فقط رشتهٔ IP را می‌سنجید؛ مسیر DNS/نام میزبان سیاست متمرکز نداشت.
- موتور پیش از Probe سیاست شبکه را اعمال نمی‌کرد.

### ۲٫۴ Rate Limiting
- فقط دو لیمیتر (عمومی/سنگین) وجود داشت؛ Login سقف مستقل خودش را داشت اما Import/Probe/مدیریتی از هم جدا نبودند.
- شمارش فقط بر اساس IP بود؛ حملهٔ توزیع‌شده روی یک حساب کاربری سقف نداشت.
- `Map` بدون سقف بود؛ IPهای جعلی می‌توانستند حافظه را بی‌مرز رشد دهند. پاک‌سازی فقط با تایمر و بدون سقف کلید.
- IPهای `::ffff:1.2.3.4` و `1.2.3.4` کلیدهای جدا می‌ساختند (دور زدن سقف با تغییر شکل آدرس).

### ۲٫۵ پیکربندی و مستندات
- `HOST` در README با پیش‌فرض واقعی کد (`127.0.0.1`) ناسازگار بود (README مقدار `0.0.0.0` می‌گفت).
- هر ماژول متغیر محیطی خودش را می‌خواند؛ مقدار نامعتبر (CIDR، TLS ناقص، `TRUST_PROXY` مثل `*`) می‌توانست بی‌صدا نادیده گرفته شود.
- `NETWATCH_BACKUP_DIR` فقط در `backup.js` خوانده می‌شد و در یک منبع مرکزی نبود.

### ۲٫۶ چرخهٔ عمر منابع
- تایمر `kickoff` زمان‌بند پشتیبان پاک نمی‌شد.
- `startSessionSweeper` و `startAuditSweeper` تابع توقف نداشتند.
- `jobs.js` Workerهای فعال را در خاموشی terminate نمی‌کرد و کارهای صف بدون پاسخ می‌ماندند.
- تایمر دسته‌بندی SSE (`flushTimer`) و Listenerهای `bus` در خاموشی آزاد نمی‌شدند.
- `finish()` در خاموشی می‌توانست دوبار اجرا شود.

### ۲٫۷ Migration
- هیچ نسخه‌بندی ساختار (`PRAGMA user_version`) و پشتیبان پیش از Migration وجود نداشت.

---

## ۳. فایل‌های تغییرکرده / افزوده‌شده

| فایل | تغییر |
| --- | --- |
| `server/config.js` | **جدید** — منبع مرکزی پیکربندی، اعتبارسنجی حیاتی، خلاصهٔ ایمن برای لاگ |
| `server/leader.js` | Fencing Token پایدار (`engine_meta.leader_epoch`)، گرفتن/تمدید/آزادسازی اتمی، `verify(epoch)` |
| `server/engine.js` | ترتیب Stop→Drain→Release، توقف/راه‌اندازی سریال، Lease Renewal مستقل، Fencing در شروع/ثبت/تراکنش، سیاست شبکه پیش از Probe، آمار `fenced` |
| `server/net-policy.js` | مسدودسازی پیش‌فرض Metadata/Link-Local، نرمال‌سازی IPv4-mapped/compatible، مسدودسازی 6to4/Teredo/NAT64/Zone، `checkProbeTarget` با DNS |
| `server/probe-guard.js` | گارد async با سیاست متمرکز و بررسی DNS |
| `server/rate-limit.js` | بازنویسی: حوزه‌های مستقل، کلید IP+حساب، سقف کلید/LRU، آمار حافظه، `close()`، نرمال‌سازی IP |
| `server/index.js` | اتصال به `config.js`، لیمیترهای حوزه‌ای، خاموشی کامل منابع، بستن اتصال‌های idle، `shutdown_done` |
| `server/db.js` | `engine_meta`، ستون `epoch`، نسخه‌بندی Schema، **پشتیبان پیش از Migration**، ایندکس یکتای نتیجهٔ عملیات، پیش‌فرض‌های امن Probe، کلیدهای بولی جدید |
| `server/backup.js` | مسیر پشتیبان از Config، آزادسازی تایمر kickoff |
| `server/auth.js` | لیمیتر ورود با کلید حساب، `stopSessionSweeper` |
| `server/audit.js` | `stopAuditSweeper` |
| `server/jobs.js` | ردیابی Workerها، `shutdownJobs()`، رد کار جدید در خاموشی |
| `server/engine-cli.js` | توقف با مهلت تنظیم‌شده و بدون `stop`+`drain` موازی |
| `server/routes/devices.js` / `server/routes/ops.js` | پاسخ `409` برای بررسی دستی روی نمونهٔ بدون رهبری |
| `server/tests/unit/*` | ۷ فایل آزمون جدید (Config، Fencing قفل، Fencing موتور، شبکه، Rate Limit، چرخهٔ حیات، Migration) + ۱ فایل Jobs |
| `server/tests/integration/shutdown-resources.test.mjs` | **جدید** — SIGTERM + SSE + Checkpoint |
| `README.md` / `SECURITY.md` / `.env.example` | هم‌راستاسازی پیش‌فرض‌ها و مستندسازی رفتار جدید |

---

## ۴. شرح اصلاحات

### ۴٫۱ ترتیب صحیح Stop / Drain / Release
- `accepting=false` و `running=false` بلافاصله؛ تایمر چرخه و تایمر تمدید Lease پاک می‌شوند.
- اگر `drainMs > 0` باشد، `drain()` تا پایان Probeهای در جریان صبر می‌کند. در این بازه موتور هنوز رهبر است و نتایج آن‌ها **معتبر** ثبت می‌شوند.
- پس از تخلیه یا پایان مهلت، `lifecycle++` می‌شود (هر عملیات باقی‌مانده Fence می‌شود) و **تنها پس از آن** قفل آزاد می‌شود.
- `stop({drainMs:0})` برای توقف فوری امن است: عملیات در جریان باطل و قفل هم‌زمان آزاد می‌شود. مسیرهای Shutdown (SIGTERM/SIGINT) و Restart از مهلت `NETWATCH_SHUTDOWN_TIMEOUT_MS` استفاده می‌کنند.
- `start()` تا پایان `_stopping` صبر می‌کند و `_startPromise` فراخوانی‌های هم‌زمان را یکی می‌کند. `restart()` با `_restartPromise` سریال است.
- `probeIcmp` دارای `catch` و `logEvent` است.

### ۴٫۲ Fencing Token
- جدول `engine_meta(key,value)` شمارندهٔ `leader_epoch` را نگه می‌دارد. هر دورهٔ رهبری تازه (آزادسازی، انقضا، Crash) شمارنده را در همان تراکنش گرفتن قفل یک واحد بالا می‌برد؛ حتی حذف ردیف قفل در خاموشی تمیز شمارنده را تکرار نمی‌کند.
- `LeaderLock.verify(epoch)` مالک، epoch و TTL زنده را از پایگاه‌داده می‌خواند.
- هر Probe (`performCheck`) یک `lease = {epoch, lifecycle, startedAt}` می‌گیرد. پیش از رزرو زمان‌بندی، پیش از نوشتن در پنجرهٔ تعمیرات، پس از پایان Probe و **در اولین خط تراکنش ثبت** اعتبارسنجی می‌شود. اگر رهبری عوض شده باشد، تراکنش Rollback و نتیجه دور ریخته می‌شود (`stats.fenced` + رویداد `engine_write_fenced`).
- بررسی دستی وقتی موتور خاموش/standby است، یک Lease موقت می‌گیرد؛ اگر نمونهٔ دیگری رهبر باشد پاسخ `409 ENGINE_NOT_LEADER` است و هیچ نوشتنی انجام نمی‌شود.
- `engine_lock.epoch` برای سازگاری و نمایش نگه داشته می‌شود؛ منبع حقیقت یکتایی `engine_meta` است.

### ۴٫۳ سیاست شبکه
- پیش‌فرض‌ها: `10/8`, `172.16/12`, `192.168/16`, `127/8`, `::1/128`, `fc00::/7` (بدون Link-Local/Metadata).
- `canonicalizeIp()` آدرس‌های `::ffff:a.b.c.d` و `::a.b.c.d` را به IPv4 تبدیل می‌کند و Zone ID را رد می‌کند.
- مسدودسازی همیشگی: `0.0.0.0/8`, Multicast, `240/4`, `::`, `ff00::/8`.
- Metadata (`169.254.169.254`, `169.254.170.2`, `100.100.100.200`, `fd00:ec2::254`) فقط با `probe_allow_metadata`/`NETWATCH_PROBE_ALLOW_METADATA`.
- Link-Local (`169.254/16`, `fe80::/10`) فقط با `probe_allow_link_local`/`NETWATCH_PROBE_ALLOW_LINK_LOCAL`.
- 6to4 (`2002::/16`)، Teredo (`2001::/32`) و NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`) فقط با `probe_allow_transition`.
- `checkProbeTarget()` نام میزبان را با `dns.lookup(all)` حل می‌کند و **همهٔ** آدرس‌ها باید مجاز باشند؛ خطای DNS یا وجود یک آدرس غیرمجاز ⇒ رد.
- گارد Probe و خود موتور هر دو از همین سیاست استفاده می‌کنند (تمرکز + دفاع در عمق). تنظیمات در API تنظیمات هم قابل تغییرند (کلیدهای بولی جدید).

### ۴٫۴ Rate Limiting
- چهار حوزه: عمومی، Probe، Import/Export، مدیریتی. Login لیمیتر مستقل خودش را دارد.
- سقف‌ها: عمومی ۶۰۰، Probe ۶۰، Import ۲۰، مدیریتی ۱۲۰، Login ۱۰/۱۵دقیقه (قابل تنظیم).
- Probe/Import/مدیریتی هم با IP و هم با `user.id` شمارش می‌شوند؛ Login با IP و نام کاربری.
- `maxKeys` (پیش‌فرض ۱۰٬۰۰۰) با پاک‌سازی منقضی‌ها و حذف LRU قدیمی‌ترین‌ها؛ `stats()` شامل `keys`, `ipKeys`, `userKeys`, `estimatedBytes` است. `close()` تایمر را آزاد و حافظه را پاک می‌کند.
- IP از `req.ip` (تابع trust proxy اکید Express) خوانده و `::ffff:` نرمال می‌شود. مقدار نامعتبر `NETWATCH_TRUST_PROXY` در شروع رد می‌شود.

### ۴٫۵ پیکربندی
- `server/config.js` تنها منبع `HOST`, `PORT`, `DATA_DIR`, `DB`, `BACKUP_DIR`, TLS, Trust Proxy, مهلت‌ها، سقف‌های نرخ، سیاست Probe و SSE است.
- خطاهای حیاتی `ConfigError` می‌سازند و **پیش از اتصال/نوشتن** برنامه را متوقف می‌کنند؛ پیام فقط نام کلید و بازهٔ مجاز را نشان می‌دهد (بدون مقدار حساس).
- خلاصهٔ `config_loaded` در لاگ هیچ رمز/کلید/مسیر کلید خصوصی ندارد.
- مقدارهای عددی تنظیمات پایش (که از قبل در `db.js` مرزگذاری می‌شدند) همچنان نرمال می‌شوند تا نصب‌های موجود نشکنند.

### ۴٫۶ چرخهٔ عمر و Shutdown
- `engine.stop()` تایمر چرخه، تایمر Lease، هشدارهای معوق و قفل را آزاد می‌کند.
- `jobs.shutdownJobs()` صف را با `JOB_SHUTDOWN` رد و Workerهای فعال را terminate می‌کند.
- `stopSessionSweeper`، `stopAuditSweeper`، تایمر kickoff پشتیبان و `flushTimer` دسته‌بندی SSE در خاموشی آزاد می‌شوند؛ `bus.removeAllListeners()`.
- Lیمیترهای نرخ `close()` می‌شوند.
- `finish()` با نگهبان `finished` فقط یک‌بار WAL را Checkpoint و DB را می‌بندد. پس از مهلت، `closeAllConnections()` اتصال‌های گیرکرده را می‌بندد.
- SSE با `closeAll()` و سپس `closeIdleConnections()` بسته می‌شود.

### ۴٫۷ Migration سازگار با نسخهٔ قبل
- `SCHEMA_VERSION = 2` و `PRAGMA user_version`.
- اگر فایل DB از قبل وجود داشته و نسخه‌اش قدیمی باشد: `wal_checkpoint(TRUNCATE)` سپس کپی `DB.pre-migration-v<old>-<timestamp>` با مجوز `0600`. **اگر پشتیبان ساخته نشود، Migration انجام نمی‌شود.**
- تغییرات افزایشی: `ALTER TABLE engine_lock ADD COLUMN epoch`, `CREATE TABLE engine_meta`, `CREATE UNIQUE INDEX ... samples(device_id, started_at)` (در صورت دادهٔ تکراری قدیمی، هشدار و ادامه).
- داده، مالک قفل و ردیف‌های موجود حفظ می‌شوند (تست `db-migration.test.mjs`).

### ۴٫۸ جلوگیری از رکورد تکراری
- رزرو `next_check_at` پیش از Probe + ادغام بررسی در جریان (`inflight`) + ایندکس یکتای `(device_id, started_at)` + تراکنش ثبت.

---

## ۵. آزمون‌های اجراشده

```bash
npm run lint          # ESLint
npm run typecheck     # TypeScript
npm run build         # Vite production build
npm run test:unit     # 164 آزمون
npm run test:web      # 14 آزمون
npm run test:integration # 84 آزمون (شامل shutdown-resources و TLS)
npm run test:e2e      # smoke (۸۷ بررسی) + ۳ آزمون E2E
```

آزمون‌های جدید:

| فایل | پوشش |
| --- | --- |
| `server/tests/unit/config.test.mjs` | پیش‌فرض‌ها، خطاهای حیاتی، Trust Proxy، CIDR، عدم افشای Secret |
| `server/tests/unit/leader-fencing.test.mjs` | افزایش epoch فقط در انتقال، تمدید، verify، release رهبر سابق |
| `server/tests/unit/engine-fencing.test.mjs` | رهبر سابق، دو بررسی هم‌زمان، Restart در Probe، نتیجهٔ دیرکرده پس از Stop، رد بررسی دستی در standby |
| `server/tests/unit/engine-lifecycle.test.mjs` | Start هم‌زمان، آزادسازی تایمرها/هشدار معوق/قفل، Restart سریال، Failover |
| `server/tests/unit/net-policy-hardening.test.mjs` | Metadata/Link-Local، IPv4-mapped/compatible، 6to4/Teredo/NAT64، Zone، DNS |
| `server/tests/unit/rate-limit.test.mjs` | حوزه‌های مستقل، کلید حساب، سقف حافظه/LRU، نرمال‌سازی IP، close |
| `server/tests/unit/jobs-shutdown.test.mjs` | رد کار جدید و آزادسازی Worker در خاموشی |
| `server/tests/unit/db-migration.test.mjs` | پشتیبان پیش از Migration + حفظ داده + نسخهٔ ساختار |
| `server/tests/integration/shutdown-resources.test.mjs` | SIGTERM، بسته‌شدن SSE، `shutdown_done`، Checkpoint و سلامت DB |

**تغییر آزمون موجود:** `engine-resilience.test.mjs` دو تست Drain را به قرارداد جدید (توقف صریح با `drainMs`) به‌روزرسانی کرد، چون قرارداد قبلی «آزادسازی فوری قفل پیش از پایان عملیات» بود و همان باگ بحرانی محسوب می‌شد؛ آزمون جدید همان سناریو را با مهلت و بدون از دست‌دادن نمونه بررسی می‌کند.

---

## ۶. نتایج

| فرمان | نتیجه |
| --- | --- |
| `npm run lint` | ✅ بدون خطا |
| `npm run typecheck` | ✅ بدون خطا |
| `npm run build` | ✅ |
| `npm run test:unit` | ✅ ۱۶۴/۱۶۴ |
| `npm run test:web` | ✅ ۱۴/۱۴ |
| `npm run test:integration` | ✅ ۸۴/۸۴ |
| `npm run test:e2e` | ✅ ۸۷ بررسی Smoke + ۳/۳ |

**وضعیت پایه پیش از تغییرات:** Unit 132/132 سبز بود. Integration یک شکست داشت (`tls.test.mjs`: پاسخ ۵۰۳ برای `/` چون `web/dist` ساخته نشده بود)؛ پس از `npm run build` این شکست برطرف شد و در اجرای نهایی سبز است. هیچ شکست جدیدی باقی نمانده است.

---

## ۷. ریسک‌های باقی‌مانده

1. **Fencing وابسته به همان SQLite مشترک است.** اگر پایگاه‌داده روی فایل‌سیستم غیرقابل‌اعتماد (NFS با قفل ناسازگار) باشد، تضمین اتمی BEGIN IMMEDIATE می‌تواند ضعیف شود. استقرار باید DB را روی دیسک محلی نگه دارد.
2. **Rate Limiter درون‌حافظه‌ای و per-process است.** با چند نمونه پشت پروکسی، سقف کل باید در پروکسی/Ingress هم اعمال شود؛ پس از Restart شمارنده صفر می‌شود.
3. **سیاست شبکه برای IPهای واقعی دستگاه‌هاست.** ورودی API فقط IP معتبر می‌پذیرد، اما دادهٔ قدیمی/دستی ممکن است نام میزبان داشته باشد؛ `checkProbeTarget` آن را با DNS می‌سنجد، ولی تغییر رکورد DNS بین بررسی و Probe (TOCTOU) در ICMP/TCP قابل حذف کامل نیست. برای شبکهٔ داخلی با DNS تحت کنترل، ریسک پایین است.
4. **پشتیبان پیش از Migration روی پایگاه‌دادهٔ بسیار بزرگ** به فضای دیسک تقریباً برابر حجم DB نیاز دارد؛ سیاست حداقل فضای آزاد پیش از Migration به‌صورت سخت‌گیرانه بررسی نمی‌شود (خطای کپی، Migration را متوقف می‌کند).
5. **ایندکس یکتای `(device_id, started_at)`** روی نصب‌های قدیمی با دادهٔ تکراری ساخته نمی‌شود و فقط هشدار ثبت می‌شود (برای Backward Compatibility)؛ در چنین نصب‌هایی تضمین نهایی همان قفل/`inflight` است.
6. **TLS/HTTPS** همچنان به پیکربندی درست مدیر وابسته است؛ config فقط نبودِ یکی از cert/key را تشخیص می‌دهد، نه اعتبار زنجیرهٔ گواهی.
7. **آزمون چندفرآیندی واقعی Crash در میانهٔ ثبت** به‌صورت سناریوی `kill -9` در `engine-crash.test.mjs` پوشش داده شده؛ شبیه‌سازی Fencing در Unit انجام شده است. آزمون Chaos با قطع برق/دیسک پر خارج از دامنهٔ این فاز است.

---

## ۸. مستندات به‌روزشده

- `README.md`: پیش‌فرض `HOST=127.0.0.1`، شرح Fencing/چرخهٔ توقف، سیاست شبکهٔ سخت‌شده، سقف‌های نرخ مستقل، جدول کامل متغیرها، تفکیک «مقدار حیاتی نامعتبر ⇒ توقف» از «تنظیمات پایش با مرزگذاری».
- `SECURITY.md`: سیاست Probe (Metadata/Link-Local/Transition/DNS) و اعتبارسنجی `NETWATCH_TRUST_PROXY`.
- `.env.example`: `NETWATCH_DB`, `NETWATCH_BACKUP_DIR`, سقف‌های مستقل نرخ، `NETWATCH_RATE_LIMIT_MAX_KEYS`, پرچم‌های Probe، `NETWATCH_SHUTDOWN_TIMEOUT_MS` و `NETWATCH_STOP_DRAIN_MS` با پیش‌فرض واقعی.
- همین گزارش: `docs/phase1-critical-fixes-report.md`.

### بازیابی پایگاه‌داده در صورت شکست Migration

```bash
# فایل پشتیبان ساخته‌شده در کنار DB است:
ls data/netwatch.db.pre-migration-v*
# توقف سرویس، سپس جایگزینی اتمیک:
cp data/netwatch.db.pre-migration-v1-<timestamp> data/netwatch.db
npm start
```

یا از مسیر رسمی `npm run db:restore -- <backup-name>` برای پشتیبان‌های کامل استفاده کنید.
