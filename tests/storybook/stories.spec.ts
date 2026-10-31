/**
 * Критичный набор витрины: истории с меткой `ci` открываются в собранном build/storybook.
 * Набор падает при ошибке play, ошибке выполнения или загрузки ресурса, выходе за ширину рабочей области
 * и любом нарушении доступности из отчёта addon-a11y.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

interface IndexEntry {
  id: string;
  type: 'story' | 'docs';
  title: string;
  name: string;
  importPath: string;
  tags?: string[];
}

interface A11yViolation {
  id: string;
  impact?: string | null;
  help: string;
  nodes: { target: unknown[]; any?: { data?: { fgColor?: string; bgColor?: string; contrastRatio?: number } | null }[] }[];
}

type A11yResult = { violations?: A11yViolation[]; incomplete?: A11yViolation[]; error?: unknown };

interface StoryOutcome {
  status?: string;
  events: string[];
  reporters: { type: string; status: string; result?: A11yResult }[];
}

declare global {
  interface Window {
    __songframeStory?: StoryOutcome & { finished: boolean };
  }
}

/** Метка истории, входящей в обязательный браузерный набор CI. */
const CI_TAG = 'ci';
/** Пауза после завершения истории: ошибка таймера, сработавшего сразу после play, тоже роняет проверку. */
const SETTLE_MS = 500;
/** Адрес, на который витрина подменяет файлы вне набора: 404 по нему — сценарий истории, а не ошибка. */
const MISSING_FILE = '/media/missing-story-file';

const indexPath = resolve(__dirname, '../../build/storybook/index.json');
if (!existsSync(indexPath)) throw new Error('Нет build/storybook/index.json. Сначала выполните yarn build-storybook.');
const entries = Object.values((JSON.parse(readFileSync(indexPath, 'utf8')) as { entries: Record<string, IndexEntry> }).entries);
/** STORYBOOK_TEST_ALL=1 — полный обход всех историй при приёмке общих изменений (палитра, тема, компоновка). */
const all = process.env.STORYBOOK_TEST_ALL === '1';
const stories = entries.filter((entry) => entry.type === 'story' && (all || entry.tags?.includes(CI_TAG)));
if (!stories.length) throw new Error(all ? 'В витрине нет историй.' : `В витрине нет историй с меткой «${CI_TAG}».`);

/** Подписка ставится до загрузки preview: ранние события play не теряются. */
function observeStory(): void {
  // Переход MUI меняет цвет текста сразу, а фон плавно: axe не должен проверять промежуточный кадр.
  document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = '*, *::before, *::after { transition: none !important; }';
    document.head.append(style);
  });
  const outcome: StoryOutcome & { finished: boolean } = { finished: false, events: [], reporters: [] };
  window.__songframeStory = outcome;
  let channel: { on(name: string, listener: (payload: unknown) => void): void } | undefined;
  Object.defineProperty(window, '__STORYBOOK_ADDONS_CHANNEL__', {
    configurable: true,
    get: () => channel,
    set(value: typeof channel) {
      channel = value;
      for (const name of ['playFunctionThrewException', 'unhandledErrorsWhilePlaying', 'storyThrewException', 'storyErrored', 'storyMissing'])
        value?.on(name, (payload) => {
          const error = payload as { message?: string; title?: string } | undefined;
          outcome.events.push(`${name}: ${error?.message ?? error?.title ?? JSON.stringify(payload)}`);
        });
      value?.on('storyFinished', (payload) => {
        const finished = payload as { status?: string; reporters?: StoryOutcome['reporters'] };
        outcome.status = finished.status;
        outcome.reporters = JSON.parse(JSON.stringify(finished.reporters ?? [])) as StoryOutcome['reporters'];
        outcome.finished = true;
      });
    }
  });
}

function describeViolation(violation: A11yViolation): string {
  const targets = violation.nodes.slice(0, 3).map((node) => {
    // Для контраста axe сообщает цвета и коэффициент: по ним исправляется палитра, а не отдельный элемент.
    const data = node.any?.find((check) => check.data?.contrastRatio)?.data;
    return node.target.join(' ') + (data ? ` [${data.fgColor} на ${data.bgColor}: ${data.contrastRatio}]` : '');
  });
  return `${violation.id} (${violation.impact ?? 'без оценки'}): ${violation.help} — ${targets.join('; ')}`;
}

for (const story of stories) {
  test(`${story.title} › ${story.name}`, async ({ page }, info) => {
    const { theme, workspace } = info.project.metadata as { theme: string; workspace: number };
    const problems: string[] = [];
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      // Ошибку загрузки ресурса фиксирует обработчик ответов с точным адресом.
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) problems.push(`console: ${message.text()}`);
    });
    page.on('response', (response) => {
      // Истории утраченного файла намеренно ссылаются на отсутствующий адрес. @link src/renderer/src/testing/storybook.ts
      if (response.status() >= 400 && !new URL(response.url()).pathname.endsWith(MISSING_FILE)) problems.push(`HTTP ${response.status()}: ${response.url()}`);
    });
    page.on('requestfailed', (request) => {
      // Прерванное чтение медиа штатно: плеер отменяет его при перемотке и размонтировании.
      if (request.resourceType() !== 'media' || request.failure()?.errorText !== 'net::ERR_ABORTED')
        problems.push(`запрос не выполнен: ${request.url()} ${request.failure()?.errorText ?? ''}`);
    });
    await page.addInitScript(observeStory);
    await page.goto(`iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story&globals=theme:${theme};workspace:${workspace}`);
    await page.waitForFunction(() => window.__songframeStory?.finished === true, null, { timeout: 75_000 });
    await page.waitForTimeout(SETTLE_MS);
    const outcome = await page.evaluate(() => window.__songframeStory!);
    const overflow = await page.evaluate(() => {
      const area = document.querySelector('[data-testid="story-workspace"]');
      return Math.max(document.documentElement.scrollWidth - window.innerWidth, area ? area.scrollWidth - area.clientWidth : 0);
    });

    expect([...outcome.events, ...problems], 'play и выполнение истории без ошибок').toEqual([]);
    expect(outcome.status, 'статус завершения истории').toBe('success');
    expect(overflow, 'выход за ширину рабочей области или окна, px').toBeLessThanOrEqual(1);
    const a11y = outcome.reporters.find((reporter) => reporter.type === 'a11y');
    expect(a11y, 'отчёт addon-a11y').toBeDefined();
    expect(a11y?.result?.error, 'проверка доступности выполнена').toBeUndefined();
    expect((a11y?.result?.violations ?? []).map(describeViolation), 'нарушения доступности').toEqual([]);
    // Контраст, который axe не смог вычислить (полупрозрачный фон, наложение), остаётся в отчёте для ручного просмотра.
    for (const unsure of a11y?.result?.incomplete ?? [])
      if (unsure.id === 'color-contrast') info.annotations.push({ type: 'a11y: контраст не определён', description: describeViolation(unsure) });
  });
}
