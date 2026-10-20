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

const child = spawn(process.execPath, ['server/index.js', '--dev'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    NETWATCH_DATA_DIR: dataDir,
    NETWATCH_ADMIN_PASSWORD: password,
    NETWATCH_ENGINE: '0',
    NETWATCH_BACKUP_INTERVAL_HOURS: '24',
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
