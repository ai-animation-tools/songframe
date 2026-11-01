/** Проверки переноса сравнивают целые фразы и видимый SSR-текст с независимыми ожиданиями. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { componentsTexts } from '@shared/texts/components';
import type { JobInfo } from '@shared/types';
import { FileDropZone } from './FileDropZone';
import { JobCard } from './JobCard';
import { StateEditor } from './StateEditor';
import { ReadableValue } from './ReadableValue';

vi.mock('../state', () => ({ useApp: () => ({ notify: vi.fn(), describeError: String }) }));

// Стили и элементы не относятся к видимому тексту; сущности оставляем как есть для проверки экранирования.
const visibleText = (html: string): string => html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '').replace(/<[^>]*>/g, '');

const job: JobInfo = {
  id: 'component-texts',
  kind: 'regenerate',
  title: 'Повтор плана M<&>',
  status: 'failed',
  startedAt: '2026-10-29T10:00:00Z',
  finishedAt: null,
  log: '',
  code: 3,
  steps: [
    { tool: 'prepare', label: 'Подготовка & проверка', status: 'failed', code: 5 },
    { tool: 'send', label: 'Отправка', status: 'pending', code: null }
  ]
};

describe('Форматированные фразы общих компонентов', () => {
  it('сохраняет кавычки, пути, знаки и целую подпись', () => {
    expect(componentsTexts.stateEditor.removeProperty({ label: 'шлем «новый» & <visor>' })).toBe('Снять свойство «шлем «новый» & <visor>»');
    expect(componentsTexts.stateEditor.restoreProperty({ label: 'шлем' })).toBe('Вернуть унаследованное свойство шлем');
    expect(componentsTexts.stateEditor.inherited({ value: 'source/герои & шлем.png' })).toBe('унаследовано: source/герои & шлем.png');
    expect(componentsTexts.gallery.openLarge({ label: 'source/Олег & <1>.png' })).toBe('Открыть крупно: source/Олег & <1>.png');
    expect(componentsTexts.gallery.position({ kind: 'Опора «Олег»', position: 2, total: 5 })).toBe('Опора «Олег» · 2 / 5');
    expect(componentsTexts.shot.openPlan({ shot: 'M<&>', title: 'на странице «Производство»' })).toBe('Открыть план M<&> на странице «Производство»');
  });

  it('показывает коды ошибок и объясняет неизвестный исход без потери пробела после точки', () => {
    const failed = visibleText(renderToStaticMarkup(createElement(JobCard, { job })));
    expect(failed).toContain('код 3');
    expect(failed).toContain('Подготовка &amp; проверка: код 5');
    expect(failed).toContain('Журнал пуст.');
    const interrupted = visibleText(renderToStaticMarkup(createElement(JobCard, { job: { ...job, status: 'interrupted' } })));
    expect(interrupted).toContain(
      'Прервано закрытием или сбоем программы. Результат задания неизвестен: проверьте его на рабочей странице и при необходимости запустите заново.'
    );
  });

  it('сохраняет фразы наследования и безопасный вывод пользовательского состояния', () => {
    const inherited = renderToStaticMarkup(createElement(ReadableValue, { value: { scene: 'M<&>', phase: 'before' } }));
    expect(visibleText(inherited)).toBe('от плана M&lt;&amp;&gt;: состояние на первый кадр');
    const unknown = renderToStaticMarkup(createElement(ReadableValue, { value: { scene: 'M01', phase: 'неизвестный момент' } }));
    expect(visibleText(unknown)).toBe('от плана M01: неизвестный момент');
    const state = renderToStaticMarkup(createElement(ReadableValue, { value: { oleg: { helmet: null, mud: 'грязь & <script>' } } }));
    expect(visibleText(state)).toBe('oleg: helmet: снять; mud: грязь &amp; &lt;script&gt;');
    expect(state).not.toContain('<script>');
  });

  it('оставляет унаследованное значение и снятие свойства в редакторе с прежними доступными именами', () => {
    const html = renderToStaticMarkup(
      createElement(StateEditor, {
        properties: [
          { key: 'helmet', label: 'Шлем & визор' },
          { key: 'mud', label: 'Грязь' }
        ],
        value: { helmet: null },
        baseline: { helmet: 'надет', mud: 'по колено' },
        allowRemove: true,
        onChange: vi.fn()
      })
    );
    expect(html).toContain('aria-label="Вернуть унаследованное свойство Шлем &amp; визор"');
    expect(visibleText(html)).toContain('свойство будет снято');
    expect(visibleText(html)).toContain('унаследовано: по колено');
    expect(html).toContain('aria-label="Снять свойство «Грязь»"');
  });

  it.each([
    ['image', false, false, 'Перетащите изображение сюда. PNG, JPG, WebP.'],
    ['image', true, false, 'Перетащите изображения сюда. PNG, JPG, WebP.'],
    ['image', false, true, 'Перетащите изображение сюда или нажмите, чтобы выбрать файл. PNG, JPG, WebP.'],
    ['image', true, true, 'Перетащите изображения сюда или нажмите, чтобы выбрать файлы. PNG, JPG, WebP.'],
    ['audio', false, false, 'Перетащите MP3 сюда.'],
    ['audio', false, true, 'Перетащите MP3 сюда или нажмите, чтобы выбрать файл.'],
    ['text', false, false, 'Перетащите сюда TXT или MD.'],
    ['text', false, true, 'Перетащите сюда TXT или MD либо нажмите, чтобы выбрать файл.']
  ] as const)('сохраняет целую подсказку области загрузки %s (multiple=%s, pick=%s)', (kind, multiple, canPick, expected) => {
    const html = renderToStaticMarkup(
      createElement(FileDropZone, { kind, multiple, label: 'Загрузка', message: 'Файл', onFiles: vi.fn(), onPick: canPick ? vi.fn() : undefined })
    );
    // Явный пробел FileDropZone разделяет сообщение и подсказку в DOM и при доступном чтении; CSS-переноса для этого недостаточно.
    expect(visibleText(html)).toBe(`Файл ${expected}`);
  });
});
