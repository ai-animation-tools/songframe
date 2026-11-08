/** Управляемые ответы проверяют границы контекста и остановку опроса без Electron и настоящего агента. */
import type * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Api } from '@shared/api';
import type { VideoReviewView } from '@shared/video-review';
import { useVideoReview } from './useVideoReview';

const fixture = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  stateIndex: 0,
  refIndex: 0,
  effects: [] as (() => (() => void) | void)[],
  notify: vi.fn(),
  state: { current: '/project' },
  describeError: (error: unknown) => (error instanceof Error ? error.message : String(error))
}));
// Жизненный цикл повторяет принятый в useProductionWorkflow.test.ts способ проверки async-границ hook.
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
  useRef: (initial: unknown) => fixture.refs[fixture.refIndex++] ?? (fixture.refs[fixture.refIndex - 1] = { current: initial }),
  useEffect: (effect: () => (() => void) | void) => {
    fixture.effects.push(effect);
  },
  useCallback: (value: unknown) => value
}));
vi.mock('../../state', () => ({ useApp: () => ({ state: fixture.state, notify: fixture.notify, describeError: fixture.describeError }) }));
const api = { view: vi.fn<Api['videoReview']['view']>(), start: vi.fn<Api['videoReview']['start']>(), cancel: vi.fn<Api['videoReview']['cancel']>() };
const idle: VideoReviewView = {
  status: 'idle',
  job: null,
  report: null,
  frames: [],
  stale: false,
  canStart: true,
  reason: null,
  error: null,
  durationSeconds: 8
};
const running: VideoReviewView = { ...idle, status: 'running', canStart: false };
const complete: VideoReviewView = { ...idle, status: 'completed', report: { schemaVersion: 1, summary: 'Сохранённый отчёт.', findings: [], limitations: [] } };
function Draw(dir = '/project/pkg-a') {
  fixture.stateIndex = fixture.refIndex = 0;
  fixture.effects = [];
  return useVideoReview(dir);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}
let cleanup: (() => void) | void;
beforeEach(() => {
  vi.useFakeTimers();
  fixture.states = [];
  fixture.refs = [];
  fixture.effects = [];
  vi.clearAllMocks();
  api.view.mockReset().mockResolvedValue(idle);
  api.start.mockReset().mockResolvedValue(running);
  api.cancel.mockReset().mockResolvedValue({ ...idle, status: 'cancelled' });
  vi.stubGlobal('window', { api: { videoReview: api } });
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function mount(dir?: string): void {
  Draw(dir);
  cleanup = fixture.effects[0]();
}

describe('чтение и опрос проверки видео', () => {
  it('показывает сохранённый отчёт и не опрашивает готовое состояние', async () => {
    api.view.mockResolvedValue(complete);
    mount();
    await settle();
    expect(Draw().view?.report?.summary).toBe('Сохранённый отчёт.');
    await vi.advanceTimersByTimeAsync(6000);
    expect(api.view).toHaveBeenCalledTimes(1);
    expect(fixture.notify).not.toHaveBeenCalled();
  });
  it('опрашивает выполняющееся задание и прекращает опрос после отчёта', async () => {
    api.view.mockResolvedValueOnce(running).mockResolvedValue(complete);
    mount();
    await settle();
    await vi.advanceTimersByTimeAsync(1500);
    expect(Draw().view?.status).toBe('completed');
    expect(api.view).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(6000);
    expect(api.view).toHaveBeenCalledTimes(2);
    expect(fixture.notify).toHaveBeenCalledWith('Отчёт проверки видео готов.', 'success');
  });
  it('оставляет актуальную ошибку чтения для явного повтора', async () => {
    api.view.mockRejectedValueOnce(new Error('Ошибка чтения.'));
    mount();
    await settle();
    expect(Draw().error).toBe('Ошибка чтения.');
    await vi.advanceTimersByTimeAsync(6000);
    expect(api.view).toHaveBeenCalledTimes(1);
    await Draw().refresh();
    expect(Draw().error).toBeNull();
    expect(Draw().view?.status).toBe('idle');
  });
  it('отмена прекращает опрос и не запускает повтор автоматически', async () => {
    api.view.mockResolvedValue(running);
    mount();
    await settle();
    await Draw().cancel();
    await vi.advanceTimersByTimeAsync(6000);
    expect(api.cancel).toHaveBeenCalledWith('/project', '/project/pkg-a');
    expect(Draw().view?.status).toBe('cancelled');
    expect(api.view).toHaveBeenCalledTimes(1);
    expect(api.start).not.toHaveBeenCalled();
  });
  it('очистка удаляет таймер и не продолжает опрос после закрытия', async () => {
    api.view.mockResolvedValue(running);
    mount();
    await settle();
    cleanup?.();
    cleanup = undefined;
    await vi.advanceTimersByTimeAsync(6000);
    expect(api.view).toHaveBeenCalledTimes(1);
  });
});

describe('поздние ответы проверки видео', () => {
  it.each(['success', 'error'] as const)('игнорирует поздний %s чтения предыдущего пакета', async (outcome) => {
    const old = deferred<VideoReviewView>();
    api.view.mockReturnValueOnce(old.promise).mockResolvedValue(complete);
    mount();
    cleanup?.();
    mount('/project/pkg-b');
    await settle();
    if (outcome === 'success') old.resolve({ ...idle, error: 'Старый пакет.' });
    else old.reject(new Error('Старый пакет.'));
    await settle();
    expect(Draw('/project/pkg-b').view?.status).toBe('completed');
    expect(Draw('/project/pkg-b').error).toBeNull();
  });
  it('игнорирует позднюю ошибку опроса после новой команды того же пакета', async () => {
    api.view.mockResolvedValueOnce(running);
    const old = deferred<VideoReviewView>();
    api.view.mockReturnValueOnce(old.promise);
    mount();
    await settle();
    await vi.advanceTimersByTimeAsync(1500);
    await Draw().cancel();
    old.reject(new Error('Старая ошибка опроса.'));
    await settle();
    expect(Draw().error).toBeNull();
    expect(Draw().view?.status).toBe('cancelled');
  });
  it('ответ запуска предыдущего пакета не меняет текущий отчёт или pending', async () => {
    const old = deferred<VideoReviewView>();
    api.start.mockReturnValueOnce(old.promise);
    mount();
    await settle();
    const operation = Draw().start();
    cleanup?.();
    api.view.mockResolvedValue(complete);
    mount('/project/pkg-b');
    await settle();
    old.resolve(running);
    await operation;
    expect(Draw('/project/pkg-b').view?.status).toBe('completed');
    expect(Draw('/project/pkg-b').pending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('ручное перечитывание статуса проверки', () => {
  it('перечитывает сохранённый failed только через view и сообщает о результате без нового запуска', async () => {
    const failed: VideoReviewView = { ...idle, status: 'failed', error: 'Прежняя ошибка агента.' };
    api.view.mockResolvedValue(failed);
    mount();
    await settle();
    expect(fixture.notify).not.toHaveBeenCalled();
    const reading = deferred<VideoReviewView>();
    api.view.mockReturnValueOnce(reading.promise);
    const refresh = Draw().refresh();
    expect(Draw().pending).toBe(true);
    expect(Draw().refreshing).toBe(true);
    await Draw().refresh();
    await Draw().start();
    await Draw().cancel();
    expect(api.view).toHaveBeenCalledTimes(2);
    expect(api.start).not.toHaveBeenCalled();
    expect(api.cancel).not.toHaveBeenCalled();
    reading.resolve(failed);
    await refresh;
    expect(Draw().view).toEqual(failed);
    expect(Draw().error).toBeNull();
    expect(Draw().pending).toBe(false);
    expect(Draw().refreshing).toBe(false);
    expect(fixture.notify).toHaveBeenCalledExactlyOnceWith('Статус перечитан. Для нового анализа нажмите «Проверить заново».', 'info');
  });
  it('оставляет ошибку ручного чтения видимой и разрешает повтор', async () => {
    mount();
    await settle();
    api.view.mockRejectedValueOnce(new Error('Файл статуса недоступен.'));
    await Draw().refresh();
    expect(Draw().error).toBe('Файл статуса недоступен.');
    expect(Draw().pending).toBe(false);
    expect(Draw().refreshing).toBe(false);
    expect(fixture.notify).toHaveBeenCalledWith('Файл статуса недоступен.', 'error');
    await Draw().refresh();
    expect(Draw().error).toBeNull();
    expect(fixture.notify).toHaveBeenLastCalledWith('Статус проверки перечитан.', 'info');
    expect(api.start).not.toHaveBeenCalled();
  });
  it('не добавляет подтверждения ручного чтения к первому снимку или фоновому опросу', async () => {
    api.view.mockResolvedValue(running);
    mount();
    await settle();
    await vi.advanceTimersByTimeAsync(4500);
    expect(api.view).toHaveBeenCalledTimes(4);
    expect(fixture.notify).not.toHaveBeenCalled();
    expect(Draw().pending).toBe(false);
    expect(Draw().refreshing).toBe(false);
  });
  it('не запускает чтение параллельно команде агента', async () => {
    mount();
    await settle();
    const starting = deferred<VideoReviewView>();
    api.start.mockReturnValueOnce(starting.promise);
    const start = Draw().start();
    await Draw().refresh();
    expect(api.view).toHaveBeenCalledTimes(1);
    expect(Draw().pending).toBe(true);
    expect(Draw().refreshing).toBe(false);
    starting.resolve(running);
    await start;
    expect(Draw().pending).toBe(false);
    expect(fixture.notify).not.toHaveBeenCalled();
  });
  it.each(['success', 'error'] as const)('поздний %s ручного чтения прежнего пакета не гасит новую загрузку и не уведомляет', async (outcome) => {
    mount();
    await settle();
    const old = deferred<VideoReviewView>();
    api.view.mockReturnValueOnce(old.promise);
    const oldRefresh = Draw().refresh();
    cleanup?.();
    mount('/project/pkg-b');
    await settle();
    const latest = deferred<VideoReviewView>();
    api.view.mockReturnValueOnce(latest.promise);
    const latestRefresh = Draw('/project/pkg-b').refresh();
    if (outcome === 'success') old.resolve({ ...idle, status: 'failed' });
    else old.reject(new Error('Ошибка прежнего пакета.'));
    await oldRefresh;
    expect(Draw('/project/pkg-b').pending).toBe(true);
    expect(Draw('/project/pkg-b').refreshing).toBe(true);
    expect(Draw('/project/pkg-b').error).toBeNull();
    expect(fixture.notify).not.toHaveBeenCalled();
    latest.resolve(idle);
    await latestRefresh;
    expect(Draw('/project/pkg-b').pending).toBe(false);
    expect(fixture.notify).toHaveBeenCalledExactlyOnceWith('Статус проверки перечитан.', 'info');
  });
  it('не показывает подтверждение и не ставит таймер после закрытия во время ручного чтения', async () => {
    mount();
    await settle();
    const reading = deferred<VideoReviewView>();
    api.view.mockReturnValueOnce(reading.promise);
    const refresh = Draw().refresh();
    cleanup?.();
    cleanup = undefined;
    reading.resolve(running);
    await refresh;
    expect(fixture.notify).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
