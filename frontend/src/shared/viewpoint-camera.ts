import type { Camera3D } from './camera3d';
import type { SchemeObject, SchemePoint } from './schemes';
import { objectVolume, type Triangle } from './scheme-volume';
import {
  DEFAULT_CAMERA_HEIGHT,
  cameraHeight,
  distance,
  leadSubject,
  ownTilt,
  lookHeading,
  pathPoint,
  pointAt,
  subjectFacing,
  viewpointFov,
  type SceneViewpoint,
  type ViewpointPhase
} from './viewpoint';

/**
 * Вид из камеры точки съёмки: перспективная камера и условные фигуры героев для объёма схемы локации. Всё
 * вычисляется из точек плана и кастинга и не хранится: камера стоит в своей точке на своей высоте (по умолчанию —
 * уровень глаз) и смотрит по прицелу на всех героев (lookHeading) с наклоном к середине фигуры главного героя
 * (lookPitch) или, без героев, горизонтально по стороне. Герои — цилиндры ростом из кастинга, без роста — условные 1,7 м: они
 * показывают, где герой стоит и что его заслоняет, а не его облик. Машины (сущности кастинга вида «Транспорт») —
 * коробка кузова с кабиной по типовым габаритам легкового автомобиля, длинной стороной по направлению subjectFacing:
 * цилиндр человека на месте машины сбивал бы генератор, которому снимок вида даётся как схема композиции. Так же
 * машину считает Go в фактах кадра (internal/viewframe/vehicle.go). Камера сверху висит над точкой и смотрит вниз;
 * её кадр и есть схема, отдельного вида у неё нет.
 */

/** Высота камеры по умолчанию, м: съёмка с рук или штатива на уровне глаз. */
export const EYE_HEIGHT = DEFAULT_CAMERA_HEIGHT;
/** Условная фигура героя: рост без заданного в кастинге и радиус цилиндра, м. */
export const FIGURE_HEIGHT = 1.7;
export const FIGURE_RADIUS = 0.25;
/** Машина: длина, ширина и высота без заданной в кастинге, м; кузов — нижние две трети высоты, выше — кабина. */
export const VEHICLE_LENGTH = 4.6;
export const VEHICLE_WIDTH = 1.8;
export const VEHICLE_HEIGHT = 1.5;
/** Взгляд без главного героя: точка на этом расстоянии по направлению стороны, м. */
const LOOK_AHEAD = 10;

/** Рост сущностей кастинга по ID, м; сущности без роста в карте нет. */
export type FigureHeights = Readonly<Record<string, number>>;

/** ID сущностей кастинга, которые на виде из камеры — машины. */
export type FigureVehicles = readonly string[];

/** Рост героя или высота машины entity: из кастинга, иначе типовые VEHICLE_HEIGHT или FIGURE_HEIGHT. */
export function figureHeight(heights: FigureHeights, entity: string, vehicles: FigureVehicles = []): number {
  return heights[entity] ?? (vehicles.includes(entity) ? VEHICLE_HEIGHT : FIGURE_HEIGHT);
}

/** Камера вида на кадре phase; без точки камеры или при камере сверху — null. */
export function viewpointCamera(viewpoint: SceneViewpoint, phase: ViewpointPhase, heights: FigureHeights = {}, vehicles: FigureVehicles = []): Camera3D | null {
  const at = pathPoint(viewpoint.camera, phase);
  const heading = lookHeading(viewpoint, phase);
  if (!at || heading === null) return null;
  const subject = leadSubject(viewpoint);
  const lead = pathPoint(subject, phase);
  const height = cameraHeight(viewpoint, phase);
  const eye: Camera3D['eye'] = [at[0], at[1], height];
  // Цель взгляда — на расстоянии главного героя (без него или с героем в точке камеры — вдаль) с наклоном lookPitch.
  const reach = lead ? distance(at, lead) : 0;
  const depth = reach > 1e-9 ? reach : LOOK_AHEAD;
  const ahead = pointAt(at, heading, depth);
  const target: Camera3D['target'] = [ahead[0], ahead[1], height + depth * Math.tan(lookPitch(viewpoint, phase, heights, vehicles))];
  return { eye, target, fov: viewpointFov(viewpoint) };
}

/**
 * Наклон взгляда на кадре phase, радианы, минус — вниз; так же считает Go (viewframe.Viewpoint.Pitch) для фактов
 * кадра агента. Свой наклон человека (tilt) берётся как есть. Без него камера смотрит на середину фигуры главного героя на его расстоянии; без героя или с героем в точке
 * камеры — горизонтально. Камера со своим направлением без поворота держит наклон первого кадра весь план: она не
 * поворачивается и по высоте. Камера, которая целится в героев или поворачивается, ведёт главного героя и наклоном.
 */
export function lookPitch(viewpoint: SceneViewpoint, phase: ViewpointPhase, heights: FigureHeights = {}, vehicles: FigureVehicles = []): number {
  const own = ownTilt(viewpoint, phase);
  if (own !== null) return (own * Math.PI) / 180;
  const from: ViewpointPhase = viewpoint.heading && viewpoint.heading.end === undefined ? 'start' : phase;
  const subject = leadSubject(viewpoint);
  const at = pathPoint(viewpoint.camera, from);
  const lead = pathPoint(subject, from);
  if (!subject || !at || !lead) return 0;
  const reach = distance(at, lead);
  return reach > 1e-9 ? Math.atan2(figureHeight(heights, subject.entity, vehicles) / 2 - cameraHeight(viewpoint, from), reach) : 0;
}

/** Фигура героя на кадре phase: ID сущности, главный ли он, задан ли его рост и треугольники цилиндра или машины. */
export interface SubjectFigure {
  entity: string;
  lead: boolean;
  /** Рост из кастинга; false — условная фигура FIGURE_HEIGHT или типовая высота машины. */
  measured: boolean;
  triangles: Triangle[];
}

/** Треугольники машины высотой height в at, передом в facing градусов: кузов и кабина, сдвинутая назад. */
function vehicleTriangles(entity: string, at: SchemePoint, facing: number, height: number): Triangle[] {
  const body = (height * 2) / 3;
  const back = (facing * Math.PI) / 180;
  const shift = 0.3;
  const cabin: SchemePoint = [at[0] - Math.cos(back) * shift, at[1] - Math.sin(back) * shift];
  const part = (id: string, center: SchemePoint, size: SchemePoint, elevation: number, partHeight: number): SchemeObject => ({
    id: `${entity}:${id}`,
    name: entity,
    shape: { type: 'rect', center, size, rotation: facing },
    elevation,
    height: partHeight
  });
  return [
    ...objectVolume(part('body', at, [VEHICLE_LENGTH, VEHICLE_WIDTH], 0, body)),
    ...objectVolume(part('cabin', cabin, [VEHICLE_LENGTH * 0.52, VEHICLE_WIDTH * 0.94], body, height - body))
  ];
}

/**
 * Фигуры всех поставленных на схему героев на кадре phase ростом из heights; первый — главный. Машины из vehicles —
 * коробка по направлению subjectFacing, остальные — цилиндры.
 */
export function subjectFigures(viewpoint: SceneViewpoint, phase: ViewpointPhase, heights: FigureHeights = {}, vehicles: FigureVehicles = []): SubjectFigure[] {
  return (viewpoint.subjects ?? []).map((subject, index) => {
    const at = pathPoint(subject, phase)!;
    const height = figureHeight(heights, subject.entity, vehicles);
    const triangles = vehicles.includes(subject.entity)
      ? vehicleTriangles(subject.entity, at, subjectFacing(viewpoint, index, phase), height)
      : objectVolume({ id: subject.entity, name: subject.entity, shape: { type: 'ellipse', center: at, radii: [FIGURE_RADIUS, FIGURE_RADIUS] }, height });
    return { entity: subject.entity, lead: index === 0, measured: heights[subject.entity] !== undefined, triangles };
  });
}
