/** Проверка среды: независимые результаты и этапы импорта поступают по мере готовности. */
import { environmentTexts } from '@shared/texts/environment';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WHISPER_MODELS } from '@shared/whisper-models';
import { mediaPaths, missingModelFiles, modelDirectory } from './media-runtime';
import type { EnvironmentCheck } from '@shared/types';
import { PythonLauncher } from './python-launcher';
import { paidAdapters } from './providers';

const PROGRESS_PREFIX = 'SONGFRAME_ENV_CHECK ';
const MODULES = [
  ['PIL', 'pillow', environmentTexts.main.pillowLabel],
  ['numpy', 'numpy', environmentTexts.main.numpyLabel],
  ['faster_whisper', 'faster-whisper', environmentTexts.main.fasterWhisperLabel],
  ['ctranslate2', 'ctranslate2', environmentTexts.main.ctranslateLabel]
] as const;
const bundledHint = environmentTexts.main.bundledPythonHint;
const developmentHint = environmentTexts.main.developmentPythonHint;
type Update = (id: string, patch: Partial<EnvironmentCheck>) => void;
/** Первый запуск программ из поставки на Windows может идти долго (антивирус, холодный диск): запас на проверку версии. */
const COMMAND_TIMEOUT_MS = 45000;
/** Импорт библиотек Python при холодном запуске. */
const IMPORTS_TIMEOUT_MS = 360000;

/** Версии проверяются независимо: медленный внешний CLI не блокирует главный процесс и остальные проверки. */
export function run(command: string, args: string[], shell: boolean, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string; elapsedMs: number }> {
  const started = performance.now();
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf-8', timeout: COMMAND_TIMEOUT_MS, shell, env, windowsHide: true }, (error, stdout, stderr) => {
      const elapsedMs = Math.round(performance.now() - started);
      if (error) {
        let output: string;
        if (error.killed) output = environmentTexts.main.commandTimedOut(COMMAND_TIMEOUT_MS);
        // Регулярка распознаёт штатную ошибку внешнего CMD; это контракт stderr, а не текст UI.
        else if (error.code === 'ENOENT' || String(error.code) === '9009' || (shell && /is not recognized|не является.*командой/i.test(stderr)))
          output = environmentTexts.main.commandNotFound(command);
        // CMD пишет в локальной кодировке: не выдаём повреждённый текст за сообщение инструмента.
        else if (shell && /\uFFFD/.test(stderr || error.message)) output = environmentTexts.main.commandFailed({ code: error.code, command });
        else output = stderr.trim() || error.message;
        resolve({ ok: false, output, elapsedMs });
      } else resolve({ ok: true, output: (stdout || stderr).trim(), elapsedMs });
    });
  });
}

async function checkPython(launcher: PythonLauncher, update: Update): Promise<void> {
  const started = performance.now();
  const completed = new Set<string>();
  let pendingStderr = '';
  const line = (text: string): void => {
    if (!text.startsWith(PROGRESS_PREFIX)) return;
    try {
      const progress = JSON.parse(text.slice(PROGRESS_PREFIX.length));
      if (progress.kind === 'python' && typeof progress.version === 'string' && typeof progress.executable === 'string') {
        completed.add('python');
        update('python', {
          status: 'done',
          ok: true,
          detail: environmentTexts.main.pythonVersion({ version: progress.version, executable: progress.executable }),
          elapsedMs: Math.round(performance.now() - started)
        });
      } else if (progress.kind === 'import') {
        const module = MODULES.find(([name]) => name === progress.name);
        if (!module) return;
        const id = module[1];
        if (progress.state === 'running') update(id, { status: 'running', detail: environmentTexts.main.importRunning });
        else if (progress.state === 'done' && typeof progress.ok === 'boolean' && typeof progress.detail === 'string' && Number.isFinite(progress.elapsedMs)) {
          completed.add(id);
          update(id, { status: 'done', ok: progress.ok, detail: progress.detail, elapsedMs: progress.elapsedMs });
        }
      }
    } catch {
      // Чужой stderr и неполные/неизвестные сообщения не подменяют результат проверки.
    }
  };
  const onOutput = (text: string, error?: boolean): void => {
    if (!error) return;
    pendingStderr += text;
    let newline: number;
    while ((newline = pendingStderr.indexOf('\n')) !== -1) {
      line(pendingStderr.slice(0, newline).replace(/\r$/, ''));
      pendingStderr = pendingStderr.slice(newline + 1);
    }
  };
  update('python', { status: 'running', detail: environmentTexts.main.pythonStarting });
  try {
    const runtime = launcher.runtime();
    update('python', {
      label: runtime.source === 'bundled' ? environmentTexts.main.bundledPython : environmentTexts.main.developmentPython,
      hint: runtime.source === 'bundled' ? bundledHint : developmentHint,
      bundled: runtime.source === 'bundled'
    });
    // Библиотеки поставляются вместе с тем Python, которым запущены.
    for (const [, id] of MODULES) update(id, { bundled: runtime.source === 'bundled' });
    // Fallback подписи сериализуется как строка Python: вывод и протокол прогресса остаются прежними.
    // Один процесс сохраняет итоговый JSON в stdout; помеченный stderr показывает настоящий зависший импорт до завершения процесса.
    const imports = await launcher.execute(
      [
        '-c',
        `import importlib,json,sys,time
def progress(value):
    print('SONGFRAME_ENV_CHECK ' + json.dumps(value), file=sys.stderr, flush=True)
version = sys.version.split()[0]
progress({'kind': 'python', 'version': version, 'executable': sys.executable})
result = {}
for name in ('PIL', 'numpy', 'faster_whisper', 'ctranslate2'):
    progress({'kind': 'import', 'name': name, 'state': 'running'})
    started = time.perf_counter()
    try:
        module = importlib.import_module(name)
        result[name] = {'ok': True, 'detail': getattr(module, '__version__', ${JSON.stringify(environmentTexts.main.importAvailable)})}
    except Exception as error:
        result[name] = {'ok': False, 'detail': str(error)}
    result[name]['elapsedMs'] = round((time.perf_counter() - started) * 1000)
    progress({'kind': 'import', 'name': name, 'state': 'done', **result[name]})
print(json.dumps({'version': version, 'executable': sys.executable, 'dependencies': result}))`
      ],
      { timeoutMs: IMPORTS_TIMEOUT_MS, onOutput }
    );
    if (pendingStderr) line(pendingStderr);
    const stderr = imports.stderr
      .split(/\r?\n/)
      .filter((text) => !text.startsWith(PROGRESS_PREFIX))
      .join('\n')
      .trim();
    if (imports.code !== 0) throw new Error(stderr || imports.stdout || environmentTexts.main.pythonLibrariesFailed);
    const result = JSON.parse(imports.stdout);
    // Итог остаётся доступен вызывающим без подписки; события импорта не заменяют настоящую проверку библиотек.
    update('python', {
      status: 'done',
      ok: true,
      detail: environmentTexts.main.pythonVersion({ version: result.version, executable: result.executable }),
      ...(!completed.has('python') ? { elapsedMs: Math.round(performance.now() - started) } : {})
    });
    for (const [name, id] of MODULES) {
      const status = result.dependencies[name];
      update(id, {
        status: 'done',
        ok: status?.ok ?? false,
        detail: status?.detail ?? environmentTexts.main.importResultMissing,
        elapsedMs: status?.elapsedMs
      });
    }
  } catch (error) {
    for (const id of ['python', ...MODULES.map(([, id]) => id)]) {
      if (!completed.has(id)) update(id, { status: 'done', ok: false, detail: (error as Error).message, elapsedMs: Math.round(performance.now() - started) });
    }
  }
}

/** Итоговый порядок сохраняется, а подписчик получает каждую строку до и во время запуска независимых проверок. */
export async function checkEnvironment(
  toolsRoot: string | null,
  launcher = new PythonLauncher({ toolsRoot }),
  onProgress?: (check: EnvironmentCheck) => void
): Promise<EnvironmentCheck[]> {
  const media = mediaPaths(launcher.options);
  const externalEnv = launcher.options.env ?? process.env;
  // Строки платных провайдеров задают их адаптеры; одинаковая строка показывается один раз.
  const providers = paidAdapters().map((adapter) => adapter.environment(launcher.options));
  const providerChecks = providers
    .flatMap((provider) => provider.checks)
    .filter((check, index, all) => all.findIndex((item) => item.id === check.id) === index);
  const pythonHint = launcher.options.packaged ? bundledHint : developmentHint;
  const initial = (id: string, label: string, hint: string, productionOnly = true): EnvironmentCheck => ({
    id,
    label,
    hint,
    productionOnly,
    ok: false,
    detail: environmentTexts.main.waiting,
    status: 'pending'
  });
  const checks: EnvironmentCheck[] = [
    initial(
      'tools',
      environmentTexts.main.toolsLabel,
      launcher.options.packaged ? environmentTexts.main.bundledToolsHint : environmentTexts.main.developmentToolsHint,
      false
    ),
    initial('python', launcher.options.packaged ? environmentTexts.main.bundledPython : environmentTexts.main.developmentPython, pythonHint),
    ...MODULES.map(([, id, label]) => initial(id, label, pythonHint)),
    initial('whisper-model', environmentTexts.main.whisperModelLabel, environmentTexts.main.whisperModelHint),
    ...(['ffmpeg', 'ffprobe'] as const).map((id) => ({
      ...initial(
        id,
        environmentTexts.main.mediaLabel({
          bundled: Boolean(media),
          name: id === 'ffmpeg' ? environmentTexts.main.ffmpegLabel : environmentTexts.main.ffprobeLabel
        }),
        media ? environmentTexts.main.bundledMediaHint : environmentTexts.main.developmentMediaHint
      ),
      bundled: Boolean(media)
    })),
    ...providerChecks.map((check) => ({ ...check })),
    {
      ...initial('git', environmentTexts.main.gitLabel, environmentTexts.main.gitHint),
      external: true
    }
  ];
  for (const check of checks) onProgress?.({ ...check });
  const update: Update = (id, patch) => {
    const index = checks.findIndex((check) => check.id === id);
    checks[index] = { ...checks[index], ...patch };
    onProgress?.({ ...checks[index] });
  };

  const toolsStarted = performance.now();
  update('tools', { status: 'running', detail: environmentTexts.main.resourcesChecking });
  const toolsOk = !!toolsRoot && existsSync(join(toolsRoot, 'tools', 'common.py')) && existsSync(join(toolsRoot, 'templates', 'project'));
  update('tools', {
    status: 'done',
    ok: toolsOk,
    detail: toolsRoot ?? environmentTexts.main.toolsNotFound,
    elapsedMs: Math.round(performance.now() - toolsStarted)
  });
  const modelStarted = performance.now();
  update('whisper-model', { status: 'running', detail: environmentTexts.main.modelChecking });
  const candidates = [modelDirectory(launcher.options), ...WHISPER_MODELS.map(({ id }) => modelDirectory(launcher.options, id))];
  const modelDir = candidates.find((path) => missingModelFiles(path).length === 0) ?? candidates[0];
  const missing = missingModelFiles(modelDir);
  update('whisper-model', {
    status: 'done',
    ok: missing.length === 0,
    detail: missing.length ? environmentTexts.main.modelNotFound : modelDir,
    elapsedMs: Math.round(performance.now() - modelStarted)
  });

  // Проверяем то же окружение, которое получат производственные инструменты; bundled EXE обходят shell.
  const shell = (launcher.options.platform ?? process.platform) === 'win32';
  const commands = [
    { id: 'ffmpeg', command: media?.ffmpeg ?? 'ffmpeg', args: ['-version'], shell: false },
    { id: 'ffprobe', command: media?.ffprobe ?? 'ffprobe', args: ['-version'], shell: false },
    { id: 'git', command: 'git', args: ['--version'], shell }
  ];
  const pending = commands.map(async ({ id, command, args, shell: commandShell }) => {
    update(id, { status: 'running', detail: environmentTexts.main.versionChecking });
    const probe = await run(command, args, commandShell, externalEnv);
    const detail = probe.ok && (id === 'ffmpeg' || id === 'ffprobe') ? `${probe.output.split('\n')[0]} (${command})` : probe.output;
    update(id, { status: 'done', ok: probe.ok, detail, elapsedMs: probe.elapsedMs });
  });
  const pendingProviders = providers.map((provider) => provider.run(update));
  await Promise.all([...pending, ...pendingProviders, checkPython(launcher, update)]);
  return checks;
}
