import type { Camera3D } from './camera3d';
import type { SchemeObject } from './schemes';
import { objectVolume, type Triangle } from './scheme-volume';
import {
  DEFAULT_CAMERA_HEIGHT,
  cameraHeight,
  distance,
  leadSubject,
  lookHeading,
  pathPoint,
  pointAt,
  viewpointFov,
  type SceneViewpoint,
  type ViewpointPhase
} from './viewpoint';

/**
 * Вид из камеры точки съёмки: перспективная камера и условные фигуры героев для объёма схемы локации. Всё
 * вычисляется из точек плана и кастинга и не хранится: камера стоит в своей точке на своей высоте (по умолчанию —
 * уровень глаз) и смотрит по прицелу на всех героев (lookHeading) на середину фигуры главного героя на его расстоянии
 * или, без героев, горизонтально по стороне. Герои — цилиндры ростом из кастинга, без роста — условные 1,7 м: они
 * показывают, где герой стоит и что его заслоняет, а не его облик. Камера сверху висит над точкой и смотрит вниз;
 * её кадр и есть схема, отдельного вида у неё нет.
 */

/** Высота камеры по умолчанию, м: съёмка с рук или штатива на уровне глаз. */
export const EYE_HEIGHT = DEFAULT_CAMERA_HEIGHT;
/** Условная фигура героя: рост без заданного в кастинге и радиус цилиндра, м. */
export const FIGURE_HEIGHT = 1.7;
export const FIGURE_RADIUS = 0.25;
/** Взгляд без главного героя: точка на этом расстоянии по направлению стороны, м. */
const LOOK_AHEAD = 10;

/** Рост сущностей кастинга по ID, м; сущности без роста в карте нет. */
export type FigureHeights = Readonly<Record<string, number>>;

/** Рост героя entity: из кастинга или условный FIGURE_HEIGHT. */
export function figureHeight(heights: FigureHeights, entity: string): number {
  return heights[entity] ?? FIGURE_HEIGHT;
}

/** Камера вида на кадре phase; без точки камеры или при камере сверху — null. */
export function viewpointCamera(viewpoint: SceneViewpoint, phase: ViewpointPhase, heights: FigureHeights = {}): Camera3D | null {
  const at = pathPoint(viewpoint.camera, phase);
  const heading = lookHeading(viewpoint, phase);
  if (!at || heading === null) return null;
  const subject = leadSubject(viewpoint);
  const lead = pathPoint(subject, phase);
  const height = cameraHeight(viewpoint, phase);
  const eye: Camera3D['eye'] = [at[0], at[1], height];
  // Наклон взгляда — на середину фигуры на расстоянии главного героя; герой в точке камеры или без героев —
  // горизонтально вдаль.
  const reach = lead ? distance(at, lead) : 0;
  const aimed = reach > 1e-9;
  const ahead = pointAt(at, heading, aimed ? reach : LOOK_AHEAD);
  const target: Camera3D['target'] = [ahead[0], ahead[1], aimed && subject ? figureHeight(heights, subject.entity) / 2 : height];
  return { eye, target, fov: viewpointFov(viewpoint) };
}

/** Фигура героя на кадре phase: ID сущности, главный ли он, задан ли его рост и треугольники цилиндра. */
export interface SubjectFigure {
  entity: string;
  lead: boolean;
  /** Рост из кастинга; false — условная фигура FIGURE_HEIGHT. */
  measured: boolean;
  triangles: Triangle[];
}

/** Фигуры всех поставленных на схему героев на кадре phase ростом из heights; первый — главный. */
export function subjectFigures(viewpoint: SceneViewpoint, phase: ViewpointPhase, heights: FigureHeights = {}): SubjectFigure[] {
  return (viewpoint.subjects ?? []).map((subject, index) => {
    const at = pathPoint(subject, phase)!;
    const figure: SchemeObject = {
      id: subject.entity,
      name: subject.entity,
      shape: { type: 'ellipse', center: at, radii: [FIGURE_RADIUS, FIGURE_RADIUS] },
      height: figureHeight(heights, subject.entity)
    };
    return { entity: subject.entity, lead: index === 0, measured: heights[subject.entity] !== undefined, triangles: objectVolume(figure) };
  });
}
