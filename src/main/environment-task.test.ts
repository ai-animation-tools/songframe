/** Настоящие worker-потоки изолируют синхронную диагностику и завершаются при ошибке или таймауте. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EnvironmentCheck } from '@shared/types';
import { runEnvironmentTask } from './environment-task';

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-environment-worker-'));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function fixture(body: string): string {
  const path = join(work, 'worker.cjs');
  // Plain CJS исполняется настоящим Node Worker без сборщика и замены Worker тестовой реализацией.
  writeFileSync(
    path,
    `const { parentPort, workerData } = require('node:worker_threads');
try {
${body}
} finally {
  parentPort.close();
}
`
  );
  return path;
}

describe('задача диагностики в отдельном потоке', () => {
  it('оставляет главный event loop свободным во время CPU-цикла, передаёт входы, прогресс и порядок результата', async () => {
    const workerFile = fixture(`
const first = { id: 'node', label: 'Node.js', ok: true, detail: workerData.options.env.SONGFRAME_TEST_MARKER, productionOnly: true };
const second = { id: 'python', label: 'Python', ok: true, detail: workerData.toolsRoot, productionOnly: true };
parentPort.postMessage({ type: 'progress', check: first });
const end = performance.now() + 200;
while (performance.now() < end) {}
parentPort.postMessage({ type: 'progress', check: second });
parentPort.postMessage({ type: 'result', checks: [second, first] });
`);
    const events: string[] = [];
    const progress: EnvironmentCheck[] = [];
    let finished = false;
    let tick!: () => void;
    const mainTick = new Promise<void>((resolve) => {
      tick = resolve;
    });
    const pending = runEnvironmentTask(
      work,
      { toolsRoot: work, env: { SONGFRAME_TEST_MARKER: 'Окружение передано' } },
      (check) => {
        events.push(`progress:${check.id}`);
        progress.push(check);
        if (check.id === 'node') {
          setTimeout(() => {
            events.push('main-timer');
            tick();
          }, 0);
        }
      },
      { workerFile }
    ).then((checks) => {
      finished = true;
      events.push('result');
      return checks;
    });
    try {
      await mainTick;
      expect(finished).toBe(false);
      const checks = await pending;
      expect(progress.map(({ id }) => id)).toEqual(['node', 'python']);
      expect(checks).toEqual([progress[1], progress[0]]);
      expect(checks[0].detail).toBe(work);
      expect(checks[1].detail).toBe('Окружение передано');
      expect(events).toEqual(['progress:node', 'main-timer', 'progress:python', 'result']);
    } finally {
      await pending.catch(() => undefined);
    }
  });

  it('отклоняет задачу при настоящем исключении worker', async () => {
    const workerFile = fixture(`throw new Error('Ошибка тестового worker');`);
    await expect(runEnvironmentTask(null, { toolsRoot: null }, undefined, { workerFile })).rejects.toThrow('Ошибка тестового worker');
  });

  it('не принимает чистый выход worker без сообщения результата за успешную диагностику', async () => {
    const workerFile = fixture(`parentPort.postMessage({ type: 'progress', check: { id: 'node', label: 'Node.js', ok: true, detail: 'готово' } });`);
    const progress: EnvironmentCheck[] = [];
    await expect(runEnvironmentTask(null, { toolsRoot: null }, (check) => progress.push(check), { workerFile })).rejects.toThrow(
      'Проверка среды завершилась без результата (код 0).'
    );
    expect(progress.map(({ id }) => id)).toEqual(['node']);
  });

  it('по короткому таймауту прерывает CPU-worker, а не только отклоняет его Promise', async () => {
    const heartbeat = join(work, 'heartbeat');
    const stop = join(work, 'stop');
    const workerFile = fixture(`
const fs = require('node:fs');
const { SONGFRAME_TEST_HEARTBEAT, SONGFRAME_TEST_STOP } = workerData.options.env;
let next = 0;
let count = 0;
const end = Date.now() + 2500;
while (Date.now() < end && !fs.existsSync(SONGFRAME_TEST_STOP)) {
  if (Date.now() >= next) {
    fs.writeFileSync(SONGFRAME_TEST_HEARTBEAT, String(++count));
    next = Date.now() + 10;
  }
}
`);
    const started = performance.now();
    try {
      await expect(
        runEnvironmentTask(null, { toolsRoot: null, env: { SONGFRAME_TEST_HEARTBEAT: heartbeat, SONGFRAME_TEST_STOP: stop } }, undefined, {
          workerFile,
          timeoutMs: 40
        })
      ).rejects.toThrow('Превышено время проверки среды. Повторите проверку.');
      // Широкий предел проверяет завершение таймаутом, не скорость запуска процессов на конкретной ОС.
      expect(performance.now() - started).toBeLessThan(2000);
      await delay(40);
      const before = existsSync(heartbeat) ? readFileSync(heartbeat, 'utf8') : null;
      await delay(80);
      expect(existsSync(heartbeat) ? readFileSync(heartbeat, 'utf8') : null).toBe(before);
    } finally {
      // Если terminate сломается, тест всё равно останавливает цикл; собственный предел не оставляет вечный поток.
      writeFileSync(stop, 'stop');
      await delay(40);
    }
  });
});
