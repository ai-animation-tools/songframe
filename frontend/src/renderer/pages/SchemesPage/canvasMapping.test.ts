import { describe, expect, it } from 'vitest';
import { fitViewport, formatMetres, gridStep, horizontalSign, snap, toScreen, toWorld, type Viewport } from './canvasMapping';

const viewport: Viewport = { center: [10, 20], scale: 5, width: 400, height: 300 };

describe('пересчёт координат холста', () => {
  it('вид сверху: восток вправо, север вверх', () => {
    expect(toScreen([10, 20], viewport, 'top')).toEqual([200, 150]);
    expect(toScreen([12, 20], viewport, 'top')).toEqual([210, 150]);
    expect(toScreen([10, 22], viewport, 'top')).toEqual([200, 140]);
  });

  it('виды сбоку разворачивают горизонталь как у стоящего наблюдателя', () => {
    expect(horizontalSign('south')).toBe(1);
    expect(horizontalSign('east')).toBe(1);
    expect(horizontalSign('north')).toBe(-1);
    expect(horizontalSign('west')).toBe(-1);
    // С запада север слева: большая координата Y мира — левее центра.
    expect(toScreen([12, 20], viewport, 'west')[0]).toBe(190);
  });

  it('обратный пересчёт возвращает исходную точку на всех видах', () => {
    for (const view of ['top', 'north', 'east', 'south', 'west'] as const) {
      const back = toWorld(toScreen([3.5, -7.25], viewport, view), viewport, view);
      expect(back[0]).toBeCloseTo(3.5, 9);
      expect(back[1]).toBeCloseTo(-7.25, 9);
    }
  });

  it('вписывает рамку и выбирает шаг сетки', () => {
    const fitted = fitViewport([0, 0, 100, 20], 1000, 500);
    expect(fitted.center).toEqual([50, 10]);
    expect(fitted.scale).toBeCloseTo(8.5, 9);
    expect(fitViewport(null, 800, 600)).toMatchObject({ center: [0, 0], scale: 10 });
    expect(gridStep(20)).toBe(1);
    expect(gridStep(5)).toBe(5);
    expect(gridStep(200)).toBe(0.1);
    expect(snap(3.14159, 0.1)).toBe(3.1);
    expect(snap(28.7, 5)).toBe(30);
    expect(snap(1.19, 0.1)).toBe(1.2);
    expect(snap(0.61, 0.05)).toBe(0.6);
    expect(snap(-0.4, 1)).toBe(0);
    expect(Object.is(snap(-0.4, 1), 0)).toBe(true);
    expect(formatMetres(0.6)).toBe('0,6');
    expect(formatMetres(12)).toBe('12');
  });
});
