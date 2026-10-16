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

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AppProvider>
          <LiveProvider>
            <LivePingProvider>
              <App />
            </LivePingProvider>
          </LiveProvider>
        </AppProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>
);
