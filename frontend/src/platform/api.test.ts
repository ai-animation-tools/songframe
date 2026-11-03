/**
 * Наблюдаемые гарантии адаптера window.api: настоящие ответы bindings без подмены, явный отказ
 * неперенесённых методов, перевод ошибок Go/транспорта и ограничение ожидания. Bindings Wails
 * подменяются целиком: runtime и Go-сервис не запускаются.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '@shared/types';
import { platformTexts } from '@shared/texts/platform';
import { ApiError, createApi, methodAvailability, withDeadline, type Bindings } from './api';

const state: AppState = { packaged: true, problems: [], toolsRoot: null, localDir: '/isolated/profile', current: null, history: [], platform: 'linux' };

/** Минимальные bindings: каждый тест задаёт только нужные сервисы, остальные при обращении падают. */
function bindings(
  overrides: {
    State?: () => Promise<unknown>;
    FileBase?: () => Promise<string>;
    on?: (name: string, listener: (event: { data: unknown }) => void) => () => void;
  } = {}
) {
  const service = (methods: Record<string, unknown>) => async () => methods as never;
  const missing = async () => {
    throw new Error('binding не настроен в тесте');
  };
  const b: Bindings = {
    app: service({ State: overrides.State ?? (async () => state), FrontendReady: async () => undefined }),
    shell: service({ FileBase: overrides.FileBase ?? (async () => 'http://127.0.0.1:4100') }),
    native: missing,
    components: missing,
    jobs: missing,
    projects: missing,
    timing: missing,
    events: async () => ({ on: overrides.on ?? (() => () => undefined) })
  } as Bindings;
  return b;
}

describe('Граница window.api', () => {
  afterEach(() => vi.useRealTimers());

  it('возвращает снимок Go без изменения null и массивов и включает fileUrl после первого app.state', async () => {
    const read = vi.fn(async () => structuredClone(state));
    const api = createApi(bindings({ State: read }));
    expect(() => api.shell.fileUrl('/file')).toThrow(ApiError);
    await expect(api.app.state()).resolves.toStrictEqual(state);
    expect(read).toHaveBeenCalledOnce();
    expect(api.shell.fileUrl('/клип/трек 1.mp3')).toBe('http://127.0.0.1:4100/file/%D0%BA%D0%BB%D0%B8%D0%BF/%D1%82%D1%80%D0%B5%D0%BA%201.mp3');
  });

  it('отвергает неперенесённое платное действие до обращения к bindings', async () => {
    const read = vi.fn(async () => state);
    const api = createApi(bindings({ State: read }));
    await expect(api.production.submit('/project', 'package', 'sha')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      method: 'production.submit',
      message: platformTexts.unavailable
    });
    expect(read).not.toHaveBeenCalled();
    expect(methodAvailability('production.submit')).toEqual({ available: false, reason: platformTexts.unavailable });
    expect(methodAvailability('app.state')).toEqual({ available: true, reason: null });
  });

  it('синхронный неперенесённый метод бросает ApiError, подписка неперенесённой области — пустая отписка', () => {
    const api = createApi(bindings());
    expect(() => api.montageWindow.send({ type: 'ready' })).toThrow(ApiError);
    const unsubscribe = api.montageWindow.onClosed(() => undefined);
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
  });

  it('сохраняет причину ошибки Go-сервиса и отдельно сообщает о сбое связи', async () => {
    const serviceError = Object.assign(new Error('Не удалось подготовить папку состояния: путь занят файлом.'), { name: 'RuntimeError' });
    const failing = createApi(bindings({ State: async () => Promise.reject(serviceError) }));
    await expect(failing.app.state()).rejects.toMatchObject({ code: 'SERVICE_FAILED', message: serviceError.message });
    const offline = createApi(bindings({ State: async () => Promise.reject(new TypeError('Failed to fetch')) }));
    await expect(offline.app.state()).rejects.toMatchObject({ code: 'CONNECTION_FAILED', message: platformTexts.connectionFailed });
  });

  it('ошибка чтения не запоминается: повтор может завершиться успешно', async () => {
    const read = vi.fn<() => Promise<unknown>>().mockRejectedValueOnce(new Error('нет доступа')).mockResolvedValueOnce(state);
    const api = createApi(bindings({ State: read }));
    await expect(api.app.state()).rejects.toBeInstanceOf(ApiError);
    await expect(api.app.state()).resolves.toEqual(state);
  });

  it('переводит событие нативного drop в контракт onFilesDropped и отбрасывает события после отписки', async () => {
    let emit: (event: { data: unknown }) => void = () => undefined;
    const api = createApi(bindings({ on: (_name, listener) => ((emit = listener), () => undefined) }));
    const listener = vi.fn();
    const unsubscribe = api.shell.onFilesDropped(listener);
    // Подписка ставится после отложенного import runtime: ждём один оборот очереди.
    await new Promise((resolve) => setTimeout(resolve, 0));
    emit({ data: { targetID: 'drop-1', paths: ['/диск/трек.mp3'] } });
    expect(listener).toHaveBeenCalledWith({ targetId: 'drop-1', paths: ['/диск/трек.mp3'] });
    unsubscribe();
    emit({ data: { targetID: 'drop-1', paths: [] } });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('ограничивает ожидание потерянного ответа и снимает таймер после успеха', async () => {
    vi.useFakeTimers();
    const pending = withDeadline(() => new Promise<never>(() => undefined), 'app.state', 20);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    await expect(withDeadline(async () => state, 'app.state', 20)).resolves.toEqual(state);
    expect(vi.getTimerCount()).toBe(0);
  });
});
