/**
 * Адаптер группы scenarioWorkflow: восемь методов вызывают Go. Документы предложения проходят
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
    schemes: missing,
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
    promptLog: missing,
    projectHistory: missing,
    montage: missing,
    montageWindow: missing,
    cameraWindow: missing,
    derivedShots: missing,
    effects: missing,
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
  changedInputs: ['timing'],
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
    const error = Object.assign(new Error('Запуск агента сейчас недоступен.'), { name: 'RuntimeError' });
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

  it('проверка сценария: отчёт передаётся как есть, задание агента — через общий вид', async () => {
    const report = {
      summary: 'Одна проблема.',
      issues: [
        {
          group: 'state',
          severity: 'high',
          shots: ['M08'],
          entities: ['artem'],
          title: 'Часы на улице',
          problem: 'Где.',
          why: 'Почему.',
          fix: 'Что сделать.',
          changes: [{ shot: 'M08', phase: 'before', entity: 'artem', property: 'facing', value: 'на дверь' }],
          fixed: false,
          resolved: false
        }
      ]
    };
    const checkView = { status: 'ready', canStart: true, reason: null, stale: false, report, message: null, job: null };
    const methods = {
      CheckView: vi.fn(async () => checkView),
      StartCheck: vi.fn(async () => ({ ...checkView, status: 'running', report: null, canStart: false, reason: 'Занято.' })),
      CheckFixPreview: vi.fn(async () => preview),
      ApplyCheckFixes: vi.fn(async () => ({ ...checkView, report: { ...report, issues: [{ ...report.issues[0], fixed: true }] } })),
      ResolveCheckIssue: vi.fn(async () => ({ ...checkView, report: { ...report, issues: [{ ...report.issues[0], resolved: true }] } }))
    };
    const preview = {
      changes: [
        {
          issue: 0,
          shot: 'M08',
          phase: 'before',
          entity: 'artem',
          entityName: 'Артём',
          property: 'facing',
          propertyLabel: 'Взгляд',
          current: 'на часы',
          value: 'на дверь'
        }
      ],
      accepted: [{ id: 'M08', direct: true }],
      stale: []
    };
    const api = createApi(bindings(methods));
    await expect(api.scenarioWorkflow.checkView('/клип')).resolves.toEqual(checkView);
    await expect(api.scenarioWorkflow.startCheck('/клип')).resolves.toMatchObject({ status: 'running', report: null, reason: 'Занято.' });
    expect(methods.CheckView).toHaveBeenCalledWith('/клип');
    expect(methods.StartCheck).toHaveBeenCalledWith('/клип');
    await expect(api.scenarioWorkflow.checkFixPreview('/клип', [0])).resolves.toEqual(preview);
    await expect(api.scenarioWorkflow.applyCheckFixes({ project: '/клип', issues: [0], keep: ['M08'] })).resolves.toMatchObject({
      report: { issues: [{ fixed: true }] }
    });
    expect(methods.CheckFixPreview).toHaveBeenCalledWith('/клип', [0]);
    expect(methods.ApplyCheckFixes).toHaveBeenCalledWith({ project: '/клип', issues: [0], keep: ['M08'] });
    await expect(api.scenarioWorkflow.resolveCheckIssue({ project: '/клип', issue: 0, resolved: true })).resolves.toMatchObject({
      report: { issues: [{ resolved: true }] }
    });
    expect(methods.ResolveCheckIssue).toHaveBeenCalledWith({ project: '/клип', issue: 0, resolved: true });
  });
});
