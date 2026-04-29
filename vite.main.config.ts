import { defineConfig } from 'vite';
import path from 'node:path';

const SENTINEL_BANNER = `
try {
  require('node:fs').appendFileSync('/tmp/glint-bundle.log',
    new Date().toISOString() + ' bundle loaded\\n');
  process.on('uncaughtException', function(e) {
    try {
      require('node:fs').appendFileSync('/tmp/glint-bundle.log',
        'UNCAUGHT: ' + (e && e.stack ? e.stack : String(e)) + '\\n');
    } catch (_) {}
  });
} catch (_) {}
`;

export default defineConfig({
  resolve: {
    alias: {
      '@main': path.resolve(__dirname, 'src/main'),
      '@core': path.resolve(__dirname, 'src/core'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    rollupOptions: {
      output: { banner: SENTINEL_BANNER },
      // ONLY externalize what truly cannot be inlined:
      //   - electron        (host-provided)
      //   - better-sqlite3  (native binding)
      //   - tesseract.js    (loads worker-script files at runtime)
      // Pino + jimp are pure JS — let Vite bundle them. Externalizing
      // pino dragged in 8+ transitive deps that weren't shipped, causing
      // a 'Cannot find module pino-std-serializers' on packaged boot.
      external: [
        'electron',
        'better-sqlite3',
        'tesseract.js',
      ],
    },
  },
});
