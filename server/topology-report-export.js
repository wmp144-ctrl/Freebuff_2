/**
 * NetWatch — خروجی گزارش توپولوژی به PDF و Excel (مرحلهٔ ۴)
 * ----------------------------------------------------------------
 * Persian PDF نیاز به دو چیز دارد که PDFKit به‌تنهایی انجام نمی‌دهد:
 *   ۱) ترتیب بصری راست‌به‌چپ برای متن ترکیبی فارسی/لاتین/عدد
 *   ۲) فونت فارسی توکار (بدون وابستگی به فونت نصب‌شده روی سرور)
 * این ماژول با bidi-js مرزهای جهت را می‌سازد و هر واژه را جداگانه با فونت
 * Vazirmatn می‌کشد؛ در نتیجه فاصله‌ها، عددها و واژه‌های لاتین جابه‌جا نمی‌شوند.
 *
 * Excel با SheetJS ساخته می‌شود و همهٔ بخش‌های گزارش، از جمله مقادیر عددی
 * واقعی، را در برگه‌های جداگانه دارد. محدودیت صفحه‌بندی PDF یک محدودیت
 * نمایشی است؛ Excel فهرست کامل را دارد و همین موضوع در PDF صریح نوشته می‌شود.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import bidiFactory from 'bidi-js';
import * as XLSX from 'xlsx';
import { LINK_STATUS_LABEL, SATURATION_LABEL, REPORT_SECTIONS } from './topology-report.js';

const bidi = bidiFactory();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_REGULAR = path.join(__dirname, 'assets', 'Vazirmatn-Regular.ttf');
const FONT_BOLD = path.join(__dirname, 'assets', 'Vazirmatn-Bold.ttf');
const MAX_PDF_ROWS = 1200;

const COLORS = {
  ink: '#0f172a',
  muted: '#64748b',
  light: '#f8fafc',
  border: '#e2e8f0',
  brand: '#1d4ed8',
  brandSoft: '#eff6ff',
  emerald: '#047857',
  amber: '#b45309',
  red: '#b91c1c',
  violet: '#6d28d9',
};

function hasFonts() {
  return fs.existsSync(FONT_REGULAR) && fs.existsSync(FONT_BOLD);
}

function faNumber(value, digits = 2) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return new Intl.NumberFormat('fa-IR', { maximumFractionDigits: digits }).format(n);
}

function faDate(ts) {
  if (!ts) return '—';
  try {
    return new Intl.DateTimeFormat('fa-IR', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Tehran',
    }).format(new Date(Number(ts)));
  } catch {
    return '—';
  }
}

function statusColor(value) {
  if (value === 'up' || value === 'online' || value === 'normal') return COLORS.emerald;
  if (value === 'degraded' || value === 'warning' || value === 'high' || value === 'medium') return COLORS.amber;
  if (value === 'down' || value === 'offline' || value === 'critical') return COLORS.red;
  if (value === 'failover') return COLORS.violet;
  return COLORS.muted;
}

/**
 * تقسیم متن به بازه‌های هم‌جهت و ساخت ترتیب بصری چپ‌به‌راست.
 * برای هر بازهٔ RTL واژه‌ها معکوس می‌شوند تا با کشیدن چپ‌به‌راست، خواندن
 * راست‌به‌چپ درست باشد؛ بازهٔ LTR (عدد/نام لاتین) دست‌نخورده می‌ماند.
 */
function layoutItems(doc, text, { font = 'regular', size = 10 } = {}) {
  const raw = String(text ?? '');
  if (!raw) return { items: [], width: 0, gap: 0 };
  doc.font(font === 'bold' ? 'vazirBold' : 'vazir').fontSize(size);
  const levels = bidi.getEmbeddingLevels(raw, 'rtl');
  const runs = [];
  if (!levels.levels.length) return { items: [], width: 0, gap: 0 };
  let start = 0;
  let parity = levels.levels[0] & 1;
  for (let i = 1; i <= raw.length; i += 1) {
    const next = i < raw.length ? levels.levels[i] & 1 : -1;
    if (next !== parity) {
      runs.push({ text: raw.slice(start, i), rtl: parity === 1 });
      start = i;
      parity = next;
    }
  }
  const items = [];
  for (const run of runs) {
    if (!run.text) continue;
    if (run.rtl) {
      const words = run.text.trim().split(/\s+/).filter(Boolean);
      for (let i = words.length - 1; i >= 0; i -= 1) {
        items.push({ text: words[i], width: doc.widthOfString(words[i]) });
      }
    } else {
      const clean = run.text.replace(/\s+/g, ' ').trim();
      if (clean) items.push({ text: clean, width: doc.widthOfString(clean) });
    }
  }
  const gap = size * 0.27;
  const width = items.reduce((sum, item) => sum + item.width, 0) + gap * Math.max(0, items.length - 1);
  return { items, width, gap };
}

function fitText(doc, text, maxWidth, opts) {
  const raw = String(text ?? '');
  if (!raw) return '';
  if (layoutItems(doc, raw, opts).width <= maxWidth) return raw;
  let low = 0;
  let high = raw.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${raw.slice(0, mid).trimEnd()}…`;
    if (layoutItems(doc, candidate, opts).width <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return `${raw.slice(0, Math.max(1, low)).trimEnd()}…`;
}

function drawLine(doc, text, { right, y, size = 10, font = 'regular', color = COLORS.ink, maxWidth = null } = {}) {
  const opts = { size, font };
  const raw = maxWidth != null ? fitText(doc, text, maxWidth, opts) : String(text ?? '');
  const layout = layoutItems(doc, raw, opts);
  if (!layout.items.length) return 0;
  doc.font(font === 'bold' ? 'vazirBold' : 'vazir').fontSize(size).fillColor(color);
  let x = right - layout.width;
  for (const item of layout.items) {
    doc.text(item.text, x, y, { lineBreak: false });
    x += item.width + layout.gap;
  }
  return layout.width;
}

function drawSectionTitle(doc, page, title, hint = '') {
  const { left, right } = page;
  const y = page.y;
  doc.save();
  doc.fillColor(COLORS.brand).rect(right + 5, y, 3, 18).fill();
  doc.restore();
  drawLine(doc, title, { right, y, size: 13, font: 'bold' });
  if (hint) drawLine(doc, hint, { right, y: y + 19, size: 8.5, color: COLORS.muted });
  doc.moveTo(left, y + 27).lineTo(right, y + 27).strokeColor(COLORS.border).lineWidth(0.7).stroke();
  page.y = y + (hint ? 38 : 34);
  return page.y;
}

function drawKpi(doc, page, items) {
  const gap = 8;
  const cols = 4;
  const width = (page.width - gap * (cols - 1)) / cols;
  const height = 52;
  let x = page.right;
  let y = page.y;
  for (let i = 0; i < items.length; i += 1) {
    if (i > 0 && i % cols === 0) {
      y += height + gap;
      x = page.right;
    }
    const cardX = x - width;
    doc.save();
    doc.roundedRect(cardX, y, width, height, 6).fillAndStroke(COLORS.light, COLORS.border);
    doc.restore();
    drawLine(doc, items[i].label, { right: cardX + width - 8, y: y + 7, size: 8, color: COLORS.muted, maxWidth: width - 16 });
    drawLine(doc, items[i].value, {
      right: cardX + width - 8,
      y: y + 21,
      size: 15,
      font: 'bold',
      color: items[i].color || COLORS.ink,
      maxWidth: width - 16,
    });
    if (items[i].hint) {
      drawLine(doc, items[i].hint, { right: cardX + width - 8, y: y + 40, size: 7.5, color: COLORS.muted, maxWidth: width - 16 });
    }
    x -= width + gap;
  }
  const rows = Math.ceil(items.length / cols);
  page.y = y + rows * height + (rows - 1) * gap + 14;
}

/**
 * جدول با ستون‌های راست‌به‌چپ. ستون اول در سمت راست page قرار می‌گیرد.
 * سرستون در هر صفحهٔ جدید تکرار می‌شود.
 */
function drawTable(doc, page, { title, hint = '', columns, rows, empty = 'داده‌ای ثبت نشده است.' }) {
  const startY = page.y;
  if (title) {
    if (page.y + 140 > page.bottom - 28) addPage(doc, page);
    page.y = drawSectionTitle(doc, page, title, hint);
  }
  if (!rows.length) {
    drawLine(doc, empty, { right: page.right, y: page.y + 2, size: 9, color: COLORS.muted });
    page.y += 22;
    return;
  }
  const totalWidth = columns.reduce((sum, col) => sum + col.width, 0);
  const scale = totalWidth > 0 ? (page.width - 2) / totalWidth : 1;
  let cursor = page.right;
  const placed = columns.map((col) => {
    const width = col.width * scale;
    cursor -= width;
    return { ...col, x: cursor, width };
  });
  const headerHeight = 22;
  const rowHeight = 19;
  const padding = 4;

  const drawHeader = () => {
    doc.save();
    doc.rect(page.left, page.y, page.width - 2, headerHeight).fill('#eef2ff');
    doc.restore();
    for (const col of placed) {
      drawLine(doc, col.label, {
        right: col.x + col.width - padding,
        y: page.y + 6,
        size: 8,
        font: 'bold',
        color: COLORS.ink,
        maxWidth: col.width - padding * 2,
      });
    }
    page.y += headerHeight;
    doc.moveTo(page.left, page.y).lineTo(page.right - 2, page.y).strokeColor(COLORS.border).lineWidth(0.6).stroke();
  };

  drawHeader();
  const limit = Math.min(rows.length, MAX_PDF_ROWS);
  for (let i = 0; i < limit; i += 1) {
    if (page.y + rowHeight > page.bottom - 28) {
      doc.addPage();
      page.pageIndex += 1;
      page.y = 72;
      drawHeader();
    }
    if (i % 2 === 1) {
      doc.save();
      doc.rect(page.left, page.y, page.width - 2, rowHeight).fill('#fbfdff');
      doc.restore();
    }
    const row = rows[i];
    for (const col of placed) {
      const value = typeof col.value === 'function' ? col.value(row) : row[col.key];
      const toneValue = col.statusKey ? row[col.statusKey] : value;
      const color = col.status ? statusColor(toneValue) : COLORS.ink;
      drawLine(doc, value == null || value === '' ? '—' : String(value), {
        right: col.x + col.width - padding,
        y: page.y + 5,
        size: 7.6,
        color,
        maxWidth: col.width - padding * 2,
      });
    }
    page.y += rowHeight;
    doc.moveTo(page.left, page.y).lineTo(page.right - 2, page.y).strokeColor('#f1f5f9').lineWidth(0.4).stroke();
  }
  if (rows.length > limit) {
    drawLine(doc, `نمایش ${faNumber(limit, 0)} ردیف نخست از ${faNumber(rows.length, 0)} ردیف؛ فهرست کامل در خروجی Excel موجود است.`, {
      right: page.right,
      y: page.y + 5,
      size: 7.5,
      color: COLORS.muted,
      maxWidth: page.width,
    });
    page.y += 16;
  }
  page.y += 10;
  return startY;
}

function pageFooter(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const oldBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    drawLine(doc, `NetWatch — گزارش توپولوژی · صفحهٔ ${faNumber(i - range.start + 1, 0)} از ${faNumber(range.count, 0)}`, {
      right: 805,
      y: 570,
      size: 7.5,
      color: COLORS.muted,
      maxWidth: 770,
    });
    doc.page.margins.bottom = oldBottom;
  }
}

function addPage(doc, page) {
  doc.addPage();
  page.pageIndex += 1;
  doc.save();
  doc.rect(0, 0, 842, 3).fill(COLORS.brand);
  doc.restore();
  drawLine(doc, 'NetWatch — گزارش توپولوژی ارتباطات', {
    right: page.right,
    y: 13,
    size: 8,
    color: COLORS.muted,
    maxWidth: page.width,
  });
  page.y = 40;
}

function ensureSpace(doc, page, needed) {
  if (page.y + needed > page.bottom - 28) addPage(doc, page);
}

/**
 * ساخت فایل PDF گزارش.
 * @param {object} report خروجی buildTopologyReport
 * @returns {Promise<Buffer>}
 */
export async function reportToPdf(report) {
  if (!hasFonts()) throw new Error('فونت فارسی گزارش (Vazirmatn) در server/assets موجود نیست.');
  if (!report) throw new Error('گزارش برای خروجی PDF خالی است.');
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margins: { top: 36, right: 36, bottom: 36, left: 36 },
    bufferPages: true,
    info: {
      Title: `NetWatch — ${report.diagram.name}`,
      Author: 'NetWatch',
      Subject: 'گزارش ساختار شبکه و توپولوژی ارتباطات',
      CreationDate: new Date(),
    },
  });
  doc.registerFont('vazir', FONT_REGULAR);
  doc.registerFont('vazirBold', FONT_BOLD);
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
  });

  const page = {
    left: 36,
    right: 805,
    width: 769,
    bottom: 560,
    y: 36,
    pageIndex: 0,
  };

  // سربرگ صفحهٔ اول
  doc.save();
  doc.rect(0, 0, 842, 58).fill(COLORS.ink);
  doc.restore();
  drawLine(doc, 'گزارش ساختار شبکه و توپولوژی ارتباطات', {
    right: 805,
    y: 14,
    size: 16,
    font: 'bold',
    color: '#ffffff',
    maxWidth: 730,
  });
  drawLine(doc, `${report.diagram.name} · ویرایش ${faNumber(report.diagram.revision, 0)} · ${faDate(report.generatedAt)}`, {
    right: 805,
    y: 35,
    size: 8.5,
    color: '#cbd5e1',
    maxWidth: 730,
  });
  page.y = 74;

  drawKpi(doc, page, [
    { label: 'تجهیزات دیاگرام', value: faNumber(report.structure.deviceNodeCount, 0), hint: `${faNumber(report.structure.nodeCount, 0)} گره` },
    { label: 'لینک‌ها', value: faNumber(report.structure.linkCount, 0), hint: `${faNumber(report.structure.connectedComponents, 0)} مؤلفهٔ همبند` },
    { label: 'مسیرهای پشتیبان', value: faNumber(report.pathCounts.backup, 0), hint: `${faNumber(report.pathCounts.withoutBackup, 0)} گروه بدون پشتیبان`, color: report.pathCounts.withoutBackup ? COLORS.amber : COLORS.ink },
    { label: 'لینک‌های قطع', value: faNumber(report.structure.linkStatusCounts.down, 0), hint: `${faNumber(report.structure.linkStatusCounts.degraded, 0)} اختلال`, color: report.structure.linkStatusCounts.down ? COLORS.red : COLORS.ink },
  ]);

  if (report.diagram.description) {
    drawLine(doc, 'توضیح دیاگرام', { right: page.right, y: page.y, size: 8.5, font: 'bold', color: COLORS.muted });
    page.y += 13;
    drawLine(doc, report.diagram.description, { right: page.right, y: page.y, size: 8, color: COLORS.muted, maxWidth: page.width });
    page.y += 18;
  }

  // ساختار
  page.y = drawSectionTitle(doc, page, REPORT_SECTIONS[0].title, 'شمارش‌ها از گره و لینک ذخیره‌شدهٔ همین دیاگرام است.');
  const structureRows = [
    ['تعداد گره‌ها', faNumber(report.structure.nodeCount, 0)],
    ['تجهیزات واقعی', faNumber(report.structure.deviceNodeCount, 0)],
    ['مراکز تجمع روی دیاگرام', faNumber(report.structure.siteNodeCount, 0)],
    ['ابر / WAN', faNumber(report.structure.cloudNodeCount, 0)],
    ['یادداشت‌ها', faNumber(report.structure.noteCount, 0)],
    ['لینک‌ها', faNumber(report.structure.linkCount, 0)],
    ['مؤلفه‌های همبند', faNumber(report.structure.connectedComponents, 0)],
    ['گره‌های بدون اتصال', faNumber(report.structure.isolatedNodeCount, 0)],
    ['میانگین درجه', faNumber(report.structure.averageDegree, 2)],
    ['وضعیت تجهیزات', `آنلاین ${faNumber(report.structure.statusCounts.online, 0)} · آفلاین ${faNumber(report.structure.statusCounts.offline, 0)} · هشدار ${faNumber(report.structure.statusCounts.warning, 0)} · نامشخص ${faNumber(report.structure.statusCounts.unknown, 0)}`],
    ['وضعیت لینک‌ها', `سالم ${faNumber(report.structure.linkStatusCounts.up, 0)} · اختلال ${faNumber(report.structure.linkStatusCounts.degraded, 0)} · قطع ${faNumber(report.structure.linkStatusCounts.down, 0)} · نامشخص ${faNumber(report.structure.linkStatusCounts.unknown, 0)}`],
    ['انواع لینک', report.structure.linkKinds.map((item) => `${item.label} ${faNumber(item.count, 0)}`).join(' · ') || '—'],
  ];
  drawTable(doc, page, {
    columns: [
      { key: 'label', label: 'شاخص', width: 300 },
      { key: 'value', label: 'مقدار', width: 450 },
    ],
    rows: structureRows.map(([label, value]) => ({ label, value })),
  });

  // تجهیزات
  drawTable(doc, page, {
    title: REPORT_SECTIONS[1].title,
    hint: `${faNumber(report.devices.length, 0)} تجهیز متصل به این دیاگرام · ${faNumber(report.sites.length, 0)} مرکز تجمع ثبت‌شده`,
    columns: [
      { key: 'label', label: 'تجهیز', width: 150 },
      { key: 'ip', label: 'آدرس IP', width: 100 },
      { key: 'roleLabel', label: 'نقش', width: 78 },
      { key: 'kind', label: 'نوع', width: 90 },
      { key: 'statusLabel', label: 'وضعیت', width: 70, status: true, statusKey: 'status' },
      { key: 'site', label: 'مرکز / موقعیت', width: 145 },
      { key: 'degree', label: 'اتصال', width: 50 },
      { key: 'group', label: 'گروه', width: 80 },
    ],
    rows: report.devices,
    empty: 'هیچ تجهیز واقعی به این دیاگرام متصل نیست.',
  });

  // مراکز تجمع
  drawTable(doc, page, {
    title: 'مراکز تجمع',
    hint: 'تعداد تجهیزات از عضویت ثبت‌شدهٔ مرکز محاسبه می‌شود.',
    columns: [
      { key: 'name', label: 'نام مرکز', width: 190 },
      { key: 'code', label: 'کد', width: 80 },
      { key: 'deviceCount', label: 'تجهیزات', width: 70 },
      { key: 'onlineCount', label: 'آنلاین', width: 65 },
      { key: 'offlineCount', label: 'آفلاین', width: 65 },
      { key: 'address', label: 'نشانی', width: 290 },
      { key: 'onDiagram', label: 'روی دیاگرام', width: 85, value: (row) => (row.onDiagram ? 'بله' : 'خیر') },
    ],
    rows: report.sites,
    empty: 'مرکز تجمعی ثبت نشده است.',
  });

  // مسیرها
  const pathRows = [];
  for (const group of report.paths) {
    for (const role of ['primary', 'backup']) {
      const route = group[role];
      if (!route) continue;
      pathRows.push({
        group: group.name,
        role: role === 'primary' ? 'اصلی' : 'پشتیبان',
        from: route.from,
        to: route.to,
        hops: route.hops,
        statusLabel: route.statusLabel,
        status: route.status,
        active: route.active ? 'فعال' : route.status === 'unknown' ? 'نامشخص' : 'غیرفعال',
        groupStatus: group.statusLabel,
      });
    }
  }
  drawTable(doc, page, {
    title: REPORT_SECTIONS[2].title,
    hint: `${faNumber(report.pathCounts.groups, 0)} گروه · ${faNumber(report.pathCounts.failover, 0)} پشتیبان فعال · ${faNumber(report.pathCounts.broken, 0)} مسیر شکسته`,
    columns: [
      { key: 'group', label: 'گروه', width: 150 },
      { key: 'role', label: 'نقش', width: 65 },
      { key: 'from', label: 'مبدأ', width: 150 },
      { key: 'to', label: 'مقصد', width: 150 },
      { key: 'hops', label: 'گام', width: 50 },
      { key: 'statusLabel', label: 'وضعیت', width: 75, status: true, statusKey: 'status' },
      { key: 'active', label: 'وضعیت جاری', width: 90 },
    ],
    rows: pathRows,
    empty: 'مسیر اصلی یا پشتیبانی ثبت نشده است.',
  });

  // لینک‌ها
  drawTable(doc, page, {
    title: REPORT_SECTIONS[3].title,
    hint: 'وضعیت و متریک‌ها از Snapshot زندهٔ همین لحظه؛ «نامشخص» یعنی دادهٔ تازه یا منبع سنجش نیست.',
    columns: [
      { key: 'label', label: 'لینک', width: 145 },
      { key: 'from', label: 'مبدأ', width: 115 },
      { key: 'to', label: 'مقصد', width: 115 },
      { key: 'kindLabel', label: 'نوع', width: 55 },
      { key: 'statusLabel', label: 'وضعیت', width: 65, status: true, statusKey: 'status' },
      { key: 'latencyMs', label: 'تأخیر ms', width: 65 },
      { key: 'lossPct', label: 'افت ٪', width: 50 },
      { key: 'reason', label: 'دلیل / اختلال', width: 160 },
    ],
    rows: report.links,
    empty: 'لینکی ثبت نشده است.',
  });

  // ظرفیت
  drawKpi(doc, page, [
    { label: 'ظرفیت اندازه‌گیری‌شده', value: report.capacity.totalCapacityMbps == null ? '—' : `${faNumber(report.capacity.totalCapacityMbps, 1)} Mbps`, hint: `${faNumber(report.capacity.measuredCount, 0)} لینک` },
    { label: 'میانگین وزنی مصرف', value: report.capacity.weightedUtilPct == null ? '—' : `${faNumber(report.capacity.weightedUtilPct, 1)}٪`, hint: 'بر پایهٔ ظرفیت هر لینک' },
    { label: 'نزدیک اشباع', value: faNumber(report.capacity.saturatedCount, 0), color: report.capacity.saturatedCount ? COLORS.red : COLORS.ink, hint: `${faNumber(report.capacity.highLoadCount, 0)} پرترافیک` },
    { label: 'بدون ظرفیت ثبت‌شده', value: faNumber(report.capacity.noCapacityCount, 0), color: report.capacity.noCapacityCount ? COLORS.amber : COLORS.ink, hint: `${faNumber(report.capacity.unmeasuredCount, 0)} بدون سنجش` },
  ]);
  drawTable(doc, page, {
    title: REPORT_SECTIONS[4].title,
    columns: [
      { key: 'label', label: 'لینک', width: 200 },
      { key: 'capacityMbps', label: 'ظرفیت Mbps', width: 100, value: (row) => (row.capacityMbps == null ? '—' : faNumber(row.capacityMbps, 1)) },
      { key: 'utilPct', label: 'مصرف ٪', width: 80, value: (row) => (row.utilPct == null ? '—' : faNumber(row.utilPct, 1)) },
      { key: 'rxMbps', label: 'دریافت Mbps', width: 95, value: (row) => (row.rxMbps == null ? '—' : faNumber(row.rxMbps, 3)) },
      { key: 'txMbps', label: 'ارسال Mbps', width: 95, value: (row) => (row.txMbps == null ? '—' : faNumber(row.txMbps, 3)) },
      { key: 'saturationLabel', label: 'دستهٔ بار', width: 90 },
      { key: 'telemetryAt', label: 'آخرین سنجش', width: 110, value: (row) => faDate(row.telemetryAt) },
    ],
    rows: report.links,
    empty: 'لینکی برای سنجش ظرفیت وجود ندارد.',
  });

  // ریسک‌ها
  drawTable(doc, page, {
    title: REPORT_SECTIONS[5].title,
    hint: `${faNumber(report.risks.criticalNodeCount, 0)} نقطهٔ بحرانی · ${faNumber(report.risks.riskyLinkCount, 0)} لینک تک‌مسیره · ${faNumber(report.risks.unreachableDeviceCount, 0)} تجهیز دور از مرکز`,
    columns: [
      { key: 'label', label: 'تجهیز / نقطهٔ بحرانی', width: 190 },
      { key: 'roleLabel', label: 'نقش', width: 80 },
      { key: 'ip', label: 'IP', width: 100 },
      { key: 'dependentDeviceCount', label: 'تجهیز وابسته', width: 90 },
      { key: 'dependentSiteCount', label: 'مرکز وابسته', width: 85 },
      { key: 'severityLabel', label: 'شدت', width: 65, status: true, statusKey: 'severity' },
    ],
    rows: report.risks.criticalNodes,
    empty: 'نقطهٔ بحرانی با تجهیز وابسته شناسایی نشد.',
  });
  drawTable(doc, page, {
    title: 'لینک‌های تک‌مسیره (پل)',
    columns: [
      { key: 'label', label: 'لینک', width: 200 },
      { key: 'from', label: 'مبدأ', width: 150 },
      { key: 'to', label: 'مقصد', width: 150 },
      { key: 'dependentDeviceCount', label: 'تجهیز وابسته', width: 90 },
      { key: 'statusLabel', label: 'وضعیت', width: 70, status: true, statusKey: 'status' },
      { key: 'severityLabel', label: 'شدت', width: 60, status: true, statusKey: 'severity' },
    ],
    rows: report.risks.riskyLinks,
    empty: 'لینک تک‌مسیره‌ای شناسایی نشد.',
  });
  drawTable(doc, page, {
    title: 'اختلالات ارتباطی فعال',
    columns: [
      { key: 'typeLabel', label: 'نوع', width: 60 },
      { key: 'label', label: 'مورد', width: 220 },
      { key: 'statusLabel', label: 'وضعیت', width: 80, status: true, statusKey: 'status' },
      { key: 'affectedDeviceCount', label: 'تجهیز متأثر', width: 90 },
      { key: 'reason', label: 'دلیل', width: 300 },
    ],
    rows: report.risks.incidents,
    empty: 'اختلال فعالی گزارش نشده است.',
  });

  if (report.warnings.length) {
    ensureSpace(doc, page, 40);
    page.y = drawSectionTitle(doc, page, 'هشدارها و محدودیت‌های داده');
    for (const warning of report.warnings) {
      ensureSpace(doc, page, 18);
      drawLine(doc, `• ${warning}`, { right: page.right, y: page.y, size: 8.5, color: COLORS.amber, maxWidth: page.width });
      page.y += 15;
    }
    page.y += 6;
  }

  pageFooter(doc);
  doc.end();
  await finished;
  return Buffer.concat(chunks);
}

/* ------------------------------------------------------------------ */
/* Excel                                                              */
/* ------------------------------------------------------------------ */

function sheetFromRows(name, headers, rows) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = headers.map((header, index) => ({
    wch: Math.max(
      12,
      Math.min(40, String(header).length + 8, ...rows.slice(0, 100).map((row) => String(row[index] ?? '').length + 4))
    ),
  }));
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  return { name, ws };
}

export function reportToWorkbook(report) {
  if (!report) throw new Error('گزارش برای خروجی Excel خالی است.');
  const wb = XLSX.utils.book_new();
  const add = (name, headers, rows) => {
    const { ws } = sheetFromRows(name, headers, rows);
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  };

  add(
    'خلاصه',
    ['شاخص', 'مقدار'],
    [
      ['نام دیاگرام', report.diagram.name],
      ['ویرایش', report.diagram.revision],
      ['زمان گزارش', faDate(report.generatedAt)],
      ['تعداد گره', report.structure.nodeCount],
      ['تعداد تجهیز', report.structure.deviceNodeCount],
      ['تعداد مرکز تجمع', report.structure.siteNodeCount],
      ['تعداد لینک', report.structure.linkCount],
      ['مؤلفه‌های همبند', report.structure.connectedComponents],
      ['لینک سالم', report.structure.linkStatusCounts.up],
      ['لینک دچار اختلال', report.structure.linkStatusCounts.degraded],
      ['لینک قطع', report.structure.linkStatusCounts.down],
      ['لینک نامشخص', report.structure.linkStatusCounts.unknown],
      ['گروه مسیر', report.pathCounts.groups],
      ['مسیر پشتیبان', report.pathCounts.backup],
      ['پشتیبان فعال', report.pathCounts.failover],
      ['گروه بدون پشتیبان', report.pathCounts.withoutBackup],
      ['ظرفیت کل اندازه‌گیری‌شده (Mbps)', report.capacity.totalCapacityMbps],
      ['میانگین وزنی مصرف (٪)', report.capacity.weightedUtilPct],
      ['لینک نزدیک اشباع', report.capacity.saturatedCount],
      ['نقاط بحرانی', report.risks.criticalNodeCount],
      ['لینک تک‌مسیره', report.risks.riskyLinkCount],
      ['تجهیز دور از مرکز', report.risks.unreachableDeviceCount],
    ]
  );

  add(
    'ساختار',
    ['شاخص', 'مقدار'],
    [
      ['تعداد گره', report.structure.nodeCount],
      ['تجهیزات واقعی', report.structure.deviceNodeCount],
      ['مراکز تجمع روی دیاگرام', report.structure.siteNodeCount],
      ['ابر / WAN', report.structure.cloudNodeCount],
      ['یادداشت', report.structure.noteCount],
      ['لینک', report.structure.linkCount],
      ['مؤلفهٔ همبند', report.structure.connectedComponents],
      ['گره بدون اتصال', report.structure.isolatedNodeCount],
      ['میانگین درجه', report.structure.averageDegree],
      ['تجهیز آنلاین', report.structure.statusCounts.online],
      ['تجهیز آفلاین', report.structure.statusCounts.offline],
      ['تجهیز هشدار', report.structure.statusCounts.warning],
      ['تجهیز نامشخص', report.structure.statusCounts.unknown],
      ...report.structure.linkKinds.map((item) => [`لینک ${item.label}`, item.count]),
      ...report.structure.roles.map((item) => [`نقش ${item.label}`, item.count]),
    ]
  );

  add(
    'تجهیزات',
    ['نام', 'IP', 'نوع', 'نقش', 'وضعیت', 'دلیل وضعیت', 'گروه', 'مرکز/موقعیت', 'سازنده', 'مدل', 'سریال', 'تعداد اتصال', 'پایش فعال'],
    report.devices.map((row) => [
      row.label,
      row.ip,
      row.kind,
      row.roleLabel,
      row.statusLabel,
      row.statusReason,
      row.group,
      row.site,
      row.vendor,
      row.model,
      row.serial,
      row.degree,
      row.monitoringEnabled ? 'بله' : 'خیر',
    ])
  );

  add(
    'مراکز تجمع',
    ['نام', 'کد', 'تجهیزات', 'آنلاین', 'آفلاین', 'نشانی', 'روی دیاگرام'],
    report.sites.map((row) => [
      row.name,
      row.code,
      row.deviceCount,
      row.onlineCount,
      row.offlineCount,
      row.address,
      row.onDiagram ? 'بله' : 'خیر',
    ])
  );

  const pathRows = [];
  for (const group of report.paths) {
    for (const role of ['primary', 'backup']) {
      const route = group[role];
      if (!route) continue;
      pathRows.push([
        group.name,
        role === 'primary' ? 'اصلی' : 'پشتیبان',
        route.from,
        route.to,
        route.hops,
        route.statusLabel,
        route.active ? 'فعال' : 'غیرفعال',
        route.broken ? 'بله' : 'خیر',
        group.statusLabel,
      ]);
    }
  }
  add(
    'مسیرها',
    ['گروه', 'نقش', 'مبدأ', 'مقصد', 'تعداد گام', 'وضعیت مسیر', 'وضعیت جاری', 'شکسته', 'وضعیت گروه'],
    pathRows
  );

  add(
    'لینک‌ها',
    ['لینک', 'مبدأ', 'مقصد', 'نوع', 'وضعیت', 'دلیل', 'تأخیر ms', 'افت ٪', 'نوسان ms', 'منبع سنجش', 'آخرین سنجش'],
    report.links.map((row) => [
      row.label,
      row.from,
      row.to,
      row.kindLabel,
      row.statusLabel,
      row.reason,
      row.latencyMs ?? '',
      row.lossPct ?? '',
      row.jitterMs ?? '',
      row.monitored ? 'دارد' : 'ندارد',
      row.telemetryAt ? faDate(row.telemetryAt) : '',
    ])
  );

  add(
    'ظرفیت و مصرف',
    ['لینک', 'ظرفیت Mbps', 'مصرف ٪', 'دریافت Mbps', 'ارسال Mbps', 'دستهٔ بار', 'وضعیت سنجش'],
    report.links.map((row) => [
      row.label,
      row.capacityMbps ?? '',
      row.utilPct ?? '',
      row.rxMbps ?? '',
      row.txMbps ?? '',
      row.saturationLabel,
      row.telemetryAt ? (row.telemetryStale ? 'کهنه' : 'تازه') : 'بدون سنجش',
    ])
  );

  add(
    'نقاط بحرانی',
    ['نوع', 'نام', 'نقش', 'IP/مبدأ', 'وضعیت', 'تجهیز وابسته', 'مرکز وابسته', 'شدت', 'دلیل'],
    [
      ...report.risks.criticalNodes.map((row) => [
        'نقطهٔ بحرانی',
        row.label,
        row.roleLabel,
        row.ip,
        row.status,
        row.dependentDeviceCount,
        row.dependentSiteCount,
        row.severityLabel,
        '',
      ]),
      ...report.risks.riskyLinks.map((row) => [
        'لینک تک‌مسیره',
        row.label,
        '',
        `${row.from} ↔ ${row.to}`,
        row.statusLabel,
        row.dependentDeviceCount,
        row.dependentSiteCount,
        row.severityLabel,
        '',
      ]),
      ...report.risks.incidents.map((row) => [
        row.typeLabel,
        row.label,
        '',
        (row.endpoints || []).join(' / '),
        row.statusLabel,
        row.affectedDeviceCount,
        '',
        '',
        row.reason,
      ]),
    ]
  );

  if (report.warnings.length) {
    add('هشدارها', ['هشدار'], report.warnings.map((warning) => [warning]));
  }

  wb.Workbook = { Views: [{ RTL: true }] };
  wb.Props = {
    Title: `NetWatch — ${report.diagram.name}`,
    Subject: 'گزارش ساختار شبکه و توپولوژی ارتباطات',
    Author: 'NetWatch',
    CreatedDate: new Date(report.generatedAt),
  };
  return wb;
}

export function reportToXlsx(report) {
  const wb = reportToWorkbook(report);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}

export { LINK_STATUS_LABEL, SATURATION_LABEL };
