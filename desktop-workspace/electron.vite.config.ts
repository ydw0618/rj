import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts'), worker: resolve('src/main/worker.ts') } } },
  },
  preload: { build: { rollupOptions: { input: resolve('src/preload/index.ts') } } },
  renderer: {
    root: 'src/renderer',
    base: './',
    build: {
      reportCompressedSize: false,
      rolldownOptions: {
        // BlockSuite uses constructor names as identifiers in its service registry.
        output: { minify: { mangle: { keepNames: true }, compress: { keepNames: { class: true, function: true } } } },
      },
    },
    plugins: [
      react(),
      {
        name: 'dev-react-refresh-csp',
        apply: 'serve',
        transformIndexHtml(html) {
          return html.replace("script-src 'self' workspace-asset:", "script-src 'self' 'unsafe-inline' workspace-asset:");
        },
      },
    ],
  },
});
