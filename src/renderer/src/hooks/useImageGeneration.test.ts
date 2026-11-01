import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReferenceImageGenerationInput } from '@shared/reference-image-generation';
import type { CoverGenerationSession } from '@shared/cover-generation';
import { useImageGeneration } from './useImageGeneration';

const fixture = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  callbacks: [] as { value: unknown; deps: readonly unknown[] }[],
  effects: [] as { deps: readonly unknown[]; cleanup?: () => void }[],
  pending: [] as (() => void)[],
  stateIndex: 0,
  refIndex: 0,
  callbackIndex: 0,
  effectIndex: 0,
  notify: vi.fn(),
  describeError: (error: unknown) => (error instanceof Error ? error.message : String(error))
}));

// Минимальный стенд исполняет реальные обработчики hook и очистку эффектов; IPC заменён управляемыми promise.
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
  useCallback: (value: unknown, deps: readonly unknown[]) => {
    const index = fixture.callbackIndex++;
    const old = fixture.callbacks[index];
    if (!old || deps.some((value, n) => !Object.is(value, old.deps[n]))) fixture.callbacks[index] = { value, deps };
    return fixture.callbacks[index].value;
  },
  useEffect: (effect: () => (() => void) | void, deps: readonly unknown[]) => {
    const index = fixture.effectIndex++;
    const old = fixture.effects[index];
    if (!old || deps.some((value, n) => !Object.is(value, old.deps[n]))) {
      fixture.pending.push(() => {
        old?.cleanup?.();
        fixture.effects[index] = { deps, cleanup: effect() ?? undefined };
      });
    }
  }
}));
vi.mock('../state', () => ({
  useApp: () => ({
    notify: fixture.notify,
    describeError: fixture.describeError,
    aiAccess: {
      agent: { provider: null, selected: false, available: false, message: '' },
      image: { provider: 'codex', selected: true, available: true, message: '' },
      video: { provider: null, selected: false, available: false, message: '' }
    }
  })
}));

const prepared: CoverGenerationSession = {
  id: 'reference-session',
  prompt: 'Герой <&>',
  status: 'idle',
  image: null,
  error: null,
  provider: 'codex',
  model: null,
  preparing: false,
  requestSha: 'sha',
  approvalToken: 'token',
  quote: null
};
const ready: CoverGenerationSession = { ...prepared, status: 'ready', image: { path: '/temporary/full.png', width: 1536, height: 1024 } };
const result = { id: prepared.id, path: '/temporary/accepted.png', prompt: prepared.prompt };
const api = {
  create: vi.fn(),
  prepare: vi.fn(),
  generate: vi.fn(),
  view: vi.fn(),
  accept: vi.fn(),
  attach: vi.fn(),
  close: vi.fn()
};
function RenderHook(mode: 'cover' | 'reference' = 'reference', input?: ReferenceImageGenerationInput) {
  fixture.stateIndex = fixture.refIndex = fixture.callbackIndex = fixture.effectIndex = 0;
  const value = useImageGeneration('/project', mode, input);
  for (const effect of fixture.pending.splice(0)) effect();
  return value;
}
function unmount() {
  for (const effect of fixture.effects) effect.cleanup?.();
}
async function prepareReady() {
  await RenderHook().start('Герой <&>');
  await RenderHook().generate({ approvalToken: 'token', promptConfirmed: true });
  return RenderHook();
}

beforeEach(() => {
  fixture.states = [];
  fixture.refs = [];
  fixture.callbacks = [];
  fixture.effects = [];
  fixture.pending = [];
  vi.clearAllMocks();
  api.create.mockResolvedValue({ ...prepared, requestSha: null, approvalToken: null });
  api.prepare.mockResolvedValue(prepared);
  api.generate.mockResolvedValue(ready);
  api.accept.mockResolvedValue(result);
  api.close.mockResolvedValue(undefined);
  vi.stubGlobal('window', { api: { referenceImages: api, cover: api } });
});

describe('жизненный цикл генерации референса', () => {
  it('инвалидация удаляет цену, токен и готовый кандидат; старые callbacks не отправляют и не принимают результат', async () => {
    const previous = await prepareReady();
    expect(previous.session?.image).toEqual(ready.image);
    expect(previous.invalidate()).toBe(true);
    expect(RenderHook().session).toBeNull();
    expect(RenderHook().preparedSha).toBeNull();
    expect(api.close).toHaveBeenCalledExactlyOnceWith('reference-session');
    const accepted = vi.fn();
    await previous.accept(null, accepted);
    await previous.generate({ approvalToken: 'token', promptConfirmed: true });
    await previous.next();
    expect(accepted).not.toHaveBeenCalled();
    expect(api.accept).not.toHaveBeenCalled();
    expect(api.generate).toHaveBeenCalledTimes(1);
    expect(api.prepare).toHaveBeenCalledTimes(1);

    const next = { ...prepared, id: 'edited-session', prompt: '  Только мой текст\n', requestSha: 'new-sha', approvalToken: 'new-token' };
    api.create.mockResolvedValue({ ...next, requestSha: null, approvalToken: null });
    api.prepare.mockResolvedValue(next);
    await RenderHook('reference', { images: [] }).start(next.prompt);
    expect(api.create).toHaveBeenLastCalledWith('/project', next.prompt, { images: [] });
    await RenderHook().generate({ approvalToken: 'token', promptConfirmed: true });
    expect(api.generate).toHaveBeenCalledTimes(1);
    await RenderHook().generate({ approvalToken: 'new-token', promptConfirmed: true });
    expect(api.generate).toHaveBeenLastCalledWith('edited-session', 'new-sha', { approvalToken: 'new-token', promptConfirmed: true });
  });

  it('не разрешает инвалидацию во время отправки или незавершённой привязки оплаченного оригинала', async () => {
    await RenderHook().start('Герой');
    let finish!: (value: CoverGenerationSession) => void;
    api.generate.mockReturnValueOnce(
      new Promise<CoverGenerationSession>((resolve) => {
        finish = resolve;
      })
    );
    const submitting = RenderHook().generate({ approvalToken: 'token', promptConfirmed: true });
    expect(RenderHook().invalidate()).toBe(false);
    finish(ready);
    await submitting;
    await RenderHook().accept(null, async () => {
      throw new Error('Привязка не сохранена');
    });
    expect(RenderHook().attachmentPending).toBe(true);
    expect(RenderHook().invalidate()).toBe(false);
    expect(api.close).not.toHaveBeenCalled();
  });

  it('передаёт текущий текст и опоры один раз; повтор готовит прежнюю сессию без новой отправки', async () => {
    const input = { images: [{ path: '/uploads/hero.png', label: 'Анфас' }] };
    const snapshot = {
      ...prepared,
      prompt: 'Герой. Контекст и стиль клипа.',
      referenceImages: [{ path: '/snapshot/hero.png', label: 'Анфас', sha256: 'a'.repeat(64), bytes: 100 }]
    };
    api.create.mockResolvedValue({ ...snapshot, requestSha: null, approvalToken: null });
    api.prepare.mockResolvedValue(snapshot);
    await RenderHook('reference', input).start('  Герой  ');
    expect(api.create).toHaveBeenCalledExactlyOnceWith('/project', '  Герой  ', input);
    await RenderHook('reference', { images: [] }).next();
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.prepare.mock.calls).toEqual([['reference-session'], ['reference-session']]);
    expect(RenderHook('reference').session).toEqual(snapshot);
    expect(api.generate).not.toHaveBeenCalled();
  });

  it('обложка сохраняет вызов create с двумя аргументами и не получает контекст референса', async () => {
    await RenderHook('cover', { images: [{ path: '/uploads/hero.png', label: 'Герой' }] }).start('Обложка');
    expect(api.create).toHaveBeenCalledExactlyOnceWith('/project', 'Обложка');
  });

  it('подготовка не отправляет генерацию, двойной клик отправляет ровно один согласованный запрос', async () => {
    const initial = RenderHook();
    await Promise.all([initial.start('Герой <&>'), initial.start('Герой <&>')]);
    expect(api.create).toHaveBeenCalledExactlyOnceWith('/project', 'Герой <&>', { images: [] });
    expect(api.generate).not.toHaveBeenCalled();
    const current = RenderHook();
    await Promise.all([
      current.generate({ approvalToken: 'token', promptConfirmed: true }),
      current.generate({ approvalToken: 'token', promptConfirmed: true })
    ]);
    expect(api.generate).toHaveBeenCalledExactlyOnceWith('reference-session', 'sha', { approvalToken: 'token', promptConfirmed: true });
  });

  it('отклоняет устаревший токен и принимает полный оригинал без параметров обрезки', async () => {
    await RenderHook().start('Герой');
    await RenderHook().generate({ approvalToken: 'old-token', promptConfirmed: true });
    expect(api.generate).not.toHaveBeenCalled();
    await RenderHook().generate({ approvalToken: 'token', promptConfirmed: true });
    const accepted = vi.fn();
    await RenderHook().accept(null, accepted);
    expect(api.accept).toHaveBeenCalledExactlyOnceWith('reference-session');
    expect(accepted).toHaveBeenCalledExactlyOnceWith(result);
    unmount();
    expect(api.close).not.toHaveBeenCalled();
  });

  it('при ошибке attach сохраняет кандидата и повторяет привязку без новой генерации и повторного accept', async () => {
    const current = await prepareReady();
    const attach = vi.fn().mockRejectedValueOnce(new Error('Не удалось сохранить привязку')).mockResolvedValueOnce(undefined);
    await current.accept(null, attach);
    expect(RenderHook().error).toBe('Не удалось сохранить привязку');
    expect(RenderHook().session?.image).toEqual(ready.image);
    expect(RenderHook().attachmentPending).toBe(true);
    await RenderHook().generate({ approvalToken: 'token', promptConfirmed: true });
    await RenderHook().accept(null, attach);
    expect(api.accept).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(api.generate).toHaveBeenCalledTimes(1);
    expect(RenderHook().error).toBeNull();
  });

  it('закрывает поздно созданную сессию после ухода и не готовит запрос', async () => {
    let finish!: (value: CoverGenerationSession) => void;
    api.create.mockReturnValue(
      new Promise<CoverGenerationSession>((resolve) => {
        finish = resolve;
      })
    );
    const starting = RenderHook().start('Герой');
    unmount();
    finish(prepared);
    await starting;
    expect(api.close).toHaveBeenCalledExactlyOnceWith('reference-session');
    expect(api.prepare).not.toHaveBeenCalled();
  });

  it('уход до окончания accept не применяет результат к следующему объекту', async () => {
    const current = await prepareReady();
    let finish!: (value: typeof result) => void;
    api.accept.mockReturnValue(
      new Promise<typeof result>((resolve) => {
        finish = resolve;
      })
    );
    const accepted = vi.fn();
    const accepting = current.accept(null, accepted);
    unmount();
    finish(result);
    await accepting;
    expect(accepted).not.toHaveBeenCalled();
    expect(api.close).toHaveBeenCalledExactlyOnceWith('reference-session');
  });
});
