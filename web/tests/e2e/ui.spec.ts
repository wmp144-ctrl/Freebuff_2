import { test, expect, type Page } from '@playwright/test';

/**
 * آزمون‌های Regression رابط کاربری برای سناریوهای پرخطر:
 *   • ورود/خروج، RTL و سلامت داشبورد
 *   • CRUD تجهیز از رابط (ثبت، ویرایش، حذف)
 *   • جست‌وجو/فیلتر، جدول و Import
 *   • قطع/اتصال مجدد SSE و نمایش داده کهنه
 *   • خطای API و بازیابی
 *   • نقش Viewer: رابط فقط‌خواندنی + 403 سرور
 *   • Responsive بدون سرریز افقی
 *
 * آزمون‌ها ترتیبی اجرا می‌شوند تا دادهٔ ساخته‌شده در هر مرحله در مرحلهٔ بعد
 * قابل استفاده باشد؛ هر آزمون دادهٔ خودش را با نام یکتا می‌سازد.
 */
test.describe.configure({ mode: 'serial' });

const ADMIN = { username: 'admin', password: process.env.E2E_ADMIN_PASSWORD || 'E2ePass!2345' };
const RUN = Date.now().toString(36).slice(-6);

async function login(page: Page, creds = ADMIN) {
  await page.goto('/login');
  await page.fill('#username', creds.username);
  await page.fill('#password', creds.password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard');
}

/** فراخوانی API از داخل مرورگر؛ کوکی نشست و CSRF همان نشست استفاده می‌شود. */
async function api<T = unknown>(
  page: Page,
  method: string,
  path: string,
  data?: unknown
): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ method, path, data }) => {
      const match = document.cookie.match(/(?:^|;\s*)nw_csrf=([^;]+)/);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (match) headers['X-CSRF-Token'] = decodeURIComponent(match[1]);
      const res = await fetch(path, {
        method,
        headers,
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      return { status: res.status, body };
    },
    { method, path, data }
  ) as Promise<{ status: number; body: T }>;
}

test('login, RTL and dashboard health sections render', async ({ page }) => {
  await login(page);

  await expect(page).toHaveURL(/\/dashboard$/);
  expect(await page.locator('html').getAttribute('dir')).toBe('rtl');
  expect(await page.locator('html').getAttribute('lang')).toBe('fa');

  await expect(page.getByTestId('network-health')).toBeVisible();
  // عنوان «سلامت برنامه» هم در منوی کنار و هم در سرتیتر بخش وجود دارد؛
  // ارجاع دقیق به سرتیتر همان بخش از ابهام انتخابگر جلوگیری می‌کند.
  await expect(page.getByTestId('app-health')).toBeVisible();
  await expect(page.getByTestId('network-health').getByRole('heading', { name: 'سلامت شبکه' })).toBeVisible();
  await expect(page.getByTestId('app-health').getByRole('heading', { name: 'سلامت برنامه' })).toBeVisible();
  // بخش‌های سلامت در حالت پیش‌فرض جمع‌اند و فقط وضعیت کلی را نشان می‌دهند.
  await expect(page.getByTestId('network-health-summary')).toBeVisible();
  await expect(page.getByTestId('app-health').getByText('API', { exact: true })).toBeHidden();
  await page.getByTestId('network-health-toggle').click();
  await page.getByTestId('app-health-toggle').click();
  await expect(page.getByTestId('app-health').getByText('API', { exact: true })).toBeVisible();
  await expect(page.getByTestId('app-health').getByText('پایگاه‌داده', { exact: true })).toBeVisible();

  // نمودارها واقعاً رندر می‌شوند (نه فقط داده در DOM)
  await expect(page.locator('.recharts-surface').first()).toBeVisible();

  // اتصال SSE برقرار می‌شود و داده به‌عنوان زنده علامت می‌خورد
  const badge = page.getByTestId('live-badge').first();
  await expect(badge).toHaveAttribute('data-state', 'live', { timeout: 25_000 });
  await expect(page.getByTestId('stale-notice')).toHaveCount(0);
});

test('app health page loads on a direct visit and is not the JSON health endpoint', async ({ page }) => {
  await login(page);
  // بارگذاری مستقیم (نه ناوبری داخلی) باید صفحهٔ SPA را بدهد، نه JSON؛ مسیر
  // پایش همچنان `/health` و `/api/health` است.
  await page.goto('/app-health');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'سلامت برنامه' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('CPU و حافظه')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('live-badge').first()).toHaveAttribute('data-state', 'live', { timeout: 25_000 });
});

test('device create, edit, search and delete through the UI', async ({ page }) => {
  await login(page);
  await page.goto('/devices');
  await expect(page.getByRole('button', { name: 'افزودن تجهیز' })).toBeVisible();

  const name = `E2E-دستگاه-${RUN}`;
  await page.getByRole('button', { name: 'افزودن تجهیز' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('افزودن تجهیز جدید')).toBeVisible();
  await dialog.getByPlaceholder('مثلاً سوئیچ دسترسی طبقه ۳').fill(name);
  await dialog.getByPlaceholder('192.168.1.10').fill('10.240.0.10');
  await dialog.getByPlaceholder('R12-U4').fill('R1-U1');
  await dialog.getByRole('button', { name: 'ذخیره', exact: true }).click();
  await expect(page.getByText('تجهیز جدید افزوده شد')).toBeVisible({ timeout: 15_000 });
  await expect(dialog).toHaveCount(0);

  // جست‌وجو: فقط تجهیز ساخته‌شده می‌ماند
  const search = page.getByPlaceholder('جست‌وجو در تجهیزات…');
  await search.fill(name);
  await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('E2E-Import-1')).toHaveCount(0);

  // ویرایش از کارت
  const card = page.locator('.device-card', { hasText: name });
  await card.getByTitle('ویرایش').click();
  const editDialog = page.getByRole('dialog');
  const edited = `${name}-ویرایش`;
  await editDialog.getByPlaceholder('مثلاً سوئیچ دسترسی طبقه ۳').fill(edited);
  await editDialog.getByRole('button', { name: 'ذخیره', exact: true }).click();
  await expect(page.getByText('تغییرات تجهیز ذخیره شد')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(edited)).toBeVisible({ timeout: 15_000 });

  // حذف با تأیید
  page.once('dialog', (d) => d.accept());
  await page.locator('.device-card', { hasText: edited }).getByTitle('حذف').click();
  await expect(page.getByText('تجهیز حذف شد')).toBeVisible({ timeout: 15_000 });
  await search.fill('');
  await expect(page.getByText(edited)).toHaveCount(0, { timeout: 15_000 });
});

test('status filter, table view and empty state stay usable', async ({ page }) => {
  await login(page);
  await page.goto('/devices');

  // ترکیب جست‌وجوی بی‌نتیجه و فیلتر وضعیت باید Empty State بدهد
  const search = page.getByPlaceholder('جست‌وجو در تجهیزات…');
  await search.fill(`NO-SUCH-${RUN}`);
  await page.getByRole('button', { name: 'وصل', exact: true }).click();
  await expect(page.getByText('تجهیزی با این فیلترها یافت نشد')).toBeVisible({ timeout: 15_000 });
  await search.fill('');
  await page.getByRole('button', { name: 'همه', exact: true }).click();
  await expect(page.getByText('تجهیزی با این فیلترها یافت نشد')).toHaveCount(0, { timeout: 15_000 });

  // نمایش جدول و استفاده از مرتب‌سازی
  await page.getByRole('button', { name: 'جدول', exact: true }).click();
  await expect(page.locator('table.table')).toBeVisible();
  await page.getByRole('button', { name: /نام تجهیز/ }).click();
  await expect(page.locator('table.table tbody tr').first()).toBeVisible();
});

test('CSV import previews and commits devices', async ({ page }) => {
  await login(page);
  await page.goto('/devices');
  await page.getByRole('button', { name: 'ورود گروهی', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('ورود گروهی تجهیزات از فایل Excel / CSV')).toBeVisible();

  const csv = 'name,ip,group,location\nE2E-Import-1,10.240.1.1,گروه آزمون,E2E\n';
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'e2e-devices.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('\uFEFF' + csv, 'utf8'),
  });

  await expect(dialog.getByText(/ردیف خوانده شد/)).toBeVisible({ timeout: 20_000 });
  const commit = dialog.getByRole('button', { name: /ثبت .* تجهیز/ });
  await expect(commit).toBeEnabled();
  await commit.click();
  await expect(dialog.getByText(/تجهیز ثبت شد/)).toBeVisible({ timeout: 20_000 });
});

test('map page renders the interactive map container', async ({ page }) => {
  await login(page);
  await page.goto('/map');
  await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 30_000 });
});

test('SSE disconnect marks data stale and reconnect restores live state', async ({ page }) => {
  await login(page);
  const badge = page.getByTestId('live-badge').first();
  await expect(badge).toHaveAttribute('data-state', 'live', { timeout: 25_000 });

  // قطع واقعی کانال زنده: درخواست SSE مسدود می‌شود و صفحه دوباره بارگذاری می‌شود.
  // (setOffline سوکت باز SSE را نمی‌بندد و آزمون را غیرقابل‌اعتماد می‌کند.)
  // الگوی گلوب باید رشتهٔ پرس‌وجو را هم بگیرد؛ جریان SSE با
  // `/api/events?devices=…` باز می‌شود و بدون «*» هیچ‌گاه مسدود نمی‌شد.
  await page.route('**/api/events*', (route) => route.abort());
  await page.reload();
  await expect(page.getByTestId('stale-notice')).toBeVisible({ timeout: 30_000 });
  await expect(badge).not.toHaveAttribute('data-state', 'live');

  // بازگشت شبکه: رویداد online اتصال را فوری بازسازی می‌کند و داده دوباره تازه می‌شود.
  await page.unroute('**/api/events*');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(badge).toHaveAttribute('data-state', 'live', { timeout: 40_000 });
  await expect(page.getByTestId('stale-notice')).toHaveCount(0, { timeout: 20_000 });
});

test('API failure shows a retryable error instead of stale live data', async ({ page }) => {
  await login(page);
  await page.route('**/api/dashboard/summary*', (route) => route.abort());
  await page.goto('/dashboard');
  await expect(page.getByText(/ارتباط با سرور برقرار نشد/)).toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId('network-health')).toHaveCount(0);

  await page.unroute('**/api/dashboard/summary*');
  await page.getByRole('button', { name: 'تلاش دوباره' }).click();
  await expect(page.getByTestId('network-health')).toBeVisible({ timeout: 25_000 });
});

test('viewer gets read-only UI and forbidden writes are rejected by the server', async ({ browser, page }) => {
  await login(page);
  const username = `viewer-${RUN}`;
  const created = await api<{ id: number }>(page, 'POST', '/api/auth/users', {
    username,
    password: 'ViewerPass!2345',
    role: 'viewer',
    displayName: 'بیننده آزمون',
  });
  expect(created.status).toBe(201);

  const device = await api<{ id: number }>(page, 'POST', '/api/devices', {
    name: `E2E-Viewer-${RUN}`,
    ip: '10.240.2.2',
  });
  expect(device.status).toBe(201);

  const viewerContext = await browser.newContext();
  const viewerPage = await viewerContext.newPage();
  await login(viewerPage, { username, password: 'ViewerPass!2345' });

  await viewerPage.goto('/devices');
  await expect(viewerPage.getByRole('button', { name: 'افزودن تجهیز' })).toHaveCount(0);
  await expect(viewerPage.getByRole('button', { name: 'ورود گروهی' })).toHaveCount(0);

  await viewerPage.goto('/settings');
  await expect(viewerPage.getByText('دسترسی فقط‌خواندنی')).toBeVisible();
  await expect(viewerPage.getByRole('button', { name: 'کاربران', exact: true })).toHaveCount(0);

  const forbidden = await api(viewerPage, 'DELETE', `/api/devices/${device.body.id}`);
  expect(forbidden.status).toBe(403);

  // خروج از حساب و بازگشت به صفحهٔ ورود
  await viewerPage.getByRole('button', { name: 'خروج', exact: true }).click();
  await expect(viewerPage.locator('#password')).toBeVisible({ timeout: 20_000 });
  await viewerContext.close();
});

test('mobile layout has no horizontal overflow', async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dashboard');
  await expect(page.getByTestId('network-health')).toBeVisible();

  for (const path of ['/dashboard', '/devices', '/settings']) {
    await page.goto(path);
    await page.waitForTimeout(800);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
  }
});
