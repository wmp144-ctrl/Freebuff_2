import React, { Suspense, lazy, useEffect, useRef } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Layout from './components/Layout';
import { PageLoader } from './components/ui';
import ErrorBoundary from './components/ErrorBoundary';
import { useApp, useLiveState, useToast } from './lib/store';
import { setFormatCalendar } from './lib/format';

// هر صفحه در بستهٔ خودش بارگذاری می‌شود: نمودارها (recharts) فقط با داشبورد/
// گزارش‌ها، نقشه (Leaflet/MapLibre) فقط با نقشه، و صفحهٔ سلامت فقط با مراجعه به
// آن دانلود می‌شوند. این کار حجم بار اولیه و زمان تعاملی را کاهش می‌دهد.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Devices = lazy(() => import('./pages/Devices'));
const DeviceDetail = lazy(() => import('./pages/DeviceDetail'));
const MapPage = lazy(() => import('./pages/MapPage'));
const Diagrams = lazy(() => import('./pages/Diagrams'));
const Alerts = lazy(() => import('./pages/Alerts'));
const Maintenance = lazy(() => import('./pages/Maintenance'));
const Reports = lazy(() => import('./pages/Reports'));
const Templates = lazy(() => import('./pages/Templates'));
const Conflicts = lazy(() => import('./pages/Conflicts'));
const Settings = lazy(() => import('./pages/Settings'));
const AppHealth = lazy(() => import('./pages/AppHealth'));

export default function App() {
  const { settings } = useApp();
  // تقویم نمایشی از تنظیمات خوانده می‌شود؛ مقدار ذخیره‌شده در DB همیشه
  // میلادی/epoch است و این تنظیم فقط لایهٔ نمایش را تغییر می‌دهد.
  setFormatCalendar(settings?.calendar);
  const live = useLiveState();
  const { push } = useToast();
  const location = useLocation();
  const seen = useRef(new Set<number>());

  useEffect(() => {
    const fresh = live.alerts.filter((a) => !seen.current.has(a.id));
    if (!fresh.length) return;
    fresh.forEach((a) => seen.current.add(a.id));
    if (!settings?.notify_browser) return;
    for (const a of fresh.slice(0, 3)) {
      push(a.title, a.severity === 'critical' ? 'error' : a.severity === 'warning' ? 'warning' : 'info');
    }
  }, [live.alerts, settings?.notify_browser, push]);

  return (
    <Layout>
      {/* هر صفحه مرز خطای مستقل دارد؛ خطای یک صفحه کل برنامه را سفید نمی‌کند */}
      <ErrorBoundary key={location.pathname} label="این صفحه">
        <Suspense fallback={<PageLoader label="در حال بارگذاری صفحه…" />}>
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/devices" element={<Devices />} />
            <Route path="/devices/:id" element={<DeviceDetail />} />
            <Route path="/map" element={<MapPage />} />
            <Route path="/diagrams" element={<Diagrams />} />
            <Route path="/diagrams/:id" element={<Diagrams />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/maintenance" element={<Maintenance />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/templates" element={<Templates />} />
            <Route path="/conflicts" element={<Conflicts />} />
            {/* مسیر SPA عمداً `/app-health` است: `/health` و `/api/health` نقطه‌های
                پایانی JSON پایش هستند و بارگذاری مستقیم آن‌ها نباید صفحهٔ HTML بدهد. */}
            <Route path="/app-health" element={<AppHealth />} />
            <Route path="/health" element={<Navigate to="/app-health" replace />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </Layout>
  );
}
