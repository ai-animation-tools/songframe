/**
 * Адаптер группы derivedShots: четыре метода идут в DerivedShotService без изменения рецепта
 * (Go сам проверяет его, как checkedDerivedRecipe оригинала), задание вида приводится к JobInfo
 * контракта, ошибка Go становится SERVICE_FAILED. Bindings подменяются целиком.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DerivedShotRecipe } from '@shared/derived-shot';
import { createApi, methodAvailability, type Bindings } from './api';

const recipe: DerivedShotRecipe = { mode: 'repeat', start_frame: 12, end_frame_exclusive: 72 };

const view = {
  project: '/клип',
  shot: 'M05',
  title: 'Вступление',
  action: '',
  sourceShot: 'M03',
  sourceTitle: 'Двор',
  sourcePath: '/клип/assets/shots/M03/video.mp4',
  sourceFrames: 150,
  targetFrames: 90,
  recipe,
  preview: null,
  job: null,
  problem: null,
  toolsProblem: null,
  hasAsset: false
};

/** Задание Go: поля modelDownload и error адаптер не передаёт в контракт. */
const goJob = {
  id: 'job-1',
  project: '/клип',
  kind: 'tool',
  title: 'Сборка производного плана M05',
  status: 'running',
  startedAt: '2026-11-06T12:00:00Z',
  finishedAt: null,
  log: '',
  code: null,
  steps: [],
  modelDownload: null,
  error: null
};

function harness(derivedShots: Record<string, unknown>) {
  const b = { derivedShots: async () => derivedShots as never } as unknown as Bindings;
  return createApi(b);
}

describe('derivedShots поверх DerivedShotService', () => {
  it('все методы перенесены', () => {
    for (const method of ['view', 'save', 'build', 'accept'] as const)
      expect(methodAvailability(`derivedShots.${method}`)).toEqual({ available: true, reason: null });
  });

  it('передаёт рецепт без изменений и возвращает вид', async () => {
    const View = vi.fn(async () => view);
    const Save = vi.fn(async () => view);
    const api = harness({ View, Save });
    await expect(api.derivedShots.view('/клип', 'M05')).resolves.toStrictEqual(view);
    await expect(api.derivedShots.save('/клип', 'M05', recipe)).resolves.toStrictEqual(view);
    expect(View).toHaveBeenCalledWith('/клип', 'M05');
    expect(Save).toHaveBeenCalledWith('/клип', 'M05', recipe);
  });

  it('сборка и приёмка приводят задание к контракту', async () => {
    const Build = vi.fn(async () => ({ ...view, job: goJob }));
    const Accept = vi.fn(async () => ({ ...view, job: goJob }));
    const api = harness({ Build, Accept });
    const built = await api.derivedShots.build('/клип', 'M05', recipe);
    expect(built.job?.id).toBe('job-1');
    expect(built.job).not.toHaveProperty('modelDownload');
    expect(built.job).not.toHaveProperty('error');
    await api.derivedShots.accept('/клип', 'M05', 'id-1', 'a'.repeat(64), true);
    expect(Build).toHaveBeenCalledWith('/клип', 'M05', recipe);
    expect(Accept).toHaveBeenCalledWith('/клип', 'M05', 'id-1', 'a'.repeat(64), true);
  });

  it('ошибка Go — SERVICE_FAILED с текстом сервиса', async () => {
    const Build = vi.fn(async () => {
      throw Object.assign(new Error('Материал источника устарел.'), { name: 'RuntimeError' });
    });
    await expect(harness({ Build }).derivedShots.build('/клип', 'M05', recipe)).rejects.toMatchObject({
      code: 'SERVICE_FAILED',
      method: 'derivedShots.build',
      message: 'Материал источника устарел.'
    });
  });
});
