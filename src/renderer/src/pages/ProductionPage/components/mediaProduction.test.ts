/** Контракт представления различает платный image-запрос, выбор опоры и отдельную приёмку видео. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageView } from '@shared/types';
import { ProductionFrameGenerationButton } from './ProductionFrameGenerationButton';
import { PackageRequest } from './PackageRequest';
import { PackageResult } from './PackageResult';
import { PackageResume } from './PackageResume';

// Здесь проверяется выбор исполнителя, поэтому кнопка агента заменяет только зависимость от AppProvider.
vi.mock('../../../components', () => ({
  AgentButton: ({ provider, disabled, children }: { provider: string; disabled: boolean; children: string }) =>
    createElement('button', { 'data-agent': provider, disabled }, children)
}));

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

beforeEach(() => vi.stubGlobal('window', { api: { shell: { fileUrl: (path: string) => `songframe-file://${path}` } } }));
afterEach(() => vi.unstubAllGlobals());

describe('Генерация опор и результаты изображений', () => {
  it('использует Codex AgentButton только для Codex, а Kling готовит запрос обычной кнопкой', () => {
    const codex = renderToStaticMarkup(createElement(ProductionFrameGenerationButton, { provider: 'codex', disabled: false, onGenerate: unchanged }));
    const kling = renderToStaticMarkup(createElement(ProductionFrameGenerationButton, { provider: 'kling', disabled: false, onGenerate: unchanged }));
    expect(codex).toContain('data-agent="codex"');
    expect(kling).toContain('Подготовить запрос изображения (Kling)');
    expect(kling).not.toContain('data-agent');
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
