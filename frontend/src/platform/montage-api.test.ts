/**
 * Адаптер группы montage: все шесть методов идут в MontageService без преобразования черновика
 * (Go сам проверяет его, как normalizeMontageDraft оригинала). Проверяются аргументы bindings,
 * `id ?? null` при сохранении, приведение задания экспорта и применения к JobInfo контракта и
 * отмена выбора файла пробы. Bindings подменяются целиком: Wails runtime и Go не запускаются.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MontageDraft } from '@shared/montage';
import { createApi, type Bindings } from './api';

const draft: MontageDraft = {
  schema_version: 1,
  name: 'Режиссёрская версия',
  audio: { path: 'source/track.wav', start_frame: 0, end_frame_exclusive: 90 },
  clips: [],
  base_scenes_sha256: 'a'.repeat(64),
  base_manifest_sha256: {}
};

/** Задание Go: поля modelDownload и error адаптер не передаёт в контракт. */
const goJob = {
  id: 'job-1',
  project: '/клип',
  kind: 'tool',
  title: 'Применение монтажа',
  status: 'running',
  startedAt: '2026-11-05T12:00:00Z',
  finishedAt: null,
  log: '',
  code: null,
  steps: [],
  modelDownload: null,
  error: null
};

function harness(montage: Record<string, unknown>) {
  const b = { montage: async () => montage as never } as unknown as Bindings;
  return createApi(b);
}

describe('montage поверх MontageService', () => {
  it('передаёт черновик без изменений, сохраняет новый черновик с id null', async () => {
    const saved = { id: 'id-1', name: draft.name, updatedAt: '2026-11-05T12:00:00.000Z' };
    const Save = vi.fn(async () => saved);
    const Load = vi.fn(async () => structuredClone(draft));
    const api = harness({ Save, Load });
    await expect(api.montage.save('/клип', draft)).resolves.toStrictEqual(saved);
    await api.montage.save('/клип', draft, 'id-1');
    expect(Save.mock.calls).toStrictEqual([
      ['/клип', draft, null],
      ['/клип', draft, 'id-1']
    ]);
    await expect(api.montage.load('/клип', 'id-1')).resolves.toStrictEqual(draft);
    expect(Load).toHaveBeenCalledWith('/клип', 'id-1');
  });

  it('удаление черновика передаёт проект и идентификатор', async () => {
    const Remove = vi.fn(async () => undefined);
    await expect(harness({ Remove }).montage.remove('/клип', 'id-1')).resolves.toBeUndefined();
    expect(Remove).toHaveBeenCalledWith('/клип', 'id-1');
  });

  it('экспорт и применение возвращают задание контракта', async () => {
    const Export = vi.fn(async () => ({ job: goJob, video: 'plan/reviews/montage/latest/review.mp4' }));
    const Apply = vi.fn(async () => goJob);
    const api = harness({ Export, Apply });
    const exported = await api.montage.export('/клип', draft);
    expect(exported.video).toBe('plan/reviews/montage/latest/review.mp4');
    expect(exported.job).not.toHaveProperty('modelDownload');
    expect(exported.job).not.toHaveProperty('error');
    expect(exported.job.id).toBe('job-1');
    const applied = await api.montage.apply('/клип', draft);
    expect(applied).toStrictEqual(exported.job);
    expect(Export).toHaveBeenCalledWith('/клип', draft);
    expect(Apply).toHaveBeenCalledWith('/клип', draft);
  });

  it('отмена выбора файла пробы — null, ошибка Go — SERVICE_FAILED', async () => {
    const SaveVideo = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(Object.assign(new Error('Проба монтажа не найдена.'), { name: 'RuntimeError' }));
    const api = harness({ SaveVideo });
    await expect(api.montage.saveVideo('/клип', 'plan/reviews/montage/latest/review.mp4')).resolves.toBeNull();
    await expect(api.montage.saveVideo('/клип', 'нет.mp4')).rejects.toMatchObject({
      code: 'SERVICE_FAILED',
      method: 'montage.saveVideo',
      message: 'Проба монтажа не найдена.'
    });
  });
});
