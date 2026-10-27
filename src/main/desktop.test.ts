/** Проверяем доставку запроса файловому менеджеру и ошибки помощника, не открывая окна в unit-тестах. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDesktopPath } from './desktop';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "Папка с пробелами и ' кавычкой "));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('Открытие папок', () => {
  it('на Linux передаёт URI папки в ShowFolders отдельным аргументом', async () => {
    const run = vi.fn(async () => undefined);
    const native = vi.fn(async () => '');
    await openDesktopPath(directory, native, 'linux', run);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]).toEqual([
      'gdbus',
      [
        'call',
        '--session',
        '--dest',
        'org.freedesktop.FileManager1',
        '--object-path',
        '/org/freedesktop/FileManager1',
        '--method',
        'org.freedesktop.FileManager1.ShowFolders',
        JSON.stringify([pathToFileURL(directory).href]),
        ''
      ]
    ]);
    expect(native).not.toHaveBeenCalled();
  });
  it('использует xdg-open при недоступном интерфейсе и передаёт его отказ пользователю', async () => {
    const run = vi.fn<(command: string, args: string[]) => Promise<void>>().mockRejectedValueOnce(new Error('Нет интерфейса')).mockResolvedValueOnce(undefined);
    const native = vi.fn(async () => '');
    await openDesktopPath(directory, native, 'linux', run);
    expect(run).toHaveBeenLastCalledWith('xdg-open', [directory]);
    run.mockRejectedValue(new Error('Файловый менеджер не запустился'));
    await expect(openDesktopPath(directory, native, 'linux', run)).rejects.toThrow(/Не удалось открыть.*Файловый менеджер не запустился/);
    expect(native).not.toHaveBeenCalled();
  });
  it('сохраняет штатное открытие файлов и других ОС, учитывая строку ошибки Electron', async () => {
    const run = vi.fn(async () => undefined);
    const native = vi.fn(async () => '');
    const file = join(directory, 'file.txt');
    writeFileSync(file, 'текст');
    await openDesktopPath(file, native, 'linux', run);
    await openDesktopPath(directory, native, 'win32', run);
    expect(native).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
    native.mockResolvedValue('Нет приложения');
    await expect(openDesktopPath(file, native, 'linux', run)).rejects.toThrow(/Нет приложения/);
  });
  it('не запускает файловый менеджер для отсутствующего пути', async () => {
    const run = vi.fn(async () => undefined);
    const native = vi.fn(async () => '');
    await expect(openDesktopPath(join(directory, 'нет'), native, 'linux', run)).rejects.toThrow(/не найдены/);
    expect(run).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
  });
});
