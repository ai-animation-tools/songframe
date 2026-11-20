import { describe, expect, it } from 'vitest';
import { cameraMatrix, orbitCamera, projectPoint, verticalFov, type Camera3D } from './camera3d';

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
});
