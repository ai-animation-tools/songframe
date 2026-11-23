import { describe, expect, it } from 'vitest';
import type { EffectParamSpec } from './types';
import { editableSteps, sameSteps, shotLabel, stepValue, withValue } from './effects';

const density: EffectParamSpec = { name: 'density', title: 'Плотность', min: 0, max: 5000, default: 900, step: 10 };

describe('черновик эффектов', () => {
  it('хранит только изменённые значения', () => {
    const step = withValue({ effect: 'rain', given: {} }, density, 1200);
    expect(step.given).toEqual({ density: 1200 });
    expect(stepValue(step, density)).toBe(1200);
    // Возврат к значению по умолчанию убирает его из рецепта.
    expect(withValue(step, density, 900).given).toEqual({});
    expect(stepValue({ effect: 'rain', given: {} }, density)).toBe(900);
  });

  it('для правки берёт заданное человеком, без полных значений Go', () => {
    const steps = editableSteps([
      { effect: 'rain', given: { density: 1200 }, wind: { direction: 20, strength: 0.5 }, version: 1, params: { density: 1200, angle: 9.5 } },
      { effect: 'grain', given: {}, wind: null, version: 1, params: { amount: 0.025 } }
    ]);
    expect(steps).toEqual([
      { effect: 'rain', given: { density: 1200 }, wind: { direction: 20, strength: 0.5 } },
      { effect: 'grain', given: {} }
    ]);
  });

  it('сравнивает цепочки без учёта порядка ключей и пустого ветра', () => {
    expect(sameSteps([{ effect: 'rain', given: { a: 1, b: 2 } }], [{ effect: 'rain', given: { b: 2, a: 1 }, wind: null }])).toBe(true);
    expect(sameSteps([{ effect: 'rain', given: {} }], [{ effect: 'rain', given: {}, wind: { direction: 0, strength: 0.4 } }])).toBe(false);
    expect(sameSteps([], [{ effect: 'grain', given: {} }])).toBe(false);
  });
});

describe('подпись плана', () => {
  it('номер со строкой песни, без строки — только номер', () => {
    expect(shotLabel({ shot: 'M01', title: 'Вступление' })).toBe('M01 · Вступление');
    expect(shotLabel({ shot: 'M02', title: '' })).toBe('M02');
  });
});
