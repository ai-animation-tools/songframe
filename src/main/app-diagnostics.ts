/** Подключение журнала сбоев к событиям главного процесса, окон и дочерних процессов Electron. */
import { release } from 'node:os';
import { app, dialog, type BrowserWindow } from 'electron';
import type { PreviousSessionInfo, RendererErrorReport } from '@shared/types';
import { diagnosticsTexts } from '@shared/texts/diagnostics';
import { beginSession, CrashLog, describeFailure, endSession, previousSessionInfo, runtimeLine, type RuntimeInfo, type SessionRecord } from './diagnostics';

const RENDERER_TEXT_LIMIT = 8000;

export function runtimeInfo(): RuntimeInfo {
  return {
    app: app.getVersion(),
    electron: process.versions.electron ?? '—',
    node: process.versions.node,
    os: `${process.platform} ${release()}`,
    arch: process.arch,
    packaged: app.isPackaged
  };
}

export class AppDiagnostics {
  readonly log: CrashLog;
  readonly previous: PreviousSessionInfo;
  private readonly session: SessionRecord | null;
  private noticePending: boolean;
  private finished = false;

  /** Только оконный запуск: служебные проверки без окна не трогают сеанс пользователя. */
  constructor(readonly localDir: string) {
    this.log = new CrashLog(localDir);
    const info = runtimeInfo();
    // eslint-disable-next-line no-restricted-syntax -- Запись старта сеанса принадлежит служебному журналу.
    this.log.write('session', `Запуск: ${runtimeLine(info)}; pid ${process.pid}`);
    let session: SessionRecord | null = null;
    let previous: PreviousSessionInfo = { crashed: false, startedAt: null, version: null };
    try {
      const started = beginSession(localDir, { startedAt: new Date().toISOString(), version: info.app, pid: process.pid });
      session = started.record;
      previous = previousSessionInfo(started.previous, started.crashed);
      if (started.crashed)
        this.log.write(
          'previousSessionCrash',
          // eslint-disable-next-line no-restricted-syntax -- Сведения предыдущего процесса сохраняются только в журнале сбоев.
          `Прошлый сеанс (начат ${started.previous?.startedAt}, версия ${started.previous?.version}, pid ${started.previous?.pid}) не завершился штатно.`
        );
    } catch (error) {
      // eslint-disable-next-line no-restricted-syntax -- Отказ записи файла сеанса выводится только в журнал сбоев.
      this.log.write('session', `Не удалось записать файл сеанса: ${describeFailure(error)}`);
    }
    this.session = session;
    this.previous = previous;
    this.noticePending = previous.crashed;
    this.install();
  }

  private install(): void {
    process.on('uncaughtException', (error) => {
      this.log.write('uncaughtException', describeFailure(error));
      console.error(error);
      // Как и стандартное окно Electron, сообщаем о сбое, но добавляем, где искать подробности.
      dialog.showErrorBox(diagnosticsTexts.crashTitle, diagnosticsTexts.crashDetails({ details: error instanceof Error ? error.message : String(error) }));
    });
    process.on('unhandledRejection', (reason) => {
      this.log.write('unhandledRejection', describeFailure(reason));
      console.error(reason);
    });
    app.on('render-process-gone', (_event, contents, details) => {
      if (details.reason === 'clean-exit') return;
      // eslint-disable-next-line no-restricted-syntax -- Причина завершения renderer записывается только в служебный журнал.
      this.log.write('render-process-gone', `Окно «${contents.getTitle()}»: причина ${details.reason}, код ${details.exitCode}`);
    });
    app.on('child-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit') return;
      // eslint-disable-next-line no-restricted-syntax -- Причина завершения дочернего процесса принадлежит журналу Electron.
      this.log.write('child-process-gone', `${details.type}${details.name ? ` (${details.name})` : ''}: причина ${details.reason}, код ${details.exitCode}`);
    });
    app.on('browser-window-created', (_event, window: BrowserWindow) => {
      // eslint-disable-next-line no-restricted-syntax -- Событие зависания окна записывается только в журнал сбоев.
      window.on('unresponsive', () => this.log.write('unresponsive', `Окно «${window.getTitle()}» не отвечает.`));
      // eslint-disable-next-line no-restricted-syntax -- Событие восстановления окна записывается только в журнал сбоев.
      window.on('responsive', () => this.log.write('responsive', `Окно «${window.getTitle()}» снова отвечает.`));
    });
  }

  /** Ошибка renderer: только сообщение и стек, без данных страницы. */
  rendererError(report: RendererErrorReport): void {
    const text = [report.message, report.source, report.stack].filter((part) => typeof part === 'string' && part).join('\n');
    this.log.write(`renderer:${report.kind === 'unhandledrejection' ? 'unhandledrejection' : 'error'}`, text.slice(0, RENDERER_TEXT_LIMIT));
  }

  /** Уведомление об аварийном прошлом сеансе показывается один раз за запуск. */
  takeCrashNotice(): PreviousSessionInfo | null {
    if (!this.noticePending) return null;
    this.noticePending = false;
    return this.previous;
  }

  /** Штатный выход: сеанс помечается чистым. */
  finish(): void {
    if (this.finished || !this.session) return;
    this.finished = true;
    try {
      endSession(this.localDir, this.session);
      // eslint-disable-next-line no-restricted-syntax -- Штатное завершение сохраняет служебный формат журнала сеанса.
      this.log.write('session', 'Штатный выход.');
    } catch (error) {
      // eslint-disable-next-line no-restricted-syntax -- Отказ записи завершения сеанса выводится только в журнал сбоев.
      this.log.write('session', `Не удалось отметить штатный выход: ${describeFailure(error)}`);
    }
  }
}
