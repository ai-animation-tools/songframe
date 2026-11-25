import type { Vec3 } from './scheme-volume';

/**
 * Перспективная камера для объёма схемы: матрицы WebGL (по столбцам) и проекция точки мира в пиксели кадра. Мир — метры
 * схемы: X — восток, Y — север, Z — вверх. Угол обзора задаётся по горизонтали, как у точки съёмки плана; вертикальный
 * угол следует из пропорций кадра.
 */

/** Камера: где стоит, куда смотрит и угол обзора по горизонтали в градусах. */
export interface Camera3D {
  eye: Vec3;
  target: Vec3;
  fov: number;
}

export type Matrix4 = number[];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => {
  const length = Math.hypot(...a) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};

/** Вертикальный угол обзора в радианах по горизонтальному в градусах и пропорции кадра width / height. */
export function verticalFov(horizontalDegrees: number, aspect: number): number {
  return 2 * Math.atan(Math.tan((horizontalDegrees * Math.PI) / 360) / aspect);
}

/** Матрица перспективы: вертикальный угол в радианах, ближняя и дальняя плоскости в метрах. */
export function perspective(fovY: number, aspect: number, near: number, far: number): Matrix4 {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}

/**
 * Матрица вида: камера в eye смотрит на target, верх — ось Z мира. Взгляд строго вверх или вниз вырожден: тогда
 * верхом кадра служит север.
 */
export function lookAt(eye: Vec3, target: Vec3): Matrix4 {
  const z = normalize(sub(eye, target));
  const up: Vec3 = Math.abs(z[2]) > 0.999 ? [0, 1, 0] : [0, 0, 1];
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}

/** Произведение матриц a × b (по столбцам). */
export function multiply(a: Matrix4, b: Matrix4): Matrix4 {
  const result = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column++)
    for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) result[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
  return result;
}

/**
 * Сколько метров земля тянется за края схемы во все стороны. Край земли — видимый «горизонт» объёма: в 5 км он с любой
 * высоты точки съёмки лежит в долях градуса под настоящим горизонтом, поэтому линия горизонта на виде из камеры и на
 * снимке схемы композиции стоит там же, где в кадре; земля в десятки метров давала бы его на градусы ниже.
 */
export const GROUND_REACH = 5000;

/**
 * Ближняя и дальняя плоскости: от 5 см до дальности, покрывающей схему и землю до её края (GROUND_REACH). Точность
 * глубины определяет ближняя плоскость, дальняя её почти не меняет.
 */
export function clipPlanes(camera: Camera3D, extent: number): [number, number] {
  return [0.05, Math.max(GROUND_REACH * 2, Math.hypot(...sub(camera.eye, camera.target)) + extent * 2)];
}

/** Матрица камеры для кадра width × height; extent — размер сцены в метрах для дальней плоскости. */
export function cameraMatrix(camera: Camera3D, width: number, height: number, extent: number): Matrix4 {
  const aspect = width / Math.max(1, height);
  const [near, far] = clipPlanes(camera, extent);
  return multiply(perspective(verticalFov(camera.fov, aspect), aspect, near, far), lookAt(camera.eye, camera.target));
}

/** Пиксели кадра для точки мира или null, если точка за камерой. Начало координат — левый верхний угол кадра. */
export function projectPoint(matrix: Matrix4, point: Vec3, width: number, height: number): [number, number] | null {
  const [x, y, z] = point;
  const clip = [0, 1, 2, 3].map((row) => matrix[row] * x + matrix[4 + row] * y + matrix[8 + row] * z + matrix[12 + row]);
  if (clip[3] <= 1e-6) return null;
  return [((clip[0] / clip[3] + 1) / 2) * width, ((1 - clip[1] / clip[3]) / 2) * height];
}

/**
 * Луч из камеры через пиксель кадра width × height: начало в глазу, направление (не нормированное) по тем же осям,
 * что у lookAt и perspective. Обратная к projectPoint операция для выбора объекта щелчком.
 */
export function pixelRay(camera: Camera3D, width: number, height: number, pixel: [number, number]): { origin: Vec3; direction: Vec3 } {
  const forward = normalize(sub(camera.target, camera.eye));
  const up: Vec3 = Math.abs(forward[2]) > 0.999 ? [0, 1, 0] : [0, 0, 1];
  const right = normalize(cross(forward, up));
  const cameraUp = cross(right, forward);
  const aspect = width / Math.max(1, height);
  const tanY = Math.tan(verticalFov(camera.fov, aspect) / 2);
  const x = ((2 * pixel[0]) / width - 1) * tanY * aspect;
  const y = (1 - (2 * pixel[1]) / height) * tanY;
  return {
    origin: camera.eye,
    direction: [0, 1, 2].map((axis) => forward[axis] + right[axis] * x + cameraUp[axis] * y) as Vec3
  };
}

/** Камера облёта: вокруг target на расстоянии distance, азимут от востока против часовой и высота угла над горизонтом, градусы. */
export function orbitCamera(target: Vec3, azimuth: number, elevation: number, distance: number, fov = 50): Camera3D {
  const a = (azimuth * Math.PI) / 180;
  const e = (elevation * Math.PI) / 180;
  return {
    eye: [target[0] + distance * Math.cos(e) * Math.cos(a), target[1] + distance * Math.cos(e) * Math.sin(a), target[2] + distance * Math.sin(e)],
    target,
    fov
  };
}
