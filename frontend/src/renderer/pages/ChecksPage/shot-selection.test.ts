import { describe, expect, it } from 'vitest';
import { selectShot } from './shot-selection';

// Порядок задаёт сценарий: дробные номера и пропуски не превращаются в числовой диапазон.
const order = ['M22', 'M23', 'M23.5', 'M24', 'M26', 'M28'];

describe('выбор сцен для пробы стыков', () => {
  it('переключает отдельные сцены и возвращает их в порядке сценария', () => {
    const selected = selectShot({ selected: ['M28'], anchor: 'M28' }, order, 'M23.5', false);
    expect(selected).toEqual({ selected: ['M23.5', 'M28'], anchor: 'M23.5' });
    expect(selectShot(selected, order, 'M23.5', false)).toEqual({ selected: ['M28'], anchor: 'M23.5' });
  });

  it('добавляет диапазон с дробным номером, сохраняя ранее выбранные сцены', () => {
    const start = selectShot({ selected: ['M28'], anchor: 'M28' }, order, 'M23', false);
    expect(selectShot(start, order, 'M26', true)).toEqual({ selected: ['M23', 'M23.5', 'M24', 'M26', 'M28'], anchor: 'M23' });
  });

  it('выделяет диапазон назад и сохраняет начало для следующего Shift', () => {
    const selection = { selected: ['M26'], anchor: 'M26' };
    const backward = selectShot(selection, order, 'M23.5', true);
    expect(backward).toEqual({ selected: ['M23.5', 'M24', 'M26'], anchor: 'M26' });
    expect(selectShot(backward, order, 'M28', true)).toEqual({ selected: ['M23.5', 'M24', 'M26', 'M28'], anchor: 'M26' });
  });

  it('начинает новый выбор с Shift, если начало отсутствует или удалено', () => {
    for (const anchor of [null, 'M00']) {
      expect(selectShot({ selected: [], anchor }, order, 'M24', true)).toEqual({ selected: ['M24'], anchor: 'M24' });
    }
  });

  it('не меняет выбор для неизвестной сцены и убирает удалённые сцены при следующем выборе', () => {
    const selection = { selected: ['M00', 'M24'], anchor: 'M24' };
    expect(selectShot(selection, order, 'M00', true)).toBe(selection);
    expect(selectShot(selection, order, 'M26', true)).toEqual({ selected: ['M24', 'M26'], anchor: 'M24' });
  });
});
