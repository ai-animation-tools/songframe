/** Ошибки окна доходят до журнала сбоев, а уведомление о сбое ведёт на страницу журнала. */
import { describe, expect, it, vi } from 'vitest';
import type { Api } from '@shared/api';
import { linkSegments } from './components/linkTargets';
import { CRASH_NOTICE, installErrorReporting } from './diagnostics';

describe('Перехват ошибок renderer', () => {
  it('передаёт ошибку и отклонённое обещание в главный процесс', () => {
    const target = new EventTarget();
    const reportRendererError = vi.fn();
    installErrorReporting(Object.assign(target, { api: { diagnostics: { reportRendererError } } as unknown as Api }));

    const error = new TypeError('нет свойства');
    const event = Object.assign(new Event('error'), { error, message: error.message, filename: 'app.js', lineno: 3, colno: 7 });
    target.dispatchEvent(event);
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'отказ' }));

    expect(reportRendererError).toHaveBeenNthCalledWith(1, { kind: 'error', message: 'TypeError: нет свойства', stack: error.stack, source: 'app.js:3:7' });
    expect(reportRendererError).toHaveBeenNthCalledWith(2, { kind: 'unhandledrejection', message: 'отказ' });
  });

  it('уведомление об аварийном сеансе ссылается на «Журнал заданий»', () => {
    expect(linkSegments(CRASH_NOTICE).find((segment) => segment.target)?.target).toEqual({ path: '/jobs' });
  });
});
