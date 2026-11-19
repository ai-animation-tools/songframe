import type { Scheme, SchemeObject, SchemePoint, SchemeShape, SchemeShapeType, SchemeViewKind, SchemesFile } from './schemes';

/**
 * Чистые правки схем для редактора страницы «Схемы»: создание схем и фигур, перемещение фигур и вершин, границы для
 * вписывания в холст и построение гладкой кривой. Координаты — метры схемы (см. `schemes.ts`); экранные пиксели
 * и ось Y экрана вниз учитывает только холст.
 */

/**
 * Метры с точностью до миллиметра. Сумма дробных сдвигов в двоичной арифметике даёт хвосты вроде 74.60000000000001;
 * округление после каждой правки держит файл схемы читаемым и не меняет геометрию заметно.
 */
export function metres(value: number): number {
  return Math.round(value * 1000) / 1000 || 0;
}

const tidy = (point: SchemePoint): SchemePoint => [metres(point[0]), metres(point[1])];

/** Точка черновика линии или многоугольника, добавленная в конец, если она не повторяет последнюю (двойной щелчок). */
export function appendPoint(points: readonly SchemePoint[], point: SchemePoint): SchemePoint[] {
  const last = points.at(-1);
  return last && last[0] === point[0] && last[1] === point[1] ? [...points] : [...points, point];
}

/** Свободный код с префиксом: prefix1, prefix2… — первый, которого нет среди used. */
export function nextId(used: Iterable<string>, prefix: string): string {
  const taken = new Set(used);
  for (let number = 1; ; number += 1) {
    const candidate = `${prefix}${number}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Пустая схема вида view для локации; код — свободный в документе. */
export function createScheme(document: SchemesFile, location: string, view: SchemeViewKind, title: string): Scheme {
  return {
    id: nextId(
      document.schemes.map((scheme) => scheme.id),
      's'
    ),
    location,
    title: title.trim(),
    view,
    objects: []
  };
}

/** Размер новой фигуры по умолчанию, метров: заметен на сетке и легко правится. */
const DEFAULT_SIZE = 4;

/**
 * Фигура типа type с началом в точке from и, для протягиваемых фигур, концом в to. Прямоугольник и эллипс
 * занимают рамку from–to (или квадрат со стороной fallback вокруг from, если рамка вырождена: щелчок без протягивания); линия и многоугольник
 * начинаются из точек, которые дальше добавляет редактор.
 */
export function createShape(type: SchemeShapeType, from: SchemePoint, to: SchemePoint = from, fallback = DEFAULT_SIZE): SchemeShape {
  const width = Math.abs(to[0] - from[0]);
  const height = Math.abs(to[1] - from[1]);
  const framed = width > 0.01 && height > 0.01;
  const center = tidy(framed ? [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2] : from);
  switch (type) {
    case 'rect':
      return { type, center, size: framed ? tidy([width, height]) : [fallback, fallback], rotation: 0 };
    case 'ellipse':
      return { type, center, radii: framed ? tidy([width / 2, height / 2]) : [fallback / 2, fallback / 2], rotation: 0 };
    case 'polygon':
      return { type, points: [from, to] };
    case 'line':
      return { type, points: [from, to], smooth: false, closed: false };
    case 'point':
      return { type, at: from };
  }
}

/** Новый объект схемы с фигурой shape и свободным кодом; название задаёт автор. */
export function createObject(scheme: Scheme, shape: SchemeShape, name: string): SchemeObject {
  return {
    id: nextId(
      scheme.objects.map((object) => object.id),
      'o'
    ),
    name,
    shape
  };
}

const shift = (point: SchemePoint, dx: number, dy: number): SchemePoint => tidy([point[0] + dx, point[1] + dy]);

/** Фигура, сдвинутая целиком на (dx, dy) метров. */
export function moveShape(shape: SchemeShape, dx: number, dy: number): SchemeShape {
  switch (shape.type) {
    case 'rect':
    case 'ellipse':
      return { ...shape, center: shift(shape.center, dx, dy) };
    case 'polygon':
    case 'line':
      return { ...shape, points: shape.points.map((point) => shift(point, dx, dy)) };
    case 'point':
      return { ...shape, at: shift(shape.at, dx, dy) };
  }
}

/**
 * Ручки рамки прямоугольника и эллипса в осях фигуры: четыре угла, затем середины четырёх сторон. Знак по оси
 * показывает, к какой стороне от центра относится ручка; ноль — ось ручка не меняет.
 */
const FRAME_SIGNS: readonly SchemePoint[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0]
];

/** Наименьший размер рамки, м: протаскивание ручки за противоположную сторону не схлопывает фигуру в ноль. */
const MIN_FRAME = 0.01;

type FrameShape = Extract<SchemeShape, { type: 'rect' | 'ellipse' }>;
const halfOf = (shape: FrameShape): SchemePoint => (shape.type === 'rect' ? [shape.size[0] / 2, shape.size[1] / 2] : shape.radii);

/** Фигура правится по вершинам (линия, многоугольник, точка), а не рамкой. */
export function hasVertices(shape: SchemeShape): shape is Extract<SchemeShape, { type: 'polygon' | 'line' | 'point' }> {
  return shape.type === 'polygon' || shape.type === 'line' || shape.type === 'point';
}

/**
 * Ручки фигуры: вершины линии и многоугольника, точка, а у прямоугольника и эллипса — углы и середины сторон
 * рамки с учётом поворота (порядок FRAME_SIGNS).
 */
export function shapeHandles(shape: SchemeShape): SchemePoint[] {
  switch (shape.type) {
    case 'polygon':
    case 'line':
      return shape.points;
    case 'point':
      return [shape.at];
    case 'rect':
    case 'ellipse': {
      const half = halfOf(shape);
      return FRAME_SIGNS.map((sign) => rotate([shape.center[0] + sign[0] * half[0], shape.center[1] + sign[1] * half[1]], shape.center, shape.rotation ?? 0));
    }
  }
}

/**
 * Фигура, у которой ручка index перенесена в точку to. Вершина линии, многоугольника или точка встаёт в to.
 * Ручка рамки меняет размер: противоположный угол или сторона остаются на месте, поворот сохраняется, ручка
 * середины стороны меняет только свой размер.
 */
export function moveHandle(shape: SchemeShape, index: number, to: SchemePoint): SchemeShape {
  switch (shape.type) {
    case 'polygon':
    case 'line':
      return { ...shape, points: shape.points.map((point, at) => (at === index ? tidy(to) : point)) };
    case 'point':
      return { ...shape, at: tidy(to) };
    case 'rect':
    case 'ellipse': {
      const sign = FRAME_SIGNS[index];
      if (!sign) return shape;
      const angle = shape.rotation ?? 0;
      const half = halfOf(shape);
      // Точка в осях фигуры: начало в центре, без поворота.
      const local = rotate(to, shape.center, -angle);
      const pointer: SchemePoint = [local[0] - shape.center[0], local[1] - shape.center[1]];
      const nextHalf: SchemePoint = [...half];
      const shiftLocal: SchemePoint = [0, 0];
      for (const axis of [0, 1] as const) {
        if (!sign[axis]) continue;
        const fixed = -sign[axis] * half[axis];
        nextHalf[axis] = Math.max(MIN_FRAME, Math.abs(pointer[axis] - fixed)) / 2;
        shiftLocal[axis] = (fixed + pointer[axis]) / 2;
      }
      const center = tidy(rotate([shape.center[0] + shiftLocal[0], shape.center[1] + shiftLocal[1]], shape.center, angle));
      return shape.type === 'rect' ? { ...shape, center, size: tidy([nextHalf[0] * 2, nextHalf[1] * 2]) } : { ...shape, center, radii: tidy(nextHalf) };
    }
  }
}

/** Вершина index удалена, если после этого фигура остаётся полной (линия — 2 точки, замкнутая и многоугольник — 3). */
export function removeHandle(shape: SchemeShape, index: number): SchemeShape {
  if (shape.type !== 'polygon' && shape.type !== 'line') return shape;
  const minimum = shape.type === 'polygon' || shape.closed ? 3 : 2;
  if (shape.points.length <= minimum) return shape;
  return { ...shape, points: shape.points.filter((_, at) => at !== index) };
}

/** Поворот точки вокруг center на angle градусов против часовой стрелки (ось Y вверх). */
export function rotate(point: SchemePoint, center: SchemePoint, angle: number): SchemePoint {
  const radians = (angle * Math.PI) / 180;
  const x = point[0] - center[0];
  const y = point[1] - center[1];
  return [center[0] + x * Math.cos(radians) - y * Math.sin(radians), center[1] + x * Math.sin(radians) + y * Math.cos(radians)];
}

/** Углы прямоугольника с учётом поворота, против часовой от левого нижнего. */
export function rectCorners(shape: Extract<SchemeShape, { type: 'rect' }>): SchemePoint[] {
  const [cx, cy] = shape.center;
  const [w, h] = [shape.size[0] / 2, shape.size[1] / 2];
  const corners: SchemePoint[] = [
    [cx - w, cy - h],
    [cx + w, cy - h],
    [cx + w, cy + h],
    [cx - w, cy + h]
  ];
  return corners.map((corner) => rotate(corner, shape.center, shape.rotation ?? 0));
}

/** Площадь фигуры в квадратных метрах; у линии и точки — 0. Многоугольник — по формуле площади Гаусса. */
export function shapeArea(shape: SchemeShape): number {
  switch (shape.type) {
    case 'rect':
      return shape.size[0] * shape.size[1];
    case 'ellipse':
      return Math.PI * shape.radii[0] * shape.radii[1];
    case 'polygon': {
      let sum = 0;
      shape.points.forEach((point, index) => {
        const next = shape.points[(index + 1) % shape.points.length];
        sum += point[0] * next[1] - next[0] * point[1];
      });
      return Math.abs(sum) / 2;
    }
    default:
      return 0;
  }
}

/**
 * Порядок отрисовки: крупные площади снизу, мелкие, линии и точки сверху. Так объект, положенный на другой
 * (стол в комнате, клумба во дворе), всегда виден и ловится мышью, в каком бы порядке его ни нарисовали.
 * Порядок в файле не меняется; равные площади сохраняют порядок схемы.
 */
export function drawOrder(objects: readonly SchemeObject[]): SchemeObject[] {
  return objects
    .map((object, index) => ({ object, index, area: shapeArea(object.shape) }))
    .sort((a, b) => b.area - a.area || a.index - b.index)
    .map((item) => item.object);
}

/** Ограничивающая рамка в метрах: [minX, minY, maxX, maxY]. */
export type Bounds = [number, number, number, number];

/** Рамка фигуры с учётом поворота и ширины линии. */
export function shapeBounds(shape: SchemeShape): Bounds {
  const of = (points: SchemePoint[], pad = 0): Bounds => {
    const xs = points.map((point) => point[0]);
    const ys = points.map((point) => point[1]);
    return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
  };
  switch (shape.type) {
    case 'rect':
      return of(rectCorners(shape));
    case 'ellipse': {
      // Рамка повёрнутого эллипса: полуоси проекций на оси координат.
      const radians = ((shape.rotation ?? 0) * Math.PI) / 180;
      const [a, b] = shape.radii;
      const hx = Math.hypot(a * Math.cos(radians), b * Math.sin(radians));
      const hy = Math.hypot(a * Math.sin(radians), b * Math.cos(radians));
      return [shape.center[0] - hx, shape.center[1] - hy, shape.center[0] + hx, shape.center[1] + hy];
    }
    case 'polygon':
      return of(shape.points);
    case 'line':
      return of(shape.smooth ? smoothCurve(shape.points, !!shape.closed) : shape.points, (shape.width ?? 0) / 2);
    case 'point':
      return of([shape.at]);
  }
}

/** Рамка всех объектов схемы; пустая схема — null. */
export function schemeBounds(objects: readonly SchemeObject[]): Bounds | null {
  if (!objects.length) return null;
  return objects
    .map((object) => shapeBounds(object.shape))
    .reduce((all, item) => [Math.min(all[0], item[0]), Math.min(all[1], item[1]), Math.max(all[2], item[2]), Math.max(all[3], item[3])]);
}

/** Сколько отрезков строится между соседними точками гладкой кривой. */
const SMOOTH_STEPS = 12;

/**
 * Гладкая кривая через точки — центростремительный сплайн Катмулла — Рома в виде ломаной. Кривая проходит через
 * все заданные точки, поэтому автор и агент описывают её одними точками, без ручек. Замкнутая кривая возвращается
 * в первую точку.
 */
export function smoothCurve(points: readonly SchemePoint[], closed: boolean): SchemePoint[] {
  if (points.length < 3) return [...points];
  const count = points.length;
  const at = (index: number): SchemePoint => {
    if (closed) return points[((index % count) + count) % count];
    return points[Math.max(0, Math.min(count - 1, index))];
  };
  const result: SchemePoint[] = [points[0]];
  const segments = closed ? count : count - 1;
  for (let index = 0; index < segments; index += 1) {
    const [p0, p1, p2, p3] = [at(index - 1), at(index), at(index + 1), at(index + 2)];
    for (let step = 1; step <= SMOOTH_STEPS; step += 1) {
      result.push(catmullRom(p0, p1, p2, p3, step / SMOOTH_STEPS));
    }
  }
  return result;
}

/** Точка центростремительного сплайна между p1 и p2 при параметре t ∈ [0, 1]. */
function catmullRom(p0: SchemePoint, p1: SchemePoint, p2: SchemePoint, p3: SchemePoint, t: number): SchemePoint {
  const knot = (a: SchemePoint, b: SchemePoint): number => Math.max(Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])), 1e-6);
  const t1 = knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const mix = (a: SchemePoint, b: SchemePoint, ta: number, tb: number): SchemePoint => {
    const wa = (tb - u) / (tb - ta);
    const wb = (u - ta) / (tb - ta);
    return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb];
  };
  const a1 = mix(p0, p1, 0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, 0, t2);
  const b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}

/** Схема с заменённым объектом id; остальные объекты и порядок прежние. */
export function updateObject(scheme: Scheme, id: string, change: (object: SchemeObject) => SchemeObject): Scheme {
  return { ...scheme, objects: scheme.objects.map((object) => (object.id === id ? change(object) : object)) };
}

/** Документ с заменённой схемой id. */
export function updateScheme(document: SchemesFile, id: string, change: (scheme: Scheme) => Scheme): SchemesFile {
  return { ...document, schemes: document.schemes.map((scheme) => (scheme.id === id ? change(scheme) : scheme)) };
}
