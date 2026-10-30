/** Раздаёт собранную витрину под подпапкой с поддержкой Range: так её открывает браузерный набор и ручная приёмка. */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const dir = resolve(root, option('dir', 'build/storybook'));
const base = option('base', '/songframe/storybook/');
const port = Number(option('port', '6107'));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg'
};

if (!existsSync(join(dir, 'index.json'))) {
  console.error(`Нет собранной витрины в ${dir}. Сначала выполните yarn build-storybook.`);
  process.exit(2);
}

/** Отменённое браузером чтение закрывает файл; ошибка одного запроса не останавливает сервер. */
const send = (file, response, range) => pipeline(createReadStream(file, range), response, () => {});

const decode = (path) => {
  try {
    return decodeURIComponent(path);
  } catch {
    return undefined;
  }
};

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith(base)) return void response.writeHead(404).end();
  const path = decode(url.pathname.slice(base.length));
  if (path === undefined) return void response.writeHead(400).end();
  const file = normalize(join(dir, path || 'index.html'));
  if (!file.startsWith(dir + sep) || !existsSync(file) || statSync(file).isDirectory()) return void response.writeHead(404).end();
  const size = statSync(file).size;
  const headers = { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  // Без 206 Chrome читает метаданные MP4, но оставляет нулевой диапазон перемотки.
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) return void response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
    response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    send(file, response, { start, end });
    return;
  }
  response.writeHead(200, { ...headers, 'Content-Length': size });
  send(file, response);
}).listen(port, '127.0.0.1', () => console.log(`Витрина: http://127.0.0.1:${port}${base}`));
