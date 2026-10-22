/**
 * NetWatch — پیوست تجهیزات
 * ----------------------------------------------------------------
 * پیوست‌ها در `data/attachments` (۰۷۰۰) و با نام تولیدی ذخیره می‌شوند؛ هیچ
 * بخشی از نام کاربر در مسیر نوشتن نمی‌آید. نوع فایل از «محتوای واقعی»
 * (magic bytes) تشخیص داده می‌شود، نه از پسوند یا MIME اعلامی مرورگر.
 * فقط تصویر، PDF و متن ساده پذیرفته می‌شود تا فایل اجرایی یا آرشیو فشرده
 * (ZIP bomb) وارد نشود.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { getSettings } from './db.js';

export const HARD_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const ATTACHMENTS_DIR = path.join(config.dataDir, 'attachments');

export const ALLOWED_TYPES = Object.freeze({
  png: { ext: 'png', mime: 'image/png', kind: 'image' },
  jpeg: { ext: 'jpg', mime: 'image/jpeg', kind: 'image' },
  gif: { ext: 'gif', mime: 'image/gif', kind: 'image' },
  webp: { ext: 'webp', mime: 'image/webp', kind: 'image' },
  pdf: { ext: 'pdf', mime: 'application/pdf', kind: 'file' },
  text: { ext: 'txt', mime: 'text/plain', kind: 'file' },
});

/** سقف حجم مؤثر بر اساس تنظیمات (۱ تا ۲۰ مگابایت) */
export function attachmentMaxBytes(settings = getSettings()) {
  const mb = Number(settings.attachment_max_mb);
  const safe = Number.isFinite(mb) ? Math.min(20, Math.max(1, Math.round(mb))) : 5;
  return safe * 1024 * 1024;
}

export function ensureAttachmentsDir() {
  fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(ATTACHMENTS_DIR, 0o700);
  } catch {
    /* برخی فایل‌سیستم‌ها chmod را پشتیبانی نمی‌کنند */
  }
  return ATTACHMENTS_DIR;
}

function startsWith(buf, bytes) {
  return buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);
}

/** تشخیص نوع از محتوای فایل؛ null یعنی نوع مجاز نیست. */
export function detectFileType(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return ALLOWED_TYPES.png;
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return ALLOWED_TYPES.jpeg;
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return ALLOWED_TYPES.gif;
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return ALLOWED_TYPES.webp;
  if (buffer.toString('ascii', 0, 5) === '%PDF-') return ALLOWED_TYPES.pdf;
  // امضاهای اجرایی/آرشیوی صریحاً رد می‌شوند (حتی اگر بایت‌هایشان شبیه متن باشد).
  if (
    startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) || // ZIP/DOCX/XLSX
    startsWith(buffer, [0x37, 0x7a, 0xbc, 0xaf]) || // 7z
    startsWith(buffer, [0x1f, 0x8b]) || // gzip
    startsWith(buffer, [0x7f, 0x45, 0x4c, 0x46]) || // ELF
    startsWith(buffer, [0x4d, 0x5a]) // PE/EXE
  ) {
    return null;
  }
  // متن ساده: UTF-8 معتبر و فقط کاراکترهای کنترلی مجاز (tab/newline/CR).
  if (!buffer.includes(0) && buffer.length <= 2 * 1024 * 1024) {
    const text = buffer.toString('utf8');
    if (!text.includes('\uFFFD')) {
      let printable = true;
      for (const byte of buffer) {
        if (byte < 9 || (byte > 13 && byte < 32) || byte === 127) {
          printable = false;
          break;
        }
      }
      if (printable) return ALLOWED_TYPES.text;
    }
  }
  return null;
}

/** نام نمایشی امن (بدون مسیر، کاراکتر کنترلی و طول محدود) */
export function safeDisplayName(name, fallbackExt = 'bin') {
  const base = path.basename(String(name || 'file'));
  const cleaned = [...base]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code > 31 && code !== 127 && ch !== '/' && ch !== '\\';
    })
    .join('')
    .trim()
    .slice(0, 160);
  return cleaned || `attachment.${fallbackExt}`;
}

/**
 * ذخیرهٔ محتوا روی دیسک با نام تولیدی و مجوز ۰۶۰۰.
 * @returns {{storedName:string, sizeBytes:number}}
 */
export function writeAttachmentFile(buffer, type) {
  ensureAttachmentsDir();
  const storedName = `${Date.now()}-${crypto.randomUUID()}.${type.ext}`;
  const full = path.join(ATTACHMENTS_DIR, storedName);
  fs.writeFileSync(full, buffer, { mode: 0o600, flag: 'wx' });
  try {
    fs.chmodSync(full, 0o600);
  } catch {
    /* بی‌اثر */
  }
  return { storedName, sizeBytes: buffer.length };
}

/** مسیر امن یک فایل پیوست؛ مسیرهای خارج از پوشه هرگز ساخته نمی‌شوند. */
export function attachmentPath(storedName) {
  const name = path.basename(String(storedName || ''));
  if (!name || name !== String(storedName)) return null;
  const full = path.join(ATTACHMENTS_DIR, name);
  if (path.dirname(full) !== ATTACHMENTS_DIR) return null;
  return full;
}

export function removeAttachmentFile(storedName) {
  const full = attachmentPath(storedName);
  if (!full) return false;
  try {
    fs.unlinkSync(full);
    return true;
  } catch {
    return false;
  }
}

/**
 * حذف دو مرحله‌ای فایل تا «رکورد بدون فایل» یا «فایل بدون رکورد» پیش نیاید
 * (BUG-19):
 *   1) فایل با rename به نام `.trash-*` کنار گذاشته می‌شود (اتمیک روی همان دیسک)،
 *   2) رکورد پایگاه‌داده حذف می‌شود،
 *   3) اگر حذف رکورد شکست بخورد، فایل به نام اصلی برگردانده می‌شود؛
 *      در غیر این صورت فایل کنارگذاشته‌شده پاک می‌شود.
 * فایل‌های `.trash-*` در شروع سرور هم پاک می‌شوند.
 */
export function stageAttachmentRemoval(storedName) {
  const full = attachmentPath(storedName);
  if (!full) return null;
  const trash = path.join(ATTACHMENTS_DIR, `.trash-${crypto.randomUUID()}-${path.basename(full)}`);
  try {
    fs.renameSync(full, trash);
  } catch {
    // فایل از قبل موجود نیست؛ رکورد باید حذف شود.
    return { trash: null, path: full };
  }
  return {
    trash,
    path: full,
    restore: () => {
      try {
        fs.renameSync(trash, full);
        return true;
      } catch {
        return false;
      }
    },
    commit: () => {
      try {
        fs.unlinkSync(trash);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * پاک‌سازی فایل‌های یتیم پیوست در شروع سرور.
 *
 * - فایل `.trash-*` باقی‌مانده از حذف نیمه‌کاره پاک می‌شود.
 * - فایلی که رکورد پایگاه‌داده ندارد (مثلاً Crash بین نوشتن فایل و INSERT)
 *   فقط اگر از یک ساعت قدیمی‌تر باشد حذف می‌شود تا آپلود در جریان آسیب نبیند.
 * - رکورد بدون فایل حذف نمی‌شود (دادهٔ کاربر است)؛ فقط گزارش می‌شود.
 */
export function sweepAttachmentOrphans({ referenced = [], now = Date.now(), minAgeMs = 60 * 60 * 1000 } = {}) {
  let removedFiles = 0;
  let trashed = 0;
  let missingFiles = 0;
  try {
    ensureAttachmentsDir();
  } catch {
    return { removedFiles, trashed, missingFiles, unavailable: true };
  }
  const keep = new Set((referenced || []).map((n) => path.basename(String(n))));
  let names = [];
  try {
    names = fs.readdirSync(ATTACHMENTS_DIR);
  } catch {
    return { removedFiles, trashed, missingFiles, unavailable: true };
  }
  for (const name of names) {
    const full = path.join(ATTACHMENTS_DIR, name);
    let st;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (name.startsWith('.trash-')) {
      if (now - st.mtimeMs >= minAgeMs) {
        try {
          fs.unlinkSync(full);
          trashed += 1;
        } catch {
          /* بی‌اثر */
        }
      }
      continue;
    }
    if (keep.has(name)) continue;
    if (now - st.mtimeMs < minAgeMs) continue;
    try {
      fs.unlinkSync(full);
      removedFiles += 1;
    } catch {
      /* بی‌اثر */
    }
  }
  for (const name of keep) {
    if (!fs.existsSync(path.join(ATTACHMENTS_DIR, path.basename(name)))) missingFiles += 1;
  }
  return { removedFiles, trashed, missingFiles };
}

/** حذف فایل‌های پیوست یک یا چند تجهیز (پس از حذف ردیف‌های DB) */
export function cleanupDeviceAttachmentFiles(rows) {
  let removed = 0;
  for (const row of rows) {
    if (removeAttachmentFile(row.stored_name)) removed += 1;
  }
  return removed;
}

export default {
  ATTACHMENTS_DIR,
  ALLOWED_TYPES,
  HARD_MAX_ATTACHMENT_BYTES,
  attachmentMaxBytes,
  ensureAttachmentsDir,
  detectFileType,
  safeDisplayName,
  writeAttachmentFile,
  attachmentPath,
  removeAttachmentFile,
  stageAttachmentRemoval,
  sweepAttachmentOrphans,
  cleanupDeviceAttachmentFiles,
};
