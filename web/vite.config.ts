import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

const extraHosts = (process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS || '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

export default defineConfig({
  root: rootDir,
  // Tailwind 4 از طریق پلاگین اختصاصی Vite اجرا می‌شود؛ postcss و autoprefixer لازم نیستند.
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(rootDir, 'src') },
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
    // Vite 8 با Rolldown کار می‌کند و شکل شیءگونهٔ manualChunks را نمی‌پذیرد؛
    // groups معادل همان تفکیک است: کتابخانه‌های کم‌تغییر جدا می‌مانند تا با هر
    // به‌روزرسانی برنامه، مرورگر لازم نباشد آن‌ها را دوباره دریافت کند.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react',
              test: /node_modules[\\/](react|react-dom|react-router|react-router-dom)[\\/]/,
              priority: 20,
            },
            { name: 'charts', test: /node_modules[\\/](recharts|victory-vendor)[\\/]/, priority: 15 },
            { name: 'leaflet', test: /node_modules[\\/]leaflet[\\/]/, priority: 15 },
            // کتابخانهٔ نقشهٔ برداری فقط وقتی لایهٔ وکتور استفاده شود بارگذاری می‌شود
            {
              name: 'maplibre',
              test: /node_modules[\\/](maplibre-gl|@maplibre)[\\/]/,
              priority: 20,
            },
          ],
        },
      },
    },
  },
});
