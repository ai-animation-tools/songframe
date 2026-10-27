/** Подставной CLI проверяет control protocol и завершение процесса без запросов к модели. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readClaudeUsage } from './claude-account-transport';

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'Лимиты Claude '));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function cli(usage: unknown, behavior = ''): string {
  const path = join(work, 'claude');
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(${JSON.stringify(join(work, 'args'))}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(join(work, 'pid'))}, String(process.pid));
${behavior}
readline.createInterface({ input: process.stdin }).on('line', line => {
  fs.appendFileSync(${JSON.stringify(join(work, 'requests'))}, line + '\\n');
  const message = JSON.parse(line);
  if (message.type !== 'control_request' || !['initialize', 'get_usage'].includes(message.request?.subtype)) process.exit(91);
  if (message.request.subtype === 'get_usage' && message.request.skip_behaviors !== true) process.exit(92);
  const response = message.request.subtype === 'initialize' ? { account: { email: 'private@example.test' } } : ${JSON.stringify(usage)};
  console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } }));
});
`,
    { mode: 0o700 }
  );
  return path;
}

function read(executable: string, timeoutMs = 1000) {
  return readClaudeUsage(executable, { env: process.env, home: work, timeoutMs });
}

describe.skipIf(process.platform !== 'linux')('Лимиты Claude без пользовательского хода', () => {
  it('получает настоящий ноль, передаёт только initialize/get_usage и удаляет посторонние поля', async () => {
    const result = await read(
      cli({
        subscription_type: 'pro',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 0, resets_at: null, email: 'private@example.test' },
          seven_day: { utilization: 24, resets_at: '2026-10-26T01:00:00Z' },
          limits: [{ kind: 'session', group: 'session', percent: 0, severity: 'normal', resets_at: null, is_active: true, label: 'private@example.test' }],
          credentials: 'secret-canary'
        },
        account: { email: 'private@example.test' },
        behaviors: { transcript: 'private' }
      })
    );
    expect(result).toEqual({
      subscription_type: 'pro',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 0, resets_at: null },
        seven_day: { utilization: 24, resets_at: '2026-10-26T01:00:00Z' },
        limits: [{ kind: 'session', group: 'session', percent: 0, severity: 'normal', resets_at: null, is_active: true }]
      }
    });
    const requests = readFileSync(join(work, 'requests'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(requests).toEqual([
      { type: 'control_request', request_id: 'initialize', request: { subtype: 'initialize' } },
      { type: 'control_request', request_id: 'get_usage', request: { subtype: 'get_usage', skip_behaviors: true } }
    ]);
    const args = JSON.parse(readFileSync(join(work, 'args'), 'utf8')) as string[];
    expect(args).not.toContain('-p');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--setting-sources=');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('{"mcpServers":{}}');
    expect(args).toContain('{"disableAllHooks":true}');
    expect(JSON.stringify(result)).not.toMatch(/private|secret-canary|credentials|account|behaviors/);
  });

  it('сохраняет неизвестные частичные значения как null, не подставляя нули', async () => {
    expect(
      await read(
        cli({
          rate_limits: { five_hour: { utilization: 101, resets_at: 'not-a-date' }, limits: [{ kind: 'private@example.test', group: 'weekly', percent: 0 }] }
        })
      )
    ).toEqual({ subscription_type: null, rate_limits_available: null, rate_limits: { five_hour: { utilization: null, resets_at: null }, limits: [] } });
  });

  it('различает недоступные лимиты и некорректный ответ', async () => {
    expect(await read(cli({ subscription_type: null, rate_limits_available: false, rate_limits: null }))).toEqual({
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null
    });
    expect(await read(cli({ unrelated: true }))).toBeNull();
  });

  it.each([
    "console.log('invalid-json'); process.stdin.resume(); return;",
    "console.log(JSON.stringify({type:'assistant',message:{content:'secret'}})); process.stdin.resume(); return;",
    "console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:'wrong'}})); process.stdin.resume(); return;",
    "console.log('x'.repeat(140000)); process.stdin.resume(); return;"
  ])('прерывает неверный протокол или чрезмерный вывод', async (behavior) => {
    expect(await read(cli({}, behavior))).toBeNull();
  });

  it('ограничивает ожидание и убивает CLI, который игнорирует EOF и SIGTERM', async () => {
    const executable = cli({}, "process.on('SIGTERM', () => {}); process.stdin.resume(); setInterval(() => {}, 1000); return;");
    const start = Date.now();
    expect(await read(executable, 150)).toBeNull();
    expect(Date.now() - start).toBeLessThan(1500);
    const pid = Number(readFileSync(join(work, 'pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
