/** Значения сравнения читаются без markdown и JSON: заголовки, списки, состояние и наследование словами. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReadableValue } from './ReadableValue';
import { ScenarioComparison } from '../pages/ScenarioPage/components/ScenarioComparison';

// Стили emotion содержат фигурные скобки и имена классов: проверяем только разметку.
const strip = (html: string): string => html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
const render = (value: unknown): string => strip(renderToStaticMarkup(createElement(ReadableValue, { value })));

describe('человекочитаемые значения сравнения', () => {
  it('убирает разметку markdown: заголовки, жирный текст, ссылки и списки', () => {
    const html = render('# Правила\n\nФормат **16:9**, ориентир [Паша](../source/pasha.jpg).\n\n- осень\n- без дождя');
    expect(html).toContain('Правила');
    expect(html).not.toContain('# Правила');
    expect(html).toContain('<b>16:9</b>');
    expect(html).toContain('Паша');
    expect(html).not.toContain('../source/pasha.jpg');
    expect(html).toContain('<li');
    expect(html).not.toContain('- осень');
    const checklist = render('Проверить:\n- [ ] шлем надет\n- [x] грязь на куртке');
    expect(checklist).toContain('шлем надет');
    expect(checklist).not.toContain('[ ]');
  });

  it('показывает наследование состояния фразой, а изменения состояния по сущностям', () => {
    expect(render({ scene: 'M13', phase: 'same' })).toContain('от плана M13: то же состояние');
    const html = render({ before: { pasha: { mud: 'по колено', helmet: null } } });
    expect(html).toContain('На первый кадр');
    expect(html).toContain('<b>pasha:</b>');
    expect(html).toContain('mud: по колено; helmet: снять');
    expect(html).not.toContain('{');
  });

  it('перечисляет примитивы чипами, а объекты парами с русскими подписями', () => {
    expect(render(['pasha', 'oleg'])).toContain('MuiChip');
    const html = render([{ id: 'intro', title: 'Вступление', direction: 'Едут', entities: ['pasha'] }]);
    expect(html).toContain('Код:');
    expect(html).toContain('Действие:');
    expect(html).toContain('Участники:');
    expect(html).not.toContain('&quot;');
  });

  it('блок сравнения считает изменённые поля и сворачивается, когда их нет', () => {
    const changed = strip(
      renderToStaticMarkup(
        createElement(ScenarioComparison, {
          title: 'План M01',
          fields: [
            { label: 'Камера', before: 'статика', after: 'наезд' },
            { label: 'Действие', before: 'а', after: 'а' }
          ]
        })
      )
    );
    expect(changed).toContain('изменено: Камера');
    expect(changed).toContain('aria-expanded="true"');
    const unchanged = strip(
      renderToStaticMarkup(createElement(ScenarioComparison, { title: 'План M02', fields: [{ label: 'Камера', before: 'а', after: 'а' }] }))
    );
    expect(unchanged).toContain('без изменений');
    expect(unchanged).toContain('aria-expanded="false"');
  });
});
