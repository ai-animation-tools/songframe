/** Подставной app-server проверяет model/list и завершение RPC без реального аккаунта и генерации. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readCodexModels } from './codex-models';

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-codex-models-'));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function cli(body: string): string {
  const executable = join(work, 'Codex fixture');
  writeFileSync(
    executable,
    `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(${JSON.stringify(join(work, 'args.json'))}, JSON.stringify(process.argv.slice(2)));
const send = (r, result) => console.log(JSON.stringify({id:r.id,result}));
readline.createInterface({input:process.stdin}).on('line', line => {
  const r = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(join(work, 'requests.jsonl'))}, line+'\\n');
  if(r.method === 'initialize') { send(r, {}); return; }
  if(r.method === 'initialized') return;
  if(r.method !== 'model/list') process.exit(99);
  ${body}
});
`,
    { mode: 0o700 }
  );
  return executable;
}

const read = (executablePath: string, timeoutMs = 1000) => readCodexModels({ provider: 'codex', executablePath }, { home: work, env: process.env, timeoutMs });

it('читает все страницы видимых моделей точными model ID без account refresh и запуска диалога', async () => {
  const executable = cli(
    `send(r, r.params.cursor ? {data:[{id:'catalog-b',model:'actual-b',displayName:'Модель B',hidden:false,inputModalities:['text']}],nextCursor:null} : {data:[{id:'catalog-a',model:'actual-a',displayName:'Модель A',hidden:false,isDefault:true},{id:'hidden',model:'hidden',hidden:true}],nextCursor:'page-2'});`
  );
  expect(await read(executable)).toEqual([
    { id: 'actual-a', command: 'codex_exec', arguments: {}, slots: {}, limits: {} },
    { id: 'actual-b', command: 'codex_exec', arguments: {}, slots: {}, limits: {} }
  ]);
  expect(JSON.parse(readFileSync(join(work, 'args.json'), 'utf8'))).toEqual(['app-server', '--listen', 'stdio://']);
  const requests = readFileSync(join(work, 'requests.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(requests.map((r) => r.method)).toEqual(['initialize', 'initialized', 'model/list', 'model/list']);
  expect(requests[2].params).toEqual({ limit: 100, includeHidden: false });
  expect(requests[3].params).toEqual({ limit: 100, includeHidden: false, cursor: 'page-2' });
});

it.each([
  ['неизвестный JSON', 'send(r, {models:[]});', 'формат'],
  ['нет точного имени', "send(r, {data:[{id:'only-id'}],nextCursor:null});", 'точного имени'],
  ['повтор курсора', "send(r, {data:[],nextCursor:'same-page'});", 'повторил страницу'],
  ['отказ RPC', 'console.log(JSON.stringify({id:r.id,error:{code:-32601}}));', 'не поддерживает'],
  ['преждевременный EOF', 'process.exit(0);', 'закрыта']
])('отклоняет %s без выдуманного каталога', async (_name, body, message) => {
  await expect(read(cli(body))).rejects.toThrow(message);
});

it('завершает зависший app-server по общему таймауту', async () => {
  await expect(read(cli(''), 80)).rejects.toThrow('Не удалось получить диагностику CLI');
});
