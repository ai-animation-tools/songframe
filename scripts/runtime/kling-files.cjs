/** Полный состав официального пакета проверяется перед повторным использованием и упаковкой. @link prepare-kling.mjs */
const { readFile, readdir, stat } = require('node:fs/promises');
const { join } = require('node:path');
const { sha256 } = require('./media-files.cjs');

async function klingFiles(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (path === 'manifest.json') continue;
    if (entry.name === '.credentials') throw new Error('Учётные данные не входят в поставку Kling CLI.');
    if (entry.isDirectory()) files.push(...(await klingFiles(root, path)));
    else if (entry.isFile()) files.push({ path, size: (await stat(join(root, path))).size, sha256: await sha256(join(root, path)) });
    else throw new Error(`Неожиданный ресурс Kling CLI: ${path}`);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function verifyKling(root, lock) {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  if (
    manifest.name !== lock.name ||
    manifest.version !== lock.version ||
    manifest.source !== lock.url ||
    manifest.archiveSha256 !== lock.sha256 ||
    manifest.integrity !== lock.integrity
  )
    throw new Error('Поставка Kling CLI устарела. Выполните yarn prepare:kling.');
  const actual = await klingFiles(root);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('Изменён состав или SHA256 файлов Kling CLI. Выполните yarn prepare:kling.');
  for (const required of ['package.json', 'dist/cli.js', 'SOURCES.md'])
    if (!actual.some((file) => file.path === required)) throw new Error(`Нет ресурса Kling CLI: ${required}`);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== lock.name || pkg.version !== lock.version) throw new Error('Не совпадает версия официального пакета Kling CLI.');
  return manifest;
}

module.exports = { klingFiles, verifyKling };
