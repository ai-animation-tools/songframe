/** Проверяет доставку итогов через настоящую регистрацию IPC без открытой страницы и renderer-подписок. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentJob } from '@shared/agents';
import type { AgentManager } from './agent-manager';
import { createServices, registerIpc, type Services } from './ipc';
import { PythonLauncher } from './python-launcher';
import { TaskNotifications, type TaskNotice } from './task-notifications';

const electron = vi.hoisted(() => ({
  root: '',
  handlers: new Map<string, Parameters<typeof ipcMain.handle>[1]>()
}));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => electron.root, getPath: () => electron.root },
  BrowserWindow: {},
  dialog: {},
  shell: {},
  nativeImage: {},
  ipcMain: {
    handle: (channel: string, handler: Parameters<typeof ipcMain.handle>[1]) => electron.handlers.set(channel, handler),
    on: vi.fn()
  }
}));

let work: string;
let project: string;
let services: Services;
let emitAgent: (event: AgentEvent) => void;
let deliver: ReturnType<typeof vi.fn<(notice: TaskNotice) => void>>;

function invoke(channel: string, ...args: unknown[]): unknown {
  return electron.handlers.get(channel)!({} as Electron.IpcMainInvokeEvent, ...args);
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-notification-ipc-'));
  electron.root = work;
  electron.handlers.clear();
  vi.stubEnv('SONGFRAME_LOCAL_DIR', join(work, 'local'));
  mkdirSync(join(work, 'tools'));
  writeFileSync(join(work, 'tools/common.py'), '');
  project = join(work, 'clip');
  mkdirSync(join(project, 'source'), { recursive: true });
  writeFileSync(join(project, 'source/text.md'), '[Куплет]\nПервая строка\nВторая строка\n');
  vi.spyOn(PythonLauncher.prototype, 'runtime').mockReturnValue({
    source: 'system-dev',
    version: '3.12',
    command: 'python',
    argsPrefix: [],
    env: {},
    cwd: work
  });
  vi.spyOn(PythonLauncher.prototype, 'run').mockResolvedValue({ code: 0, stdout: '', stderr: '', command: 'test' });
  deliver = vi.fn();
  services = createServices(false);
  services.agents = {
    onEvent: (listener: typeof emitAgent) => {
      emitAgent = listener;
      return () => undefined;
    }
  } as AgentManager;
  services.notifications = new TaskNotifications(deliver);
  registerIpc(
    () => services,
    (next) => {
      services = next;
    }
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(work, { recursive: true, force: true });
});

describe('доставка уведомлений из IPC', () => {
  it('объясняет отсутствие текста до запуска распознавания', async () => {
    // Файл может исчезнуть уже после открытия диалога; IPC не должен отдавать ENOENT или запускать инструмент.
    rmSync(join(project, 'source/text.md'));
    await expect(invoke('timing:generate', project, { recognition: 'recognition.json' })).rejects.toThrow(
      'Сначала добавьте текст песни на странице «Исходники».'
    );
    expect(PythonLauncher.prototype.run).not.toHaveBeenCalled();
  });

  it('получает завершения Jobs и агента без renderer-подписчика, не повторяя итог агента', async () => {
    const job = services.jobs.start('review', 'Проба', project, [{ tool: 'build_review', args: [] }]);
    await vi.waitFor(() => expect(job.status).toBe('done'));
    const agent: AgentJob = {
      schemaVersion: 1,
      id: 'agent-test',
      sequence: 1,
      project,
      provider: 'codex',
      task: 'ai-clip-scenario:test',
      permissions: 'read-only',
      inputHashes: { prompt: '', context: '' },
      status: 'completed',
      phase: 'completed',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      result: '',
      log: ''
    };
    const event: AgentEvent = { jobId: agent.id, project, sequence: 1, phase: 'completed', type: 'completed', job: agent };
    emitAgent(event);
    emitAgent(event);
    expect(deliver.mock.calls.map(([notice]) => notice.target)).toEqual([
      { project, route: '/project/checks' },
      { project, route: '/project/scenario' }
    ]);
  });

  it('сообщает ровно один итог разметки по code и возвращает исходный результат', async () => {
    for (const code of [0, 2, null]) {
      deliver.mockClear();
      const result = { code, stdout: 'результат', stderr: '', command: 'test' };
      vi.mocked(PythonLauncher.prototype.run).mockResolvedValueOnce(result);
      await expect(invoke('timing:generate', project, { recognition: 'recognition.json' })).resolves.toBe(result);
      expect(deliver).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          title: code === 0 ? 'Черновик разметки готов' : 'Ошибка разметки',
          target: { project, route: '/project/timing' }
        })
      );
    }
  });

  it('сохраняет исходное исключение разметки даже при ошибке доставки уведомления', async () => {
    const failure = new Error('Распознавание недоступно');
    vi.mocked(PythonLauncher.prototype.run).mockRejectedValueOnce(failure);
    deliver.mockImplementation(() => {
      throw new Error('Служба уведомлений недоступна');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(invoke('timing:generate', project, { recognition: 'recognition.json' })).rejects.toBe(failure);
    expect(deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: 'Ошибка разметки' }));
  });

  it('сохраняет службу уведомлений и завершения старых Jobs после смены корня, подключая новые Jobs', async () => {
    const previous = services;
    let finish!: (value: Awaited<ReturnType<PythonLauncher['run']>>) => void;
    vi.mocked(PythonLauncher.prototype.run).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const oldJob = services.jobs.start('review', 'Проба', project, [{ tool: 'build_review', args: [] }]);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const nextRoot = join(work, 'next');
    mkdirSync(join(nextRoot, 'tools'), { recursive: true });
    writeFileSync(join(nextRoot, 'tools/common.py'), '');
    invoke('app:setToolsRoot', nextRoot);
    expect(services.toolsRoot).toBe(nextRoot);
    expect(services.notifications).toBe(previous.notifications);
    expect(services.agents).toBe(previous.agents);
    expect(services.jobs).not.toBe(previous.jobs);
    finish({ code: 0, stdout: '', stderr: '', command: 'test' });
    await vi.waitFor(() => expect(oldJob.status).toBe('done'));
    const newJob = services.jobs.start('animatic', 'Аниматик', project, [{ tool: 'build_animatic', args: [] }]);
    await vi.waitFor(() => expect(newJob.status).toBe('done'));
    expect(deliver.mock.calls.map(([notice]) => notice.target.route)).toEqual(['/project/checks', '/project/animatic']);
  });
});
