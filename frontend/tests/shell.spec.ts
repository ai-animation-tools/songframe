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
    await expect(page.getByRole('button', { name: 'Открыть папку проекта' })).toBeDisabled();
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
