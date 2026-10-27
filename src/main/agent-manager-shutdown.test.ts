/** Удаление временной папки дожидается CLI, в том числе во время диагностики до spawn. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCheckResult } from '@shared/agents';
import { AgentManager } from './agent-manager';
import type { AgentAdapter } from './agent-adapters';
import { SettingsStore } from './settings';

let root: string;
let project: string;
let settings: SettingsStore;
let managers: AgentManager[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'songframe-shutdown-test-'));
  project = join(root, 'project');
  mkdirSync(join(project, 'plan'), { recursive: true });
  writeFileSync(join(project, 'plan/project.json'), '{}');
  settings = new SettingsStore(join(root, 'state'));
  settings.saveAgent({ provider: 'codex' });
  managers = [];
});
afterEach(async () => {
  await Promise.all(managers.map((manager) => manager.shutdownAndWait()));
  rmSync(root, { recursive: true, force: true });
});
function create(check: AgentAdapter['check'], script: string): AgentManager {
  const manager = new AgentManager(settings, {
    adapter: () => ({
      check,
      args: () => [script],
      parse: () => [],
      account: async () => {
        throw new Error('Не используется в тесте.');
      }
    })
  });
  managers.push(manager);
  return manager;
}
const available: AgentCheckResult = {
  executablePath: process.execPath,
  version: '0.159.2',
  availability: 'available',
  authorization: 'authenticated',
  message: 'Готов'
};

describe.skipIf(process.platform !== 'linux')('Ожидание завершения менеджера', () => {
  it('возвращается только после фактического закрытия дочернего процесса', async () => {
    const script = join(root, 'fake.cjs');
    const pidFile = join(root, 'pid');
    writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const manager = create(async () => available, script);
    manager.start({ project, task: 'Обложка', prompt: 'Тест отмены' });
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await manager.shutdownAndWait();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(manager.list()[0].status).toBe('interrupted');
  });

  it('дожидается незавершённой диагностики и не запускает CLI после отмены', async () => {
    let finishCheck: ((value: AgentCheckResult) => void) | undefined;
    const script = join(root, 'fake.cjs');
    const marker = join(root, 'started');
    writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'Недопустимый запуск');`);
    const manager = create(
      () =>
        new Promise((finish) => {
          finishCheck = finish;
        }),
      script
    );
    manager.start({ project, task: 'Обложка', prompt: 'Тест отмены диагностики' });
    let stopped = false;
    const closing = manager.shutdownAndWait().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finishCheck!(available);
    await closing;
    expect(stopped).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});
