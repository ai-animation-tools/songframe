import { describe, expect, it } from 'vitest';
import type { SchemeObject, SchemeShape } from './schemes';
import { objectTopHeight, objectVolume, triangleNormal, triangulate, type Triangle, type Vec3 } from './scheme-volume';

const object = (shape: SchemeShape, extra: Partial<SchemeObject> = {}): SchemeObject => ({ id: 'o', name: 'Объект', shape, ...extra });
const rect = (rotation = 0): SchemeShape => ({ type: 'rect', center: [10, 20], size: [6, 8], rotation });

/** Рамка всех вершин: [min, max] по каждой оси. */
function bounds(triangles: Triangle[]): [Vec3, Vec3] {
  const points = triangles.flat();
  const min = [0, 1, 2].map((axis) => Math.min(...points.map((p) => p[axis]))) as Vec3;
  const max = [0, 1, 2].map((axis) => Math.max(...points.map((p) => p[axis]))) as Vec3;
  return [min, max];
}

/** Каждая грань выпуклого тела смотрит от его центра. */
function expectOutward(triangles: Triangle[]): void {
  const [min, max] = bounds(triangles);
  const center = [0, 1, 2].map((axis) => (min[axis] + max[axis]) / 2);
  for (const triangle of triangles) {
    const normal = triangleNormal(triangle);
    const mid = [0, 1, 2].map((axis) => (triangle[0][axis] + triangle[1][axis] + triangle[2][axis]) / 3);
    const dot = normal.reduce((sum, value, axis) => sum + value * (mid[axis] - center[axis]), 0);
    expect(dot, `грань ${JSON.stringify(triangle)}`).toBeGreaterThan(-1e-9);
  }
}

describe('объём объектов схемы', () => {
  it('призма прямоугольника: стенки, верх, без низа на земле', () => {
    const triangles = objectVolume(object(rect(), { height: 3 }));
    expect(triangles).toHaveLength(4 * 2 + 2);
    expect(bounds(triangles)).toEqual([
      [7, 16, 0],
      [13, 24, 3]
    ]);
    expectOutward(triangles);
  });

  it('гребень вдоль x: конёк посередине по y на высоте тела плюс подъём, фронтоны на концах x', () => {
    const triangles = objectVolume(object(rect(), { height: 3, top: { form: 'ridge', rise: 3, axis: 'x' } }));
    const peak = triangles.flat().filter((p) => Math.abs(p[2] - 6) < 1e-9);
    expect(new Set(peak.map((p) => p[1].toFixed(6)))).toEqual(new Set(['20.000000']));
    expect(Math.min(...peak.map((p) => p[0]))).toBeCloseTo(7);
    expect(Math.max(...peak.map((p) => p[0]))).toBeCloseTo(13);
    expectOutward(triangles);
  });

  it('гребень вдоль y и поворот фигуры поворачивают конёк вместе с ней', () => {
    const along = objectVolume(object(rect(), { height: 3, top: { form: 'ridge', rise: 2, axis: 'y' } }));
    const peak = along.flat().filter((p) => Math.abs(p[2] - 5) < 1e-9);
    expect(new Set(peak.map((p) => p[0].toFixed(6)))).toEqual(new Set(['10.000000']));
    const turned = objectVolume(object(rect(90), { height: 3, top: { form: 'ridge', rise: 2, axis: 'x' } }));
    const turnedPeak = turned.flat().filter((p) => Math.abs(p[2] - 5) < 1e-9);
    // Повёрнутый на 90° прямоугольник: его ось x смотрит на север, конёк идёт вдоль Y через центр.
    expect(new Set(turnedPeak.map((p) => p[0].toFixed(6)))).toEqual(new Set(['10.000000']));
    expectOutward(turned);
  });

  it('скат к −y: низкий край у южной стороны, высокий — у северной', () => {
    const triangles = objectVolume(object(rect(), { height: 2, top: { form: 'slope', rise: 1, down: '-y' } }));
    const high = triangles.flat().filter((p) => Math.abs(p[2] - 3) < 1e-9);
    expect(high.every((p) => Math.abs(p[1] - 24) < 1e-9)).toBe(true);
    expectOutward(triangles);
    const east = objectVolume(object(rect(), { height: 2, top: { form: 'slope', rise: 1, down: '+x' } }));
    expect(
      east
        .flat()
        .filter((p) => Math.abs(p[2] - 3) < 1e-9)
        .every((p) => Math.abs(p[0] - 7) < 1e-9)
    ).toBe(true);
  });

  it('шатёр от земли без тела и конус над эллипсом', () => {
    const tent = objectVolume(object(rect(), { top: { form: 'tent', rise: 2 } }));
    expect(tent).toHaveLength(4);
    expect(tent.every((triangle) => triangle[2][0] === 10 && triangle[2][1] === 20 && triangle[2][2] === 2)).toBe(true);
    expectOutward(tent);
    const cone = objectVolume(object({ type: 'ellipse', center: [0, 0], radii: [1, 1] }, { height: 1, top: { form: 'tent', rise: 1 } }));
    expect(bounds(cone)[1][2]).toBeCloseTo(2);
    expectOutward(cone);
  });

  it('эллипсоид кроны над землёй вписан в радиусы и высоту', () => {
    const crown = objectVolume(object({ type: 'ellipse', center: [-8, 5], radii: [2, 1.5] }, { height: 4, elevation: 2, body: 'ellipsoid' }));
    const [min, max] = bounds(crown);
    expect(min[2]).toBeCloseTo(2);
    expect(max[2]).toBeCloseTo(6);
    expect(max[0] - min[0]).toBeCloseTo(4);
    expect(max[1] - min[1]).toBeCloseTo(3, 1);
    expectOutward(crown);
    expect(crown.every((triangle) => Math.hypot(...triangleNormal(triangle)) > 0.99)).toBe(true);
  });

  it('поднятое тело получает низ, плоская поверхность — один слой лицом вверх', () => {
    const awning = objectVolume(object(rect(), { height: 0.2, elevation: 2.5 }));
    expect(awning.some((triangle) => triangleNormal(triangle)[2] < -0.99)).toBe(true);
    const road = objectVolume(object(rect()));
    expect(road).toHaveLength(2);
    expect(road.every((triangle) => triangleNormal(triangle)[2] > 0.99 && triangle.every((p) => p[2] === 0))).toBe(true);
  });

  it('забор — двусторонняя стенка, полоса с шириной — плоская дорога, точка с высотой — столб', () => {
    const fence = objectVolume(
      object(
        {
          type: 'line',
          points: [
            [0, 0],
            [10, 0],
            [10, 5]
          ]
        },
        { height: 1.8 }
      )
    );
    expect(fence).toHaveLength(8);
    expect(bounds(fence)[1][2]).toBe(1.8);
    const road = objectVolume(
      object({
        type: 'line',
        points: [
          [0, 0],
          [10, 0]
        ],
        width: 4
      })
    );
    expect(bounds(road)).toEqual([
      [0, -2, 0],
      [10, 2, 0]
    ]);
    expect(
      objectVolume(
        object({
          type: 'line',
          points: [
            [0, 0],
            [10, 0]
          ]
        })
      )
    ).toHaveLength(0);
    expect(objectVolume(object({ type: 'point', at: [1, 1] }))).toHaveLength(0);
    expect(bounds(objectVolume(object({ type: 'point', at: [1, 1] }, { height: 3 })))[1][2]).toBe(3);
  });

  it('вогнутый многоугольник разбивается без треугольников вне контура', () => {
    // Буква Г: площадь 3 из четырёх клеток.
    const pieces = triangulate([
      [0, 0],
      [2, 0],
      [2, 1],
      [1, 1],
      [1, 2],
      [0, 2]
    ]);
    const area = pieces.reduce((sum, [a, b, c]) => sum + ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2, 0);
    expect(area).toBeCloseTo(3);
    expect(pieces).toHaveLength(4);
  });

  it('наибольшая высота учитывает подъём, тело и верх', () => {
    expect(objectTopHeight(object(rect(), { height: 3, top: { form: 'ridge', rise: 3, axis: 'x' } }))).toBe(6);
    expect(objectTopHeight(object(rect(), { height: 4, elevation: 2, body: 'ellipsoid' }))).toBe(6);
    expect(objectTopHeight(object(rect()))).toBe(0);
  });
});
