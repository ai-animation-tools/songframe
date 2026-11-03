/** Пустой фильтр оформлен как пустая очередь: заголовок с числом, пояснение и возврат к полному списку. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PackageView, ShotProduction } from '@shared/types';
import { ProductionShotList } from './ProductionShotList';

describe('пустой список планов', () => {
  it('объясняет фильтр и предлагает показать все планы', () => {
    const html = renderToStaticMarkup(
      createElement(ProductionShotList, { shots: [], selected: null, onSelect: vi.fn(), filter: 'attention', onResetFilter: vi.fn() })
    );
    expect(html).toContain('Ждут вашего действия (0)');
    expect(html).toContain('Ни один пакет не ждёт вашего действия');
    expect(html).toContain('Показать все планы');
  });

  it('без фильтра говорит, что планов нет, и не предлагает сброс', () => {
    const html = renderToStaticMarkup(
      createElement(ProductionShotList, { shots: [], selected: null, onSelect: vi.fn(), filter: 'all', onResetFilter: vi.fn() })
    );
    expect(html).toContain('Все планы (0)');
    expect(html).not.toContain('Показать все планы');
  });
});

describe('сетка карточек планов', () => {
  it('показывает карточку с состоянием, интервалом и ожидающим действием', () => {
    vi.stubGlobal('window', { api: { shell: { fileUrl: (path: string) => `songframe-file://${path}` } } });
    const shot: ShotProduction = {
      id: 'M45',
      title: 'Олег у окна',
      original: '',
      start: 61,
      end: 66.5,
      lipsync: true,
      state: 'progress',
      stageLabel: 'результат получен',
      regenerateProblem: null,
      derivedFrom: null,
      attention: 'вопрос о результате',
      asset: null,
      packages: [
        {
          dir: '/p',
          relative: 'batches/M45-attempt-01',
          shot: 'M45',
          stage: 'downloaded',
          stageLabel: '',
          waitReason: null,
          mode: null,
          retryOf: null,
          batch: null,
          timing: null,
          keyframes: [{ id: 'f1', role: 'first', time_seconds: 0, imagePath: '/f1.png', approved: true }],
          description: null,
          prompt: null,
          request: null
        } as unknown as PackageView
      ]
    };
    const html = renderToStaticMarkup(
      createElement(ProductionShotList, { shots: [shot], selected: 'M45', onSelect: vi.fn(), filter: 'all', withDetails: true })
    ).replace(/<style[^>]*>[^<]*<\/style>/g, '');
    vi.unstubAllGlobals();
    expect(html).toContain('M45');
    expect(html).toContain('в работе');
    expect(html).toContain('1:01.00–1:06.50');
    expect(html).toContain('речь');
    expect(html).toContain('songframe-file:///f1.png');
    expect(html).toContain('ждёт вас: вопрос о результате');
    expect(html).toContain('Олег у окна');
  });
});
