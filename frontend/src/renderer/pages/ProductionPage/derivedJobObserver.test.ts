import type * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, JobInfo, ProjectStatus } from '@shared/types';
import { AppProvider, type useApp } from '../../state';

const fixture = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  stateIndex: 0,
  refIndex: 0,
  effects: [] as (() => (() => void) | void)[],
  notices: vi.fn()
}));
// Запускаем настоящий общий observer: локальная страница и её operations для получения итога больше не нужны.
vi.mock('react', async (original) => ({
  ...(await original<typeof React>()),
  useState: (initial: unknown) => {
    const index = fixture.stateIndex++;
    if (!(index in fixture.states)) fixture.states[index] = typeof initial === 'function' ? initial() : initial;
    return [
      fixture.states[index],
      (value: unknown) => {
        const next = typeof value === 'function' ? value(fixture.states[index]) : value;
        fixture.states[index] = next;
        if (next && typeof next.message === 'string' && typeof next.severity === 'string') fixture.notices(next);
      }
    ];
  },
  useRef: (initial: unknown) => fixture.refs[fixture.refIndex++] ?? (fixture.refs[fixture.refIndex - 1] = { current: initial }),
  useEffect: (effect: () => (() => void) | void) => fixture.effects.push(effect),
  useCallback: (value: unknown) => value,
  useMemo: (calculate: () => unknown) => calculate()
}));
vi.mock('../../network', () => ({ useOnline: () => true, offlineAccess: (value: unknown) => value }));

const list = vi.fn();
const status = vi.fn();
const running: JobInfo = {
  id: 'accept-1',
  project: '/projects/real',
  kind: 'tool',
  title: 'Приёмка M02',
  status: 'running',
  startedAt: '2026-10-30T09:59:59Z',
  finishedAt: null,
  log: '',
  code: null,
  steps: [{ tool: 'derive_shot', label: '', status: 'running', code: null }]
};
function Draw() {
  fixture.stateIndex = fixture.refIndex = 0;
  fixture.effects = [];
  return (AppProvider({ children: null }).props as { value: ReturnType<typeof useApp> }).value;
}
async function observe() {
  await Draw().refresh();
  Draw();
  status.mockClear();
  // До общего опроса подключаются только проверка аварийного сеанса и обработчик фокуса.
  return fixture.effects[2]()!;
}
async function poll(jobs: JobInfo[]) {
  list.mockResolvedValue(jobs);
  await vi.advanceTimersByTimeAsync(3000);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-30T10:00:00Z'));
  fixture.states = [];
  fixture.refs = [];
  fixture.effects = [];
  vi.clearAllMocks();
  status.mockResolvedValue({ revision: 'before' });
  vi.stubGlobal('window', {
    location: { hash: '#/project/production' },
    api: {
      app: { state: vi.fn().mockResolvedValue({ current: '/projects/linked' } as AppState) },
      jobs: { list },
      projects: { status },
      agents: { list: vi.fn().mockResolvedValue([]), getSettings: vi.fn().mockResolvedValue(null) },
      ai: { access: vi.fn().mockResolvedValue(null) }
    }
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('общий наблюдатель производного плана после повторного открытия производства', () => {
  it.each(['done', 'failed', 'interrupted'] as const)('сообщает running→%s один раз и обновляет шапку без локальных operations', async (terminal) => {
    const stop = await observe();
    const old = { ...running, id: 'old-completed', status: 'done' as const };
    await poll([running, old]);
    expect(fixture.notices).not.toHaveBeenCalled();
    window.location.hash = '#/project/scenes';
    await poll([running, old]);
    window.location.hash = '#/project/production';
    status.mockResolvedValue({ revision: 'after' });
    const finished = { ...running, status: terminal, error: terminal === 'done' ? undefined : 'Комплект не записан.' };
    await poll([finished, old]);
    expect(fixture.notices).toHaveBeenCalledExactlyOnceWith({
      message: terminal === 'done' ? 'Приёмка M02: выполнено.' : 'Приёмка M02: не выполнено. Комплект не записан. Подробности — в журнале заданий.',
      severity: terminal === 'done' ? 'success' : 'error',
      persist: undefined
    });
    // Путь текущего проекта может быть ссылкой: канонический путь задания не мешает обновлению шапки.
    expect(status).toHaveBeenCalledExactlyOnceWith('/projects/linked');
    expect(Draw().status).toEqual({ revision: 'after' } as unknown as ProjectStatus);
    window.location.hash = '#/project/scenes';
    await poll([finished, old]);
    window.location.hash = '#/project/production';
    await poll([finished, old]);
    expect(fixture.notices).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledOnce();
    stop();
  });

  it('не теряет короткое задание между опросами и не показывает старую историю при запуске', async () => {
    const stop = await observe();
    const old = { ...running, id: 'old-completed', status: 'done' as const };
    const fast = { ...running, status: 'done' as const, startedAt: '2026-10-30T10:00:01Z' };
    await poll([old, fast]);
    expect(fixture.notices).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledOnce();
    await poll([old, fast]);
    expect(fixture.notices).toHaveBeenCalledOnce();
    stop();
  });

  it('сохраняет владельца уведомлений обычных производственных заданий', async () => {
    const stop = await observe();
    const ordinary = { ...running, kind: 'submit' as const, steps: [], title: 'Отправка M01' };
    await poll([ordinary]);
    await poll([{ ...ordinary, status: 'done' }]);
    expect(fixture.notices).not.toHaveBeenCalled();
    window.location.hash = '#/project/scenes';
    const other = { ...ordinary, id: 'submit-2' };
    await poll([other]);
    await poll([{ ...other, status: 'failed', error: 'Нет связи.' }]);
    expect(fixture.notices).toHaveBeenCalledExactlyOnceWith({
      message: 'Отправка M01: не выполнено. Нет связи. Подробности — в журнале заданий.',
      severity: 'error',
      persist: undefined
    });
    stop();
  });
});
