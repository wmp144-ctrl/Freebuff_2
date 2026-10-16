import React, { useEffect, useRef } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Devices from './pages/Devices';
import DeviceDetail from './pages/DeviceDetail';
import MapPage from './pages/MapPage';
import Alerts from './pages/Alerts';
import Maintenance from './pages/Maintenance';
import Reports from './pages/Reports';
import Settings from './pages/Settings';
import { useApp, useLive, useToast } from './lib/store';

export default function App() {
  const { settings } = useApp();
  const live = useLive();
  const { push } = useToast();
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
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/devices" element={<Devices />} />
        <Route path="/devices/:id" element={<DeviceDetail />} />
        <Route path="/map" element={<MapPage />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="/maintenance" element={<Maintenance />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Layout>
  );
}
