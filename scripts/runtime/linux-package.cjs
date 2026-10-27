/** Состав Linux-поставки и лицензии проверяются до создания AppImage, без путей машины сборщика. */
const { cp, readFile, readdir, stat, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const asar = require('@electron/asar');
const { sha256 } = require('./media-files.cjs');

async function walk(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await walk(root, name)));
    else if (entry.isFile()) files.push(name);
  }
  return files;
}

async function describe(root, file) {
  const info = await stat(join(root, file));
  if (!info.isFile() || !info.size) throw new Error(`Ресурс отсутствует или пуст: ${file}`);
  return { path: file, bytes: info.size, sha256: await sha256(join(root, file)) };
}

async function inspectResources(root) {
  const resources = join(root, 'resources');
  const tools = await walk(join(resources, 'tools'));
  if (tools.some((name) => name.startsWith('testdata/') || /(^|\/)test_.*\.py$/.test(name) || name.includes('__pycache__') || name.startsWith('run_tests/')))
    throw new Error('В поставку попали тесты или фикстуры tools.');
  const runtime = await walk(join(resources, 'runtime'));
  if (runtime.some((name) => name.startsWith('models/'))) throw new Error('В AppImage попали веса модели.');
  const required = [
    'resources/app.asar',
    'resources/kling/package.json',
    'resources/kling/dist/cli.js',
    'resources/kling/manifest.json',
    'resources/kling/SOURCES.md',
    'resources/runtime/manifest.json',
    'resources/runtime/requirements.lock',
    'resources/runtime/python/bin/python3',
    'resources/runtime/bin/ffmpeg',
    'resources/runtime/bin/ffprobe',
    'resources/runtime/media-manifest.json',
    'resources/tools/common.py',
    'resources/tools/cost_check/pricing.json',
    'resources/tools/lint_registry/schemas/scenes.schema.json',
    'resources/templates/project/AGENTS.md',
    'resources/templates/project/.vscode/settings.json',
    'resources/skills/ai-clip-scenario/SKILL.md',
    'LICENSE.electron.txt',
    'LICENSES.chromium.html',
    'resources/runtime/python/lib/python3.12/LICENSE.txt',
    'resources/runtime/licenses/packages.json',
    'resources/runtime/licenses/cpython/PYTHON.json',
    'resources/runtime/licenses/upstream/flatbuffers-LICENSE',
    'resources/runtime/licenses/upstream/tokenizers-LICENSE',
    'resources/runtime/licenses/upstream/CTranslate2-LICENSE',
    'resources/runtime/licenses/ffmpeg/LICENSE.txt'
  ];
  return Promise.all(required.map((file) => describe(root, file)));
}

async function createInventory(context) {
  if (context.electronPlatformName !== 'linux') return;
  const root = context.appOutDir;
  const repo = context.packager.projectDir;
  const runtime = JSON.parse(await readFile(join(root, 'resources/runtime/manifest.json'), 'utf8'));
  const kling = JSON.parse(await readFile(join(root, 'resources/kling/manifest.json'), 'utf8'));
  const wheels = JSON.parse(await readFile(join(root, 'resources/runtime/licenses/packages.json'), 'utf8'));
  const extraNotices = { ctranslate2: 'upstream/CTranslate2-LICENSE', flatbuffers: 'upstream/flatbuffers-LICENSE', tokenizers: 'upstream/tokenizers-LICENSE' };
  for (const wheel of wheels) {
    if (!wheel.files.length && extraNotices[wheel.name]) wheel.files.push(extraNotices[wheel.name]);
    if (wheel.name === 'tokenizers' && !wheel.license) wheel.license = 'Apache-2.0 (upstream)';
  }
  const appArchive = join(root, 'resources/app.asar');
  const archiveFiles = asar.listPackage(appArchive).map((file) => file.replace(/^\//, ''));
  const npm = [];
  for (const file of archiveFiles.filter((file) => /^node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(file))) {
    const metadata = JSON.parse(asar.extractFile(appArchive, file).toString('utf8'));
    const directory = file.slice(0, -'package.json'.length);
    npm.push({
      name: metadata.name,
      version: metadata.version,
      license: metadata.license ?? null,
      notices: archiveFiles
        .filter((name) => name.startsWith(directory) && /(^|\/)(LICENSE|LICENCE|NOTICE|COPYING)(\.|$)/i.test(name))
        .map((name) => `resources/app.asar/${name}`)
    });
  }
  // Проверяем только код приложения: бинарные зависимости содержат собственные upstream build paths.
  for (const file of ['build/app/main/index.js', 'build/app/preload/index.js']) {
    if (asar.extractFile(appArchive, file).includes(Buffer.from(repo))) throw new Error(`В код зашит checkout сборщика: ${file}`);
  }
  const files = await inspectResources(root);
  for (const entry of ['runtime/python/bin/python3', 'runtime/bin/ffmpeg', 'runtime/bin/ffprobe']) {
    if (!((await stat(join(root, 'resources', entry))).mode & 0o111)) throw new Error(`Нет execute-bit: ${entry}`);
  }
  const notices = (await walk(join(root, 'resources/runtime/licenses'))).filter((name) => !name.endsWith('.json'));
  for (const wheel of wheels) for (const file of wheel.files) await stat(join(root, 'resources/runtime/licenses', file));
  const inventory = {
    schema_version: 1,
    target: 'linux-x64',
    version: context.packager.appInfo.version,
    electron: context.packager.config.electronVersion ?? require('electron/package.json').version,
    python: runtime.python,
    kling,
    modelDelivery: 'external',
    files,
    wheels,
    npm,
    notices: notices.map((file) => `resources/runtime/licenses/${file}`)
  };
  const markdown =
    '# Состав Linux-поставки\n\nМодель распознавания и Claude/Codex не входят в приложение. Официальный Kling CLI включён в поставку и использует Node.js из Electron. Перечень отражает уведомления поставщиков; полные тексты находятся по указанным путям.\n\n' +
    `Electron ${inventory.electron}, Python ${inventory.python}.\n\n## Python-пакеты\n\n| Пакет | Версия | Лицензия из metadata |\n| --- | --- | --- |\n` +
    wheels.map((item) => `| ${item.name} | ${item.version} | ${String(item.license).replaceAll('\n', ' ').replaceAll('|', '/')} |`).join('\n') +
    '\n\n## JavaScript-пакеты\n\n| Пакет | Версия | Лицензия из metadata |\n| --- | --- | --- |\n' +
    npm.map((item) => `| ${item.name} | ${item.version} | ${item.license ?? 'см. уведомления'} |`).join('\n') +
    `\n\n## Kling CLI\n\n${kling.name} ${kling.version}. Неизменённый пакет, источник и контрольная сумма: resources/kling/SOURCES.md. Документация поставщика сохранена в resources/kling/README.md.\n` +
    '\n\n## Тексты лицензий\n\n' +
    ['LICENSE.electron.txt', 'LICENSES.chromium.html', 'resources/runtime/python/lib/python3.12/LICENSE.txt', ...inventory.notices]
      .map((file) => `- ${file}`)
      .join('\n') +
    '\n';
  await writeFile(join(root, 'resources/distribution.json'), JSON.stringify(inventory, null, 2) + '\n');
  await writeFile(join(root, 'resources/THIRD_PARTY_LICENSES.md'), markdown);
  const output = context.packager.config.directories?.output ?? join(repo, 'build/release');
  await cp(join(root, 'resources/distribution.json'), join(output, 'linux-distribution.json'));
  await cp(join(root, 'resources/THIRD_PARTY_LICENSES.md'), join(output, 'THIRD_PARTY_LICENSES.md'));
  console.log(`Состав Linux-поставки проверен: ${files.length} ресурсов, ${wheels.length} Python и ${npm.length} JavaScript-пакетов.`);
}

module.exports = { inspectResources, createInventory };
