/** Подставной Python проверяет завершение всего задания без запуска инструментов и renderer. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_INTERRUPTED_MESSAGE, type JobInfo } from '@shared/types';
import { Jobs, SAVED_JOBS_LIMIT } from './jobs';
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

function jobs(outcomes: Outcome[], options: ConstructorParameters<typeof Jobs>[3] = {}): Jobs {
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
  return new Jobs(localDir, localDir, launcher, options);
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
    const reason = "M44: провайдер снимка 'gptunnel'; для повтора требуется другой провайдер.";
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

describe('Журнал заданий между запусками', () => {
  const saved = (id: string): Record<string, unknown> => JSON.parse(readFileSync(join(localDir, 'jobs', `${id}.json`), 'utf8'));

  it('сохраняет сведения без текста лога и показывает их в новом экземпляре с журналом из файла', async () => {
    const first = jobs([{ code: 0, stdout: 'Вывод первого шага\n' }]);
    const job = first.start('check', 'Проверка поставки', '/проект', [{ tool: 'check_workspace', args: ['--json'], label: 'рабочая папка' }]);
    await finished(first, job.id);
    expect(saved(job.id)).toMatchObject({ id: job.id, title: 'Проверка поставки', status: 'done', code: 0, steps: [{ status: 'done', code: 0 }] });
    expect(saved(job.id)).not.toHaveProperty('log');

    const second = jobs([]);
    const [restored] = second.list();
    expect(restored).toMatchObject({ id: job.id, status: 'done', previousSession: true, log: '' });
    expect(second.get(job.id)?.log).toContain('Вывод первого шага');
    expect(second.readLog(job.id)).toContain('$ рабочая папка --json');
    expect(saved(job.id)).not.toHaveProperty('previousSession');
  });

  it('помечает выполнявшееся задание прерванным и сохраняет это', async () => {
    const first = jobs([new Promise<number>(() => undefined)]);
    const job = first.start('submit', 'Отправка M1', null, [
      { tool: 'first', args: [] },
      { tool: 'second', args: [] }
    ]);
    await vi.waitFor(() => expect(saved(job.id)).toMatchObject({ steps: [{ status: 'running' }, { status: 'pending' }] }), { interval: 10 });

    const restored = jobs([]).get(job.id)!;
    expect(restored).toMatchObject({
      status: 'interrupted',
      error: JOB_INTERRUPTED_MESSAGE,
      finishedAt: expect.any(String),
      steps: [{ status: 'failed' }, { status: 'pending' }]
    });
    expect(saved(job.id)).toMatchObject({ status: 'interrupted', error: JOB_INTERRUPTED_MESSAGE });
    // Смена ресурсов продолжает тот же журнал и не объявляет живое задание прерванным.
    expect(new Jobs(localDir, localDir, first.launcher, { previous: first }).get(job.id)?.status).toBe('running');
    // Служебная проверка без окна не читает и не меняет журнал пользователя.
    expect(jobs([], { restore: false }).list()).toEqual([]);
  });

  it('хранит последние сведения в пределах лимита и удаляет старые вместе с журналом', () => {
    const directory = join(localDir, 'jobs');
    mkdirSync(directory, { recursive: true });
    for (let index = 0; index < SAVED_JOBS_LIMIT + 2; index += 1) {
      const id = `old${index.toString(36)}-1`;
      const info = {
        id,
        kind: 'tool',
        title: `Задание ${index}`,
        status: 'done',
        startedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        finishedAt: null,
        code: 0,
        steps: []
      };
      writeFileSync(join(directory, `${id}.json`), JSON.stringify(info));
      writeFileSync(join(directory, `${id}.log`), 'журнал');
    }
    const value = jobs([]);
    expect(value.list()).toHaveLength(SAVED_JOBS_LIMIT);
    expect(value.list()[0].title).toBe(`Задание ${SAVED_JOBS_LIMIT + 1}`);
    for (const id of ['old0-1', 'old1-1']) {
      expect(existsSync(join(directory, `${id}.json`))).toBe(false);
      expect(existsSync(join(directory, `${id}.log`))).toBe(false);
    }
    expect(existsSync(join(directory, 'old2-1.log'))).toBe(true);
  });

  it('пропускает повреждённые сведения и записи агента, не падая', () => {
    const directory = join(localDir, 'jobs');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'broken-1.json'), '{ не JSON');
    writeFileSync(join(directory, 'other-2.json'), JSON.stringify({ id: 'чужой', title: 'Неверный id' }));
    writeFileSync(join(directory, 'agent-00000000-0000-0000-0000-000000000000.json'), JSON.stringify({ id: 'агент' }));
    const good = {
      id: 'good-3',
      kind: 'tool',
      title: 'Целое',
      status: 'failed',
      startedAt: '2026-10-28T10:00:00Z',
      finishedAt: '2026-10-28T10:01:00Z',
      code: 2,
      steps: []
    };
    writeFileSync(join(directory, 'good-3.json'), JSON.stringify(good));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(
      jobs([])
        .list()
        .map((job) => job.id)
    ).toEqual(['good-3']);
    expect(warning).toHaveBeenCalledTimes(2);
    expect(existsSync(join(directory, 'broken-1.json'))).toBe(true);
    expect(jobs([]).get('good-3')?.log).toBe('');
  });
});
