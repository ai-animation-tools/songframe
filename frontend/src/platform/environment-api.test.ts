/**
 * Адаптер групп environment и media: методы перенесены в Go (этап 45), события прогресса проверки
 * среды относятся к своему вызову по requestId, необязательные поля строк не появляются пустыми
 * ключами, адрес входа приходит событием environment:loginUrl. Bindings подменяются целиком.
 */
import { describe, expect, it } from 'vitest';
import { createApi, methodAvailability, type Bindings, type EventSource } from './api';

type Listener = (event: { data: unknown }) => void;

function bindings(services: { environment?: Record<string, unknown>; media?: Record<string, unknown> }, events: EventSource): Bindings {
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
    scenarioWorkflow: missing,
    productionWorkflow: missing,
    environment: services.environment ? async () => services.environment as never : missing,
    media: services.media ? async () => services.media as never : missing,
    production: missing,
    dashboard: missing,
    animatic: missing,
    events
  } as Bindings;
}

function eventHub() {
  const listeners = new Map<string, Set<Listener>>();
  const events: EventSource = async () => ({
    on: (name, listener) => {
      const set = listeners.get(name) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(name, set);
      return () => set.delete(listener);
    }
  });
  const emit = (name: string, data: unknown) => {
    for (const listener of listeners.get(name) ?? []) listener({ data });
  };
  const count = (name: string) => listeners.get(name)?.size ?? 0;
  return { events, emit, count };
}

const row = {
  id: 'git',
  label: 'Git',
  ok: false,
  detail: 'Ожидание проверки',
  hint: 'подсказка',
  productionOnly: true,
  status: 'pending',
  external: true
};

describe('environment', () => {
  it('методы доступны', () => {
    for (const method of [
      'environment.check',
      'environment.providerAuth',
      'environment.loginProvider',
      'environment.cancelLogin',
      'environment.onLoginUrl',
      'media.capabilities'
    ] as const)
      expect(methodAvailability(method).available).toBe(true);
  });

  it('прогресс относится к своему вызову и подписка снимается после ответа', async () => {
    const hub = eventHub();
    const api = createApi(
      bindings(
        {
          environment: {
            Check: async (requestId: string) => {
              hub.emit('environment:progress', { requestId: 'чужой', check: { ...row, label: 'чужая' } });
              hub.emit('environment:progress', { requestId, check: row });
              return [{ ...row, status: 'done', ok: true, detail: 'git version 2.43.0', elapsedMs: 4 }];
            }
          }
        },
        hub.events
      )
    );
    const progress: unknown[] = [];
    const result = await api.environment.check((check) => progress.push(check));
    expect(progress).toEqual([row]);
    expect(result).toEqual([{ ...row, status: 'done', ok: true, detail: 'git version 2.43.0', elapsedMs: 4 }]);
    expect(hub.count('environment:progress')).toBe(0);
  });

  it('вход, отмена, адрес авторизации и состояние входа', async () => {
    const hub = eventHub();
    const calls: string[] = [];
    const api = createApi(
      bindings(
        {
          environment: {
            ProviderAuth: async (provider: string) => (calls.push(`auth ${provider}`), { status: 'authenticated' }),
            LoginProvider: async (provider: string) => {
              hub.emit('environment:loginUrl', { provider, url: 'https://example.test/authorize' });
              return { ok: true, message: 'Вход выполнен.' };
            },
            CancelLogin: async (provider: string) => void calls.push(`cancel ${provider}`)
          }
        },
        hub.events
      )
    );
    const urls: unknown[] = [];
    const off = api.environment.onLoginUrl((value) => urls.push(value));
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(api.environment.providerAuth('kling')).resolves.toEqual({ status: 'authenticated' });
    await expect(api.environment.loginProvider('kling')).resolves.toEqual({ ok: true, message: 'Вход выполнен.' });
    await api.environment.cancelLogin('kling');
    off();
    expect(urls).toEqual([{ provider: 'kling', url: 'https://example.test/authorize' }]);
    expect(calls).toEqual(['auth kling', 'cancel kling']);
  });

  it('возможности медиа передают объявления моделей как есть', async () => {
    const caps = {
      provider: 'test',
      kind: 'image',
      available: true,
      checkedAt: '2026-11-04T00:00:00.000Z',
      models: [{ id: 'm', command: 'text_to_image', arguments: { aspect_ratio: { allowed: ['16:9'] } }, slots: {}, limits: {} }],
      problems: [],
      generationVerified: false
    };
    const api = createApi(bindings({ media: { Capabilities: async () => caps } }, eventHub().events));
    await expect(api.media.capabilities('/клип', 'image', 'test')).resolves.toEqual(caps);
  });
});
