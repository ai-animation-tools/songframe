/** Короткая сессия диагностики CLI: ограниченный вывод и обязательное завершение дочернего процесса. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface AccountProcessOptions {
  env: NodeJS.ProcessEnv;
  home: string;
  timeoutMs?: number;
}

const OUTPUT_LIMIT = 128 * 1024;

export async function withAccountProcess<T>(
  executable: string,
  args: string[],
  options: AccountProcessOptions,
  operation: (child: ChildProcessWithoutNullStreams, closed: Promise<number | null>, fail: () => void) => Promise<T>
): Promise<T> {
  const child = spawn(executable, args, { env: options.env, cwd: options.home, stdio: 'pipe', windowsHide: true });
  let rejectFailure!: (reason: Error) => void;
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  const fail = (): void => rejectFailure(new Error('Не удалось получить диагностику CLI.'));
  const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
  let bytes = 0;
  const count = (chunk: Buffer | string): void => {
    bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.length;
    if (bytes > OUTPUT_LIMIT) fail();
  };
  child.stdout.on('data', count);
  child.stderr.on('data', count);
  child.on('error', fail);
  child.stdin.on('error', fail);
  const timer = setTimeout(fail, options.timeoutMs ?? 10_000);
  try {
    return await Promise.race([operation(child, closed, fail), failure]);
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    // Даже старый CLI, который игнорирует EOF или SIGTERM, не остаётся фоновым сервером диагностики.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let endTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          endTimer = setTimeout(resolve, 150);
        }, 150);
      })
    ]);
    clearTimeout(killTimer);
    clearTimeout(endTimer);
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
  }
}

export async function readAccountCommand(executable: string, args: string[], options: AccountProcessOptions): Promise<unknown> {
  return withAccountProcess(executable, args, options, async (child, closed) => {
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stdin.end();
    if ((await closed) !== 0) throw new Error('Команда диагностики завершилась с ошибкой.');
    return JSON.parse(output);
  });
}

interface CodexAccountSnapshot {
  account?: unknown;
  rateLimits?: unknown;
  partial: boolean;
}

/** Короткая общая RPC-сессия только для чтения: без диалогов, генерации и обновления токенов. */
export async function withCodexAppServer<T>(
  executable: string,
  options: AccountProcessOptions,
  operation: (request: (method: 'account/read' | 'account/rateLimits/read' | 'model/list', params: Record<string, unknown>) => Promise<unknown>) => Promise<T>
): Promise<T> {
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  let stopped = false;
  const rejectPending = (): void => {
    for (const request of pending.values()) request.reject(new Error('Сессия диагностики закрыта.'));
    pending.clear();
  };
  try {
    return await withAccountProcess(executable, ['app-server', '--listen', 'stdio://'], options, async (child, closed, fail) => {
      let nextId = 0;
      let buffer = '';
      void closed.then(() => {
        stopped = true;
        rejectPending();
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (stopped) return;
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          try {
            const message: unknown = JSON.parse(line);
            if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
            const reply = message as Record<string, unknown>;
            if (typeof reply.id !== 'number') continue;
            const request = pending.get(reply.id);
            if (!request) continue;
            pending.delete(reply.id);
            if ('error' in reply || !('result' in reply)) request.reject(new Error('CLI не поддерживает запрос диагностики.'));
            else request.resolve(reply.result);
          } catch {
            rejectPending();
            fail();
          }
        }
      });
      const request = (method: string, params: Record<string, unknown>): Promise<unknown> => {
        if (stopped) return Promise.reject(new Error('Сессия диагностики закрыта.'));
        const id = ++nextId;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
        });
      };
      await request('initialize', { clientInfo: { name: 'songframe', title: 'SongFrame', version: '0.1.0' } });
      child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
      return operation(request);
    });
  } finally {
    stopped = true;
    // Освобождаем ожидающие RPC и при общем таймауте, когда ответа сервера уже не будет.
    rejectPending();
  }
}

/** Только штатные операции чтения аккаунта; каталог моделей использует тот же транспорт отдельно. */
export async function readCodexAccount(executable: string, options: AccountProcessOptions): Promise<CodexAccountSnapshot> {
  const snapshot: CodexAccountSnapshot = { partial: false };
  try {
    await withCodexAppServer(executable, options, async (request) => {
      try {
        snapshot.account = await request('account/read', { refreshToken: false });
      } catch {
        snapshot.partial = true;
      }
      try {
        snapshot.rateLimits = await request('account/rateLimits/read', {});
      } catch {
        snapshot.partial = true;
      }
    });
  } catch {
    snapshot.partial = true;
  }
  return snapshot;
}
