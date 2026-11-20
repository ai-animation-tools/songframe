/**
 * Схемы локаций plan/schemes.json: вид сверху, нарисованный именованными фигурами в метрах, с необязательным объёмом
 * объектов. У локации одна схема; её стороны показывает объём (3D и вид из камеры точки съёмки).
 * Владелец формата — Go-пакет `internal/schemes`; здесь типы для страницы «Схемы» и общие константы.
 */

/** Точка на земле в метрах: [восток, север]. */
export type SchemePoint = [number, number];

/** Геометрия объекта; набор полей зависит от type. */
export type SchemeShape =
  | { type: 'rect'; center: SchemePoint; size: SchemePoint; rotation?: number }
  | { type: 'ellipse'; center: SchemePoint; radii: SchemePoint; rotation?: number }
  | { type: 'polygon'; points: SchemePoint[] }
  | { type: 'line'; points: SchemePoint[]; smooth?: boolean; closed?: boolean; width?: number }
  | { type: 'point'; at: SchemePoint };

/** Тип фигуры. */
export type SchemeShapeType = SchemeShape['type'];

/** Форма верха объёма: гребень вдоль оси фигуры, скат в одну сторону, шатёр к центру. */
export type SchemeTopForm = 'ridge' | 'slope' | 'tent';
export const SCHEME_TOP_FORMS: readonly SchemeTopForm[] = ['ridge', 'slope', 'tent'];

/** Собственная ось фигуры до поворота: x — первый размер (без поворота — восток), y — второй (север). */
export type SchemeAxis = 'x' | 'y';
/** Сторона фигуры, куда опускается скат. */
export type SchemeSlopeDown = '+x' | '-x' | '+y' | '-y';

/** Верх объёма над телом: поднимается на rise метров; axis — у гребня, down — у ската. */
export type SchemeTop =
  { form: 'ridge'; rise: number; axis: SchemeAxis } | { form: 'slope'; rise: number; down: SchemeSlopeDown } | { form: 'tent'; rise: number };

/**
 * Именованная фигура. Смысл объекта агент берёт из названия; color нужен только редактору; entity связывает объект
 * с сущностью кастинга.
 *
 * Объём: тело — фигура, поднятая на height метров от низа (нет или 0 — плоская поверхность);
 * elevation поднимает низ над землёй; top — верх над телом; body «ellipsoid» — округлое тело вместо призмы.
 * Допустимые сочетания проверяет Go (`internal/schemes`).
 */
export interface SchemeObject {
  id: string;
  name: string;
  shape: SchemeShape;
  height?: number;
  elevation?: number;
  top?: SchemeTop;
  body?: 'ellipsoid';
  color?: string;
  entity?: string;
}

/** Схема локации кастинга; у локации одна схема. */
export interface Scheme {
  id: string;
  location: string;
  title: string;
  objects: SchemeObject[];
}

/** plan/schemes.json. */
export interface SchemesFile {
  schema_version: 1;
  schemes: Scheme[];
}

/** Локация кастинга, к которой привязываются схемы. */
export interface SchemeLocation {
  id: string;
  name: string;
}

/** Сущность кастинга, с которой можно связать объект схемы (без мира сцены). */
export interface SchemeEntity {
  id: string;
  name: string;
  kind: string;
}

/** Ответ schemes.view. */
export interface SchemesView {
  document: SchemesFile;
  /** Файла ещё нет: первая запись создаст его. */
  missing: boolean;
  /** Файл не разбирается; запись запрещена, пока его не исправят. */
  damaged: boolean;
  locations: SchemeLocation[];
  entities: SchemeEntity[];
  problems: string[];
  /** ID локаций без схемы. */
  withoutScheme: string[];
}
