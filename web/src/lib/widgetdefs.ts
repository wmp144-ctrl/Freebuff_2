import type { WidgetDef } from '../components/widgets';

/** بخش‌های صفحه جزئیات تجهیز که قابل جابه‌جایی/حذف/تغییر اندازه هستند */
export const DETAIL_WIDGETS: WidgetDef[] = [
  { id: 'general', title: 'اطلاعات عمومی', defaultSize: 'sm', defaultHeight: 'md', description: 'مشخصات پایه تجهیز' },
  { id: 'monitoring', title: 'اطلاعات مانیتورینگ', defaultSize: 'lg', defaultHeight: 'lg', description: 'متریک‌های پایش و آستانه‌ها' },
  { id: 'charts', title: 'نمودارهای تاریخی', defaultSize: 'full', defaultHeight: 'xl', description: 'تأخیر، افت بسته، وضعیت و دسترس‌پذیری' },
  { id: 'daily', title: 'روند دسترس‌پذیری روزانه', defaultSize: 'full', defaultHeight: 'md', description: '۱۴ روز گذشته' },
  { id: 'outages', title: 'تاریخچه اختلالات و قطعی‌ها', defaultSize: 'full', defaultHeight: 'lg' },
  { id: 'maintenance', title: 'سوابق تعمیرات و نگهداری', defaultSize: 'full', defaultHeight: 'md', description: 'فقط سوابق ثبت‌شده توسط کاربر' },
];

/**
 * ویجت‌های داشبورد
 *
 * همهٔ ویجت‌ها یک ارتفاع پیش‌فرض یکسان دارند تا شبکهٔ داشبورد یکدست بماند؛
 * ارتفاع هر ویجت را می‌توان جداگانه از حالت «چیدمان» تغییر داد.
 */
export const DASHBOARD_WIDGETS: WidgetDef[] = [
  { id: 'kpis', title: 'شاخص‌های کلیدی (KPI)', defaultSize: 'full', defaultHeight: 'md', description: 'کارت‌های آماری بالای صفحه' },
  { id: 'health', title: 'شاخص سلامت شبکه', defaultSize: 'md', defaultHeight: 'md' },
  { id: 'distribution', title: 'وضعیت لحظه‌ای تجهیزات', defaultSize: 'md', defaultHeight: 'md' },
  { id: 'degraded', title: 'تجهیزات دارای افت کیفیت', defaultSize: 'md', defaultHeight: 'md' },
  { id: 'offline-trend', title: 'تغییرات تجهیزات قطع‌شده', defaultSize: 'lg', defaultHeight: 'md' },
  { id: 'outages-per-day', title: 'تعداد قطعی‌ها به تفکیک روز', defaultSize: 'sm', defaultHeight: 'md' },
  { id: 'health-trend', title: 'روند شاخص سلامت و دسترس‌پذیری', defaultSize: 'md', defaultHeight: 'md' },
  { id: 'group-status', title: 'وضعیت گروه‌های تجهیزات', defaultSize: 'md', defaultHeight: 'md' },
  { id: 'top-latency', title: 'بیشترین تأخیر', defaultSize: 'md', defaultHeight: 'md' },
  { id: 'top-downtime', title: 'بیشترین قطعی', defaultSize: 'md', defaultHeight: 'md' },
  { id: 'recent-alerts', title: 'آخرین هشدارها', defaultSize: 'lg', defaultHeight: 'md' },
  { id: 'avg-rtt', title: 'میانگین تأخیر شبکه', defaultSize: 'sm', defaultHeight: 'md' },
  { id: 'quick-links', title: 'نکات کاربردی', defaultSize: 'full', defaultHeight: 'md' },
];
