import { resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  // Браузерный набор витрины (tests/storybook) запускает Playwright на собранной витрине, не Vitest.
  test: { include: ['src/**/*.test.ts'], exclude: [...configDefaults.exclude, 'tests/**'], environment: 'node' }
});
