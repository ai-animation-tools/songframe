/** Открытие локальных папок с подтверждением системного вызова; shell.openPath на Linux не ждёт xdg-open. */
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { applicationTexts } from '@shared/texts/application';

const exec = promisify(execFile);
type DesktopCommand = (command: string, args: string[]) => Promise<void>;

async function runDesktopCommand(command: string, args: string[]): Promise<void> {
  try {
    await exec(command, args, { timeout: 8000, maxBuffer: 64 * 1024, encoding: 'utf8', windowsHide: true });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (failure.killed) throw new Error(applicationTexts.desktop.commandTimedOut, { cause: error });
    if (failure.code === 'ENOENT') throw new Error(applicationTexts.desktop.commandMissing({ command }), { cause: error });
    throw new Error(failure.stderr?.trim().slice(0, 1000) || applicationTexts.desktop.commandFailed, { cause: error });
  }
}

export async function openDesktopPath(
  path: string,
  nativeOpen: (path: string) => Promise<string>,
  platform = process.platform,
  run: DesktopCommand = runDesktopCommand
): Promise<void> {
  let directory: boolean;
  try {
    directory = (await stat(path)).isDirectory();
  } catch {
    throw new Error(applicationTexts.desktop.pathUnavailable({ path }));
  }
  try {
    if (platform === 'linux' && directory) {
      try {
        // ShowFolders открывает содержимое папки, а не выделяет её в родительском каталоге.
        // URI и GVariant-массив передаются отдельными аргументами, без shell и имён конкретного файлового менеджера.
        await run('gdbus', [
          'call',
          '--session',
          '--dest',
          'org.freedesktop.FileManager1',
          '--object-path',
          '/org/freedesktop/FileManager1',
          '--method',
          'org.freedesktop.FileManager1.ShowFolders',
          JSON.stringify([pathToFileURL(path).href]),
          ''
        ]);
      } catch {
        // Если интерфейс отсутствует, остаётся обычный выбор приложения ОС, с проверкой кода выхода.
        await run('xdg-open', [path]);
      }
      return;
    }
    const error = await nativeOpen(path);
    if (error) throw new Error(error);
  } catch (error) {
    throw new Error(applicationTexts.desktop.openFailed({ path, reason: (error as Error).message }), { cause: error });
  }
}
