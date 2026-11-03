import { test, expect } from '@playwright/test';

interface StoryOutcome {
  finished: boolean;
  status?: string;
  errors: string[];
}
declare global {
  interface Window {
    __shellStoryOutcome?: StoryOutcome;
  }
}

/** Слушатели ставятся до preview, чтобы regression в play не терялся за видимым fallback страницы. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const outcome: StoryOutcome = { finished: false, errors: [] };
    window.__shellStoryOutcome = outcome;
    let channel: { on: (name: string, callback: (payload: unknown) => void) => void } | undefined;
    Object.defineProperty(window, '__STORYBOOK_ADDONS_CHANNEL__', {
      configurable: true,
      get: () => channel,
      set(value: typeof channel) {
        channel = value;
        for (const name of ['playFunctionThrewException', 'unhandledErrorsWhilePlaying', 'storyThrewException', 'storyErrored', 'storyMissing']) {
          value?.on(name, (payload) => outcome.errors.push(`${name}: ${JSON.stringify(payload)}`));
        }
        value?.on('storyFinished', (payload) => {
          outcome.status = (payload as { status?: string }).status;
          outcome.finished = true;
        });
      }
    });
  });
});
test.afterEach(async ({ page }) => {
  await page.waitForFunction(() => window.__shellStoryOutcome?.finished === true);
  const outcome = await page.evaluate(() => window.__shellStoryOutcome);
  expect(outcome?.errors, 'проверки play завершились без ошибок').toEqual([]);
  expect(outcome?.status).toBe('success');
});

const story = (name: string) => `/iframe.html?id=оболочка-songframe--${name}&viewMode=story`;
// Приёмка использует обычное рабочее окно; уменьшенный размер не является обязательной целью миграции.
for (const theme of ['ready', 'dark']) {
  test(`оболочка ${theme}, 1320×860`, async ({ page }) => {
    await page.goto(story(theme));
    await expect(page.getByRole('heading', { name: 'Проекты', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Открыть папку проекта' })).toBeEnabled();
    await expect(page.getByRole('link', { name: 'Тайминги', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await page.getByRole('link', { name: 'Тайминги', exact: true }).focus();
    await expect(page.getByRole('tooltip')).toContainText('Эта функция пока недоступна');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: theme === 'dark' ? 'Светлая тема' : 'Тёмная тема' }).click();
    await expect(page.getByRole('button', { name: theme === 'dark' ? 'Тёмная тема' : 'Светлая тема' })).toBeVisible();
  });
}
test('ошибка старта восстанавливается повтором', async ({ page }) => {
  await page.goto(story('retry'));
  await expect(page.getByRole('heading', { name: 'Проекты', exact: true })).toBeVisible();
  await expect(page.getByText('Не удалось запустить приложение')).toHaveCount(0);
});
test('прямой переход на неперенесённую страницу остаётся понятным', async ({ page }) => {
  await page.goto(story('unavailable'));
  await expect(page.getByRole('heading', { name: 'Проекты', exact: true })).toBeVisible();
});
test('загрузка и сбой рендера не оставляют белое окно', async ({ page }) => {
  await page.goto(story('loading'));
  await expect(page.getByRole('status', { name: 'Подготовка приложения' })).toBeVisible();
  await page.goto(story('render-error'));
  await expect(page.getByText('Не удалось показать страницу')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Показать страницу заново' })).toBeVisible();
});

test('ошибка начального чтения объясняет сбой и оставляет повтор', async ({ page }) => {
  await page.goto(story('startup-error'));
  await expect(page.getByText('Не удалось подготовить локальное состояние приложения.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Попробовать снова' })).toBeVisible();
});

for (const name of ['repeated-mount', 'repeated-mount-dark']) {
  test(`жизненный цикл App и TimingPage: ${name}, 1320×860`, async ({ page }) => {
    await page.goto(story(name));
    // Play проверяет число активных подписок и закрытие preview после настоящих React unmount.
    await page.waitForFunction(() => window.__shellStoryOutcome?.finished === true);
    await expect(page.getByRole('button', { name: 'Смонтировать приложение' })).toBeVisible();
    await expect(page.getByRole('main')).toHaveCount(0);
    await expect(page.getByLabel('Проигрыватель', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Смонтировать приложение' }).click();
    await page.getByRole('button', { name: 'Открыть папку проекта' }).click();
    await expect(page.getByRole('cell', { name: 'Ручная граница' })).toBeVisible();
    await page.getByRole('button', { name: 'Открыть в отдельном окне' }).click();
    await expect(page.getByRole('button', { name: 'Открыть в отдельном окне' })).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Размонтировать приложение' }).click();
    await expect(page.getByRole('main')).toHaveCount(0);
  });
}

for (const name of [
  'read-only-timings',
  'read-only-dark',
  'blocked-project',
  'missing-media',
  'project-read-error',
  'notification-target',
  'stale-project-response',
  'project-loading',
  'waveform-error',
  'long-project-path',
  'changed-media-stops-old-seek',
  'changed-track-version'
]) {
  test(`просмотр проекта: ${name}`, async ({ page }) => {
    await page.goto(story(name));
    await page.waitForFunction(() => window.__shellStoryOutcome?.finished === true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (name === 'read-only-timings' || name === 'read-only-dark') await page.screenshot({ path: `/tmp/songframe-step3-${name}.png`, fullPage: true });
  });
}

for (const name of ['components-context', 'components-dark', 'components-settings', 'components-checking-navigation']) {
  test(`компоненты в оболочке: ${name}`, async ({ page }) => {
    await page.goto(story(name));
    await page.waitForFunction(() => window.__shellStoryOutcome?.finished === true);
    await expect(page.getByRole('heading', { name: 'Компоненты', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
for (const name of [
  'automatic-ready',
  'dark',
  'missing',
  'ready',
  'downloading',
  'verifying',
  'error-recovery',
  'connect-on-computer',
  'connect-archive',
  'connect-bad-then-valid',
  'cancelled-connect',
  'model-waits-for-runtime',
  'component-error',
  'long-path-dark',
  'catalog-recovery',
  'polling-is-read-only'
]) {
  test(`менеджер компонентов: ${name}`, async ({ page }) => {
    await page.goto(`/iframe.html?id=компоненты-менеджер--${name}&viewMode=story`);
    await page.waitForFunction(() => window.__shellStoryOutcome?.finished === true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole('button', { name: /Проверить компоненты|Перепроверить файлы|Обновить/ })).toHaveCount(0);
    if (name === 'automatic-ready' || name === 'dark') {
      for (const title of ['FFmpeg и ffprobe', 'ONNX Runtime']) {
        const logo = page.getByRole('region', { name: title, exact: true }).locator('img');
        await expect.poll(() => logo.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
        const badge = await logo.evaluate((element) => {
          const bounds = element.parentElement!.getBoundingClientRect();
          return { width: bounds.width, height: bounds.height, fit: getComputedStyle(element).objectFit };
        });
        expect(badge).toEqual({ width: 56, height: 56, fit: 'contain' });
      }
      const left = await page.getByRole('region', { name: 'FFmpeg и ffprobe' }).boundingBox();
      const right = await page.getByRole('region', { name: 'ONNX Runtime', exact: true }).boundingBox();
      expect(right!.x).toBeGreaterThan(left!.x);
      expect(right!.y).toBe(left!.y);
      await page.getByRole('heading', { name: 'Компоненты', exact: true }).click();
      await page.screenshot({ path: `/tmp/songframe-41-3-state-${name}.png` });
    }
  });
}
