/** Подставной Python проверяет завершение всего задания без запуска инструментов и renderer. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobInfo } from '@shared/types';
import { Jobs } from './jobs';
import { PythonLauncher } from './python-launcher';

let localDir: string;
beforeEach(() => {
  localDir = mkdtempSync(join(tmpdir(), 'songframe-jobs-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(localDir, { recursive: true, force: true });
});

function jobs(outcomes: (number | Error | Promise<number>)[]): Jobs {
  const launcher = new PythonLauncher({ toolsRoot: localDir, localDir });
  vi.spyOn(launcher, 'runtime').mockReturnValue({ source: 'system-dev', command: 'fake-python', argsPrefix: [], cwd: localDir, env: {}, version: '3.12' });
  vi.spyOn(launcher, 'run').mockImplementation(async (_project, _tool, _args, options) => {
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    const code = await outcome;
    options?.onOutput?.('Результат шага\n');
    return { code: code ?? 0, stdout: '', stderr: '', command: 'fake-python' };
  });
  return new Jobs(localDir, localDir, launcher);
}

async function finished(value: Jobs, id: string): Promise<JobInfo> {
  await vi.waitFor(() => expect(value.get(id)?.status).not.toBe('running'), { interval: 10 });
  return value.get(id)!;
}

describe('Завершение Jobs', () => {
  it('публикует одно событие после всех шагов с исходным проектом и отдельным снимком', async () => {
    let complete!: (code: number) => void;
    const secondStep = new Promise<number>((resolve) => {
      complete = resolve;
    });
    const value = jobs([0, secondStep]);
    const listener = vi.fn();
    value.onFinished(listener);
    const job = value.start('tool', 'Два шага', 'первоначальный проект', [
      { tool: 'first', args: [] },
      { tool: 'second', args: [] }
    ]);
    expect(job.project).toBe('первоначальный проект');

    await vi.waitFor(() => expect(job.steps[1].status).toBe('running'), { interval: 10 });
    expect(listener).not.toHaveBeenCalled();
    complete(0);
    await finished(value, job.id);

    expect(listener).toHaveBeenCalledTimes(1);
    const [snapshot, project] = listener.mock.calls[0] as [JobInfo, string];
    expect(project).toBe('первоначальный проект');
    expect(snapshot).toEqual(job);
    expect(snapshot).not.toBe(job);
    expect(snapshot.steps).not.toBe(job.steps);
    expect(snapshot).toMatchObject({
      status: 'done',
      code: 0,
      finishedAt: expect.any(String),
      steps: [
        { status: 'done', code: 0 },
        { status: 'done', code: 0 }
      ]
    });
    snapshot.steps[0].status = 'failed';
    expect(value.get(job.id)?.steps[0].status).toBe('done');
    expect(value.list()).toEqual([job]);
  });

  it.each([
    ['ненулевой код обязательного шага', 7, 7],
    ['ошибка запуска Python', new Error('Python не запустился'), -1]
  ])('публикует финальную ошибку: %s', async (_label, outcome, expectedCode) => {
    const value = jobs([outcome as number | Error]);
    const listener = vi.fn();
    value.onFinished(listener);
    const job = value.start('tool', 'Ошибка', null, [
      { tool: 'first', args: [] },
      { tool: 'second', args: [] }
    ]);
    expect(job.project).toBeNull();
    await finished(value, job.id);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        code: expectedCode,
        finishedAt: expect.any(String),
        steps: [
          { label: 'first', tool: 'first', status: 'failed', code: expectedCode },
          { label: 'second', tool: 'second', status: 'pending', code: null }
        ]
      }),
      null
    );
    expect(value.launcher.run).toHaveBeenCalledTimes(1);
  });

  it('не доставляет событие после отписки во время выполнения', async () => {
    let complete!: (code: number) => void;
    const pendingStep = new Promise<number>((resolve) => {
      complete = resolve;
    });
    const value = jobs([pendingStep]);
    const listener = vi.fn();
    const unsubscribe = value.onFinished(listener);
    const job = value.start('tool', 'Ожидание', null, [{ tool: 'first', args: [] }]);
    unsubscribe();
    complete(0);
    await finished(value, job.id);
    expect(listener).not.toHaveBeenCalled();
  });

  it('изолирует ошибку и изменения подписчика от результата и следующего подписчика', async () => {
    const value = jobs([0]);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    value.onFinished((snapshot) => {
      snapshot.status = 'failed';
      snapshot.steps[0].code = 99;
      throw new Error('Ошибка подписчика');
    });
    const listener = vi.fn();
    value.onFinished(listener);
    const job = value.start('tool', 'Результат', null, [{ tool: 'first', args: [] }]);
    await finished(value, job.id);

    expect(job).toMatchObject({ status: 'done', code: 0, steps: [{ status: 'done', code: 0 }] });
    expect(listener).toHaveBeenCalledExactlyOnceWith(job, null);
    expect(warning).toHaveBeenCalledTimes(1);
  });
});
