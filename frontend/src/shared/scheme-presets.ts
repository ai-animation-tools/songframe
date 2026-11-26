import type { Scheme, SchemeObject, SchemePoint } from './schemes';
import { metres, nextId } from './scheme-editing';

/**
 * Набор заготовок для страницы «Схемы»: типовые предметы улицы, природы, зданий и интерьера. Заготовка — только
 * способ быстро поставить обычные объекты схемы с правдоподобными размерами; после добавления они ничем не
 * отличаются от нарисованных вручную и правятся как любые другие. Формат plan/schemes.json от заготовок
 * не зависит. Людей в наборе нет: человек в кадре — сущность кастинга.
 */

/** Группа заготовок в меню. */
export type SchemePresetGroup = 'street' | 'nature' | 'buildings' | 'interior';
export const SCHEME_PRESET_GROUPS: readonly SchemePresetGroup[] = ['street', 'nature', 'buildings', 'interior'];

/**
 * Объект заготовки без кода и названия: код выдаёт добавление (свободный в схеме), название берётся из текстов
 * по заготовке и части (part) — у составных заготовок части называются по-разному.
 */
export type SchemePresetObject = Omit<SchemeObject, 'id' | 'name'> & { part?: string };

/** Размеры комнаты, м: ширина — по оси «восток», длина — по оси «север», высота стен. */
export interface RoomSize {
  width: number;
  length: number;
  height: number;
}

/** Заготовка: код (ключ названия в текстах), группа и объекты, поставленные вокруг точки at. */
export interface SchemePreset {
  id: string;
  group: SchemePresetGroup;
  build(at: SchemePoint): SchemePresetObject[];
}

/** Толщина стен комнаты, дверей и окон на фасаде, м: тонкий прямоугольник, заметный на плане. */
export const THIN = 0.2;
/** Толщина стен «Комнаты», м. */
export const ROOM_WALL = 0.1;
/** Допустимые размеры комнаты, м: стены тоньше пола, а комната остаётся предметом схемы, а не районом. */
export const ROOM_LIMITS = { min: 1, max: 100, minHeight: 0.5, maxHeight: 30 } as const;
/** Размеры комнаты, которые предлагает окно «Комната». */
export const DEFAULT_ROOM: RoomSize = { width: 4, length: 5, height: 2.7 };

const at = (point: SchemePoint, dx = 0, dy = 0): SchemePoint => [metres(point[0] + dx), metres(point[1] + dy)];

/** Предмет-параллелепипед: название ставится из текстов по коду заготовки, поэтому здесь его нет. */
function solid(length: number, width: number, height: number, extra: Partial<SchemePresetObject> = {}): (point: SchemePoint) => SchemePresetObject[] {
  return (point) => [{ shape: { type: 'rect', center: at(point), size: [length, width], rotation: 0 }, height, ...extra }];
}

/** Одиночная точка заданной высоты (столб, светофор). */
function post(height: number): (point: SchemePoint) => SchemePresetObject[] {
  return (point) => [{ shape: { type: 'point', at: at(point) }, height }];
}

/** Заготовки по группам; порядок — порядок в меню. Названия частей составных заготовок помечены в тексте. */
export const SCHEME_PRESETS: readonly SchemePreset[] = [
  { id: 'car', group: 'street', build: solid(4.6, 1.8, 1.5) },
  { id: 'bus', group: 'street', build: solid(12, 2.5, 3) },
  { id: 'truck', group: 'street', build: solid(7, 2.5, 3.2) },
  { id: 'pole', group: 'street', build: post(7) },
  { id: 'trafficLight', group: 'street', build: post(3.5) },
  { id: 'bench', group: 'street', build: solid(1.8, 0.5, 0.9) },
  {
    id: 'fence',
    group: 'street',
    // Линия длиной 4 м вдоль востока; концы правятся ручками.
    build: (point) => [
      {
        shape: {
          type: 'line',
          points: [at(point, -2), at(point, 2)],
          smooth: false,
          closed: false
        },
        height: 1.8
      }
    ]
  },
  {
    id: 'tree',
    group: 'nature',
    // Два объекта в одной точке: ствол и поднятая над землёй эллипсоидная крона.
    build: (point) => [
      { part: 'trunk', shape: { type: 'point', at: at(point) }, height: 2 },
      { part: 'crown', shape: { type: 'ellipse', center: at(point), radii: [2.5, 2.5], rotation: 0 }, height: 4, elevation: 2, body: 'ellipsoid' }
    ]
  },
  {
    id: 'spruce',
    group: 'nature',
    // Круг ⌀3 с шатром: конус без тела высотой 5,5 м (середина диапазона 5–6).
    build: (point) => [{ shape: { type: 'ellipse', center: at(point), radii: [1.5, 1.5], rotation: 0 }, top: { form: 'tent', rise: 5.5 } }]
  },
  {
    id: 'bush',
    group: 'nature',
    build: (point) => [{ shape: { type: 'ellipse', center: at(point), radii: [0.8, 0.8], rotation: 0 }, height: 1.2, body: 'ellipsoid' }]
  },
  { id: 'house', group: 'buildings', build: solid(10, 8, 3, { top: { form: 'ridge', rise: 2.5, axis: 'x' } }) },
  { id: 'apartmentHouse', group: 'buildings', build: solid(30, 12, 15) },
  // Дверь и окно — тонкие прямоугольники вдоль фасада: ставятся на стену и сдвигаются по ней.
  { id: 'door', group: 'buildings', build: solid(1, THIN, 2.1) },
  { id: 'window', group: 'buildings', build: solid(1.4, THIN, 1.5, { elevation: 0.9 }) },
  { id: 'table', group: 'interior', build: solid(1.4, 0.8, 0.75) },
  { id: 'chair', group: 'interior', build: solid(0.45, 0.45, 0.9) },
  { id: 'wardrobe', group: 'interior', build: solid(1, 0.6, 2) },
  { id: 'bed', group: 'interior', build: solid(2, 1.6, 0.5) },
  { id: 'sofa', group: 'interior', build: solid(2.1, 0.9, 0.85) }
];

/**
 * Комната по размерам: пол (плоская поверхность) и четыре тонкие стены внутри его рамки, чтобы габарит
 * комнаты остался равен введённым ширине и длине. Центр — точка at.
 */
export function buildRoom(point: SchemePoint, size: RoomSize): SchemePresetObject[] {
  const { width, length, height } = size;
  const t = ROOM_WALL;
  const wall = (part: 'north' | 'south' | 'west' | 'east', dx: number, dy: number, sx: number, sy: number): SchemePresetObject => ({
    part,
    shape: { type: 'rect', center: at(point, dx, dy), size: [metres(sx), metres(sy)], rotation: 0 },
    height
  });
  return [
    { part: 'floor', shape: { type: 'rect', center: at(point), size: [width, length], rotation: 0 } },
    wall('north', 0, (length - t) / 2, width, t),
    wall('south', 0, -(length - t) / 2, width, t),
    // Боковые стены между северной и южной: углы не накладываются.
    wall('west', -(width - t) / 2, 0, t, length - 2 * t),
    wall('east', (width - t) / 2, 0, t, length - 2 * t)
  ];
}

/**
 * Добавляет объекты заготовки в схему: коды — свободные по порядку, названия — через name(part). Возвращает
 * новую схему и добавленные объекты (первый из них редактор выделяет). Одна заготовка — одна правка схемы.
 */
export function addPresetObjects(
  scheme: Scheme,
  objects: readonly SchemePresetObject[],
  name: (part: string | undefined) => string
): { scheme: Scheme; added: SchemeObject[] } {
  const used = scheme.objects.map((object) => object.id);
  const added = objects.map((item): SchemeObject => {
    const { part, ...rest } = item;
    const id = nextId(used, 'o');
    used.push(id);
    return { id, ...rest, name: name(part) };
  });
  return { scheme: { ...scheme, objects: [...scheme.objects, ...added] }, added };
}
