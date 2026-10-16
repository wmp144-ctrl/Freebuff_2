import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const extraHosts = (process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS || '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    allowedHosts: [...new Set(['localhost', '127.0.0.1', ...extraHosts])],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1400,
    rollupOptions: {
      output: {
        // تفکیک کتابخانه‌های کم‌تغییر به بسته‌های جدا: با هر به‌روزرسانی برنامه،
        // مرورگر لازم نیست آن‌ها را دوباره دریافت کند.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
          leaflet: ['leaflet'],
          // کتابخانهٔ نقشهٔ برداری فقط وقتی لایهٔ وکتور استفاده شود بارگذاری می‌شود
          maplibre: ['maplibre-gl', '@maplibre/maplibre-gl-leaflet'],
        },
      },
    },
  },
});
