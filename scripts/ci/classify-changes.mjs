/** Независимые наборы CI объединяются по изменённым областям; неизвестный вход включает все проверки. */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const CI_FLAGS = ['quality', 'types', 'node', 'build', 'browser', 'python', 'runtime', 'release', 'workflow'];
export const ASR_TESTS = [
  'test_align_lyrics',
  'test_transcribe_local',
  'test_quality',
  'test_hardware',
  'test_song_timing',
  'test_separate_vocals',
  'test_download_song_models'
];
export const CROSS_LANGUAGE_TESTS = [
  'main',
  'portability',
  'shot-acceptance',
  'project-settings-views',
  'scenario-integration',
  'production-workflow',
  'production-integration',
  'production-images-integration',
  'derived-integration',
  'derived-workflow',
  'montage-integration',
  'video-review'
].map((name) => `src/main/${name}.test.ts`);
const WORKFLOW_TESTS = [
  'scenario-workflow',
  'scenario-integration',
  'production-workflow',
  'production-integration',
  'production-images-integration',
  'video-review'
].map((name) => `src/main/${name}.test.ts`);
const ASR_DIRECTORIES = ['align_lyrics', 'transcribe_local', 'song_timing', 'separate_vocals', 'download_song_models'];
const STORY_MEDIA = ['assets/shots/M01/video.mp4', 'source/heroes/mira.png', 'source/track.mp3'].map((path) => `tools/testdata/sample-project/${path}`);

function scope(flags = [], nodeTests = [], pythonTests = [], reason = 'paths') {
  return {
    ...Object.fromEntries(CI_FLAGS.map((flag) => [flag, flags.includes(flag)])),
    node_tests: nodeTests,
    python_tests: pythonTests,
    reason
  };
}
const full = (reason) => withPreparation(scope(CI_FLAGS, null, null, reason));
const node = (tests, flags = []) => scope(['node', ...flags], tests);
const python = (tests = null) => scope(['python'], [], tests);
const crossLanguage = () => scope(['node', 'python'], CROSS_LANGUAGE_TESTS, null);

/** Подготовка Python/FFmpeg нужна только полному Node-набору и явным интеграционным потребителям. */
export function needsNodeMedia(tests) {
  return tests === null || tests.some((path) => CROSS_LANGUAGE_TESTS.includes(path));
}
function withPreparation(result) {
  return { ...result, node_media: result.node && needsNodeMedia(result.node_tests) };
}

/** null означает полный набор и поглощает адресные списки, false всегда сопровождается пустым списком. */
function merge(target, source) {
  for (const flag of CI_FLAGS) target[flag] ||= source[flag];
  for (const key of ['node_tests', 'python_tests']) {
    target[key] = target[key] === null || source[key] === null ? null : [...new Set([...target[key], ...source[key]])].sort();
  }
  if (source.reason !== 'paths') target.reason = source.reason;
  return target;
}

/** Простые предметные группы и явные потребители заменяют граф импортов; документы провайдеров остаются входом Node. */
function classifyPath(path) {
  if (path.startsWith('docs/providers/')) return node(['src/main/provider-guides.test.ts']);
  if (path.startsWith('skills/')) return node(WORKFLOW_TESTS);
  if (path.startsWith('templates/')) return node(['src/main/main.test.ts', 'src/main/checks-instructions.test.ts', 'src/main/portability.test.ts']);
  if (path.startsWith('tools/testdata/sample-project/')) {
    const result = crossLanguage();
    result.browser = STORY_MEDIA.includes(path);
    return result;
  }
  // Промпты и шаблоны выше являются входом приложения; обычные руководства дальше не требуют CI.
  if (path.endsWith('.md')) return scope();
  if (path.startsWith('.github/workflows/') || path.startsWith('scripts/ci/')) return scope(['workflow'], [], [], 'ci-routing');
  if (['package.json', 'yarn.lock', '.yarnrc.yml', '.nvmrc'].includes(path)) return full('global-config');
  if (
    path === 'LICENSE' ||
    path === '.gitignore' ||
    ['docs/', 'dev-skills/', '.agents/', '.claude/', '.vscode/', 'www/', '.github/ISSUE_TEMPLATE/'].some((prefix) => path.startsWith(prefix)) ||
    path === '.github/pull_request_template.md'
  )
    return scope();
  if (path === '.editorconfig' || /^(?:eslint\.config\.[cm]?js|\.prettier[^/]*)$/.test(path)) return scope(['quality']);
  if (/^tsconfig[^/]*\.json$/.test(path)) return scope(['quality', 'types', 'build', 'browser']);
  if (/^vitest[^/]*\.ts$/.test(path)) return node(null, ['quality']);
  if (path === 'electron.vite.config.ts') return scope(['quality', 'types', 'build']);
  if (path === 'electron-builder.yml') return scope(['quality', 'build', 'runtime']);
  if (path === 'pyproject.toml') return python();
  if (path.startsWith('src/main/')) return node(null, ['quality', 'types', 'build']);
  if (['src/renderer/', 'src/shared/', 'src/preload/'].some((prefix) => path.startsWith(prefix))) {
    return node(null, ['quality', 'types', 'build', 'browser']);
  }
  if (['.storybook/', 'scripts/storybook/', 'tests/storybook/'].some((prefix) => path.startsWith(prefix))) {
    return scope(['quality', 'types', 'browser']);
  }
  if (path.startsWith('resources/')) return scope(['runtime']);
  if (path.startsWith('scripts/release/')) return scope(['quality', 'release']);
  if (path === 'scripts/runtime/media-lock.json') {
    return scope(['runtime', 'quality', 'node', 'python'], CROSS_LANGUAGE_TESTS, ['test_prepare_ci_ffmpeg']);
  }
  if (path.startsWith('scripts/runtime/')) {
    return scope(['runtime', ...(/\.(?:[cm]?js|json|ya?ml)$/.test(path) ? ['quality'] : [])]);
  }
  if (path === 'tools/song_timing/models.json') {
    return scope(['types', 'node', 'build', 'python'], ['src/main/timing-local.test.ts', 'src/main/vocal-preparation.test.ts'], ASR_TESTS);
  }
  if (path === 'tools/testdata/scene-fingerprints.json') return node(['src/main/shot-acceptance.test.ts']);
  if (path.startsWith('tools/')) {
    // Два соседних набора импортируют эти модули как фикстуры: это явные исключения без графа импортов.
    if (path === 'tools/shot_workflow/test_shot_workflow_decisions.py') return python(['test_shot_workflow_decisions', 'test_shot_workflow_images']);
    if (path === 'tools/export_edit_bundle/test_export_edit_bundle.py') return python(['test_export_edit_bundle', 'test_check_workspace']);
    const test = /^tools\/[^/]+\/(test_[^/]+)\.py$/.exec(path);
    if (test) return python([test[1]]);
    if (path === 'tools/testing/sample_project.py') return python();
    if (path === 'tools/testing/fake_media_request.py') {
      return scope(
        ['node', 'python'],
        ['src/main/production-workflow.test.ts', 'src/main/production-integration.test.ts', 'src/main/production-images-integration.test.ts'],
        null
      );
    }
    if (path.startsWith('tools/current_project/'))
      return scope(['node', 'python'], ['src/main/main.test.ts', 'src/main/portability.test.ts'], ['test_current_project']);
    if (path.startsWith('tools/video_review/')) return scope(['node', 'python'], ['src/main/video-review.test.ts'], ['test_video_review']);
    if (ASR_DIRECTORIES.some((directory) => path.startsWith(`tools/${directory}/`))) return python(ASR_TESTS);
    if (path.startsWith('tools/download_whisper_model/')) return python(['test_download_whisper_model']);
    const result = crossLanguage();
    if (path.startsWith('tools/lint_registry/schemas/')) merge(result, node(['src/shared/video.test.ts']));
    return result;
  }
  return full('unknown-path');
}

export function classifyChanges(paths) {
  if (!paths.length) return full('empty-diff');
  return withPreparation(paths.reduce((result, path) => merge(result, classifyPath(path)), scope()));
}

/** Удалённый или переименованный тест не передаётся адресному runner под прежним именем. */
async function validateSelectedTests(result, cwd) {
  if (result.node && result.node_tests !== null && result.node_tests.some((path) => !existsSync(join(cwd, path)))) result.node_tests = null;
  if (result.python && result.python_tests !== null) {
    const available = new Set();
    for (const directory of await readdir(join(cwd, 'tools'), { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      for (const name of await readdir(join(cwd, 'tools', directory.name))) {
        if (/^test_.+\.py$/.test(name)) available.add(name.slice(0, -3));
      }
    }
    if (result.python_tests.some((name) => !available.has(name))) result.python_tests = null;
  }
  return withPreparation(result);
}

async function classifyRange(range, cwd) {
  // Без распознавания rename Git показывает старый и новый путь; NUL сохраняет пробелы и переводы строк в именах.
  const { stdout } = await execute('git', ['diff', '--name-only', '--no-renames', '-z', ...range, '--'], { cwd, maxBuffer: 10 * 1024 * 1024 });
  return validateSelectedTests(classifyChanges(stdout.split('\0').filter(Boolean)), cwd);
}

export class ManualInputError extends Error {}

/** Ручной выбор не превращается в полный набор из-за опечатки: ошибки параметров останавливают scope. */
async function classifyManual(inputs, cwd) {
  if (inputs == null) inputs = {};
  if (typeof inputs !== 'object' || Array.isArray(inputs)) throw new ManualInputError('Параметры ручного CI должны быть объектом.');
  const mode = inputs.mode === undefined ? 'Автоматически (последний коммит)' : inputs.mode;
  if (mode === 'Полный набор') return full('manual-full');
  if (mode === 'Выбранные группы') {
    const flags = CI_FLAGS.filter((flag) => {
      const value = inputs[flag];
      if (value === true || value === 'true') return true;
      if (value === undefined || value === false || value === 'false') return false;
      throw new ManualInputError(`Параметр ${flag} ручного CI должен иметь значение true или false.`);
    });
    if (!flags.length) throw new ManualInputError('В режиме «Выбранные группы» отметьте хотя бы одну группу проверок.');
    return withPreparation(scope(flags, flags.includes('node') ? null : [], flags.includes('python') ? null : [], 'manual-selected'));
  }
  if (mode !== 'Автоматически (последний коммит)')
    throw new ManualInputError('Неизвестный режим ручного CI. Выберите автоматический режим, выбранные группы или полный набор.');
  try {
    // HEAD^ — первый родитель merge-коммита; выбранный ref берётся из checkout, а не из payload push/PR.
    const { stdout } = await execute('git', ['rev-parse', 'HEAD', 'HEAD^'], { cwd });
    const [head, base] = stdout.trim().split(/\s+/);
    const result = await classifyRange([base, head], cwd);
    return { ...result, reason: `manual-auto-${result.reason}` };
  } catch {
    return full('manual-auto-unavailable-range');
  }
}

/** PR проверяет всю ветку от общей базы, push — диапазон всех отправленных коммитов. */
export async function classifyEvent(eventName, event, cwd = process.cwd()) {
  if (eventName === 'workflow_dispatch') {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new ManualInputError('Не удалось прочитать событие ручного CI.');
    return classifyManual(event.inputs, cwd);
  }
  let base;
  let head;
  if (eventName === 'push') {
    base = event?.before;
    head = event?.after;
  } else if (eventName === 'pull_request') {
    base = event?.pull_request?.base?.sha;
    head = event?.pull_request?.head?.sha;
  } else return full('unknown-event');
  const commit = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value) && !/^0+$/.test(value);
  if (!commit(base) || !commit(head)) return full('missing-range');
  try {
    const range = eventName === 'pull_request' ? [`${base}...${head}`] : [base, head];
    return await classifyRange(range, cwd);
  } catch {
    return full('unavailable-diff');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    result = await classifyEvent(process.env.GITHUB_EVENT_NAME, event);
  } catch (error) {
    if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
      console.error(error instanceof ManualInputError ? error.message : `Не удалось прочитать параметры ручного CI: ${error.message}`);
      process.exitCode = 1;
    } else result = full('unavailable-event');
  }
  if (result && process.env.GITHUB_OUTPUT) {
    const outputs = [...CI_FLAGS, 'node_media', 'node_tests', 'python_tests'].map((key) => `${key}=${JSON.stringify(result[key])}\n`).join('');
    await appendFile(process.env.GITHUB_OUTPUT, outputs);
  }
  if (result) console.log(JSON.stringify(result));
}
