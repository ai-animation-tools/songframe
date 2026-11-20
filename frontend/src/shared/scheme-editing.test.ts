import { describe, expect, it } from 'vitest';
import type { Scheme, SchemePoint } from './schemes';
import {
  drawOrder,
  labelAnchor,
  shapeArea,
  shapeHandles,
  appendPoint,
  metres,
  createObject,
  createScheme,
  createShape,
  moveHandle,
  moveShape,
  nextId,
  rectCorners,
  removeHandle,
  rotate,
  schemeBounds,
  shapeBounds,
  smoothCurve
} from './scheme-editing';

const close = (actual: number[], expected: number[]): void => actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 6));

describe('коды и создание', () => {
  it('выдаёт первый свободный код', () => {
    expect(nextId(['o1', 'o3'], 'o')).toBe('o2');
    expect(nextId([], 's')).toBe('s1');
  });

  it('создаёт схему и объект со свободными кодами', () => {
    const scheme = createScheme({ schema_version: 1, schemes: [{ id: 's1', location: 'a', title: 'А', objects: [] }] }, 'b', '  Сквер ');
    expect(scheme).toEqual({ id: 's2', location: 'b', title: 'Сквер', objects: [] });
    const object = createObject(
      { ...scheme, objects: [{ id: 'o1', name: 'x', shape: { type: 'point', at: [0, 0] } }] },
      { type: 'point', at: [1, 1] },
      'Фонарь'
    );
    expect(object.id).toBe('o2');
  });

  it('прямоугольник и эллипс по рамке, иначе размер по умолчанию', () => {
    expect(createShape('rect', [0, 0], [10, 4])).toEqual({ type: 'rect', center: [5, 2], size: [10, 4], rotation: 0 });
    expect(createShape('ellipse', [2, 2], [6, 4])).toEqual({ type: 'ellipse', center: [4, 3], radii: [2, 1], rotation: 0 });
    expect(createShape('rect', [3, 3])).toEqual({ type: 'rect', center: [3, 3], size: [4, 4], rotation: 0 });
    expect(createShape('point', [1, 2])).toEqual({ type: 'point', at: [1, 2] });
    expect(createShape('line', [0, 0], [5, 0])).toEqual({
      type: 'line',
      points: [
        [0, 0],
        [5, 0]
      ],
      smooth: false,
      closed: false
    });
  });
});

describe('правки фигур', () => {
  it('сдвигает фигуры целиком', () => {
    expect(moveShape({ type: 'rect', center: [1, 1], size: [2, 2] }, 3, -1)).toMatchObject({ center: [4, 0] });
    expect(
      moveShape(
        {
          type: 'polygon',
          points: [
            [0, 0],
            [1, 0],
            [1, 1]
          ]
        },
        1,
        1
      )
    ).toEqual({
      type: 'polygon',
      points: [
        [1, 1],
        [2, 1],
        [2, 2]
      ]
    });
    expect(moveShape({ type: 'point', at: [0, 0] }, 2, 2)).toEqual({ type: 'point', at: [2, 2] });
  });

  it('двигает и удаляет вершины, не ломая фигуру', () => {
    const line = {
      type: 'line' as const,
      points: [
        [0, 0],
        [5, 0],
        [10, 0]
      ] as SchemePoint[]
    };
    expect(moveHandle(line, 1, [5, 3])).toMatchObject({
      points: [
        [0, 0],
        [5, 3],
        [10, 0]
      ]
    });
    expect(removeHandle(line, 1)).toEqual({
      type: 'line',
      points: [
        [0, 0],
        [10, 0]
      ]
    });
    expect(
      removeHandle(
        {
          type: 'line',
          points: [
            [0, 0],
            [1, 0]
          ]
        },
        0
      ).type === 'line' &&
        removeHandle(
          {
            type: 'line',
            points: [
              [0, 0],
              [1, 0]
            ]
          },
          0
        )
    ).toMatchObject({
      points: [
        [0, 0],
        [1, 0]
      ]
    });
    const triangle = {
      type: 'polygon' as const,
      points: [
        [0, 0],
        [1, 0],
        [0, 1]
      ] as SchemePoint[]
    };
    expect(removeHandle(triangle, 0)).toBe(triangle);
  });
});

describe('геометрия', () => {
  it('поворачивает против часовой стрелки', () => {
    close(rotate([1, 0], [0, 0], 90), [0, 1]);
    close(rotate([2, 1], [1, 1], 180), [0, 1]);
  });

  it('углы повёрнутого прямоугольника', () => {
    const corners = rectCorners({ type: 'rect', center: [0, 0], size: [4, 2], rotation: 90 });
    close(corners[0], [1, -2]);
    close(corners[2], [-1, 2]);
  });

  it('рамки фигур учитывают поворот и ширину линии', () => {
    close(shapeBounds({ type: 'rect', center: [0, 0], size: [4, 2], rotation: 90 }), [-1, -2, 1, 2]);
    close(shapeBounds({ type: 'ellipse', center: [0, 0], radii: [3, 1], rotation: 90 }), [-1, -3, 1, 3]);
    close(
      shapeBounds({
        type: 'line',
        points: [
          [0, 0],
          [10, 0]
        ],
        width: 4
      }),
      [-2, -2, 12, 2]
    );
    const objects: Scheme['objects'] = [
      { id: 'a', name: 'A', shape: { type: 'point', at: [-5, 2] } },
      { id: 'b', name: 'B', shape: { type: 'rect', center: [10, 10], size: [2, 2] } }
    ];
    close(schemeBounds(objects)!, [-5, 2, 11, 11]);
    expect(schemeBounds([])).toBeNull();
  });

  it('гладкая кривая проходит через заданные точки', () => {
    const points: SchemePoint[] = [
      [0, 0],
      [10, 5],
      [20, 0],
      [30, 5]
    ];
    const curve = smoothCurve(points, false);
    for (const point of points) expect(curve.some((item) => Math.hypot(item[0] - point[0], item[1] - point[1]) < 1e-9)).toBe(true);
    expect(curve[0]).toEqual([0, 0]);
    close(curve[curve.length - 1], [30, 5]);
    // Кривая не уходит далеко за выпуклую оболочку точек.
    expect(Math.max(...curve.map((item) => item[1]))).toBeLessThan(7);
  });

  it('замкнутая кривая возвращается в первую точку', () => {
    const curve = smoothCurve(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10]
      ],
      true
    );
    close(curve[curve.length - 1], [0, 0]);
  });
});

describe('чистота координат', () => {
  it('сдвиги и вершины округляются до миллиметра без хвостов двоичной арифметики', () => {
    const line = { type: 'line' as const, points: [[40.7, 20.8]] as SchemePoint[], smooth: false, closed: false };
    let moved: typeof line | ReturnType<typeof moveShape> = line;
    for (let step = 0; step < 7; step += 1) moved = moveShape(moved, 0.1, -0.3);
    expect(moved).toMatchObject({ points: [[41.4, 18.7]] });
    expect(moveHandle(line, 0, [0.1 + 0.2, -0.30000000000000004])).toMatchObject({ points: [[0.3, -0.3]] });
    expect(metres(-74.60000000000001)).toBe(-74.6);
    expect(Object.is(metres(-0.0001), 0)).toBe(true);
  });

  it('рамка прямоугольника даёт центр и размер без хвостов', () => {
    expect(createShape('rect', [-113.4, -0.5], [-85.7, 11.8])).toEqual({ type: 'rect', center: [-99.55, 5.65], size: [27.7, 12.3], rotation: 0 });
  });

  it('двойной щелчок не повторяет последнюю точку черновика', () => {
    const points: SchemePoint[] = [[1, 2]];
    expect(appendPoint(points, [1, 2])).toEqual([[1, 2]]);
    expect(appendPoint(points, [3, 4])).toEqual([
      [1, 2],
      [3, 4]
    ]);
  });
});

describe('ручки рамки', () => {
  const rect = { type: 'rect' as const, center: [0, 0] as SchemePoint, size: [4, 2] as SchemePoint, rotation: 0 };

  it('у прямоугольника и эллипса четыре угла и четыре середины сторон', () => {
    expect(shapeHandles(rect)).toEqual([
      [-2, -1],
      [2, -1],
      [2, 1],
      [-2, 1],
      [0, -1],
      [2, 0],
      [0, 1],
      [-2, 0]
    ]);
    expect(shapeHandles({ type: 'ellipse', center: [1, 1], radii: [1, 2], rotation: 0 })[2]).toEqual([2, 3]);
  });

  it('угол растягивает рамку, противоположный угол остаётся на месте', () => {
    expect(moveHandle(rect, 2, [4, 3])).toEqual({ ...rect, center: [1, 1], size: [6, 4] });
    expect(moveHandle({ type: 'ellipse', center: [0, 0], radii: [2, 1], rotation: 0 }, 0, [-4, -3])).toEqual({
      type: 'ellipse',
      center: [-1, -1],
      radii: [3, 2],
      rotation: 0
    });
  });

  it('середина стороны меняет только свой размер', () => {
    expect(moveHandle(rect, 5, [5, 7])).toEqual({ ...rect, center: [1.5, 0], size: [7, 2] });
    expect(moveHandle(rect, 4, [9, -3])).toEqual({ ...rect, center: [0, -1], size: [4, 4] });
  });

  it('у повёрнутой фигуры растяжение идёт вдоль её осей', () => {
    const turned = { ...rect, rotation: 90 };
    // Повёрнутый на 90° прямоугольник 4×2: его ось X смотрит на север. Правая сторона — на севере, y = 2.
    const right = shapeHandles(turned)[5];
    expect(right[0]).toBeCloseTo(0, 9);
    expect(right[1]).toBeCloseTo(2, 9);
    const moved = moveHandle(turned, 5, [0.5, 4]);
    expect(moved).toMatchObject({ center: [0, 1], size: [6, 2], rotation: 90 });
  });

  it('протаскивание за противоположную сторону не схлопывает фигуру в ноль', () => {
    expect(moveHandle(rect, 5, [-2, 0])).toMatchObject({ size: [0.01, 2] });
    expect(moveHandle(rect, 5, [-5, 0])).toEqual({ ...rect, center: [-3.5, 0], size: [3, 2] });
  });
});

describe('порядок отрисовки', () => {
  it('площади фигур', () => {
    expect(shapeArea({ type: 'rect', center: [0, 0], size: [10, 11], rotation: 0 })).toBe(110);
    expect(shapeArea({ type: 'ellipse', center: [0, 0], radii: [1, 2], rotation: 0 })).toBeCloseTo(2 * Math.PI, 9);
    expect(
      shapeArea({
        type: 'polygon',
        points: [
          [0, 0],
          [4, 0],
          [4, 3]
        ]
      })
    ).toBe(6);
    expect(shapeArea({ type: 'point', at: [1, 1] })).toBe(0);
  });

  it('мелкое поверх крупного независимо от порядка рисования', () => {
    const rect = (id: string, w: number, h: number) => ({
      id,
      name: id,
      shape: { type: 'rect' as const, center: [0, 0] as SchemePoint, size: [w, h] as SchemePoint, rotation: 0 }
    });
    const thin = rect('thin', 1, 9);
    const big = rect('big', 10, 11);
    const small = rect('small', 2, 2);
    const point = { id: 'p', name: 'p', shape: { type: 'point' as const, at: [0, 0] as SchemePoint } };
    expect(drawOrder([point, thin, big, small]).map((object) => object.id)).toEqual(['big', 'thin', 'small', 'p']);
    expect(drawOrder([rect('a', 2, 2), rect('b', 2, 2)]).map((object) => object.id)).toEqual(['a', 'b']);
  });
});

describe('подписи', () => {
  it('забор по периметру подписан на самой линии, а не в центре двора', () => {
    const fence: SchemePoint[] = [
      [-2, -12],
      [-10, -12],
      [-10, 10],
      [12, 10],
      [12, -12],
      [0, -12]
    ];
    // Длина 86 м, середина — 43 м от начала: на северной стороне, 13 м от северо-западного угла.
    expect(labelAnchor({ type: 'line', points: fence, smooth: false, closed: false })).toEqual([3, 10]);
  });

  it('замкнутая линия учитывает замыкающий отрезок, точка и фигуры — как прежде', () => {
    const square: SchemePoint[] = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4]
    ];
    expect(labelAnchor({ type: 'line', points: square, smooth: false, closed: true })).toEqual([4, 4]);
    expect(labelAnchor({ type: 'point', at: [1, 2] })).toEqual([1, 2]);
    expect(labelAnchor({ type: 'rect', center: [1, 1], size: [2, 4], rotation: 0 })).toEqual([1, 1]);
  });
});
