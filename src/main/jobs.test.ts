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

type Outcome = number | Error | Promise<number> | { code: number | null; stdout?: string; stderr?: string };

function jobs(outcomes: Outcome[]): Jobs {
  const launcher = new PythonLauncher({ toolsRoot: localDir, localDir });
  vi.spyOn(launcher, 'runtime').mockReturnValue({ source: 'system-dev', command: 'fake-python', argsPrefix: [], cwd: localDir, env: {}, version: '3.12' });
  vi.spyOn(launcher, 'run').mockImplementation(async (_project, _tool, _args, options) => {
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    const result = await outcome;
    const output = typeof result === 'object' ? result : { code: result ?? 0 };
    options?.onOutput?.(output.stdout ?? 'Результат шага\n');
    if (output.stderr) options?.onOutput?.(output.stderr, true);
    return { code: output.code, stdout: output.stdout ?? '', stderr: output.stderr ?? '', command: 'fake-python' };
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
    expect(job.error).toBe(outcome instanceof Error ? outcome.message : `Шаг «first» завершился с кодом ${expectedCode}.`);
  });

  it('сохраняет причину отказа повтора из stderr в задании и событии завершения', async () => {
    const reason = "M44: провайдер снимка 'gptunnel'; для повтора требуется Kling.";
    const value = jobs([{ code: 3, stdout: 'Подготовка повтора\n', stderr: `\n${reason}\n` }]);
    const listener = vi.fn();
    value.onFinished(listener);
    const job = value.start('regenerate', 'Подготовка повтора M44', null, [
      { tool: 'regenerate_shot', args: ['M44', '--json'], label: 'новая попытка без отправки' }
    ]);
    await finished(value, job.id);

    expect(job).toMatchObject({ status: 'failed', code: 3, error: reason });
    expect(listener).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ error: reason }), null);
    expect(value.launcher.run).toHaveBeenCalledTimes(1);
  });

  it('сохраняет причину первого обязательного сбоя после последующих шагов', async () => {
    const value = jobs([
      { code: 1, stdout: 'Первый шаг не готов\n' },
      { code: 2, stderr: 'Второй шаг не готов\n' },
      { code: 0, stdout: 'Успешный длинный вывод\n'.repeat(2000) }
    ]);
    const job = value.start('tool', 'Продолжение после ошибки', null, [
      { tool: 'first', args: [], stop: false },
      { tool: 'second', args: [], stop: false },
      { tool: 'third', args: [] }
    ]);
    await finished(value, job.id);

    expect(job).toMatchObject({ status: 'failed', code: 1, error: 'Первый шаг не готов' });
    expect(job.log).not.toContain('Первый шаг не готов');
  });

  it('не считает сбой необязательного шага причиной ошибки успешного задания', async () => {
    const value = jobs([{ code: 2, stderr: 'Сопутствующий шаг недоступен\n' }, 0]);
    const job = value.start('tool', 'Сопутствующая операция', null, [
      { tool: 'optional', args: [], required: false },
      { tool: 'required', args: [] }
    ]);
    await finished(value, job.id);

    expect(job).toMatchObject({ status: 'done', code: 0 });
    expect(job.error).toBeUndefined();
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
