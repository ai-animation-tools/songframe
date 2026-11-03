/** Проверяем границу между каталогом, локальной формой и сохраняемыми изменениями состояния. */
import { describe, expect, it } from 'vitest';
import { stateFieldRows, patchStateField } from './stateFields';

const properties = [
  { key: 'coat', label: 'Куртка', checklist: 'Куртка: {value}?' },
  { key: 'pose', label: 'Поза' }
];
describe('поля отдельного состояния', () => {
  it('не превращает каталог в обязательную анкету и не записывает выбор пустого поля', () => {
    const value = {};
    expect(stateFieldRows(properties, value, {}, [])).toEqual([]);
    expect(stateFieldRows(properties, value, {}, ['pose'])).toEqual([properties[1]]);
    expect(value).toEqual({});
  });
  it('сохраняет словарные метаданные, произвольные прежние ключи, baseline и явный null', () => {
    expect(
      stateFieldRows(properties, { coat: null, old_key: 'шрам' }, { pose: 'сидит', old_key: 'прежний шрам' }, ['coat', 'new_key']).map((row) => row.key)
    ).toEqual(['coat', 'pose', 'old_key', 'new_key']);
    expect(stateFieldRows(properties, { coat: 'синяя' }, {}, [])[0].checklist).toBe('Куртка: {value}?');
  });
  it('отмена изменения и снятие свойства дают разные дельты без мутации соседних значений', () => {
    const original = { coat: 'мокрая', pose: 'стоит' };
    expect(patchStateField(original, 'coat', undefined)).toEqual({ pose: 'стоит' });
    expect(patchStateField(original, 'coat', null)).toEqual({ coat: null, pose: 'стоит' });
    expect(patchStateField(original, 'coat', '')).toEqual({ pose: 'стоит' });
    expect(original).toEqual({ coat: 'мокрая', pose: 'стоит' });
  });
  it('удаление определения сохраняет значение своим ключом, пустой словарь не восстанавливается', () => {
    expect(stateFieldRows([], { coat: 'синяя' }, {}, [])).toEqual([{ key: 'coat', label: 'coat' }]);
    expect(stateFieldRows([], {}, {}, [])).toEqual([]);
  });
});
