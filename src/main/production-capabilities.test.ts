/** Статус инструментов до создания сценария совпадает со статусом в готовом проекте. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { viewProduction } from './production';
import { PythonLauncher } from './python-launcher';
import { registerTestMediaProvider, TEST_PROVIDER, testPaidAdapter } from './testing/media-provider';

let work: string;
let project: string;
let restoreProvider: () => void;
const installed = vi.fn(() => true);

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-production-capabilities-'));
  project = join(work, 'project');
  mkdirSync(project);
  installed.mockReset().mockReturnValue(true);
  restoreProvider = registerTestMediaProvider({ ...testPaidAdapter, installed });
});

afterEach(() => {
  restoreProvider();
  vi.restoreAllMocks();
  rmSync(work, { recursive: true, force: true });
});

function launcher(python: boolean): PythonLauncher {
  const result = new PythonLauncher({ toolsRoot: null, packaged: true, resourcesPath: join(work, 'resources') });
  vi.spyOn(result, 'available').mockReturnValue(python);
  return result;
}

function createScenario(): void {
  mkdirSync(join(project, 'plan'));
  writeFileSync(join(project, 'plan/scenes.json'), JSON.stringify({ fps: 30, sequences: [], scenes: [] }));
}

describe('Доступность инструментов производства', () => {
  it.each([true, false])('видит программу платного провайдера до сценария независимо от Python (%s)', (python) => {
    const runtime = launcher(python);
    const before = viewProduction(project, runtime);
    expect(before.tools.python).toBe(python);
    expect(before.tools.providers[TEST_PROVIDER]).toBe(true);
    expect(installed).toHaveBeenCalledWith(runtime.options);
    expect(before.problems).toEqual(['Сначала нужен сценарий. Создайте его на странице «Сценарий».']);

    createScenario();
    const after = viewProduction(project, runtime);
    expect(after.tools).toEqual(before.tools);
    expect(after.problems).toEqual([]);
  });

  it('показывает отсутствующую программу провайдера одинаково до и после сценария', () => {
    installed.mockReturnValue(false);
    const runtime = launcher(true);
    const before = viewProduction(project, runtime);
    expect(before.tools.providers[TEST_PROVIDER]).toBe(false);

    createScenario();
    expect(viewProduction(project, runtime).tools).toEqual(before.tools);
  });
});
