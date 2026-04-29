import { defineConfig } from 'vite';
import path from 'node:path';

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
      // Externalize native + worker-script modules. Vite can't bundle the
      // worker-script files tesseract.js loads at runtime; better-sqlite3 is
      // a native binding; pino/pino-pretty have transport workers; jimp ships
      // platform-specific binaries.
      external: [
        'electron',
        'better-sqlite3',
        'tesseract.js',
        'pino',
        'pino-pretty',
        'jimp',
      ],
    },
  },
});
