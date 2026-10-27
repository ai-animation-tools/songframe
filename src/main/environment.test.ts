/** Контракт диагностики: независимые процессы не блокируют друг друга, ошибки и времена доходят до интерфейса. */
import { spawn, type ExecFileException } from 'node:child_process';
import type * as ChildProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkEnvironment } from './environment';
import { PythonLauncher } from './python-launcher';
import type { EnvironmentCheck, ToolResult } from '@shared/types';

const processes = vi.hoisted(() => ({ execFile: vi.fn(), spawnSync: vi.fn() }));
vi.mock('node:child_process', async (original) => ({ ...(await original<typeof ChildProcess>()), ...processes }));

type Callback = (error: ExecFileException | null, stdout: string, stderr: string) => void;
let work: string;
let callbacks: Map<string, Callback>;

const pythonResult = (): ToolResult => ({
  code: 0,
  stderr: '',
  command: 'python',
  stdout: JSON.stringify({
    version: '3.12.15',
    executable: 'bundled/python.exe',
    dependencies: Object.fromEntries(['PIL', 'numpy', 'faster_whisper', 'ctranslate2'].map((name) => [name, { ok: true, detail: '1.0', elapsedMs: 7 }]))
  })
});

function launcher(platform: 'linux' | 'win32' = 'linux'): PythonLauncher {
  // Прежние проверки внешних CLI используют явный override, сохраняя packaged-пути FFmpeg/ffprobe.
  const value = new PythonLauncher({
    packaged: true,
    toolsRoot: work,
    resourcesPath: work,
    platform,
    env: { ...process.env, SONGFRAME_KLING_CLI: 'kling' }
  });
  vi.spyOn(value, 'runtime').mockReturnValue({ source: 'bundled', command: 'bundled/python.exe', argsPrefix: [], cwd: work, env: {}, version: '3.12.15' });
  vi.spyOn(value, 'execute').mockResolvedValue(pythonResult());
  return value;
}

function finishVersions(output: Record<string, string> = {}): void {
  for (const [command, callback] of callbacks) callback(null, output[command] ?? `${command} version\n`, '');
}

function bundledLauncher(platform: 'linux' | 'win32' = 'linux'): PythonLauncher {
  const value = launcher(platform);
  const env: NodeJS.ProcessEnv = { ...value.options.env, PATH: '', SONGFRAME_EXTERNAL_MARKER: 'bundle-env' };
  delete env.SONGFRAME_KLING_CLI;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.KLING_NONINTERACTIVE;
  value.options.env = env;
  return value;
}

function installKlingFixture(): string {
  const directory = join(work, 'kling');
  mkdirSync(join(directory, 'dist'), { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@klingai/cli-global', version: '0.2.3' }));
  const script = join(directory, 'dist/cli.js');
  writeFileSync(script, 'console.log("0.2.3");\n');
  return script;
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-environment-'));
  callbacks = new Map();
  processes.execFile.mockReset().mockImplementation((command: string, _args: string[], _options: unknown, callback: Callback) => {
    callbacks.set(command, callback);
  });
  processes.spawnSync.mockReset().mockImplementation(() => {
    throw new Error('Диагностика не должна запускать синхронный процесс.');
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(work, { recursive: true, force: true });
});

describe('Диагностика среды', () => {
  it('начинает Python и пять CLI параллельно, оставляет event loop свободным и сохраняет порядок после обратного завершения', async () => {
    const value = launcher();
    let completePython!: (result: ToolResult) => void;
    vi.mocked(value.execute).mockReturnValue(
      new Promise((resolve) => {
        completePython = resolve;
      })
    );
    const result = checkEnvironment(work, value);
    expect(callbacks.size).toBe(5);
    expect(value.execute).toHaveBeenCalledTimes(1);
    let completed = false;
    void result.then(() => {
      completed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    for (const [command, callback] of [...callbacks].reverse()) callback(null, `${command} version\n`, '');
    await Promise.resolve();
    expect(completed).toBe(false);
    completePython(pythonResult());
    const checks = await result;
    expect(checks.map(({ id }) => id)).toEqual([
      'tools',
      'python',
      'pillow',
      'numpy',
      'faster-whisper',
      'ctranslate2',
      'whisper-model',
      'ffmpeg',
      'ffprobe',
      'node',
      'kling',
      'git'
    ]);
    expect(checks.find(({ id }) => id === 'pillow')).toMatchObject({ ok: true, elapsedMs: 7 });
    for (const id of ['python', 'ffmpeg', 'ffprobe', 'node', 'kling', 'git'])
      expect(checks.find((check) => check.id === id)?.elapsedMs).toEqual(expect.any(Number));
    expect(value.execute).toHaveBeenCalledWith(expect.any(Array), { timeoutMs: 120000, onOutput: expect.any(Function) });
    expect(processes.spawnSync).not.toHaveBeenCalled();
  });

  it('публикует начальные строки до запуска процессов и готовые CLI до завершения медленного Python', async () => {
    const value = launcher();
    const events: EnvironmentCheck[] = [];
    processes.execFile.mockImplementation((command: string, _args: string[], _options: unknown, callback: Callback) => {
      expect(events.filter((check) => check.status === 'pending')).toHaveLength(12);
      callbacks.set(command, callback);
    });
    let completePython!: (result: ToolResult) => void;
    vi.mocked(value.execute).mockReturnValue(
      new Promise((resolve) => {
        completePython = resolve;
      })
    );
    const result = checkEnvironment(work, value, (check) => events.push(check));
    expect(events.slice(0, 12).map(({ id }) => id)).toEqual([
      'tools',
      'python',
      'pillow',
      'numpy',
      'faster-whisper',
      'ctranslate2',
      'whisper-model',
      'ffmpeg',
      'ffprobe',
      'node',
      'kling',
      'git'
    ]);
    expect(events.slice(0, 12).every((check) => check.status === 'pending' && check.detail === 'Ожидание проверки' && check.elapsedMs === undefined)).toBe(
      true
    );
    expect(events.find((check) => check.id === 'python' && check.status === 'running')).toBeDefined();
    callbacks.get('node')!(null, 'v24.0.0', '');
    await Promise.resolve();
    expect(events.find((check) => check.id === 'node' && check.status === 'done')).toMatchObject({ ok: true, detail: 'v24.0.0' });
    expect(events.some((check) => check.id === 'python' && check.status === 'done')).toBe(false);
    finishVersions();
    completePython(pythonResult());
    const final = await result;
    expect(final.every((check) => check.status === 'done')).toBe(true);
  });

  it('разбирает фрагменты stderr и сразу показывает конкретный импорт, сохраняя частичный результат после обрыва Python', async () => {
    const value = launcher();
    const events: EnvironmentCheck[] = [];
    let output!: (text: string, error?: boolean) => void;
    let completePython!: (result: ToolResult) => void;
    vi.mocked(value.execute).mockImplementation((_args, options) => {
      output = options!.onOutput!;
      return new Promise((resolve) => {
        completePython = resolve;
      });
    });
    const result = checkEnvironment(work, value, (check) => events.push(check));
    const lines =
      [
        'Обычный stderr библиотеки',
        'SONGFRAME_ENV_CHECK {не JSON}',
        'SONGFRAME_ENV_CHECK ' + JSON.stringify({ kind: 'unknown' }),
        'SONGFRAME_ENV_CHECK ' + JSON.stringify({ kind: 'python', version: '3.12.15', executable: 'actual-python' }),
        'SONGFRAME_ENV_CHECK ' + JSON.stringify({ kind: 'import', name: 'PIL', state: 'running' }),
        'SONGFRAME_ENV_CHECK ' + JSON.stringify({ kind: 'import', name: 'PIL', state: 'done', ok: true, detail: '13.0', elapsedMs: 14 }),
        'SONGFRAME_ENV_CHECK ' + JSON.stringify({ kind: 'import', name: 'numpy', state: 'running' })
      ].join('\r\n') + '\r\n';
    // Размеры не совпадают с границами JSON/строк: поток может дробиться произвольно.
    for (let index = 0; index < lines.length; index += 11) output(lines.slice(index, index + 11), true);
    output(
      'SONGFRAME_ENV_CHECK ' + JSON.stringify({ kind: 'import', name: 'unknown-module', state: 'done', ok: true, detail: 'ignored', elapsedMs: 0 }) + '\n',
      true
    );
    output(
      'SONGFRAME_ENV_CHECK ' + JSON.stringify({ kind: 'import', name: 'numpy', state: 'done', ok: true, detail: 'stdout is ignored', elapsedMs: 0 }) + '\n',
      false
    );
    expect(events.find((check) => check.id === 'python' && check.status === 'done')).toMatchObject({ detail: 'Python 3.12.15 (actual-python)', ok: true });
    expect(events.find((check) => check.id === 'pillow' && check.status === 'done')).toMatchObject({ ok: true, elapsedMs: 14 });
    expect(events.filter((check) => check.id === 'numpy').at(-1)).toMatchObject({ status: 'running', detail: 'Выполняется импорт' });
    finishVersions();
    completePython({ code: null, stdout: '', stderr: lines + 'Превышено время выполнения (120000 мс).', command: 'python' });
    const final = await result;
    expect(final.find((check) => check.id === 'python')).toMatchObject({ ok: true, status: 'done' });
    expect(final.find((check) => check.id === 'pillow')).toMatchObject({ ok: true, status: 'done', elapsedMs: 14 });
    expect(final.find((check) => check.id === 'numpy')).toMatchObject({
      ok: false,
      status: 'done',
      detail: expect.stringContaining('Превышено время выполнения')
    });
    expect(final.find((check) => check.id === 'numpy')?.detail).not.toContain('SONGFRAME_ENV_CHECK');
    expect(final).toHaveLength(12);
  });

  it('не показывает повреждённый CMD stderr при отсутствующей команде и другой Windows-ошибке', async () => {
    const result = checkEnvironment(work, launcher('win32'));
    callbacks.get('node')!(Object.assign(new Error('Command failed'), { code: 9009 }), '', '\uFFFD\uFFFD\uFFFD');
    callbacks.get('kling')!(Object.assign(new Error('Command failed'), { code: 1 }), '', "'kling' is not recognized as an internal or external command");
    callbacks.get('git')!(Object.assign(new Error('Command failed'), { code: 5 }), '', '\uFFFD\uFFFD\uFFFD');
    for (const [command, callback] of callbacks) if (!['node', 'kling', 'git'].includes(command)) callback(null, 'version', '');
    const checks = await result;
    expect(checks.find(({ id }) => id === 'node')).toMatchObject({ ok: false, detail: 'Команда не найдена: node' });
    expect(checks.find(({ id }) => id === 'kling')).toMatchObject({ ok: false, detail: 'Команда не найдена: kling' });
    expect(checks.find(({ id }) => id === 'git')).toMatchObject({ ok: false, detail: 'Команда завершилась с ошибкой (код 5): git' });
  });

  it('сохраняет Windows bundled EXE без shell, а внешние CLI запускает через shell с прежним лимитом', async () => {
    const result = checkEnvironment(work, launcher('win32'));
    const calls = processes.execFile.mock.calls;
    expect(calls.slice(0, 2).map(([command, , options]) => ({ command, options }))).toEqual([
      { command: join(work, 'runtime/bin/ffmpeg.exe'), options: expect.objectContaining({ shell: false, timeout: 15000 }) },
      { command: join(work, 'runtime/bin/ffprobe.exe'), options: expect.objectContaining({ shell: false, timeout: 15000 }) }
    ]);
    expect(calls).toHaveLength(5);
    expect(calls.slice(2).map(([command, , options]) => ({ command, options }))).toEqual(
      expect.arrayContaining(['node', 'kling', 'git'].map((command) => ({ command, options: expect.objectContaining({ shell: true, timeout: 15000 }) })))
    );
    finishVersions();
    await result;
  });

  it.each(['настроенный', 'пустой'])('использует окружение launcher и тот же Kling CLI при значении PATH: %s', async (kind) => {
    const value = launcher();
    const command = join(work, 'CLI с пробелами', 'kling-custom');
    const env = { PATH: kind === 'пустой' ? '' : join(work, 'node-bin'), SONGFRAME_KLING_CLI: command, SONGFRAME_EXTERNAL_MARKER: 'launcher-env' };
    value.options.env = env;
    const result = checkEnvironment(work, value);
    const calls = processes.execFile.mock.calls;
    expect(calls).toHaveLength(5);
    // Пустой PATH тоже задан явно: диагностика не должна подменять его окружением графического запуска.
    for (const [file, , options] of calls) {
      expect(options.env).toMatchObject(env);
      expect(options.env.PATH).toBe(env.PATH);
      if (file !== command) expect(options.env).toBe(env);
    }
    expect(calls.map(([file]) => file)).toContain(command);
    expect(calls.map(([file]) => file)).not.toContain('kling');
    expect(processes.execFile).toHaveBeenCalledWith(
      command,
      ['--version'],
      expect.objectContaining({ env: expect.objectContaining(env), shell: false, timeout: 15000 }),
      expect.any(Function)
    );
    finishVersions();
    const checks = await result;
    expect(checks.find(({ id }) => id === 'kling')).toMatchObject({ ok: true, detail: `${command} version` });
    expect(checks.find(({ id }) => id === 'node')?.ok).toBe(true);
  });

  it.each(['linux', 'win32'] as const)('проверяет встроенные Node/Kling без внешнего Node и не передаёт Electron-режим другим CLI: %s', async (platform) => {
    const script = installKlingFixture();
    const value = bundledLauncher(platform);
    const events: EnvironmentCheck[] = [];
    const result = checkEnvironment(work, value, (check) => events.push(check));
    expect(processes.execFile).toHaveBeenCalledTimes(4);
    expect(processes.execFile.mock.calls.map(([command]) => command)).not.toContain('node');
    expect(processes.execFile.mock.calls.map(([command]) => command)).not.toContain('kling');
    expect(processes.execFile).toHaveBeenCalledWith(
      process.execPath,
      [script, '--version'],
      expect.objectContaining({
        shell: false,
        timeout: 15000,
        env: expect.objectContaining({ PATH: '', SONGFRAME_EXTERNAL_MARKER: 'bundle-env', KLING_NONINTERACTIVE: '1', ELECTRON_RUN_AS_NODE: '1' })
      }),
      expect.any(Function)
    );
    for (const [command, , options] of processes.execFile.mock.calls) {
      if (command === process.execPath) continue;
      expect(options.env).toBe(value.options.env);
      expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(options.env.KLING_NONINTERACTIVE).toBeUndefined();
    }
    expect(value.options.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
    // Встроенный Node готов до ответов дочерних CLI; его версия берётся из процесса Electron.
    expect(events.filter((check) => check.id === 'node').map(({ status }) => status)).toEqual(['pending', 'done']);
    expect(events.find((check) => check.id === 'node' && check.status === 'done')).toMatchObject({
      bundled: true,
      ok: true,
      detail: process.versions.node,
      elapsedMs: 0
    });
    finishVersions({ [process.execPath]: '0.2.3\n' });
    const checks = await result;
    expect(checks).toHaveLength(12);
    expect(checks.find(({ id }) => id === 'kling')).toMatchObject({ bundled: true, ok: true, status: 'done', detail: '0.2.3' });
    expect(checks.find(({ id }) => id === 'node')).toMatchObject({ bundled: true, ok: true, detail: process.versions.node });
  });

  it.each(['отсутствует', 'чужой manifest', 'пустой JS'])('показывает ошибку встроенного Kling без fallback, сохраняя встроенный Node: %s', async (damage) => {
    if (damage !== 'отсутствует') {
      const script = installKlingFixture();
      if (damage === 'чужой manifest') writeFileSync(join(work, 'kling/package.json'), JSON.stringify({ name: 'another-cli', version: '0.2.3' }));
      else writeFileSync(script, '');
    }
    const result = checkEnvironment(work, bundledLauncher());
    expect(processes.execFile.mock.calls.map(([command]) => command)).toEqual([join(work, 'runtime/bin/ffmpeg'), join(work, 'runtime/bin/ffprobe'), 'git']);
    finishVersions();
    const checks = await result;
    expect(checks.find(({ id }) => id === 'kling')).toMatchObject({
      bundled: true,
      ok: false,
      status: 'done',
      detail: expect.stringContaining('Встроенный Kling CLI недоступен')
    });
    expect(checks.find(({ id }) => id === 'node')).toMatchObject({ bundled: true, ok: true, status: 'done', detail: process.versions.node });
  });

  it('показывает настоящие ошибки запуска, stderr и таймаут вместо общего «не найден»', async () => {
    const result = checkEnvironment(work, launcher());
    callbacks.get('node')!(Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }), '', '');
    callbacks.get('kling')!(Object.assign(new Error('Command failed'), { code: 1 }), '', 'CLI: повреждена конфигурация');
    callbacks.get('git')!(Object.assign(new Error('Command timed out'), { killed: true, signal: 'SIGTERM' as const }), '', '');
    for (const [command, callback] of callbacks) if (!['node', 'kling', 'git'].includes(command)) callback(null, 'version', '');
    const checks = await result;
    expect(checks.find(({ id }) => id === 'node')).toMatchObject({ ok: false, detail: 'Команда не найдена: node' });
    expect(checks.find(({ id }) => id === 'kling')).toMatchObject({ ok: false, detail: 'CLI: повреждена конфигурация' });
    expect(checks.find(({ id }) => id === 'git')).toMatchObject({ ok: false, detail: 'Превышено время выполнения (15000 мс).' });
  });

  it('сохраняет ошибку Python и доступность независимых CLI после таймаута импорта', async () => {
    const value = launcher();
    vi.mocked(value.execute).mockResolvedValue({ code: null, stdout: '', stderr: 'Превышено время выполнения (120000 мс).', command: 'python' });
    const result = checkEnvironment(work, value);
    finishVersions();
    const checks = await result;
    expect(checks.find(({ id }) => id === 'python')).toMatchObject({ ok: false, detail: 'Превышено время выполнения (120000 мс).' });
    expect(checks.find(({ id }) => id === 'numpy')).toMatchObject({ ok: false, detail: 'Превышено время выполнения (120000 мс).' });
    expect(checks.find(({ id }) => id === 'ffmpeg')?.ok).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('проверяет версию и реальные импорты одним Python-процессом, продолжая после ошибки одного модуля', async () => {
    // Маленькие модули проверяют исполняемый Python-контракт без загрузки тяжёлых библиотек и сетевых ресурсов.
    for (const name of ['PIL', 'numpy', 'ctranslate2']) writeFileSync(join(work, `${name}.py`), '__version__ = "test-version"\n');
    writeFileSync(join(work, 'faster_whisper.py'), 'raise ImportError("DLL load failed: test-library")\n');
    const value = launcher();
    vi.mocked(value.execute).mockImplementation(
      async (args, options) =>
        new Promise((resolve, reject) => {
          const child = spawn('python3', args, { env: { ...process.env, PYTHONPATH: work }, stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk) => {
            stdout += chunk;
          });
          child.stderr.on('data', (chunk) => {
            stderr += chunk;
            options?.onOutput?.(String(chunk), true);
          });
          child.on('error', reject);
          child.on('close', (code) => resolve({ code, stdout, stderr, command: 'python3' }));
        })
    );
    const result = checkEnvironment(work, value);
    finishVersions();
    const checks = await result;
    expect(value.execute).toHaveBeenCalledTimes(1);
    expect(checks.find(({ id }) => id === 'python')).toMatchObject({ ok: true, detail: expect.stringMatching(/^Python 3\./) });
    expect(checks.find(({ id }) => id === 'faster-whisper')).toMatchObject({
      ok: false,
      detail: 'DLL load failed: test-library',
      elapsedMs: expect.any(Number)
    });
    expect(checks.find(({ id }) => id === 'ctranslate2')).toMatchObject({ ok: true, detail: 'test-version', elapsedMs: expect.any(Number) });
    expect(processes.spawnSync).not.toHaveBeenCalled();
  });
});
