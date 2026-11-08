/**
 * Адаптер группы videoReview: методы перенесены в Go (этап 44), ответ Go проходит без ручной
 * проверки и изменения, задание агента внутри представления сужается общим toAgentJob, отказ Go
 * показывается своим текстом. Bindings подменяются целиком; Wails runtime не нужен.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentJob } from '@shared/agents';
import type { VideoReviewView } from '@shared/video-review';
import { createApi, type Bindings } from './api';

function bindings(videoReview: Record<string, unknown>): Bindings {
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
    videoReview: async () => videoReview as never,
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
    scenarioWorkflow: missing,
    productionWorkflow: missing,
    events: async () => ({ on: () => () => undefined })
  } as Bindings;
}

const job: AgentJob = {
  schemaVersion: 1,
  id: 'job-1',
  sequence: 1,
  project: '/клип',
  provider: 'codex',
  task: 'Проверка видео агентом',
  permissions: 'read-only',
  inputHashes: { prompt: 'a'.repeat(64), context: 'b'.repeat(64) },
  status: 'completed',
  phase: 'Завершено',
  startedAt: '2026-11-04T09:00:00.000Z',
  finishedAt: '2026-11-04T09:01:00.000Z',
  exitCode: 0,
  result: '{}',
  log: ''
};

const completed: VideoReviewView = {
  status: 'completed',
  job,
  report: {
    schemaVersion: 1,
    summary: 'Видео соответствует плану.',
    findings: [{ verdict: 'match', timeSeconds: 1.5, description: 'Персонаж на месте.', frameIds: ['F01'] }],
    limitations: []
  },
  frames: [{ id: 'F01', timeSeconds: 1.5, path: '/клип/production/S001/video-review/latest/F01.png' }],
  stale: false,
  canStart: true,
  reason: null,
  error: null,
  durationSeconds: 5
};

const idle: VideoReviewView = {
  status: 'idle',
  job: null,
  report: null,
  frames: [],
  stale: false,
  canStart: false,
  reason: 'Нет видео для проверки.',
  error: null,
  durationSeconds: null
};

describe('window.api.videoReview', () => {
  it('передаёт проект и пакет, возвращает представление Go без изменений', async () => {
    const service = {
      View: vi.fn(async () => completed),
      Start: vi.fn(async () => ({ ...idle, status: 'preparing', canStart: false, reason: null })),
      Cancel: vi.fn(async () => ({ ...idle, status: 'cancelled', error: 'Проверка видео остановлена.' }))
    };
    const api = createApi(bindings(service));
    await expect(api.videoReview.view('/клип', '/клип/production/S001')).resolves.toEqual(completed);
    await expect(api.videoReview.start('/клип', '/клип/production/S001')).resolves.toMatchObject({ status: 'preparing', job: null });
    await expect(api.videoReview.cancel('/клип', '/клип/production/S001')).resolves.toMatchObject({ status: 'cancelled' });
    for (const method of [service.View, service.Start, service.Cancel]) expect(method).toHaveBeenCalledWith('/клип', '/клип/production/S001');
  });

  it('необязательный diagnostic задания не появляется пустым ключом', async () => {
    const api = createApi(bindings({ View: async () => completed }));
    const view = await api.videoReview.view('/клип', '/клип/production/S001');
    expect(view.job && 'diagnostic' in view.job).toBe(false);
    const failed = { ...completed, status: 'failed', job: { ...job, status: 'failed', diagnostic: 'cancelled' } };
    const withDiagnostic = createApi(bindings({ View: async () => failed }));
    await expect(withDiagnostic.videoReview.view('/клип', '/клип/production/S001')).resolves.toMatchObject({
      job: { diagnostic: 'cancelled' }
    });
  });

  it('показывает отказ Go своим текстом', async () => {
    const error = Object.assign(new Error('[AGENT_UNSELECTED] Сначала выберите агента в настройках.'), { name: 'RuntimeError' });
    const api = createApi(bindings({ Start: async () => Promise.reject(error) }));
    await expect(api.videoReview.start('/клип', '/клип/production/S001')).rejects.toMatchObject({
      code: 'SERVICE_FAILED',
      method: 'videoReview.start',
      message: error.message
    });
  });
});
