/** Браузерный набор проверяет собранную витрину по HTTP; Node-тесты Vitest сюда не входят. */
import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

const root = resolve(__dirname, '../..');
const ci = !!process.env.CI;
const port = Number(process.env.STORYBOOK_TEST_PORT ?? 6107);
// Подпапка проверяет, что ресурсы и медиа витрины не привязаны к корню сайта.
const basePath = '/songframe/storybook/';
const baseURL = `http://127.0.0.1:${port}${basePath}`;
const report = resolve(root, 'build/storybook-test');

export default defineConfig({
  testDir: __dirname,
  testMatch: 'stories.spec.ts',
  outputDir: resolve(report, 'results'),
  fullyParallel: true,
  forbidOnly: ci,
  // Повтор отделяет нестабильную историю от сломанной в отчёте, но обе роняют job: прохождение «через раз» не принимается.
  retries: ci ? 1 : 0,
  failOnFlakyTests: ci,
  timeout: 90_000,
  reporter: [['list'], ['html', { outputFolder: resolve(report, 'report'), open: 'never' }], ...(ci ? [['github'] as const] : [])],
  use: { baseURL, browserName: 'chromium', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  // Окна 960 и 1320 соответствуют рабочим областям 724 и 1084 px с учётом меню приложения.
  projects: [
    { name: 'светлая 960×640', use: { viewport: { width: 960, height: 640 } }, metadata: { theme: 'light', workspace: 724 } },
    { name: 'тёмная 960×640', use: { viewport: { width: 960, height: 640 } }, metadata: { theme: 'dark', workspace: 724 } },
    { name: 'светлая 1320×860', use: { viewport: { width: 1320, height: 860 } }, metadata: { theme: 'light', workspace: 1084 } },
    { name: 'тёмная 1320×860', use: { viewport: { width: 1320, height: 860 } }, metadata: { theme: 'dark', workspace: 1084 } }
  ],
  webServer: {
    command: `node scripts/storybook/serve-static.mjs --port ${port} --base ${basePath}`,
    cwd: root,
    url: `${baseURL}index.json`,
    // Чужой сервер на порту (другая сборка или checkout) дал бы ложный результат; занятый порт задаётся STORYBOOK_TEST_PORT.
    reuseExistingServer: false
  }
});
