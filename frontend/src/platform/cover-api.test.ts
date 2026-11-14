/**
 * Адаптер групп cover и referenceImages: методы вызывают Go, ответ Go проходит без
 * ручной проверки, а необязательный SHA опоры не превращается в пустой ключ.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CoverGenerationSession } from '@shared/cover-generation';
import { createApi, type Bindings } from './api';

function bindings(cover: Record<string, unknown>, referenceImages: Record<string, unknown> = {}): Bindings {
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
    cover: async () => cover as never,
    referenceImages: async () => referenceImages as never,
    environment: missing,
    media: missing,
    scenarioWorkflow: missing,
    productionWorkflow: missing,
    production: missing,
    dashboard: missing,
    animatic: missing,
    promptLog: missing,
    projectHistory: missing,
    montage: missing,
    montageWindow: missing,
    derivedShots: missing,
    updates: missing,
    events: async () => ({ on: () => () => undefined })
  } as Bindings;
}

const session: CoverGenerationSession = {
  id: 'session-1',
  prompt: 'Обложка с лодкой.',
  referenceImages: [{ path: '/tmp/songframe-cover-1/references/R001.png', label: 'Лодка', sha256: 'a'.repeat(64), bytes: 120 }],
  status: 'idle',
  image: null,
  error: null,
  provider: 'test',
  model: null,
  preparing: false,
  requestSha: 'b'.repeat(64),
  approvalToken: 'token-1',
  quote: { credits: 3, balance: 100, verdict: 'ok' }
};

describe('window.api.cover и window.api.referenceImages', () => {
  it('передаёт сессии, согласие и квадрат обложки как есть', async () => {
    const service = {
      Inspect: vi.fn(async () => session.referenceImages),
      Create: vi.fn(async (_project: string, _prompt: string, _input: { images: object[] } | null) => session),
      Prepare: vi.fn(async () => ({ ...session, preparing: false })),
      Generate: vi.fn(async () => ({ ...session, status: 'generating', requestSha: null, approvalToken: null })),
      View: vi.fn(async () => session),
      Accept: vi.fn(async () => ({ id: 'session-1', path: '/tmp/songframe-cover-1/accepted.png' })),
      Close: vi.fn(async () => undefined)
    };
    const api = createApi(bindings(service));
    const input = { images: [{ path: '/клип/source/boat.png', label: 'Лодка' }] };
    await expect(api.cover.inspect(input)).resolves.toEqual(session.referenceImages);
    await expect(api.cover.create('/клип', 'Обложка с лодкой.', input)).resolves.toEqual(session);
    expect(service.Create).toHaveBeenCalledWith('/клип', 'Обложка с лодкой.', { images: [{ path: '/клип/source/boat.png', label: 'Лодка' }] });
    expect(Object.keys(service.Create.mock.calls[0]?.[2]?.images[0] ?? {})).toEqual(['path', 'label']);
    await api.cover.create('/клип', 'Без опор.');
    expect(service.Create).toHaveBeenLastCalledWith('/клип', 'Без опор.', null);
    await expect(api.cover.prepare('session-1')).resolves.toMatchObject({ quote: { verdict: 'ok' } });
    const approval = { approvalToken: 'token-1', promptConfirmed: true as const, allowUnknownCost: true };
    await expect(api.cover.generate('session-1', 'b'.repeat(64), approval)).resolves.toMatchObject({ status: 'generating' });
    expect(service.Generate).toHaveBeenCalledWith('session-1', 'b'.repeat(64), approval);
    await expect(api.cover.accept('session-1', { x: 0, y: 0, size: 10 })).resolves.toEqual({ id: 'session-1', path: '/tmp/songframe-cover-1/accepted.png' });
    expect(service.Accept).toHaveBeenCalledWith('session-1', { x: 0, y: 0, size: 10 });
    await api.cover.close('session-1');
    expect(service.Close).toHaveBeenCalledWith('session-1');
  });

  it('референс: SHA опоры, контекст без черновиков, приёмка и привязка', async () => {
    const reference = {
      Create: vi.fn(async () => session),
      Context: vi.fn(async () => ({ clipName: 'Клип', idea: '', lyrics: '', visualStyle: '' })),
      Accept: vi.fn(async () => ({ id: 'session-1', path: '/клип/plan/reference-images/session-1/image-jobs/a/out.png', prompt: 'Лодка' })),
      Attach: vi.fn(async () => undefined)
    };
    const api = createApi(bindings({}, reference));
    await api.referenceImages.create('/клип', 'Лодка', { images: [{ path: '/клип/source/boat.png', label: 'Лодка', sha256: 'c'.repeat(64) }] });
    expect(reference.Create).toHaveBeenCalledWith('/клип', 'Лодка', { images: [{ path: '/клип/source/boat.png', label: 'Лодка', sha256: 'c'.repeat(64) }] });
    await expect(api.referenceImages.context('/клип')).resolves.toEqual({ clipName: 'Клип', idea: '', lyrics: '', visualStyle: '' });
    expect(reference.Context).toHaveBeenCalledWith('/клип', null);
    await api.referenceImages.context('/клип', { idea: '' });
    expect(reference.Context).toHaveBeenLastCalledWith('/клип', { idea: '' });
    await expect(api.referenceImages.accept('session-1')).resolves.toMatchObject({ prompt: 'Лодка' });
    await api.referenceImages.attach('session-1', 'boat');
    expect(reference.Attach).toHaveBeenCalledWith('session-1', 'boat');
  });

  it('показывает отказ Go своим текстом и не ограничивает подготовку сроком оболочки', async () => {
    vi.useFakeTimers();
    try {
      let finish: (value: CoverGenerationSession) => void = () => undefined;
      const api = createApi(bindings({ Prepare: () => new Promise((resolve) => (finish = resolve)) }));
      const pending = api.cover.prepare('session-1');
      await vi.advanceTimersByTimeAsync(60_000);
      finish(session);
      await expect(pending).resolves.toEqual(session);
    } finally {
      vi.useRealTimers();
    }
    const error = Object.assign(new Error('Сессия обложки закрыта. Откройте генерацию заново.'), { name: 'RuntimeError' });
    const api = createApi(bindings({ View: async () => Promise.reject(error) }));
    await expect(api.cover.view('session-1')).rejects.toMatchObject({ code: 'SERVICE_FAILED', method: 'cover.view', message: error.message });
  });
});
