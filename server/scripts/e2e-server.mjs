/**
 * سرور موقت آزمون رابط کاربری (Playwright)
 * ----------------------------------------------------------------
 * یک پوشهٔ داده موقت می‌سازد، سرور را با موتور خاموش بالا می‌آورد و با پایان
 * آزمون، فرآیند و داده‌ها را پاک می‌کند. هیچ اثری روی data/ واقعی نمی‌ماند.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-ui-e2e-'));
const port = String(process.env.E2E_PORT || 3210);
const password = process.env.E2E_ADMIN_PASSWORD || 'E2ePass!2345';

// سرور دیگر حساب مدیر را از محیط نمی‌سازد؛ پیش از بالا آمدن آن، پایگاه‌داده را
// می‌سازیم و حساب آزمون را از همان مسیر رسمی createUser درج می‌کنیم. این کار
// قبل از spawn انجام می‌شود تا آزمون‌های Playwright هرگز با فرم راه‌اندازی اولیه
// روبه‌رو نشوند و هیچ رمزی در env سرور قرار نگیرد.
process.env.NETWATCH_DATA_DIR = dataDir;
process.env.NETWATCH_ENGINE = '0';
// config.js در همین فرآیند هم خوانده می‌شود؛ PORT ارثی محیط (ممکن است ۰ باشد)
// نباید پیش از اجرای سرور، پیکربندی را نامعتبر کند.
process.env.PORT = port;
const { db } = await import('../db.js');
const { createUser, findUserByUsername } = await import('../auth.js');
try {
  if (!findUserByUsername('admin')) {
    createUser({ username: 'admin', password, role: 'admin', displayName: 'مدیر سامانه' });
  }
} finally {
  db.close();
}

const child = spawn(process.execPath, ['server/index.js', '--dev'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    NETWATCH_DATA_DIR: dataDir,
    NETWATCH_ENGINE: '0',
    NETWATCH_BACKUP_INTERVAL_HOURS: '24',
    // هر آزمون UI یک ورود تازه انجام می‌دهد و همه از یک IP می‌آیند؛ سقف نرخ
    // ورود پیش‌فرض (۱۰ در دقیقه) باعث مسدودشدن آزمون‌های آخر می‌شد. سقف نرخ
    // واقعی در آزمون‌های امنیتی سرور بررسی می‌شود، نه اینجا.
    NETWATCH_LOGIN_RATE_LIMIT_MAX: '100',
    PORT: port,
    HOST: '127.0.0.1',
  },
});

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  try {
    child.kill(signal || 'SIGTERM');
  } catch {
    /* فرآیند قبلاً پایان یافته است */
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('exit', () => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* پاک‌سازی موقت بی‌اثر */
  }
});

child.on('exit', (code, signal) => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* بی‌اثر */
  }
  process.exit(code ?? (signal ? 1 : 0));
});
