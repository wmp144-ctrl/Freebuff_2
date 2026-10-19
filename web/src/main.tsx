import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource/vazirmatn/300.css';
import '@fontsource/vazirmatn/400.css';
import '@fontsource/vazirmatn/500.css';
import '@fontsource/vazirmatn/600.css';
import '@fontsource/vazirmatn/700.css';
import 'leaflet/dist/leaflet.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import './index.css';
import App from './App';
import { AppProvider, LiveProvider, ToastProvider } from './lib/store';
import { LivePingProvider } from './components/LivePing';
import { AuthProvider } from './lib/auth';
import { AuthGate } from './pages/Login';
import ErrorBoundary from './components/ErrorBoundary';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <AuthGate>
            <AppProvider>
              <LiveProvider>
                <LivePingProvider>
                  <ErrorBoundary label="برنامه">
                    <App />
                  </ErrorBoundary>
                </LivePingProvider>
              </LiveProvider>
            </AppProvider>
          </AuthGate>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>
);
