/**
 * Браузерный обход собранной витрины по HTTP (tests/storybook); Node-тесты Vitest сюда не входят.
 * Проверяется только обязательное окно 1320×860 в светлой и тёмной темах,
 * отчёты пишутся в test-results/ и playwright-report/ рядом с frontend, витрина — storybook-static.
 */
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = dirname(fileURLToPath(import.meta.url));
const ci = !!process.env.CI;
const port = Number(process.env.STORYBOOK_TEST_PORT ?? 6107);
// Подпапка проверяет, что ресурсы и медиа витрины не привязаны к корню сайта.
const basePath = '/songframe/storybook/';
const baseURL = `http://127.0.0.1:${port}${basePath}`;

/**
 * Половина доступных процессов, как Playwright делит ядра по умолчанию, но от доступных, а не от всех:
 * квота CPU контейнера (cgroup v2) или привязка к ядрам (`availableParallelism`), которую ставит
 * check:all через scripts/low-priority.sh. Сам Playwright считает все ядра машины и запустил бы вдвое
 * больше браузеров, чем ядер у прогона.
 */
function workerCount(): number {
  let available = availableParallelism();
  try {
    const [quota, period] = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(' ');
    if (quota !== 'max') available = Math.min(available, Number(quota) / Number(period));
  } catch {
    // Без cgroup v2 квоты нет.
  }
  return Math.max(1, Math.floor(available / 2));
}

export default defineConfig({
  testDir: resolve(root, 'tests/storybook'),
  testMatch: 'stories.spec.ts',
  outputDir: resolve(root, 'test-results'),
  fullyParallel: true,
  workers: workerCount(),
  forbidOnly: ci,
  // Повтор отделяет нестабильную историю от сломанной в отчёте, но обе роняют job: прохождение «через раз» не принимается.
  retries: ci ? 1 : 0,
  failOnFlakyTests: ci,
  timeout: 90_000,
  reporter: [['list'], ['html', { outputFolder: resolve(root, 'playwright-report'), open: 'never' }]],
  // Трасса пишется для каждой истории и сохраняется только при падении: без покадровых скриншотов
  // обход примерно на треть быстрее, а снимки DOM в трассе и скриншот падения остаются.
  use: { baseURL, browserName: 'chromium', screenshot: 'only-on-failure', trace: { mode: 'retain-on-failure', screenshots: false } },
  // Минимальное и стартовое окно приложения 1320×860 даёт рабочую область 1084 px с учётом меню.
  projects: [
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
