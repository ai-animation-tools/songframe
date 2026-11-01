/** Настоящие процессы подставных CLI проверяют общий контракт без расхода лимитов провайдеров. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentJob, AgentSettings } from '@shared/agents';
import { AgentManager } from './agent-manager';
import { JsonLines } from './agent-protocol';
import { SettingsStore } from './settings';

let work: string;
let project: string;
let settings: SettingsStore;
let managers: AgentManager[];
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'Задания агентов '));
  project = join(work, 'Проект клипа');
  mkdirSync(join(project, 'plan'), { recursive: true });
  writeFileSync(join(project, 'plan/project.json'), '{"generation":{"provider":"test"}}');
  settings = new SettingsStore(join(work, 'state'));
  managers = [];
});
afterEach(() => {
  for (const manager of managers) manager.shutdown();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(work, { recursive: true, force: true });
});
function manager(options: ConstructorParameters<typeof AgentManager>[1] = {}): AgentManager {
  const value = new AgentManager(settings, options);
  managers.push(value);
  return value;
}

/** CLI ищется только по имени: фикстура лежит в каталоге с пробелами первым в PATH, раньше настоящего ~/.local/bin. */
function fake(provider: AgentSettings['provider'], body: string, version?: string, login = true): string {
  const bin = join(work, 'исполняемые файлы');
  mkdirSync(bin, { recursive: true });
  const executablePath = join(bin, provider);
  const cliVersion = version ?? (provider === 'claude' ? '2.1.284 (Claude Code)' : 'codex-cli 0.159.2');
  writeFileSync(
    executablePath,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(${JSON.stringify(cliVersion)}); process.exit(0); }
if (args[0] === 'auth' || args[0] === 'login') {
  if (${JSON.stringify(provider)} === 'claude') console.log(JSON.stringify({loggedIn:${login}}));
  else console.error(${JSON.stringify(login ? 'Logged in using ChatGPT' : 'Not logged in')});
  process.exit(${login ? 0 : 1});
}
fs.writeFileSync(${JSON.stringify(join(work, 'started'))}, JSON.stringify({args, cwd:process.cwd()}));
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk=> input += chunk);
process.stdin.on('end', ()=> { fs.writeFileSync(${JSON.stringify(join(work, 'stdin'))},input); ${body} });
`,
    { mode: 0o700 }
  );
  vi.stubEnv('PATH', bin + delimiter + (process.env.PATH ?? ''));
  settings.saveAgent({ provider, model: 'модель с пробелами;$(touch injected)' });
  return executablePath;
}

function success(provider: AgentSettings['provider']): string {
  return provider === 'claude'
    ? `
    send({type:'system',subtype:'init',session_id:'claude-session'});
    send({type:'assistant',message:{content:[{type:'tool_use',id:'read-1',name:'Read',input:{token:'SECRET'}}]}});
    send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'read-1',content:'SECRET source lyrics'}]}});
    send({type:'stream_event',event:{delta:{type:'text_delta',text:'Привет '}}});
    setTimeout(()=>{
      send({type:'stream_event',event:{delta:{type:'text_delta',text:'мир'}}});
      send({type:'assistant',message:{content:[{type:'text',text:'Привет мир'}]}});
      send({type:'result',subtype:'success',is_error:false,result:'Привет мир',session_id:'claude-session'});
    },120);
  `
    : `
    send({type:'thread.started',thread_id:'codex-session'});
    send({type:'turn.started'});
    send({type:'item.started',item:{id:'tool',type:'command_execution',command:'SECRET'}});
    send({type:'item.completed',item:{id:'tool',type:'command_execution',aggregated_output:'SECRET source lyrics'}});
    send({type:'item.updated',item:{id:'a',type:'agent_message',text:'Привет '}});
    setTimeout(()=>{
      send({type:'item.completed',item:{id:'a',type:'agent_message',text:'Привет мир'}});
      send({type:'turn.completed'});
    },120);
  `;
}

async function terminal(manager: AgentManager, id: string): Promise<AgentJob> {
  await vi.waitFor(() => expect(manager.get(id)?.status).not.toBe('running'), { timeout: 4000, interval: 10 });
  return manager.get(id)!;
}
const start = (value: AgentManager) => value.start({ project, task: 'Черновик', prompt: 'ТЕКСТ ЗАПРОСА; $(touch injected) "кириллица"', context: 'КОНТЕКСТ' });

/** Маленькие локальные изображения позволяют проверить байты транспорта без запроса настоящей модели. */
function attachment(name = 'Кадр с пробелами.png', jpeg = false): string {
  const file = join(work, name);
  const data = jpeg
    ? Buffer.from([255, 216, 255, 224, 0, 2, 255, 217])
    : Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM6sAAAAASUVORK5CYII=', 'base64');
  writeFileSync(file, data);
  return file;
}

describe('Вложения изображений текстового агента', () => {
  it('Claude отклоняет слишком большой сериализованный ввод до рабочего spawn', async () => {
    fake('claude', success('claude'));
    const images = [attachment('Большой кадр.png'), attachment('Большая опора.png')];
    for (const path of images) truncateSync(path, 4 * 1024 * 1024);
    const value = manager();
    const job = value.start({ project, task: 'Проверка', prompt: 'Проверь вложения', images });
    expect(await terminal(value, job.id)).toMatchObject({
      status: 'failed',
      diagnostic: 'INVALID_INPUT',
      exitCode: null,
      message: expect.stringContaining('10 000 000 байт')
    });
    expect(existsSync(join(work, 'started'))).toBe(false);
    expect(existsSync(join(work, 'stdin'))).toBe(false);
  });

  it.each(['claude', 'codex'] as const)('%s: отправляет изображения штатным транспортом и сохраняет запрет записи', async (provider) => {
    fake(provider, success(provider));
    const png = attachment('Кадр $(не выполнять).png');
    const jpeg = attachment('Опора с пробелами.JPEG', true);
    const value = manager();
    const job = value.start({ project, task: 'Проверка кадров', prompt: 'Проверь эти кадры', context: 'Контекст', images: [png, jpeg] });
    const done = await terminal(value, job.id);
    expect(done).toMatchObject({ status: 'completed', permissions: 'read-only' });
    const args = JSON.parse(readFileSync(join(work, 'started'), 'utf8')).args as string[];
    const stdin = readFileSync(join(work, 'stdin'), 'utf8');
    if (provider === 'codex') {
      expect(args.slice(-5)).toEqual(['--image', png, '--image', jpeg, '-']);
      expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
      expect(stdin).toContain('Задача:\nПроверь эти кадры');
      expect(stdin).not.toContain(png);
    } else {
      expect(args[args.indexOf('--input-format') + 1]).toBe('stream-json');
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
      expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
      const input = JSON.parse(stdin);
      expect(input).toMatchObject({ type: 'user', parent_tool_use_id: null, message: { role: 'user' } });
      expect(input.message.content[0]).toEqual({ type: 'text', text: expect.stringContaining('Задача:\nПроверь эти кадры') });
      expect(input.message.content.slice(1)).toEqual([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: readFileSync(png).toString('base64') } },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: readFileSync(jpeg).toString('base64') } }
      ]);
      expect(stdin.endsWith('\n')).toBe(true);
    }
    const persisted = readFileSync(join(work, 'state/jobs', `agent-${job.id}.json`), 'utf8');
    expect(persisted).not.toContain(png);
    expect(persisted).not.toContain(readFileSync(png).toString('base64'));
  });

  it('хеш контекста зависит от байтов и порядка, но не пути, а пустой список сохраняет текстовый контракт', async () => {
    fake('codex', 'send({type:"turn.completed"});');
    const first = attachment();
    const second = attachment('другая опора.jpeg', true);
    const copy = join(work, 'копия.png');
    writeFileSync(copy, readFileSync(first));
    const value = manager();
    const run = async (images?: string[]): Promise<AgentJob> => {
      const job = value.start({ project, task: 'Проверка', prompt: 'Промпт', context: 'Контекст', ...(images ? { images } : {}) });
      return terminal(value, job.id);
    };
    const original = await run([first, second]);
    expect((await run([copy, second])).inputHashes).toEqual(original.inputHashes);
    expect((await run([second, first])).inputHashes.context).not.toBe(original.inputHashes.context);
    writeFileSync(first, Buffer.concat([readFileSync(first), Buffer.from('изменённый кадр')]));
    expect((await run([first, second])).inputHashes.context).not.toBe(original.inputHashes.context);
    expect((await run([])).inputHashes.context).toBe(createHash('sha256').update('Контекст').digest('hex'));
    expect((await run()).inputHashes.context).toBe(createHash('sha256').update('Контекст').digest('hex'));
  });

  it('отклоняет неверные пути, типы и пустые или замаскированные файлы до диагностики CLI и истории', () => {
    const value = manager();
    const png = attachment();
    const empty = join(work, 'пустой.png');
    writeFileSync(empty, '');
    const text = join(work, 'текст.png');
    writeFileSync(text, 'это не картинка');
    const directory = join(work, 'каталог.png');
    mkdirSync(directory);
    for (const images of [
      null,
      'image.png',
      [42],
      [''],
      [' '],
      ['relative.png'],
      [png + '\0'],
      [join(work, 'нет.png')],
      [empty],
      [text],
      [directory],
      [attachment('неверный.gif')]
    ]) {
      expect(() => value.start({ project, task: 'Проверка', prompt: 'Промпт', images })).toThrow(/INVALID_INPUT/);
    }
    expect(value.list()).toEqual([]);
    expect(existsSync(join(work, 'started'))).toBe(false);
  });

  it('ограничивает число и суммарный размер файлов, в том числе до чтения большого файла', () => {
    const png = attachment();
    const value = manager();
    const input = { project, task: 'Проверка', prompt: 'Промпт' };
    expect(() => value.start({ ...input, images: Array(65).fill(png) })).toThrow(/до 64 изображений/);
    truncateSync(png, 5 * 1024 * 1024 + 1);
    expect(() => value.start({ ...input, images: [png] })).toThrow(/до 5 МиБ/);
    truncateSync(png, 5 * 1024 * 1024);
    expect(() => value.start({ ...input, images: Array(5).fill(png) })).toThrow(/до 20 МиБ суммарно/);
    expect(value.list()).toEqual([]);
  });

  it('передача вложений не открывает маршрут создания изображений с записью', () => {
    const png = attachment();
    const candidate = join(settings.localDir, 'image-jobs', 'candidate');
    mkdirSync(candidate, { recursive: true });
    const value = manager();
    expect(() => value.startImages({ project, task: 'Проверка', prompt: 'Промпт', images: [png] }, candidate, { provider: 'codex' })).toThrow(
      /только в заданиях агента без записи/
    );
    expect(value.list()).toEqual([]);
  });
});

describe('Разбор JSONL', () => {
  it('сохраняет UTF-8 при разрыве каждого байта и принимает последнюю строку без переноса', () => {
    const values: unknown[] = [];
    const parser = new JsonLines((value) => values.push(value));
    for (const byte of Buffer.from('\n{"text":"Привет"}\r\n{"n":2}')) parser.push(Buffer.from([byte]));
    parser.finish();
    expect(values).toEqual([{ text: 'Привет' }, { n: 2 }]);
  });
  it('отклоняет сломанный JSON и ограничивает строку без включения её текста в ошибку', () => {
    expect(() => new JsonLines(() => {}).push(Buffer.from('SECRET\n'))).toThrow(/PROTOCOL_ERROR/);
    expect(() => new JsonLines(() => {}, 8).push(Buffer.from('SECRET'.repeat(10)))).toThrow(/OUTPUT_LIMIT/);
  });
});

describe.skipIf(process.platform !== 'linux')('Жизненный цикл обоих CLI', () => {
  it.each(['claude', 'codex'] as const)('%s: передаёт stdin, выдаёт прогресс до выхода и сохраняет очищенную историю', async (provider) => {
    fake(provider, `console.error('access_token=SECRET'); ${success(provider)}`);
    const value = manager();
    const events: AgentEvent[] = [];
    const unsubscribe = value.onEvent((event) => events.push(event));
    const job = start(value);
    await vi.waitFor(() => expect(events.some((event) => event.type === 'text_delta')).toBe(true));
    expect(value.get(job.id)?.status).toBe('running');
    const done = await terminal(value, job.id);
    expect(done).toMatchObject({ status: 'completed', exitCode: 0, result: 'Привет мир', sessionId: `${provider}-session`, permissions: 'read-only' });
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['started', 'text_delta', 'tool_started', 'tool_finished', 'completed']));
    expect(
      events
        .filter((event) => event.type === 'text_delta')
        .map((event) => event.text)
        .join('')
    ).toBe('Привет мир');
    const invocation = JSON.parse(readFileSync(join(work, 'started'), 'utf8'));
    expect(invocation.cwd).toBe(project);
    expect(invocation.args).toContain('модель с пробелами;$(touch injected)');
    expect(invocation.args.join(' ')).not.toMatch(/ТЕКСТ ЗАПРОСА|dangerously|yolo|bypassPermissions/);
    // Полная инструкция и разделители stdin являются контрактом запроса, включая пользовательские спецсимволы.
    expect(readFileSync(join(work, 'stdin'), 'utf8')).toBe(
      'Подготовь предложение для пользователя. Не изменяй файлы проекта, не выполняй commit/push, не удаляй исходники или assets и не отправляй платные запросы сервисам генерации. Правила хранения проекта описаны в его README.md.\n\nЗадача:\nТЕКСТ ЗАПРОСА; $(touch injected) "кириллица"\n\nДополнительный контекст:\nКОНТЕКСТ'
    );
    expect(job.phase).toBe('Проверка агента');
    expect(done.phase).toBe('Завершено');
    expect(events.map((event) => event.phase)).toEqual(
      expect.arrayContaining(['Проверка агента', 'Агент выполняет задачу', 'Чтение проекта', 'Получение ответа', 'Завершено'])
    );
    expect(done.log).toBe('Агент начал работу инструмента.\nАгент завершил работу инструмента.\nЗадание завершено.\n');
    expect(invocation.args).toContain(provider === 'claude' ? 'Read,Glob,Grep' : 'read-only');
    const persisted = readFileSync(join(work, 'state/jobs', `agent-${job.id}.json`), 'utf8');
    expect(persisted).not.toMatch(/SECRET|source lyrics|ТЕКСТ ЗАПРОСА|КОНТЕКСТ/);
    expect(done.inputHashes.prompt).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(join(project, 'plan/project.json'), 'utf8')).toContain('test');
    unsubscribe();
    expect(manager().get(job.id)).toEqual(done);
  });

  it.each([undefined, ''])('сохраняет переносы промпта и пропускает пустой контекст %s', async (context) => {
    fake('codex', 'send({type:"turn.completed"});');
    const value = manager();
    const job = value.start({ project, task: 'Проверка', prompt: '  /мой клип/"a & b.json"\r\n$(touch файл)\n', context });
    expect(await terminal(value, job.id)).toMatchObject({ status: 'completed', phase: 'Завершено' });
    expect(readFileSync(join(work, 'stdin'), 'utf8')).toBe(
      'Подготовь предложение для пользователя. Не изменяй файлы проекта, не выполняй commit/push, не удаляй исходники или assets и не отправляй платные запросы сервисам генерации. Правила хранения проекта описаны в его README.md.\n\nЗадача:\n  /мой клип/"a & b.json"\r\n$(touch файл)\n'
    );
  });

  it('codex: сохраняет финальный JSON отдельно от commentary и чтения проекта', async () => {
    const commentary = 'Проверю AGENTS.md и README.md.';
    const finalResult = JSON.stringify({
      schemaVersion: 1,
      pass: 'treatment',
      cast: { schema_version: 1, entities: [], properties: {} },
      treatment: {
        schema_version: 1,
        logline: 'Дорога домой',
        sequences: [{ id: 'verse', title: 'Куплет', direction: 'Путь героя', start: 0, end: 10, entities: [] }]
      }
    });
    fake(
      'codex',
      `
      send({type:'thread.started',thread_id:'codex-session'});
      send({type:'turn.started'});
      send({type:'item.completed',item:{id:'commentary',type:'agent_message',text:${JSON.stringify(commentary)}}});
      send({type:'item.started',item:{id:'read-project',type:'command_execution',command:'cat AGENTS.md README.md'}});
      send({type:'item.completed',item:{id:'read-project',type:'command_execution',aggregated_output:'SECRET project instructions'}});
      setTimeout(()=>{
        send({type:'item.updated',item:{id:'final-json',type:'agent_message',text:${JSON.stringify(finalResult.slice(0, 24))}}});
        send({type:'item.completed',item:{id:'final-json',type:'agent_message',text:${JSON.stringify(finalResult)}}});
        send({type:'turn.completed'});
      },120);
    `
    );
    const value = manager();
    const events: AgentEvent[] = [];
    value.onEvent((event) => events.push(event));
    const job = start(value);
    await vi.waitFor(() => expect(events.some((event) => event.type === 'text_delta' && event.text === commentary)).toBe(true));
    expect(value.get(job.id)?.status).toBe('running');
    const done = await terminal(value, job.id);
    expect(done).toMatchObject({ status: 'completed', exitCode: 0, result: finalResult, permissions: 'read-only' });
    expect(JSON.parse(done.result)).toMatchObject({ schemaVersion: 1, pass: 'treatment' });
    expect(
      events
        .filter((event) => event.type === 'text_delta')
        .map((event) => event.text)
        .join('')
    ).toBe(`${commentary}\n${finalResult}`);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['tool_started', 'tool_finished']));
    const invocation = JSON.parse(readFileSync(join(work, 'started'), 'utf8'));
    expect(invocation.args).toEqual([
      '-a',
      'never',
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--color',
      'never',
      '--model',
      'модель с пробелами;$(touch injected)',
      '-'
    ]);
    expect(invocation.cwd).toBe(project);
    // Полная инструкция и разделители stdin являются контрактом запроса, включая пользовательские спецсимволы.
    expect(readFileSync(join(work, 'stdin'), 'utf8')).toBe(
      'Подготовь предложение для пользователя. Не изменяй файлы проекта, не выполняй commit/push, не удаляй исходники или assets и не отправляй платные запросы сервисам генерации. Правила хранения проекта описаны в его README.md.\n\nЗадача:\nТЕКСТ ЗАПРОСА; $(touch injected) "кириллица"\n\nДополнительный контекст:\nКОНТЕКСТ'
    );
    expect(job.phase).toBe('Проверка агента');
    expect(done.phase).toBe('Завершено');
    expect(events.map((event) => event.phase)).toEqual(
      expect.arrayContaining(['Проверка агента', 'Агент выполняет задачу', 'Чтение проекта', 'Получение ответа', 'Завершено'])
    );
    expect(done.log).toBe('Агент начал работу инструмента.\nАгент завершил работу инструмента.\nЗадание завершено.\n');
    expect(manager().get(job.id)?.result).toBe(finalResult);
  });

  it.each(['claude', 'codex'] as const)('%s: различает отсутствие входа и неизвестную версию до рабочего запуска', async (provider) => {
    fake(provider, '', undefined, false);
    let value = manager();
    expect(await terminal(value, start(value).id)).toMatchObject({ status: 'failed', diagnostic: 'AUTH_REQUIRED' });
    expect(existsSync(join(work, 'started'))).toBe(false);
    fake(provider, '', provider === 'claude' ? '3.0.0 (Claude Code)' : 'codex-cli 1.0.0');
    value = manager();
    expect(await terminal(value, start(value).id)).toMatchObject({ status: 'failed', diagnostic: 'UNSUPPORTED_VERSION' });
    expect(existsSync(join(work, 'started'))).toBe(false);
  });

  it.each(['claude', 'codex'] as const)('%s: обрабатывает stderr, malformed JSONL, отсутствие финала и ненулевой exit', async (provider) => {
    for (const [body, diagnostic] of [
      ['console.error("not logged in SECRET");process.exitCode=1;', 'AUTH_REQUIRED'],
      ['process.stdout.write("SECRET broken json\\n");', 'PROTOCOL_ERROR'],
      ['send({type:"новое_событие"});', 'PROTOCOL_ERROR'],
      [`${success(provider)} setTimeout(()=>process.exitCode=2,50);`, 'CLI_ERROR']
    ]) {
      fake(provider, body);
      const value = manager();
      const done = await terminal(value, start(value).id);
      expect(done).toMatchObject({ status: 'failed', diagnostic });
      expect(done.log).not.toContain('SECRET');
      expect(done.message).not.toContain('SECRET');
    }
  });

  it.each(['claude', 'codex'] as const)('%s: показывает лимит провайдера, тайм-аут и ограничение общего вывода', async (provider) => {
    fake(
      provider,
      provider === 'claude' ? 'send({type:"result",subtype:"error_max_budget_usd",is_error:true});' : 'send({type:"turn.failed",error:{message:"rate_limit"}});'
    );
    let value = manager();
    expect(await terminal(value, start(value).id)).toMatchObject({ status: 'failed', diagnostic: 'RATE_LIMIT' });
    fake(provider, 'setInterval(()=>{},1000);');
    value = manager({ timeoutMs: 120 });
    expect(await terminal(value, start(value).id)).toMatchObject({ status: 'failed', diagnostic: 'TIMEOUT' });
    fake(provider, 'console.error("SECRET".repeat(1000));');
    value = manager({ outputBytes: 2000 });
    expect(await terminal(value, start(value).id)).toMatchObject({ status: 'failed', diagnostic: 'OUTPUT_LIMIT' });
  });

  it('codex: переподключение потока не обрывает задание, а причина сбоя видна в сообщении', async () => {
    const notice =
      'send({type:"error",message:"Reconnecting... 1/5 (stream disconnected)"}); send({type:"item.completed",item:{id:"w",type:"error",message:"access_token=SECRET предупреждение"}});';
    fake('codex', notice + success('codex'));
    let value = manager();
    let done = await terminal(value, start(value).id);
    expect(done).toMatchObject({ status: 'completed', result: 'Привет мир' });
    expect(done.log).toContain('Агент сообщил: Reconnecting... 1/5 (stream disconnected)');
    expect(done.log).not.toContain('SECRET');

    fake('codex', 'send({type:"turn.failed",error:{message:"image generation is not available for this account"}});');
    value = manager();
    done = await terminal(value, start(value).id);
    expect(done).toMatchObject({ status: 'failed', diagnostic: 'CLI_ERROR' });
    expect(done.message).toContain('Сообщение агента: «image generation is not available for this account»');

    // Ход оборвался без turn.failed: причиной служит последнее уведомление, а не общая фраза о протоколе.
    fake('codex', 'send({type:"error",message:"stream disconnected before completion"});');
    value = manager();
    done = await terminal(value, start(value).id);
    expect(done).toMatchObject({ status: 'failed', diagnostic: 'CLI_ERROR' });
    expect(done.message).toContain('«stream disconnected before completion»');
  });

  it('резервирует проект до проверки, учитывает symlink и позволяет отменить до spawn', async () => {
    fake('codex', success('codex'));
    const value = manager();
    const job = start(value);
    const alias = join(work, 'Ссылка на проект');
    symlinkSync(project, alias);
    expect(() => value.start({ project: alias, task: 'Второй', prompt: 'новый запрос' })).toThrow(/PROJECT_BUSY/);
    expect(value.cancel(job.id)).toMatchObject({ status: 'cancelled', diagnostic: 'CANCELLED' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(existsSync(join(work, 'started'))).toBe(false);
    expect(value.get(job.id)?.status).toBe('cancelled');
  });

  it('отмена и закрытие убивают дочерние процессы и не оставляют статус running', async () => {
    // PID записывается рядом с фикстурой; пользовательские процессы и файлы не используются.
    fake(
      'codex',
      `const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});fs.writeFileSync(${JSON.stringify(join(work, 'child-pid'))},String(child.pid));setInterval(()=>{},1000);`
    );
    const value = manager();
    const job = start(value);
    await vi.waitFor(() => expect(existsSync(join(work, 'child-pid'))).toBe(true));
    const pid = +readFileSync(join(work, 'child-pid'), 'utf8');
    value.cancel(job.id);
    await vi.waitFor(() => {
      let state = '';
      try {
        state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0];
      } catch {
        /* Процесс уже удалён ядром. */
      }
      expect(['', 'Z', 'X']).toContain(state);
    });
    expect(value.get(job.id)?.status).toBe('cancelled');
    fake('codex', 'setInterval(()=>{},1000);');
    const second = start(value);
    await vi.waitFor(() => expect(value.get(second.id)?.cliVersion).toBeDefined());
    value.shutdown();
    expect(manager().get(second.id)).toMatchObject({ status: 'interrupted', diagnostic: 'INTERRUPTED' });
  });

  it('восстанавливает незавершённую историю как interrupted без автоматического запуска и не раскрывает изменяемую ссылку', async () => {
    fake('codex', success('codex'));
    const value = manager();
    const done = await terminal(value, start(value).id);
    const file = join(work, 'state/jobs', `agent-${done.id}.json`);
    writeFileSync(file, JSON.stringify({ ...done, status: 'running', finishedAt: null }));
    const restored = manager();
    expect(restored.get(done.id)).toMatchObject({
      status: 'interrupted',
      diagnostic: 'INTERRUPTED',
      phase: 'Прервано перезапуском',
      message: 'Приложение завершилось до получения результата. Автоматический повтор не выполнялся; для нового запуска подготовьте запрос заново.'
    });
    const clone = restored.get(done.id)!;
    clone.result = 'замена';
    expect(restored.get(done.id)?.result).toBe('Привет мир');
    expect(readdirSync(join(work, 'state/jobs')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(() => restored.start({ project, task: 'Повтор', prompt: '', retryOf: done.id })).toThrow(/INVALID_INPUT/);
  });

  it.each(['claude', 'codex'] as const)('%s: добавляет инструкции проекта один раз при запуске, доработке и повторе', async (provider) => {
    fake(provider, success(provider));
    const instructions = '  Постоянное правило\r\n\n$(не исполнять)  \n';
    writeFileSync(join(project, 'plan/project.json'), JSON.stringify({ agent_instructions: instructions }));
    const value = manager();
    const first = value.start({ project, task: 'Первый', prompt: 'Задание', context: 'Контекст' });
    expect(await terminal(value, first.id)).toMatchObject({ status: 'completed' });
    const stdin = readFileSync(join(work, 'stdin'), 'utf8');
    expect(stdin).toContain(
      `\n\nПостоянные инструкции текстовому агенту этого проекта:\n${instructions}\n\nЗадача:\nЗадание\n\nДополнительный контекст:\nКонтекст`
    );
    expect(stdin.split(instructions)).toHaveLength(2);
    writeFileSync(join(project, 'plan/project.json'), JSON.stringify({ agent_instructions: 'Новое правило' }));
    const retry = value.start({ project, task: 'Повтор', prompt: 'Доработай ответ', retryOf: first.id });
    expect(await terminal(value, retry.id)).toMatchObject({ status: 'completed', retryOf: first.id });
    expect(readFileSync(join(work, 'stdin'), 'utf8')).toContain('Новое правило\n\nЗадача:\nДоработай ответ');
    expect(readFileSync(join(work, 'stdin'), 'utf8')).not.toContain(instructions);
    writeFileSync(join(project, 'plan/project.json'), JSON.stringify({ agent_instructions: '' }));
    const empty = value.start({ project, task: 'Пустое поле', prompt: 'Задание' });
    expect(await terminal(value, empty.id)).toMatchObject({ status: 'completed' });
    expect(readFileSync(join(work, 'stdin'), 'utf8')).not.toContain('Постоянные инструкции текстовому агенту');
  });

  it('берёт снимок инструкций проекта задания до диагностики и не смешивает два клипа', async () => {
    fake('codex', success('codex'));
    const secondProject = join(work, 'Второй клип');
    mkdirSync(join(secondProject, 'plan'), { recursive: true });
    writeFileSync(join(secondProject, 'plan/project.json'), JSON.stringify({ agent_instructions: 'Правило второго клипа' }));
    writeFileSync(join(project, 'plan/project.json'), JSON.stringify({ agent_instructions: 'Правило первого клипа' }));
    const value = manager();
    const first = value.start({ project, task: 'Первый', prompt: 'Задание' });
    writeFileSync(join(project, 'plan/project.json'), JSON.stringify({ agent_instructions: 'Правка во время запуска' }));
    await terminal(value, first.id);
    expect(readFileSync(join(work, 'stdin'), 'utf8')).toContain('Правило первого клипа');
    expect(readFileSync(join(work, 'stdin'), 'utf8')).not.toContain('Правка во время запуска');
    const second = value.start({ project: secondProject, task: 'Второй', prompt: 'Задание' });
    await terminal(value, second.id);
    expect(readFileSync(join(work, 'stdin'), 'utf8')).toContain('Правило второго клипа');
    expect(readFileSync(join(work, 'stdin'), 'utf8')).not.toContain('Правило первого клипа');
    expect(() => value.start({ project: secondProject, task: 'Чужой повтор', prompt: 'Задание', retryOf: first.id })).toThrow(/INVALID_INPUT/);
    const retry = value.start({ project, task: 'Снова первый', prompt: 'Задание', retryOf: first.id });
    await terminal(value, retry.id);
    expect(readFileSync(join(work, 'stdin'), 'utf8')).toContain('Правка во время запуска');
    expect(readFileSync(join(work, 'stdin'), 'utf8')).not.toContain('Правило второго клипа');
  });

  it('инструкции не подменяют выбор текстового агента и не передаются исполнителю изображений', async () => {
    writeFileSync(join(project, 'plan/project.json'), JSON.stringify({ agent_instructions: 'Только текстовому агенту' }));
    expect(() => manager().start({ project, task: 'Без исполнителя', prompt: 'Задание' })).toThrow(/INVALID_INPUT/);
    fake('codex', success('codex'));
    const candidate = join(settings.localDir, 'image-jobs', 'candidate');
    mkdirSync(candidate, { recursive: true });
    const value = manager();
    const image = value.startImages({ project, task: 'Изображение', prompt: 'Нарисуй' }, candidate, { provider: 'codex' });
    expect(await terminal(value, image.id)).toMatchObject({ status: 'completed' });
    expect(readFileSync(join(work, 'stdin'), 'utf8')).not.toContain('Только текстовому агенту');
    expect(readFileSync(join(work, 'stdin'), 'utf8')).not.toContain('Постоянные инструкции текстовому агенту');
  });

  it('повреждённые инструкции останавливают запуск до CLI и записи задания', () => {
    fake('codex', success('codex'));
    writeFileSync(join(project, 'plan/project.json'), JSON.stringify({ agent_instructions: 42 }));
    const value = manager();
    expect(() => start(value)).toThrow(/agent_instructions должен быть строкой/);
    expect(value.list()).toEqual([]);
    expect(existsSync(join(work, 'started'))).toBe(false);
  });
});
