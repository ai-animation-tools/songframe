/** Статус инструментов до создания сценария совпадает со статусом в готовом проекте. */
import { spawnSync } from 'node:child_process';
import type * as childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { viewProduction } from './production';
import { PythonLauncher } from './python-launcher';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawnSync: vi.fn(() => {
    throw new Error('Этот просмотр не должен запускать внешний процесс.');
  })
}));

let work: string;
let project: string;
let resourcesPath: string;

beforeEach(() => {
  vi.stubEnv('SONGFRAME_KLING_CLI', undefined);
  work = mkdtempSync(join(tmpdir(), 'songframe-production-capabilities-'));
  project = join(work, 'project');
  resourcesPath = join(work, 'resources');
  mkdirSync(project);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  rmSync(work, { recursive: true, force: true });
});

function launcher(python: boolean): PythonLauncher {
  const result = new PythonLauncher({ toolsRoot: null, packaged: true, resourcesPath });
  vi.spyOn(result, 'available').mockReturnValue(python);
  return result;
}

function bundle(): void {
  const root = join(resourcesPath, 'kling');
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@klingai/cli-global', version: '0.2.3' }));
  writeFileSync(join(root, 'dist/cli.js'), '// Тестовая поставка, выполнение не требуется.');
}

function createScenario(): void {
  mkdirSync(join(project, 'plan'));
  writeFileSync(join(project, 'plan/scenes.json'), JSON.stringify({ fps: 30, sequences: [], scenes: [] }));
}

describe('Доступность инструментов производства', () => {
  it.each([true, false])('видит встроенный Kling до сценария независимо от Python (%s)', (python) => {
    bundle();
    const runtime = launcher(python);
    const before = viewProduction(project, runtime);
    expect(before.tools).toEqual({ python, kling: true });
    expect(before.problems).toEqual(['Сначала нужен сценарий. Создайте его на странице «Сценарий».']);

    createScenario();
    const after = viewProduction(project, runtime);
    expect(after.tools).toEqual(before.tools);
    expect(after.problems).toEqual([]);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('показывает отсутствующий packaged CLI одинаково до и после сценария', () => {
    const runtime = launcher(true);
    const before = viewProduction(project, runtime);
    expect(before.tools).toEqual({ python: true, kling: false });

    createScenario();
    expect(viewProduction(project, runtime).tools).toEqual(before.tools);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('сохраняет явный SONGFRAME_KLING_CLI без встроенной поставки и без запуска CLI', () => {
    vi.stubEnv('SONGFRAME_KLING_CLI', join(work, 'custom-kling'));
    const runtime = launcher(true);
    const before = viewProduction(project, runtime);
    expect(before.tools).toEqual({ python: true, kling: true });

    createScenario();
    expect(viewProduction(project, runtime).tools).toEqual(before.tools);
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
