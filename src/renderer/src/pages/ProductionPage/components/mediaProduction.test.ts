/** Контракт представления различает платный image-запрос, выбор опоры и отдельную приёмку видео. */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAccess } from '@shared/ai-access';
import type { PackageView, ProductionQuote } from '@shared/types';
import { ProductionFrameGenerationButton } from './ProductionFrameGenerationButton';
import { PackageRequest } from './PackageRequest';
import { PackageResult } from './PackageResult';
import { PackageResume } from './PackageResume';
import { PackageDecision } from './PackageDecision';
import { SendRequestDialog } from './SendRequestDialog';

// Сохранённый выбор задаётся независимо от поставляемых моделям настроек по умолчанию.
const context = vi.hoisted(() => ({ agentProvider: 'codex', aiAccess: null as AiAccess | null, quote: null as ProductionQuote | null }));
vi.mock('../useRequestQuote', () => ({
  useRequestQuote: () => ({ quote: context.quote, error: null, loading: false, external: false, refreshQuote: () => {}, consumeQuote: () => {} })
}));
// SSR проверяет содержимое и доступность подтверждения без портала Electron-диалога.
vi.mock('../../../components/ConfirmationDialog', () => ({
  ConfirmationDialog: ({
    title,
    children,
    confirmDisabled,
    confirmLabel
  }: {
    title: ReactNode;
    children: ReactNode;
    confirmDisabled: boolean;
    confirmLabel: string;
  }) => createElement('section', null, title, children, createElement('button', { disabled: confirmDisabled, 'data-confirm': true }, confirmLabel))
}));
vi.mock('../../../state', () => ({ useApp: () => context }));

const unchanged = (): void => {};
const fixture = (kind?: 'image' | 'video'): PackageView => ({
  dir: '/fixture/package',
  relative: 'package',
  shot: 'shot-01',
  stage: kind === 'image' ? 'image_downloaded' : 'downloaded',
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
  resultToken: 'result-sha',
  request: {
    dir: '/fixture/request',
    kind,
    provider: 'kling',
    command: kind === 'image' ? 'text_to_image' : 'image_to_video',
    frameId: kind === 'image' ? 'first' : undefined,
    sha256: 'request-sha',
    model: 'fixture-model',
    parameters: {},
    inputs: [],
    attemptStatus: 'downloaded',
    promptText: 'Замороженный промпт',
    generationId: 'generation-id',
    creditsConsumed: 3,
    downloads: ['/fixture/original']
  }
});

beforeEach(() => {
  context.quote = null;
  context.aiAccess = {
    agent: { provider: 'codex', selected: true, available: true, message: '' },
    image: { provider: 'codex', selected: true, available: true, message: '' },
    video: { provider: 'kling', selected: true, available: true, message: '' }
  };
  vi.stubGlobal('window', { api: { shell: { fileUrl: (path: string) => `songframe-file://${path}` } } });
});
afterEach(() => vi.unstubAllGlobals());

describe('Генерация опор и результаты изображений', () => {
  it('использует Codex AgentButton только для Codex, а Kling готовит запрос обычной кнопкой', () => {
    const codex = renderToStaticMarkup(createElement(ProductionFrameGenerationButton, { provider: 'codex', disabled: false, onGenerate: unchanged }));
    const kling = renderToStaticMarkup(createElement(ProductionFrameGenerationButton, { provider: 'kling', disabled: false, onGenerate: unchanged }));
    expect(codex).toContain('Codex');
    expect(codex).not.toMatch(/<button[^>]*disabled/);
    expect(kling).toContain('Подготовить запрос изображения (Kling)');
    expect(kling).not.toContain('Codex');
  });

  it('блокирует неизвестного исполнителя с понятной диагностикой', () => {
    const html = renderToStaticMarkup(createElement(ProductionFrameGenerationButton, { provider: 'future-image', disabled: false, onGenerate: unchanged }));
    expect(html).toContain('future-image');
    expect(html).toContain('не поддерживается');
    expect(html).toContain('disabled');
    expect(html).not.toContain('data-agent');
  });

  it('показывает image-оригинал и выбор опоры без приёмки в assets и видеосводки', () => {
    const html = renderToStaticMarkup(
      createElement(PackageResult, { pkg: fixture('image'), busy: false, onAccept: unchanged, onContactSheet: unchanged, onSelectImage: unchanged })
    );
    expect(html).toContain('<img');
    expect(html).toContain('Выбрать как опору');
    expect(html).toContain('Утверждение опор выполняется отдельно');
    expect(html).not.toContain('<video');
    expect(html).not.toContain('Принять в assets');
    expect(html).not.toContain('Сделать техническую сводку');
  });

  it('сохраняет видеопредставление старого запроса без kind', () => {
    const html = renderToStaticMarkup(
      createElement(PackageResult, { pkg: fixture(), busy: false, onAccept: unchanged, onContactSheet: unchanged, onSelectImage: unchanged })
    );
    expect(html).toContain('<video');
    expect(html).toContain('Принять в assets');
    expect(html).not.toContain('Выбрать как опору');
  });

  it('не разрешает выбрать изображение без токена показанного результата', () => {
    const pkg = fixture('image');
    delete pkg.resultToken;
    const html = renderToStaticMarkup(
      createElement(PackageResult, { pkg, busy: false, onAccept: unchanged, onContactSheet: unchanged, onSelectImage: unchanged })
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*Выбрать как опору<\/button>/);
  });

  it('показывает frozen image-промпт, кадр, SHA и разрешает переход к подтверждению image_request_choice', () => {
    const pkg = fixture('image');
    pkg.stage = 'image_request_choice';
    pkg.request!.attemptStatus = 'prepared';
    const html = renderToStaticMarkup(createElement(PackageRequest, { pkg, busy: false, klingAvailable: true, onSubmit: unchanged }));
    expect(html).toContain('Запрос изображения');
    expect(html).toContain('text_to_image');
    expect(html).toContain('first');
    expect(html).toContain('Замороженный промпт');
    expect(html).toContain('request-sha');
    expect(html).toContain('Отправить');
  });

  it('объясняет неизвестный исход отправки и подписывает хеш и входной кадр', () => {
    const pkg = fixture('video');
    pkg.request!.attemptStatus = 'submission_unknown';
    pkg.request!.inputs = [{ slot: 'image_1', role: 'first', path: 'inputs/01.png', imagePath: '/fixture/inputs/01.png' }];
    const html = renderToStaticMarkup(createElement(PackageRequest, { pkg, busy: false, klingAvailable: true, onSubmit: unchanged }));
    expect(html).toContain('исход отправки неизвестен');
    expect(html).toContain('Хеш запроса (SHA-256)');
    expect(html).toContain('Первый кадр (Изображение 1)');
    expect(html).not.toContain('submission_unknown');
    expect(html).not.toContain('request_sha256');
    expect(html).not.toContain('image_1');
  });

  it('объясняет замену предпочтительной модели в согласовании замороженного запроса', () => {
    const pkg = fixture('video');
    pkg.request!.model = 'kling-video-v4_0';
    pkg.request!.modelSelection = {
      preferredModel: 'kling-video-v3_0',
      selectedModel: 'kling-video-v4_0',
      reason: 'Предпочтение не поддерживает duration=25; выбрана совместимая модель без изменения требований.'
    };
    const html = renderToStaticMarkup(createElement(PackageRequest, { pkg, busy: false, klingAvailable: true, onSubmit: unchanged }));
    expect(html).toContain('Предпочтительная модель kling-video-v3_0 заменена на kling-video-v4_0');
    expect(html).toContain('duration=25');
    expect(html).toContain('MuiAlert-standardWarning');
  });

  it('возобновляет получение изображения по существующему ID без предложения новой отправки', () => {
    const pkg = fixture('image');
    pkg.request!.attemptStatus = 'submitted';
    const html = renderToStaticMarkup(createElement(PackageResume, { pkg, busy: false, klingAvailable: true, onResume: unchanged }));
    expect(html).toContain('Получение изображения');
    expect(html).toContain('Продолжить получение');
    expect(html).not.toContain('Отправить');
  });
});

describe('Прямые действия Kling соблюдают общий выбор', () => {
  it('блокирует подготовку изображения при невыбранном провайдере и сохраняет локальный результат доступным', () => {
    context.aiAccess!.image.selected = false;
    context.aiAccess!.image.message = 'Сначала выберите провайдера изображений.';
    const prepare = renderToStaticMarkup(createElement(ProductionFrameGenerationButton, { provider: 'kling', disabled: false, onGenerate: unchanged }));
    expect(prepare).toMatch(/<button[^>]*disabled/);
    expect(prepare).toContain('Сначала выберите провайдера изображений.');
    const local = renderToStaticMarkup(
      createElement(PackageResult, { pkg: fixture('image'), busy: false, onAccept: unchanged, onContactSheet: unchanged, onSelectImage: unchanged })
    );
    expect(local).not.toMatch(/<button[^>]*disabled/);
  });

  it('использует image kind для отправки и получения изображения независимо от video provider', () => {
    context.aiAccess!.image.selected = false;
    context.aiAccess!.image.message = 'Выберите изображения.';
    const pkg = fixture('image');
    pkg.stage = 'image_request_choice';
    pkg.request!.attemptStatus = 'prepared';
    const send = renderToStaticMarkup(createElement(PackageRequest, { pkg, busy: false, klingAvailable: true, onSubmit: unchanged }));
    expect(send).toMatch(/<button[^>]*disabled/);
    expect(send).toContain('Выберите изображения.');
    pkg.request!.attemptStatus = 'submitted';
    const resume = renderToStaticMarkup(createElement(PackageResume, { pkg, busy: false, klingAvailable: true, onResume: unchanged }));
    expect(resume).toMatch(/<button[^>]*disabled/);
    expect(resume).toContain('Выберите изображения.');
    const video = fixture('video');
    video.request!.attemptStatus = 'submitted';
    expect(renderToStaticMarkup(createElement(PackageResume, { pkg: video, busy: false, klingAvailable: true, onResume: unchanged }))).not.toMatch(
      /<button[^>]*disabled/
    );
  });
});

it('сохраняет локальное согласование при блокировке нового AI-запроса', () => {
  context.aiAccess = null;
  const html = renderToStaticMarkup(
    createElement(PackageDecision, {
      pending: { stage: 'request_choice', question: 'Продолжить?', options: ['approve', 'revise', 'send', 'retry'], executor: 'app' },
      external: false,
      aiKind: 'image',
      busy: false,
      note: 'Нужна правка',
      setNote: unchanged,
      onDecide: unchanged
    })
  );
  const buttons = [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]);
  expect(buttons).toHaveLength(4);
  expect(buttons[0]).not.toContain('disabled');
  expect(buttons[1]).not.toContain('disabled');
  expect(buttons[2]).toContain('disabled');
  expect(buttons[3]).toContain('disabled');
});

describe('Подтверждение промпта и неизвестной цены', () => {
  const dialog = (): string =>
    renderToStaticMarkup(
      createElement(SendRequestDialog, {
        project: '/fixture',
        pkg: fixture('video'),
        busy: false,
        onClose: unchanged,
        onConfirm: async () => {}
      })
    );

  it('показывает полный промпт и требует отдельного согласия для неизвестной стоимости', () => {
    context.quote = { token: 'quote-1', requestSha: 'request-sha', credits: null, balance: 100, verdict: 'cost_or_balance_unknown', reasons: [] };
    const html = dialog();
    expect(html).toContain('Вы уверены, что промпт правильный?');
    expect(html).toContain('Проверьте промпт');
    expect(html).toContain('Замороженный промпт');
    expect(html).toContain('Стоимость: неизвестно');
    expect(html).not.toContain('неизвестно кредитов');
    expect(html).toContain('Я согласен');
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-confirm/);
  });

  it.each([
    { credits: 10, balance: null, verdict: 'cost_or_balance_unknown' as const },
    { credits: 10, balance: 0, verdict: 'insufficient_balance' as const }
  ])('не предлагает согласие, обходя блокирующую цену %j', (price) => {
    context.quote = { token: 'quote-1', requestSha: 'request-sha', reasons: [], ...price };
    const html = dialog();
    expect(html).not.toContain('Я согласен');
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-confirm/);
  });

  it('при подтверждённой цене оставляет обычное подтверждение отправки доступным', () => {
    context.quote = { token: 'quote-1', requestSha: 'request-sha', credits: 10, balance: 100, verdict: 'ok', reasons: [] };
    const html = dialog();
    expect(html).toContain('Стоимость: 10 кредитов');
    expect(html).not.toContain('Я согласен');
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*data-confirm/);
  });
});
