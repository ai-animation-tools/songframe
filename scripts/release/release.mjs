/**
 * Локальный выпуск SongFrame: plan читает Git и GitHub, prepare собирает и проверяет обе поставки на этой машине
 * и ставит только локальный тег, publish отправляет тег, загружает файлы и сверяет их SHA-256 через GitHub API.
 * @link ../../docs/development.md#выпуск-релиза
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, link, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const repository = 'ai-animation-tools/songframe';
export const releaseBase = `https://github.com/${repository}/releases/`;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export class ReleaseError extends Error {}
const requireState = (condition, message) => {
  if (!condition) throw new ReleaseError(message);
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function versionInput(value) {
  if (typeof value !== 'string' || !stableTag.test(`v${value}`)) throw new ReleaseError('Укажите версию X.Y.Z без префикса v, например 0.2.0.');
  return value;
}

/** Версии сравниваются численно: 0.10.0 новее 0.9.0. */
export function compareVersions(left, right) {
  const parts = (value) => versionInput(value.replace(/^v/, '')).split('.').map(BigInt);
  const [a, b] = [parts(left), parts(right)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

/** Состав выпуска: две поставки, их SHA256, отчёты проверок и уведомления о лицензиях. */
export function assetNames(version) {
  const image = `songframe-${version}-linux-x86_64.AppImage`;
  const installer = `songframe-${version}-win-x64-setup.exe`;
  return {
    image,
    installer,
    all: [
      image,
      `${image}.sha256`,
      installer,
      `${installer}.sha256`,
      'linux-distribution.json',
      'linux-smoke-result.json',
      'windows-installer-check.json',
      'THIRD_PARTY_LICENSES.md'
    ]
  };
}

/** Сверяет поставки с их SHA256 и отчётами проверок; возвращает размер и хеш каждого файла выпуска. */
export async function checkedAssets(version, directory) {
  const { image, installer, all } = assetNames(version);
  const assets = [];
  for (const name of all) {
    const bytes = await readFile(join(directory, name)).catch(() => null);
    requireState(bytes?.length, `Нет файла выпуска или он пуст: ${name}.`);
    assets.push({ name, size: bytes.length, sha256: sha(bytes) });
  }
  const hash = (name) => assets.find((asset) => asset.name === name).sha256;
  const text = (name) => readFile(join(directory, name), 'utf8');
  const json = async (name) => JSON.parse(await text(name));
  for (const name of [image, installer])
    requireState((await text(`${name}.sha256`)).trimEnd() === `${hash(name)}  ${name}`, `Не совпадает контрольная сумма: ${name}.`);
  const linux = await json('linux-smoke-result.json');
  const windows = await json('windows-installer-check.json');
  const inventory = await json('linux-distribution.json');
  requireState(linux.ok === true && linux.appimage === image && linux.sha256 === hash(image), 'Отчёт Linux не подтверждает выбранный AppImage.');
  requireState(
    windows.ok === true &&
      windows.installer === installer &&
      windows.sha256 === hash(installer) &&
      windows.version === version &&
      windows.target === 'win32-x64' &&
      windows.nativeExecution === false,
    'Отчёт Windows не подтверждает выбранный установщик.'
  );
  requireState(inventory.version === version && inventory.target === 'linux-x64', 'Версия Linux-поставки не совпадает с номером релиза.');
  return assets;
}

/** Внешние команды получают аргументы массивом; stdout возвращается строкой, stderr виден в терминале. */
export function runCommand(command, args, { cwd = root, inherit = false, env } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: env && { ...process.env, ...env }, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'inherit'] });
    const chunks = [];
    child.stdout?.on('data', (chunk) => chunks.push(chunk));
    child.on('error', () => reject(new ReleaseError(`Не удалось запустить ${command}.`)));
    child.on('close', (code) =>
      code === 0
        ? resolvePromise(Buffer.concat(chunks).toString('utf8').trim())
        : reject(new ReleaseError(`Команда ${command} ${args[0]} завершилась ошибкой.`))
    );
  });
}

/** gh сам отвечает за вход; токен скрипт не читает и не передаёт в аргументах. */
export function githubClient(run) {
  const api = async (endpoint) => JSON.parse(await run('gh', ['api', endpoint, '--paginate', '--slurp']));
  const repo = ['--repo', repository];
  return {
    releases: async () => (await api(`repos/${repository}/releases?per_page=100`)).flat(),
    assets: async (release) => (await api(`repos/${repository}/releases/${release.id}/assets?per_page=100`)).flat(),
    // Выпуск собирается локально, поэтому прошедший CI того же коммита — единственная проверка lint, типов и тестов.
    ci: async (revision) => (await api(`repos/${repository}/actions/runs?head_sha=${revision}&per_page=100`)).flatMap((page) => page.workflow_runs),
    create: (tag, version, notes) =>
      run('gh', ['release', 'create', tag, ...repo, '--verify-tag', '--draft', '--title', `SongFrame ${version}`, '--notes-file', notes]),
    upload: (tag, file) => run('gh', ['release', 'upload', tag, file, ...repo]),
    publish: (tag) => run('gh', ['release', 'edit', tag, ...repo, '--draft=false', '--latest']),
    removeIncomplete: (asset) => run('gh', ['api', '--method', 'DELETE', `repos/${repository}/releases/assets/${asset.id}`]),
    latest: async () => JSON.parse(await run('gh', ['api', `repos/${repository}/releases/latest`]))
  };
}

/** Состояние CI коммита: success, failure, pending или absent. Учитывается последний запуск workflow CI. */
export function ciState(runs) {
  const latest = runs.filter((item) => item.name === 'CI').sort((a, b) => (b.run_attempt ?? 1) - (a.run_attempt ?? 1) || b.id - a.id)[0];
  if (!latest) return 'absent';
  if (latest.status !== 'completed') return 'pending';
  return latest.conclusion === 'success' ? 'success' : 'failure';
}

/** GitHub сам вычисляет digest загруженного файла: метаданные сверяются без скачивания содержимого. */
function verifyRemoteAsset(remote, asset, tag) {
  requireState(remote?.state === 'uploaded' && remote.size === asset.size, `Размер или состояние вложения ${asset.name} на GitHub не совпадает.`);
  requireState(remote.digest === `sha256:${asset.sha256}`, `SHA-256 вложения ${asset.name} на GitHub отсутствует или не совпадает с локальным файлом.`);
  // У черновика временный адрес untagged-…; окончательный проверяется после публикации.
  const url = `${releaseBase}download/${tag}/${encodeURIComponent(asset.name)}`;
  requireState(!tag || remote.browser_download_url === url, `Адрес вложения ${asset.name} не совпадает с версионным.`);
  return { name: asset.name, url, size: remote.size, sha256: asset.sha256 };
}

/** Сборка и приёмка обеих поставок, те же шаги, что описаны для ручной проверки в docs/development.md. */
async function buildDeliveries({ version, run, cwd, reports }) {
  const { image, installer } = assetNames(version);
  // prepare уже сверил версию с package.json; явное значение исключает чужой SONGFRAME_VERSION из окружения.
  const env = { SONGFRAME_VERSION: version, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  const step = (command, args) => run(command, args, { cwd, inherit: true, env });
  await step('yarn', ['dist:linux']);
  await step('yarn', ['smoke:runtime']);
  await step('yarn', ['prepare:smoke-model']);
  await step('yarn', ['smoke:appimage', '--docker', `--appimage=build/release/${image}`, '--model=build/runtime/smoke-model', `--output=${reports}`]);
  await step('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'scripts/runtime', '-p', 'test_check_windows_installer.py']);
  await step('yarn', ['dist:win']);
  await step('python3', ['-B', 'scripts/runtime/check-windows-installer.py', `build/release/${installer}`, '--version', version]);
}

export function createRelease(options = {}) {
  const cwd = options.cwd ?? root;
  const run = (command, args, extra = {}) => (options.run ?? runCommand)(command, args, { cwd, ...extra });
  const github = options.github ?? githubClient(run);
  const build = options.build ?? buildDeliveries;
  const git = (...args) => run('git', args);
  const directoryFor = (tag) => join(cwd, 'build/releases', tag);

  async function state(version) {
    if (version !== undefined) {
      requireState(!version.startsWith('v'), 'Передайте --version без префикса v.');
      versionInput(version);
    }
    const remote = await git('remote', 'get-url', 'origin');
    requireState(
      [`git@github.com:${repository}`, `https://github.com/${repository}`, `ssh://git@github.com/${repository}`].some(
        (url) => remote === url || remote === `${url}.git`
      ),
      `origin должен указывать на ${repository} на GitHub.`
    );
    const revision = await git('rev-parse', 'HEAD');
    const clean = !(await git('status', '--porcelain'));
    const refs = new Map(
      (await git('ls-remote', '--heads', '--tags', 'origin'))
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(/\s+/).reverse())
    );
    const tagRevision = (tag) => refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
    const releases = await github.releases();
    // Предыдущий выпуск определяется опубликованными релизами, а не любым локальным тегом.
    const published = releases.filter((item) => !item.draft && !item.prerelease && stableTag.test(item.tag_name));
    published.sort((a, b) => compareVersions(b.tag_name, a.tag_name));
    const newest = published[0];
    const packageVersion = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')).version;
    requireState(
      typeof packageVersion === 'string' && stableTag.test(`v${packageVersion}`),
      'Версия в package.json должна иметь формат X.Y.Z без префикса v. Исправьте её и зафиксируйте изменение отдельным коммитом.'
    );
    const selected = version ?? (newest ? newest.tag_name.slice(1).replace(/\d+$/, (patch) => String(BigInt(patch) + 1n)) : packageVersion);
    const tag = `v${selected}`;
    const previous = published.find((item) => item.tag_name !== tag && compareVersions(item.tag_name, tag) < 0);
    const previousRevision = previous ? tagRevision(previous.tag_name) : null;
    if (previous) {
      requireState(previousRevision, 'У предыдущего опубликованного релиза нет тега на GitHub.');
      await git('merge-base', '--is-ancestor', previousRevision, revision).catch(() => {
        throw new ReleaseError('Предыдущий релиз не является предком HEAD или его коммита нет локально. Получите историю и теги origin.');
      });
    }
    return {
      revision,
      clean,
      refs,
      newest,
      previous,
      previousRevision,
      packageVersion,
      version: selected,
      tag,
      existing: releases.find((item) => item.tag_name === tag),
      remoteTag: tagRevision(tag)
    };
  }

  async function assertLocalTag(tag, revision) {
    const local = await git('rev-parse', `refs/tags/${tag}^{commit}`).catch(() => null);
    requireState(local === revision, `Локальный тег ${tag} не указывает на коммит подготовленного выпуска.`);
  }

  async function readPrepared(tag, version) {
    const directory = directoryFor(tag);
    const metadata = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8').catch(() => 'null'));
    requireState(metadata, `Выпуск ${tag} не подготовлен: сначала выполните release prepare.`);
    requireState(metadata.schema === 1 && metadata.tag === tag && metadata.version === version, 'Подготовленный комплект относится к другой версии.');
    const notes = await readFile(join(directory, 'notes.md'), 'utf8');
    requireState(sha(notes) === metadata.notesSha256, 'Описание изменилось после подготовки релиза.');
    const assets = await checkedAssets(version, directory);
    requireState(JSON.stringify(assets) === JSON.stringify(metadata.assets), 'Файлы комплекта изменились после подготовки релиза.');
    return { directory, metadata, notes, assets: assets.map((asset) => ({ ...asset, file: join(directory, asset.name) })) };
  }

  async function plan(version) {
    const current = await state(version);
    const range = current.previousRevision ? `${current.previousRevision}..${current.revision}` : current.revision;
    const log = (await git('log', '--reverse', '--format=%H%x00%s%x00%b%x00', range)).split('\0');
    const commits = [];
    for (let i = 0; i + 2 < log.length; i += 3) commits.push({ revision: log[i].trim(), subject: log[i + 1], body: log[i + 2].trim() });
    return {
      version: current.version,
      packageVersion: current.packageVersion,
      tag: current.tag,
      revision: current.revision,
      previousTag: current.previous?.tag_name ?? null,
      previousRevision: current.previousRevision,
      firstRelease: !current.previous,
      workingTreeClean: current.clean,
      remoteMainMatches: current.refs.get('refs/heads/main') === current.revision,
      ci: ciState(await github.ci(current.revision)),
      releaseState: current.existing ? (current.existing.draft ? 'draft' : 'published') : 'absent',
      remoteTagExists: Boolean(current.remoteTag),
      prepared: existsSync(join(directoryFor(current.tag), 'release.json')),
      commits,
      // Для первого выпуска изменения считаются от пустого дерева: это весь состав репозитория.
      changes: await git('diff', '--stat', current.previousRevision ?? emptyTree, current.revision)
    };
  }

  async function prepare(version, notesFile) {
    requireState(version && notesFile, 'prepare требует --version и --notes.');
    const current = await state(version);
    requireState(current.clean, 'Подготовка требует чистого дерева. Зафиксируйте изменения отдельным действием.');
    // Тег должен закреплять сам номер выпуска, чтобы обычная сборка того же коммита имела ту же версию.
    requireState(
      current.packageVersion === version,
      `Версия выпуска ${version} не совпадает с package.json (${current.packageVersion}). Обновите version в package.json до ${version} и зафиксируйте изменение отдельным коммитом перед prepare.`
    );
    requireState(!current.existing || current.existing.draft, 'Эта версия уже опубликована; для изменений выберите новую.');
    requireState(
      !current.newest || compareVersions(current.tag, current.newest.tag_name) > 0,
      'Новая версия должна быть выше последнего опубликованного релиза.'
    );
    requireState(!current.remoteTag || current.remoteTag === current.revision, 'Тег этой версии на GitHub указывает на другой коммит.');
    const notes = await readFile(resolve(cwd, notesFile), 'utf8');
    requireState(notes.trim(), 'Описание релиза не должно быть пустым.');
    const hasLocalTag = Boolean(await git('tag', '--list', current.tag));
    if (hasLocalTag) await assertLocalTag(current.tag, current.revision);
    const directory = directoryFor(current.tag);
    if (existsSync(join(directory, 'release.json'))) {
      const prepared = await readPrepared(current.tag, version);
      requireState(prepared.metadata.revision === current.revision, 'Комплект этой версии подготовлен из другого коммита.');
      requireState(prepared.notes === notes, 'Релиз уже подготовлен с другим описанием.');
      return { tag: current.tag, revision: current.revision, directory: relative(cwd, directory), prepared: true, reused: true };
    }
    // Готовые байты одной версии не заменяются другой сборкой молча: незавершённый каталог разбирают вручную.
    requireState(!existsSync(directory), `Каталог ${relative(cwd, directory)} остался от незавершённой подготовки. Удалите его перед повтором prepare.`);
    if (!hasLocalTag) await git('tag', '-a', current.tag, '-m', `Релиз SongFrame ${version}`, current.revision);
    await mkdir(directory, { recursive: true });
    await build({ version, run, cwd, reports: join(directory, 'linux-smoke') });
    requireState(
      (await git('rev-parse', 'HEAD')) === current.revision && !(await git('status', '--porcelain')),
      'HEAD или рабочее дерево изменились во время сборки.'
    );
    // Поставки остаются в build/release; комплект хранит жёсткие ссылки на те же байты, чтобы следующая сборка их не подменила.
    for (const name of assetNames(version).all) {
      const source = join(cwd, 'build/release', name);
      await link(source, join(directory, name)).catch(() => copyFile(source, join(directory, name)));
    }
    const assets = await checkedAssets(version, directory);
    await writeFile(join(directory, 'notes.md'), notes);
    await writeFile(
      join(directory, 'release.json'),
      JSON.stringify(
        { schema: 1, tag: current.tag, version, revision: current.revision, previousTag: current.previous?.tag_name ?? null, notesSha256: sha(notes), assets },
        null,
        2
      ) + '\n'
    );
    return { tag: current.tag, revision: current.revision, directory: relative(cwd, directory), prepared: true, reused: false };
  }

  async function publish(version) {
    requireState(version, 'publish требует --version.');
    let current = await state(version);
    requireState(current.clean, 'Публикация требует чистого рабочего дерева.');
    requireState(current.refs.get('refs/heads/main') === current.revision, 'Перед публикацией отправьте текущий коммит в main на GitHub.');
    requireState(
      !current.newest || compareVersions(current.tag, current.newest.tag_name) >= 0,
      'На GitHub уже есть более новый релиз; latest не будет понижен.'
    );
    const { directory, metadata, notes, assets } = await readPrepared(current.tag, version);
    const { revision } = metadata;
    await assertLocalTag(current.tag, revision);
    // Комплект закреплён тегом; HEAD с инструментом публикации может быть новее, но исходный коммит обязан быть в main.
    await git('merge-base', '--is-ancestor', revision, current.revision).catch(() => {
      throw new ReleaseError('Исходный коммит комплекта отсутствует в main на GitHub.');
    });
    const ci = ciState(await github.ci(revision));
    // CI не запускается на правки только документации; тогда его запускают вручную для того же коммита.
    const hint =
      ci === 'absent' ? ' Запустите его: gh workflow run CI --ref main.' : ci === 'failure' ? ' Отменённый запуск перезапускают: gh run rerun <id>.' : '';
    requireState(ci === 'success', `CI исходного коммита ${revision.slice(0, 12)}: ${ci}. Публикация требует успешного CI этого коммита.${hint}`);
    requireState(!current.remoteTag || current.remoteTag === revision, 'Тег на GitHub не соответствует подготовленному комплекту.');
    if (!current.remoteTag) await git('push', 'origin', `refs/tags/${current.tag}`);
    if (!current.existing) {
      await github.create(current.tag, version, join(directory, 'notes.md'));
      current = await state(version);
    }
    const release = current.existing;
    requireState(
      release && !release.prerelease && release.name === `SongFrame ${version}` && (release.body ?? '').trimEnd() === notes.trimEnd(),
      'Описание, имя или канал существующего релиза отличаются от подготовленного комплекта.'
    );
    const names = new Set(assets.map((asset) => asset.name));
    const remoteAssets = await github.assets(release);
    requireState(
      new Set(remoteAssets.map((asset) => asset.name)).size === remoteAssets.length && remoteAssets.every((asset) => names.has(asset.name)),
      'В релизе есть лишние или повторяющиеся вложения.'
    );
    for (const asset of assets) {
      let remote = remoteAssets.find((item) => item.name === asset.name);
      // После обрыва загрузки GitHub оставляет пустой starter: в черновике удаляется только этот след.
      if (release.draft && remote?.state === 'starter' && remote.size === 0) {
        await github.removeIncomplete(remote);
        remote = undefined;
      }
      if (!remote) {
        requireState(release.draft, 'В опубликованном релизе не хватает вложений; опубликованные файлы не изменяются.');
        await github.upload(current.tag, asset.file);
        remote = (await github.assets(release)).find((item) => item.name === asset.name);
      }
      verifyRemoteAsset(remote, asset);
    }
    const fresh = await state(version);
    requireState(
      fresh.clean && fresh.revision === current.revision && fresh.remoteTag === revision && fresh.refs.get('refs/heads/main') === current.revision,
      'Git-состояние изменилось во время загрузки; публикация остановлена.'
    );
    requireState(!fresh.newest || compareVersions(current.tag, fresh.newest.tag_name) >= 0, 'Во время загрузки опубликован более новый релиз.');
    if (release.draft) await github.publish(current.tag);
    const latest = await github.latest();
    requireState(latest.tag_name === current.tag && !latest.draft && !latest.prerelease, 'Релиз не стал latest; проверьте состояние GitHub.');
    // После публикации список читается заново: проверка черновика не заменяет проверку опубликованного выпуска.
    const published = await github.assets(latest);
    requireState(
      published.length === assets.length && published.every((asset) => names.has(asset.name)),
      `Опубликованный релиз должен содержать ровно ${assets.length} ожидаемых вложений.`
    );
    const verified = assets.map((asset) =>
      verifyRemoteAsset(
        published.find((item) => item.name === asset.name),
        asset,
        current.tag
      )
    );
    await writeFile(
      join(directory, 'public-release.json'),
      JSON.stringify({ schema: 1, tag: current.tag, revision, verification: 'github-api-sha256', assets: verified }, null, 2) + '\n'
    );
    return {
      tag: current.tag,
      revision,
      url: `${releaseBase}tag/${current.tag}`,
      published: true,
      assetsVerified: true,
      verification: 'github-api-sha256',
      assets: verified.length
    };
  }

  return { plan, prepare, publish };
}

async function main() {
  const { values, positionals } = parseArgs({ options: { version: { type: 'string' }, notes: { type: 'string' } }, allowPositionals: true });
  const [command] = positionals;
  requireState(
    positionals.length === 1 && ['plan', 'prepare', 'publish'].includes(command) && (command === 'prepare' || !values.notes),
    'Команды: release plan [--version 0.2.0], release prepare --version 0.2.0 --notes <файл>, release publish --version 0.2.0.'
  );
  const release = createRelease();
  const result = command === 'prepare' ? await release.prepare(values.version, values.notes) : await release[command](values.version);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof ReleaseError ? error.message : `Выпуск остановлен: ${error.message}`);
    process.exitCode = 1;
  });
}
