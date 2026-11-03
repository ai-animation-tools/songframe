import { defineConfig } from '@playwright/test';
/** Проверяются собранные истории; HMR/dev-сервер не используется как доказательство приёмки. */
export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:6106', headless: true, viewport: { width: 1320, height: 860 } },
  webServer: {
    command: 'yarn exec vite preview --outDir storybook-static --host 127.0.0.1 --port 6106 --strictPort',
    url: 'http://127.0.0.1:6106',
    reuseExistingServer: false
  },
  reporter: 'list'
});
