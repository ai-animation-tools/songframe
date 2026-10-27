/** Самостоятельная точка входа worker: Electron API здесь не используются. */
import { parentPort, workerData } from 'node:worker_threads';
import { checkEnvironment } from './environment';
import { PythonLauncher } from './python-launcher';
import type { EnvironmentWorkerInput, EnvironmentWorkerMessage } from './environment-task';

const input = workerData as EnvironmentWorkerInput;
const send = (message: EnvironmentWorkerMessage): void => {
  parentPort!.postMessage(message);
};

void checkEnvironment(input.toolsRoot, new PythonLauncher(input.options), (check) => send({ type: 'progress', check }))
  .then((checks) => send({ type: 'result', checks }))
  .catch((error: unknown) => send({ type: 'error', message: error instanceof Error ? error.message : String(error) }))
  .finally(() => parentPort!.close());
