/** Полные фразы и SSR фиксируют прежний текст кастинга без зависимости ожиданий от словаря. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { castTexts } from '@shared/texts/cast';
import { LinkedText } from '../../components/LinkedText';
import { CastPropertyAddForm } from './components/CastPropertyAddForm';
import { CastToolbar } from './components/CastToolbar';
import { CastEmptyState } from './components/CastEmptyState';
import { dictionaryProblem } from './properties';

const removal =
  'Свойство исчезнет из словаря типа «Персонаж»: в редакторах состояния пропадут его подпись, подсказка, варианты и пункт проверки. Уже записанные значения в начальном состоянии сущностей и изменениях состояния планов не удаляются и останутся под кодом pose как свои свойства без подписи.';

describe('целые фразы кастинга', () => {
  it.each([
    [0, '0', ''],
    [1, '1', ' Сейчас значение записано в начальном состоянии у 1 сущности этого типа.'],
    [2, '2', ' Сейчас значение записано в начальном состоянии у 2 сущностей этого типа.'],
    [5, '5', ' Сейчас значение записано в начальном состоянии у 5 сущностей этого типа.'],
    [11, '11', ' Сейчас значение записано в начальном состоянии у 11 сущностей этого типа.'],
    [21, '21', ' Сейчас значение записано в начальном состоянии у 21 сущности этого типа.'],
    [-2, '-2', ' Сейчас значение записано в начальном состоянии у -2 сущностей этого типа.'],
    [1.5, '1.5', ' Сейчас значение записано в начальном состоянии у 1.5 сущностей этого типа.']
  ] as const)('сохраняет исходную грамматику количества %s', (count, written, suffix) => {
    expect(castTexts.removePropertyDescription({ kind: 'Персонаж', key: 'pose', usage: count })).toBe(removal + suffix);
    expect(castTexts.stateCount({ count })).toBe(`состояние: ${written}`);
    expect(castTexts.valuesCount({ count })).toBe(`вариантов: ${written}`);
    expect(castTexts.dictionaryCount({ kind: 'Персонаж', count })).toBe(`Персонаж · ${written}`);
  });

  it('сохраняет имена, кавычки, маркеры и полные причины ошибок', () => {
    expect(castTexts.removeImage({ name: 'C:\\Клип\\«А» <img>&.png' })).toBe('Убрать изображение «C:\\Клип\\«А» <img>&.png»');
    expect(castTexts.removeEntity({ name: '«Герой» <script>&' })).toBe('Удалить сущность ««Герой» <script>&»');
    expect(castTexts.movePropertyUp({ name: 'Опора «А»' })).toBe('Поднять свойство «Опора «А»»');
    expect(castTexts.movePropertyDown({ name: 'Опора «А»' })).toBe('Опустить свойство «Опора «А»»');
    expect(castTexts.collapseProperty({ name: 'Опора «А»' })).toBe('Свернуть свойство «Опора «А»»');
    expect(castTexts.editProperty({ name: 'Опора «А»' })).toBe('Изменить свойство «Опора «А»»');
    expect(castTexts.removeProperty({ name: 'Опора «А»' })).toBe('Удалить свойство «Опора «А»»');
    expect(castTexts.checklistHelp({ withoutValue: false })).toBe(
      'Пункт «что сверить» во врезке непрерывности: {value} заменяется значением состояния. Пусто — пункта нет.'
    );
    expect(castTexts.checklistHelp({ withoutValue: true })).toBe(
      'Пункт «что сверить» во врезке непрерывности: {value} заменяется значением состояния. Пусто — пункта нет. В шаблоне нет {value}: пункт выйдет без записанного значения.'
    );
    expect(dictionaryProblem({ character: [{ key: '', label: '' }] }, () => 'Персонаж')).toBe(
      'Словарь свойств, тип «Персонаж», свойство «без кода»: Введите код свойства.'
    );
    expect(dictionaryProblem({ character: [{ key: 'pose', label: '' }] }, () => 'Персонаж')).toBe(
      'Словарь свойств, тип «Персонаж»: у свойства pose нет подписи. Введите её.'
    );
    expect(castTexts.noDictionary({ kind: 'Новый тип' })).toBe('Новый тип · нет словаря');
  });
});

describe('текст форм кастинга', () => {
  it('при ошибке чтения объясняет восстановление и не показывает подсказку первого запуска', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CastEmptyState, { hasReadProblem: true })));
    const text = html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '').replace(/<[^>]*>/g, '');
    expect(text).toBe(
      'Сохранённый кастинг не удалось загрузить. Восстановите plan/cast.json из копии и заново откройте страницу. Создание кастинга из исходников заменит повреждённый файл и не восстановит его ручные правки.'
    );
    expect(text).not.toContain('Кастинга пока нет.');
  });

  it('для первого запуска сохраняет подсказку создания и ссылку на сценарий', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CastEmptyState, { hasReadProblem: false })));
    expect(html).toContain('Кастинга пока нет.');
    expect(html).toContain('href="/project/scenario"');
    expect(html).not.toContain('Сохранённый кастинг не удалось загрузить.');
  });

  it('сохраняет подписи, примеры и причину недоступности пустой формы', () => {
    const html = renderToStaticMarkup(createElement(CastPropertyAddForm, { existingKeys: [], onAdd: vi.fn() }));
    for (const text of [
      'Код нового свойства',
      'Подпись',
      'placeholder="например, helmet"',
      'placeholder="например, Шлем"',
      'Добавить свойство',
      'Введите код свойства.'
    ])
      expect(html).toContain(text);
    expect(html).toContain('Латиницей: a–z, цифры и «_». Под ним значение хранится в состоянии сущностей и планов; после сохранения не меняется.');
  });

  it('сохраняет действия и причины недоступности в панели', () => {
    const html = renderToStaticMarkup(
      createElement(CastToolbar, { busy: false, dirty: false, saveBlockedReason: null, hasManifest: false, hasCast: false, onInit: vi.fn(), onSave: vi.fn() })
    );
    for (const text of ['Кастинг', 'Создать из исходников', 'Сначала загрузите исходники.', 'Сохранить', 'Нет изменений для сохранения.'])
      expect(html).toContain(text);
  });

  it('оставляет исходники и сценарий ссылками с прежними маршрутами', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(LinkedText, { text: castTexts.empty })));
    expect(html).toContain('href="/project/scenario"');
    const sources = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(LinkedText, { text: castTexts.sourcesMissing })));
    expect(sources).toContain('href="/project/sources"');
    expect(sources.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '').replace(/<[^>]*>/g, '')).toBe(
      'Исходников ещё нет: загрузите референсы на странице «Исходники», затем создайте кастинг.'
    );
  });
});
