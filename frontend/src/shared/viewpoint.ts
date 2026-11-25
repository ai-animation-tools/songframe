import type { Scheme, SchemePoint, SchemeShape, SchemesFile } from './schemes';
import { ellipseOutline, rectCorners, smoothCurve } from './scheme-editing';

/**
 * Точка съёмки плана (`scene.viewpoint` в plan/scenes.json): откуда снимает камера и где стоят герои относительно
 * схем локации. Хранится только то, что ввёл человек: точки, крупность, свой угол. Направление взгляда, сторона по
 * точкам и расстояния считаются здесь из точек и поэтому не расходятся с ними. Проверку формы при сохранении
 * выполняет Go (`internal/scenario/viewpoint.go`).
 *
 * Координаты — метры схемы локации: X на восток, Y на север. Углы — градусы против часовой стрелки от востока.
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

/** Своё направление камеры на первом кадре и, если поворачивается, на последнем: градусы [0, 360). */
export interface ViewpointHeading {
  start: number;
  end?: number;
}

/** Своя высота камеры над землёй на первом кадре и, если меняется (кран, дрон), на последнем: метры (0, 500]. */
export interface ViewpointHeight {
  start: number;
  end?: number;
}

/** Свой наклон взгляда камеры на первом кадре и, если меняется, на последнем: градусы [−90, 90], минус — вниз. */
export interface ViewpointTilt {
  start: number;
  end?: number;
}

/** Предел своего наклона камеры, градусы (как проверяет Go): отвесно вниз или вверх. */
export const MAX_TILT = 90;

/** Высота камеры по умолчанию, м: съёмка с рук или штатива на уровне глаз. */
export const DEFAULT_CAMERA_HEIGHT = 1.6;
/** Границы своей высоты камеры, м (как проверяет Go): от земли до съёмки с дрона. */
export const MIN_CAMERA_HEIGHT = 0.05;
export const MAX_CAMERA_HEIGHT = 500;

/** Герой плана на схеме: сущность из референсов плана и её путь. */
export interface ViewpointSubject extends ViewpointPath {
  entity: string;
  /**
   * Куда герой смотрит передом, градусы [0, 360) как у направления камеры. Нужно стоящей машине: у движущейся
   * направление следует из хода, без поля машина стоит передом к камере (subjectFacing).
   */
  facing?: number;
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
  /** Своё направление камеры; нет — камера целится в героев (aimHeading). */
  heading?: ViewpointHeading;
  /** Своя высота камеры; нет — уровень глаз (DEFAULT_CAMERA_HEIGHT). */
  camera_height?: ViewpointHeight;
  /** Свой наклон камеры; нет — камера наклоняется к главному герою (lookPitch). */
  tilt?: ViewpointTilt;
  /**
   * Герои на схеме; первый — главный: на середину его роста наклоняется камера (со своим направлением без поворота —
   * по первому кадру на весь план, lookPitch). Камера целится так, чтобы в кадр вошли все.
   */
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

/**
 * Куда герой index смотрит передом на кадре phase, градусы против часовой стрелки от востока: своё направление
 * facing; у движущегося — по ходу от start к end; иначе — к камере. Без камеры и хода — на восток. Так же считает Go
 * (viewframe.Viewpoint.Facing): по направлению ставится фигура машины.
 */
export function subjectFacing(viewpoint: SceneViewpoint, index: number, phase: ViewpointPhase): number {
  const subject = viewpoint.subjects![index];
  if (subject.facing !== undefined) return ((subject.facing % 360) + 360) % 360;
  if (moves(subject)) return headingBetween(subject.start, subject.end!) ?? 0;
  const camera = pathPoint(viewpoint.camera, phase);
  return (camera && headingBetween(pathPoint(subject, phase)!, camera)) ?? 0;
}

/** Точка съёмки, где герой entity смотрит передом в degrees (целые градусы [0, 360)); undefined — по умолчанию. */
export function setFacing(viewpoint: SceneViewpoint, entity: string, degrees: number | undefined): SceneViewpoint {
  return {
    ...viewpoint,
    subjects: (viewpoint.subjects ?? []).map((subject) => {
      if (subject.entity !== entity) return subject;
      const { facing: _previous, ...rest } = subject;
      return degrees === undefined || !Number.isFinite(degrees) ? rest : { ...rest, facing: ((Math.round(degrees) % 360) + 360) % 360 };
    })
  };
}

/** Место на кадре phase: конец, если задан, иначе начало (неподвижный). */
export function pathPoint(path: ViewpointPath | undefined, phase: ViewpointPhase): SchemePoint | undefined {
  return phase === 'end' ? (path?.end ?? path?.start) : path?.start;
}

/** Главный герой: первый на схеме. */
export function leadSubject(viewpoint: SceneViewpoint): ViewpointSubject | undefined {
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

/** Прицел на героев на кадре phase без учёта своего направления; без камеры или героев с направлением — null. */
export function autoHeading(viewpoint: SceneViewpoint, phase: ViewpointPhase): number | null {
  const camera = pathPoint(viewpoint.camera, phase);
  return camera ? aimHeading(camera, subjectPoints(viewpoint, phase)) : null;
}

/**
 * Направление взгляда на кадре phase: своё направление человека (на последнем кадре без своего конца — как на
 * первом: камера не поворачивается); иначе прицел на всех героев (aimHeading), если стоят камера и хотя бы один
 * герой не в её точке; иначе по стороне. Камера сверху направления не имеет — null.
 */
export function lookHeading(viewpoint: SceneViewpoint, phase: ViewpointPhase): number | null {
  if (viewpoint.side === 'top') return null;
  if (viewpoint.heading && viewpoint.camera) return phase === 'end' ? (viewpoint.heading.end ?? viewpoint.heading.start) : viewpoint.heading.start;
  const camera = pathPoint(viewpoint.camera, phase);
  const aim = camera ? aimHeading(camera, subjectPoints(viewpoint, phase)) : null;
  return aim ?? viewpointHeading(viewpoint.side);
}

/** Сторона определяется точками: есть камера и своё направление или герои, дающие прицел; камера не сверху. */
export function sideFromPoints(viewpoint: SceneViewpoint): boolean {
  return viewpoint.side !== 'top' && !!viewpoint.camera && (!!viewpoint.heading || autoHeading(viewpoint, 'start') !== null);
}

/** Точка съёмки, у которой сторона приведена к направлению первого кадра (если точки его дают). */
export function syncSide(viewpoint: SceneViewpoint): SceneViewpoint {
  if (!sideFromPoints(viewpoint)) return viewpoint;
  const side = sideOfHeading(lookHeading(viewpoint, 'start')!);
  return side === viewpoint.side ? viewpoint : { ...viewpoint, side };
}

/**
 * Своё направление камеры на кадре phase, целые градусы [0, 360). Конец без своего начала берёт началом текущее
 * направление первого кадра: поворот начинается оттуда, где камера смотрит сейчас. Конец, совпавший с началом, не
 * хранится. Сторона приводится к направлению.
 */
export function setHeading(viewpoint: SceneViewpoint, phase: ViewpointPhase, degrees: number): SceneViewpoint {
  const value = ((Math.round(degrees) % 360) + 360) % 360;
  const start = phase === 'start' ? value : (viewpoint.heading?.start ?? Math.round(lookHeading(viewpoint, 'start') ?? value) % 360);
  const end = phase === 'end' ? value : viewpoint.heading?.end;
  return syncSide({ ...viewpoint, heading: { start, ...(end !== undefined && end !== start ? { end } : {}) } });
}

/** Без своего направления: камера снова целится в героев. Сторона приводится к прицелу. */
export function withoutHeading(viewpoint: SceneViewpoint): SceneViewpoint {
  const { heading: _heading, ...rest } = viewpoint;
  return syncSide(rest);
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
 * Новый герой встаёт в конец списка, главный не меняется. Сторона приводится к точкам.
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
    // Без камеры своё направление теряет смысл и уходит вместе с ней.
    const { camera, heading, ...rest } = viewpoint;
    return phase === 'end' && camera ? { ...rest, ...(heading ? { heading } : {}), camera: strip(camera) } : rest;
  }
  const { subjects = [], ...rest } = viewpoint;
  const next = phase === 'end' ? subjects.map((item) => (sameTarget(item, target) ? strip(item) : item)) : subjects.filter((item) => !sameTarget(item, target));
  return syncSide(next.length ? { ...rest, subjects: next } : rest);
}

/**
 * Оставляет в точке съёмки только героев из референсов плана: карта ставит и показывает в строках только их,
 * а проверка сценария героя вне референсов не принимает. Порядок сохраняется, поэтому без прежнего главного
 * главным становится следующий герой. Без изменений возвращает тот же объект.
 */
export function withReferences(viewpoint: SceneViewpoint, references: readonly string[]): SceneViewpoint {
  const subjects = viewpoint.subjects ?? [];
  const kept = subjects.filter((subject) => references.includes(subject.entity));
  if (kept.length === subjects.length) return viewpoint;
  const { subjects: _subjects, ...rest } = viewpoint;
  return syncSide(kept.length ? { ...rest, subjects: kept } : rest);
}

/** Делает героя главным: он становится первым, остальные сохраняют порядок. */
export function setLead(viewpoint: SceneViewpoint, entity: string): SceneViewpoint {
  const subjects = viewpoint.subjects ?? [];
  const chosen = subjects.find((subject) => subject.entity === entity);
  if (!chosen) return viewpoint;
  return syncSide({ ...viewpoint, subjects: [chosen, ...subjects.filter((subject) => subject !== chosen)] });
}

/** Без мест камеры и героев и своего направления: смена локации делает точки другой схемы бессмысленными. */
export function withoutPoints(viewpoint: SceneViewpoint): SceneViewpoint {
  const { camera: _camera, heading: _heading, subjects: _subjects, ...rest } = viewpoint;
  return rest;
}

/** Высота камеры на кадре phase, м: своя (на последнем кадре — конец, иначе начало) или уровень глаз. */
export function cameraHeight(viewpoint: SceneViewpoint, phase: ViewpointPhase): number {
  const own = viewpoint.camera_height;
  if (!own) return DEFAULT_CAMERA_HEIGHT;
  return phase === 'end' ? (own.end ?? own.start) : own.start;
}

/** Меняется ли высота камеры за план. */
export function heightMoves(viewpoint: SceneViewpoint): boolean {
  return viewpoint.camera_height?.end !== undefined;
}

/**
 * Своя высота камеры на кадре phase, округлённая до сантиметра и прижатая к границам. Конец, равный началу, не
 * хранится; уровень глаз без подъёма — тоже: в файле только то, что отличается от умолчания.
 */
export function setCameraHeight(viewpoint: SceneViewpoint, phase: ViewpointPhase, metres: number): SceneViewpoint {
  const value = Math.round(Math.min(MAX_CAMERA_HEIGHT, Math.max(MIN_CAMERA_HEIGHT, metres)) * 100) / 100;
  const start = phase === 'start' ? value : (viewpoint.camera_height?.start ?? DEFAULT_CAMERA_HEIGHT);
  const end = phase === 'end' ? value : viewpoint.camera_height?.end;
  const { camera_height: _height, ...rest } = viewpoint;
  const keepEnd = end !== undefined && end !== start;
  if (start === DEFAULT_CAMERA_HEIGHT && !keepEnd) return rest;
  return { ...rest, camera_height: { start, ...(keepEnd ? { end } : {}) } };
}

/** Свой наклон камеры на кадре phase, градусы (на последнем кадре — конец, иначе начало); без своего — null. */
export function ownTilt(viewpoint: SceneViewpoint, phase: ViewpointPhase): number | null {
  const own = viewpoint.tilt;
  if (!own) return null;
  return phase === 'end' ? (own.end ?? own.start) : own.start;
}

/** Меняется ли свой наклон камеры за план. */
export function tiltMoves(viewpoint: SceneViewpoint): boolean {
  return viewpoint.tilt?.end !== undefined;
}

/**
 * Свой наклон камеры на кадре phase, округлённый до градуса и прижатый к границам. Без своего наклона начало
 * берётся из from — текущего наклона по герою, чтобы конец не задавался без начала. Конец, равный началу, не
 * хранится.
 */
export function setTilt(viewpoint: SceneViewpoint, phase: ViewpointPhase, degrees: number, from = 0): SceneViewpoint {
  const clampTilt = (value: number): number => Math.round(Math.min(MAX_TILT, Math.max(-MAX_TILT, value)));
  const value = clampTilt(degrees);
  const start = phase === 'start' ? value : clampTilt(viewpoint.tilt?.start ?? from);
  const end = phase === 'end' ? value : viewpoint.tilt?.end;
  const keepEnd = end !== undefined && end !== start;
  return { ...viewpoint, tilt: { start, ...(keepEnd ? { end } : {}) } };
}

/** Без своего наклона на последнем кадре (phase 'end') или совсем (без phase): камера снова наклоняется к герою. */
export function withoutTilt(viewpoint: SceneViewpoint, phase?: ViewpointPhase): SceneViewpoint {
  const { tilt, ...rest } = viewpoint;
  if (phase === 'end' && tilt) return { ...rest, tilt: { start: tilt.start } };
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

/** Есть ли у локации схема. */
export function hasScheme(schemes: SchemesFile | null, location: string): boolean {
  return !!schemes?.schemes.some((scheme) => scheme.location === location);
}

/**
 * Новая точка съёмки: локация — единственная локация с видом сверху, иначе первая локация кастинга; камера с юга,
 * общий план. Без локаций в кастинге точку не создать — null.
 */
export function createViewpoint(locations: readonly string[], schemes: SchemesFile | null): SceneViewpoint | null {
  if (!locations.length) return null;
  const drawn = locations.filter((location) => hasScheme(schemes, location));
  return { location: drawn.length === 1 ? drawn[0] : locations[0], side: 'south', size: 'wide' };
}

/** Кусок следа фигуры на земле: замкнутый контур или ломаная. */
export interface FootprintPart {
  points: SchemePoint[];
  closed: boolean;
}

/**
 * След фигуры схемы на земле: углы прямоугольника, контур эллипса, многоугольник, линия (гладкая — по кривой, как на
 * холсте; с шириной — полосой по прямоугольнику на каждый отрезок), точка. Нужен референсам плана, нарисованным на
 * схеме объектом: их место и размер берутся из следа. Тот же след считает Go для фактов кадра
 * (`internal/viewframe`), общая таблица случаев сверяет обе стороны.
 */
export function shapeFootprint(shape: SchemeShape): FootprintPart[] {
  switch (shape.type) {
    case 'rect':
      return [{ points: rectCorners(shape), closed: true }];
    case 'ellipse':
      return [{ points: ellipseOutline(shape), closed: true }];
    case 'polygon':
      return [{ points: shape.points, closed: true }];
    case 'line': {
      const points = shape.smooth ? smoothCurve(shape.points, !!shape.closed) : shape.points;
      return shape.width && shape.width > 0 ? band(points, !!shape.closed, shape.width) : [{ points, closed: !!shape.closed }];
    }
    case 'point':
      return [{ points: [shape.at], closed: false }];
  }
}

/** Полоса шириной width вдоль ломаной: прямоугольник на каждый отрезок; одна точка — квадрат шириной полосы. */
function band(points: readonly SchemePoint[], closed: boolean, width: number): FootprintPart[] {
  const parts: FootprintPart[] = [];
  const segments = closed ? points.length : points.length - 1;
  for (let index = 0; index < segments; index++) {
    const [a, b] = [points[index], points[(index + 1) % points.length]];
    const length = distance(a, b);
    if (length < 1e-9) continue;
    const [nx, ny] = [(-(b[1] - a[1]) / length) * (width / 2), ((b[0] - a[0]) / length) * (width / 2)];
    parts.push({
      points: [
        [a[0] - nx, a[1] - ny],
        [b[0] - nx, b[1] - ny],
        [b[0] + nx, b[1] + ny],
        [a[0] + nx, a[1] + ny]
      ],
      closed: true
    });
  }
  if (!parts.length && points.length) {
    const [[x, y], half] = [points[0], width / 2];
    parts.push({
      points: [
        [x - half, y - half],
        [x + half, y - half],
        [x + half, y + half],
        [x - half, y + half]
      ],
      closed: true
    });
  }
  return parts;
}

/** Расстояние от p до отрезка ab, метры. */
function segmentDistance(p: SchemePoint, a: SchemePoint, b: SchemePoint): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const length = dx * dx + dy * dy;
  const t = length ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Лежит ли точка внутри замкнутого контура (чётность пересечений луча). */
function insideOutline(p: SchemePoint, points: readonly SchemePoint[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [a, b] = [points[i], points[j]];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Предмет схемы, связанный с референсом плана: как его видно с камеры. */
export interface FootprintView {
  /** До ближайшей точки контура, метры; камера внутри замкнутого контура — 0. */
  distance: number;
  /** Входит ли в угол обзора хоть часть контура; у камеры сверху — null. */
  inFrame: boolean | null;
}

/**
 * Как с камеры на кадре phase виден предмет, нарисованный на схеме одной или несколькими фигурами: расстояние до
 * ближайшего края и попадает ли в кадр хоть часть. В кадре — если угловой разброс контура пересекается с углом
 * обзора: длинная стена, концы которой за краями кадра, всё равно в кадре. Без камеры — null.
 */
export function footprintView(viewpoint: SceneViewpoint, phase: ViewpointPhase, shapes: readonly SchemeShape[]): FootprintView | null {
  const camera = pathPoint(viewpoint.camera, phase);
  if (!camera || !shapes.length) return null;
  let nearest = Infinity;
  let around = false;
  // Углы точек контура от камеры — смещениями от угла на первую точку: так разброс не рвётся на переходе через 0°.
  let reference: number | null = null;
  let low = 0;
  let high = 0;
  for (const { points, closed } of shapes.flatMap(shapeFootprint)) {
    if (closed && points.length > 2 && insideOutline(camera, points)) around = true;
    const edges = points.length > 1 ? points.length - (closed ? 0 : 1) : 0;
    nearest = Math.min(
      nearest,
      edges
        ? Math.min(...Array.from({ length: edges }, (_, i) => segmentDistance(camera, points[i], points[(i + 1) % points.length])))
        : distance(camera, points[0])
    );
    for (const point of points) {
      const angle = headingBetween(camera, point);
      if (angle === null) {
        around = true;
        continue;
      }
      reference ??= angle;
      const offset = angleFrom(reference, angle);
      low = Math.min(low, offset);
      high = Math.max(high, offset);
    }
  }
  const heading = lookHeading(viewpoint, phase);
  let inFrame: boolean | null = null;
  if (heading !== null) {
    // Разброс контура — дуга с серединой center и полушириной spread: в кадре, если она пересекает угол обзора.
    const center = reference === null ? heading : reference + (low + high) / 2;
    const spread = (high - low) / 2;
    inFrame = around || Math.abs(angleFrom(heading, center)) <= viewpointFov(viewpoint) / 2 + spread + 1e-9;
  }
  return { distance: around ? 0 : nearest, inFrame };
}

/** Фигуры схемы scheme, связанные с сущностью entity; пусто — референс не нарисован на схеме. */
export function linkedShapes(scheme: Scheme | null, entity: string): SchemeShape[] {
  return scheme ? scheme.objects.filter((object) => object.entity === entity).map((object) => object.shape) : [];
}
