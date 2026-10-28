/** Повтор готовится локально: выбор агента не блокирует его, а причина несовместимости остаётся видимой. */
import { createElement, type ComponentProps, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobInfo, PackageView, ShotProduction } from '@shared/types';
import { ProductionShotCard } from './ProductionShotCard';
import { RegenerateDialog } from './RegenerateDialog';

// Отсутствующий доступ к AI воспроизводит локальную подготовку без настроенного внешнего агента.
vi.mock('../../../state', () => ({ useApp: () => ({ agentProvider: null, aiAccess: null }) }));
// SSR не открывает портал: сохраняем содержимое и доступность штатного подтверждения.
vi.mock('../../../components/ConfirmationDialog', () => ({
  ConfirmationDialog: ({
    open,
    title,
    children,
    confirmDisabled,
    confirmLabel
  }: {
    open: boolean;
    title: ReactNode;
    children: ReactNode;
    confirmDisabled?: boolean;
    confirmLabel: string;
  }) =>
    open ? createElement('section', null, title, children, createElement('button', { disabled: confirmDisabled, 'data-confirm': true }, confirmLabel)) : null
}));

const unchanged = (): void => {};
const fixturePackage = (provider: string, attemptStatus = 'downloaded'): PackageView => ({
  dir: '/fixture/package',
  relative: 'package',
  shot: 'M44',
  stage: 'downloaded',
  stageLabel: 'Получен результат',
  waitReason: null,
  mode: null,
  retryOf: null,
  batch: null,
  timing: null,
  keyframes: [],
  description: null,
  prompt: null,
  pendingDecision: null,
  decision: null,
  preview: [],
  problems: [],
  request: {
    dir: '/fixture/package/request',
    kind: 'video',
    provider,
    sha256: 'request-sha',
    model: 'saved-model',
    parameters: {},
    inputs: [],
    attemptStatus,
    generationId: 'existing-generation',
    creditsConsumed: 32,
    downloads: ['/fixture/original.mp4']
  }
});
const fixtureShot = (overrides: Partial<ShotProduction> = {}): ShotProduction => ({
  id: 'M44',
  title: 'Принятый план',
  original: 'Описание плана для новой попытки',
  start: 10,
  end: 14,
  lipsync: false,
  state: 'completed',
  stageLabel: 'Готова',
  regenerateProblem: null,
  attention: null,
  asset: { dir: '/fixture/asset', video: '/fixture/edit.mp4', original: '/fixture/original.mp4' },
  packages: [],
  ...overrides
});

const renderCard = (overrides: Partial<ComponentProps<typeof ProductionShotCard>> = {}): string =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(ProductionShotCard, {
        shot: fixtureShot(),
        busy: false,
        pythonAvailable: true,
        onRegenerate: unchanged,
        ...overrides
      })
    )
  );
const renderDialog = (problem: string | null = null, shot: string | null = 'M44'): string =>
  renderToStaticMarkup(createElement(RegenerateDialog, { shot, problem, onClose: unchanged, onConfirm: unchanged }));

function repeatButton(html: string): string {
  // Выбираем именно действие повтора среди кнопок карточки.
  const button = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find((match) => match[0].includes('Подготовить повтор'));
  expect(button, 'Действие подготовки повтора присутствует').toBeDefined();
  return button![0];
}

beforeEach(() => {
  vi.stubGlobal('window', { api: { shell: { fileUrl: (path: string) => `songframe-file://${path}` } } });
});
afterEach(() => vi.unstubAllGlobals());

describe('Локальная подготовка повтора', () => {
  it.each(['kling', 'gptunnel'])('разрешает совместимый запрос %s без aiAccess и agentProvider', (provider) => {
    const html = renderCard({ shot: fixtureShot({ packages: [fixturePackage(provider)] }) });
    expect(repeatButton(html)).not.toMatch(/\bdisabled(?:=|\s|>)/);
    expect(repeatButton(html)).not.toContain('Codex');
    expect(repeatButton(html)).not.toContain('Claude');
    expect(html).toContain('songframe-file:///fixture/edit.mp4');
  });

  it('разрешает повтор принятого комплекта без активного рабочего пакета', () => {
    expect(repeatButton(renderCard())).not.toMatch(/\bdisabled(?:=|\s|>)/);
  });

  it('разрешает локальное подтверждение и объясняет отсутствие отправки и оплаты', () => {
    const html = renderDialog();
    expect(repeatButton(html)).not.toMatch(/\bdisabled(?:=|\s|>)/);
    expect(html).toContain('Запрос не отправляется, кредиты не списываются.');
    expect(html).toContain('отдельного подтверждения');
    expect(html).not.toContain('Сначала выберите агента');
  });

  it('блокирует несовместимый провайдер и показывает причину в карточке и диалоге', () => {
    const problem = 'Провайдер сохранённого запроса Kling отличается от выбранного GPTunnel.';
    const card = renderCard({ shot: fixtureShot({ regenerateProblem: problem }) });
    const dialog = renderDialog(problem);
    for (const html of [card, dialog]) {
      expect(repeatButton(html)).toMatch(/\bdisabled(?:=|\s|>)/);
      expect(html).toContain('role="alert"');
      expect(html).toContain(problem);
    }
  });

  it.each([
    { busy: true, pythonAvailable: true },
    { busy: false, pythonAvailable: false }
  ])('блокирует подготовку при занятости или недоступном Python: %j', (availability) => {
    expect(repeatButton(renderCard(availability))).toMatch(/\bdisabled(?:=|\s|>)/);
  });

  it.each(['submitting', 'submission_unknown'])('не позволяет готовить повтор при незавершённой отправке %s', (status) => {
    const html = renderCard({ shot: fixtureShot({ packages: [fixturePackage('kling', status)] }) });
    expect(repeatButton(html)).toMatch(/\bdisabled(?:=|\s|>)/);
  });

  it('показывает причину failed задания непосредственно у действия и ссылку на журнал', () => {
    const job: JobInfo = {
      id: 'repeat-m44',
      kind: 'regenerate',
      title: 'Подготовка повтора M44',
      status: 'failed',
      startedAt: '2026-10-27T10:00:00Z',
      finishedAt: '2026-10-27T10:00:01Z',
      log: 'Служебные подробности полного журнала',
      code: 3,
      error: 'Сохранённый запрос изменён; нужна новая подготовка.',
      steps: []
    };
    const html = renderCard({ operation: { job } });
    expect(html).toContain('role="alert"');
    expect(html).toContain(job.error);
    expect(html).toContain('href="/jobs"');
    expect(html).toContain('Открыть журнал');
    expect(html).not.toContain(job.log);
    expect(html).not.toContain('role="progressbar"');
    expect(repeatButton(html)).not.toMatch(/\bdisabled(?:=|\s|>)/);
  });

  it('не показывает подтверждение без выбранного плана', () => {
    expect(renderDialog(null, null)).toBe('');
  });
});

describe('Пакет, ждущий решения, у принятой сцены', () => {
  it('показывает вопрос пакета с кнопкой открытия и не повторяет его для уже выбранного пакета', () => {
    const waiting = {
      ...fixturePackage('kling'),
      pendingDecision: { stage: 'downloaded', question: 'Принять результат, повторить или собрать пробу?', options: ['accept', 'retry'] }
    };
    const html = renderCard({ shot: fixtureShot({ packages: [waiting] }), onOpenPackage: unchanged });
    expect(html).toContain('ждёт вашего решения: Принять результат, повторить или собрать пробу?');
    expect(html).toContain('Открыть пакет');
    const selected = renderCard({ shot: fixtureShot({ packages: [waiting] }), onOpenPackage: unchanged, selectedPackage: waiting.dir });
    expect(selected).not.toContain('Открыть пакет');
  });
});
