import { describe, expect, it } from 'vitest';
import { cameraMatrix, projectPoint } from './camera3d';
import { EYE_HEIGHT, FIGURE_HEIGHT, subjectFigures, viewpointCamera } from './viewpoint-camera';
import type { SceneViewpoint } from './viewpoint';

const placed: SceneViewpoint = {
  location: 'yard',
  side: 'south',
  size: 'wide',
  camera: { start: [0, 0], end: [4, 0] },
  subjects: [
    { entity: 'hero', start: [0, 10], end: [4, 12] },
    { entity: 'friend', start: [3, 10] }
  ]
};

describe('вид из камеры', () => {
  it('камера на высоте глаз смотрит на середину фигуры героя в фокусе, угол — точки съёмки', () => {
    expect(viewpointCamera(placed, 'start')).toEqual({ eye: [0, 0, EYE_HEIGHT], target: [0, 10, FIGURE_HEIGHT / 2], fov: 60 });
    expect(viewpointCamera({ ...placed, fov: 30 }, 'end')).toEqual({ eye: [4, 0, EYE_HEIGHT], target: [4, 12, FIGURE_HEIGHT / 2], fov: 30 });
  });

  it('герой в фокусе — в центре кадра, герой за краем угла обзора — вне кадра', () => {
    const camera = viewpointCamera({ ...placed, size: 'close' }, 'start')!;
    const matrix = cameraMatrix(camera, 1600, 900, 20);
    const center = projectPoint(matrix, [0, 10, FIGURE_HEIGHT / 2], 1600, 900)!;
    expect(center[0]).toBeCloseTo(800, 6);
    expect(center[1]).toBeCloseTo(450, 6);
    // Крупный план — 25° по горизонтали: точка в 3 м сбоку на дистанции 10 м (≈17°) в кадр не попадает.
    const side = projectPoint(matrix, [3, 10, FIGURE_HEIGHT / 2], 1600, 900)!;
    expect(side[0]).toBeGreaterThan(1600);
    // Восток справа: камера смотрит на север.
    const near = projectPoint(matrix, [1, 10, FIGURE_HEIGHT / 2], 1600, 900)!;
    expect(near[0]).toBeGreaterThan(800);
  });

  it('без героя в фокусе — горизонтально по стороне', () => {
    const camera = viewpointCamera({ location: 'yard', side: 'east', size: 'wide', camera: { start: [5, 5] } }, 'start')!;
    expect(camera.eye).toEqual([5, 5, EYE_HEIGHT]);
    expect(camera.target[0]).toBeCloseTo(-5, 9);
    expect(camera.target[1]).toBeCloseTo(5, 9);
    expect(camera.target[2]).toBe(EYE_HEIGHT);
  });

  it('без точки камеры и у камеры сверху вида нет', () => {
    expect(viewpointCamera({ location: 'yard', side: 'south', size: 'wide' }, 'start')).toBeNull();
    expect(viewpointCamera({ ...placed, side: 'top' }, 'start')).toBeNull();
  });

  it('герои — цилиндры высотой фигуры в своих точках кадра, первый в фокусе', () => {
    const figures = subjectFigures(placed, 'end');
    expect(figures.map((figure) => [figure.entity, figure.focus])).toEqual([
      ['hero', true],
      ['friend', false]
    ]);
    const points = figures[0].triangles.flat();
    expect(Math.max(...points.map((point) => point[2]))).toBeCloseTo(FIGURE_HEIGHT, 9);
    expect(Math.min(...points.map((point) => point[2]))).toBeCloseTo(0, 9);
    const xs = points.map((point) => point[0]);
    expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(4, 9);
    // Неподвижный герой на последнем кадре стоит в начале пути.
    const still = figures[1].triangles.flat().map((point) => point[1]);
    expect((Math.max(...still) + Math.min(...still)) / 2).toBeCloseTo(10, 9);
  });
});
