import React, { Suspense, lazy, useEffect, useRef } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Devices from './pages/Devices';
import DeviceDetail from './pages/DeviceDetail';
import Alerts from './pages/Alerts';
import Maintenance from './pages/Maintenance';
import Reports from './pages/Reports';
import Settings from './pages/Settings';
import { PageLoader } from './components/ui';
import ErrorBoundary from './components/ErrorBoundary';
import { useApp, useLive, useToast } from './lib/store';

// برگهٔ نقشه Leaflet را با خود می‌آورد؛ بارگذاری تنبل آن، حجم بار اولیهٔ برنامه را
// برای کاربرانی که به نقشه سر نمی‌زنند کاهش می‌دهد.
const MapPage = lazy(() => import('./pages/MapPage'));

export default function App() {
  const { settings } = useApp();
  const live = useLive();
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
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/devices" element={<Devices />} />
        <Route path="/devices/:id" element={<DeviceDetail />} />
        <Route
          path="/map"
          element={
            <Suspense fallback={<PageLoader label="در حال بارگذاری نقشه…" />}>
              <MapPage />
            </Suspense>
          }
        />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="/maintenance" element={<Maintenance />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
      </ErrorBoundary>
    </Layout>
  );
}
