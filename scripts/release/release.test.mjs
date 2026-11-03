import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { assetNames, ciState, compareVersions, createRelease, releaseBase, repository, ReleaseError, runCommand, versionInput } from './release.mjs';

const version = '0.2.0';
const tag = `v${version}`;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Настоящий Git работает во временной копии с локальным origin; GitHub и сборка поставок подменены. */
async function fixture(context, { packageVersion = version } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'songframe-release-test-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const cwd = join(temporary, 'songframe');
  const origin = join(temporary, 'origin.git');
  await mkdir(cwd);
  const git = (...args) => runCommand('git', args, { cwd });
  await git('init', '--initial-branch=main');
  await git('config', 'user.name', 'Проверка релизов');
  await git('config', 'user.email', 'release-test@example.invalid');
  await writeFile(join(cwd, '.gitignore'), 'build/\n');
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'songframe', version: packageVersion }));
  await git('add', '.');
  await git('commit', '-m', 'Начальное состояние');
  await runCommand('git', ['init', '--bare', origin], { cwd });
  await git('remote', 'add', 'origin', origin);
  await git('push', 'origin', 'main');
  await mkdir(join(cwd, 'build/releases'), { recursive: true });
  const notes = join(cwd, 'build/releases/notes.md');
  await writeFile(notes, 'Первый выпуск SongFrame.\n');

  const calls = [];
  const releases = [];
  const runs = [];
  let nextId = 1;
  let builds = 0;
  const failures = { upload: false, digest: false };
  const github = {
    releases: async () => structuredClone(releases),
    assets: async (release) => {
      const current = releases.find((item) => item.id === release.id);
      return structuredClone(current.assets).map((asset) => (failures.digest && !current.draft ? { ...asset, digest: null } : asset));
    },
    ci: async (revision) => runs.filter((item) => item.head_sha === revision),
    create: async (name, value, file) => {
      calls.push(['create', name]);
      releases.push({
        id: nextId++,
        tag_name: name,
        name: `SongFrame ${value}`,
        body: await readFile(file, 'utf8'),
        draft: true,
        prerelease: false,
        assets: []
      });
    },
    upload: async (name, file) => {
      const release = releases.find((item) => item.tag_name === name);
      if (failures.upload && calls.filter(([call]) => call === 'upload').length === 3) {
        failures.upload = false;
        release.assets.push({ id: nextId++, name: basename(file), size: 0, state: 'starter' });
        throw new ReleaseError('Сбой тестовой сети');
      }
      const content = await readFile(file);
      calls.push(['upload', basename(file)]);
      release.assets.push({
        id: nextId++,
        name: basename(file),
        size: content.length,
        state: 'uploaded',
        digest: `sha256:${sha(content)}`,
        browser_download_url: `${releaseBase}download/untagged-fixture/${basename(file)}`
      });
    },
    removeIncomplete: async (asset) => {
      calls.push(['removeIncomplete', asset.name]);
      for (const release of releases) release.assets = release.assets.filter((entry) => entry.id !== asset.id);
    },
    publish: async (name) => {
      calls.push(['publish', name]);
      const release = releases.find((item) => item.tag_name === name);
      release.draft = false;
      for (const asset of release.assets) asset.browser_download_url = `${releaseBase}download/${name}/${encodeURIComponent(asset.name)}`;
    },
    latest: async () => releases.filter((item) => !item.draft).sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0]
  };
  // Сборка-имитация кладёт в build/release маленькие поставки и согласованные с ними отчёты.
  const build = async ({ version: value, cwd: directory }) => {
    builds++;
    const { image, installer } = assetNames(value);
    const release = join(directory, 'build/release');
    await mkdir(release, { recursive: true });
    const hashes = {};
    for (const name of [image, installer]) {
      const bytes = Buffer.from(`\0поставка ${name}\xff`);
      hashes[name] = sha(bytes);
      await writeFile(join(release, name), bytes);
      await writeFile(join(release, `${name}.sha256`), `${hashes[name]}  ${name}\n`);
    }
    const json = (name, value) => writeFile(join(release, name), JSON.stringify(value));
    await json('linux-smoke-result.json', { ok: true, appimage: image, sha256: hashes[image] });
    await json('windows-installer-check.json', { ok: true, installer, sha256: hashes[installer], version: value, target: 'win32-x64', nativeExecution: false });
    await json('linux-distribution.json', { version: value, target: 'linux-x64' });
    await writeFile(join(release, 'THIRD_PARTY_LICENSES.md'), '# Лицензии тестовой поставки\n');
  };
  const release = createRelease({
    cwd,
    github,
    build,
    run: (command, args, options) => {
      calls.push([command, ...args]);
      // Проверяется настоящий локальный origin, а наружу он представляется адресом GitHub.
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return Promise.resolve(`git@github.com:${repository}.git`);
      return runCommand(command, args, options);
    }
  });
  const head = () => git('rev-parse', 'HEAD');
  const passCi = async (revision) =>
    runs.push({ id: runs.length + 1, name: 'CI', head_sha: revision ?? (await head()), status: 'completed', conclusion: 'success' });
  return { cwd, git, notes, calls, releases, runs, failures, release, head, passCi, builds: () => builds };
}

test('версия принимает X.Y.Z и отклоняет префикс, ведущие нули и команды оболочки', () => {
  assert.equal(versionInput('10.0.123'), '10.0.123');
  for (const value of ['v0.2.0', '00.2.0', '0.02.0', '0.2.00', '0.2.0; echo bad', '$(echo 0.2.0)', undefined])
    assert.throws(() => versionInput(value), /X\.Y\.Z/);
  assert.equal(compareVersions('v0.10.0', '0.9.0'), 1);
});

test('состояние CI берёт последнюю попытку workflow CI', () => {
  assert.equal(ciState([]), 'absent');
  assert.equal(ciState([{ id: 1, name: 'Другой', status: 'completed', conclusion: 'success' }]), 'absent');
  assert.equal(ciState([{ id: 1, name: 'CI', status: 'in_progress' }]), 'pending');
  const cancelled = { id: 1, name: 'CI', run_attempt: 1, status: 'completed', conclusion: 'cancelled' };
  assert.equal(ciState([cancelled]), 'failure');
  assert.equal(ciState([cancelled, { ...cancelled, run_attempt: 2, conclusion: 'success' }]), 'success');
});

test('состояние CI не заменяет автоматический результат частичным ручным успехом', () => {
  const automatic = { id: 1, name: 'CI', event: 'push', status: 'completed', conclusion: 'failure' };
  for (const display_title of ['CI · manual/auto', 'CI · manual/selected', 'CI · manual/unknown', undefined]) {
    // Большие id и номер попытки не должны дать исключённому запуску преимущество при сортировке.
    const partial = { id: 100, name: 'CI', event: 'workflow_dispatch', display_title, run_attempt: 10, status: 'completed', conclusion: 'success' };
    for (const event of ['push', 'pull_request', undefined]) {
      assert.equal(ciState([{ ...automatic, event }, partial]), 'failure');
      assert.equal(ciState([{ ...automatic, event, status: 'in_progress', conclusion: null }, partial]), 'pending');
      assert.equal(ciState([{ ...automatic, event, conclusion: 'success' }, partial]), 'success');
    }
    assert.equal(ciState([partial]), 'absent');
  }
});

test('состояние CI принимает полный ручной набор по его обычному статусу', () => {
  const full = { id: 1, name: 'CI', event: 'workflow_dispatch', display_title: 'CI · manual/all', status: 'completed', conclusion: 'success' };
  assert.equal(ciState([full]), 'success');
  assert.equal(ciState([{ ...full, status: 'queued', conclusion: null }]), 'pending');
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped']) {
    assert.equal(ciState([{ ...full, conclusion }]), 'failure');
  }
  for (const display_title of ['', 'CI', 'CI · manual/all ', 'CI · manual/selected']) {
    assert.equal(ciState([{ ...full, display_title }]), 'absent');
  }
});

test('состояние CI сортирует только квалифицируемые попытки полного и автоматического запуска', () => {
  const automatic = { id: 1, name: 'CI', event: 'push', status: 'completed', conclusion: 'failure' };
  const full = { ...automatic, id: 2, event: 'workflow_dispatch', display_title: 'CI · manual/all', conclusion: 'success' };
  const partial = { ...automatic, id: 100, event: 'workflow_dispatch', display_title: 'CI · manual/selected', run_attempt: 10, conclusion: 'success' };
  assert.equal(ciState([partial, automatic, full]), 'success');
  assert.equal(ciState([full, partial, { ...automatic, id: 3, status: 'in_progress', conclusion: null }]), 'pending');
  assert.equal(ciState([partial, full, { ...automatic, id: 3 }]), 'failure');
  assert.equal(ciState([partial, { ...full, run_attempt: 2 }, { ...automatic, id: 3 }]), 'success');
  assert.equal(ciState([{ ...full, name: 'Другой workflow' }, partial]), 'absent');
});

test('план первого выпуска берёт версию package.json и не требует чистого дерева', async (context) => {
  const { cwd, release, head } = await fixture(context, { packageVersion: '0.1.0' });
  await writeFile(join(cwd, 'черновик.txt'), 'не закоммичено');
  const plan = await release.plan();
  assert.equal(plan.version, '0.1.0');
  assert.equal(plan.packageVersion, '0.1.0');
  assert.equal(plan.revision, await head());
  assert.equal(plan.firstRelease, true);
  assert.equal(plan.workingTreeClean, false);
  assert.equal(plan.remoteMainMatches, true);
  assert.equal(plan.ci, 'absent');
  assert.equal(plan.releaseState, 'absent');
  assert.equal(plan.commits.length, 1);
  assert.match(plan.changes, /package\.json/);
});

test('план явной версии показывает package.json и ничего не меняет при расхождении', async (context) => {
  const { cwd, git, release, builds } = await fixture(context);
  const original = await readFile(join(cwd, 'package.json'), 'utf8');
  const tags = await git('tag', '--list');
  const status = await git('status', '--porcelain');
  const plan = await release.plan('0.3.0');
  assert.equal(plan.version, '0.3.0');
  assert.equal(plan.packageVersion, version);
  assert.equal(await readFile(join(cwd, 'package.json'), 'utf8'), original);
  assert.equal(await git('tag', '--list'), tags);
  assert.equal(await git('status', '--porcelain'), status);
  assert(!existsSync(join(cwd, 'build/releases/v0.3.0')));
  assert.equal(builds(), 0);
});

test('prepare отклоняет расхождение с package.json до тега, каталога и сборки', async (context) => {
  const { cwd, git, notes, release, builds } = await fixture(context);
  const original = await readFile(join(cwd, 'package.json'), 'utf8');
  await assert.rejects(release.prepare('0.3.0', notes), /не совпадает с package\.json.*Обновите version.*зафиксируйте/);
  assert.equal(await readFile(join(cwd, 'package.json'), 'utf8'), original);
  assert.equal(await git('tag', '--list'), '');
  assert.equal(await git('status', '--porcelain'), '');
  assert(!existsSync(join(cwd, 'build/releases/v0.3.0')));
  assert.equal(builds(), 0);
});

test('prepare отклоняет некорректную версию package.json до тега и сборки', async (context) => {
  const { cwd, git, notes, release, builds } = await fixture(context, { packageVersion: 'v0.2.0' });
  await assert.rejects(release.prepare(version, notes), /Версия в package\.json.*X\.Y\.Z/);
  assert.equal(await git('tag', '--list'), '');
  assert(!existsSync(join(cwd, 'build/releases', tag)));
  assert.equal(builds(), 0);
});

test('prepare с версией package.json ставит только локальный тег, собирает комплект и повторно его не пересобирает', async (context) => {
  const { cwd, git, notes, calls, release, head, builds } = await fixture(context);
  const result = await release.prepare(version, notes);
  assert.deepEqual(result, { tag, revision: await head(), directory: `build/releases/${tag}`, prepared: true, reused: false });
  assert.equal(await git('rev-parse', `${tag}^{commit}`), await head());
  assert(!calls.some(([command, sub]) => command === 'git' && sub === 'push'));
  const metadata = JSON.parse(await readFile(join(cwd, 'build/releases', tag, 'release.json'), 'utf8'));
  assert.equal(metadata.assets.length, 8);
  assert.equal(JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')).version, version);
  assert.equal((await release.prepare(version, notes)).reused, true);
  assert.equal(builds(), 1);
  await writeFile(notes, 'Другое описание.\n');
  await assert.rejects(release.prepare(version, notes), /другим описанием/);
});

test('prepare отказывает при грязном дереве, пустом описании и незавершённом каталоге', async (context) => {
  const { cwd, notes, release, builds } = await fixture(context);
  await writeFile(join(cwd, 'черновик.txt'), 'не закоммичено');
  await assert.rejects(release.prepare(version, notes), /чистого дерева/);
  await rm(join(cwd, 'черновик.txt'));
  await writeFile(notes, ' \n');
  await assert.rejects(release.prepare(version, notes), /пустым/);
  await writeFile(notes, 'Описание.\n');
  await mkdir(join(cwd, 'build/releases', tag));
  await assert.rejects(release.prepare(version, notes), /незавершённой подготовки/);
  assert.equal(builds(), 0);
});

test('изменённая после подготовки поставка останавливает публикацию', async (context) => {
  const { cwd, notes, release, passCi } = await fixture(context);
  await release.prepare(version, notes);
  await passCi();
  await writeFile(join(cwd, 'build/releases', tag, 'THIRD_PARTY_LICENSES.md'), '# Подменено\n');
  await assert.rejects(release.publish(version), /изменились после подготовки/);
});

test('publish требует успешного CI исходного коммита', async (context) => {
  const { notes, calls, release } = await fixture(context);
  await release.prepare(version, notes);
  await assert.rejects(release.publish(version), /CI исходного коммита [a-f0-9]{12}: absent.*gh workflow run CI --ref main -f "mode=Полный набор"/);
  assert(!calls.some(([command, sub]) => command === 'git' && sub === 'push'));
});

test('publish отправляет тег, загружает 8 файлов, публикует и сверяет хеши; после сбоя загрузки повтор завершает выпуск', async (context) => {
  const { cwd, git, notes, calls, releases, failures, release, passCi } = await fixture(context);
  await release.prepare(version, notes);
  await passCi();
  failures.upload = true;
  await assert.rejects(release.publish(version), /Сбой тестовой сети/);
  assert.equal(releases[0].draft, true);
  const result = await release.publish(version);
  assert.deepEqual(result, {
    tag,
    revision: await git('rev-parse', 'HEAD'),
    url: `${releaseBase}tag/${tag}`,
    published: true,
    assetsVerified: true,
    verification: 'github-api-sha256',
    assets: 8
  });
  assert.equal(calls.filter(([call]) => call === 'removeIncomplete').length, 1);
  assert.equal(calls.filter(([call]) => call === 'upload').length, 8);
  assert.equal(releases[0].draft, false);
  assert.equal(await git('ls-remote', 'origin', `refs/tags/${tag}`).then((line) => line.split(/\s+/)[1]), `refs/tags/${tag}`);
  const receipt = JSON.parse(await readFile(join(cwd, 'build/releases', tag, 'public-release.json'), 'utf8'));
  assert.equal(receipt.assets.length, 8);
  assert(receipt.assets.every((asset) => asset.url.startsWith(`${releaseBase}download/${tag}/`)));
  // Повтор по опубликованному выпуску только проверяет его и ничего не загружает.
  await release.publish(version);
  assert.equal(calls.filter(([call]) => call === 'upload').length, 8);
});

test('publish допускает более новый HEAD, если исходный коммит комплекта в main', async (context) => {
  const { cwd, git, notes, release, passCi, head } = await fixture(context);
  await release.prepare(version, notes);
  const source = await head();
  await passCi(source);
  await writeFile(join(cwd, 'инструмент.txt'), 'правка сценария публикации');
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'songframe', version: '0.3.0' }));
  await git('add', '.');
  await git('commit', '-m', 'Правка инструмента публикации');
  await assert.rejects(release.publish(version), /отправьте текущий коммит в main/);
  await git('push', 'origin', 'main');
  assert.equal((await release.publish(version)).revision, source);
});

test('повтор publish восстанавливает starter полного размера без digest только в черновике', async (context) => {
  const { cwd, notes, calls, releases, failures, release, passCi, builds } = await fixture(context);
  await release.prepare(version, notes);
  await passCi();
  failures.upload = true;
  await assert.rejects(release.publish(version), /Сбой тестовой сети/);
  const incomplete = releases[0].assets.find((asset) => asset.state === 'starter');
  incomplete.size = (await readFile(join(cwd, 'build/releases', tag, incomplete.name))).length;
  incomplete.digest = null;
  const retained = structuredClone(releases[0].assets.filter((asset) => asset.id !== incomplete.id));
  assert.equal((await release.publish(version)).assetsVerified, true);
  assert.deepEqual(
    calls.filter(([call]) => call === 'removeIncomplete'),
    [['removeIncomplete', incomplete.name]]
  );
  assert.equal(calls.filter(([call]) => call === 'upload').length, 8);
  assert.equal(builds(), 1);
  assert(!releases[0].assets.some((asset) => asset.id === incomplete.id));
  for (const asset of retained) {
    const remote = releases[0].assets.find((entry) => entry.id === asset.id);
    assert.equal(remote.digest, asset.digest);
    assert.equal(remote.size, asset.size);
  }
});

for (const scenario of [
  'частичный размер',
  'нулевой starter с digest',
  'полный starter с digest',
  'uploaded другого размера',
  'uploaded без digest',
  'опубликованный starter'
]) {
  test(`publish не удаляет и не заменяет вложение: ${scenario}`, async (context) => {
    const { cwd, notes, calls, releases, failures, release, passCi } = await fixture(context);
    await release.prepare(version, notes);
    await passCi();
    failures.upload = true;
    await assert.rejects(release.publish(version), /Сбой тестовой сети/);
    const current = releases[0];
    const incomplete = current.assets.find((asset) => asset.state === 'starter');
    const size = (await readFile(join(cwd, 'build/releases', tag, incomplete.name))).length;
    incomplete.size = size;
    incomplete.digest = null;
    if (scenario === 'частичный размер') incomplete.size = size - 1;
    if (scenario === 'нулевой starter с digest') incomplete.size = 0;
    if (scenario.endsWith('starter с digest')) incomplete.digest = `sha256:${'0'.repeat(64)}`;
    if (scenario.startsWith('uploaded')) incomplete.state = 'uploaded';
    if (scenario === 'uploaded другого размера') incomplete.size = size - 1;
    if (scenario === 'опубликованный starter') current.draft = false;
    const before = structuredClone(current);
    const mutations = calls.filter(([call]) => ['upload', 'removeIncomplete', 'publish'].includes(call));
    await assert.rejects(release.publish(version), /Размер или состояние вложения|SHA-256 вложения/);
    assert.deepEqual(current, before);
    assert.deepEqual(
      calls.filter(([call]) => ['upload', 'removeIncomplete', 'publish'].includes(call)),
      mutations
    );
  });
}

test('отсутствующий digest после публикации останавливает проверку без квитанции', async (context) => {
  const { cwd, notes, failures, release, passCi } = await fixture(context);
  await release.prepare(version, notes);
  await passCi();
  failures.digest = true;
  await assert.rejects(release.publish(version), /SHA-256 вложения/);
  assert(!existsSync(join(cwd, 'build/releases', tag, 'public-release.json')));
});

test('следующая версия по умолчанию — patch после последнего опубликованного выпуска, план считает изменения от его тега', async (context) => {
  const { cwd, git, notes, release, passCi } = await fixture(context);
  await release.prepare(version, notes);
  await passCi();
  await release.publish(version);
  await writeFile(join(cwd, 'новое.txt'), 'новая возможность');
  await git('add', '.');
  await git('commit', '-m', 'Новая возможность');
  const plan = await release.plan();
  assert.equal(plan.version, '0.2.1');
  assert.equal(plan.packageVersion, version);
  assert.equal(plan.previousTag, tag);
  assert.deepEqual(
    plan.commits.map((commit) => commit.subject),
    ['Новая возможность']
  );
  await git('push', 'origin', 'main');
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'songframe', version: '0.1.5' }));
  await git('add', 'package.json');
  await git('commit', '-m', 'Версия ниже опубликованной');
  await assert.rejects(release.prepare('0.1.5', notes), /выше последнего опубликованного/);
});
