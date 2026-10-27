/** Подготавливает постоянный каталог состояния приложения. */
import { mkdirSync } from 'node:fs';

export function initializeLocalStorage(localDir: string): void {
  try {
    mkdirSync(localDir, { recursive: true });
  } catch (error) {
    throw new Error(`Не удалось подготовить локальное состояние (${localDir}): ${(error as Error).message}`, { cause: error });
  }
}
