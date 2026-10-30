/** Диалог Electron проверяется вместе с сохранением сеанса и журнала; обработчики процесса перехватываются только на время теста. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDiagnostics } from './app-diagnostics';
import { beginSession } from './diagnostics';

const electron = vi.hoisted(() => ({
  app: { getVersion: vi.fn(() => '0.1.0'), isPackaged: true, on: vi.fn() },
  dialog: { showErrorBox: vi.fn() }
}));
vi.mock('electron', () => electron);

let localDir: string;
const spyOnProcess = () => vi.spyOn(process, 'on');
let processOn: ReturnType<typeof spyOnProcess>;
beforeEach(() => {
  vi.clearAllMocks();
  localDir = mkdtempSync(join(tmpdir(), 'songframe-app-diagnostics-'));
  processOn = spyOnProcess().mockReturnValue(process);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(localDir, { recursive: true, force: true });
});

/** Обработчик извлекается из настоящей установки адаптера без глобальной отправки событий process. */
function processFailure(event: string, failure: unknown): void {
  const listener = processOn.mock.calls.find(([name]) => name === event)?.[1];
  if (!listener) throw new Error(`Не установлен обработчик ${event}`);
  listener(failure);
}

describe('Диагностика приложения', () => {
  it('показывает полное сообщение ошибки и сохраняет стек с причиной в журнале', () => {
    const diagnostics = new AppDiagnostics(localDir);
    const failure = new Error('Файл «C:\\Клипы\\A&B <дубль>.json»\nСтрока 2', { cause: 'Нет доступа «&<>»' });
    failure.stack = 'Error: Файл «C:\\Клипы\\A&B <дубль>.json»\n    at /Клип/index.js:7:2';
    processFailure('uncaughtException', failure);
    expect(electron.dialog.showErrorBox).toHaveBeenCalledExactlyOnceWith(
      'SongFrame: ошибка программы',
      'Файл «C:\\Клипы\\A&B <дубль>.json»\nСтрока 2\n\nПодробности записаны в журнал сбоев. Отчёт для разработчика можно сохранить на странице «Журнал заданий».'
    );
    expect(readFileSync(diagnostics.log.path, 'utf8')).toContain(
      '[uncaughtException] Error: Файл «C:\\Клипы\\A&B <дубль>.json»\n        at /Клип/index.js:7:2\n    Причина: Нет доступа «&<>»\n'
    );
    expect(console.error).toHaveBeenCalledWith(failure);
  });

  it('сохраняет String fallback диалога для unknown и не показывает диалог отклонённого Promise', () => {
    const diagnostics = new AppDiagnostics(localDir);
    processFailure('uncaughtException', { toString: () => 'Неизвестный сбой «&<>»' });
    expect(electron.dialog.showErrorBox).toHaveBeenCalledExactlyOnceWith(
      'SongFrame: ошибка программы',
      'Неизвестный сбой «&<>»\n\nПодробности записаны в журнал сбоев. Отчёт для разработчика можно сохранить на странице «Журнал заданий».'
    );
    processFailure('unhandledRejection', 'Ошибка Promise: Authorization: Bearer secret-value-123456789');
    expect(electron.dialog.showErrorBox).toHaveBeenCalledTimes(1);
    const log = readFileSync(diagnostics.log.path, 'utf8');
    expect(log).toContain('[unhandledRejection] Ошибка Promise: Authorization: [скрыто]');
    expect(log).not.toContain('secret-value-123456789');
  });

  it('сохраняет сведения прошлого сеанса, однократное уведомление и штатное завершение', () => {
    beginSession(localDir, { startedAt: '2026-10-28T10:00:00Z', version: '0.0.9', pid: 17 });
    const diagnostics = new AppDiagnostics(localDir);
    expect(diagnostics.takeCrashNotice()).toEqual({ crashed: true, startedAt: '2026-10-28T10:00:00Z', version: '0.0.9' });
    expect(diagnostics.takeCrashNotice()).toBeNull();
    diagnostics.rendererError({ kind: 'error', message: 'Ошибка окна «&<>»', source: 'file:///Клипы/index.js:7', stack: 'Error: окно\n at main' });
    diagnostics.finish();
    diagnostics.finish();
    const log = readFileSync(diagnostics.log.path, 'utf8');
    expect(log).toContain('[previousSessionCrash] Прошлый сеанс (начат 2026-10-28T10:00:00Z, версия 0.0.9, pid 17) не завершился штатно.');
    expect(log).toContain('[renderer:error] Ошибка окна «&<>»\n    file:///Клипы/index.js:7\n    Error: окно\n     at main');
    expect(log.match(/Штатный выход\./g)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(localDir, 'logs', 'session.json'), 'utf8'))).toMatchObject({ clean: true, version: '0.1.0', pid: process.pid });
  });
});
