/** Сообщение у действия показывает исход задания без раскрытия журнала и без запуска браузера. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { JobInfo } from '@shared/types';
import { JobStatus } from './JobStatus';

function job(overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    id: 'repeat-m44',
    kind: 'regenerate',
    title: 'Подготовка повтора M44',
    status: 'running',
    startedAt: '2026-10-27T10:00:00Z',
    finishedAt: null,
    log: 'Служебный полный журнал не должен появляться в сообщении',
    code: null,
    steps: [],
    ...overrides
  };
}

const render = (props: Parameters<typeof JobStatus>[0] = {}): string =>
  renderToStaticMarkup(createElement(MemoryRouter, null, createElement(JobStatus, props)));

describe('Результат операции у действия', () => {
  it('не показывает пустую панель без операции', () => {
    expect(render()).toBe('');
  });

  it('показывает ожидание ответа IPC до получения задания', () => {
    const html = render({ running: true, label: 'Подготовка повтора M44' });
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('Подготовка повтора M44');
  });

  it('показывает выполняющееся задание без содержимого журнала', () => {
    const html = render({ job: job() });
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('Подготовка повтора M44');
    expect(html).not.toContain('Служебный полный журнал');
  });

  it('показывает причину M44 сразу и оставляет отдельную ссылку на журнал', () => {
    const html = render({ job: job({ status: 'failed', code: 3, error: "M44: провайдер снимка 'gptunnel'; для повтора требуется Kling." }) });
    expect(html).toContain('role="alert"');
    expect(html).toContain('gptunnel');
    expect(html).toContain('для повтора требуется Kling.');
    expect(html).toContain('href="/jobs"');
    expect(html).toContain('Открыть журнал');
    expect(html).not.toContain('Служебный полный журнал');
    expect(html).not.toContain('role="progressbar"');
  });

  it('показывает успешное завершение вместо индикатора выполнения', () => {
    const html = render({ job: job({ status: 'done', code: 0 }) });
    expect(html).toContain('Подготовка повтора M44: выполнено.');
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain('Открыть журнал');
  });

  it('показывает ошибку IPC без созданного задания', () => {
    const html = render({ error: 'Папка проекта недоступна.' });
    expect(html).toContain('Действие не выполнено');
    expect(html).toContain('Папка проекта недоступна.');
    expect(html).not.toContain('кодом undefined');
  });

  it('объясняет код завершения, если инструмент не сообщил причину', () => {
    expect(render({ job: job({ status: 'failed', code: 3 }) })).toContain('Задание завершилось с кодом 3.');
  });
});
