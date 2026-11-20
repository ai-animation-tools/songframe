import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { Alert, Box, useTheme } from '@mui/material';
import { schemesTexts } from '@shared/texts/schemes';
import type { Scheme } from '@shared/schemes';
import { drawOrder, labelAnchor, objectColor, schemeBounds } from '@shared/scheme-editing';
import { objectTopHeight, objectVolume, triangleNormal, type Triangle, type Vec3 } from '@shared/scheme-volume';
import { cameraMatrix, orbitCamera, projectPoint, type Camera3D } from '@shared/camera3d';

/** Дополнительное тело сцены, которого нет в схеме: например, фигура героя точки съёмки. */
export interface VolumeExtra {
  id: string;
  triangles: Triangle[];
  color: string;
}

/** Облёт по умолчанию: с юго-запада, сверху под углом. */
const ORBIT = { azimuth: 235, elevation: 35 };
/** Плоские объекты на земле приподнимаются по порядку отрисовки, чтобы не мерцать друг на друге, м. */
const FLAT_LIFT = 0.004;

const VERTEX_SHADER = `attribute vec3 position; attribute vec3 normal; attribute vec3 color;
uniform mat4 matrix; varying vec3 vNormal; varying vec3 vColor;
void main() { gl_Position = matrix * vec4(position, 1.0); vNormal = normal; vColor = color; }`;
const FRAGMENT_SHADER = `precision mediump float; varying vec3 vNormal; varying vec3 vColor;
void main() {
  vec3 light = normalize(vec3(-0.45, -0.6, 0.75));
  float shade = 0.45 + 0.55 * max(dot(normalize(vNormal), light), 0.0) + 0.12 * max(dot(normalize(vNormal), -light), 0.0);
  gl_FragColor = vec4(vColor * shade, 1.0);
}`;

/** Цвет #rrggbb в долях единицы; другое написание — серый. */
function rgb(color: string): Vec3 {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  return match ? [parseInt(match[1], 16) / 255, parseInt(match[2], 16) / 255, parseInt(match[3], 16) / 255] : [0.6, 0.6, 0.6];
}

/** Шаг сетки на земле, м: около десяти клеток на сторону сцены по ряду 1–2–5. */
function gridStep(extent: number): number {
  const raw = extent / 10;
  const power = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-3)));
  return [1, 2, 5, 10].map((k) => k * power).find((step) => step >= raw) ?? power * 10;
}

/**
 * Вершины сцены: позиция, нормаль и цвет — по 9 чисел. Сначала треугольники объектов и земли (count), за ними отрезки
 * сетки земли (lines вершин). triangles — число треугольников объектов для истории и проверки.
 */
function buildVertices(
  scheme: Scheme,
  extras: readonly VolumeExtra[],
  ground: Vec3,
  gridColor: Vec3,
  step: number
): { data: Float32Array; count: number; lines: number; triangles: number } {
  const values: number[] = [];
  const push = (triangle: Triangle, color: Vec3, lift = 0): void => {
    const normal = triangleNormal(triangle);
    for (const point of triangle) values.push(point[0], point[1], point[2] + lift, ...normal, ...color);
  };
  drawOrder(scheme.objects).forEach((object, index) => {
    const flat = objectTopHeight(object) === 0;
    const color = rgb(objectColor(object));
    for (const triangle of objectVolume(object)) push(triangle, color, flat ? FLAT_LIFT * (index + 1) : 0);
  });
  for (const extra of extras) for (const triangle of extra.triangles) push(triangle, rgb(extra.color));
  const triangles = values.length / 27;
  // Земля — последней: два треугольника под всей сценой.
  const bounds = schemeBounds(scheme.objects) ?? [-10, -10, 10, 10];
  const margin = Math.max(10, (bounds[2] - bounds[0] + bounds[3] - bounds[1]) / 2);
  const [x0, y0, x1, y1] = [bounds[0] - margin, bounds[1] - margin, bounds[2] + margin, bounds[3] + margin];
  push(
    [
      [x0, y0, -0.01],
      [x1, y0, -0.01],
      [x1, y1, -0.01]
    ],
    ground
  );
  push(
    [
      [x0, y0, -0.01],
      [x1, y1, -0.01],
      [x0, y1, -0.01]
    ],
    ground
  );
  const count = values.length / 9;
  for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) values.push(x, y0, 0, 0, 0, 1, ...gridColor, x, y1, 0, 0, 0, 1, ...gridColor);
  for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) values.push(x0, y, 0, 0, 0, 1, ...gridColor, x1, y, 0, 0, 0, 1, ...gridColor);
  return { data: new Float32Array(values), count, lines: values.length / 9 - count, triangles };
}

/**
 * Объём схемы вида сверху в перспективе (WebGL без библиотек). Без camera — облёт: перетаскивание вращает вид,
 * колесо приближает, стрелки и +/− делают то же с клавиатуры, подписи объектов стоят над их верхом. С camera —
 * неподвижный кадр точки съёмки без подписей: подпись спрятанного объекта выдавала бы его в кадре. Кадр
 * перерисовывается только при изменении сцены, размера или вида. Без WebGL — понятное сообщение вместо сцены.
 */
export function SchemeVolumeView({
  scheme,
  label,
  height,
  camera,
  extras = []
}: {
  scheme: Scheme;
  /** Доступное имя области. */
  label: string;
  height: number;
  camera?: Camera3D;
  extras?: readonly VolumeExtra[];
}): ReactElement {
  const theme = useTheme();
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<{ gl: WebGLRenderingContext; matrix: WebGLUniformLocation; count: number; lines: number } | null>(null);
  const [width, setWidth] = useState(640);
  const [failed, setFailed] = useState<string | null>(null);
  const [orbit, setOrbit] = useState<{ azimuth: number; elevation: number; distance: number | null }>({ ...ORBIT, distance: null });
  const drag = useRef<{ x: number; y: number; azimuth: number; elevation: number } | null>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const update = (): void => setWidth(Math.max(240, Math.round(box.getBoundingClientRect().width)));
    const observer = new ResizeObserver(update);
    observer.observe(box);
    update();
    return () => observer.disconnect();
  }, []);

  const bounds = schemeBounds(scheme.objects) ?? [-10, -10, 10, 10];
  const extent = Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1], 10);
  const center: Vec3 = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2, 0];
  const dark = theme.palette.mode === 'dark';
  const step = gridStep(extent);
  const vertices = useMemo(
    () => buildVertices(scheme, extras, rgb(dark ? '#3a4a3a' : '#c9d6c0'), rgb(dark ? '#55665a' : '#a9bba0'), step),
    [scheme, extras, dark, step]
  );
  const view: Camera3D = camera ?? orbitCamera(center, orbit.azimuth, orbit.elevation, orbit.distance ?? extent * 1.3);

  // Контекст и шейдеры создаются один раз; потеря контекста показывает сообщение.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: true });
    if (!gl) {
      setFailed(schemesTexts.volumeView.unavailable);
      return;
    }
    const compile = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      setFailed(schemesTexts.volumeView.unavailable);
      return;
    }
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    for (const [name, offset] of [
      ['position', 0],
      ['normal', 3],
      ['color', 6]
    ] as const) {
      const location = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 36, offset * 4);
    }
    gl.enable(gl.DEPTH_TEST);
    glRef.current = { gl, matrix: gl.getUniformLocation(program, 'matrix')!, count: 0, lines: 0 };
    const lost = (event: Event): void => {
      event.preventDefault();
      setFailed(schemesTexts.volumeView.lost);
    };
    canvas.addEventListener('webglcontextlost', lost);
    return () => canvas.removeEventListener('webglcontextlost', lost);
  }, []);

  useEffect(() => {
    const context = glRef.current;
    if (!context) return;
    context.gl.bufferData(context.gl.ARRAY_BUFFER, vertices.data, context.gl.STATIC_DRAW);
    context.count = vertices.count;
    context.lines = vertices.lines;
  }, [vertices]);

  const pixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const matrix = cameraMatrix(view, width, height, extent);
  useEffect(() => {
    const context = glRef.current;
    const canvas = canvasRef.current;
    if (!context || !canvas) return;
    const { gl } = context;
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    gl.viewport(0, 0, canvas.width, canvas.height);
    const sky = rgb(theme.palette.mode === 'dark' ? '#1e2a33' : '#e3edf5');
    gl.clearColor(sky[0], sky[1], sky[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(context.matrix, false, new Float32Array(matrix));
    gl.drawArrays(gl.TRIANGLES, 0, context.count);
    gl.drawArrays(gl.LINES, context.count, context.lines);
  });

  // Стрелка севера: направление на экране от центра сцены к точке севернее.
  const from = projectPoint(matrix, center, width, height);
  const to = projectPoint(matrix, [center[0], center[1] + extent / 4, 0], width, height);
  const north = from && to ? (Math.atan2(to[0] - from[0], -(to[1] - from[1])) * 180) / Math.PI : 0;
  const labels = camera
    ? []
    : scheme.objects.flatMap((object) => {
        const [x, y] = labelAnchor(object.shape);
        const at = projectPoint(matrix, [x, y, objectTopHeight(object) + 0.3], width, height);
        return at && at[0] >= 0 && at[0] <= width && at[1] >= 0 && at[1] <= height ? [{ id: object.id, name: object.name, at }] : [];
      });

  const rotate = (azimuth: number, elevation: number): void =>
    setOrbit((value) => ({ ...value, azimuth: (azimuth + 360) % 360, elevation: Math.min(85, Math.max(5, elevation)) }));
  const zoom = (factor: number): void =>
    setOrbit((value) => ({ ...value, distance: Math.min(extent * 6, Math.max(2, (value.distance ?? extent * 1.3) * factor)) }));
  const keyDown = (event: KeyboardEvent): void => {
    const keys: Record<string, () => void> = {
      ArrowLeft: () => rotate(orbit.azimuth - 10, orbit.elevation),
      ArrowRight: () => rotate(orbit.azimuth + 10, orbit.elevation),
      ArrowUp: () => rotate(orbit.azimuth, orbit.elevation + 5),
      ArrowDown: () => rotate(orbit.azimuth, orbit.elevation - 5),
      '+': () => zoom(0.85),
      '=': () => zoom(0.85),
      '-': () => zoom(1 / 0.85)
    };
    if (camera || !keys[event.key]) return;
    event.preventDefault();
    keys[event.key]();
  };

  if (failed) return <Alert severity="warning">{failed}</Alert>;
  return (
    <Box
      ref={boxRef}
      sx={{ position: 'relative', border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden', height }}
      data-volume-view=""
      data-triangles={vertices.triangles}
    >
      <canvas
        ref={canvasRef}
        role="application"
        aria-label={label}
        tabIndex={camera ? -1 : 0}
        style={{ display: 'block', width, height, cursor: camera ? 'default' : drag.current ? 'grabbing' : 'grab', touchAction: 'none' }}
        onKeyDown={keyDown}
        onPointerDown={(event) => {
          if (camera) return;
          drag.current = { x: event.clientX, y: event.clientY, azimuth: orbit.azimuth, elevation: orbit.elevation };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start) return;
          rotate(start.azimuth - (event.clientX - start.x) * 0.4, start.elevation + (event.clientY - start.y) * 0.3);
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onWheel={(event) => {
          if (!camera) zoom(event.deltaY < 0 ? 0.9 : 1 / 0.9);
        }}
      />
      {labels.map((item) => (
        <Box
          key={item.id}
          sx={{
            position: 'absolute',
            left: item.at[0],
            top: item.at[1],
            transform: 'translate(-50%, -100%)',
            pointerEvents: 'none',
            fontSize: 12,
            px: 0.5,
            borderRadius: 0.5,
            bgcolor: 'background.paper',
            color: 'text.primary',
            opacity: 0.9,
            whiteSpace: 'nowrap'
          }}
        >
          {item.name}
        </Box>
      ))}
      <Box
        aria-hidden
        sx={{ position: 'absolute', right: 12, top: 10, textAlign: 'center', pointerEvents: 'none', color: 'text.primary', fontSize: 11, fontWeight: 600 }}
      >
        <svg width={24} height={24} viewBox="-12 -12 24 24" style={{ display: 'block', margin: '0 auto' }}>
          <path d="M0 -10 L6 7 L0 3 L-6 7 Z" transform={`rotate(${north})`} fill={theme.palette.text.primary} />
        </svg>
        {schemesTexts.north}
      </Box>
      {camera ? null : (
        <Box
          sx={{
            position: 'absolute',
            left: 8,
            bottom: 8,
            fontSize: 12,
            px: 0.75,
            borderRadius: 0.5,
            bgcolor: 'background.paper',
            color: 'text.primary',
            pointerEvents: 'none'
          }}
        >
          {schemesTexts.volumeView.hint({ step })}
        </Box>
      )}
    </Box>
  );
}
