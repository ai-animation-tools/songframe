/** Контракт диагностики: независимые процессы не блокируют друг друга, ошибки и времена доходят до интерфейса. */
import { spawn, type ExecFileException } from 'node:child_process';
import type * as ChildProcess from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkEnvironment } from './environment';
import { PythonLauncher } from './python-launcher';
import type { EnvironmentCheck, ToolResult } from '@shared/types';

const processes = vi.hoisted(() => ({ execFile: vi.fn(), spawnSync: vi.fn() }));
vi.mock('node:child_process', async (original) => ({ ...(await original<typeof ChildProcess>()), ...processes }));
// Таблица адаптеров заменена одним тестовым провайдером: его строка проверяется адаптером без внешних процессов.
vi.mock('./providers', () => ({
  paidAdapters: () => [
    {
      id: 'test',
      environment: () => ({
        checks: [
          {
            id: 'test',
            label: 'Тестовый сервис',
            hint: 'Войдите в сервис.',
            productionOnly: true,
            ok: false,
            detail: 'Ожидание проверки',
            status: 'pending' as const,
            bundled: true,
            loginProvider: 'test'
          }
        ],
        run: async (update: (id: string, patch: object) => void) => update('test', { status: 'done', ok: true, detail: 'Вход выполнен', elapsedMs: 1 })
      })
    }
  ]
}));

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
    env: { ...process.env }
  });
  vi.spyOn(value, 'runtime').mockReturnValue({ source: 'bundled', command: 'bundled/python.exe', argsPrefix: [], cwd: work, env: {}, version: '3.12.15' });
  vi.spyOn(value, 'execute').mockResolvedValue(pythonResult());
  return value;
}

function finishVersions(output: Record<string, string> = {}): void {
  for (const [command, callback] of callbacks) callback(null, output[command] ?? `${command} version\n`, '');
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
  it('начинает Python и три CLI параллельно, оставляет event loop свободным и сохраняет порядок после обратного завершения', async () => {
    const value = launcher();
    let completePython!: (result: ToolResult) => void;
    vi.mocked(value.execute).mockReturnValue(
      new Promise((resolve) => {
        completePython = resolve;
      })
    );
    const result = checkEnvironment(work, value);
    expect(callbacks.size).toBe(3);
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
      'test',
      'git'
    ]);
    expect(checks.find(({ id }) => id === 'pillow')).toMatchObject({ ok: true, elapsedMs: 7 });
    for (const id of ['python', 'ffmpeg', 'ffprobe', 'test', 'git']) expect(checks.find((check) => check.id === id)?.elapsedMs).toEqual(expect.any(Number));
    // Встроенный Python с библиотеками и FFmpeg/ffprobe поставки помечены «в поставке», Git — нет.
    for (const id of ['python', 'pillow', 'numpy', 'faster-whisper', 'ctranslate2', 'ffmpeg', 'ffprobe'])
      expect(checks.find((check) => check.id === id)?.bundled, id).toBe(true);
    expect(checks.find((check) => check.id === 'git')?.bundled).toBeUndefined();
    expect(value.execute).toHaveBeenCalledWith(expect.any(Array), { timeoutMs: 360000, onOutput: expect.any(Function) });
    expect(processes.spawnSync).not.toHaveBeenCalled();
  });

  it('публикует начальные строки до запуска процессов и готовые CLI до завершения медленного Python', async () => {
    const value = launcher();
    const events: EnvironmentCheck[] = [];
    processes.execFile.mockImplementation((command: string, _args: string[], _options: unknown, callback: Callback) => {
      expect(events.filter((check) => check.status === 'pending')).toHaveLength(11);
      callbacks.set(command, callback);
    });
    let completePython!: (result: ToolResult) => void;
    vi.mocked(value.execute).mockReturnValue(
      new Promise((resolve) => {
        completePython = resolve;
      })
    );
    const result = checkEnvironment(work, value, (check) => events.push(check));
    expect(events.slice(0, 11).map(({ id }) => id)).toEqual([
      'tools',
      'python',
      'pillow',
      'numpy',
      'faster-whisper',
      'ctranslate2',
      'whisper-model',
      'ffmpeg',
      'ffprobe',
      'test',
      'git'
    ]);
    expect(events.slice(0, 11).every((check) => check.status === 'pending' && check.detail === 'Ожидание проверки' && check.elapsedMs === undefined)).toBe(
      true
    );
    expect(events.find((check) => check.id === 'python' && check.status === 'running')).toBeDefined();
    callbacks.get('git')!(null, 'git version 2.50', '');
    await Promise.resolve();
    expect(events.find((check) => check.id === 'git' && check.status === 'done')).toMatchObject({ ok: true, detail: 'git version 2.50' });
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
    completePython({ code: null, stdout: '', stderr: lines + 'Превышено время выполнения (360000 мс).', command: 'python' });
    const final = await result;
    expect(final.find((check) => check.id === 'python')).toMatchObject({ ok: true, status: 'done' });
    expect(final.find((check) => check.id === 'pillow')).toMatchObject({ ok: true, status: 'done', elapsedMs: 14 });
    expect(final.find((check) => check.id === 'numpy')).toMatchObject({
      ok: false,
      status: 'done',
      detail: expect.stringContaining('Превышено время выполнения')
    });
    expect(final.find((check) => check.id === 'numpy')?.detail).not.toContain('SONGFRAME_ENV_CHECK');
    expect(final).toHaveLength(11);
  });

  it.each([
    ['отсутствующая команда', 9009, '\uFFFD\uFFFD\uFFFD', 'Команда не найдена: git'],
    ['сообщение CMD', 1, "'git' is not recognized as an internal or external command", 'Команда не найдена: git'],
    ['другая ошибка', 5, '\uFFFD\uFFFD\uFFFD', 'Команда завершилась с ошибкой (код 5): git']
  ])('не показывает повреждённый CMD stderr: %s', async (_name, code, stderr, detail) => {
    const result = checkEnvironment(work, launcher('win32'));
    callbacks.get('git')!(Object.assign(new Error('Command failed'), { code }), '', stderr);
    for (const [command, callback] of callbacks) if (command !== 'git') callback(null, 'version', '');
    const checks = await result;
    expect(checks.find(({ id }) => id === 'git')).toMatchObject({ ok: false, detail });
  });

  it('сохраняет Windows bundled EXE без shell, а внешние CLI запускает через shell с прежним лимитом', async () => {
    const result = checkEnvironment(work, launcher('win32'));
    const calls = processes.execFile.mock.calls;
    expect(calls.map(([command, , options]) => ({ command, options }))).toEqual([
      { command: join(work, 'runtime/bin/ffmpeg.exe'), options: expect.objectContaining({ shell: false, timeout: 45000 }) },
      { command: join(work, 'runtime/bin/ffprobe.exe'), options: expect.objectContaining({ shell: false, timeout: 45000 }) },
      { command: 'git', options: expect.objectContaining({ shell: true, timeout: 45000 }) }
    ]);
    finishVersions();
    await result;
  });

  it('показывает настоящие ошибки запуска, stderr и таймаут вместо общего «не найден»', async () => {
    const result = checkEnvironment(work, launcher());
    const ffmpeg = join(work, 'runtime/bin/ffmpeg');
    const ffprobe = join(work, 'runtime/bin/ffprobe');
    callbacks.get(ffmpeg)!(Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }), '', '');
    callbacks.get(ffprobe)!(Object.assign(new Error('Command failed'), { code: 1 }), '', 'ffprobe: повреждена библиотека');
    callbacks.get('git')!(Object.assign(new Error('Command timed out'), { killed: true, signal: 'SIGTERM' as const }), '', '');
    const checks = await result;
    expect(checks.find(({ id }) => id === 'ffmpeg')).toMatchObject({ ok: false, detail: `Команда не найдена: ${ffmpeg}` });
    expect(checks.find(({ id }) => id === 'ffprobe')).toMatchObject({ ok: false, detail: 'ffprobe: повреждена библиотека' });
    expect(checks.find(({ id }) => id === 'git')).toMatchObject({ ok: false, detail: 'Превышено время выполнения (45000 мс).' });
  });

  it('сохраняет ошибку Python и доступность независимых CLI после таймаута импорта', async () => {
    const value = launcher();
    vi.mocked(value.execute).mockResolvedValue({ code: null, stdout: '', stderr: 'Превышено время выполнения (360000 мс).', command: 'python' });
    const result = checkEnvironment(work, value);
    finishVersions();
    const checks = await result;
    expect(checks.find(({ id }) => id === 'python')).toMatchObject({ ok: false, detail: 'Превышено время выполнения (360000 мс).' });
    expect(checks.find(({ id }) => id === 'numpy')).toMatchObject({ ok: false, detail: 'Превышено время выполнения (360000 мс).' });
    expect(checks.find(({ id }) => id === 'ffmpeg')?.ok).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('проверяет версию и реальные импорты одним Python-процессом, продолжая после ошибки одного модуля', async () => {
    // Маленькие модули проверяют исполняемый Python-контракт без загрузки тяжёлых библиотек и сетевых ресурсов.
    for (const name of ['PIL', 'numpy']) writeFileSync(join(work, `${name}.py`), '__version__ = "test-version"\n');
    writeFileSync(join(work, 'ctranslate2.py'), '# Модуль без номера версии\n');
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
    expect(checks.find(({ id }) => id === 'ctranslate2')).toMatchObject({ ok: true, detail: 'доступен', elapsedMs: expect.any(Number) });
    // Проверяем настоящий вывод script независимо от словаря: JSON stdout и помеченный stderr сохраняют одну подпись.
    const execution = await vi.mocked(value.execute).mock.results[0].value;
    expect(JSON.parse(execution.stdout).dependencies.ctranslate2.detail).toBe('доступен');
    const progress = execution.stderr
      .trim()
      .split('\n')
      .map((line: string) => JSON.parse(line.slice('SONGFRAME_ENV_CHECK '.length)));
    expect(progress.find((item: { name?: string; state?: string }) => item.name === 'ctranslate2' && item.state === 'done')).toMatchObject({
      ok: true,
      detail: 'доступен'
    });
    expect(processes.spawnSync).not.toHaveBeenCalled();
  });
});
