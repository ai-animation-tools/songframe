/** Диагностика запускает процессы и читает библиотеки вне главного потока, включая медленный Windows CreateProcess. */
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { EnvironmentCheck } from '@shared/types';
import type { PythonOptions } from './python-runtime';

export interface EnvironmentWorkerInput {
  toolsRoot: string | null;
  options: PythonOptions;
}

export type EnvironmentWorkerMessage =
  { type: 'progress'; check: EnvironmentCheck } | { type: 'result'; checks: EnvironmentCheck[] } | { type: 'error'; message: string };

/** Отдельный путь нужен адресному тесту с действительно заблокированным worker, без запуска тяжёлых библиотек. */
export function runEnvironmentTask(
  toolsRoot: string | null,
  options: PythonOptions,
  onProgress?: (check: EnvironmentCheck) => void,
  execution: { workerFile?: string; timeoutMs?: number } = {}
): Promise<EnvironmentCheck[]> {
  return new Promise((resolve, reject) => {
    const workerData: EnvironmentWorkerInput = { toolsRoot, options };
    const worker = new Worker(execution.workerFile ?? join(__dirname, 'environment-worker.js'), { workerData });
    let settled = false;
    const finish = (error: Error | null, checks: EnvironmentCheck[] = []): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        void worker.terminate();
        reject(error);
      } else resolve(checks);
    };
    const timer = setTimeout(() => finish(new Error('Превышено время проверки среды. Повторите проверку.')), execution.timeoutMs ?? 180000);
    worker.on('message', (message: EnvironmentWorkerMessage) => {
      if (settled) return;
      if (message.type === 'progress') onProgress?.(message.check);
      else if (message.type === 'result') finish(null, message.checks);
      else if (message.type === 'error') finish(new Error(message.message));
    });
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => {
      if (!settled) finish(new Error(`Проверка среды завершилась без результата (код ${code}).`));
    });
  });
}
