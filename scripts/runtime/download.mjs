/** Кэш сборочных загрузок; URL и SHA256 задаются рецептом, приложение этот модуль не вызывает. @link README.md */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import mediaFiles from './media-files.cjs';

export async function download(
  url,
  hash,
  file,
  { idleTimeoutMs = 120_000, progressIntervalMs = 10_000, showProgress = Boolean(process.stdout.isTTY), log = console.log } = {}
) {
  await mkdir(dirname(file), { recursive: true });
  try {
    if ((await mediaFiles.sha256(file)) === hash) return file;
  } catch {
    // Первый запуск заполняет кэш.
  }
  const name = basename(file);
  const temporary = await mkdtemp(join(dirname(file), `.${name}-`));
  const part = join(temporary, 'download');
  const controller = new AbortController();
  let received = 0;
  let total;
  let lastData = Date.now();
  let timedOut = false;
  let timeout;
  const resetTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, idleTimeoutMs);
  };
  const progress = () => {
    const size = total === undefined ? '' : ` из ${total} байт (${Math.min(100, (received / total) * 100).toFixed(1)}%)`;
    const waiting = Date.now() - lastData >= progressIntervalMs ? '; ожидание данных' : '';
    log(`Загрузка ${name}: ${received} байт${size}${waiting}`);
  };
  log(`Загрузка ${name}`);
  resetTimeout();
  // В интерактивном терминале показываем ход; журнал неинтерактивной сборки не засоряем.
  const interval = showProgress ? setInterval(progress, progressIntervalMs) : undefined;
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'accept-encoding': 'identity' } });
    if (!response.ok) throw new Error(`Не удалось скачать ${name}: HTTP ${response.status}`);
    const length = response.headers.get('content-length');
    if (length && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) && Number(length) > 0) total = Number(length);
    const digest = createHash('sha256');
    const counter = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length;
        lastData = Date.now();
        resetTimeout();
        digest.update(chunk);
        callback(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(part, { flags: 'wx' }), { signal: controller.signal });
    const actual = digest.digest('hex');
    if (actual !== hash) throw new Error(`Неверный SHA256 ${name}: ${actual}`);
    // Проверенный файл публикуется одним переименованием; соседние загрузки используют свои временные каталоги.
    await rename(part, file);
    if (showProgress) progress();
    return file;
  } catch (error) {
    if (timedOut) throw new Error(`Загрузка ${name} прервана: нет данных ${Math.round(idleTimeoutMs / 1000)} с.`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
    clearInterval(interval);
    await rm(temporary, { recursive: true, force: true });
  }
}
