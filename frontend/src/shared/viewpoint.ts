import type { SchemePoint, SchemesFile } from './schemes';

/**
 * Точка съёмки плана (`scene.viewpoint` в plan/scenes.json): откуда снимает камера и где стоят герои относительно
 * схем локации. Хранится только то, что ввёл человек: точки, крупность, свой угол. Направление взгляда, сторона по
 * точкам и расстояния считаются здесь из точек и поэтому не расходятся с ними. Проверку формы при сохранении
 * выполняет Go (`internal/scenario/viewpoint.go`).
 *
 * Координаты — метры вида сверху: X на восток, Y на север. Углы — градусы против часовой стрелки от востока.
 */

export const VIEWPOINT_SIDES = ['north', 'east', 'south', 'west', 'top'] as const;
export type ViewpointSide = (typeof VIEWPOINT_SIDES)[number];

export const VIEWPOINT_SIZES = ['wide', 'medium', 'close', 'detail'] as const;
export type ViewpointSize = (typeof VIEWPOINT_SIZES)[number];

/** Место на первом кадре плана и, если меняется, на последнем. */
export interface ViewpointPath {
  start: SchemePoint;
  end?: SchemePoint;
}

/** Герой плана на схеме: сущность из референсов плана и её путь. */
export interface ViewpointSubject extends ViewpointPath {
  entity: string;
}

export interface SceneViewpoint {
  /** ID локации кастинга. */
  location: string;
  /** Где стоит камера; при точках камеры и героев — сторона, вычисленная из них (syncSide). */
  side: ViewpointSide;
  size: ViewpointSize;
  /** Свой угол обзора по горизонтали, градусы; нет — угол крупности. */
  fov?: number;
  camera?: ViewpointPath;
  /** Герои на схеме; первый — в фокусе (главный в кадре). Камера целится так, чтобы в кадр вошли все. */
  subjects?: ViewpointSubject[];
}

/** Что ставится щелчком по мини-схеме: камера или герой (ID сущности). */
export type ViewpointTarget = 'camera' | { entity: string };
export type ViewpointPhase = 'start' | 'end';

/**
 * Угол обзора по горизонтали для крупности, градусы. Крупность говорит, насколько крупно в кадре герой, а что видно
 * за ним, решает угол объектива: обычно чем крупнее план, тем длиннее объектив и уже полоса фона.
 */
export const SIZE_FOV: Record<ViewpointSize, number> = { wide: 60, medium: 40, close: 25, detail: 15 };

/** Допустимый свой угол обзора, градусы. */
export const MIN_FOV = 5;
export const MAX_FOV = 120;

/** Угол обзора точки съёмки: свой или по крупности. */
export function viewpointFov(viewpoint: SceneViewpoint): number {
  return viewpoint.fov ?? SIZE_FOV[viewpoint.size];
}

/**
 * Точка съёмки со своим углом: целые градусы в пределах MIN_FOV–MAX_FOV; угол, совпавший с углом крупности,
 * не хранится — тогда смена крупности снова меняет угол.
 */
export function withFov(viewpoint: SceneViewpoint, fov: number | undefined): SceneViewpoint {
  const { fov: _previous, ...rest } = viewpoint;
  if (fov === undefined || !Number.isFinite(fov)) return rest;
  const value = Math.min(MAX_FOV, Math.max(MIN_FOV, Math.round(fov)));
  return value === SIZE_FOV[viewpoint.size] ? rest : { ...rest, fov: value };
}

/**
 * Направление взгляда по стороне: камера с юга смотрит на север (90°), с севера — на юг (270°), с востока — на
 * запад (180°), с запада — на восток (0°). Сверху направления нет.
 */
export function viewpointHeading(side: ViewpointSide): number | null {
  return { north: 270, east: 180, south: 90, west: 0, top: null }[side];
}

/** Направление от from к to в градусах [0, 360); совпавшие точки — null. */
export function headingBetween(from: SchemePoint, to: SchemePoint): number | null {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  if (Math.hypot(dx, dy) < 1e-9) return null;
  return ((((Math.atan2(dy, dx) * 180) / Math.PI) % 360) + 360) % 360;
}

/**
 * Сторона, на которой стоит камера, смотрящая в направлении heading: противоположная взгляду ближайшая сторона
 * света. Взгляд на восток — камера с запада, на север — с юга. Ровно диагональ (45°, 135°…) относится к стороне
 * по часовой стрелке от неё: 45° (северо-восток) — к востоку, значит камера с запада.
 */
export function sideOfHeading(heading: number): Exclude<ViewpointSide, 'top'> {
  const normalized = ((heading % 360) + 360) % 360;
  // Индекс ближайшей стороны взгляда: 0 — восток, 1 — север, 2 — запад, 3 — юг; граница уходит к меньшему углу.
  const index = Math.ceil(normalized / 90 - 0.5) % 4;
  return (['west', 'south', 'east', 'north'] as const)[index];
}

/** Расстояние между точками, метры. */
export function distance(a: SchemePoint, b: SchemePoint): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Место на кадре phase: конец, если задан, иначе начало (неподвижный). */
export function pathPoint(path: ViewpointPath | undefined, phase: ViewpointPhase): SchemePoint | undefined {
  return phase === 'end' ? (path?.end ?? path?.start) : path?.start;
}

/** Герой в фокусе: первый на схеме. */
export function focusSubject(viewpoint: SceneViewpoint): ViewpointSubject | undefined {
  return viewpoint.subjects?.[0];
}

/** Угол от heading до angle в градусах (−180, 180]: положительный — против часовой стрелки, влево в кадре. */
export function angleFrom(heading: number, angle: number): number {
  const delta = (((angle - heading) % 360) + 360) % 360;
  return delta > 180 ? delta - 360 : delta;
}

/**
 * Прицел камеры из точки camera на героев points: середина их углового разброса, если смотреть из камеры. При таком
 * направлении все герои входят в кадр при наименьшем угле обзора. Герой в точке камеры направления не даёт; без
 * героев с направлением — null.
 */
export function aimHeading(camera: SchemePoint, points: readonly SchemePoint[]): number | null {
  const headings = points.map((point) => headingBetween(camera, point)).filter((heading): heading is number => heading !== null);
  if (!headings.length) return null;
  const offsets = headings.map((heading) => angleFrom(headings[0], heading));
  return (((headings[0] + (Math.min(...offsets) + Math.max(...offsets)) / 2) % 360) + 360) % 360;
}

/** Места героев на кадре phase в порядке списка. */
export function subjectPoints(viewpoint: SceneViewpoint, phase: ViewpointPhase): SchemePoint[] {
  return (viewpoint.subjects ?? []).map((subject) => pathPoint(subject, phase)!);
}

/**
 * Направление взгляда на кадре phase: прицел на всех героев (aimHeading), если стоят камера и хотя бы один герой
 * не в её точке; иначе по стороне. Камера сверху направления не имеет — null.
 */
export function lookHeading(viewpoint: SceneViewpoint, phase: ViewpointPhase): number | null {
  if (viewpoint.side === 'top') return null;
  const camera = pathPoint(viewpoint.camera, phase);
  const aim = camera ? aimHeading(camera, subjectPoints(viewpoint, phase)) : null;
  return aim ?? viewpointHeading(viewpoint.side);
}

/** Сторона определяется точками: на первом кадре есть камера и герои, дающие прицел; камера не сверху. */
export function sideFromPoints(viewpoint: SceneViewpoint): boolean {
  const camera = viewpoint.camera?.start;
  return viewpoint.side !== 'top' && !!camera && aimHeading(camera, subjectPoints(viewpoint, 'start')) !== null;
}

/** Точка съёмки, у которой сторона приведена к прицелу первого кадра (если точки его дают). */
export function syncSide(viewpoint: SceneViewpoint): SceneViewpoint {
  if (!sideFromPoints(viewpoint)) return viewpoint;
  const side = sideOfHeading(aimHeading(viewpoint.camera!.start, subjectPoints(viewpoint, 'start'))!);
  return side === viewpoint.side ? viewpoint : { ...viewpoint, side };
}

/**
 * Входит ли место point в кадр камеры на кадре phase по горизонтали: угол от направления взгляда не больше половины
 * угла обзора. Без камеры или у камеры сверху — null: судить не по чему.
 */
export function inFrame(viewpoint: SceneViewpoint, phase: ViewpointPhase, point: SchemePoint): boolean | null {
  const camera = pathPoint(viewpoint.camera, phase);
  const heading = lookHeading(viewpoint, phase);
  if (!camera || heading === null) return null;
  const angle = headingBetween(camera, point);
  return angle === null || Math.abs(angleFrom(heading, angle)) <= viewpointFov(viewpoint) / 2 + 1e-9;
}

const sameTarget = (subject: ViewpointSubject, target: ViewpointTarget): boolean => target !== 'camera' && subject.entity === target.entity;

/** Путь камеры или героя. */
export function targetPath(viewpoint: SceneViewpoint, target: ViewpointTarget): ViewpointPath | undefined {
  return target === 'camera' ? viewpoint.camera : viewpoint.subjects?.find((subject) => sameTarget(subject, target));
}

/**
 * Ставит камеру или героя в point на кадре phase. Конец без начала ставит начало: путь начинается с первого кадра.
 * Новый герой встаёт в конец списка, фокус не меняется. Сторона приводится к точкам.
 */
export function setPoint(viewpoint: SceneViewpoint, target: ViewpointTarget, phase: ViewpointPhase, point: SchemePoint): SceneViewpoint {
  const current = targetPath(viewpoint, target);
  const path: ViewpointPath = !current || phase === 'start' ? { ...current, start: point } : { ...current, end: point };
  if (target === 'camera') return syncSide({ ...viewpoint, camera: { start: path.start, ...(path.end ? { end: path.end } : {}) } });
  const subject: ViewpointSubject = { entity: target.entity, start: path.start, ...(path.end ? { end: path.end } : {}) };
  const subjects = viewpoint.subjects ?? [];
  const next = current ? subjects.map((item) => (sameTarget(item, target) ? subject : item)) : [...subjects, subject];
  return syncSide({ ...viewpoint, subjects: next });
}

/** Убирает конец пути (phase end) или камеру либо героя целиком (phase start). Пустой список героев не хранится. */
export function removePoint(viewpoint: SceneViewpoint, target: ViewpointTarget, phase: ViewpointPhase): SceneViewpoint {
  const strip = <T extends ViewpointPath>(path: T): T => {
    const { end: _end, ...rest } = path;
    return rest as T;
  };
  if (target === 'camera') {
    const { camera, ...rest } = viewpoint;
    return phase === 'end' && camera ? { ...rest, camera: strip(camera) } : rest;
  }
  const { subjects = [], ...rest } = viewpoint;
  const next = phase === 'end' ? subjects.map((item) => (sameTarget(item, target) ? strip(item) : item)) : subjects.filter((item) => !sameTarget(item, target));
  return syncSide(next.length ? { ...rest, subjects: next } : rest);
}

/** Ставит героя в фокус: он становится первым, остальные сохраняют порядок. */
export function setFocus(viewpoint: SceneViewpoint, entity: string): SceneViewpoint {
  const subjects = viewpoint.subjects ?? [];
  const chosen = subjects.find((subject) => subject.entity === entity);
  if (!chosen) return viewpoint;
  return syncSide({ ...viewpoint, subjects: [chosen, ...subjects.filter((subject) => subject !== chosen)] });
}

/** Без мест камеры и героев: смена локации делает точки другой схемы бессмысленными. */
export function withoutPoints(viewpoint: SceneViewpoint): SceneViewpoint {
  const { camera: _camera, subjects: _subjects, ...rest } = viewpoint;
  return rest;
}

/** Есть ли у пути движение: конец задан и отличается от начала. */
export function moves(path: ViewpointPath | undefined): boolean {
  return !!path?.end && distance(path.start, path.end) > 1e-9;
}

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Точка на расстоянии length от at в направлении angle. */
export function pointAt(at: SchemePoint, angle: number, length: number): SchemePoint {
  return [at[0] + length * Math.cos(radians(angle)), at[1] + length * Math.sin(radians(angle))];
}

/**
 * Сектор обзора для отрисовки: место камеры, затем дуга радиусом length от левого края кадра к правому
 * (левый край — против часовой от направления взгляда).
 */
export function viewSector(at: SchemePoint, heading: number, fov: number, length: number, steps = 16): SchemePoint[] {
  const arc = Array.from({ length: steps + 1 }, (_, index) => pointAt(at, heading + fov / 2 - (fov * index) / steps, length));
  return [at, ...arc];
}

/** Угол обзора, при котором край сектора проходит через point: удвоенный угол между взглядом и направлением на point. */
export function fovThrough(at: SchemePoint, heading: number, point: SchemePoint): number {
  return Math.abs(angleFrom(heading, headingBetween(at, point) ?? heading)) * 2;
}

/** Есть ли у локации схема вида сверху. */
export function hasTopScheme(schemes: SchemesFile | null, location: string): boolean {
  return !!schemes?.schemes.some((scheme) => scheme.location === location && scheme.view === 'top');
}

/**
 * Новая точка съёмки: локация — единственная локация с видом сверху, иначе первая локация кастинга; камера с юга,
 * общий план. Без локаций в кастинге точку не создать — null.
 */
export function createViewpoint(locations: readonly string[], schemes: SchemesFile | null): SceneViewpoint | null {
  if (!locations.length) return null;
  const withTop = locations.filter((location) => hasTopScheme(schemes, location));
  return { location: withTop.length === 1 ? withTop[0] : locations[0], side: 'south', size: 'wide' };
}
