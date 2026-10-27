/** Проверка больших ресурсов выполняется при сборке, а не при каждом пользовательском действии. @link README.md */
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { readFile, stat, access } = require('node:fs/promises');
const { constants } = require('node:fs');
const { join } = require('node:path');

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyMedia(root, lock, target = 'linux-x64') {
  if (!['linux-x64', 'win32-x64'].includes(target)) throw new Error(`Не поддерживается медиа-поставка ${target}.`);
  const windows = target === 'win32-x64';
  const distribution = windows ? lock.ffmpeg.windows : lock.ffmpeg;
  const manifest = JSON.parse(await readFile(join(root, 'media-manifest.json'), 'utf8'));
  if (manifest.target !== target || manifest.ffmpeg.archiveSha256 !== distribution.sha256)
    throw new Error(`Медиа-ресурсы устарели. Выполните yarn prepare:media --target=${target}.`);
  const expected = manifest.binaries;
  for (const file of expected) {
    const path = join(root, file.path);
    if (file.size !== undefined && (await stat(path)).size !== file.size) throw new Error(`Неверный размер ресурса: ${file.path}`);
    if ((await sha256(path)) !== file.sha256) throw new Error(`Неверный SHA256 ресурса: ${file.path}`);
  }
  for (const name of ['ffmpeg', 'ffprobe']) {
    const filename = windows ? `${name}.exe` : name;
    if (!manifest.binaries.some((file) => file.path === `bin/${filename}`)) throw new Error(`Нет ${filename} в manifest.`);
    // Execute-bit имеет смысл только для Linux; PE проверен при подготовке без его запуска.
    await access(join(root, 'bin', filename), windows ? constants.R_OK : constants.X_OK);
    if (windows) await stat(join(root, 'licenses/ffmpeg', `${name}-build.txt`));
  }
  await stat(join(root, 'licenses/ffmpeg/LICENSE.txt'));
  return manifest;
}

module.exports = { sha256, verifyMedia };
