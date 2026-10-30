/** Совпадающие проверки объединяются только на время чтения, без сети и кэша аккаунта. */
import { describe, expect, it, vi } from 'vitest';
import { readMediaCatalog } from './media-catalog';
import type { ToolResult } from '@shared/types';

const COMMANDS = ['image_to_video', 'motion_control'];
const payload = () => ({
  reports: COMMANDS.map((command) => ({ command, models: { live: { arguments: {}, slots: {}, limits: {} } } })),
  problems: [] as { command: string; message: string }[]
});
const response = (value: unknown = payload()): ToolResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '', command: 'тест' });

describe('единый каталог платного провайдера', () => {
  it.each([
    { value: null, expected: 'Сервис «QA»\n<1> вернул неверное объявление возможностей.' },
    {
      value: {
        reports: [
          { command: 'text_to_image', models: {} },
          { command: 'text_to_image', models: {} }
        ],
        problems: []
      },
      expected: 'Сервис «QA»\n<1> вернул неверный состав команд возможностей.'
    }
  ])('сохраняет полную ошибку каталога и название сервиса: $expected', async ({ value, expected }) => {
    await expect(readMediaCatalog({ run: vi.fn(async () => response(value)) }, '/project', 'Сервис «QA»\n<1>', 'image')).rejects.toThrowError(
      new Error(expected)
    );
  });

  it('сохраняет fallback отказа сервиса и приоритет внешнего stderr дословно', async () => {
    for (const [stderr, expected] of [
      ['  ', 'Сервис «QA»\n<1> не подтвердил возможности.'],
      ['  Отказ «QA»\n<1>  ', 'Отказ «QA»\n<1>']
    ]) {
      const launcher = { run: vi.fn(async () => ({ code: 1, stdout: '', stderr, command: '' })) };
      await expect(readMediaCatalog(launcher, '/project', 'Сервис «QA»\n<1>', 'image')).rejects.toThrowError(new Error(expected));
    }
  });
  it('объединяет одновременные панели одного вида медиа и повтор эффекта', async () => {
    let finish!: (value: ToolResult) => void;
    const launcher = {
      run: vi.fn(
        () =>
          new Promise<ToolResult>((resolve) => {
            finish = resolve;
          })
      )
    };
    const first = readMediaCatalog(launcher, '/project', 'test', 'video');
    const repeated = readMediaCatalog(launcher, '/project', 'test', 'video');
    expect(launcher.run).toHaveBeenCalledTimes(1);
    expect(launcher.run).toHaveBeenCalledWith(
      '/project',
      'media_request',
      ['capabilities', '--provider', 'test', '--kind', 'video', '--json', '--timeout', '30'],
      {
        timeoutMs: 35_000
      }
    );
    finish(response());
    const values = await Promise.all([first, repeated]);
    expect(values.map((value) => value.reports.map((entry) => entry.command))).toEqual([COMMANDS, COMMANDS]);
  });

  it('после завершения снова запрашивает модели и не сохраняет прошлый успех', async () => {
    const launcher = {
      run: vi
        .fn()
        .mockResolvedValueOnce(response())
        .mockResolvedValueOnce(response({ reports: [], problems: COMMANDS.map((command) => ({ command, message: 'Модели не объявлены.' })) }))
    };
    expect((await readMediaCatalog(launcher, '/project', 'test', 'video')).reports).toHaveLength(2);
    const next = await readMediaCatalog(launcher, '/project', 'test', 'video');
    expect(next.reports).toEqual([]);
    expect(next.problems).toEqual(COMMANDS.map((command) => ({ command, message: 'Модели не объявлены.' })));
    expect(launcher.run).toHaveBeenCalledTimes(2);
  });

  it('очищает общий неудачный запрос и позволяет повторить проверку', async () => {
    let fail!: (error: Error) => void;
    const run = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          })
      )
      .mockResolvedValue(response());
    const launcher = { run };
    const a = readMediaCatalog(launcher, '/project', 'test', 'video');
    const b = readMediaCatalog(launcher, '/project', 'test', 'video');
    fail(new Error('Нет соединения.'));
    expect(await Promise.allSettled([a, b])).toEqual([
      { status: 'rejected', reason: new Error('Нет соединения.') },
      { status: 'rejected', reason: new Error('Нет соединения.') }
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    expect((await readMediaCatalog(launcher, '/project', 'test', 'video')).reports).toHaveLength(2);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('сохраняет ошибки отдельных команд рядом с успешными объявлениями', async () => {
    const value = payload();
    value.problems = [{ command: 'omni_ref_video', message: 'Схема недоступна.' }];
    const launcher = { run: vi.fn(async () => response(value)) };
    const video = await readMediaCatalog(launcher, '/project', 'test', 'video');
    expect(video.reports.map((entry) => entry.command)).toEqual(COMMANDS);
    expect(video.problems).toEqual(value.problems);
  });

  it('не смешивает разные проекты, провайдеры, виды медиа и исполнители', async () => {
    const launcher = { run: vi.fn(async () => response()) };
    const other = { run: vi.fn(async () => response()) };
    await Promise.all([
      readMediaCatalog(launcher, '/one', 'test', 'video'),
      readMediaCatalog(launcher, '/two', 'test', 'video'),
      readMediaCatalog(launcher, '/one', 'other', 'video'),
      readMediaCatalog(launcher, '/one', 'test', 'image'),
      readMediaCatalog(other, '/one', 'test', 'video')
    ]);
    expect(launcher.run).toHaveBeenCalledTimes(4);
    expect(other.run).toHaveBeenCalledTimes(1);
  });

  it('отклоняет повторную команду и общую ошибку процесса не выдаёт за пустой каталог', async () => {
    const duplicated = payload();
    duplicated.problems = [{ command: COMMANDS[0], message: 'Сбой.' }];
    await expect(readMediaCatalog({ run: vi.fn(async () => response(duplicated)) }, '/project', 'test', 'video')).rejects.toThrow('состав команд');
    const launcher = { run: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'Discovery не выполнен.', command: '' })) };
    await expect(readMediaCatalog(launcher, '/project', 'test', 'video')).rejects.toThrow('Discovery не выполнен.');
  });
});
