import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT || 3210);

/**
 * آزمون‌های رابط کاربری روی یک سرور موقت و پایگاه‌دادهٔ جداگانه اجرا می‌شوند؛
 * داده‌های واقعی پوشهٔ data/ هرگز دست‌کاری نمی‌شود.
 *
 * اجرا:  npm run test:ui
 */
export default defineConfig({
  testDir: './web/tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'fa-IR',
    timezoneId: 'Asia/Tehran',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'node server/scripts/e2e-server.mjs',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      E2E_PORT: String(PORT),
      E2E_ADMIN_PASSWORD: process.env.E2E_ADMIN_PASSWORD || 'E2ePass!2345',
    },
  },
});
