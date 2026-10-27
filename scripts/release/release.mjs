/** Подготовка ручного релиза и публикация только двух проверенных поставок. @link ../../.github/workflows/release.yml */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function versionInput(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    throw new Error('Укажите версию X.Y.Z без префикса v, например 0.2.0.');
  return value;
}

export function descriptionInput(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Описание релиза не должно быть пустым.');
  return value;
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

export function ensureAvailable(version, repository, run = gh) {
  const tag = `v${versionInput(version)}`;
  // У черновика ещё может не быть Git-тега, поэтому проверяем оба источника.
  const releases = run(['api', '--paginate', `repos/${repository}/releases`, '--jq', '.[].tag_name']);
  const refs = JSON.parse(run(['api', `repos/${repository}/git/matching-refs/tags/${tag}`]));
  if (releases.split('\n').includes(tag) || refs.some((entry) => entry.ref === `refs/tags/${tag}`))
    throw new Error(`Тег или релиз ${tag} уже существует. Выберите новый номер; существующая публикация не изменена.`);
  return tag;
}

export function setBuildVersion(version, directory = process.cwd()) {
  const path = join(directory, 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.version = versionInput(version);
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
}

export function checkedAssets(version, directory) {
  versionInput(version);
  const image = `songframe-${version}-linux-x86_64.AppImage`;
  const zip = `songframe-${version}-win-x64.zip`;
  const names = [
    image,
    `${image}.sha256`,
    zip,
    `${zip}.sha256`,
    'linux-distribution.json',
    'linux-smoke-result.json',
    'windows-archive-check.json',
    'THIRD_PARTY_LICENSES.md'
  ];
  const assets = names.map((name) => join(directory, name));
  for (const path of assets) if (!statSync(path).isFile() || !statSync(path).size) throw new Error(`Пустой файл релиза: ${basename(path)}.`);
  const hashes = new Map();
  for (const name of [image, zip]) {
    const hash = createHash('sha256')
      .update(readFileSync(join(directory, name)))
      .digest('hex');
    hashes.set(name, hash);
    if (readFileSync(join(directory, `${name}.sha256`), 'utf8').trimEnd() !== `${hash}  ${name}`) throw new Error(`Не совпадает контрольная сумма: ${name}.`);
  }
  const linux = JSON.parse(readFileSync(join(directory, 'linux-smoke-result.json'), 'utf8'));
  const windows = JSON.parse(readFileSync(join(directory, 'windows-archive-check.json'), 'utf8'));
  const inventory = JSON.parse(readFileSync(join(directory, 'linux-distribution.json'), 'utf8'));
  if (linux.ok !== true || linux.appimage !== image || linux.sha256 !== hashes.get(image)) throw new Error('Отчёт Linux не подтверждает выбранный AppImage.');
  if (windows.ok !== true || windows.zip !== zip || windows.sha256 !== hashes.get(zip) || windows.target !== 'win32-x64' || windows.nativeExecution !== false)
    throw new Error('Отчёт Windows не подтверждает выбранный ZIP.');
  if (inventory.version !== version || inventory.target !== 'linux-x64') throw new Error('Версия Linux-поставки не совпадает с номером релиза.');
  return assets;
}

export function publishRelease({ version, description, repository, sha, directory }, run = gh) {
  versionInput(version);
  descriptionInput(description);
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Для релиза нужен полный SHA собранного коммита.');
  const assets = checkedAssets(version, directory);
  const tag = ensureAvailable(version, repository, run);
  const temporary = mkdtempSync(join(tmpdir(), 'songframe-release-'));
  try {
    const notes = join(temporary, 'notes.md');
    writeFileSync(notes, description);
    // Создание нового ref отклонит занятый тег даже при гонке после предварительной проверки.
    run(['api', '--method', 'POST', `repos/${repository}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${sha}`]);
    run(['release', 'create', tag, '--verify-tag', '--draft', '--target', sha, '--title', tag, '--notes-file', notes]);
    run(['release', 'upload', tag, ...assets]);
    // Ошибка загрузки оставляет черновик: публичный релиз появляется только с полным набором файлов.
    run(['release', 'edit', tag, '--draft=false', '--latest']);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return tag;
}

function main(command) {
  const version = versionInput(process.env.RELEASE_VERSION);
  if (command === 'version') return setBuildVersion(version);
  const description = descriptionInput(process.env.RELEASE_DESCRIPTION);
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error('Не задан репозиторий релиза.');
  if (command === 'prepare') {
    const tag = ensureAvailable(version, repository);
    if (!process.env.GITHUB_OUTPUT) throw new Error('Не задан файл результатов GitHub Actions.');
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\n`);
  } else if (command === 'publish') {
    const tag = publishRelease({
      version,
      description,
      repository,
      sha: process.env.GITHUB_SHA,
      directory: resolve(process.env.RELEASE_ASSETS ?? 'release-assets')
    });
    console.log(`Релиз ${tag} опубликован с обеими проверенными поставками.`);
  } else throw new Error('Использование: release.mjs prepare | version | publish.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
