/**
 * Адаптер группы scenarioWorkflow: шесть методов вызывают Go. Документы предложения проходят
 * через json.RawMessage без изменений, необязательное message появляется только при наличии,
 * отказ Go-сервиса показывается своим текстом. Bindings подменяются целиком: Wails runtime и Go не запускаются.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ScenarioWorkflowStart } from '@shared/scenario-workflow';
import { createApi, type Bindings } from './api';

function bindings(scenarioWorkflow: Record<string, unknown>): Bindings {
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
    animatic: missing,
    montage: missing,
    montageWindow: missing,
    derivedShots: missing,
    updates: missing,
    scenarioWorkflow: async () => scenarioWorkflow as never,
    productionWorkflow: missing,
    events: async () => ({ on: () => () => undefined })
  } as Bindings;
}

const view = (proposal: unknown = null, job: unknown = null) => ({
  project: '/клип',
  busy: false,
  canStartTreatment: true,
  canStartScenes: false,
  canRevise: false,
  canApproveCurrent: true,
  canApproveScenes: false,
  treatmentApproved: false,
  scenesNeedReview: false,
  problems: [],
  proposal,
  job
});

describe('window.api.scenarioWorkflow', () => {
  it('передаёт документы предложения как есть и копирует message только при наличии', async () => {
    const before = { cast: null, treatment: { schema_version: 1, extra: { kept: true } }, scenes: null };
    const proposal = {
      id: 'p',
      jobId: 'job-0',
      pass: 'treatment',
      selectedIds: [],
      status: 'ready',
      warnings: [],
      stale: false,
      before,
      after: before,
      changedIds: []
    };
    const View = vi.fn(async () => view(proposal));
    const api = createApi(bindings({ View }));
    const result = await api.scenarioWorkflow.view('/клип');
    expect(View).toHaveBeenCalledWith('/клип');
    expect(result.proposal?.before).toBe(before);
    expect(result.proposal).not.toHaveProperty('message');
    const Discard = vi.fn(async () => view({ ...proposal, status: 'invalid', message: 'Неверный ответ.' }));
    await expect(createApi(bindings({ Discard })).scenarioWorkflow.discard('/клип', 'p')).resolves.toMatchObject({
      proposal: { status: 'invalid', message: 'Неверный ответ.' }
    });
    expect(Discard).toHaveBeenCalledWith('/клип', 'p');
  });

  it('вызывает методы Go с теми же аргументами', async () => {
    const methods = {
      Start: vi.fn(async () => view()),
      Apply: vi.fn(async () => view()),
      ApproveCurrent: vi.fn(async () => view()),
      ApproveScenes: vi.fn(async () => view())
    };
    const api = createApi(bindings(methods));
    const input: ScenarioWorkflowStart = { project: '/клип', pass: 'revise', note: 'Ветер', selectedIds: ['M03'] };
    await api.scenarioWorkflow.start(input);
    await api.scenarioWorkflow.apply('/клип', 'p');
    await api.scenarioWorkflow.approveCurrent('/клип');
    await api.scenarioWorkflow.approveScenes('/клип');
    expect(methods.Start).toHaveBeenCalledWith(input);
    expect(methods.Apply).toHaveBeenCalledWith('/клип', 'p');
    expect(methods.ApproveCurrent).toHaveBeenCalledWith('/клип');
    expect(methods.ApproveScenes).toHaveBeenCalledWith('/клип');
  });

  it('показывает отказ Go-сервиса его текстом', async () => {
    // Ошибку Go Wails доставляет как RuntimeError с текстом сервиса.
    const error = Object.assign(new Error('Запуск агента ещё не подключён в Go-версии SongFrame.'), { name: 'RuntimeError' });
    const api = createApi(bindings({ Start: async () => Promise.reject(error) }));
    await expect(api.scenarioWorkflow.start({ project: '/клип', pass: 'treatment' })).rejects.toMatchObject({ code: 'SERVICE_FAILED', message: error.message });
  });

  it('применение ждёт Go дольше срока оболочки: на большом клипе публикация идёт около минуты', async () => {
    vi.useFakeTimers();
    try {
      let finish: (value: ReturnType<typeof view>) => void = () => undefined;
      const api = createApi(bindings({ Apply: () => new Promise((resolve) => (finish = resolve)) }));
      const applying = api.scenarioWorkflow.apply('/клип', 'p1');
      await vi.advanceTimersByTimeAsync(60_000);
      finish(view());
      await expect(applying).resolves.toMatchObject({ project: '/клип' });
    } finally {
      vi.useRealTimers();
    }
  });
});
