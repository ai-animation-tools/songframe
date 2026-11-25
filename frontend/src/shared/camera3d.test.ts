import { describe, expect, it } from 'vitest';
import { clipPlanes, cameraMatrix, GROUND_REACH, orbitCamera, pixelRay, projectPoint, verticalFov, type Camera3D } from './camera3d';

describe('камера объёма', () => {
  const camera: Camera3D = { eye: [0, -10, 1.7], target: [0, 0, 1.7], fov: 60 };
  const matrix = cameraMatrix(camera, 1200, 600, 40);

  it('точка взгляда в центре кадра, восток справа при взгляде на север', () => {
    const [x, y] = projectPoint(matrix, [0, 0, 1.7], 1200, 600)!;
    expect(x).toBeCloseTo(600);
    expect(y).toBeCloseTo(300);
    expect(projectPoint(matrix, [3, 0, 1.7], 1200, 600)![0]).toBeGreaterThan(600);
    expect(projectPoint(matrix, [0, 0, 5], 1200, 600)![1]).toBeLessThan(300);
  });

  it('край горизонтального угла попадает на край кадра', () => {
    // Половина угла 30°: на расстоянии 10 м край кадра в 10·tg30° от оси.
    const [x] = projectPoint(matrix, [10 * Math.tan(Math.PI / 6), 0, 1.7], 1200, 600)!;
    expect(x).toBeCloseTo(1200, 3);
  });

  it('точка за камерой не проецируется', () => {
    expect(projectPoint(matrix, [0, -20, 1.7], 1200, 600)).toBeNull();
  });

  it('вертикальный угол следует из пропорций кадра', () => {
    expect(verticalFov(90, 1)).toBeCloseTo(Math.PI / 2);
    expect(verticalFov(60, 2)).toBeLessThan(verticalFov(60, 1));
  });

  it('облёт: азимут 270° — камера на юге, смотрит на север', () => {
    const orbit = orbitCamera([0, 0, 0], 270, 0, 10);
    expect(orbit.eye[0]).toBeCloseTo(0);
    expect(orbit.eye[1]).toBeCloseTo(-10);
  });

  it('луч через пиксель проходит через точку мира, которая в этот пиксель проецируется', () => {
    for (const view of [camera, orbitCamera([2, 3, 0], 235, 35, 30), { eye: [1, 2, 40], target: [1, 2, 0], fov: 50 } satisfies Camera3D]) {
      const viewMatrix = cameraMatrix(view, 1200, 600, 40);
      for (const point of [
        [0, 0, 1.7],
        [4, 6, 0],
        [-3, 5, 2.5]
      ] as const) {
        const pixel = projectPoint(viewMatrix, [...point], 1200, 600)!;
        const { origin, direction } = pixelRay(view, 1200, 600, pixel);
        const toPoint = [0, 1, 2].map((axis) => point[axis] - origin[axis]);
        const crossed = [
          direction[1] * toPoint[2] - direction[2] * toPoint[1],
          direction[2] * toPoint[0] - direction[0] * toPoint[2],
          direction[0] * toPoint[1] - direction[1] * toPoint[0]
        ];
        expect(Math.hypot(...crossed) / (Math.hypot(...direction) * Math.hypot(...toPoint))).toBeLessThan(1e-9);
        expect(direction[0] * toPoint[0] + direction[1] * toPoint[1] + direction[2] * toPoint[2]).toBeGreaterThan(0);
      }
    }
  });

  it('край земли виден почти на настоящем горизонте и не срезан дальней плоскостью', () => {
    // Камера в 3,5 м над землёй с наклоном вниз: край земли в GROUND_REACH под горизонтом меньше чем на 0,5% кадра.
    const tilted: Camera3D = { eye: [0, 0, 3.5], target: [0, 6, 0.85], fov: 78 };
    const view = cameraMatrix(tilted, 1280, 720, 30);
    const edge = projectPoint(view, [0, GROUND_REACH, 0], 1280, 720)!;
    const horizon = projectPoint(view, [0, GROUND_REACH * 1000, 3.5], 1280, 720)!;
    expect(Math.abs(edge[1] - horizon[1])).toBeLessThan(720 * 0.005);
    expect(clipPlanes(tilted, 30)[1]).toBeGreaterThan(Math.hypot(GROUND_REACH, GROUND_REACH));
  });
});
