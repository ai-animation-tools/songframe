/** Браузерный набор проверяет собранную витрину по HTTP; Node-тесты Vitest сюда не входят. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

const root = resolve(__dirname, '../..');
const ci = !!process.env.CI;
const port = Number(process.env.STORYBOOK_TEST_PORT ?? 6107);
// Подпапка проверяет, что ресурсы и медиа витрины не привязаны к корню сайта.
const basePath = '/songframe/storybook/';
const baseURL = `http://127.0.0.1:${port}${basePath}`;
const report = resolve(root, 'build/storybook-test');

/** Половина квоты CPU контейнера (cgroup v2), как Playwright по умолчанию делит ядра; без квоты — его обычный выбор. */
function containerWorkers(): number | undefined {
  try {
    const [quota, period] = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(' ');
    return quota === 'max' ? undefined : Math.max(1, Math.floor(Number(quota) / Number(period) / 2));
  } catch {
    return undefined;
  }
}

export default defineConfig({
  testDir: __dirname,
  testMatch: 'stories.spec.ts',
  outputDir: resolve(report, 'results'),
  fullyParallel: true,
  // Node видит все ядра хоста, а не квоту контейнера: на раннере с ограничением 36 браузеров делили несколько ядер и падали по таймауту.
  workers: containerWorkers(),
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
