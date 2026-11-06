/** Идущая операция заметна и закреплена; итог показывается обычным статусом. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { JobInfo } from '@shared/types';
import { ProductionOperationNotice } from './ProductionOperationNotice';

const render = (operation: Parameters<typeof ProductionOperationNotice>[0]['operation']): string =>
  renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ProductionOperationNotice, { operation, stickyTop: 72 })));
const job = (status: JobInfo['status']): JobInfo => ({ id: 'job', title: 'Приёмка M02', status }) as JobInfo;

describe('состояние операции попытки', () => {
  it('идущая приёмка называется и показывает полосу прогресса', () => {
    const html = render({ job: job('running') });
    expect(html).toContain('Приёмка M02');
    expect(html).toContain('role="status"');
    expect(html).toContain('MuiLinearProgress');
  });
  it('запуск до появления задания тоже заметен', () => {
    expect(render({ running: true, label: 'Запуск действия…' })).toContain('Запуск действия…');
  });
  it('без операции ничего не показывает', () => {
    expect(render({})).toBe('');
  });
  it('завершённая операция показывает итог без полосы', () => {
    const html = render({ job: job('done') });
    expect(html).toContain('Приёмка M02');
    expect(html).not.toContain('MuiLinearProgress');
  });
});
