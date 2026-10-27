/** Проверка среды: независимые результаты и этапы импорта поступают по мере готовности. */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WHISPER_MODELS } from '@shared/whisper-models';
import { mediaPaths, missingModelFiles, modelDirectory } from './media-runtime';
import type { EnvironmentCheck } from '@shared/types';
import { PythonLauncher } from './python-launcher';
import { klingPaths, resolveKling } from './kling-runtime';

const PROGRESS_PREFIX = 'SONGFRAME_ENV_CHECK ';
const MODULES = [
  ['PIL', 'pillow', 'Pillow'],
  ['numpy', 'numpy', 'NumPy'],
  ['faster_whisper', 'faster-whisper', 'faster-whisper'],
  ['ctranslate2', 'ctranslate2', 'CTranslate2']
] as const;
const bundledHint = 'Python и библиотеки входят в приложение. Если комплект повреждён, распакуйте приложение заново.';
const developmentHint = 'Для разработки: yarn prepare:runtime или Python 3.11+ с зависимостями из scripts/runtime/README.md.';
type Update = (id: string, patch: Partial<EnvironmentCheck>) => void;

/** Версии проверяются независимо: медленный внешний CLI не блокирует главный процесс и остальные проверки. */
function run(command: string, args: string[], shell: boolean, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string; elapsedMs: number }> {
  const started = performance.now();
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf-8', timeout: 15000, shell, env, windowsHide: true }, (error, stdout, stderr) => {
      const elapsedMs = Math.round(performance.now() - started);
      if (error) {
        let output: string;
        if (error.killed) output = 'Превышено время выполнения (15000 мс).';
        else if (error.code === 'ENOENT' || String(error.code) === '9009' || (shell && /is not recognized|не является.*командой/i.test(stderr)))
          output = `Команда не найдена: ${command}`;
        // CMD пишет в локальной кодировке: не выдаём повреждённый текст за сообщение инструмента.
        else if (shell && /\uFFFD/.test(stderr || error.message)) output = `Команда завершилась с ошибкой (код ${error.code ?? 'неизвестен'}): ${command}`;
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
          detail: `Python ${progress.version} (${progress.executable})`,
          elapsedMs: Math.round(performance.now() - started)
        });
      } else if (progress.kind === 'import') {
        const module = MODULES.find(([name]) => name === progress.name);
        if (!module) return;
        const id = module[1];
        if (progress.state === 'running') update(id, { status: 'running', detail: 'Выполняется импорт' });
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
  update('python', { status: 'running', detail: 'Запускается Python' });
  try {
    const runtime = launcher.runtime();
    update('python', {
      label: runtime.source === 'bundled' ? 'Встроенный Python' : 'Python (разработка)',
      hint: runtime.source === 'bundled' ? bundledHint : developmentHint
    });
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
        result[name] = {'ok': True, 'detail': getattr(module, '__version__', 'доступен')}
    except Exception as error:
        result[name] = {'ok': False, 'detail': str(error)}
    result[name]['elapsedMs'] = round((time.perf_counter() - started) * 1000)
    progress({'kind': 'import', 'name': name, 'state': 'done', **result[name]})
print(json.dumps({'version': version, 'executable': sys.executable, 'dependencies': result}))`
      ],
      { timeoutMs: 120000, onOutput }
    );
    if (pendingStderr) line(pendingStderr);
    const stderr = imports.stderr
      .split(/\r?\n/)
      .filter((text) => !text.startsWith(PROGRESS_PREFIX))
      .join('\n')
      .trim();
    if (imports.code !== 0) throw new Error(stderr || imports.stdout || 'Не удалось проверить Python-библиотеки.');
    const result = JSON.parse(imports.stdout);
    // Итог остаётся доступен вызывающим без подписки; события импорта не заменяют настоящую проверку библиотек.
    update('python', {
      status: 'done',
      ok: true,
      detail: `Python ${result.version} (${result.executable})`,
      ...(!completed.has('python') ? { elapsedMs: Math.round(performance.now() - started) } : {})
    });
    for (const [name, id] of MODULES) {
      const status = result.dependencies[name];
      update(id, { status: 'done', ok: status?.ok ?? false, detail: status?.detail ?? 'Нет результата импорта', elapsedMs: status?.elapsedMs });
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
  const bundledKling = !externalEnv.SONGFRAME_KLING_CLI && Boolean(klingPaths(launcher.options));
  const pythonHint = launcher.options.packaged ? bundledHint : developmentHint;
  const initial = (id: string, label: string, hint: string, productionOnly = true): EnvironmentCheck => ({
    id,
    label,
    hint,
    productionOnly,
    ok: false,
    detail: 'Ожидание проверки',
    status: 'pending'
  });
  const checks: EnvironmentCheck[] = [
    initial(
      'tools',
      'Комплекс SongFrame',
      launcher.options.packaged
        ? 'Ресурсы входят в поставку приложения. При их отсутствии распакуйте приложение заново.'
        : 'Папка с tools/common.py и templates/project.',
      false
    ),
    initial('python', launcher.options.packaged ? 'Встроенный Python' : 'Python (разработка)', pythonHint),
    ...MODULES.map(([, id, label]) => initial(id, label, pythonHint)),
    initial(
      'whisper-model',
      'Внешняя модель faster-whisper',
      'Модель устанавливается отдельно. Откройте «Тайминги → Разметить автоматически»: там рекомендации, инструкция и ссылки; путь можно выбрать вручную.'
    ),
    ...(['ffmpeg', 'ffprobe'] as const).map((id) =>
      initial(
        id,
        `${media ? 'Встроенный ' : ''}${id === 'ffmpeg' ? 'FFmpeg' : 'ffprobe'}`,
        media ? 'Бинарник входит в приложение. Восстановите поставку.' : 'Для разработки установите FFmpeg/ffprobe или выполните yarn prepare:media.'
      )
    ),
    initial('node', 'Node.js', 'Нужен официальному Kling CLI (npm i -g @klingai/cli-global).'),
    initial('kling', 'Kling CLI', 'npm i -g @klingai/cli-global, затем kling login в браузере. Без него генерации недоступны, остальное работает.'),
    initial(
      'git',
      'Git',
      'Необязателен для локальной работы. Нужен для истории проекта и проверки индекса/снимков Git; рабочие представления проверяются без него.'
    )
  ];
  if (bundledKling) {
    for (const check of checks.filter((item) => item.id === 'node' || item.id === 'kling')) {
      check.bundled = true;
      check.label = check.id === 'node' ? 'Node.js (встроенный)' : 'Kling CLI (встроенный)';
      check.hint =
        check.id === 'node'
          ? 'Используется Node из Electron; отдельная установка не требуется.'
          : 'Входит в поставку. Вход выполняется в браузере кнопкой «Войти / сменить аккаунт».';
    }
  }
  for (const check of checks) onProgress?.({ ...check });
  const update: Update = (id, patch) => {
    const index = checks.findIndex((check) => check.id === id);
    checks[index] = { ...checks[index], ...patch };
    onProgress?.({ ...checks[index] });
  };

  const toolsStarted = performance.now();
  update('tools', { status: 'running', detail: 'Проверяются ресурсы' });
  const toolsOk = !!toolsRoot && existsSync(join(toolsRoot, 'tools', 'common.py')) && existsSync(join(toolsRoot, 'templates', 'project'));
  update('tools', { status: 'done', ok: toolsOk, detail: toolsRoot ?? 'не найден', elapsedMs: Math.round(performance.now() - toolsStarted) });
  const modelStarted = performance.now();
  update('whisper-model', { status: 'running', detail: 'Проверяются стандартные каталоги модели' });
  const candidates = [modelDirectory(launcher.options), ...WHISPER_MODELS.map(({ id }) => modelDirectory(launcher.options, id))];
  const modelDir = candidates.find((path) => missingModelFiles(path).length === 0) ?? candidates[0];
  const missing = missingModelFiles(modelDir);
  update('whisper-model', {
    status: 'done',
    ok: missing.length === 0,
    detail: missing.length ? 'В стандартных папках модель не найдена. Можно выбрать другую локальную папку при разметке.' : modelDir,
    elapsedMs: Math.round(performance.now() - modelStarted)
  });

  // Проверяем то же окружение и выбранный CLI, которые получат производственные инструменты; bundled EXE обходят shell.
  const shell = (launcher.options.platform ?? process.platform) === 'win32';
  const commands = [
    { id: 'ffmpeg', command: media?.ffmpeg ?? 'ffmpeg', args: ['-version'], shell: false },
    { id: 'ffprobe', command: media?.ffprobe ?? 'ffprobe', args: ['-version'], shell: false },
    ...(!bundledKling ? [{ id: 'node', command: 'node', args: ['--version'], shell }] : []),
    { id: 'git', command: 'git', args: ['--version'], shell }
  ];
  const pending = commands.map(async ({ id, command, args, shell: commandShell }) => {
    update(id, { status: 'running', detail: 'Проверяется версия' });
    const probe = await run(command, args, commandShell, externalEnv);
    const detail =
      probe.ok && (id === 'ffmpeg' || id === 'ffprobe')
        ? `${probe.output.split('\n')[0]} (${command})`
        : probe.ok && id === 'kling'
          ? probe.output.split('\n')[0]
          : probe.output;
    update(id, { status: 'done', ok: probe.ok, detail, elapsedMs: probe.elapsedMs });
  });
  const pendingKling = (async () => {
    update('kling', { status: 'running', detail: 'Проверяется версия' });
    try {
      const runtime = resolveKling(launcher.options);
      const probe = await run(runtime.command, [...runtime.argsPrefix, '--version'], !runtime.bundled && shell, runtime.env);
      update('kling', { status: 'done', ok: probe.ok, detail: probe.ok ? probe.output.split('\n')[0] : probe.output, elapsedMs: probe.elapsedMs });
    } catch (error) {
      update('kling', { status: 'done', ok: false, detail: (error as Error).message });
    }
  })();
  if (bundledKling) update('node', { status: 'done', ok: true, detail: process.versions.node, elapsedMs: 0 });
  await Promise.all([...pending, pendingKling, checkPython(launcher, update)]);
  return checks;
}
