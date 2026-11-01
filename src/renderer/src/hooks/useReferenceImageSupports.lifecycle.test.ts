/** Жизненный цикл чтения опор проверяется без DOM, файловой системы и настоящего IPC. */
import type * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationReferenceImage } from '@shared/cover-generation';
import type { ReferenceImageGenerationInput, ReferenceImageOption } from '@shared/reference-image-generation';
import { sourcesTexts } from '@shared/texts/sources';
import { useReferenceImageSupports } from './useReferenceImageSupports';

const fixture = vi.hoisted(() => ({
  states: [] as unknown[],
  stateIndex: 0,
  effectIndex: 0,
  effects: [] as { deps: readonly unknown[]; cleanup?: () => void }[],
  pending: [] as (() => void)[],
  describeError: (error: unknown) => (error instanceof Error ? error.message : String(error))
}));
// Стенд сохраняет зависимости и cleanup эффектов, чтобы поздний ответ проходил настоящую отмену hook.
vi.mock('react', async (original) => ({
  ...(await original<typeof React>()),
  useState: (initial: unknown) => {
    const index = fixture.stateIndex++;
    if (!(index in fixture.states)) fixture.states[index] = typeof initial === 'function' ? initial() : initial;
    return [
      fixture.states[index],
      (value: unknown) => {
        fixture.states[index] = typeof value === 'function' ? value(fixture.states[index]) : value;
      }
    ];
  },
  useEffect: (effect: () => (() => void) | void, deps: readonly unknown[]) => {
    const index = fixture.effectIndex++;
    const old = fixture.effects[index];
    if (!old || deps.some((value, n) => !Object.is(value, old.deps[n])))
      fixture.pending.push(() => {
        old?.cleanup?.();
        fixture.effects[index] = { deps, cleanup: effect() ?? undefined };
      });
  }
}));
vi.mock('../state', () => ({ useApp: () => ({ describeError: fixture.describeError }) }));

const first: ReferenceImageOption = { path: '/first.png', label: 'Спереди', note: 'Сохранить лицо' };
const second: ReferenceImageOption = { path: '/second.png', label: 'Сбоку', note: 'Сохранить куртку' };
const image = (option: ReferenceImageOption, sha256 = 'a'.repeat(64)): GenerationReferenceImage => ({
  path: option.path,
  label: option.label,
  sha256,
  bytes: 128
});
const inspect = vi.fn<(input: ReferenceImageGenerationInput) => Promise<GenerationReferenceImage[]>>();
const referenceApi: { inspect?: typeof inspect } = {};

function RenderHook(options: ReferenceImageOption[], enabled = true) {
  fixture.stateIndex = fixture.effectIndex = 0;
  const value = useReferenceImageSupports(enabled, options);
  for (const effect of fixture.pending.splice(0)) effect();
  return value;
}
async function settle() {
  // Обрабатываем then и catch промиса чтения, не добавляя таймеры в проверку порядка ответов.
  await Promise.resolve();
  await Promise.resolve();
}
function deferred() {
  let resolve!: (images: GenerationReferenceImage[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<GenerationReferenceImage[]>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  fixture.states = [];
  fixture.effects = [];
  fixture.pending = [];
  inspect.mockReset();
  inspect.mockResolvedValue([image(first)]);
  referenceApi.inspect = inspect;
  vi.stubGlobal('window', { api: { referenceImages: referenceApi } });
});
afterEach(() => {
  for (const effect of fixture.effects) effect.cleanup?.();
  vi.unstubAllGlobals();
});

describe('жизненный цикл проверки выбранных опор', () => {
  it('перехватывает отсутствие метода preload и повтор без синхронного падения эффекта', async () => {
    // Удаляем именно метод переданного preload: подмена отклонённым Promise скрыла бы исходную ошибку.
    delete referenceApi.inspect;
    expect(() => RenderHook([first])).not.toThrow();
    await settle();
    const failed = RenderHook([first]);
    expect(failed).toMatchObject({
      ready: false,
      loading: false,
      restartRequired: true,
      error: sourcesTexts.referenceSupportsRestartRequired,
      input: { images: [] },
      notes: ''
    });
    failed.retry();
    expect(() => RenderHook([first])).not.toThrow();
    await settle();
    expect(RenderHook([first])).toMatchObject({
      ready: false,
      loading: false,
      restartRequired: true,
      error: sourcesTexts.referenceSupportsRestartRequired,
      input: { images: [] }
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('после успешной проверки убирает прежний снимок, если метод исчез перед retry', async () => {
    RenderHook([first]);
    await settle();
    const ready = RenderHook([first]);
    expect(ready.ready).toBe(true);
    expect(ready.input.images).toHaveLength(1);
    delete referenceApi.inspect;
    ready.retry();
    expect(() => RenderHook([first])).not.toThrow();
    await settle();
    expect(RenderHook([first])).toMatchObject({
      ready: false,
      loading: false,
      restartRequired: true,
      error: sourcesTexts.referenceSupportsRestartRequired,
      input: { images: [] },
      notes: ''
    });
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('перехватывает синхронную ошибку существующего метода как ошибку чтения', async () => {
    inspect.mockImplementationOnce(() => {
      throw new Error('Опора повреждена');
    });
    expect(() => RenderHook([first])).not.toThrow();
    await settle();
    expect(RenderHook([first])).toMatchObject({
      ready: false,
      loading: false,
      restartRequired: false,
      error: 'Опора повреждена',
      input: { images: [] }
    });
  });

  it('снимает ошибку отсутствующего метода при смене выбора и успешно проверяет новые опоры', async () => {
    delete referenceApi.inspect;
    expect(() => RenderHook([first])).not.toThrow();
    await settle();
    expect(RenderHook([first]).restartRequired).toBe(true);
    referenceApi.inspect = inspect;
    const current = deferred();
    inspect.mockReturnValueOnce(current.promise);
    expect(RenderHook([second])).toMatchObject({ ready: false, loading: true, error: null, restartRequired: false, input: { images: [] } });
    current.resolve([image(second, 'b'.repeat(64))]);
    await settle();
    expect(RenderHook([second])).toMatchObject({ ready: true, loading: false, error: null, restartRequired: false });
  });

  it('поздняя ошибка прежнего выбора не заменяет успешный результат текущего', async () => {
    const old = deferred();
    const current = deferred();
    inspect.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    RenderHook([first]);
    RenderHook([second]);
    current.resolve([image(second, 'b'.repeat(64))]);
    await settle();
    expect(RenderHook([second]).ready).toBe(true);
    old.reject(new Error('Старый файл больше недоступен'));
    await settle();
    expect(RenderHook([second])).toMatchObject({
      ready: true,
      loading: false,
      error: null,
      restartRequired: false,
      input: { images: [{ path: second.path, label: second.label, sha256: 'b'.repeat(64) }] }
    });
  });

  it('игнорирует поздний ответ прежнего выбора и ждёт проверку текущего списка', async () => {
    const old = deferred();
    const current = deferred();
    inspect.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    expect(RenderHook([first]).ready).toBe(false);
    expect(RenderHook([second]).ready).toBe(false);
    old.resolve([image(first)]);
    await settle();
    const waiting = RenderHook([second]);
    expect(waiting.ready).toBe(false);
    expect(waiting.loading).toBe(true);
    expect(waiting.input.images).toEqual([]);
    expect(waiting.notes).toBe('');
    current.resolve([image(second, 'b'.repeat(64))]);
    await settle();
    const ready = RenderHook([second]);
    expect(ready.ready).toBe(true);
    expect(ready.input.images).toEqual([{ path: second.path, label: second.label, sha256: 'b'.repeat(64) }]);
    expect(ready.notes).toContain(second.note);
    expect(ready.notes).not.toContain(first.note);
  });

  it('немедленно снимает готовность после смены уже проверенной опоры', async () => {
    RenderHook([first]);
    await settle();
    expect(RenderHook([first]).ready).toBe(true);
    const next = deferred();
    inspect.mockReturnValueOnce(next.promise);
    const changed = RenderHook([second]);
    expect(changed.ready).toBe(false);
    expect(changed.loading).toBe(true);
    expect(changed.input.images).toEqual([]);
    expect(changed.notes).toBe('');
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('показывает ошибку проверки и повторяет чтение только по retry', async () => {
    inspect.mockRejectedValueOnce(new Error('Опора недоступна'));
    RenderHook([first]);
    await settle();
    const failed = RenderHook([first]);
    expect(failed).toMatchObject({ ready: false, loading: false, error: 'Опора недоступна', restartRequired: false, input: { images: [] } });
    RenderHook([first]);
    expect(inspect).toHaveBeenCalledTimes(1);
    const retry = deferred();
    inspect.mockReturnValueOnce(retry.promise);
    failed.retry();
    expect(RenderHook([first])).toMatchObject({ ready: false, loading: true, error: null });
    expect(inspect).toHaveBeenCalledTimes(2);
    retry.resolve([image(first)]);
    await settle();
    expect(RenderHook([first])).toMatchObject({ ready: true, loading: false, error: null });
  });

  it.each([
    { enabled: false, options: [first] },
    { enabled: true, options: [] },
    { enabled: false, options: [] }
  ])('не читает изображения при enabled=$enabled и числе опор $options.length', ({ enabled, options }) => {
    const value = RenderHook(options, enabled);
    expect(inspect).not.toHaveBeenCalled();
    expect(value).toMatchObject({ ready: true, loading: false, error: null, notes: '', input: { images: [] } });
  });

  it('исключает примечания из inspect и входа генерации, сохраняя SHA проверенных байтов', async () => {
    const sha256 = 'c'.repeat(64);
    inspect.mockResolvedValueOnce([image(first, sha256)]);
    RenderHook([first]);
    expect(inspect).toHaveBeenCalledExactlyOnceWith({ images: [{ path: first.path, label: first.label }] });
    await settle();
    const value = RenderHook([first]);
    expect(value.input).toEqual({ images: [{ path: first.path, label: first.label, sha256 }] });
    expect(JSON.stringify(value.input)).not.toContain(first.note);
    expect(value.notes).toContain(first.note);
  });

  it('обновляет примечание без повторного чтения тех же байтов', async () => {
    RenderHook([first]);
    await settle();
    const before = RenderHook([first]);
    const changed = { ...first, note: 'Сохранить новую деталь одежды' };
    const after = RenderHook([changed]);
    expect(after.ready).toBe(true);
    expect(after.input).toEqual(before.input);
    expect(after.notes).toContain(changed.note);
    expect(after.notes).not.toContain(first.note);
    expect(inspect).toHaveBeenCalledTimes(1);
  });
});
