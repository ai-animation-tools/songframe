/** Медиакомплект Linux и Windows: закреплённые FFmpeg/ffprobe; модели устанавливаются отдельно, без загрузок при запуске приложения. @link README.md */
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import mediaFiles from './media-files.cjs';

const { sha256, verifyMedia } = mediaFiles;
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Медиа-поставка готовится на Linux x64.');
const target = process.argv.find((arg) => arg.startsWith('--target='))?.slice('--target='.length) ?? 'linux-x64';
if (!['linux-x64', 'win32-x64'].includes(target)) throw new Error(`Не поддерживается медиа-поставка ${target}.`);
const windows = target === 'win32-x64';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const root = join(repo, 'build/runtime', target);
const cache = join(repo, 'build/runtime/downloads/media');
const lock = JSON.parse(await readFile(join(here, 'media-lock.json'), 'utf8'));
const distribution = windows ? lock.ffmpeg.windows : lock.ffmpeg;
await stat(join(root, windows ? 'python/python.exe' : 'python/bin/python3'));
await mkdir(cache, { recursive: true });

async function obtain(url, hash, name) {
  const file = join(cache, name);
  try {
    if ((await sha256(file)) === hash) return file;
  } catch {
    // Отсутствующий кэш заполняется только ресурсом из закреплённого источника.
  }
  const part = `${file}.part`;
  console.log(`Загрузка ${name}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Не удалось скачать ${name}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(part));
  if ((await sha256(part)) !== hash) throw new Error(`Неверный SHA256 ${name}`);
  await rename(part, file);
  return file;
}

try {
  await verifyMedia(root, lock, target);
  console.log('FFmpeg/ffprobe уже подготовлены; файлы проверены. Модели в сборку не входят.');
} catch {
  const staging = join(root, 'media.preparing');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const archive = await obtain(distribution.url, distribution.sha256, basename(new URL(distribution.url).pathname));
  const unpack = join(staging, windows ? basename(archive, '.zip') : 'ffmpeg');
  // ZIP распаковывает уже подготовленный Linux Python; Windows EXE на сборщике не исполняются.
  if (!windows) await mkdir(unpack);
  const extraction = windows
    ? spawnSync(join(repo, 'build/runtime/linux-x64/python/bin/python3'), ['-I', '-B', '-m', 'zipfile', '-e', archive, staging], { stdio: 'inherit' })
    : spawnSync('tar', ['-xJf', archive, '--strip-components=1', '-C', unpack], { stdio: 'inherit' });
  if (extraction.error || extraction.status !== 0) throw new Error('Не удалось распаковать FFmpeg.');
  await mkdir(join(staging, 'bin'));
  await mkdir(join(staging, 'licenses/ffmpeg'), { recursive: true });
  const binaries = [];
  for (const name of ['ffmpeg', 'ffprobe']) {
    const filename = windows ? `${name}.exe` : name;
    const output = join(staging, 'bin', filename);
    await copyFile(join(unpack, 'bin', filename), output);
    if (windows) {
      // Сохраняем встроенные флаги configure из закреплённого PE, не выдавая чтение за нативный запуск.
      const binary = await readFile(output);
      const configuration = binary.toString('latin1').match(/--prefix=[\x20-\x7e]+/)?.[0];
      if (binary.subarray(0, 2).toString() !== 'MZ' || !binary.includes(Buffer.from(lock.ffmpeg.version)) || !configuration?.includes('--target-os=mingw32'))
        throw new Error(`Неверный Windows-бинарник ${filename}.`);
      await writeFile(
        join(staging, 'licenses/ffmpeg', `${name}-build.txt`),
        `Версия: ${lock.ffmpeg.version}\nИсточник: ${distribution.url}\nНативный запуск на сборщике не выполнялся.\nconfiguration: ${configuration}\n`
      );
    } else {
      await chmod(output, 0o755);
      const probe = spawnSync(output, ['-version'], { encoding: 'utf8', timeout: 30000 });
      if (probe.error || probe.status !== 0 || !probe.stdout.includes(lock.ffmpeg.version)) throw new Error(`Не запускается поставляемый ${name}.`);
      await writeFile(join(staging, 'licenses/ffmpeg', `${name}-version.txt`), probe.stdout);
    }
    binaries.push({ path: `bin/${filename}`, sha256: await sha256(output), size: (await stat(output)).size });
  }
  // Сохраняем лицензию и документацию именно выбранной GPL-сборки, включая её флаги configure.
  await copyFile(join(unpack, 'LICENSE.txt'), join(staging, 'licenses/ffmpeg/LICENSE.txt'));
  await cp(join(unpack, 'doc'), join(staging, 'licenses/ffmpeg/doc'), { recursive: true });
  const manifest = {
    target,
    buildHost: `${process.platform}-${process.arch}`,
    nativeProbe: !windows,
    ffmpeg: {
      version: lock.ffmpeg.version,
      release: lock.ffmpeg.release,
      source: distribution.url,
      archiveSha256: distribution.sha256,
      license: 'GPL-3.0-or-later'
    },
    modelDelivery: 'external',
    binaries
  };
  await writeFile(join(staging, 'media-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await verifyMedia(staging, lock, target);
  for (const name of ['bin']) {
    await rm(join(root, name), { recursive: true, force: true });
    await rename(join(staging, name), join(root, name));
  }
  await rm(join(root, 'licenses/ffmpeg'), { recursive: true, force: true });
  await rename(join(staging, 'licenses/ffmpeg'), join(root, 'licenses/ffmpeg'));
  await rename(join(staging, 'media-manifest.json'), join(root, 'media-manifest.json'));
  await rm(staging, { recursive: true, force: true });
  console.log(`Подготовлены FFmpeg/ffprobe для ${target}. Модель устанавливается пользователем отдельно.`);
}

// Уведомление об источниках сохраняется и при повторном использовании уже проверенного комплекта.
await copyFile(join(here, 'licenses/FFmpeg-SOURCES.md'), join(root, 'licenses/ffmpeg/SOURCES.md'));

// Старые локальные веса не удаляем; упаковка явно исключает models, даже если они остались после прежней сборки.
const manifestPath = join(root, 'media-manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
delete manifest.model;
manifest.modelDelivery = 'external';
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
