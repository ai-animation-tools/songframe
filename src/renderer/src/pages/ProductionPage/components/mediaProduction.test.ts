/** Контракт представления различает платный image-запрос, выбор опоры и отдельную приёмку видео. */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAccess } from '@shared/ai-access';
import type { PackageView, ProductionQuote } from '@shared/types';
import { agentTitle } from '@shared/agent-providers';
import { MEDIA_PROVIDERS, mediaProvidersFor, registerMediaProviderForTests } from '@shared/media-providers';
import { ProductionFrameGenerationButton } from './ProductionFrameGenerationButton';
import { PackageRequest } from './PackageRequest';
import { PackageResult } from './PackageResult';
import { PackageResume } from './PackageResume';
import { PackageDecision } from './PackageDecision';
import { SendRequestDialog } from './SendRequestDialog';
import { TEST_AGENT_PROVIDER, TEST_PROVIDER, testAgentProviderInfo, testProviderInfo } from '@shared/testing/media-provider';

// Опоры провайдера-агента исполняет программа из реестра агентов; её знак показывает AgentButton.
const AGENT_EXECUTOR = testAgentProviderInfo.executor!;
let restoreProviders: (() => void)[] = [];
beforeAll(() => {
  restoreProviders = [
    registerMediaProviderForTests(TEST_PROVIDER, testProviderInfo),
    registerMediaProviderForTests(TEST_AGENT_PROVIDER, testAgentProviderInfo)
  ];
});
afterAll(() => restoreProviders.forEach((restore) => restore()));

// Сохранённый выбор задаётся независимо от поставляемых моделям настроек по умолчанию.
const context = vi.hoisted(() => ({ agentProvider: 'codex' as string | null, aiAccess: null as AiAccess | null, quote: null as ProductionQuote | null }));
vi.mock('../useRequestQuote', () => ({
  useRequestQuote: () => ({ quote: context.quote, error: null, loading: false, refreshQuote: () => {}, consumeQuote: () => {} })
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
  keyframeNotes: [],
  sceneChanged: false,
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
    provider: TEST_PROVIDER,
    command: kind === 'image' ? 'text_to_image' : 'image_to_video',
    frameId: kind === 'image' ? 'first' : undefined,
    sha256: 'request-sha',
    model: 'fixture-model',
    parameters: {},
    inputs: [],
    attemptStatus: 'downloaded',
    promptText: 'Замороженный промпт',
    generationId: 'generation-id',
    manualResult: false,
    creditsConsumed: 3,
    downloads: ['/fixture/original']
  }
});

beforeEach(() => {
  context.quote = null;
  context.aiAccess = {
    agent: { provider: 'codex', selected: true, available: true, message: '' },
    image: { provider: TEST_AGENT_PROVIDER, selected: true, available: true, message: '' },
    video: { provider: TEST_PROVIDER, selected: true, available: true, message: '' }
  };
  vi.stubGlobal('window', { api: { shell: { fileUrl: (path: string) => `songframe-file://${path}` } } });
});
afterEach(() => vi.unstubAllGlobals());

describe('Генерация опор и результаты изображений', () => {
  it('использует AgentButton только для провайдера-агента, а платный провайдер готовит запрос обычной кнопкой', () => {
    const agent = renderToStaticMarkup(
      createElement(ProductionFrameGenerationButton, { provider: TEST_AGENT_PROVIDER, disabled: false, onGenerate: unchanged })
    );
    const paid = renderToStaticMarkup(createElement(ProductionFrameGenerationButton, { provider: TEST_PROVIDER, disabled: false, onGenerate: unchanged }));
    expect(agent).toContain(`title="${agentTitle(AGENT_EXECUTOR)}"`);
    expect(agent).not.toMatch(/<button[^>]*disabled/);
    expect(paid).toContain(`Подготовить запрос изображения (${MEDIA_PROVIDERS[TEST_PROVIDER].title})`);
    expect(paid).not.toContain(agentTitle(AGENT_EXECUTOR));
  });

  it.each(['claude', null])('показывает знак исполнителя на кнопке опор провайдера-агента при агенте %s', (agent) => {
    context.agentProvider = agent;
    try {
      const html = renderToStaticMarkup(
        createElement(ProductionFrameGenerationButton, { provider: TEST_AGENT_PROVIDER, disabled: false, onGenerate: unchanged })
      );
      expect(html).toContain(`Создать опоры в ${MEDIA_PROVIDERS[TEST_AGENT_PROVIDER].title}`);
      expect(html).toContain(`title="${agentTitle(AGENT_EXECUTOR)}"`);
      expect(html).not.toMatch(/<button[^>]*disabled/);
    } finally {
      context.agentProvider = 'codex';
    }
  });

  it('подписывает кнопку опорой, которую создаст следующее задание', () => {
    const agent = renderToStaticMarkup(
      createElement(ProductionFrameGenerationButton, { provider: TEST_AGENT_PROVIDER, frame: 'K02', disabled: false, onGenerate: unchanged })
    );
    const paid = renderToStaticMarkup(
      createElement(ProductionFrameGenerationButton, { provider: TEST_PROVIDER, frame: 'K02', disabled: false, onGenerate: unchanged })
    );
    expect(agent).toContain(`Создать K02 в ${MEDIA_PROVIDERS[TEST_AGENT_PROVIDER].title}`);
    expect(paid).toContain(`Подготовить запрос изображения K02 (${MEDIA_PROVIDERS[TEST_PROVIDER].title})`);
  });

  it('строит список поддерживаемых исполнителей опор из реестра', () => {
    const html = renderToStaticMarkup(createElement(ProductionFrameGenerationButton, { disabled: false, onGenerate: unchanged }));
    expect(html).toContain('Провайдер изображений не задан.');
    const titles = mediaProvidersFor('image').map((id) => MEDIA_PROVIDERS[id].title);
    expect(titles).toContain(MEDIA_PROVIDERS[TEST_PROVIDER].title);
    expect(html).toContain(`Выберите ${titles.slice(0, -1).join(', ')} или ${titles.at(-1)} в настройках проекта.`);
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
    expect(html).toContain('Утвердить её нужно отдельно');
    expect(html).not.toContain('<video');
    expect(html).not.toContain('>Принять<');
    expect(html).not.toContain('Сделать техническую сводку');
  });

  it('сохраняет видеопредставление старого запроса без kind', () => {
    const html = renderToStaticMarkup(
      createElement(PackageResult, { pkg: fixture(), busy: false, onAccept: unchanged, onContactSheet: unchanged, onSelectImage: unchanged })
    );
    expect(html).toContain('<video');
    expect(html).toContain('>Принять<');
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
    const html = renderToStaticMarkup(createElement(PackageRequest, { pkg, busy: false, providerAvailable: true, onSubmit: unchanged }));
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
    const html = renderToStaticMarkup(createElement(PackageRequest, { pkg, busy: false, providerAvailable: true, onSubmit: unchanged }));
    expect(html).toContain('исход отправки неизвестен');
    expect(html).toContain('Хеш запроса (SHA-256)');
    expect(html).toContain('Первый кадр (Изображение 1)');
    expect(html).not.toContain('submission_unknown');
    expect(html).not.toContain('request_sha256');
    expect(html).not.toContain('image_1');
  });

  it('объясняет замену предпочтительной модели в согласовании замороженного запроса', () => {
    const pkg = fixture('video');
    pkg.request!.model = 'test-video-pro';
    pkg.request!.modelSelection = {
      preferredModel: 'test-video',
      selectedModel: 'test-video-pro',
      reason: 'Предпочтение не поддерживает duration=25; выбрана совместимая модель без изменения требований.'
    };
    const html = renderToStaticMarkup(createElement(PackageRequest, { pkg, busy: false, providerAvailable: true, onSubmit: unchanged }));
    expect(html).toContain('Предпочтительная модель test-video заменена на test-video-pro');
    expect(html).toContain('duration=25');
    expect(html).toContain('MuiAlert-standardWarning');
  });

  it('при неизвестном исходе без ID отсылает к истории генераций из реестра провайдера вместо поля ID', () => {
    const pkg = fixture('video');
    pkg.request!.attemptStatus = 'submission_unknown';
    pkg.request!.generationId = null;
    const html = renderToStaticMarkup(
      createElement(PackageResume, { pkg, busy: false, providerAvailable: true, onResume: unchanged, onAttach: unchanged, onNotCreated: unchanged })
    );
    expect(html).toContain(MEDIA_PROVIDERS[TEST_PROVIDER].generationHistory);
    expect(html).toContain('Загрузить результат вручную');
    expect(html).toContain('Задание не создано');
    expect(html).not.toContain('Продолжить получение');
    expect(html).not.toContain('<input');
  });

  it('возобновляет получение изображения по существующему ID без предложения новой отправки', () => {
    const pkg = fixture('image');
    pkg.request!.attemptStatus = 'submitted';
    const html = renderToStaticMarkup(
      createElement(PackageResume, { pkg, busy: false, providerAvailable: true, onResume: unchanged, onAttach: unchanged, onNotCreated: unchanged })
    );
    expect(html).toContain('Получение изображения');
    expect(html).toContain('Продолжить получение');
    expect(html).not.toContain('Отправить');
  });
});

describe('Прямые действия платного провайдера соблюдают общий выбор', () => {
  it('блокирует подготовку изображения при невыбранном провайдере и сохраняет локальный результат доступным', () => {
    context.aiAccess!.image.selected = false;
    context.aiAccess!.image.message = 'Сначала выберите провайдера изображений.';
    const prepare = renderToStaticMarkup(createElement(ProductionFrameGenerationButton, { provider: TEST_PROVIDER, disabled: false, onGenerate: unchanged }));
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
    const send = renderToStaticMarkup(createElement(PackageRequest, { pkg, busy: false, providerAvailable: true, onSubmit: unchanged }));
    expect(send).toMatch(/<button[^>]*disabled/);
    expect(send).toContain('Выберите изображения.');
    pkg.request!.attemptStatus = 'submitted';
    const resume = renderToStaticMarkup(
      createElement(PackageResume, { pkg, busy: false, providerAvailable: true, onResume: unchanged, onAttach: unchanged, onNotCreated: unchanged })
    );
    expect(resume).toMatch(/<button[^>]*disabled/);
    expect(resume).toContain('Выберите изображения.');
    const video = fixture('video');
    video.request!.attemptStatus = 'submitted';
    expect(
      renderToStaticMarkup(
        createElement(PackageResume, { pkg: video, busy: false, providerAvailable: true, onResume: unchanged, onAttach: unchanged, onNotCreated: unchanged })
      )
    ).not.toMatch(/<button[^>]*disabled/);
  });
});

it('сохраняет локальное согласование при блокировке нового AI-запроса', () => {
  context.aiAccess = null;
  const html = renderToStaticMarkup(
    createElement(PackageDecision, {
      pending: { stage: 'request_choice', question: 'Продолжить?', options: ['approve', 'revise', 'send', 'retry'] },
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
    expect(html).toContain('Стоимость: станет известна после первого такого запроса');
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
