/** Настоящие диапазоны Git проверяются во временных репозиториях, без GitHub и тяжёлых наборов CI. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { classifyChanges, classifyEvent } from './classify-changes.mjs';

const execute = promisify(execFile);
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

test('только сценарий выпуска и сопровождающие документы пропускают app/browser', () => {
  const result = classifyChanges(['scripts/release/release.mjs', 'README.md', 'docs/development.md', 'dev-skills/songframe-release/SKILL.md']);
  assert.equal(result.release_only, true);
  assert.equal(result.browser, false);
  for (const path of [
    'src/main/ipc.ts',
    'tools/transcribe_local/transcribe_local.py',
    'package.json',
    '.github/workflows/ci.yml',
    'docs/providers/image/test.md'
  ]) {
    assert.equal(classifyChanges(['scripts/release/release.mjs', path]).release_only, false, path);
  }
  assert.equal(classifyChanges([]).release_only, false);
  assert.equal(classifyChanges(['docs/development.md']).release_only, false);
});

test('браузерный набор следует прямым входам витрины, общим контрактам и конфигурации', () => {
  for (const path of [
    'src/renderer/src/App.tsx',
    'src/shared/api.ts',
    'src/preload/index.ts',
    '.storybook/main.ts',
    '.storybook/assets/track.mp3',
    'tests/storybook/stories.spec.ts',
    'scripts/storybook/prepare-assets.mjs',
    'resources/icon.png',
    'tools/testdata/sample-project/source/heroes/mira.png',
    'package.json',
    'yarn.lock',
    '.yarnrc.yml',
    '.nvmrc',
    'tsconfig.storybook.json',
    'vitest.config.ts',
    'electron.vite.config.ts',
    'eslint.config.mjs',
    '.prettierrc.json',
    '.prettierignore'
  ]) {
    assert.equal(classifyChanges([path]).browser, true, path);
  }
  for (const path of ['src/main/ipc.ts', 'tools/align_lyrics/align_lyrics.py', 'scripts/ci/classify-changes.mjs', '.github/workflows/ci.yml']) {
    const result = classifyChanges([path]);
    assert.equal(result.release_only, false, path);
    assert.equal(result.browser, false, path);
  }
  assert.equal(classifyChanges([]).browser, true);
});

test('push учитывает весь диапазон before→after, а не только последний коммит', async (context) => {
  const { cwd, commit, base } = await fixture(context);
  await commit('src/main/ipc.ts');
  const head = await commit('scripts/release/release.mjs');
  assert.equal((await classifyEvent('push', { before: base, after: head }, cwd)).release_only, false);
});

test('push только сценария выпуска выбирает быстрый набор', async (context) => {
  const { cwd, commit, base } = await fixture(context);
  await commit('scripts/release/release.mjs');
  const head = await commit('docs/development.md');
  assert.equal((await classifyEvent('push', { before: base, after: head }, cwd)).release_only, true);
});

test('PR берёт все коммиты ветки от общей базы, не захватывая новые изменения main', async (context) => {
  const { cwd, git, commit, base } = await fixture(context);
  await git('switch', '-c', 'release-fix');
  await commit('scripts/release/release.mjs');
  const head = await commit('docs/development.md');
  await git('switch', 'main');
  const main = await commit('src/renderer/src/App.tsx');
  assert.notEqual(main, base);
  assert.equal((await classifyEvent('pull_request', { pull_request: { base: { sha: main }, head: { sha: head } } }, cwd)).release_only, true);
});

test('PR с ранним изменением UI запускает браузер, даже если последний коммит правит только выпуск', async (context) => {
  const { cwd, git, commit, base } = await fixture(context);
  await git('switch', '-c', 'mixed-fix');
  await commit('src/renderer/src/App.tsx');
  const head = await commit('scripts/release/release.mjs');
  const result = await classifyEvent('pull_request', { pull_request: { base: { sha: base }, head: { sha: head } } }, cwd);
  assert.equal(result.release_only, false);
  assert.equal(result.browser, true);
});

test('rename из кода в документы сохраняет полный набор проверок', async (context) => {
  const { cwd, git, write, commit } = await fixture(context);
  const base = await commit('src/renderer/deleted.ts');
  await write('scripts/release/release.mjs', 'исправление');
  await rename(join(cwd, 'src/renderer/deleted.ts'), join(cwd, 'deleted.md'));
  await git('add', '.');
  await git('commit', '-m', 'Перенос файла');
  const head = await git('rev-parse', 'HEAD');
  const result = await classifyEvent('push', { before: base, after: head }, cwd);
  assert.equal(result.release_only, false);
  assert.equal(result.browser, true);
});

test('ручной запуск, нулевой before и недоступный diff оставляют полный набор', async (context) => {
  const { cwd, base } = await fixture(context);
  for (const [name, event] of [
    ['workflow_dispatch', {}],
    ['push', { before: '0'.repeat(40), after: base }],
    ['push', { before: 'a'.repeat(40), after: base }],
    ['pull_request', {}],
    ['unknown', {}]
  ]) {
    const result = await classifyEvent(name, event, cwd);
    assert.equal(result.release_only, false, name);
    assert.equal(result.browser, true, name);
  }
});

test('CLI читает событие GitHub и записывает флаги, используемые workflow', async (context) => {
  const { cwd, commit, base } = await fixture(context);
  const head = await commit('scripts/release/release.mjs');
  const event = join(cwd, 'event.json');
  const output = join(cwd, 'github-output');
  await writeFile(event, JSON.stringify({ before: base, after: head }));
  const { stdout } = await execute(process.execPath, [fileURLToPath(new URL('./classify-changes.mjs', import.meta.url))], {
    cwd,
    env: { ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output }
  });
  assert.deepEqual(JSON.parse(stdout), { release_only: true, browser: false, reason: 'release-only' });
  assert.equal(await readFile(output, 'utf8'), 'release_only=true\nbrowser=false\n');
});
