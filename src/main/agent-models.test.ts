/** Каталог моделей агента: подставные CLI и адаптеры, без настоящих claude/codex и сетевых запросов. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCheckResult, AgentModel } from '@shared/agents';
import { ClaudeAdapter, type AgentAdapter } from './agent-adapters';
import { readAgentModels } from './agent-models';
import { readClaudeModels } from './claude-account-transport';
import type { AccountProcessOptions } from './codex-account-transport';

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'Модели агента '));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(work, { recursive: true, force: true });
});

const options = (timeoutMs = 1500): AccountProcessOptions => ({ home: work, env: { PATH: work, HOME: work }, timeoutMs });

function lines(name: string): Record<string, unknown>[] {
  return readFileSync(join(work, name), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

/** Фальшивый Claude: версия, статус входа и control protocol; initialize отвечает заданным списком моделей. */
function claude(initialize: unknown, extra = ''): string {
  const path = join(work, 'claude');
  writeFileSync(
    path,
    `#!${process.execPath}
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(join(work, 'args.jsonl'))}, JSON.stringify(args) + '\\n');
    if (JSON.stringify(args) === '["--version"]') console.log('2.1.284 (Claude Code)');
    else if (JSON.stringify(args) === '["auth","status","--json"]') console.log('{"loggedIn":true}');
    else if (args[0] === '--output-format') {
      ${extra}
      require('node:readline').createInterface({input:process.stdin}).on('line', (line) => {
        const request = JSON.parse(line);
        fs.appendFileSync(${JSON.stringify(join(work, 'requests.jsonl'))}, line + '\\n');
        if (request.request.subtype !== 'initialize') process.exit(98);
        console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,response:${JSON.stringify(initialize)}}}));
      });
    } else process.exit(99);
  `,
    { mode: 0o700 }
  );
  return path;
}

describe.skipIf(process.platform !== 'linux')('readClaudeModels', () => {
  it('читает модели из initialize, отбрасывая default, пустые и некорректные значения', async () => {
    const executable = claude(
      {
        models: [
          { value: 'default', displayName: 'По умолчанию' },
          { value: 'sonnet', displayName: ' Sonnet ', description: ' Быстрая модель ' },
          { value: 'opus' },
          { value: '  ', displayName: 'Пустая' },
          { value: 'with space', displayName: 'Пробел' },
          { displayName: 'Без value' },
          'строка'
        ]
      },
      'console.log(JSON.stringify({type:"system",subtype:"status"}));'
    );
    expect(await readClaudeModels(executable, options())).toEqual([
      { id: 'sonnet', label: 'Sonnet', description: 'Быстрая модель' },
      { id: 'opus', label: 'opus' }
    ]);
    const requests = lines('requests.jsonl');
    expect(requests).toEqual([{ type: 'control_request', request_id: 'initialize', request: { subtype: 'initialize' } }]);
    // Служебный запуск без инструментов, хуков и сохранения сессии.
    const [args] = lines('args.jsonl') as unknown as string[][];
    expect(args).toEqual(expect.arrayContaining(['--no-session-persistence', '--strict-mcp-config', '--setting-sources=']));
    expect(args).not.toContain('-p');
  });

  it('отклоняет ответ без списка моделей и неожиданный ход модели', async () => {
    await expect(readClaudeModels(claude({}), options())).rejects.toThrow('не вернул список моделей');
    const turn = claude({ models: [] }, 'console.log(JSON.stringify({type:"assistant",message:{content:[]}}));');
    await expect(readClaudeModels(turn, options())).rejects.toThrow('не ответил');
  });

  it('завершает зависший CLI по таймауту', async () => {
    const path = join(work, 'claude');
    writeFileSync(path, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
    await expect(readClaudeModels(path, options(100))).rejects.toThrow();
  });
});

function stub(check: AgentCheckResult, models: AgentAdapter['models']): AgentAdapter & { calls: Array<[string, AccountProcessOptions]> } {
  const calls: Array<[string, AccountProcessOptions]> = [];
  return {
    provider: 'claude',
    calls,
    check: async () => check,
    account: async () => {
      throw new Error('account не должен вызываться');
    },
    models: (executable, value) => {
      calls.push([executable, value]);
      return models(executable, value);
    },
    args: () => [],
    parse: () => []
  };
}

const available: AgentCheckResult = {
  executablePath: '/fixture/bin/claude',
  version: '2.1.284',
  availability: 'available',
  authorization: 'authenticated',
  message: ''
};
const models: AgentModel[] = [{ id: 'sonnet', label: 'Sonnet' }];

describe('readAgentModels', () => {
  it('при ненайденном CLI возвращает пустой список с сообщением проверки, не читая каталог', async () => {
    const adapter = stub({ availability: 'not_found', authorization: 'unknown', message: 'Claude Code не найден в PATH' }, async () => models);
    expect(await readAgentModels(adapter, { provider: 'claude' }, { home: work, env: { PATH: work } })).toEqual({
      models: [],
      message: 'Claude Code не найден в PATH'
    });
    expect(adapter.calls).toEqual([]);
  });

  it('при доступном CLI без пути не читает каталог', async () => {
    const adapter = stub({ ...available, executablePath: undefined, message: 'без пути' }, async () => models);
    expect(await readAgentModels(adapter, { provider: 'claude' })).toEqual({ models: [], message: 'без пути' });
    expect(adapter.calls).toEqual([]);
  });

  it('при ошибке каталога возвращает пустой список с предложением ввести модель вручную', async () => {
    const adapter = stub(available, async () => {
      throw new Error('SECRET');
    });
    const result = await readAgentModels(adapter, { provider: 'claude' }, { home: work, env: { PATH: work } });
    expect(result.models).toEqual([]);
    expect(result.message).toBe('Каталог моделей Claude Code сейчас недоступен. Модель можно ввести вручную.');
    expect(result.message).not.toContain('SECRET');
  });

  it('пустой каталог тоже предлагает ручной ввод', async () => {
    const result = await readAgentModels(
      stub(available, async () => []),
      { provider: 'claude' }
    );
    expect(result).toMatchObject({ models: [] });
    expect(result.message).toBe('Claude Code не вернул доступные модели. Модель можно ввести вручную.');
  });

  it('читает модели найденного файла с расширенным PATH и home', async () => {
    const adapter = stub(available, async () => models);
    expect(await readAgentModels(adapter, { provider: 'claude' }, { home: work, env: { PATH: '/fixture/path' }, timeoutMs: 777 })).toEqual({ models });
    const [[executable, value]] = adapter.calls;
    expect(executable).toBe('/fixture/bin/claude');
    expect(value).toMatchObject({ home: work, timeoutMs: 777 });
    expect(value.env.PATH?.split(delimiter)).toEqual(expect.arrayContaining(['/fixture/path', join(work, '.local', 'bin'), '/usr/bin']));
  });

  it.skipIf(process.platform !== 'linux')('с ClaudeAdapter находит подставной claude первым в PATH', async () => {
    const executable = claude({ models: [{ value: 'default' }, { value: 'haiku', displayName: 'Haiku' }] });
    vi.stubEnv('PATH', work + delimiter + (process.env.PATH ?? ''));
    expect(await readAgentModels(new ClaudeAdapter(), { provider: 'claude' }, { home: work, timeoutMs: 1500 })).toEqual({
      models: [{ id: 'haiku', label: 'Haiku' }]
    });
    expect(lines('args.jsonl')[0]).toEqual(['--version']);
    expect(lines('requests.jsonl')).toHaveLength(1);
    expect(executable).toBe(join(work, 'claude'));
  });
});
