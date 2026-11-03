/** Группы CI проверяются без тяжёлых наборов; диапазоны и переименования — настоящим Git во временной папке. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ASR_TESTS, CI_FLAGS, CROSS_LANGUAGE_TESTS, classifyChanges, classifyEvent, needsNodeMedia } from './classify-changes.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const mainTests = (...names) => names.map((name) => `src/main/${name}.test.ts`);
const sorted = (values) => (values === null ? null : [...values].sort());
function assertScope(paths, flags, nodeTests = [], pythonTests = []) {
  const result = classifyChanges(paths);
  const label = paths.join(', ');
  assert.deepEqual(CI_FLAGS.filter((flag) => result[flag]).sort(), [...flags].sort(), label);
  assert.deepEqual(result.node_tests, sorted(nodeTests), `${label}: node_tests`);
  assert.deepEqual(result.python_tests, sorted(pythonTests), `${label}: python_tests`);
  return result;
}
async function fixture(context) {
  const cwd = await mkdtemp(join(tmpdir(), 'songframe-ci-scope-'));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  const git = async (...args) => (await execute('git', args, { cwd })).stdout.trim();
  await git('init', '--initial-branch=main');
  await git('config', 'user.name', 'Проверка CI');
  await git('config', 'user.email', 'ci-test@example.invalid');
  const write = async (path, text) => {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), text);
  };
  const commit = async (path, text = 'начальное содержимое') => {
    await write(path, text);
    await git('add', '.');
    await git('commit', '-m', 'Изменение для проверки');
    return git('rev-parse', 'HEAD');
  };
  const base = await commit('README.md');
  return { cwd, git, write, commit, base };
}

test('app, Storybook и статические конфигурации включают независимые проверки', () => {
  assertScope(['src/main/ipc.ts'], ['quality', 'types', 'node', 'build'], null);
  for (const path of ['src/renderer/src/App.tsx', 'src/shared/api.ts', 'src/preload/index.ts']) {
    assertScope([path], ['quality', 'types', 'node', 'build', 'browser'], null);
  }
  for (const path of ['.storybook/main.ts', 'tests/storybook/stories.spec.ts', 'scripts/storybook/prepare-assets.mjs']) {
    assertScope([path], ['quality', 'types', 'browser']);
  }
  assertScope(['vitest.config.ts'], ['quality', 'node'], null);
  assertScope(['eslint.config.mjs', '.prettierrc.json', '.editorconfig'], ['quality']);
  assertScope(['tsconfig.web.json'], ['quality', 'types', 'build', 'browser']);
  assertScope(['electron.vite.config.ts'], ['quality', 'types', 'build']);
  assertScope(['electron-builder.yml'], ['quality', 'build', 'runtime']);
  assertScope(['resources/icon.png'], ['runtime']);
  assertScope(['resources/icon.ico'], ['runtime']);
});

test('выпуск и runtime независимы, общий media-lock добавляет только нужные интеграции', () => {
  assertScope(['scripts/release/release.mjs', 'docs/development.md'], ['quality', 'release']);
  assertScope(['scripts/runtime/download.mjs'], ['quality', 'runtime']);
  assertScope(['scripts/runtime/media-lock.json'], ['quality', 'runtime', 'python', 'node'], CROSS_LANGUAGE_TESTS, ['test_prepare_ci_ffmpeg']);
  assertScope(['scripts/runtime/check-windows-installer.py'], ['runtime']);
  assertScope(['scripts/runtime/requirements-win32-x64.lock'], ['runtime']);
});

test('Python ASR ограничен своей группой и не включает приложение', () => {
  for (const folder of ['align_lyrics', 'transcribe_local', 'song_timing', 'separate_vocals', 'download_song_models']) {
    assertScope([`tools/${folder}/source.py`], ['python'], [], ASR_TESTS);
  }
  assertScope(['tools/download_whisper_model/download_whisper_model.py'], ['python'], [], ['test_download_whisper_model']);
  assertScope(['tools/transcribe_local/test_quality.py'], ['python'], [], ['test_quality']);
  assertScope(['tools/shot_workflow/test_shot_workflow.py'], ['python'], [], ['test_shot_workflow']);
  assertScope(['tools/testing/sample_project.py'], ['python'], [], null);
});

test('изменённые Python-фикстуры включают два прямых импортирующих набора', () => {
  assertScope(['tools/shot_workflow/test_shot_workflow_decisions.py'], ['python'], [], ['test_shot_workflow_decisions', 'test_shot_workflow_images']);
  assertScope(['tools/export_edit_bundle/test_export_edit_bundle.py'], ['python'], [], ['test_export_edit_bundle', 'test_check_workspace']);
});

test('остальные инструменты запускают только Python и явных Node-потребителей', () => {
  for (const path of ['tools/shot_workflow/shot_workflow.py', 'tools/common.py', 'tools/cast_registry/default_properties.json']) {
    assertScope([path], ['python', 'node'], CROSS_LANGUAGE_TESTS, null);
  }
  assertScope(['tools/current_project/current_project.py'], ['python', 'node'], mainTests('main', 'portability'), ['test_current_project']);
  assertScope(['tools/video_review/video_review.py'], ['python', 'node'], mainTests('video-review'), ['test_video_review']);
  assertScope(['tools/current_project/test_current_project.py'], ['python'], [], ['test_current_project']);
  assertScope(['tools/video_review/test_video_review.py'], ['python'], [], ['test_video_review']);
  assertScope(
    ['tools/testing/fake_media_request.py'],
    ['python', 'node'],
    mainTests('production-workflow', 'production-integration', 'production-images-integration'),
    null
  );
});

test('общие данные дополняют своих реальных потребителей', () => {
  assertScope(['tools/song_timing/models.json'], ['types', 'node', 'build', 'python'], mainTests('timing-local', 'vocal-preparation'), ASR_TESTS);
  assertScope(['tools/testdata/scene-fingerprints.json'], ['node'], mainTests('shot-acceptance'));
  assertScope(['tools/lint_registry/schemas/scenes.schema.json'], ['node', 'python'], [...CROSS_LANGUAGE_TESTS, 'src/shared/video.test.ts'], null);
  assertScope(['docs/providers/image/test.md'], ['node'], mainTests('provider-guides'));
  assertScope(['templates/project/plan/project.json'], ['node'], mainTests('main', 'checks-instructions', 'portability'));
  const skill = classifyChanges(['skills/ai-clip-scene/SKILL.md']);
  assert.equal(skill.node, true);
  assert.equal(skill.python, false);
  for (const path of mainTests('scenario-workflow', 'production-workflow', 'video-review')) assert(skill.node_tests.includes(path));
});

test('браузер читает ровно три медиа образца, а не весь sample-project', () => {
  for (const path of ['assets/shots/M01/video.mp4', 'source/heroes/mira.png', 'source/track.mp3']) {
    assertScope([`tools/testdata/sample-project/${path}`], ['python', 'node', 'browser'], CROSS_LANGUAGE_TESTS, null);
  }
  assertScope(['tools/testdata/sample-project/plan/scenes.json'], ['python', 'node'], CROSS_LANGUAGE_TESTS, null);
  assertScope(['tools/testdata/sample-project/source/text.md'], ['python', 'node'], CROSS_LANGUAGE_TESTS, null);
  assertScope(['tools/testdata/README.md'], []);
  assertScope(['.storybook/assets/story-derived-source-150.mp4'], ['quality', 'types', 'browser']);
});

test('подготовка Node-медиа следует итоговым потребителям, а не самому флагу node', () => {
  for (const path of ['docs/providers/image/test.md', 'tools/song_timing/models.json']) assert.equal(classifyChanges([path]).node_media, false, path);
  for (const test of mainTests('provider-guides', 'timing-local', 'vocal-preparation', 'checks-instructions'))
    assert.equal(needsNodeMedia([test]), false, test);
  for (const test of CROSS_LANGUAGE_TESTS) assert.equal(needsNodeMedia([test]), true, test);
  assert(CROSS_LANGUAGE_TESTS.includes('src/main/derived-workflow.test.ts'));
  assert.equal(classifyChanges(['tools/common.py']).node_media, true);
  assert.equal(classifyChanges(['docs/providers/image/test.md', 'tools/common.py']).node_media, true);
  assert.equal(classifyChanges(['src/main/ipc.ts']).node_media, true);
  assert.equal(classifyChanges(['tools/transcribe_local/test_quality.py']).node_media, false);
  assert.equal(classifyChanges(['scripts/release/release.mjs']).node_media, false);
});

test('смешанный diff объединяет списки, полный набор поглощает адресные', () => {
  assertScope(
    ['tools/transcribe_local/test_quality.py', 'tools/current_project/test_current_project.py'],
    ['python'],
    [],
    ['test_quality', 'test_current_project']
  );
  assertScope(
    ['docs/providers/image/test.md', 'templates/project/README.md'],
    ['node'],
    mainTests('provider-guides', 'main', 'checks-instructions', 'portability')
  );
  assertScope(['src/main/ipc.ts', 'docs/providers/image/test.md'], ['quality', 'types', 'node', 'build'], null);
  assertScope(['tools/transcribe_local/test_quality.py', 'tools/common.py'], ['node', 'python'], CROSS_LANGUAGE_TESTS, null);
  assertScope(['scripts/release/release.mjs', 'tools/transcribe_local/test_quality.py'], ['quality', 'release', 'python'], [], ['test_quality']);
});

test('известные документы выключают проверки, неизвестные пути и глобальные зависимости включают всё', () => {
  assertScope(['README.md', 'docs/development.md', 'dev-skills/songframe-release/SKILL.md', '.github/ISSUE_TEMPLATE/bug-report.yml', 'www/index.html'], []);
  for (const path of ['new-area/data.bin', 'package.json', 'yarn.lock', '.yarnrc.yml', '.nvmrc']) assertScope([path], CI_FLAGS, null, null);
  assertScope([], CI_FLAGS, null, null);
  assertScope(['.gitignore'], []);
});

test('обычные Markdown не запускают наборы, а Markdown-входы приложения сохраняют своих потребителей', () => {
  for (const path of [
    'tools/transcribe_local/README.md',
    'tools/testdata/README.md',
    'scripts/ci/README.md',
    'scripts/runtime/README.md',
    'scripts/release/README.md',
    'resources/README.md'
  ]) {
    assertScope([path], []);
  }
  assertScope(['docs/providers/image/test.md'], ['node'], mainTests('provider-guides'));
  assertScope(['templates/project/README.md'], ['node'], mainTests('main', 'checks-instructions', 'portability'));
  assert.equal(classifyChanges(['skills/ai-clip-scene/SKILL.md']).node, true);
});

test('изменения workflow и routing проверяют только workflow, смешанные области объединяются', () => {
  for (const path of [
    'scripts/ci/classify-changes.mjs',
    'scripts/ci/classify-changes.test.mjs',
    'scripts/ci/node-openssl.cnf',
    '.github/workflows/ci.yml',
    '.github/workflows/pages.yml',
    '.github/workflows/another.yml'
  ]) {
    const result = assertScope([path], ['workflow']);
    assert.equal(result.node_media, false, path);
  }
  assertScope(['scripts/ci/classify-changes.mjs', 'src/shared/types.ts'], ['quality', 'types', 'node', 'build', 'browser', 'workflow'], null);
  assertScope(['.github/workflows/ci.yml', 'tools/transcribe_local/test_quality.py'], ['workflow', 'python'], [], ['test_quality']);
  assertScope(['scripts/ci/node-openssl.cnf', 'scripts/release/release.mjs'], ['workflow', 'quality', 'release']);
});

test('все явно выбранные наборы существуют в текущем репозитории', async () => {
  const pythonNames = new Set();
  for (const folder of await readdir(join(root, 'tools'), { withFileTypes: true })) {
    if (folder.isDirectory())
      for (const name of await readdir(join(root, 'tools', folder.name))) if (/^test_.+\.py$/.test(name)) pythonNames.add(name.slice(0, -3));
  }
  for (const path of [
    'tools/song_timing/models.json',
    'tools/current_project/current_project.py',
    'tools/video_review/video_review.py',
    'tools/common.py',
    'tools/shot_workflow/test_shot_workflow_decisions.py',
    'tools/export_edit_bundle/test_export_edit_bundle.py',
    'scripts/runtime/media-lock.json',
    'skills/ai-clip-scene/SKILL.md',
    'docs/providers/image/test.md',
    'templates/project/README.md',
    'tools/lint_registry/schemas/scenes.schema.json',
    'tools/download_whisper_model/source.py'
  ]) {
    const result = classifyChanges([path]);
    for (const name of result.python_tests ?? []) assert(pythonNames.has(name), name);
    for (const file of result.node_tests ?? []) assert(existsSync(join(root, file)), file);
  }
});

test('push учитывает весь диапазон коммитов, а не только последний', async (context) => {
  const { cwd, commit, base } = await fixture(context);
  await commit('src/renderer/src/App.tsx');
  const head = await commit('scripts/release/release.mjs');
  const result = await classifyEvent('push', { before: base, after: head }, cwd);
  assert.equal(result.browser, true);
  assert.equal(result.build, true);
  assert.equal(result.release, true);
  assert.equal(result.python, false);
});

test('PR использует merge-base и все коммиты ветки, без чужих изменений main', async (context) => {
  const { cwd, git, commit } = await fixture(context);
  await git('switch', '-c', 'release-fix');
  await commit('scripts/release/release.mjs');
  const head = await commit('docs/development.md');
  await git('switch', 'main');
  const main = await commit('src/renderer/src/App.tsx');
  const result = await classifyEvent('pull_request', { pull_request: { base: { sha: main }, head: { sha: head } } }, cwd);
  assert.equal(result.release, true);
  assert.equal(result.browser, false);
  assert.equal(result.node, false);
});

test('rename UI в документы сохраняет проверку удалённого исходного пути', async (context) => {
  const { cwd, git, commit } = await fixture(context);
  const base = await commit('src/renderer/deleted.ts');
  await rename(join(cwd, 'src/renderer/deleted.ts'), join(cwd, 'deleted.md'));
  await git('add', '.');
  await git('commit', '-m', 'Перенос файла');
  const result = await classifyEvent('push', { before: base, after: await git('rev-parse', 'HEAD') }, cwd);
  assert.equal(result.browser, true);
  assert.equal(result.node, true);
});

for (const action of ['delete', 'rename']) {
  test(`удалённый Python-модуль не передаётся --only после ${action}`, async (context) => {
    const { cwd, git, commit } = await fixture(context);
    const base = await commit('tools/align_lyrics/test_old.py');
    if (action === 'rename') await rename(join(cwd, 'tools/align_lyrics/test_old.py'), join(cwd, 'tools/align_lyrics/test_new.py'));
    else await rm(join(cwd, 'tools/align_lyrics/test_old.py'));
    await git('add', '.');
    await git('commit', '-m', 'Изменение тестового модуля');
    const result = await classifyEvent('push', { before: base, after: await git('rev-parse', 'HEAD') }, cwd);
    assert.equal(result.python, true);
    assert.equal(result.python_tests, null);
    assert.equal(result.node, false);
    assert.equal(result.browser, false);
  });
}

test('отсутствующий выбранный Node-потребитель заменяется полным Node-набором', async (context) => {
  const { cwd, commit, base } = await fixture(context);
  const head = await commit('docs/providers/image/test.md');
  // В этой копии provider-guides.test.ts уже отсутствует; сам diff не затрагивает src и не включает Node целиком.
  const result = await classifyEvent('push', { before: base, after: head }, cwd);
  assert.equal(result.node, true);
  assert.equal(result.node_tests, null);
  assert.equal(result.node_media, true);
});

test('ручной запуск, нулевой before, неизвестное событие и недоступный diff включают всё', async (context) => {
  const { cwd, base } = await fixture(context);
  for (const [name, event] of [
    ['workflow_dispatch', {}],
    ['push', { before: '0'.repeat(40), after: base }],
    ['push', { before: 'a'.repeat(40), after: base }],
    ['pull_request', {}],
    ['unknown', {}],
    ['push', { before: base, after: base }]
  ]) {
    const result = await classifyEvent(name, event, cwd);
    assert(
      CI_FLAGS.every((flag) => result[flag]),
      name
    );
    assert.equal(result.node_tests, null);
    assert.equal(result.python_tests, null);
    assert.equal(result.node_media, true);
  }
});

test('CLI записывает независимые boolean и JSON-списки для workflow', async (context) => {
  const { cwd, commit, base } = await fixture(context);
  const head = await commit('tools/transcribe_local/test_quality.py');
  const event = join(cwd, 'event.json');
  const output = join(cwd, 'github-output');
  await writeFile(event, JSON.stringify({ before: base, after: head }));
  const { stdout } = await execute(process.execPath, [resolve(root, 'scripts/ci/classify-changes.mjs')], {
    cwd,
    env: { ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output }
  });
  const result = JSON.parse(stdout);
  assert.equal(result.python, true);
  assert.equal(result.node, false);
  assert.equal(result.node_media, false);
  assert.deepEqual(result.python_tests, ['test_quality']);
  const outputs = Object.fromEntries(
    (await readFile(output, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), JSON.parse(line.slice(separator + 1))];
      })
  );
  for (const key of [...CI_FLAGS, 'node_media', 'node_tests', 'python_tests']) assert.deepEqual(outputs[key], result[key], key);
  assert.equal('release_only' in outputs, false);
});
