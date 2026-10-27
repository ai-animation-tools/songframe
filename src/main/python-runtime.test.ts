/** Выбор поставки и общий контракт запуска без зависимости тестов от установленного Python. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Jobs } from './jobs';
import { resolvePaths } from './paths';
import { PythonLauncher } from './python-launcher';
import { pythonEnv, resolvePython } from './python-runtime';
import { runTool } from './tools';
import { checkEnvironment } from './environment';

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-python-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(work, { recursive: true, force: true });
});

function bundle(target = `${process.platform}-${process.arch}`): string {
  const root = join(work, 'Поставка с пробелами', 'runtime');
  const executable = join(root, 'python', target.startsWith('win32') ? 'python.exe' : 'bin/python3');
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, '');
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ target, python: '3.12.15' }));
  return root;
}

/** Подставной процесс на Node проверяет launcher на любой ОС, не маскируя отсутствие настоящего runtime smoke. */
function fakeLauncher(code: string, name = 'probe'): PythonLauncher {
  const script = join(work, 'tools', name, `${name}.py`);
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, code);
  const launcher = new PythonLauncher({ toolsRoot: work });
  vi.spyOn(launcher, 'runtime').mockReturnValue({
    command: process.execPath,
    argsPrefix: [],
    cwd: work,
    env: { ...process.env },
    source: 'system-dev',
    version: 'test'
  });
  return launcher;
}

describe('переносимый Python', () => {
  it('берёт resourcesPath для обеих платформ, независимо от PATH и checkout', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const root = bundle(`${platform}-x64`);
      const runtime = resolvePython({ toolsRoot: work, packaged: true, resourcesPath: dirname(root), platform, arch: 'x64', env: { PATH: '' } });
      expect(runtime.command).toBe(join(root, 'python', platform === 'win32' ? 'python.exe' : 'bin/python3'));
      expect(runtime.source).toBe('bundled');
      expect(runtime.argsPrefix).toEqual(['-B', '-X', 'utf8']);
      expect(runtime.env.PYTHONUTF8).toBe('1');
    }
  });

  it('не ищет системный fallback при отсутствующем, чужом или повреждённом комплекте', () => {
    const options = { toolsRoot: work, packaged: true, resourcesPath: work };
    expect(() => resolvePython(options)).toThrow('Встроенный Python недоступен');
    const root = bundle('other-arch');
    expect(() => resolvePython({ ...options, resourcesPath: dirname(root) })).toThrow('не подходит');
    writeFileSync(join(root, 'manifest.json'), '{');
    expect(() => resolvePython({ ...options, resourcesPath: dirname(root) })).toThrow('Встроенный Python недоступен');
  });

  it('видит исправление после ошибки без перезапуска процесса', () => {
    const options = { toolsRoot: work, packaged: true, resourcesPath: join(work, 'Поставка с пробелами') };
    const launcher = new PythonLauncher(options);
    expect(launcher.available()).toBe(false);
    bundle();
    expect(launcher.available()).toBe(true);
  });

  it('не наследует чужой Python и сохраняет пользовательские параметры инструментов', () => {
    const env = pythonEnv({
      toolsRoot: work,
      localDir: work,
      env: { PYTHONHOME: '/old', PYTHONPATH: '/old', VIRTUAL_ENV: '/old', SystemRoot: 'C:\\Windows', SONGFRAME_KLING_CLI: 'fake' }
    });
    expect(env.PYTHONHOME).toBeUndefined();
    expect(env.PYTHONPATH).toBeUndefined();
    expect(env.VIRTUAL_ENV).toBeUndefined();
    expect(env).toMatchObject({ SystemRoot: 'C:\\Windows', SONGFRAME_KLING_CLI: 'fake', PYTHONNOUSERSITE: '1', SONGFRAME_LOCAL_DIR: work });
  });

  it('отделяет packaged-ресурсы от записываемого состояния и override разработчика', () => {
    mkdirSync(join(work, 'resources/tools'), { recursive: true });
    writeFileSync(join(work, 'resources/tools/common.py'), '');
    const paths = resolvePaths({
      appPath: '/missing',
      execPath: '/missing/app',
      cwd: '/missing',
      userData: join(work, 'user'),
      packaged: true,
      resourcesPath: join(work, 'resources'),
      override: '/old-checkout'
    });
    expect(paths).toMatchObject({ toolsRoot: join(work, 'resources'), resourcesRoot: join(work, 'resources'), localDir: join(work, 'user') });
  });

  it('диагностика показывает ошибку запуска самого встроенного Python и не предлагает pip', async () => {
    const root = bundle();
    const checks = await checkEnvironment(work, new PythonLauncher({ toolsRoot: work, packaged: true, resourcesPath: dirname(root) }));
    expect(checks.find((c) => c.id === 'python')).toMatchObject({ label: 'Встроенный Python', ok: false });
    expect(checks.find((c) => c.id === 'python')?.hint).not.toContain('pip');
  });
});

describe('общий launcher', () => {
  it('сохраняет кириллицу, аргументы с пробелами и одинаковый результат runTool/Jobs', async () => {
    const launcher = fakeLauncher("console.log(JSON.stringify(process.argv.slice(2))); console.error('Ошибка импорта PIL'); process.exitCode = 2;");
    const project = join(work, 'Клип с пробелами');
    const result = await runTool(work, project, 'probe', ['--value', 'текст с пробелами'], 10000, launcher);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual(['--project', project, '--value', 'текст с пробелами']);
    expect(result.stderr).toContain('Ошибка импорта PIL');
    const jobs = new Jobs(work, join(work, 'logs'), launcher);
    const job = jobs.start('check', 'Проба', project, [{ tool: 'probe', args: ['--value', 'текст с пробелами'] }]);
    await vi.waitFor(() => expect(job.status).toBe('failed'));
    expect(job.code).toBe(result.code);
    expect(job.log).toContain(result.stdout.trim());
    expect(readFileSync(join(work, 'logs/jobs', `${job.id}.log`), 'utf8')).toContain('Ошибка импорта PIL');
  });

  it('даёт одинаковую диагностику ENOENT и помечает job неуспешным', async () => {
    const launcher = fakeLauncher('');
    vi.mocked(launcher.runtime).mockReturnValue({ ...launcher.runtime(), command: join(work, 'missing-python') });
    const result = await launcher.run(work, 'probe', []);
    expect(result.code).toBeNull();
    expect(result.stderr).toContain('ENOENT');
    const jobs = new Jobs(work, join(work, 'logs'), launcher);
    const job = jobs.start('check', 'Нет Python', work, [{ tool: 'probe', args: [] }]);
    await vi.waitFor(() => expect(job.status).toBe('failed'));
    expect(job.code).toBe(-1);
    expect(job.log).toContain('ENOENT');
  });

  it('завершает таймаутом runTool и Jobs', async () => {
    const launcher = fakeLauncher('setInterval(() => {}, 1000);');
    const result = await runTool(work, work, 'probe', [], 100, launcher);
    expect(result).toMatchObject({ code: null });
    expect(result.stderr).toContain('Превышено время');
    const jobs = new Jobs(work, join(work, 'logs'), launcher);
    const job = jobs.start('check', 'Долго', work, [{ tool: 'probe', args: [], timeoutMs: 100 }]);
    await vi.waitFor(() => expect(job.status).toBe('failed'));
    expect(job.log).toContain('Превышено время');
  });

  it('останавливает вложенное дерево при таймауте', async () => {
    const marker = join(work, 'child-finished');
    const source = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'wrong'), 500);`;
    const launcher = fakeLauncher(`require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(source)}]); setInterval(() => {}, 1000);`);
    await launcher.run(work, 'probe', [], { timeoutMs: 200 });
    await new Promise((r) => setTimeout(r, 600));
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('отличает сигнал от обычного кода завершения', async () => {
    const result = await fakeLauncher("process.kill(process.pid, 'SIGTERM');").run(work, 'probe', []);
    expect(result.code).toBeNull();
    expect(result.stderr).toContain('SIGTERM');
  });
});
