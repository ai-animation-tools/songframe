/**
 * Адаптер групп agents и ai: методы перенесены в Go (этап 44), ответы Go проходят без ручной
 * проверки, необязательный diagnostic задания не появляется пустым ключом, отказ Go показывается
 * своим текстом, события приходят из Wails-события agents:event. Bindings подменяются целиком.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/agents';
import { createApi, type Bindings, type EventSource } from './api';

function bindings(services: { agents?: Record<string, unknown>; ai?: Record<string, unknown> }, events?: EventSource): Bindings {
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
    agents: services.agents ? async () => services.agents as never : missing,
    ai: services.ai ? async () => services.ai as never : missing,
    videoReview: missing,
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
    events: events ?? (async () => ({ on: () => () => undefined }))
  } as Bindings;
}

const job = {
  schemaVersion: 1,
  id: 'job-1',
  project: '/клип',
  task: 'scenario',
  provider: 'codex',
  model: '',
  permissions: 'read-only',
  status: 'running',
  phase: 'Запущено',
  startedAt: '2026-11-04T09:00:00.000Z',
  log: '',
  output: null,
  error: null,
  exitCode: null
};

describe('window.api.agents', () => {
  it('передаёт настройки и ответы Go без изменений', async () => {
    const settings = { provider: 'claude', model: 'opus' } as const;
    const service = {
      GetSettings: vi.fn(async () => null),
      GetProviderSettings: vi.fn(async () => settings),
      SaveProviderSettings: vi.fn(async (value: unknown) => value),
      SaveSettings: vi.fn(async (value: unknown) => value),
      Check: vi.fn(async () => ({ availability: 'available', authorization: 'authenticated', message: 'ok', version: '2.1.5' })),
      Models: vi.fn(async () => ({ models: [{ id: 'opus', label: 'Opus' }] })),
      Account: vi.fn(async () => ({
        provider: 'claude',
        checkedAt: '2026-11-04T09:00:00.000Z',
        diagnostic: { availability: 'available', authorization: 'unknown', message: '' },
        email: null,
        organization: null,
        authenticationMethod: null,
        plan: null,
        subscriptionStatus: null,
        subscriptionExpiresAt: null,
        limits: null,
        credits: null
      }))
    };
    const api = createApi(bindings({ agents: service }));
    await expect(api.agents.getSettings()).resolves.toBeNull();
    await expect(api.agents.getProviderSettings('claude')).resolves.toEqual(settings);
    expect(service.GetProviderSettings).toHaveBeenCalledWith('claude');
    await expect(api.agents.saveProviderSettings(settings)).resolves.toEqual(settings);
    await expect(api.agents.saveSettings(null)).resolves.toBeNull();
    expect(service.SaveSettings).toHaveBeenCalledWith(null);
    await expect(api.agents.check(settings)).resolves.toMatchObject({ availability: 'available', version: '2.1.5' });
    await expect(api.agents.models({ provider: 'claude' })).resolves.toEqual({ models: [{ id: 'opus', label: 'Opus' }] });
    await expect(api.agents.account(settings)).resolves.toMatchObject({ provider: 'claude', limits: null, diagnostic: { authorization: 'unknown' } });
  });

  it('задания: diagnostic только при наличии, list без проекта передаёт null', async () => {
    const service = {
      Start: vi.fn(async () => job),
      Cancel: vi.fn(async () => ({ ...job, status: 'cancelled', diagnostic: 'cancelled' })),
      Get: vi.fn(async (id: string) => (id === 'job-1' ? job : null)),
      List: vi.fn(async () => [job])
    };
    const api = createApi(bindings({ agents: service }));
    const started = await api.agents.start({ project: '/клип', task: 'scenario', prompt: 'p' });
    expect(started).toEqual(job);
    expect('diagnostic' in started).toBe(false);
    await expect(api.agents.cancel('job-1')).resolves.toMatchObject({ status: 'cancelled', diagnostic: 'cancelled' });
    await expect(api.agents.get('other')).resolves.toBeNull();
    await expect(api.agents.get('job-1')).resolves.toEqual(job);
    await api.agents.list();
    await api.agents.list('/клип');
    expect(service.List.mock.calls).toEqual([[null], ['/клип']]);
  });

  it('показывает отказ Go текстом «[КОД] причина»', async () => {
    const error = Object.assign(new Error('[AGENT_BUSY] Агент уже выполняет задание этого проекта.'), { name: 'RuntimeError' });
    const api = createApi(bindings({ agents: { Start: async () => Promise.reject(error) } }));
    await expect(api.agents.start({ project: '/клип', task: 'scenario', prompt: 'p' })).rejects.toMatchObject({
      code: 'SERVICE_FAILED',
      method: 'agents.start',
      message: error.message
    });
  });

  it('ai.access возвращает доступ исполнителей и принимает null без проекта', async () => {
    const access = {
      agent: { provider: 'codex', selected: true, available: true, message: 'ok' },
      image: { provider: null, selected: false, available: false, message: 'Сначала выберите провайдера изображений в настройках проекта.' },
      video: { provider: null, selected: false, available: false, message: 'Сначала выберите провайдера видео в настройках проекта.' }
    };
    const Access = vi.fn(async () => access);
    const api = createApi(bindings({ ai: { Access } }));
    await expect(api.ai.access(null)).resolves.toEqual(access);
    expect(Access).toHaveBeenCalledWith(null);
  });

  it('onEvent подписывается на agents:event и отписывается', async () => {
    const listeners = new Map<string, (event: { data: unknown }) => void>();
    const off = vi.fn();
    const events: EventSource = async () => ({
      on: (name, listener) => {
        listeners.set(name, listener);
        return off;
      }
    });
    const api = createApi(bindings({}, events));
    const received: AgentEvent[] = [];
    const unsubscribe = api.agents.onEvent((event) => received.push(event));
    await vi.waitFor(() => expect(listeners.has('agents:event')).toBe(true));
    const event: AgentEvent = { jobId: 'job-1', project: '/клип', sequence: 1, phase: 'Запущено', type: 'started' };
    listeners.get('agents:event')!({ data: event });
    expect(received).toEqual([event]);
    unsubscribe();
    expect(off).toHaveBeenCalled();
    listeners.get('agents:event')!({ data: event });
    expect(received).toHaveLength(1);
  });
});
