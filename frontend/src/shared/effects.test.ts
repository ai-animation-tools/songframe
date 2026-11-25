import { describe, expect, it } from 'vitest';
import type { EffectParamSpec } from './types';
import {
  editableSteps,
  mergeSteps,
  roundToStep,
  sameSteps,
  shotLabel,
  stepValue,
  withValue,
  type EffectStep,
  planSeconds,
  fractionToSeconds,
  secondsToFraction,
  beamGeometry,
  dragSource,
  dragDirection,
  dragCone,
  dragRadius
} from './effects';

const density: EffectParamSpec = { name: 'density', title: 'Плотность', min: 0, max: 5000, default: 900, step: 10, hint: '' };

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

describe('точность и копирование параметров', () => {
  it('округляет значение до знаков шага без навязывания сетки', () => {
    expect(roundToStep(0.47 - 0.01, 0.01)).toBe(0.46);
    expect(roundToStep(0.305, 0.1)).toBe(0.3);
    expect(roundToStep(1234.6, 10)).toBe(1235);
    expect(roundToStep(0.123, 0.05)).toBe(0.12);
  });

  it('эффекты источника заменяют такие же, остальные эффекты черновика остаются по порядку реестра', () => {
    const draft: EffectStep[] = [
      { effect: 'light', given: { intensity: 15 } },
      { effect: 'rain', given: { density: 500 } }
    ];
    const source: EffectStep[] = [
      { effect: 'rain', given: { density: 2000 }, wind: { direction: 20, strength: 0.3 } },
      { effect: 'grain', given: {} }
    ];
    expect(mergeSteps(draft, source, ['light', 'rain', 'grain'])).toEqual([
      { effect: 'light', given: { intensity: 15 } },
      { effect: 'rain', given: { density: 2000 }, wind: { direction: 20, strength: 0.3 } },
      { effect: 'grain', given: {} }
    ]);
    expect(mergeSteps([], source, ['light', 'rain', 'grain'])).toEqual(source);
  });
});

describe('подпись плана', () => {
  it('номер со строкой песни, без строки — только номер', () => {
    expect(shotLabel({ shot: 'M01', title: 'Вступление' })).toBe('M01 · Вступление');
    expect(shotLabel({ shot: 'M02', title: '' })).toBe('M02');
  });
});

describe('моменты плана в секундах', () => {
  const shot = { frames: 101, fps: 25 };
  it('доля ↔ секунды по времени последнего кадра', () => {
    expect(planSeconds(shot)).toBe(4);
    expect(fractionToSeconds(0.45, shot)).toBe(1.8);
    expect(secondsToFraction(1.8, shot)).toBe(0.45);
  });
  it('секунды ставятся на ближайший кадр и в пределы плана', () => {
    expect(secondsToFraction(1.81, shot)).toBe(0.45);
    expect(secondsToFraction(-1, shot)).toBe(0);
    expect(secondsToFraction(99, shot)).toBe(1);
    expect(secondsToFraction(1, { frames: 1, fps: 25 })).toBe(0);
  });
});

describe('ручки луча', () => {
  const spec = (name: string, min: number, max: number, step: number) => ({ name, title: name, min, max, default: 0, step, hint: '' });
  const beam = { x: 'x', y: 'y', radius: 'r', direction: 'd', cone: 'c' };
  const values: Record<string, number> = { x: 0.5, y: 0.5, r: 0.5, d: 0, c: 60 };
  const geometry = beamGeometry(beam, (name) => values[name]);
  it('геометрия в пикселях полного кадра', () => {
    expect(geometry.x).toBe(960);
    expect(geometry.y).toBe(540);
    expect(geometry.half).toBeCloseTo(Math.PI / 6);
  });
  it('источник — доли кадра в пределах параметра', () => {
    expect(dragSource({ x: spec('x', -1, 2, 0.01), y: spec('y', -1, 2, 0.01) }, -288, 1620)).toEqual({ x: -0.15, y: 1.5 });
    expect(dragSource({ x: spec('x', -1, 2, 0.01), y: spec('y', -1, 2, 0.01) }, -5000, 0)).toEqual({ x: -1, y: 0 });
  });
  it('направление — против часовой от направления вправо, экранная ось y вниз', () => {
    expect(dragDirection(spec('d', 0, 360, 1), geometry, 960, 100)).toBe(90);
    expect(dragDirection(spec('d', 0, 360, 1), geometry, 960, 900)).toBe(270);
    expect(dragDirection(spec('d', 0, 360, 1), geometry, 100, 540)).toBe(180);
  });
  it('ширина — удвоенный угол от оси, дальность — расстояние в долях диагонали', () => {
    expect(dragCone(spec('c', 10, 360, 1), geometry, 1960, 540 - 1000)).toBe(90);
    expect(dragCone(spec('c', 10, 360, 1), geometry, 960, 540)).toBe(10);
    expect(dragCone(spec('c', 10, 360, 1), geometry, 0, 540)).toBe(360);
    expect(dragRadius(spec('r', 0.1, 3, 0.01), geometry, 960 + Math.hypot(1920, 1080), 540)).toBe(1);
  });
});
