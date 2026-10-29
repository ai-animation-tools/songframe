/** Словарь свойств: проверка кода, перестановка, очистка перед сохранением и признак правок. */
import { describe, expect, it } from 'vitest';
import type { CastEntity } from '@shared/types';
import { cleanProperties, dictionaryKinds, dictionaryProblem, moveItem, patchProperty, propertyKeyProblem, propertyUsage, propertyValues } from './properties';

const entity = (id: string, kind: string, initial_state: Record<string, string> = {}): CastEntity => ({
  id,
  kind,
  name: id,
  short_name: id,
  role: '',
  appearance: '',
  images: [],
  initial_state
});

describe('propertyKeyProblem', () => {
  it('требует код латиницей и запрещает дубль', () => {
    expect(propertyKeyProblem('', [])).toBe('Введите код свойства.');
    expect(propertyKeyProblem('Helmet', [])).toMatch(/строчной латинской/);
    expect(propertyKeyProblem('1st', [])).toMatch(/строчной латинской/);
    expect(propertyKeyProblem('шлем', [])).toMatch(/строчной латинской/);
    expect(propertyKeyProblem('helmet', ['helmet'])).toMatch(/уже есть/);
    expect(propertyKeyProblem('helmet_2', ['helmet'])).toBeNull();
  });
});

describe('moveItem', () => {
  it('переставляет на соседнюю позицию и не выходит за границы', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });
});

describe('patchProperty', () => {
  it('убирает очищенные необязательные поля и сохраняет порядок полей', () => {
    const saved = { key: 'contact', label: 'Опора', hint: 'На чём стоит', values: ['пол'], checklist: 'Опора: {value}?' };
    expect(patchProperty(saved, { hint: '', values: [], checklist: '' })).toEqual({ key: 'contact', label: 'Опора' });
    // Возврат прежнего значения совпадает с сохранённым и по сериализации: признак правок гаснет.
    const restored = patchProperty(patchProperty(saved, { hint: '' }), { hint: 'На чём стоит' });
    expect(JSON.stringify(restored)).toBe(JSON.stringify(saved));
  });
});

describe('cleanProperties', () => {
  it('обрезает пробелы, убирает пустые и повторные варианты', () => {
    expect(
      cleanProperties({ character: [{ key: 'pose', label: ' Поза ', hint: '  ', values: [' сидит', 'сидит', ''], checklist: ' Поза: {value}? ' }] })
    ).toEqual({
      character: [{ key: 'pose', label: 'Поза', values: ['сидит'], checklist: 'Поза: {value}?' }]
    });
    expect(propertyValues([' a ', 'a', '', 'b'])).toEqual(['a', 'b']);
  });
});

describe('dictionaryProblem', () => {
  const label = (kind: string): string => (kind === 'character' ? 'Персонаж' : kind);
  it('называет тип и свойство с ошибкой', () => {
    expect(dictionaryProblem({ character: [{ key: 'pose', label: 'Поза' }] }, label)).toBeNull();
    expect(dictionaryProblem({ character: [{ key: 'pose', label: ' ' }] }, label)).toMatch(/тип «Персонаж».*pose нет подписи/);
    expect(
      dictionaryProblem(
        {
          character: [
            { key: 'pose', label: 'Поза' },
            { key: 'pose', label: 'Поза 2' }
          ]
        },
        label
      )
    ).toMatch(/«Поза».*уже есть/);
    expect(dictionaryProblem({ character: [{ key: 'Pose', label: 'Поза' }] }, label)).toMatch(/строчной латинской/);
  });
});

describe('dictionaryKinds и propertyUsage', () => {
  it('ставит типы страницы первыми и добавляет прочие из словаря и сущностей', () => {
    const entities = [entity('hero', 'character', { pose: 'сидит' }), entity('boat', 'boat'), entity('world', 'world')];
    expect(dictionaryKinds(['character', 'vehicle', 'world'], { character: [], world: [], prop: [] }, entities)).toEqual([
      'character',
      'world',
      'prop',
      'boat'
    ]);
    expect(propertyUsage(entities, 'character', 'pose')).toBe(1);
    expect(propertyUsage(entities, 'boat', 'pose')).toBe(0);
  });
});
