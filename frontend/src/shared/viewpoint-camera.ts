import type { Camera3D } from './camera3d';
import type { SchemeObject } from './schemes';
import { objectVolume, type Triangle } from './scheme-volume';
import { distance, focusSubject, lookHeading, pathPoint, pointAt, viewpointFov, type SceneViewpoint, type ViewpointPhase } from './viewpoint';

/**
 * Вид из камеры точки съёмки: перспективная камера и условные фигуры героев для объёма схемы локации. Всё
 * вычисляется из точек плана и не хранится: камера стоит в своей точке на высоте глаз и смотрит по прицелу на всех
 * героев (lookHeading) на середину фигуры на расстоянии героя в фокусе или, без героев, горизонтально по стороне.
 * Рост героев неизвестен, поэтому все они — одинаковые цилиндры: они показывают, где герой стоит и что его
 * заслоняет, а не его облик. Камера сверху висит над точкой и
 * смотрит вниз; её кадр и есть схема, отдельного вида у неё нет.
 */

/** Высота камеры над землёй, м: съёмка с рук или штатива на уровне глаз. */
export const EYE_HEIGHT = 1.6;
/** Условная фигура героя: высота и радиус цилиндра, м. */
export const FIGURE_HEIGHT = 1.7;
export const FIGURE_RADIUS = 0.25;
/** Взгляд без героя в фокусе: точка на этом расстоянии по направлению стороны, м. */
const LOOK_AHEAD = 10;

/** Камера вида на кадре phase; без точки камеры или при камере сверху — null. */
export function viewpointCamera(viewpoint: SceneViewpoint, phase: ViewpointPhase): Camera3D | null {
  const at = pathPoint(viewpoint.camera, phase);
  const heading = lookHeading(viewpoint, phase);
  if (!at || heading === null) return null;
  const focus = pathPoint(focusSubject(viewpoint), phase);
  const eye: Camera3D['eye'] = [at[0], at[1], EYE_HEIGHT];
  // Наклон взгляда — на середину фигуры на расстоянии героя в фокусе; герой в точке камеры или без героев —
  // горизонтально вдаль.
  const reach = focus ? distance(at, focus) : 0;
  const aimed = reach > 1e-9;
  const ahead = pointAt(at, heading, aimed ? reach : LOOK_AHEAD);
  const target: Camera3D['target'] = [ahead[0], ahead[1], aimed ? FIGURE_HEIGHT / 2 : EYE_HEIGHT];
  return { eye, target, fov: viewpointFov(viewpoint) };
}

/** Фигура героя на кадре phase: ID сущности, в фокусе ли он и треугольники цилиндра. */
export interface SubjectFigure {
  entity: string;
  focus: boolean;
  triangles: Triangle[];
}

/** Фигуры всех поставленных на схему героев на кадре phase; первый — в фокусе. */
export function subjectFigures(viewpoint: SceneViewpoint, phase: ViewpointPhase): SubjectFigure[] {
  return (viewpoint.subjects ?? []).map((subject, index) => {
    const at = pathPoint(subject, phase)!;
    const figure: SchemeObject = {
      id: subject.entity,
      name: subject.entity,
      shape: { type: 'ellipse', center: at, radii: [FIGURE_RADIUS, FIGURE_RADIUS] },
      height: FIGURE_HEIGHT
    };
    return { entity: subject.entity, focus: index === 0, triangles: objectVolume(figure) };
  });
}
