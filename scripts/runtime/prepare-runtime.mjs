/** Подготовка Python для Linux или готовой Windows-поставки; версии и хеши закреплены рядом. @link README.md */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { download } from './download.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const host = `${process.platform}-${process.arch}`;
const target = process.argv.find((arg) => arg.startsWith('--target='))?.slice('--target='.length) ?? host;
const crossWindows = host === 'linux-x64' && target === 'win32-x64';
if (target !== host && !crossWindows) throw new Error(`Сборка ${target} из ${host} не поддерживается.`);
const lock = JSON.parse(await readFile(join(here, 'runtime-lock.json'), 'utf8'));
const distribution = lock.platforms[target];
if (!distribution) throw new Error(`Подготовка runtime поддерживает Linux x64 и Windows x64, получено ${target}.`);
const requirements = join(here, `requirements-${target}.lock`);
const requirementsSha256 = createHash('sha256')
  .update(await readFile(requirements))
  .digest('hex');
const recipe = await Promise.all(
  [
    'prepare-runtime.mjs',
    'download.mjs',
    'prepare-windows.py',
    'requirements-build.lock',
    'runtime-probe.py',
    'collect-licenses.py',
    'licenses/CTranslate2-LICENSE',
    'licenses/README.md'
  ].map((name) => readFile(join(here, name)))
);
const recipeHash = createHash('sha256');
for (const content of recipe) recipeHash.update(content);
const fingerprint = createHash('sha256')
  .update(JSON.stringify({ lock, requirementsSha256, recipeSha256: recipeHash.digest('hex') }))
  .digest('hex');
const root = join(repo, 'build/runtime', target);

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: repo, env, stdio: 'inherit', shell: false, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Не удалось выполнить ${command}: ${result.error?.message ?? result.status}`);
}

let current;
try {
  current = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
} catch {
  // Прерванная подготовка не считается готовой поставкой.
}
if (current?.fingerprint === fingerprint) {
  await stat(join(root, distribution.executable));
  console.log(`Runtime ${target} уже подготовлен. Проверка: yarn smoke:runtime`);
} else {
  const cache = join(repo, 'build/runtime/downloads');
  await mkdir(cache, { recursive: true });
  const archive = join(cache, decodeURIComponent(new URL(distribution.url).pathname.split('/').pop()));
  console.log(`Подготовка CPython ${lock.python}: ${target}`);
  await download(distribution.url, distribution.sha256, archive);
  const staging = `${root}.preparing`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  run('tar', ['-xzf', archive, '-C', staging]);
  const python = join(staging, distribution.executable);
  const env = { ...process.env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' };
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  const wheels = join(cache, target);
  await mkdir(wheels, { recursive: true });
  if (crossWindows) {
    // Сначала получаем сборочный Linux Python; Windows Python здесь не запускается и не подменяется Linux-пакетами.
    run(process.execPath, [fileURLToPath(import.meta.url)], env);
    const builder = join(repo, 'build/runtime', host, lock.platforms[host].executable);
    const verifiedWheels = join(staging, 'wheels');
    run(
      builder,
      [
        '-I',
        '-B',
        '-X',
        'utf8',
        '-m',
        'pip',
        'download',
        '--disable-pip-version-check',
        '--platform',
        'win_amd64',
        '--python-version',
        '3.12',
        '--implementation',
        'cp',
        '--abi',
        'cp312',
        '--only-binary=:all:',
        '--no-deps',
        '--require-hashes',
        '-r',
        requirements,
        '--find-links',
        wheels,
        '--dest',
        verifiedWheels
      ],
      env
    );
    const buildWheels = join(cache, 'build');
    await mkdir(buildWheels, { recursive: true });
    run(
      builder,
      [
        '-I',
        '-B',
        '-X',
        'utf8',
        '-m',
        'pip',
        'download',
        '--disable-pip-version-check',
        '--only-binary=:all:',
        '--no-deps',
        '--require-hashes',
        '-r',
        join(here, 'requirements-build.lock'),
        '--dest',
        buildWheels
      ],
      env
    );
    run(
      builder,
      [
        '-I',
        '-B',
        '-X',
        'utf8',
        join(here, 'prepare-windows.py'),
        join(staging, 'python'),
        verifiedWheels,
        join(buildWheels, 'installer-0.7.0-py3-none-any.whl'),
        lock.python
      ],
      env
    );
    run(builder, ['-I', '-B', '-X', 'utf8', join(here, 'collect-licenses.py'), join(staging, 'licenses'), join(staging, 'python/Lib/site-packages')], env);
    await rm(verifiedWheels, { recursive: true, force: true });
  } else {
    run(
      python,
      [
        '-I',
        '-B',
        '-X',
        'utf8',
        '-m',
        'pip',
        'download',
        '--disable-pip-version-check',
        '--only-binary=:all:',
        '--require-hashes',
        '-r',
        requirements,
        '--dest',
        wheels
      ],
      env
    );
    run(
      python,
      [
        '-I',
        '-B',
        '-X',
        'utf8',
        '-m',
        'pip',
        'install',
        '--no-compile',
        '--disable-pip-version-check',
        '--no-index',
        '--find-links',
        wheels,
        '--only-binary=:all:',
        '--require-hashes',
        '-r',
        requirements
      ],
      env
    );
    run(python, ['-I', '-B', '-X', 'utf8', '-m', 'pip', 'check'], env);
    run(python, ['-I', '-B', '-X', 'utf8', join(here, 'runtime-probe.py')], env);
    run(python, ['-I', '-B', '-X', 'utf8', join(here, 'collect-licenses.py'), join(staging, 'licenses')], env);
  }
  await cp(join(here, 'licenses'), join(staging, 'licenses/upstream'), { recursive: true });
  await copyFile(requirements, join(staging, 'requirements.lock'));
  await writeFile(
    join(staging, 'manifest.json'),
    JSON.stringify(
      {
        target,
        buildHost: host,
        nativeProbe: !crossWindows,
        python: lock.python,
        release: lock.release,
        source: distribution.url,
        archiveSha256: distribution.sha256,
        requirementsSha256,
        fingerprint
      },
      null,
      2
    ) + '\n'
  );
  await rm(root, { recursive: true, force: true });
  await rename(staging, root);
  console.log(`Подготовлен runtime: ${target}`);
}
