/** Необработанные ошибки окна уходят в журнал сбоев главного процесса: после вылета их можно отправить разработчику. */
import type { RendererErrorReport } from '@shared/types';

/** Уведомление об аварийном прошлом сеансе; название страницы в кавычках становится ссылкой через LinkedText. */
export const CRASH_NOTICE = 'Прошлый сеанс SongFrame завершился аварийно. Подробности и отчёт для разработчика — на странице «Журнал заданий».';

function describe(value: unknown): Pick<RendererErrorReport, 'message' | 'stack'> {
  if (value instanceof Error) return { message: `${value.name}: ${value.message}`, stack: value.stack };
  return { message: typeof value === 'string' ? value : String(value) };
}

/** Подключается один раз в общей точке входа renderer (main.tsx) для всех окон. */
export function installErrorReporting(target: Pick<Window, 'addEventListener' | 'api'> = window): void {
  const send = (report: RendererErrorReport): void => {
    try {
      target.api?.diagnostics.reportRendererError(report);
    } catch {
      // Журнал недоступен: ошибка остаётся в консоли окна.
    }
  };
  target.addEventListener('error', (event) => {
    const source = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined;
    send({ kind: 'error', ...describe(event.error ?? event.message), source });
  });
  target.addEventListener('unhandledrejection', (event) => send({ kind: 'unhandledrejection', ...describe(event.reason) }));
}
