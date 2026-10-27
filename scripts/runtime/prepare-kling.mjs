/** Копирует закреплённый официальный пакет из Git; Node уже входит в Electron. @link ../../vendor/kling-cli/VENDOR.md */
import { cp, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import klingFiles from './kling-files.cjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const vendor = join(repo, 'vendor/kling-cli');
const root = join(repo, 'build/runtime/kling');
const lock = JSON.parse(await readFile(join(here, 'kling-lock.json'), 'utf8'));

// Исходником служит проверяемая копия в Git: подготовка не скачивает пакет и не вызывает внешний Kling.
const expected = await klingFiles.verifyKling(vendor, lock);
let prepared = false;
try {
  const actual = await klingFiles.verifyKling(root, lock);
  prepared = JSON.stringify(actual) === JSON.stringify(expected);
} catch {
  /* Отсутствующую или изменённую сборочную копию восстанавливаем из vendor. */
}

if (prepared) {
  console.log(`Kling CLI ${lock.version} уже подготовлен; копия совпадает с vendor/kling-cli.`);
} else {
  const staging = `${root}.preparing`;
  await rm(staging, { recursive: true, force: true });
  await cp(vendor, staging, { recursive: true });
  await klingFiles.verifyKling(staging, lock);
  await rm(root, { recursive: true, force: true });
  await rename(staging, root);
  console.log(`Подготовлен официальный Kling CLI ${lock.version} из vendor/kling-cli.`);
}
