/** Совпадающие проверки объединяются только на время чтения, без сети и кэша аккаунта. */
import { describe, expect, it, vi } from 'vitest';
import { KLING_COMMANDS, readKlingCapabilities } from './kling-capabilities';
import type { ToolResult } from '@shared/types';

const payload = () => ({
  reports: KLING_COMMANDS.map((command) => ({ command, models: { live: { arguments: {}, slots: {}, limits: {} } } })),
  problems: [] as { command: string; message: string }[]
});
const response = (value = payload()): ToolResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '', command: 'тест' });

describe('единый каталог Kling', () => {
  it('объединяет одновременные настройки изображений, видео и повтор эффекта', async () => {
    let finish!: (value: ToolResult) => void;
    const launcher = {
      run: vi.fn(
        () =>
          new Promise<ToolResult>((resolve) => {
            finish = resolve;
          })
      )
    };
    const image = readKlingCapabilities(launcher, '/project', [], ['text_to_image', 'image_to_image']);
    const video = readKlingCapabilities(launcher, '/project', [], ['image_to_video', 'motion_control']);
    const repeated = readKlingCapabilities(launcher, '/project', [], ['image_to_video']);
    expect(launcher.run).toHaveBeenCalledTimes(1);
    expect(launcher.run).toHaveBeenCalledWith(
      '/project',
      'kling_request',
      ['capabilities', '--commands', KLING_COMMANDS.join(','), '--json', '--timeout', '30'],
      { timeoutMs: 35_000 }
    );
    finish(response());
    const values = await Promise.all([image, video, repeated]);
    expect(values.map((value) => value.reports.map((entry) => entry.command))).toEqual([
      ['text_to_image', 'image_to_image'],
      ['image_to_video', 'motion_control'],
      ['image_to_video']
    ]);
  });

  it('после завершения снова запрашивает модели и не сохраняет прошлый успех', async () => {
    const launcher = {
      run: vi
        .fn()
        .mockResolvedValueOnce(response())
        .mockResolvedValueOnce(response({ reports: [], problems: KLING_COMMANDS.map((command) => ({ command, message: 'Модели не объявлены.' })) }))
    };
    expect((await readKlingCapabilities(launcher, '/project', [], ['image_to_video'])).reports).toHaveLength(1);
    const next = await readKlingCapabilities(launcher, '/project', [], ['image_to_video']);
    expect(next.reports).toEqual([]);
    expect(next.problems).toEqual([{ command: 'image_to_video', message: 'Модели не объявлены.' }]);
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
    const a = readKlingCapabilities(launcher, '/project', [], ['image_to_video']);
    const b = readKlingCapabilities(launcher, '/project', [], ['text_to_image']);
    fail(new Error('Нет соединения.'));
    expect(await Promise.allSettled([a, b])).toEqual([
      { status: 'rejected', reason: new Error('Нет соединения.') },
      { status: 'rejected', reason: new Error('Нет соединения.') }
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    expect((await readKlingCapabilities(launcher, '/project', [], ['image_to_video'])).reports).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('сохраняет ошибки запрошенных команд и не показывает ошибки другого вида медиа', async () => {
    const value = payload();
    value.reports = value.reports.filter((entry) => entry.command !== 'omni_ref_video');
    value.problems = [{ command: 'omni_ref_video', message: 'Схема недоступна.' }];
    const launcher = { run: vi.fn(async () => response(value)) };
    const [image, video] = await Promise.all([
      readKlingCapabilities(launcher, '/project', [], ['text_to_image']),
      readKlingCapabilities(launcher, '/project', [], ['image_to_video', 'omni_ref_video'])
    ]);
    expect(image.problems).toEqual([]);
    expect(video.reports.map((entry) => entry.command)).toEqual(['image_to_video']);
    expect(video.problems).toEqual(value.problems);
    expect(launcher.run).toHaveBeenCalledTimes(1);
  });

  it('не смешивает разные проекты, исполнители и явно выбранные CLI', async () => {
    const launcher = { run: vi.fn(async () => response()) };
    const other = { run: vi.fn(async () => response()) };
    await Promise.all([
      readKlingCapabilities(launcher, '/one', [], ['image_to_video']),
      readKlingCapabilities(launcher, '/two', [], ['image_to_video']),
      readKlingCapabilities(launcher, '/one', ['--cli', '/other'], ['image_to_video']),
      readKlingCapabilities(other, '/one', [], ['image_to_video'])
    ]);
    expect(launcher.run).toHaveBeenCalledTimes(3);
    expect(other.run).toHaveBeenCalledTimes(1);
  });

  it('общая ошибка процесса не превращается в успешный пустой каталог', async () => {
    const launcher = { run: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'Discovery не выполнен.', command: '' })) };
    await expect(readKlingCapabilities(launcher, '/project', [], ['image_to_video'])).rejects.toThrow('Discovery не выполнен.');
  });
});
