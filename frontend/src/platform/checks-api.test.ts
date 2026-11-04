/**
 * Адаптер группы checks: list/run/runAll перенесены в Go (задания общего менеджера), остальные
 * методы группы (views через updateViews, пробы) недоступны с причиной «не перенесено».
 * Bindings подменяются целиком: Wails runtime и Go не запускаются.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CheckInfo } from '@shared/types';
import { createApi, methodAvailability, type Bindings } from './api';

function bindings(checks: Record<string, unknown>): Bindings {
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
    checks: async () => checks as never,
    events: async () => ({ on: () => () => undefined })
  } as Bindings;
}

const job = {
  id: 'j1',
  project: '/клип',
  kind: 'check',
  title: 'Все проверки',
  status: 'running',
  startedAt: '2026-11-04T12:00:00.000Z',
  finishedAt: null,
  log: '',
  code: null,
  steps: [{ label: 'Данные сцен', tool: 'lint_registry', status: 'pending', code: null }]
};

describe('window.api.checks', () => {
  it('list, run и runAll перенесены; пересборка представлений и пробы — нет', () => {
    for (const method of ['checks.list', 'checks.run', 'checks.runAll'] as const) {
      expect(methodAvailability(method)).toEqual({ available: true, reason: null });
    }
    for (const method of ['checks.updateViews', 'checks.buildReview', 'checks.listReviews', 'checks.removeReview'] as const) {
      expect(methodAvailability(method).available).toBe(false);
    }
  });

  it('list возвращает CHECKS Go', async () => {
    const list: CheckInfo[] = [{ id: 'lint', label: 'Данные сцен', description: 'Проверить формат', tool: 'lint_registry', needsScenes: true }];
    const api = createApi(bindings({ List: async () => list }));
    await expect(api.checks.list()).resolves.toEqual(list);
  });

  it('run и runAll передают проект, проверку и параметры (по умолчанию — пустые)', async () => {
    const Run = vi.fn(async () => job);
    const RunAll = vi.fn(async () => job);
    const api = createApi(bindings({ Run, RunAll }));
    await expect(api.checks.run('/клип', 'lint', { strict: true })).resolves.toMatchObject({ id: 'j1', kind: 'check' });
    expect(Run).toHaveBeenCalledWith('/клип', 'lint', { strict: true });
    await api.checks.run('/клип', 'status');
    expect(Run).toHaveBeenLastCalledWith('/клип', 'status', {});
    await expect(api.checks.runAll('/клип')).resolves.toMatchObject({ title: 'Все проверки' });
    expect(RunAll).toHaveBeenCalledWith('/клип', {});
  });

  it('показывает отказ Go-сервиса его текстом', async () => {
    const error = Object.assign(new Error('Проверка «Карточки и списки» ещё не перенесена в Go-версию SongFrame.'), { name: 'RuntimeError' });
    const api = createApi(bindings({ Run: async () => Promise.reject(error) }));
    await expect(api.checks.run('/клип', 'views')).rejects.toMatchObject({ code: 'SERVICE_FAILED', message: error.message });
  });
});
