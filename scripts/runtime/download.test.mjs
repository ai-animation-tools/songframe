/** Проверка загрузчика на локальном сервере без получения настоящих архивов. @link README.md */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { download } from './download.mjs';

const body = Buffer.from('проверка загрузки');
const hash = createHash('sha256').update(body).digest('hex');

test('загрузка, прогресс, ошибки и сохранность кэша', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'songframe-download-test-'));
  const server = createServer((req, res) => {
    if (req.url === '/error') {
      res.writeHead(503).end();
      return;
    }
    if (req.url === '/stall') {
      res.writeHead(200);
      res.write('a');
      return;
    }
    if (req.url === '/known') res.setHeader('Content-Length', body.length);
    res.write(body.subarray(0, 4));
    setTimeout(() => res.end(body.subarray(4)), 70);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const opts = (logs) => ({ idleTimeoutMs: 500, progressIntervalMs: 20, showProgress: true, log: (line) => logs.push(line) });
  const file = join(dir, 'archive');
  const logs = [];
  await download(`${url}/known`, hash, file, opts(logs));
  assert.deepEqual(await readFile(file), body);
  assert.ok(logs.some((line) => line.includes(`из ${body.length} байт`) && line.includes('%')));
  assert.ok(logs.some((line) => line.includes('ожидание данных')));
  await rm(file);
  const unknown = [];
  await download(`${url}/unknown`, hash, file, opts(unknown));
  assert.ok(unknown.some((line) => line.includes('байт') && !line.includes(' из ')));
  await rm(file);
  const noninteractive = [];
  await download(`${url}/known`, hash, file, { ...opts(noninteractive), showProgress: false });
  assert.ok(noninteractive.every((line) => !line.includes('байт')));
  await writeFile(file, 'старый кэш');
  await assert.rejects(download(`${url}/error`, hash, file, opts([])), /HTTP 503/);
  await assert.rejects(download(`${url}/known`, '0'.repeat(64), file, opts([])), /Неверный SHA256/);
  await assert.rejects(download(`${url}/stall`, hash, file, { ...opts([]), idleTimeoutMs: 80 }), /нет данных/);
  assert.equal(await readFile(file, 'utf8'), 'старый кэш');
  assert.deepEqual(await readdir(dir), ['archive']);
  await Promise.all([download(`${url}/known`, hash, file, opts([])), download(`${url}/known`, hash, file, opts([]))]);
  assert.deepEqual(await readFile(file), body);
  assert.deepEqual(await readdir(dir), ['archive']);
});
