/**
 * Схемы локаций plan/schemes.json: вид сверху и виды с четырёх сторон, нарисованные именованными фигурами в метрах.
 * Владелец формата — Go-пакет `internal/schemes`; здесь типы для страницы «Схемы» и общие константы.
 *
 * Координаты общие для всех видов: на виде сверху [восток, север]; на видах сбоку [координата мира по горизонтали,
 * высота] — X мира для видов с севера и юга, Y мира для видов с востока и запада. «Вид с запада» — то, что видит
 * камера, стоящая на западе и смотрящая на восток.
 */

/** Вид схемы. */
export type SchemeViewKind = 'top' | 'north' | 'east' | 'south' | 'west';

/** Виды в порядке показа: обязательный вид сверху первым. */
export const SCHEME_VIEWS: readonly SchemeViewKind[] = ['top', 'north', 'east', 'south', 'west'];

/** Точка в метрах. */
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

/**
 * Именованная фигура. Смысл объекта агент берёт из названия; height (метры) отличает объём, заслоняющий обзор,
 * от плоской поверхности; color нужен только редактору; entity связывает объект с сущностью кастинга.
 */
export interface SchemeObject {
  id: string;
  name: string;
  shape: SchemeShape;
  height?: number;
  color?: string;
  entity?: string;
}

/** Одна схема локации кастинга. */
export interface Scheme {
  id: string;
  location: string;
  title: string;
  view: SchemeViewKind;
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

/** Ответ schemes.view. */
export interface SchemesView {
  document: SchemesFile;
  /** Файла ещё нет: первая запись создаст его. */
  missing: boolean;
  /** Файл не разбирается; запись запрещена, пока его не исправят. */
  damaged: boolean;
  locations: SchemeLocation[];
  problems: string[];
  /** ID локаций без обязательного вида сверху. */
  withoutTop: string[];
}
