/**
 * Наблюдаемые гарантии адаптера window.api: настоящие ответы bindings без подмены, подключение
 * каждого метода контракта, перевод ошибок Go/транспорта и ограничение ожидания. Bindings Wails
 * подменяются целиком: runtime и Go-сервис не запускаются.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '@shared/types';
import { platformTexts } from '@shared/texts/platform';
import { ApiError, createApi, undefinedPaths, withDeadline, type Bindings } from './api';
import { apiSkeleton, isApiStub } from './api-skeleton';

const state: AppState = { packaged: true, problems: [], localDir: '/isolated/profile', current: null, history: [], platform: 'linux' };

/** Минимальные bindings: каждый тест задаёт только нужные сервисы, остальные при обращении падают. */
function bindings(
  overrides: {
    State?: () => Promise<unknown>;
    FileBase?: () => Promise<string>;
    on?: (name: string, listener: (event: { data: unknown }) => void) => () => void;
    projects?: Record<string, unknown>;
    sources?: Record<string, unknown>;
    animatic?: Record<string, unknown>;
    checks?: Record<string, unknown>;
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
    projects: overrides.projects ? service(overrides.projects) : missing,
    timing: missing,
    sources: overrides.sources ? service(overrides.sources) : missing,
    cast: missing,
    scenario: missing,
    tools: missing,
    checks: overrides.checks ? service(overrides.checks) : missing,
    agents: missing,
    ai: missing,
    scenarioWorkflow: missing,
    productionWorkflow: missing,
    videoReview: missing,
    cover: missing,
    referenceImages: missing,
    environment: missing,
    media: missing,
    production: missing,
    dashboard: missing,
    animatic: overrides.animatic ? service(overrides.animatic) : missing,
    promptLog: missing,
    montage: missing,
    montageWindow: missing,
    derivedShots: missing,
    updates: missing,
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

  it('подключает к bindings каждый метод каркаса без обращения к сервисам', () => {
    const skeleton = apiSkeleton();
    const api = createApi(bindings());
    const stubs: string[] = [];
    let methods = 0;
    for (const [group, members] of Object.entries(skeleton)) {
      for (const name of Object.keys(members)) {
        methods += 1;
        expect(isApiStub((skeleton as unknown as Record<string, Record<string, unknown>>)[group][name])).toBe(true);
        if (isApiStub((api as unknown as Record<string, Record<string, unknown>>)[group][name])) stubs.push(`${group}.${name}`);
      }
    }
    expect(methods).toBeGreaterThan(100);
    expect(stubs).toEqual([]);
    // Заглушка — ошибка программиста, а не отказ Go-сервиса: её не спутать с ApiError.
    expect(() => skeleton.app.state()).toThrow(/app\.state не подключён/);
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

  it('передаёт сброс полей generation (undefined) списком путей, а не теряет его в JSON', async () => {
    const saved = { agentInstructions: '', name: 'Клип', animaticVideo: 'klip.mp4', generation: null };
    const SaveSettings = vi.fn(async () => saved);
    const api = createApi(bindings({ projects: { SaveSettings } }));
    const generation = { video: null, image: { provider: 'test', model: undefined, options: { a: 1, b: undefined } } };
    await expect(api.projects.saveSettings('/клип', { name: 'Клип', animaticVideo: 'klip.mp4', generation })).resolves.toEqual(saved);
    expect(SaveSettings).toHaveBeenCalledWith('/клип', {
      name: 'Клип',
      animaticVideo: 'klip.mp4',
      generation,
      unset: [
        ['image', 'model'],
        ['image', 'options', 'b']
      ]
    });
    expect(undefinedPaths([undefined])).toEqual([]);
    expect(undefinedPaths(null)).toEqual([]);
  });

  it('отдаёт опись исходников и настройки проекта как прочитанный JSON', async () => {
    const manifest = { schema_version: 1, track: null, lyrics: null, idea: null, cover: null, references: [], updated_at: 'x' };
    const view = { manifest, lyricsText: '', ideaText: '', coverPath: null, referenceFilePaths: {}, problems: [] };
    const api = createApi(bindings({ sources: { View: async () => view } }));
    await expect(api.sources.view('/клип')).resolves.toStrictEqual(view);
  });

  it('передаёт аниматик и пробы стыков в Go без изменения данных', async () => {
    const view = { built: null, shots: [], approval: { status: 'review', approvedSha256: null, current: false }, cardsFresh: true, problems: [] };
    const calls: unknown[][] = [];
    const api = createApi(
      bindings({
        animatic: {
          View: async (...args: unknown[]) => (calls.push(['view', ...args]), view),
          SetStatus: async (...args: unknown[]) => (calls.push(['status', ...args]), view)
        },
        checks: { ListReviews: async (...args: unknown[]) => (calls.push(['reviews', ...args]), []) }
      })
    );
    await expect(api.animatic.view('/клип')).resolves.toStrictEqual(view);
    await expect(api.animatic.setStatus('/клип', 'approved')).resolves.toStrictEqual(view);
    await expect(api.checks.listReviews('/клип')).resolves.toStrictEqual([]);
    expect(calls).toEqual([
      ['view', '/клип'],
      ['status', '/клип', 'approved'],
      ['reviews', '/клип']
    ]);
  });
});
