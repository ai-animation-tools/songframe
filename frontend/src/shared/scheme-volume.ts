import type { Scheme, SchemeObject, SchemePoint, SchemeShape } from './schemes';
import { ellipseOutline, rectCorners, smoothCurve } from './scheme-editing';

/**
 * Объём схемы вида сверху: треугольники всех объектов в метрах мира (X — восток, Y — север, Z — вверх). Из них
 * рисуется 3D-просмотр схемы и вид из камеры точки съёмки; по ним же считаются факты кадра. Формы объёма описаны в
 * `docs/schemes.md#объём`, допустимые сочетания проверяет Go (`internal/schemes`), здесь они уже верны.
 *
 * Все треугольники обращены наружу: вершины идут против часовой стрелки, если смотреть снаружи, поэтому нормаль
 * (b − a) × (c − a) смотрит от тела. Плоская поверхность (без высоты и верха) — один слой на высоте низа лицом вверх;
 * стенка линии без ширины — один слой, видимый с обеих сторон.
 */

export type Vec3 = [number, number, number];
export type Triangle = [Vec3, Vec3, Vec3];

/** Объём одного объекта: его код и треугольники. */
export interface ObjectVolume {
  id: string;
  triangles: Triangle[];
}

/** Толщина столба точки, м: точка с высотой — тонкая опора, видимая в кадре. */
const POLE = 0.12;
/** Число долгот и широт эллипсоида. */
const SEGMENTS = 24;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Единичная нормаль треугольника по порядку вершин; вырожденный — нулевой вектор. */
export function triangleNormal([a, b, c]: Triangle): Vec3 {
  const n = cross(sub(b, a), sub(c, a));
  const length = Math.hypot(...n);
  return length < 1e-12 ? [0, 0, 0] : [n[0] / length, n[1] / length, n[2] / length];
}

/** Удвоенная площадь со знаком: больше нуля — обход против часовой стрелки. */
function signedArea(points: readonly SchemePoint[]): number {
  let sum = 0;
  for (let index = 0; index < points.length; index++) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[(index + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum;
}

/** Контур против часовой стрелки: от этого зависит, куда смотрят стенки. */
function counterClockwise(points: readonly SchemePoint[]): SchemePoint[] {
  return signedArea(points) < 0 ? [...points].reverse() : [...points];
}

/** Точка p внутри треугольника abc (обход против часовой), включая границу. */
function inside(p: SchemePoint, a: SchemePoint, b: SchemePoint, c: SchemePoint): boolean {
  const side = (u: SchemePoint, v: SchemePoint): number => (v[0] - u[0]) * (p[1] - u[1]) - (v[1] - u[1]) * (p[0] - u[0]);
  return side(a, b) >= 0 && side(b, c) >= 0 && side(c, a) >= 0;
}

/**
 * Треугольники простого многоугольника (обход против часовой) отсечением ушей: выпуклые и вогнутые контуры.
 * Самопересекающийся контур отсекается как получится — схема не должна такой содержать, но программа не падает.
 */
export function triangulate(points: readonly SchemePoint[]): [SchemePoint, SchemePoint, SchemePoint][] {
  const rest = [...points];
  const result: [SchemePoint, SchemePoint, SchemePoint][] = [];
  let guard = rest.length * rest.length;
  while (rest.length > 3 && guard-- > 0) {
    let cut = false;
    for (let index = 0; index < rest.length; index++) {
      const a = rest[(index + rest.length - 1) % rest.length];
      const b = rest[index];
      const c = rest[(index + 1) % rest.length];
      const convex = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 1e-12;
      if (!convex || rest.some((p) => p !== a && p !== b && p !== c && inside(p, a, b, c))) continue;
      result.push([a, b, c]);
      rest.splice(index, 1);
      cut = true;
      break;
    }
    if (!cut) break;
  }
  for (let index = 1; index + 1 < rest.length; index++) result.push([rest[0], rest[index], rest[index + 1]]);
  return result;
}

/** Стенки контура от z0 до z1 и, по флагам, низ и плоский верх. */
function prism(outline: readonly SchemePoint[], z0: number, z1: number, bottom: boolean, top: boolean): Triangle[] {
  const ring = counterClockwise(outline);
  const triangles: Triangle[] = [];
  if (z1 > z0) {
    ring.forEach((p, index) => {
      const q = ring[(index + 1) % ring.length];
      triangles.push(
        [
          [p[0], p[1], z0],
          [q[0], q[1], z0],
          [q[0], q[1], z1]
        ],
        [
          [p[0], p[1], z0],
          [q[0], q[1], z1],
          [p[0], p[1], z1]
        ]
      );
    });
  }
  for (const [a, b, c] of triangulate(ring)) {
    if (top)
      triangles.push([
        [a[0], a[1], z1],
        [b[0], b[1], z1],
        [c[0], c[1], z1]
      ]);
    if (bottom)
      triangles.push([
        [a[0], a[1], z0],
        [c[0], c[1], z0],
        [b[0], b[1], z0]
      ]);
  }
  return triangles;
}

/** Перевод из собственных осей прямоугольника (поворот angle, градусы против часовой) в метры мира. */
function frame(center: SchemePoint, angle: number): (u: number, v: number, z: number) => Vec3 {
  const radians = (angle * Math.PI) / 180;
  const [cos, sin] = [Math.cos(radians), Math.sin(radians)];
  return (u, v, z) => [center[0] + u * cos - v * sin, center[1] + u * sin + v * cos, z];
}

/**
 * Гребень над прямоугольником: в его осях гребень идёт вдоль u посередине по v. Ось y сводится к оси x поворотом
 * на 90° с обменом размеров — это тот же прямоугольник.
 */
function ridge(shape: Extract<SchemeShape, { type: 'rect' }>, axis: 'x' | 'y', z: number, rise: number): Triangle[] {
  const along = axis === 'x';
  const at = frame(shape.center, (shape.rotation ?? 0) + (along ? 0 : 90));
  const [hu, hv] = along ? [shape.size[0] / 2, shape.size[1] / 2] : [shape.size[1] / 2, shape.size[0] / 2];
  const top = z + rise;
  return [
    [at(-hu, -hv, z), at(hu, -hv, z), at(hu, 0, top)],
    [at(-hu, -hv, z), at(hu, 0, top), at(-hu, 0, top)],
    [at(hu, hv, z), at(-hu, hv, z), at(-hu, 0, top)],
    [at(hu, hv, z), at(-hu, 0, top), at(hu, 0, top)],
    [at(-hu, hv, z), at(-hu, -hv, z), at(-hu, 0, top)],
    [at(hu, -hv, z), at(hu, hv, z), at(hu, 0, top)]
  ];
}

/**
 * Скат над прямоугольником: низкий край у стороны down, высокий — у противоположной. В осях ската он опускается к −v;
 * остальные стороны сводятся к этой поворотом (±90° — с обменом размеров).
 */
function slope(shape: Extract<SchemeShape, { type: 'rect' }>, down: '+x' | '-x' | '+y' | '-y', z: number, rise: number): Triangle[] {
  const turn = { '-y': 0, '+x': 90, '+y': 180, '-x': 270 }[down];
  const swap = turn === 90 || turn === 270;
  const at = frame(shape.center, (shape.rotation ?? 0) + turn);
  const [hu, hv] = swap ? [shape.size[1] / 2, shape.size[0] / 2] : [shape.size[0] / 2, shape.size[1] / 2];
  const top = z + rise;
  return [
    [at(-hu, -hv, z), at(hu, -hv, z), at(hu, hv, top)],
    [at(-hu, -hv, z), at(hu, hv, top), at(-hu, hv, top)],
    [at(hu, hv, z), at(-hu, hv, z), at(-hu, hv, top)],
    [at(hu, hv, z), at(-hu, hv, top), at(hu, hv, top)],
    [at(-hu, hv, z), at(-hu, -hv, z), at(-hu, hv, top)],
    [at(hu, -hv, z), at(hu, hv, z), at(hu, hv, top)]
  ];
}

/** Центр тяжести площади контура: вершина шатра. */
function centroid(points: readonly SchemePoint[]): SchemePoint {
  const area = signedArea(points);
  if (Math.abs(area) < 1e-12) {
    const sum = points.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
    return [sum[0] / points.length, sum[1] / points.length];
  }
  let cx = 0;
  let cy = 0;
  points.forEach((p, index) => {
    const q = points[(index + 1) % points.length];
    const k = p[0] * q[1] - q[0] * p[1];
    cx += (p[0] + q[0]) * k;
    cy += (p[1] + q[1]) * k;
  });
  return [cx / (3 * area), cy / (3 * area)];
}

/** Шатёр: треугольники от каждой стороны контура к вершине над центром. */
function tent(outline: readonly SchemePoint[], z: number, rise: number): Triangle[] {
  const ring = counterClockwise(outline);
  const [cx, cy] = centroid(ring);
  return ring.map((p, index) => {
    const q = ring[(index + 1) % ring.length];
    return [
      [p[0], p[1], z],
      [q[0], q[1], z],
      [cx, cy, z + rise]
    ];
  });
}

/** Эллипсоид, вписанный в полуоси (ru, rv) с поворотом и высоту от z0 до z1. */
function ellipsoid(center: SchemePoint, ru: number, rv: number, angle: number, z0: number, z1: number): Triangle[] {
  const at = frame(center, angle);
  const rz = (z1 - z0) / 2;
  const zc = z0 + rz;
  const point = (i: number, j: number): Vec3 => {
    const theta = (i / SEGMENTS) * Math.PI * 2;
    const phi = (j / (SEGMENTS / 2)) * Math.PI;
    return at(ru * Math.cos(theta) * Math.sin(phi), rv * Math.sin(theta) * Math.sin(phi), zc + rz * Math.cos(phi));
  };
  const triangles: Triangle[] = [];
  for (let i = 0; i < SEGMENTS; i++)
    for (let j = 0; j < SEGMENTS / 2; j++) {
      const [a, b, c, d] = [point(i, j), point(i, j + 1), point(i + 1, j + 1), point(i + 1, j)];
      // У полюсов две вершины совпадают: такой треугольник вырожден и не нужен.
      if (j > 0) triangles.push([a, b, d]);
      if (j < SEGMENTS / 2 - 1) triangles.push([b, c, d]);
    }
  return triangles;
}

/** Стенка или полоса вдоль линии: у каждого отрезка свой параллелепипед шириной width, без ширины — стенка в один слой. */
function wall(points: readonly SchemePoint[], width: number | undefined, z0: number, z1: number): Triangle[] {
  const triangles: Triangle[] = [];
  for (let index = 0; index + 1 < points.length; index++) {
    const [p, q] = [points[index], points[index + 1]];
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (length < 1e-9) continue;
    if (width) {
      const [nx, ny] = [(-(q[1] - p[1]) / length) * (width / 2), ((q[0] - p[0]) / length) * (width / 2)];
      const band: SchemePoint[] = [
        [p[0] - nx, p[1] - ny],
        [q[0] - nx, q[1] - ny],
        [q[0] + nx, q[1] + ny],
        [p[0] + nx, p[1] + ny]
      ];
      triangles.push(...prism(band, z0, z1, false, true));
    } else if (z1 > z0) {
      const [a, b, c, d]: Vec3[] = [
        [p[0], p[1], z0],
        [q[0], q[1], z0],
        [q[0], q[1], z1],
        [p[0], p[1], z1]
      ];
      // Один слой: два слоя в одной плоскости лицом в разные стороны рябят в кадре. Видна с обеих сторон, свет
      // для обратной стороны отрисовка считает по перевёрнутой нормали.
      triangles.push([a, b, c], [a, c, d]);
    }
  }
  return triangles;
}

/** Контур площадной фигуры; у линии и точки контура нет. */
function outlineOf(shape: SchemeShape): SchemePoint[] | null {
  switch (shape.type) {
    case 'rect':
      return rectCorners(shape);
    case 'ellipse':
      return ellipseOutline(shape);
    case 'polygon':
      return shape.points;
    default:
      return null;
  }
}

/** Треугольники одного объекта вида сверху. Линия без высоты и ширины и точка без высоты объёма не имеют. */
export function objectVolume(object: SchemeObject): Triangle[] {
  const { shape } = object;
  const z0 = object.elevation ?? 0;
  const z1 = z0 + (object.height ?? 0);
  if (shape.type === 'point') {
    if (z1 <= z0) return [];
    const [x, y] = shape.at;
    const h = POLE / 2;
    return prism(
      [
        [x - h, y - h],
        [x + h, y - h],
        [x + h, y + h],
        [x - h, y + h]
      ],
      z0,
      z1,
      z0 > 0,
      true
    );
  }
  if (shape.type === 'line') {
    const path = shape.smooth ? smoothCurve(shape.points, !!shape.closed) : [...shape.points];
    if (shape.closed && !shape.smooth) path.push(path[0]);
    return wall(path, shape.width, z0, z1);
  }
  const outline = outlineOf(shape)!;
  if (object.body === 'ellipsoid') {
    const [ru, rv] = shape.type === 'rect' ? [shape.size[0] / 2, shape.size[1] / 2] : shape.type === 'ellipse' ? shape.radii : [0, 0];
    const center = shape.type === 'polygon' ? centroid(outline) : shape.center;
    const angle = shape.type === 'polygon' ? 0 : (shape.rotation ?? 0);
    return ellipsoid(center, ru, rv, angle, z0, z1);
  }
  const top = object.top;
  const triangles = prism(outline, z0, z1, z0 > 0, !top);
  if (!top) return triangles;
  if (top.form === 'ridge' && shape.type === 'rect') return [...triangles, ...ridge(shape, top.axis, z1, top.rise)];
  if (top.form === 'slope' && shape.type === 'rect') return [...triangles, ...slope(shape, top.down, z1, top.rise)];
  return [...triangles, ...tent(outline, z1, top.rise)];
}

/** Объём всех объектов схемы; объекты без объёма пропускаются. */
export function schemeVolume(scheme: Scheme): ObjectVolume[] {
  return scheme.objects.map((object) => ({ id: object.id, triangles: objectVolume(object) })).filter((volume) => volume.triangles.length > 0);
}

/** Наибольшая высота объекта над землёй: верх тела или верха. Нужна фактам кадра и подписи объёма. */
export function objectTopHeight(object: SchemeObject): number {
  return (object.elevation ?? 0) + (object.height ?? 0) + (object.top && object.body !== 'ellipsoid' ? object.top.rise : 0);
}
