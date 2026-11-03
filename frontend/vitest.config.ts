import { defineConfig } from 'vitest/config';
import { aliases } from './vite.config';
/** Контрактные и чистые тесты не требуют Wails-окна и не запускают сервис приложения. */
export default defineConfig({ resolve: { alias: aliases }, test: { include: ['src/**/*.test.ts'], environment: 'node' } });
