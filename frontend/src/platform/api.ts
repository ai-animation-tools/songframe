import type { Api } from '@shared/api';
import type { AppState } from '@shared/types';
import { platformTexts } from '@shared/texts/platform';
import { unavailableApi, type ApiMethod } from './unavailable-api';

export type { ApiMethod } from './unavailable-api';

/** Транспорт подменяется только в тестах: рабочий вариант использует сгенерированные bindings Go. */
export interface ShellTransport {
  state(): Promise<AppState>;
  frontendReady(): Promise<void>;
}

/** Ошибка сохраняет технический код и метод для диагностики, не превращая отказ в успешную пустую выдачу. */
export class ApiError extends Error {
  constructor(
    public readonly code: 'UNAVAILABLE' | 'INVALID_RESPONSE' | 'TIMEOUT' | 'CONNECTION_FAILED' | 'SERVICE_FAILED',
    public readonly method: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'ApiError';
  }
}

/** Доступность принадлежит адаптеру, поэтому UI не повторяет собственный список готовых Go-операций. */
export function methodAvailability(method: ApiMethod): { available: boolean; reason: string | null } {
  return method === 'app.state' ? { available: true, reason: null } : { available: false, reason: platformTexts.unavailable };
}

/** Таймаут ограничивает ожидание оболочки; поздний результат не отменяет показанную ошибку и не меняет UI. */
export async function withDeadline<T>(operation: () => Promise<T>, method: string, milliseconds = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ApiError('TIMEOUT', method, platformTexts.timeout)), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Формы методов сохранены, но неподдержанные вызовы отвергаются до транспорта. Sync-методы остаются sync. */
export function createApi(transport: ShellTransport): Api {
  const fail = (method: ApiMethod): never => {
    throw new ApiError('UNAVAILABLE', method, platformTexts.unavailable);
  };
  const api = unavailableApi(async (method) => fail(method), fail);
  api.app.state = () => withDeadline(() => transport.state(), 'app.state');
  return api;
}

/** Bindings загружаются при первом вызове: Storybook и unit-тесты не запускают настоящий Wails runtime. */
const nativeTransport: ShellTransport = {
  async state() {
    try {
      const bindings = await import('../../bindings/songframe-go/internal/app/shellservice');
      const raw = await bindings.State();
      if (!raw || typeof raw !== 'object') throw new ApiError('INVALID_RESPONSE', 'app.state', platformTexts.invalidResponse);
      const platform = raw.platform;
      // Go slices допускают null на уровне generated DTO; проектный контракт требует реальные массивы.
      if (
        typeof raw.packaged !== 'boolean' ||
        typeof raw.localDir !== 'string' ||
        !raw.localDir ||
        !Array.isArray(raw.problems) ||
        !raw.problems.every((value) => typeof value === 'string') ||
        !Array.isArray(raw.history) ||
        !raw.history.every(
          (item) =>
            item !== null &&
            typeof item === 'object' &&
            typeof item.path === 'string' &&
            typeof item.name === 'string' &&
            typeof item.lastOpened === 'string' &&
            typeof item.exists === 'boolean'
        ) ||
        !(raw.current === null || typeof raw.current === 'string') ||
        !(raw.toolsRoot === null || typeof raw.toolsRoot === 'string') ||
        !(platform === 'linux' || platform === 'win32' || platform === 'darwin')
      ) {
        throw new ApiError('INVALID_RESPONSE', 'app.state', platformTexts.invalidResponse);
      }
      return { ...raw, problems: raw.problems, history: raw.history, platform } satisfies AppState;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Wails RuntimeError — ответ работающего сервиса; сохраняем причину диска/профиля для восстановления.
      if (error instanceof Error && error.name === 'RuntimeError') {
        throw new ApiError('SERVICE_FAILED', 'app.state', error.message, { cause: error });
      }
      throw new ApiError('CONNECTION_FAILED', 'app.state', platformTexts.connectionFailed, { cause: error });
    }
  },
  async frontendReady() {
    const bindings = await import('../../bindings/songframe-go/internal/app/shellservice');
    await bindings.FrontendReady();
  }
};

/** Единственная установка window.api; код UI не получает файловую систему или возможность запускать процессы. */
export function installApi(): void {
  window.api = createApi(nativeTransport);
}

/** Подтверждает React mount после State; обычный запуск ничего не закрывает, smoke завершает нативную проверку. */
export function signalFrontendReady(): Promise<void> {
  return withDeadline(() => nativeTransport.frontendReady(), 'frontendReady');
}

declare global {
  interface Window {
    api: Api;
  }
}
