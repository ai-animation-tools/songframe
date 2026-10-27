/** У install_only нет уведомлений статических зависимостей CPython; берём их из того же полного выпуска. */
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { download } from './download.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const lock = JSON.parse(await readFile(join(repo, 'scripts/runtime/linux-licenses-lock.json'), 'utf8'));
const cache = join(repo, 'build/runtime/downloads/linux-licenses');
const target = join(repo, 'build/runtime/linux-x64/licenses');
const archive = await download(lock.cpython.url, lock.cpython.sha256, join(cache, 'cpython-full.tar.zst'));
const temporary = await mkdtemp(join(cache, 'notices-'));
try {
  const extraction = spawnSync('tar', ['--zstd', '-xf', archive, '-C', temporary, 'python/PYTHON.json', 'python/licenses'], { stdio: 'inherit' });
  if (extraction.error || extraction.status !== 0) throw new Error('Для извлечения лицензий нужны tar и zstd.');
  await mkdir(join(target, 'cpython'), { recursive: true });
  await cp(join(temporary, 'python/licenses'), join(target, 'cpython'), { recursive: true });
  await cp(join(temporary, 'python/PYTHON.json'), join(target, 'cpython/PYTHON.json'));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
for (const entry of lock.extras) await download(entry.url, entry.sha256, join(target, 'upstream', entry.name));
await writeFile(join(target, 'sources.json'), JSON.stringify(lock, null, 2) + '\n');
console.log('Лицензии CPython, его нативных зависимостей и недостающие уведомления wheels подготовлены.');
