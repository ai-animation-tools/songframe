/** Tiny нужна только проверке поставки; каталог находится вне упаковываемого linux-x64. */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { download } from './download.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const lock = JSON.parse(await readFile(join(repo, 'scripts/runtime/smoke-model-lock.json'), 'utf8'));
const target = join(repo, 'build/runtime/smoke-model');
for (const file of lock.files)
  await download(`https://huggingface.co/${lock.repository}/resolve/${lock.revision}/${file.name}`, file.sha256, join(target, file.name));
console.log(`Внешняя тестовая модель готова: ${target}`);
