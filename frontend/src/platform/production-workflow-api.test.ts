/**
 * Адаптер группы productionWorkflow: все методы (view, start, apply, discard, generateFrames,
 * importFrames) перенесены в Go. Документы
 * пакета и предложения проходят через json.RawMessage без изменений. Bindings подменяются
 * целиком: Wails runtime и Go не запускаются.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ProductionWorkflowStart } from '@shared/production-workflow';
import { createApi, methodAvailability, type Bindings } from './api';

function bindings(productionWorkflow: Record<string, unknown>): Bindings {
  const missing = async () => {
    throw new Error('binding не настроен в тесте');
  };
  return {
    app: missing,
    shell: missing,
    native: missing,
    components: missing,
    jobs: missing,
    projects: missing,
    timing: missing,
    sources: missing,
    cast: missing,
    scenario: missing,
    tools: missing,
    checks: missing,
    agents: missing,
    ai: missing,
    videoReview: missing,
    cover: missing,
    referenceImages: missing,
    environment: missing,
    media: missing,
    production: missing,
    dashboard: missing,
    scenarioWorkflow: missing,
    productionWorkflow: async () => productionWorkflow as never,
    events: async () => ({ on: () => () => undefined })
  } as Bindings;
}

const framePrompts = [{ id: 'K01', role: 'first', timeSeconds: 0, prompt: 'Лодка', referencePaths: [], extra: { kept: true } }];
const view = (overrides: Record<string, unknown> = {}) => ({
  project: '/клип',
  shot: 'M01',
  packageDir: null,
  busy: false,
  stage: null,
  reasons: { prepare: null, continue: 'нужен выбранный пакет с принятым описанием и опорами', frames: 'нужен выбранный пакет с принятым описанием' },
  derivedFrom: null,
  canPrepare: true,
  canContinue: false,
  canRevise: false,
  canGenerateFrames: false,
  paid: false,
  framePrompts,
  nextFrame: null,
  approvedFrameIds: [],
  problems: [],
  proposal: null,
  job: null,
  ...overrides
});

describe('window.api.productionWorkflow', () => {
  it('перенесены все методы прохода производства', () => {
    for (const method of [
      'productionWorkflow.view',
      'productionWorkflow.start',
      'productionWorkflow.apply',
      'productionWorkflow.discard',
      'productionWorkflow.generateFrames',
      'productionWorkflow.importFrames'
    ] as const)
      expect(methodAvailability(method)).toEqual({ available: true, reason: null });
  });

  it('передаёт документы как есть, а провайдеров — только при наличии', async () => {
    const proposal = { id: 'p', jobId: 'job-1', stage: 'description', status: 'ready', stale: false, before: '', after: { schemaVersion: 1 } };
    const View = vi.fn(async () => view({ proposal, imageProvider: 'test-agent' }));
    const api = createApi(bindings({ View }));
    const result = await api.productionWorkflow.view('/клип', 'M01');
    expect(View).toHaveBeenCalledWith('/клип', 'M01', '');
    expect(result.framePrompts).toBe(framePrompts);
    expect(result.proposal).toBe(proposal);
    expect(result.imageProvider).toBe('test-agent');
    expect(result).not.toHaveProperty('videoProvider');
  });

  it('вызывает методы Go с теми же аргументами; пакет undefined — пустая строка', async () => {
    const methods = { Start: vi.fn(async () => view()), Apply: vi.fn(async () => view()), Discard: vi.fn(async () => view()) };
    const api = createApi(bindings(methods));
    const input: ProductionWorkflowStart = { project: '/клип', shot: 'M01', packageDir: '/клип/plan/batches/M01-attempt-01', action: 'revise', note: 'Ветер' };
    await api.productionWorkflow.start(input);
    await api.productionWorkflow.apply('/клип', 'M01', undefined, 'p');
    await api.productionWorkflow.apply('/клип', 'M01', '/клип/plan/batches/M01-attempt-01', 'q');
    await api.productionWorkflow.discard('/клип', 'M01', undefined, 'p');
    expect(methods.Start).toHaveBeenCalledWith(input);
    expect(methods.Apply).toHaveBeenNthCalledWith(1, '/клип', 'M01', '', 'p');
    expect(methods.Apply).toHaveBeenNthCalledWith(2, '/клип', 'M01', '/клип/plan/batches/M01-attempt-01', 'q');
    expect(methods.Discard).toHaveBeenCalledWith('/клип', 'M01', '', 'p');
  });

  it('создание и импорт опор передают пакет и кандидатов как есть', async () => {
    const methods = { GenerateFrames: vi.fn(async () => view()), ImportFrames: vi.fn(async () => view()) };
    const api = createApi(bindings(methods));
    const images = [{ id: 'K01', path: '/кадры/K01.png' }];
    await api.productionWorkflow.generateFrames('/клип', 'M01', '/клип/plan/batches/M01-attempt-01');
    await api.productionWorkflow.importFrames('/клип', 'M01', '/клип/plan/batches/M01-attempt-01', images);
    expect(methods.GenerateFrames).toHaveBeenCalledWith('/клип', 'M01', '/клип/plan/batches/M01-attempt-01');
    expect(methods.ImportFrames).toHaveBeenCalledWith('/клип', 'M01', '/клип/plan/batches/M01-attempt-01', images);
  });

  it('создание опоры ждёт Go без срока оболочки: платная опора ждёт каталог и подготовку запроса', async () => {
    vi.useFakeTimers();
    try {
      let finish: (value: ReturnType<typeof view>) => void = () => undefined;
      const api = createApi(bindings({ GenerateFrames: () => new Promise((resolve) => (finish = resolve)) }));
      const generating = api.productionWorkflow.generateFrames('/клип', 'M01', '/клип/plan/batches/M01-attempt-01');
      await vi.advanceTimersByTimeAsync(40_000);
      finish(view());
      await expect(generating).resolves.toMatchObject({ shot: 'M01' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('показывает отказ Go-сервиса его текстом', async () => {
    const error = Object.assign(new Error('Сначала выберите агента в настройках приложения.'), { name: 'RuntimeError' });
    const api = createApi(bindings({ Start: async () => Promise.reject(error) }));
    await expect(api.productionWorkflow.start({ project: '/клип', shot: 'M01', action: 'prepare' })).rejects.toMatchObject({
      code: 'SERVICE_FAILED',
      message: error.message
    });
  });

  it('запуск и применение ждут Go без срока оболочки: врезки, каталог моделей и подготовка запроса', async () => {
    vi.useFakeTimers();
    try {
      let finish: (value: ReturnType<typeof view>) => void = () => undefined;
      let applied: (value: ReturnType<typeof view>) => void = () => undefined;
      const api = createApi(
        bindings({ Start: () => new Promise((resolve) => (finish = resolve)), Apply: () => new Promise((resolve) => (applied = resolve)) })
      );
      const starting = api.productionWorkflow.start({ project: '/клип', shot: 'M01', action: 'prepare' });
      const applying = api.productionWorkflow.apply('/клип', 'M01', undefined, 'p');
      await vi.advanceTimersByTimeAsync(40_000);
      finish(view());
      applied(view({ shot: 'M02' }));
      await expect(starting).resolves.toMatchObject({ shot: 'M01' });
      await expect(applying).resolves.toMatchObject({ shot: 'M02' });
    } finally {
      vi.useRealTimers();
    }
  });
});
