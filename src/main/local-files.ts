/** Чтение и атомарная запись локальных JSON: сбой не должен обнулять настройки или историю. */
import { localFilesTexts } from '@shared/texts/local-files';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function readLocalJson<T>(path: string): T | null {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (data === null || typeof data !== 'object') throw new Error(localFilesTexts.main.objectExpected);
    return data as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(localFilesTexts.main.readFailed({ path, reason: (error as Error).message }), {
      cause: error
    });
  }
}

export function writeAtomicText(path: string, text: string, mode?: number): void {
  writeAtomicBytes(path, Buffer.from(text, 'utf8'), mode);
}

/** Та же замена целого файла для изображений карточек и резервных копий предложения. */
export function writeAtomicBytes(path: string, data: Uint8Array, mode?: number): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Сохраняем права существующего файла, если это не новый исполняемый launcher.
    const permissions =
      mode ??
      (() => {
        try {
          return statSync(path).mode & 0o777;
        } catch {
          return 0o600;
        }
      })();
    writeFileSync(temporary, data, { mode: permissions, flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) {
    throw new Error(localFilesTexts.main.writeFailed({ path, reason: (error as Error).message }), { cause: error });
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function writeLocalJson(path: string, data: unknown): void {
  writeAtomicText(path, JSON.stringify(data, null, 2) + '\n');
}
