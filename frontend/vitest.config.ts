import { configDefaults, defineConfig } from 'vitest/config';
import { aliases } from './vite.config';
/**
 * Чистые тесты renderer, shared и platform выполняются в Node без Wails-окна и Go-сервиса.
 * Браузерный обход витрины (tests/storybook) запускает Playwright на собранной витрине, не Vitest.
 */
export default defineConfig({
  resolve: { alias: aliases },
  test: { include: ['src/**/*.test.ts'], exclude: [...configDefaults.exclude, 'tests/**'], environment: 'node' }
});
