/** Диагностика сохраняет целые фразы, спецсимволы путей и различие между кодом завершения и сигналом. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { environmentTexts } from '@shared/texts/environment';
import { resolvePaths } from './paths';
import { PythonLauncher } from './python-launcher';

const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('дословные сообщения среды', () => {
  it('показывает выбранный отсутствующий путь без нормализации текста или потери кавычек', () => {
    const work = mkdtempSync(join(tmpdir(), 'songframe-environment-texts-'));
    temporaryDirectories.push(work);
    const selected = join(work, 'Клип «Ёж» & {draft}');
    const paths = resolvePaths({ appPath: work, execPath: join(work, 'app'), cwd: work, userData: work, override: selected });
    expect(paths.toolsRoot).toBeNull();
    expect(paths.problems).toEqual([`Сохранённая папка комплекса недоступна: ${selected}. Выберите её заново на странице «Среда».`]);
  });

  it('сохраняет параметры полной диагностики команд, Python и медиапоставки', () => {
    const command = 'C:\\Клип «Ёж» & {draft}\\python.exe';
    expect(environmentTexts.main.commandNotFound(command)).toBe('Команда не найдена: C:\\Клип «Ёж» & {draft}\\python.exe');
    expect(environmentTexts.main.commandFailed({ command, code: undefined })).toBe(
      'Команда завершилась с ошибкой (код неизвестен): C:\\Клип «Ёж» & {draft}\\python.exe'
    );
    expect(environmentTexts.main.commandFailed({ command: 'git', code: 0 })).toBe('Команда завершилась с ошибкой (код 0): git');
    expect(environmentTexts.main.commandFailed({ command: 'git', code: null })).toBe('Команда завершилась с ошибкой (код неизвестен): git');
    expect(environmentTexts.main.commandFailed({ command: 'git', code: 'ENOENT' })).toBe('Команда завершилась с ошибкой (код ENOENT): git');
    expect(environmentTexts.main.pythonVersion({ version: '3.12.15', executable: command })).toBe('Python 3.12.15 (C:\\Клип «Ёж» & {draft}\\python.exe)');
    expect(environmentTexts.main.pythonExited(null)).toBe('Python завершился с кодом null');
    expect(environmentTexts.main.pythonExited(0)).toBe('Python завершился с кодом 0');
    expect(environmentTexts.main.runtimeTargetMismatch({ actual: 'win32-x64', expected: 'linux-arm64' })).toBe(
      'Комплект win32-x64 не подходит для linux-arm64.'
    );
    expect(environmentTexts.main.runtimeFileMissing(command)).toBe('Нет файла C:\\Клип «Ёж» & {draft}\\python.exe.');
    expect(environmentTexts.main.bundledPythonUnavailable({ root: 'runtime с пробелами', reason: 'ошибка\nDLL' })).toBe(
      'Встроенный Python недоступен (runtime с пробелами): ошибка\nDLL'
    );
    expect(environmentTexts.main.bundledMediaUnavailable({ name: 'ffprobe', binDir: 'C:\\Клип «Ёж»\\bin' })).toBe(
      'Встроенный ffprobe недоступен (C:\\Клип «Ёж»\\bin). Распакуйте приложение заново.'
    );
    expect(environmentTexts.main.mediaLabel({ bundled: false, name: 'ffprobe' })).toBe('ffprobe');
    expect(environmentTexts.main.mediaLabel({ bundled: true, name: 'FFmpeg' })).toBe('Встроенный FFmpeg');
    expect(environmentTexts.main.environmentExited(0)).toBe('Проверка среды завершилась без результата (код 0).');
    expect(environmentTexts.main.commandTimedOut(45000)).toBe('Превышено время выполнения (45000 мс).');
  });

  it('сохраняет отдельные переводы строк в потоке ошибок', () => {
    expect(environmentTexts.main.executionStopped).toBe('Выполнение остановлено пользователем.');
    expect(environmentTexts.main.executionStoppedOutput).toBe('\nВыполнение остановлено пользователем.\n');
    expect(environmentTexts.main.executionTimedOutOutput(123)).toBe('\nПревышено время выполнения (123 мс).\n');
    expect(environmentTexts.main.pythonLaunchFailedOutput('ENOENT\nподробности')).toBe('\nОшибка запуска Python: ENOENT\nподробности\n');
    expect(environmentTexts.main.pythonSignalOutput('SIGTERM')).toBe('\nPython остановлен сигналом SIGTERM.\n');
  });

  it('возвращает ошибки предусловий до определения runtime и не вызывает его после ранней отмены', async () => {
    const launcher = new PythonLauncher({ toolsRoot: null });
    const runtime = vi.spyOn(launcher, 'runtime').mockImplementation(() => {
      throw new Error('runtime не должен вызываться');
    });
    await expect(launcher.run(null, 'probe', [])).rejects.toThrow('Корень комплекса не найден.');
    await expect(launcher.execute([], { signal: AbortSignal.abort() })).resolves.toEqual({
      code: null,
      stdout: '',
      stderr: 'Выполнение остановлено пользователем.',
      command: ''
    });
    expect(runtime).not.toHaveBeenCalled();
    const invalid = new PythonLauncher({ toolsRoot: '/unused' });
    const invalidRuntime = vi.spyOn(invalid, 'runtime');
    await expect(invalid.run(null, 'Имя «Ёж»', [])).rejects.toThrow('Недопустимое имя инструмента: Имя «Ёж»');
    expect(invalidRuntime).not.toHaveBeenCalled();
  });
});
