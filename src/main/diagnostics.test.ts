/** Журнал сбоев, файл сеанса и отчёт для разработчика проверяются на временном каталоге состояния без Electron. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentJob } from '@shared/agents';
import type { JobInfo } from '@shared/types';
import { beginSession, buildReport, CrashLog, endSession, hideHome, jobText, previousSessionInfo, type RuntimeInfo } from './diagnostics';

let localDir: string;
beforeEach(() => {
  localDir = mkdtempSync(join(tmpdir(), 'songframe-diagnostics-'));
});
afterEach(() => {
  rmSync(localDir, { recursive: true, force: true });
});

const HOME = '/home/oleg';
const INFO: RuntimeInfo = { app: '0.1.0', electron: '38.0.0', node: '22.19.0', os: 'linux 6.8.0', arch: 'x64', packaged: true };

function toolJob(index: number, overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    id: `job${index}-1`,
    project: `${HOME}/Клипы/Олег`,
    kind: 'submit',
    title: `Отправка M${index}`,
    status: 'failed',
    startedAt: new Date(Date.UTC(2026, 9, 28, 10, index)).toISOString(),
    finishedAt: null,
    log: '',
    code: 3,
    error: 'Провайдер отказал',
    steps: [{ label: 'отправка', tool: 'media_request', status: 'failed', code: 3 }],
    ...overrides
  };
}

function agentJob(): AgentJob {
  return {
    schemaVersion: 1,
    id: '11111111-2222-3333-4444-555555555555',
    sequence: 4,
    project: `${HOME}/Клипы/Олег`,
    provider: 'claude',
    task: 'Сценарий',
    permissions: 'read-only',
    inputHashes: { prompt: 'a'.repeat(64), context: 'b'.repeat(64) },
    status: 'failed',
    phase: 'Ошибка',
    startedAt: '2026-10-28T09:00:00.000Z',
    finishedAt: '2026-10-28T09:05:00.000Z',
    exitCode: 1,
    diagnostic: 'CLI_ERROR',
    message: 'Секретное сообщение агента',
    result: 'Текст ответа агента',
    log: 'Вывод агента'
  };
}

describe('Журнал сбоев', () => {
  it('пишет время, вид и стек с отступом, скрывая домашний каталог и токены', () => {
    const log = new CrashLog(localDir, { home: HOME, now: () => new Date('2026-10-28T11:20:30.000Z') });
    log.write('uncaughtException', `Error: нет файла ${HOME}/Клипы/plan.json\n    at main (${HOME}/app/index.js:1:1)\nAuthorization: Bearer abcdefghijkl`);
    const text = readFileSync(join(localDir, 'logs', 'app.log'), 'utf8');
    expect(text).toBe(
      '2026-10-28T11:20:30.000Z [uncaughtException] Error: нет файла ~/Клипы/plan.json\n' +
        '        at main (~/app/index.js:1:1)\n' +
        '    Authorization: [скрыто]\n'
    );
  });

  it('при превышении размера переименовывает журнал в app.1.log и хранит одну копию', () => {
    const log = new CrashLog(localDir, { limit: 100, home: HOME });
    log.write('first', 'x'.repeat(120));
    log.write('second', 'вторая запись');
    expect(readFileSync(join(localDir, 'logs', 'app.1.log'), 'utf8')).toContain('[first]');
    expect(readFileSync(join(localDir, 'logs', 'app.log'), 'utf8')).toContain('[second]');
    log.write('third', 'y'.repeat(120));
    log.write('fourth', 'четвёртая');
    expect(readFileSync(join(localDir, 'logs', 'app.1.log'), 'utf8')).not.toContain('[first]');
    expect(readFileSync(join(localDir, 'logs', 'app.1.log'), 'utf8')).toContain('[third]');
    expect(readFileSync(join(localDir, 'logs', 'app.log'), 'utf8')).toContain('[fourth]');
  });

  it('заменяет домашний каталог Windows в обоих видах разделителей', () => {
    expect(hideHome('C:\\Users\\Oleg\\AppData\\Roaming\\songframe и C:/Users/Oleg/Клип', 'C:\\Users\\Oleg')).toBe('~\\AppData\\Roaming\\songframe и ~/Клип');
  });
});

describe('Файл сеанса', () => {
  const read = (): Record<string, unknown> => JSON.parse(readFileSync(join(localDir, 'logs', 'session.json'), 'utf8'));

  it('первый запуск не считается аварийным; штатный выход помечает сеанс чистым', () => {
    const first = beginSession(localDir, { startedAt: '2026-10-28T10:00:00Z', version: '0.1.0', pid: 10 });
    expect(first).toMatchObject({ previous: null, crashed: false });
    expect(read()).toEqual({ startedAt: '2026-10-28T10:00:00Z', version: '0.1.0', pid: 10, clean: false });
    endSession(localDir, first.record);
    expect(read()).toMatchObject({ pid: 10, clean: true });

    const second = beginSession(localDir, { startedAt: '2026-10-28T11:00:00Z', version: '0.1.0', pid: 11 });
    expect(second.crashed).toBe(false);
    expect(previousSessionInfo(second.previous, second.crashed)).toEqual({ crashed: false, startedAt: '2026-10-28T10:00:00Z', version: '0.1.0' });
  });

  it('сеанс без штатного выхода считается аварийным; повреждённый файл не мешает запуску', () => {
    beginSession(localDir, { startedAt: '2026-10-28T10:00:00Z', version: '0.1.0', pid: 10 });
    const next = beginSession(localDir, { startedAt: '2026-10-28T11:00:00Z', version: '0.2.0', pid: 11 });
    expect(next.crashed).toBe(true);
    expect(previousSessionInfo(next.previous, next.crashed)).toEqual({ crashed: true, startedAt: '2026-10-28T10:00:00Z', version: '0.1.0' });

    writeFileSync(join(localDir, 'logs', 'session.json'), '{ сломано');
    expect(beginSession(localDir, { startedAt: '2026-10-28T12:00:00Z', version: '0.2.0', pid: 12 })).toMatchObject({ previous: null, crashed: false });
  });
});

describe('Отчёт для разработчика', () => {
  beforeEach(() => {
    mkdirSync(join(localDir, 'logs'), { recursive: true });
    mkdirSync(join(localDir, 'providers', 'paid'), { recursive: true });
    writeFileSync(join(localDir, 'logs', 'app.log'), '2026-10-28T11:00:00.000Z [uncaughtException] Error: сбой\n');
    writeFileSync(join(localDir, 'logs', 'app.1.log'), '2026-10-27T11:00:00.000Z [session] прошлый журнал\n');
    writeFileSync(join(localDir, 'settings.json'), JSON.stringify({ secret: 'SETTINGS-SECRET' }));
    writeFileSync(join(localDir, 'providers', 'paid', 'credentials.json'), JSON.stringify({ token: 'CREDENTIALS-SECRET' }));
  });

  const report = (overrides: Partial<Parameters<typeof buildReport>[0]> = {}): string =>
    buildReport({
      localDir,
      info: INFO,
      previous: { crashed: true, startedAt: '2026-10-28T10:00:00Z', version: '0.1.0' },
      jobs: [toolJob(2), toolJob(1, { status: 'interrupted', previousSession: true })],
      readLog: (id) => `${Array.from({ length: 300 }, (_, line) => `${id} строка ${line}`).join('\n')}\nпуть ${HOME}/Клипы\n`,
      agents: [agentJob()],
      now: new Date('2026-10-28T12:00:00.000Z'),
      home: HOME,
      ...overrides
    });

  it('содержит версии, сеанс, журналы сбоев, задания и сводку агента без секретов и домашнего каталога', () => {
    const text = report({ localDir: join(HOME, '.config', 'songframe'), home: HOME });
    expect(text.startsWith('SongFrame: отчёт для разработчика\nСоздан: 2026-10-28T12:00:00.000Z\nSongFrame 0.1.0; Electron 38.0.0; Node 22.19.0')).toBe(true);
    expect(text).toContain('Каталог состояния: ~/.config/songframe');
    expect(text).toContain('Прошлый сеанс: завершился аварийно (начат 2026-10-28T10:00:00Z, версия 0.1.0)');
    expect(text).not.toContain(HOME);
  });

  it('включает оба журнала сбоев, хвосты журналов заданий и сводку агента без промптов и вывода', () => {
    const text = report();
    expect(text.indexOf('logs/app.1.log')).toBeLessThan(text.indexOf('logs/app.log'));
    expect(text).toContain('[uncaughtException] Error: сбой');
    expect(text).toContain('Задание job2-1: Отправка M2');
    expect(text).toContain('статус: interrupted');
    expect(text).toContain('отправка (media_request): failed, код 3');
    expect(text).toContain('job1-1 строка 299');
    expect(text).not.toContain('job1-1 строка 100\n');
    expect(text).toContain('путь ~/Клипы');
    expect(text).toContain('11111111-2222-3333-4444-555555555555; задача: Сценарий; провайдер: claude; статус: failed');
    expect(text).toContain('код выхода: 1; диагностика: CLI_ERROR');
    for (const secret of ['SETTINGS-SECRET', 'CREDENTIALS-SECRET', 'Секретное сообщение агента', 'Текст ответа агента', 'Вывод агента'])
      expect(text).not.toContain(secret);
  });

  it('ограничивает размер и сообщает, что журналы остальных заданий не вошли', () => {
    const jobs = Array.from({ length: 50 }, (_, index) => toolJob(index));
    const text = report({ jobs, readLog: () => 'ж'.repeat(5000), limit: 40 * 1024 });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(40 * 1024);
    expect(text).toContain('Отчёт ограничен 40 КБ: журналы остальных заданий не включены.');
    expect(text).toContain('== Задания агента');
  });

  it('копия задания содержит сведения и журнал', () => {
    const text = jobText(toolJob(1), 'строка журнала\n');
    expect(text).toContain('Задание job1-1: Отправка M1');
    expect(text).toContain('Ошибка: Провайдер отказал');
    expect(text).toContain('Журнал:\nстрока журнала');
    expect(existsSync(join(localDir, 'logs', 'app.log'))).toBe(true);
  });
});
