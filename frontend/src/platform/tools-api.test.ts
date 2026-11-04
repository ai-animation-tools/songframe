/**
 * Адаптер группы tools: tools.run перенесён в Go (scene_scaffold выполняется в процессе
 * приложения), ToolResult возвращается как есть, отказ Go-сервиса показывается своим текстом.
 * Bindings подменяются целиком: Wails runtime и Go не запускаются.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ToolResult } from '@shared/types';
import { createApi, methodAvailability, type Bindings } from './api';

function bindings(tools: Record<string, unknown>): Bindings {
  const missing = async () => {
    throw new Error('binding не настроен в тесте');
  };
  return {
    app: missing,
    shell: missing,
    native: missing,
    components: missing,
    jobs: missing,
    projects: missing,
    timing: missing,
    sources: missing,
    cast: missing,
    scenario: missing,
    tools: async () => tools as never,
    checks: missing,
    agents: missing,
    ai: missing,
    scenarioWorkflow: missing,
    videoReview: missing,
    events: async () => ({ on: () => () => undefined })
  } as Bindings;
}

describe('window.api.tools', () => {
  it('tools.run перенесён в Go', () => {
    expect(methodAvailability('tools.run')).toEqual({ available: true, reason: null });
  });

  it('передаёт проект, имя и аргументы и возвращает ToolResult Go без изменений', async () => {
    const result: ToolResult = {
      code: 1,
      stdout: '',
      stderr: 'plan/scenes.json уже существует: добавьте --force, чтобы заменить его каркасом (постановка будет потеряна).\n',
      command: '"scene_scaffold" "--project" "/клип" "--json"'
    };
    const Run = vi.fn(async () => result);
    const api = createApi(bindings({ Run }));
    await expect(api.tools.run('/клип', 'scene_scaffold', ['--json'])).resolves.toBe(result);
    expect(Run).toHaveBeenCalledWith('/клип', 'scene_scaffold', ['--json']);
  });

  it('показывает отказ Go-сервиса его текстом', async () => {
    const error = Object.assign(new Error('Инструмент update_scene_views ещё не перенесён в Go-версию SongFrame.'), { name: 'RuntimeError' });
    const api = createApi(bindings({ Run: async () => Promise.reject(error) }));
    await expect(api.tools.run('/клип', 'update_scene_views', [])).rejects.toMatchObject({ code: 'SERVICE_FAILED', message: error.message });
  });
});
