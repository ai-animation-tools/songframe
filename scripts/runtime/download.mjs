/** Кэш сборочных загрузок; URL и SHA256 задаются рецептом, приложение этот модуль не вызывает. */
import { createWriteStream } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import mediaFiles from './media-files.cjs';

export async function download(url, hash, file) {
  await mkdir(dirname(file), { recursive: true });
  try {
    if ((await mediaFiles.sha256(file)) === hash) return file;
  } catch {
    /* Первый запуск заполняет кэш. */
  }
  console.log(`Загрузка ${new URL(url).pathname.split('/').pop()}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(`${file}.part`));
  if ((await mediaFiles.sha256(`${file}.part`)) !== hash) throw new Error(`Неверный SHA256: ${file}`);
  await rename(`${file}.part`, file);
  return file;
}
