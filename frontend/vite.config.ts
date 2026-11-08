import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Общие пути приложения и витрины; в готовом пакете остаются только статические ресурсы. */
export const aliases = {
  '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
  '@renderer': fileURLToPath(new URL('./src/renderer', import.meta.url)),
  '@platform': fileURLToPath(new URL('./src/platform', import.meta.url))
};
export default defineConfig({ plugins: [react()], resolve: { alias: aliases }, base: './', build: { outDir: 'dist', emptyOutDir: true } });
