/**
 * خروجی گرفتن از بوم دیاگرام — تصویر PNG و PDF تک‌صفحه‌ای.
 *
 * تصویر با html-to-image از خود نمای بوم گرفته می‌شود تا دقیقاً همان چیزی
 * که کاربر می‌بیند (گروه‌ها، تجهیزات، شکل‌ها و خطوط ارتباط) در خروجی باشد.
 * PDF به‌صورت مستقل و بدون وابستگی اضافه ساخته می‌شود: تصویر JPEG در یک
 * صفحهٔ A4 (افقی/عمودی بر اساس نسبت بوم) جا می‌گیرد و متن فارسی هم چون
 * بخشی از تصویر است، نیازی به جاسازی فونت ندارد.
 *
 * «کادر عنوان» یک برگهٔ خروجی می‌سازد: تصویر بوم به‌همراه نواری از فراداده
 * (نام دیاگرام، تاریخ، نسخه، نویسنده و شمار تجزها) که برای چاپ و بایگانی
 * لازم است. متن نوار در DOM ساخته می‌شود تا شکل‌دهی فارسی/راست‌به‌چپ درست
 * باشد؛ رسم مستقیم روی Canvas چنین شکل‌دهی ندارد.
 */
import { toPng } from 'html-to-image';
import { faDigits, fmtDateTime, fmtTimezone } from './format';

/** نام فایل امن برای دانلود؛ نام فارسی حفظ می‌شود. */
export function safeFileName(name: string, extension: string): string {
  const base = String(name ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
  return `${base || 'diagram'}.${extension}`;
}

export function downloadDataUrl(dataUrl: string, fileName: string): void {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  try {
    downloadDataUrl(url, fileName);
  } finally {
    // مرورگر پس از شروع دانلود به آدرس نیاز ندارد؛ آزادسازی حافظه بعد از یک تیک.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('تبدیل تصویر دیاگرام ناموفق بود.'));
    image.src = src;
  });
}

/** PNG دریافتی از بوم را به JPEG با پس‌زمینهٔ سفید تبدیل می‌کند (سبک‌تر برای PDF). */
async function toJpeg(dataUrl: string): Promise<{ dataUrl: string; width: number; height: number; base64: string }> {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('ساخت تصویر خروجی در این مرورگر ممکن نیست.');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);
  const jpeg = canvas.toDataURL('image/jpeg', 0.92);
  return {
    dataUrl: jpeg,
    width: canvas.width,
    height: canvas.height,
    base64: jpeg.slice(jpeg.indexOf(',') + 1),
  };
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * ساخت PDF تک‌صفحه‌ای با یک تصویر JPEG (فیلتر DCTDecode).
 * اشیای PDF: Catalog، Pages، Page، XObject تصویر و جریان محتوا.
 */
async function buildPdf(dataUrl: string): Promise<Blob> {
  const jpeg = await toJpeg(dataUrl);
  const image = base64ToBytes(jpeg.base64);

  const landscape = jpeg.width >= jpeg.height;
  const pageWidth = landscape ? 842 : 595; // A4 در واحد point
  const pageHeight = landscape ? 595 : 842;
  const margin = 24;
  const scale = Math.min((pageWidth - margin * 2) / jpeg.width, (pageHeight - margin * 2) / jpeg.height);
  const drawWidth = jpeg.width * scale;
  const drawHeight = jpeg.height * scale;
  const offsetX = (pageWidth - drawWidth) / 2;
  const offsetY = (pageHeight - drawHeight) / 2;

  const content = [
    'q',
    `${drawWidth.toFixed(2)} 0 0 ${drawHeight.toFixed(2)} ${offsetX.toFixed(2)} ${offsetY.toFixed(2)} cm`,
    '/Im0 Do',
    'Q',
    '',
  ].join('\n');
  const contentBytes = new TextEncoder().encode(content);

  const chunks: Uint8Array[] = [];
  let size = 0;
  const push = (bytes: Uint8Array) => {
    chunks.push(bytes);
    size += bytes.length;
  };
  const write = (text: string) => push(new TextEncoder().encode(text));
  const offsets: number[] = [];
  const object = (number: number, body: string) => {
    offsets[number] = size;
    write(`${number} 0 obj\n${body}\nendobj\n`);
  };

  write('%PDF-1.4\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`
  );

  // شیء تصویر: سرآیند و انتهای آن متن است، دادهٔ JPEG باینری در میانه می‌آید.
  offsets[4] = size;
  write(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${jpeg.width} /Height ${jpeg.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`
  );
  push(image);
  write('\nendstream\nendobj\n');

  offsets[5] = size;
  write(`5 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
  push(contentBytes);
  write('endstream\nendobj\n');

  const xrefStart = size;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i += 1) xref += `${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  write(xref);

  const merged = new Uint8Array(size);
  let cursor = 0;
  for (const chunk of chunks) {
    merged.set(chunk, cursor);
    cursor += chunk.length;
  }
  return new Blob([merged], { type: 'application/pdf' });
}

/* ------------------------------------------------------------------ */
/* کادر عنوان و متادیتا (برگهٔ خروجی)                                 */
/* ------------------------------------------------------------------ */

export interface ExportMeta {
  name: string;
  description?: string;
  revision: number;
  updatedAt: number;
  createdBy?: string;
  nodeCount: number;
  edgeCount: number;
  siteName?: string;
  timezoneOffset?: number;
}

function textElement(tag: 'p' | 'span' | 'div', text: string, style: string): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = text;
  el.style.cssText = style;
  return el;
}

/**
 * ترکیب تصویر بوم با نوار عنوان در یک تصویر واحد.
 *
 * عرض برگه همان عرض بوم است تا نسبت نقشه حفظ شود؛ نوار پایین با خط جداکننده
 * و نشان رنگی برند همراه است.
 */
export async function composeExportSheet(
  pngDataUrl: string,
  meta: ExportMeta,
  options: { timezoneOffset?: number } = {}
): Promise<string> {
  const image = await loadImage(pngDataUrl);
  const width = Math.max(360, image.naturalWidth || image.width);
  const offset = options.timezoneOffset ?? meta.timezoneOffset ?? 210;

  const sheet = document.createElement('div');
  sheet.setAttribute('aria-hidden', 'true');
  sheet.style.cssText = [
    'position:fixed',
    'left:-200000px',
    'top:0',
    `width:${width}px`,
    'background:#ffffff',
    'direction:rtl',
    'font-family:Vazirmatn,Tahoma,sans-serif',
  ].join(';');

  const img = document.createElement('img');
  img.src = pngDataUrl;
  img.alt = '';
  img.style.cssText = 'display:block;width:100%;height:auto;';
  sheet.appendChild(img);

  const footer = document.createElement('div');
  footer.style.cssText = [
    'display:flex',
    'align-items:flex-end',
    'justify-content:space-between',
    'gap:16px',
    'padding:12px 18px 14px',
    'border-top:2px solid #2563eb',
    'background:#f8fafc',
  ].join(';');

  const start = document.createElement('div');
  start.style.cssText = 'min-width:0;flex:1;text-align:right;';
  start.appendChild(
    textElement('p', meta.siteName || 'NetWatch', 'margin:0;font-size:12px;font-weight:600;color:#2563eb;letter-spacing:.02em;')
  );
  start.appendChild(
    textElement('p', meta.name, 'margin:3px 0 0;font-size:18px;font-weight:700;color:#1e293b;line-height:1.4;')
  );
  if (meta.description) {
    start.appendChild(
      textElement(
        'p',
        meta.description.length > 160 ? `${meta.description.slice(0, 157)}…` : meta.description,
        'margin:3px 0 0;font-size:11.5px;color:#64748b;line-height:1.6;max-height:2.2em;overflow:hidden;'
      )
    );
  }

  const end = document.createElement('div');
  end.style.cssText = 'flex:0 0 auto;text-align:left;font-size:11.5px;color:#475569;line-height:1.75;';
  end.appendChild(
    textElement('p', `تاریخ خروجی: ${fmtDateTime(Date.now(), offset)}`, 'margin:0;')
  );
  end.appendChild(
    textElement(
      'p',
      `نسخه: ${faDigits(meta.revision)} · ${faDigits(meta.nodeCount)} جزء · ${faDigits(meta.edgeCount)} ارتباط`,
      'margin:0;'
    )
  );
  if (meta.createdBy) {
    end.appendChild(textElement('p', `سازنده: ${meta.createdBy}`, 'margin:0;'));
  }
  end.appendChild(
    textElement('p', `آخرین ذخیره: ${fmtDateTime(meta.updatedAt, offset)} · ${fmtTimezone(offset)}`, 'margin:0;color:#94a3b8;')
  );

  footer.append(start, end);
  sheet.appendChild(footer);
  document.body.appendChild(sheet);
  try {
    // یک فریم صبر می‌کنیم تا تصویر و فونت‌ها پیش از عکس‌برداری آماده شوند.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const height = sheet.offsetHeight;
    return await toPng(sheet, {
      pixelRatio: 1,
      width,
      height,
      backgroundColor: '#ffffff',
      // برگه بیرون از دید قرار دارد؛ کلون html-to-image باید بدون جابه‌جایی
      // (position/left) رندر شود وگرنه خروجی خالی می‌شود.
      style: { position: 'static', left: '0', top: '0', margin: '0' },
    });
  } finally {
    sheet.remove();
  }
}

/** دانلود خروجی PDF از تصویر PNG بوم. */
export async function downloadDiagramPdf(pngDataUrl: string, fileName: string): Promise<void> {
  const blob = await buildPdf(pngDataUrl);
  downloadBlob(blob, fileName);
}
