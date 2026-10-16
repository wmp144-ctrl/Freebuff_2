import type { WidgetDef } from '../components/widgets';

/** بخش‌های صفحه جزئیات تجهیز که قابل جابه‌جایی/حذف/تغییر اندازه هستند */
export const DETAIL_WIDGETS: WidgetDef[] = [
  { id: 'general', title: 'اطلاعات عمومی', defaultSize: 'sm', description: 'مشخصات پایه تجهیز' },
  { id: 'monitoring', title: 'اطلاعات مانیتورینگ', defaultSize: 'lg', description: 'متریک‌های پایش و آستانه‌ها' },
  { id: 'charts', title: 'نمودارهای تاریخی', defaultSize: 'full', description: 'تأخیر، افت بسته، وضعیت و دسترس‌پذیری' },
  { id: 'daily', title: 'روند دسترس‌پذیری روزانه', defaultSize: 'full', description: '۱۴ روز گذشته' },
  { id: 'outages', title: 'تاریخچه اختلالات و قطعی‌ها', defaultSize: 'full' },
  { id: 'maintenance', title: 'سوابق تعمیرات و نگهداری', defaultSize: 'full', description: 'فقط سوابق ثبت‌شده توسط کاربر' },
];

/** ویجت‌های داشبورد */
export const DASHBOARD_WIDGETS: WidgetDef[] = [
  { id: 'kpis', title: 'شاخص‌های کلیدی (KPI)', defaultSize: 'full', description: 'کارت‌های آماری بالای صفحه' },
  { id: 'health', title: 'شاخص سلامت شبکه', defaultSize: 'md' },
  { id: 'distribution', title: 'وضعیت لحظه‌ای تجهیزات', defaultSize: 'md' },
  { id: 'degraded', title: 'تجهیزات دارای افت کیفیت', defaultSize: 'md' },
  { id: 'offline-trend', title: 'تغییرات تجهیزات قطع‌شده', defaultSize: 'lg' },
  { id: 'outages-per-day', title: 'تعداد قطعی‌ها به تفکیک روز', defaultSize: 'sm' },
  { id: 'health-trend', title: 'روند شاخص سلامت و دسترس‌پذیری', defaultSize: 'md' },
  { id: 'group-status', title: 'وضعیت گروه‌های تجهیزات', defaultSize: 'md' },
  { id: 'top-latency', title: 'بیشترین تأخیر', defaultSize: 'md' },
  { id: 'top-downtime', title: 'بیشترین قطعی', defaultSize: 'md' },
  { id: 'recent-alerts', title: 'آخرین هشدارها', defaultSize: 'lg' },
  { id: 'avg-rtt', title: 'میانگین تأخیر شبکه', defaultSize: 'sm' },
  { id: 'quick-links', title: 'نکات کاربردی', defaultSize: 'full' },
];
