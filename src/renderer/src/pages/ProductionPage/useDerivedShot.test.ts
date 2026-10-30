import type * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DerivedShotApi, DerivedShotView } from '@shared/derived-shot';
import type { JobInfo } from '@shared/types';
import { useDerivedShot } from './useDerivedShot';

const fixture = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  stateIndex: 0,
  refIndex: 0,
  effects: [] as (() => (() => void) | void)[],
  notify: vi.fn(),
  describeError: (error: unknown) => (error instanceof Error ? error.message : String(error))
}));
// Проверяем реальные обработчики и границы async без DOM; эффекты запускаем явно там, где нужен жизненный цикл панели.
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
  useCallback: (value: unknown) => value,
  useMemo: (calculate: () => unknown) => calculate()
}));
vi.mock('../../state', () => ({ useApp: () => ({ notify: fixture.notify, describeError: fixture.describeError }) }));

const api = {
  view: vi.fn<DerivedShotApi['view']>(),
  save: vi.fn<DerivedShotApi['save']>(),
  build: vi.fn<DerivedShotApi['build']>(),
  accept: vi.fn<DerivedShotApi['accept']>()
};
const onApplied = vi.fn().mockResolvedValue(undefined);
const job = { id: 'job-derived', kind: 'tool', status: 'running', steps: [{ tool: 'derive_shot' }] } as JobInfo;
function shotView(project = '/a'): DerivedShotView {
  const recipe = { mode: 'trim', start_frame: 10 } as const;
  return {
    project,
    shot: 'M02',
    title: 'Цель',
    action: 'Ускорить как-нибудь красиво',
    sourceShot: 'M01',
    sourceTitle: 'Источник',
    sourcePath: '/source.mp4',
    sourceFrames: 300,
    targetFrames: 90,
    recipe,
    preview: {
      id: 'preview-1',
      videoPath: '/preview.mp4',
      candidatePath: '/candidate',
      resultToken: 'token-1',
      recipe,
      frames: 90,
      fresh: true,
      problem: null,
      accepted: false
    },
    job: null,
    problem: null,
    toolsProblem: null,
    hasAsset: false
  };
}
function Draw(project = '/a', shot = 'M02') {
  fixture.stateIndex = fixture.refIndex = 0;
  fixture.effects = [];
  return useDerivedShot(project, shot, onApplied);
}
async function loaded(view = shotView()) {
  api.view.mockResolvedValue(view);
  await Draw(view.project).retry();
  return Draw(view.project);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle() {
  for (let index = 0; index < 5; index++) await Promise.resolve();
}

beforeEach(() => {
  fixture.states = [];
  fixture.refs = [];
  fixture.effects = [];
  vi.clearAllMocks();
  api.view.mockResolvedValue(shotView());
  api.save.mockImplementation(async (project, _shot, recipe) => ({ ...shotView(project), recipe }));
  api.build.mockResolvedValue({ ...shotView(), job });
  api.accept.mockResolvedValue({ ...shotView(), hasAsset: true, preview: { ...shotView().preview!, accepted: true } });
  vi.stubGlobal('window', { api: { derivedShots: api } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('локальная сборка производного плана', () => {
  it('не угадывает операцию из постановки, не запускает сборку или приёмку при открытии', async () => {
    const form = await loaded({ ...shotView(), recipe: null, preview: null });
    expect(form.draft.mode).toBe('');
    expect(form.reasons?.build).toContain('выберите способ');
    expect(api.build).not.toHaveBeenCalled();
    expect(api.accept).not.toHaveBeenCalled();
  });

  it('показывает канонический ответ для выбранного пути через ссылку и сохраняет правки при опросе', async () => {
    const selectedProject = '/projects/linked';
    const canonicalView = shotView('/projects/real');
    api.view.mockResolvedValue(canonicalView);
    await Draw(selectedProject).retry();
    let form = Draw(selectedProject);
    expect(form.view).toBe(canonicalView);
    form.change({ ...form.draft, start: '20' });
    await Draw(selectedProject).retry();
    form = Draw(selectedProject);
    expect(form.draft.start).toBe('20');
    expect(form.reasons?.dirty).toBe(true);
    api.save.mockImplementationOnce(async (_project, _shot, recipe) => ({ ...canonicalView, recipe }));
    await form.save();
    form = Draw(selectedProject);
    expect(api.save).toHaveBeenCalledExactlyOnceWith(selectedProject, 'M02', { mode: 'trim', start_frame: 20 });
    expect(form.view?.project).toBe('/projects/real');
    expect(form.draft.start).toBe('20');
    expect(form.reasons?.dirty).toBe(false);
    expect(Draw('/projects/other').view).toBeNull();
  });

  it('сохраняет черновик без Python, провайдера и доступного источника', async () => {
    let form = await loaded({
      ...shotView(),
      recipe: null,
      preview: null,
      sourceFrames: 0,
      problem: 'Источник отсутствует.',
      toolsProblem: 'Python не найден.'
    });
    form.change({ mode: 'still', start: '0', end: '', frame: '5' });
    form = Draw();
    expect(form.reasons?.build).toBe('Источник отсутствует.');
    expect(form.reasons?.save).toBeNull();
    await form.save();
    expect(api.save).toHaveBeenCalledExactlyOnceWith('/a', 'M02', { mode: 'still', frame: 5 });
    expect(api.build).not.toHaveBeenCalled();
  });

  it('сохраняет правки при опросе и блокирует приёмку старого предпросмотра до нового результата', async () => {
    let form = await loaded();
    form.change({ ...form.draft, start: '20' });
    form = Draw();
    await form.retry();
    form = Draw();
    expect(form.draft.start).toBe('20');
    expect(form.reasons?.accept).toContain('Сохраните рецепт');
    form.requestAccept();
    expect(api.accept).not.toHaveBeenCalled();
    await form.save();
    form = Draw();
    expect(form.reasons?.accept).toContain('отличается');
    form.requestAccept();
    expect(api.accept).not.toHaveBeenCalled();
  });

  it('при потере Python блокирует приёмку готового кандидата, сохраняя доступ к черновику', async () => {
    let form = await loaded({ ...shotView(), toolsProblem: 'Python не найден.' });
    expect(form.reasons?.accept).toBe('Python не найден.');
    form.requestAccept();
    expect(api.accept).not.toHaveBeenCalled();
    form.change({ ...form.draft, start: '20' });
    form = Draw();
    expect(form.reasons?.save).toBeNull();
    await form.save();
    expect(api.save).toHaveBeenCalledOnce();
  });

  it('сборка запускается ровно один раз и только возвращает наблюдаемое фоновое задание', async () => {
    const form = await loaded();
    const building = form.build();
    await form.build();
    await building;
    expect(api.build).toHaveBeenCalledExactlyOnceWith('/a', 'M02', { mode: 'trim', start_frame: 10 });
    expect(Draw().busy).toBe(true);
    expect(api.accept).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it.each(['failed', 'done'] as const)('приёмка running→%s не сообщает успех до конца задания', async (status) => {
    let form = await loaded();
    api.accept.mockResolvedValueOnce({ ...shotView(), job });
    form.requestAccept();
    await settle();
    expect(onApplied).not.toHaveBeenCalled();
    expect(fixture.notify).not.toHaveBeenCalled();
    expect(Draw().busy).toBe(true);
    api.view.mockResolvedValue({
      ...shotView(),
      job: { ...job, status, error: status === 'failed' ? 'Сбой записи.' : undefined },
      preview: { ...shotView().preview!, accepted: status === 'done' }
    });
    await Draw().retry();
    form = Draw();
    expect(form.busy).toBe(false);
    expect(form.view?.preview?.id).toBe('preview-1');
    if (status === 'failed') {
      expect(form.reasons?.accept).toBeNull();
      form.requestAccept();
      await settle();
      expect(api.accept).toHaveBeenCalledTimes(2);
      expect(api.build).not.toHaveBeenCalled();
    } else expect(form.reasons?.accept).toContain('уже принят');
  });

  it('не теряет кандидат после ошибки приёмки и повторяет принятие без пересборки', async () => {
    let form = await loaded();
    api.accept.mockRejectedValueOnce(new Error('Запись assets не удалась.'));
    form.requestAccept();
    await settle();
    form = Draw();
    expect(form.error).toBe('Запись assets не удалась.');
    expect(form.view?.preview?.id).toBe('preview-1');
    form.requestAccept();
    await settle();
    expect(api.accept.mock.calls).toEqual([
      ['/a', 'M02', 'preview-1', 'token-1', false],
      ['/a', 'M02', 'preview-1', 'token-1', false]
    ]);
    expect(api.build).not.toHaveBeenCalled();
    expect(onApplied).toHaveBeenCalledOnce();
  });

  it('замена требует отдельного подтверждения; отменённый callback и двойной клик не принимают результат', async () => {
    let form = await loaded({ ...shotView(), hasAsset: true });
    form.requestAccept();
    expect(api.accept).not.toHaveBeenCalled();
    form = Draw();
    expect(form.replacement).toBe(true);
    const previous = form.confirmReplacement;
    form.closeReplacement();
    await previous();
    expect(api.accept).not.toHaveBeenCalled();
    form = Draw();
    form.requestAccept();
    form = Draw();
    await Promise.all([form.confirmReplacement(), form.confirmReplacement()]);
    expect(api.accept).toHaveBeenCalledExactlyOnceWith('/a', 'M02', 'preview-1', 'token-1', true);
  });

  it('изменение формы немедленно отзывает согласие на замену, даже до следующего render', async () => {
    let form = await loaded({ ...shotView(), hasAsset: true });
    form.requestAccept();
    form = Draw();
    form.change({ ...form.draft, start: '22' });
    await form.confirmReplacement();
    expect(api.accept).not.toHaveBeenCalled();
    expect(Draw().replacement).toBe(false);
  });

  it('старый опрос не затирает сохранённый рецепт', async () => {
    let form = await loaded();
    form.change({ ...form.draft, start: '30' });
    form = Draw();
    const late = deferred<DerivedShotView>();
    api.view.mockReturnValueOnce(late.promise);
    const reading = form.retry();
    await form.save();
    late.resolve(shotView());
    await reading;
    expect(Draw().draft.start).toBe('30');
  });

  it('игнорирует поздний результат и старые действия после A→B→A', async () => {
    const old = await loaded();
    const late = deferred<DerivedShotView>();
    api.accept.mockReturnValueOnce(late.promise);
    old.requestAccept();
    Draw('/b');
    await loaded(shotView('/b'));
    await loaded(shotView('/a'));
    late.resolve({ ...shotView(), hasAsset: true });
    await settle();
    expect(onApplied).not.toHaveBeenCalled();
    await old.save();
    await old.build();
    old.requestAccept();
    expect(api.build).not.toHaveBeenCalled();
    expect(api.accept).toHaveBeenCalledTimes(1);
    expect(Draw().view?.hasAsset).toBe(false);
  });

  it('после закрытия панели сборка может завершиться фоном, но её ответ не принимает и не обновляет панель', async () => {
    const form = await loaded();
    const cleanup = fixture.effects[0]()!;
    const late = deferred<DerivedShotView>();
    api.build.mockReturnValueOnce(late.promise);
    const building = form.build();
    cleanup();
    late.resolve({ ...shotView(), job });
    await building;
    expect(onApplied).not.toHaveBeenCalled();
    expect(api.accept).not.toHaveBeenCalled();
    expect(Draw().view?.job).toBeNull();
  });

  it('повторное подключение эффектов StrictMode не оставляет панель в загрузке', async () => {
    vi.useFakeTimers();
    Draw();
    const mount = fixture.effects[0];
    const poll = fixture.effects[1];
    const unmount = mount()!;
    const stop = poll()!;
    unmount();
    stop();
    mount();
    const stopAgain = poll()!;
    await settle();
    expect(Draw().view?.shot).toBe('M02');
    stopAgain();
  });

  it('опрашивает завершение и свежесть, не принимая результат автоматически, и прекращает опрос после закрытия', async () => {
    vi.useFakeTimers();
    Draw();
    const cleanup = fixture.effects[1]()!;
    await settle();
    expect(api.view).toHaveBeenCalledTimes(1);
    api.view.mockResolvedValue({ ...shotView(), preview: { ...shotView().preview!, fresh: false, problem: 'Источник изменён.' } });
    await vi.advanceTimersByTimeAsync(1800);
    expect(Draw().view?.preview?.fresh).toBe(false);
    expect(Draw().reasons?.accept).toBe('Источник изменён.');
    expect(api.accept).not.toHaveBeenCalled();
    cleanup();
    await vi.advanceTimersByTimeAsync(3600);
    expect(api.view).toHaveBeenCalledTimes(2);
  });
});
