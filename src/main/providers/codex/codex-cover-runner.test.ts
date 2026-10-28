/** Исполнитель обложки Codex: фиксированный промпт, явная модель и временный проект без запуска настоящего агента. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentJob, AgentSettings, AgentStartInput } from '@shared/agents';
import type { CoverManager } from '../../cover-generation';
import type { SettingsStore } from '../../settings';
import { createCodexCoverRunner } from './codex-cover-runner';

let root: string;
let workDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'songframe-codex-cover-'));
  workDir = join(root, 'image-jobs', 'attempt');
  mkdirSync(workDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface Call {
  input: AgentStartInput;
  workDir: string;
  config: AgentSettings;
  settings: SettingsStore;
}
function fakeManager(result: string, calls: Call[]): (settings: SettingsStore) => CoverManager {
  return (settings: SettingsStore): CoverManager => {
    let job: AgentJob;
    return {
      startImages: (input, directory, config) => {
        calls.push({ input, workDir: directory, config, settings });
        job = { id: 'job', status: 'completed', exitCode: 0, result } as AgentJob;
        return job;
      },
      get: () => job,
      onEvent: (_listener: (event: AgentEvent) => void) => () => undefined,
      shutdownAndWait: async () => undefined
    };
  };
}

describe('обложка Codex', () => {
  it('передаёт фиксированный промпт, пользовательский контекст и закреплённую модель во временный проект', async () => {
    const calls: Call[] = [];
    const config = { provider: 'codex' as const, model: 'cover-model' };
    const runner = createCodexCoverRunner({ config, createManager: fakeManager('{"path":"cover.png"}', calls) });
    expect(await runner({ workDir, project: '/fixture/project', prompt: '  Ёж у костра  ', signal: new AbortController().signal })).toEqual({
      path: 'cover.png'
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.config).toBe(config);
    expect(call.workDir).toBe(workDir);
    expect(call.input.project).toBe(root);
    expect(call.input.prompt).toContain('image_gen');
    expect(call.input.context).toBe(JSON.stringify({ userPrompt: '  Ёж у костра  ' }));
    // История и настройки временного проекта остаются в папке обложки.
    expect(call.settings.localDir).toBe(root);
    expect(readFileSync(join(root, 'plan/project.json'), 'utf8')).toBe('{}');
    expect(existsSync('/fixture/project')).toBe(false);
  });

  it.each(['не JSON', '{"path":1}', '{"path":"cover.png","extra":true}'])('отклоняет неверный финальный ответ %s', async (result) => {
    const runner = createCodexCoverRunner({ config: { provider: 'codex' }, createManager: fakeManager(result, []) });
    await expect(runner({ workDir, project: root, prompt: 'Обложка', signal: new AbortController().signal })).rejects.toThrow(/Агент/);
  });

  it('не запускает заранее отменённую генерацию', async () => {
    const calls: Call[] = [];
    const runner = createCodexCoverRunner({ config: { provider: 'codex' }, createManager: fakeManager('{"path":"cover.png"}', calls) });
    await expect(runner({ workDir, project: root, prompt: 'Обложка', signal: AbortSignal.abort() })).rejects.toThrow(/остановлена/);
    expect(calls).toEqual([]);
  });
});
