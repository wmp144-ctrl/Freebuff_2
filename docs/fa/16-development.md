# راهنمای توسعه

این سند برای کسی است که می‌خواهد کد NetWatch را تغییر دهد یا قابلیت تازه اضافه
کند: ساختار پوشه‌ها، قواعد کدنویسی، الگوهای تکرارشونده و گام‌های افزودن یک
Endpoint، Migration یا صفحهٔ تازه.

---

## ۱. پیش‌نیازها

| مورد | مقدار |
| --- | --- |
| Node.js | `>= 22.12.0` (این نسخه در `engines` قفل شده است) |
| مدیر بسته | npm با `package-lock.json` (از `npm ci` استفاده کنید) |
| پایگاه‌دادهٔ جداگانه | لازم نیست (`node:sqlite` داخلی) |
| مرورگر برای تست UI | فقط برای `npm run test:ui` |

```bash
npm ci
npm run dev        # سرور با پورت پیش‌فرض (حالت توسعه)
npm run dev:web    # Vite روی 0.0.0.0:3000
```

> در حالت `--dev`، CSP اعمال نمی‌شود و Vite HMR فعال است. هیچ‌کدام از این دو
> در تولید صادق نیست؛ رفتار تولید را جداگانه بررسی کنید.

---

## ۲. ساختار کد

```
server/
├── index.js        ← bootstrap، میدل‌ورها، اتصال روترها، خاموشی
├── config.js       ← خواندن و اعتبارسنجی متغیرهای محیطی
├── db.js           ← اتصال SQLite، Migrationها، DEFAULT_SETTINGS، بکاپ‌پذیری
├── store.js        ← CRUD تجهیزات و کوئری‌های فهرست
├── engine.js       ← موتور پایش (زمان‌بندی، وضعیت، هشدار)
├── leader.js       ← قفل رهبری + Fencing Token
├── retention.js    ← سیاست حذف داده
├── backup.js       ← ساخت/اعتبارسنجی/بازیابی پشتیبان
├── auth.js         ← ورود، نشست، کاربران
├── permissions.js  ← نقش‌ها و مجوزها
├── sse.js          ← جریان رویداد
├── net-policy.js   ← محدودهٔ مجاز Probe
├── validation.js   ← اعتبارسنجی URL/بدنهٔ JSON
├── routes/         ← روترهای Express بر اساس دامنه
└── scripts/        ← ابزارهای CLI عملیاتی
web/src/            ← React (توضیح در 07-frontend.md)
```

| قانون مرزی | توضیح |
| --- | --- |
| `routes/*` منطق دامنه ندارد | اعتبارسنجی ورودی و پاسخ؛ محاسبه در ماژول دامنه |
| `db.js` تنها جای Migration | هیچ‌جای دیگر `ALTER TABLE` ننویسید |
| `engine.js` تنها نویسندهٔ وضعیت تجهیز | API وضعیت را دستی تغییر نمی‌دهد |
| `config.js` تنها خوانندهٔ `process.env` | بقیهٔ کد از `config` استفاده می‌کند |

---

## ۳. قواعد کدنویسی

- **ESM خالص:** `type: "module"`، بدون `require`.
- **بدون وابستگی تازه بدون دلیل:** پروژه عمداً کم‌وابستگی است؛ هر بستهٔ جدید
  سطح حمله و هزینهٔ نگهداری اضافه می‌کند.
- **اعداد جادویی نداریم:** آستانه‌ها و پیش‌فرض‌ها در `DEFAULT_SETTINGS` یا
  `config.js` تعریف می‌شوند.
- **خطاها قابل‌دسته‌بندی‌اند:** خطاهای پایگاه‌داده از `DbError` با کد
  (`DB_ERROR_CODES`) عبور می‌کنند؛ پیام فارسی برای کاربر، جزئیات برای لاگ.
- **هر تغییر حساس حسابرسی می‌شود:** از `recordAudit` استفاده کنید.
- **کارهای سنگین در صف:** Import/Export و عملیات طولانی از `jobs.js` عبور کنند.
- **خاموشی تمیز:** هر منبع دائمی (تایمر، سوکت، قفل) باید در مسیر shutdown آزاد شود.

```js
// الگوی درست خطای دامنه
throw new DbError(DB_ERROR_CODES.CONSTRAINT, 'گروهی با این نام وجود دارد.', {
  status: 409,
  sql: 'INSERT INTO groups…',
});
```

لینت با `eslint.config.mjs` اجرا می‌شود: `no-var`، `prefer-const`، `eqeqeq`
(هوشمند) و `no-empty` با استثنای `catch` خالی (عمدی برای خطاهای غیربحرانی).

> پیام‌های فارسی در کد **بدون نیم‌فاصله‌های تصادفی** و با اصطلاحات یکسان نوشته
> شوند؛ کاربر همان متن را در رابط می‌بیند.

---

## ۴. افزودن یک Endpoint

1. روتر مناسب را در `server/routes/` انتخاب یا بسازید.
2. مجوز را صریح تعیین کنید:

```js
import { requirePermission } from '../permissions.js';

router.get('/widgets', requirePermission('inventory:read'), (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: listWidgets() });
});
```

3. ورودی را اعتبارسنجی کنید (نه در دامنه، نه در کلاینت).
4. منطق را در ماژول دامنه بگذارید، نه در روتر.
5. روتر را در `server/index.js` وصل کنید:

```js
app.use('/api', widgetsRouter);
```

6. اگر تغییردهنده است، مطمئن شوید `auditMutations` آن را می‌بیند.
7. آزمون یکپارچه بنویسید: دسترسی مجاز، `401` بدون نشست، `403` با نقش کم‌مجوز،
   ورودی نامعتبر.
8. مستند [API](06-api.md) را به‌روز کنید.

### واگرایی قرارداد

آزمون `server/tests/integration/api-contract.test.mjs` شکل پاسخ‌ها را با تایپ‌های
رابط کاربری مقایسه می‌کند. اگر فیلدی حذف/تغییر نام دهید، این آزمون می‌شکند —
این ویژگی است، نه مانع.

---

## ۵. افزودن Migration

1. `SCHEMA_VERSION` را در `server/db.js` یک واحد افزایش دهید.
2. تابع گام را **idempotent** بنویسید:

```js
function migration6Widgets(db) {
  if (!hasColumn(db, 'devices', 'widget_flag')) {
    db.exec('ALTER TABLE devices ADD COLUMN widget_flag INTEGER DEFAULT 0');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_devices_widget ON devices(widget_flag)');
}
```

3. گام را به فهرست `MIGRATIONS` اضافه کنید.
4. `PRAGMA user_version` و `schema_migrations` در همان تراکنش نوشته می‌شوند —
   دستی تغییرشان ندهید.
5. آزمون‌ها: `npm run test:db` و
   `node --test server/tests/integration/upgrade-and-install.test.mjs`.
6. مستند [پایگاه‌داده](05-database.md) و [ارتقا](15-upgrade-release.md) را
   به‌روز کنید.

> گام Migration هرگز داده را حذف نمی‌کند. حذف داده فقط وظیفهٔ Retention است.

---

## ۶. افزودن تنظیم تازه

1. کلید و پیش‌فرض را در `DEFAULT_SETTINGS` (`server/db.js`) اضافه کنید.
2. اگر مقدار از محیط هم می‌آید، در `server/config.js` با `intSetting`/`bool`
   اعتبارسنجی و در `configSummary` برای نمایش ثبت کنید.
3. مرز مجاز را در `NUM_RANGES`، نوع محدود را در `ENUMS` و نوع بولی را در
   `BOOLEAN_KEYS` (همگی در `server/db.js`) اضافه کنید — `sanitizeSettings`
   همان‌جا اعمال می‌شود.
4. مقدار را در `GET /api/settings` ببینید و در رابط کاربری قابل ویرایش کنید.
5. آزمون: مقدار نامعتبر باید با پیام روشن رد شود (`server/tests/unit/config.test.mjs`).

---

## ۷. افزودن صفحهٔ رابط

خلاصهٔ گام‌ها (جزئیات در [رابط کاربری](07-frontend.md)):

1. `web/src/pages/NewPage.tsx`
2. مسیر در `web/src/App.tsx`
3. تابع API در `web/src/lib/api.ts` + تایپ در `types.ts`
4. آیتم منو در `components/Layout.tsx`
5. کنترل دسترسی بر اساس `user.permissions`
6. `npm run typecheck && npm run test:web`

---

## ۸. کار با موتور

- تغییر در زمان‌بندی/آستانه‌ها معمولاً **در تنظیمات** انجام می‌شود، نه در کد.
- اگر منطق گذار وضعیت را تغییر می‌دهید، آزمون‌های `engine-*` را ببینید؛ آن‌ها
  سناریوهای نوسان، Fencing، Crash و تأخیر هشدار را پوشش می‌دهند.
- هر عملیات نوشتن در موتور باید `epoch` و `lifecycle` را بررسی کند تا نتیجهٔ
  رهبر قبلی پس از تعویض رهبری ثبت نشود.

---

## ۹. عیب‌یابی توسعه

| نشانه | اقدام |
| --- | --- |
| `ERR_UNKNOWN_FILE_EXTENSION` | فایل `.ts` را با `--experimental-strip-types` اجرا کنید |
| آزمون‌ها روی دادهٔ واقعی اثر می‌گذارند | `useTempDataDir` از `server/tests/helpers.mjs` |
| `database is locked` | نمونهٔ دیگری در حال اجراست؛ `NETWATCH_DATA_DIR` جدا بدهید |
| پورت ۳۰۰۰ اشغال | `PORT` را تغییر دهید یا سرور قبلی را ببندید |
| کش قدیمی در رابط | Hard Reload؛ APIها `no-store` هستند |

---

## ۱۰. چک‌لیست پیش از Pull Request

- [ ] `npm run lint` و `npm run typecheck` بدون خطا
- [ ] `npm run test:unit` و `npm run test:integration` سبز (به‌جز نقص شناخته‌شدهٔ
      `db-cleanup` که در [آزمون‌ها](14-testing.md#۴-آزمون-ناموفق-و-علت-آن) توضیح
      داده شده است)
- [ ] آزمون تازه برای رفتار تازه (شامل حالت خطا)
- [ ] مستندات مرتبط به‌روز (API/پایگاه‌داده/Changelog)
- [ ] بدون راز، توکن یا مسیر محلی در کد و مستندات
- [ ] بدون تغییر ناخواسته در `package-lock.json`

---

## مطالب مرتبط

- [معماری](02-architecture.md)
- [API](06-api.md)
- [پایگاه‌داده](05-database.md)
- [رابط کاربری](07-frontend.md)
- [آزمون و تضمین کیفیت](14-testing.md)
- [ارتقا و انتشار](15-upgrade-release.md)
