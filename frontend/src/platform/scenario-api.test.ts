/**
 * Адаптер групп cast и scenario: документы сценария проходят через json.RawMessage без изменений
 * (порядок ключей и лишние поля сохраняются), ошибка Go-сервиса показывается своим текстом.
 * Bindings подменяются целиком: Wails runtime и Go не запускаются.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ScenesFile } from '@shared/types';
import { createApi, methodAvailability, type Bindings } from './api';

function bindings(scenario: Record<string, unknown>, cast: Record<string, unknown> = {}): Bindings {
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
    cast: async () => cast as never,
    scenario: async () => scenario as never,
    tools: missing,
    checks: missing,
    agents: missing,
    ai: missing,
    scenarioWorkflow: missing,
    videoReview: missing,
    cover: missing,
    referenceImages: missing,
    environment: missing,
    media: missing,
    production: missing,
    dashboard: missing,
    events: async () => ({ on: () => () => undefined })
  } as Bindings;
}

describe('window.api.cast и window.api.scenario', () => {
  it('все методы групп перенесены в Go', () => {
    for (const method of [
      'cast.view',
      'cast.init',
      'cast.save',
      'scenario.status',
      'scenario.view',
      'scenario.saveTreatment',
      'scenario.validateTreatment',
      'scenario.saveScenes',
      'scenario.saveImpact',
      'scenario.validateScenes',
      'scenario.brief'
    ] as const)
      expect(methodAvailability(method)).toEqual({ available: true, reason: null });
  });

  it('передаёт черновик и режим как есть и возвращает записанный документ Go', async () => {
    const saved = { schema_version: 1, fps: 30, extra: { kept: true }, scenes: [] } as unknown as ScenesFile;
    const SaveScenes = vi.fn(async () => saved);
    const api = createApi(bindings({ SaveScenes }));
    const draft = { fps: 30, schema_version: 1, scenes: [] } as unknown as ScenesFile;
    await expect(api.scenario.saveScenes('/клип', draft, 'keep')).resolves.toBe(saved);
    expect(SaveScenes).toHaveBeenCalledWith('/клип', draft, 'keep');
  });

  it('сужает строки Go до закрытых наборов контракта', async () => {
    const api = createApi(
      bindings({
        Status: async () => 'ready',
        SaveImpact: async () => ({ shots: [{ id: 'M01', reason: 'сдвинуты границы плана', state: 'completed', produced: true }] })
      })
    );
    await expect(api.scenario.status('/клип')).resolves.toBe('ready');
    await expect(api.scenario.saveImpact('/клип', {} as ScenesFile)).resolves.toEqual({
      shots: [{ id: 'M01', reason: 'сдвинуты границы плана', state: 'completed', produced: true }]
    });
  });

  it('показывает отказ Go-сервиса его текстом', async () => {
    const error = Object.assign(new Error('Неизвестный режим сохранения реестра.'), { name: 'RuntimeError' });
    const api = createApi(bindings({ SaveScenes: async () => Promise.reject(error) }));
    await expect(api.scenario.saveScenes('/клип', {} as ScenesFile, 'production')).rejects.toMatchObject({ code: 'SERVICE_FAILED', message: error.message });
  });
});
