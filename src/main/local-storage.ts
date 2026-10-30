/** Подготавливает постоянный каталог состояния приложения. */
import { localFilesTexts } from '@shared/texts/local-files';
import { mkdirSync } from 'node:fs';

export function initializeLocalStorage(localDir: string): void {
  try {
    mkdirSync(localDir, { recursive: true });
  } catch (error) {
    throw new Error(localFilesTexts.main.storageUnavailable({ path: localDir, reason: (error as Error).message }), { cause: error });
  }
}
