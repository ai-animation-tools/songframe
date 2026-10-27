import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

// Сборка целиком лежит в build/app, чтобы запускать и упаковывать из одного места.
const shared = { '@shared': resolve('src/shared') };

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    build: {
      outDir: 'build/app/main',
      rollupOptions: { input: { index: resolve('src/main/index.ts'), 'environment-worker': resolve('src/main/environment-worker.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    build: { outDir: 'build/app/preload' }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    resolve: { alias: { ...shared, '@renderer': resolve('src/renderer/src') } },
    build: { outDir: 'build/app/renderer', rollupOptions: { input: resolve('src/renderer/index.html') } }
  }
});
