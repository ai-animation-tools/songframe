import { describe, expect, it } from 'vitest';
import { cameraMatrix, projectPoint } from './camera3d';
import {
  EYE_HEIGHT,
  FIGURE_HEIGHT,
  VEHICLE_HEIGHT,
  VEHICLE_LENGTH,
  VEHICLE_WIDTH,
  castVehicles,
  compositionVehicles,
  lookPitch,
  subjectFigures,
  vehicleSize,
  viewpointCamera
} from './viewpoint-camera';
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
  it('камера на высоте глаз смотрит по прицелу на всех героев на середину фигуры на расстоянии главного героя', () => {
    const single: SceneViewpoint = { ...placed, subjects: placed.subjects!.slice(0, 1) };
    const start = viewpointCamera(single, 'start')!;
    expect(start.eye).toEqual([0, 0, EYE_HEIGHT]);
    expect(start.target[0]).toBeCloseTo(0, 9);
    expect(start.target[1]).toBeCloseTo(10, 9);
    expect(start.target[2]).toBe(FIGURE_HEIGHT / 2);
    expect(start.fov).toBe(60);
    const end = viewpointCamera({ ...single, fov: 30 }, 'end')!;
    expect(end.target[0]).toBeCloseTo(4, 9);
    expect(end.target[1]).toBeCloseTo(12, 9);
    expect(end.fov).toBe(30);
    // Двое героев: прицел между ними, на расстоянии главного героя (10 м).
    const pair = viewpointCamera(placed, 'start')!;
    const heading = (Math.atan2(pair.target[1], pair.target[0]) * 180) / Math.PI;
    expect(heading).toBeCloseTo((90 + (Math.atan2(10, 3) * 180) / Math.PI) / 2, 9);
    expect(Math.hypot(pair.target[0], pair.target[1])).toBeCloseTo(10, 9);
  });

  it('один герой — в центре кадра, предмет за краем угла обзора — вне кадра', () => {
    const camera = viewpointCamera({ ...placed, size: 'close', subjects: placed.subjects!.slice(0, 1) }, 'start')!;
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

  it('без главного героя — горизонтально по стороне', () => {
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

  it('герои — цилиндры высотой фигуры в своих точках кадра, первый главный', () => {
    const figures = subjectFigures(placed, 'end');
    expect(figures.map((figure) => [figure.entity, figure.lead])).toEqual([
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

  it('камера со своим направлением без поворота держит наклон первого кадра, без него ведёт героя', () => {
    const approach: SceneViewpoint = {
      location: 'beach',
      side: 'south',
      size: 'close',
      camera: { start: [0, 0] },
      heading: { start: 90 },
      camera_height: { start: 0.9 },
      subjects: [{ entity: 'kid', start: [1, 14], end: [0.5, 4] }]
    };
    const heights = { kid: 1.3 };
    const first = Math.atan2(0.65 - 0.9, Math.hypot(1, 14));
    expect(lookPitch(approach, 'start', heights)).toBeCloseTo(first, 12);
    expect(lookPitch(approach, 'end', heights)).toBeCloseTo(first, 12);
    // Цель последнего кадра — на расстоянии героя, на той же линии наклона.
    const end = viewpointCamera(approach, 'end', heights)!;
    const reach = Math.hypot(0.5, 4);
    expect(end.target[2]).toBeCloseTo(0.9 + reach * Math.tan(first), 9);
    // Без своего направления камера целится в героя и наклоняется за ним.
    const { heading: _heading, ...aimed } = approach;
    expect(lookPitch(aimed, 'end', heights)).toBeCloseTo(Math.atan2(0.65 - 0.9, reach), 12);
    // Поворачивающаяся камера тоже ведёт героя.
    expect(lookPitch({ ...approach, heading: { start: 90, end: 80 } }, 'end', heights)).toBeCloseTo(Math.atan2(0.65 - 0.9, reach), 12);
    // Свой наклон человека берётся как есть, на каждом кадре свой.
    const tilted = { ...approach, tilt: { start: -40, end: -20 } };
    expect(lookPitch(tilted, 'start', heights)).toBeCloseTo((-40 * Math.PI) / 180, 12);
    expect(lookPitch(tilted, 'end', heights)).toBeCloseTo((-20 * Math.PI) / 180, 12);
    expect(viewpointCamera(tilted, 'end', heights)!.target[2]).toBeCloseTo(0.9 + reach * Math.tan((-20 * Math.PI) / 180), 9);
  });

  it('своя высота камеры и рост героев из кастинга', () => {
    const single: SceneViewpoint = { ...placed, camera_height: { start: 10, end: 0.3 }, subjects: placed.subjects!.slice(0, 1) };
    const heights = { hero: 1.2 };
    const start = viewpointCamera(single, 'start', heights)!;
    expect(start.eye[2]).toBe(10);
    // Взгляд на середину роста главного героя: с 10 м камера смотрит вниз.
    expect(start.target[2]).toBeCloseTo(0.6, 9);
    expect(viewpointCamera(single, 'end', heights)!.eye[2]).toBe(0.3);
    const figures = subjectFigures(placed, 'start', heights);
    expect(figures.map((figure) => figure.measured)).toEqual([true, false]);
    const top = (index: number): number => Math.max(...figures[index].triangles.flat().map((point) => point[2]));
    expect(top(0)).toBeCloseTo(1.2, 9);
    expect(top(1)).toBeCloseTo(FIGURE_HEIGHT, 9);
  });

  it('машина — коробка по габаритам: стоящая передом к камере, со своим направлением — по нему, едущая — по ходу', () => {
    const span = (points: number[][], axis: 0 | 1): number => Math.max(...points.map((point) => point[axis])) - Math.min(...points.map((point) => point[axis]));
    const car = (subject: SceneViewpoint['subjects'] & object): number[][] =>
      subjectFigures(
        { location: 'yard', side: 'south', size: 'wide', camera: { start: [0, 0] }, subjects: subject },
        'start',
        {},
        { car: vehicleSize() }
      )[0].triangles.flat();
    // Камера на юге: стоящая машина без своего направления длинной стороной к камере — вдоль Y.
    const facing = car([{ entity: 'car', start: [0, 10] }]);
    expect(span(facing, 1)).toBeCloseTo(VEHICLE_LENGTH, 6);
    expect(span(facing, 0)).toBeCloseTo(VEHICLE_WIDTH, 6);
    expect(Math.max(...facing.map((point) => point[2]))).toBeCloseTo(VEHICLE_HEIGHT, 9);
    // Своё направление на восток — длинной стороной вдоль X.
    expect(span(car([{ entity: 'car', start: [0, 10], facing: 0 }]), 0)).toBeCloseTo(VEHICLE_LENGTH, 6);
    // Едет на восток — тоже вдоль X, своё направление не нужно.
    expect(span(car([{ entity: 'car', start: [0, 10], end: [10, 10] }]), 0)).toBeCloseTo(VEHICLE_LENGTH, 6);
    // Не машина остаётся цилиндром.
    const person = subjectFigures(
      { location: 'yard', side: 'south', size: 'wide', camera: { start: [0, 0] }, subjects: [{ entity: 'car', start: [0, 10] }] },
      'start'
    )[0];
    expect(span(person.triangles.flat(), 1)).toBeLessThan(1);
  });

  it('длина и ширина машины из кастинга: незаданная сторона — типовая, не-транспорт не машина', () => {
    const vehicles = castVehicles([
      { id: 'truck', kind: 'vehicle', length: 7 },
      { id: 'car', kind: 'vehicle' },
      { id: 'box', kind: 'prop', length: 3 }
    ]);
    expect(vehicles).toEqual({ truck: [7, VEHICLE_WIDTH], car: [VEHICLE_LENGTH, VEHICLE_WIDTH] });
    expect(compositionVehicles(['truck', 'car'], { truck: [12, 2.5] })).toEqual({ truck: [12, 2.5], car: [VEHICLE_LENGTH, VEHICLE_WIDTH] });
    const span = (points: number[][], axis: 0 | 1): number => Math.max(...points.map((point) => point[axis])) - Math.min(...points.map((point) => point[axis]));
    const truck = subjectFigures(
      { location: 'yard', side: 'south', size: 'wide', camera: { start: [0, 0] }, subjects: [{ entity: 'truck', start: [0, 10], facing: 0 }] },
      'start',
      {},
      { truck: [12, 2.5] }
    )[0].triangles.flat();
    expect(span(truck, 0)).toBeCloseTo(12, 6);
    expect(span(truck, 1)).toBeCloseTo(2.5, 6);
  });

  it('наклон камеры к машине — на середину её типовой высоты', () => {
    const viewpoint: SceneViewpoint = {
      location: 'yard',
      side: 'south',
      size: 'wide',
      camera: { start: [0, 0] },
      subjects: [{ entity: 'car', start: [0, 10] }]
    };
    expect(lookPitch(viewpoint, 'start', {}, { car: vehicleSize() })).toBeCloseTo(Math.atan2(VEHICLE_HEIGHT / 2 - EYE_HEIGHT, 10), 9);
  });
});
