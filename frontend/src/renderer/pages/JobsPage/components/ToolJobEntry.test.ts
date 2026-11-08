/** Запись журнала показывает прерванное задание прошлого сеанса и действие копирования без запуска окна. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JOB_INTERRUPTED_MESSAGE, type JobInfo } from '@shared/types';
import { ToolJobEntry } from './ToolJobEntry';

function job(overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    id: 'mh1-1',
    kind: 'submit',
    title: 'Отправка M12',
    status: 'done',
    startedAt: '2026-10-28T08:20:30Z',
    finishedAt: '2026-10-28T08:25:00Z',
    log: '$ отправка\nготово',
    code: 0,
    steps: [{ label: 'отправка', tool: 'media_request', status: 'done', code: 0 }],
    ...overrides
  };
}

const render = (value: JobInfo): string => renderToStaticMarkup(createElement(ToolJobEntry, { job: value, onCopy: () => undefined }));

describe('Запись задания в журнале', () => {
  it('показывает прерванное задание прошлого сеанса с датой и причиной', () => {
    const html = render(job({ status: 'interrupted', code: null, previousSession: true, log: '', error: JOB_INTERRUPTED_MESSAGE }));
    expect(html).toContain('прервано');
    expect(html).toContain('Прошлый сеанс');
    expect(html).toContain(JOB_INTERRUPTED_MESSAGE);
    expect(html).toContain('dateTime="2026-10-28T08:20:30.000Z"');
    expect(html).not.toContain('role="progressbar"');
  });

  it('у каждой записи есть кнопка «Скопировать журнал»', () => {
    const html = render(job());
    expect(html).toContain('Скопировать журнал');
    expect(html).toContain('без ошибок');
    expect(html).not.toContain('Прошлый сеанс');
    expect(html).not.toContain(JOB_INTERRUPTED_MESSAGE);
  });
});
