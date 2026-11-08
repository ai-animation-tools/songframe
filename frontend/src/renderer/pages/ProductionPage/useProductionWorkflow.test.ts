/** Проверяем реальные async-обработчики hook: устаревшее чтение не перекрывает новую операцию. */
import type * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Api } from '@shared/api';
import type { ProductionWorkflowView } from '@shared/production-workflow';
import { useProductionWorkflow } from './useProductionWorkflow';

const fixture = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  stateIndex: 0,
  refIndex: 0,
  effects: [] as (() => (() => void) | void)[],
  notify: vi.fn(),
  describeError: (error: unknown) => (error instanceof Error ? error.message : String(error))
}));
// Как в useDerivedShot.test.ts, жизненный цикл и ответы API управляются явно без DOM.
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
vi.mock('../../state', () => ({ useApp: () => ({ notify: fixture.notify, describeError: fixture.describeError }) }));

const api = { view: vi.fn<Api['productionWorkflow']['view']>(), start: vi.fn<Api['productionWorkflow']['start']>() };
const onApplied = vi.fn(async () => undefined);
const view: ProductionWorkflowView = {
  project: '/project',
  shot: 'M02',
  packageDir: '/project/plan/batches/M02',
  busy: false,
  stage: 'prompt_review',
  canPrepare: false,
  canContinue: true,
  canRevise: false,
  canGenerateFrames: false,
  paid: false,
  reasons: { prepare: null, continue: null, frames: null },
  derivedFrom: null,
  framePrompts: [],
  nextFrame: null,
  approvedFrameIds: [],
  problems: [],
  proposal: null,
  job: null
};
function Draw() {
  fixture.stateIndex = fixture.refIndex = 0;
  fixture.effects = [];
  return useProductionWorkflow('/project', 'M02', '/project/plan/batches/M02', onApplied);
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
  api.view.mockReset().mockResolvedValue(view);
  api.start.mockReset().mockResolvedValue({ ...view, busy: true });
  vi.stubGlobal('window', { api: { productionWorkflow: api } });
  Draw();
  cleanup = fixture.effects[0]();
});
afterEach(() => {
  cleanup?.();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('актуальность ошибок опроса производства', () => {
  it('игнорирует позднюю ошибку чтения после успешной операции того же пакета', async () => {
    await settle();
    const oldRead = deferred<ProductionWorkflowView>();
    api.view.mockReturnValueOnce(oldRead.promise);
    await vi.advanceTimersByTimeAsync(1500);
    expect(api.view).toHaveBeenCalledTimes(2);
    await expect(Draw().start('continue')).resolves.toBe(true);
    oldRead.reject(new Error('Ошибка старого опроса.'));
    await settle();
    expect(Draw().error).toBeNull();
    expect(Draw().view?.busy).toBe(true);
  });

  it('не подменяет ошибку текущей операции старым ответом опроса', async () => {
    await settle();
    const oldRead = deferred<ProductionWorkflowView>();
    const mutation = deferred<ProductionWorkflowView>();
    api.view.mockReturnValueOnce(oldRead.promise);
    api.start.mockReturnValueOnce(mutation.promise);
    await vi.advanceTimersByTimeAsync(1500);
    const operation = Draw().start('continue');
    oldRead.reject(new Error('Ошибка старого опроса.'));
    await settle();
    expect(Draw().error).toBeNull();
    expect(Draw().busy).toBe(true);
    mutation.reject(new Error('Ошибка текущей подготовки.'));
    await expect(operation).resolves.toBe(false);
    expect(Draw().error).toBe('Ошибка текущей подготовки.');
  });

  it('показывает ошибку актуального чтения, когда новая операция не начиналась', async () => {
    await settle();
    api.view.mockRejectedValueOnce(new Error('Не удалось прочитать текущий пакет.'));
    await vi.advanceTimersByTimeAsync(1500);
    expect(Draw().error).toBe('Не удалось прочитать текущий пакет.');
  });
});
