import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { Alert, Box, useTheme } from '@mui/material';
import { schemesTexts } from '@shared/texts/schemes';
import type { Scheme } from '@shared/schemes';
import { drawOrder, labelAnchor, objectColor, schemeBounds } from '@shared/scheme-editing';
import { objectTopHeight, objectVolume, pickObject, triangleNormal, type Triangle, type Vec3 } from '@shared/scheme-volume';
import { cameraMatrix, GROUND_REACH, orbitCamera, pixelRay, projectPoint, type Camera3D } from '@shared/camera3d';

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
/** Сдвиг указателя, после которого нажатие считается вращением, а не щелчком, px. */
const CLICK_SLOP = 4;
/** Выбранный объект светлеет на эту долю к белому. */
const SELECTED_LIGHTEN = 0.45;

const VERTEX_SHADER = `attribute vec3 position; attribute vec3 normal; attribute vec3 color;
uniform mat4 matrix; varying vec3 vNormal; varying vec3 vColor;
void main() { gl_Position = matrix * vec4(position, 1.0); vNormal = normal; vColor = color; }`;
const FRAGMENT_SHADER = `precision mediump float; varying vec3 vNormal; varying vec3 vColor;
void main() {
  vec3 light = normalize(vec3(-0.45, -0.6, 0.75));
  vec3 normal = gl_FrontFacing ? normalize(vNormal) : -normalize(vNormal);
  float shade = 0.45 + 0.55 * max(dot(normal, light), 0.0) + 0.12 * max(dot(normal, -light), 0.0);
  gl_FragColor = vec4(vColor * shade, 1.0);
}`;

/** Облёт: азимут и высота угла в градусах, расстояние в метрах (null — по размеру сцены). */
interface Orbit {
  azimuth: number;
  elevation: number;
  distance: number | null;
}

/**
 * Запомненный облёт из localStorage. Как и вид плана, это предпочтение человека в окне, а не данные клипа;
 * недоступное хранилище или негодное значение — облёт по умолчанию.
 */
function readStoredOrbit(key: string): Orbit | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<Record<keyof Orbit, unknown>> | null;
    const { azimuth, elevation, distance } = value ?? {};
    if (typeof azimuth !== 'number' || !Number.isFinite(azimuth) || typeof elevation !== 'number' || !Number.isFinite(elevation)) return null;
    return { azimuth, elevation, distance: typeof distance === 'number' && Number.isFinite(distance) && distance > 0 ? distance : null };
  } catch {
    return null;
  }
}

/** Запоминает облёт; хранилище, не принявшее запись, работе не мешает. */
function storeOrbit(key: string, orbit: Orbit): void {
  try {
    localStorage.setItem(key, JSON.stringify(orbit));
  } catch {
    // Облёт действует, пока вид открыт.
  }
}

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
  selected: string | null,
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
    const base = rgb(objectColor(object));
    const color: Vec3 = object.id === selected ? (base.map((value) => value + (1 - value) * SELECTED_LIGHTEN) as Vec3) : base;
    for (const triangle of objectVolume(object)) push(triangle, color, flat ? FLAT_LIFT * (index + 1) : 0);
  });
  for (const extra of extras) for (const triangle of extra.triangles) push(triangle, rgb(extra.color));
  const triangles = values.length / 27;
  // Земля — последней: два треугольника до самого горизонта (GROUND_REACH), сетка — только вокруг схемы.
  const bounds = schemeBounds(scheme.objects) ?? [-10, -10, 10, 10];
  const margin = Math.max(10, (bounds[2] - bounds[0] + bounds[3] - bounds[1]) / 2);
  const [x0, y0, x1, y1] = [bounds[0] - margin, bounds[1] - margin, bounds[2] + margin, bounds[3] + margin];
  const [g0, h0, g1, h1] = [bounds[0] - GROUND_REACH, bounds[1] - GROUND_REACH, bounds[2] + GROUND_REACH, bounds[3] + GROUND_REACH];
  push(
    [
      [g0, h0, -0.01],
      [g1, h0, -0.01],
      [g1, h1, -0.01]
    ],
    ground
  );
  push(
    [
      [g0, h0, -0.01],
      [g1, h1, -0.01],
      [g0, h1, -0.01]
    ],
    ground
  );
  const count = values.length / 9;
  for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) values.push(x, y0, 0, 0, 0, 1, ...gridColor, x, y1, 0, 0, 0, 1, ...gridColor);
  for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) values.push(x0, y, 0, 0, 0, 1, ...gridColor, x1, y, 0, 0, 0, 1, ...gridColor);
  return { data: new Float32Array(values), count, lines: values.length / 9 - count, triangles };
}

/**
 * Программа шейдеров и раскладка вершин сцены в контексте gl; не собралась — null. Общая для вида на экране и
 * снимка вида (volumeSnapshot).
 */
function createVolumeProgram(gl: WebGLRenderingContext): WebGLUniformLocation | null {
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
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
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
  return gl.getUniformLocation(program, 'matrix')!;
}

/** Цвета вида: земля, сетка и небо светлой и тёмной темы. */
const SCENE_COLORS = {
  light: { ground: '#c9d6c0', grid: '#a9bba0', sky: '#e3edf5' },
  dark: { ground: '#3a4a3a', grid: '#55665a', sky: '#1e2a33' }
} as const;

/** Размер сцены для сетки и проекции: наибольшая сторона схемы, не меньше 10 м. */
function sceneExtent(scheme: Scheme): number {
  const bounds = schemeBounds(scheme.objects) ?? [-10, -10, 10, 10];
  return Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1], 10);
}

/**
 * Снимок вида из камеры camera — PNG (data URL) width × height пикселей: тот же объём схемы и фигуры extras, что на
 * экране, но всегда в светлых цветах и без подписей и стрелки севера — снимок уходит генератору изображений как
 * схема композиции, и тема интерфейса на него не влияет. Рисуется на отдельном холсте вне страницы; без WebGL — null.
 */
export function volumeSnapshot(scheme: Scheme, camera: Camera3D, extras: readonly VolumeExtra[], width: number, height: number): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: true });
  if (!gl) return null;
  const matrixLocation = createVolumeProgram(gl);
  if (!matrixLocation) return null;
  const colors = SCENE_COLORS.light;
  const extent = sceneExtent(scheme);
  const vertices = buildVertices(scheme, null, extras, rgb(colors.ground), rgb(colors.grid), gridStep(extent));
  gl.bufferData(gl.ARRAY_BUFFER, vertices.data, gl.STATIC_DRAW);
  gl.viewport(0, 0, width, height);
  const sky = rgb(colors.sky);
  gl.clearColor(sky[0], sky[1], sky[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.uniformMatrix4fv(matrixLocation, false, new Float32Array(cameraMatrix(camera, width, height, extent)));
  gl.drawArrays(gl.TRIANGLES, 0, vertices.count);
  gl.drawArrays(gl.LINES, vertices.count, vertices.lines);
  const url = canvas.toDataURL('image/png');
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return url;
}

/**
 * Объём схемы в перспективе (WebGL без библиотек). Без camera — облёт: перетаскивание вращает вид,
 * колесо приближает, стрелки и +/− делают то же с клавиатуры, подписи объектов стоят над их верхом. Щелчок без
 * сдвига выбирает ближайший объект под указателем (onSelect, пустое место — null), выбранный светлеет. Облёт
 * запоминается под viewKey и возвращается, когда вид открывают снова. С camera —
 * неподвижный кадр точки съёмки без подписей: подпись спрятанного объекта выдавала бы его в кадре. Кадр
 * перерисовывается только при изменении сцены, размера или вида. С aspect высота следует из ширины, как у кадра
 * видео. Без WebGL — понятное сообщение вместо сцены.
 */
export function SchemeVolumeView({
  scheme,
  label,
  height,
  camera,
  extras = [],
  aspect,
  selected = null,
  onSelect,
  viewKey
}: {
  scheme: Scheme;
  /** Доступное имя области. */
  label: string;
  /** Высота области, px; не нужна при aspect. */
  height?: number;
  camera?: Camera3D;
  extras?: readonly VolumeExtra[];
  /** Пропорция кадра ширина / высота: высота считается из ширины. */
  aspect?: number;
  /** Выбранный объект схемы. */
  selected?: string | null;
  onSelect?(id: string | null): void;
  /** Ключ localStorage, под которым запоминается облёт. */
  viewKey?: string;
}): ReactElement {
  const theme = useTheme();
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<{ gl: WebGLRenderingContext; matrix: WebGLUniformLocation; count: number; lines: number } | null>(null);
  const [width, setWidth] = useState(640);
  const frameHeight = aspect ? Math.round(width / aspect) : (height ?? 360);
  const [failed, setFailed] = useState<string | null>(null);
  const [orbit, setOrbit] = useState<Orbit>(() => (viewKey ? readStoredOrbit(viewKey) : null) ?? { ...ORBIT, distance: null });
  // Записывается только облёт, который человек менял: открытие вида ничего не сохраняет.
  const turned = useRef(false);
  useEffect(() => {
    if (turned.current && viewKey) storeOrbit(viewKey, orbit);
  }, [orbit, viewKey]);
  const drag = useRef<{ x: number; y: number; azimuth: number; elevation: number; moved: boolean } | null>(null);

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
  const extent = sceneExtent(scheme);
  const center: Vec3 = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2, 0];
  const dark = theme.palette.mode === 'dark';
  const step = gridStep(extent);
  const vertices = useMemo(() => {
    const colors = SCENE_COLORS[dark ? 'dark' : 'light'];
    return buildVertices(scheme, selected, extras, rgb(colors.ground), rgb(colors.grid), step);
  }, [scheme, selected, extras, dark, step]);
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
    const matrix = createVolumeProgram(gl);
    if (!matrix) {
      setFailed(schemesTexts.volumeView.unavailable);
      return;
    }
    glRef.current = { gl, matrix, count: 0, lines: 0 };
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
  const matrix = cameraMatrix(view, width, frameHeight, extent);
  useEffect(() => {
    const context = glRef.current;
    const canvas = canvasRef.current;
    if (!context || !canvas) return;
    const { gl } = context;
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(frameHeight * pixelRatio);
    gl.viewport(0, 0, canvas.width, canvas.height);
    const sky = rgb(SCENE_COLORS[theme.palette.mode === 'dark' ? 'dark' : 'light'].sky);
    gl.clearColor(sky[0], sky[1], sky[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(context.matrix, false, new Float32Array(matrix));
    gl.drawArrays(gl.TRIANGLES, 0, context.count);
    gl.drawArrays(gl.LINES, context.count, context.lines);
  });

  // Стрелка севера: направление на экране от центра сцены к точке севернее.
  const from = projectPoint(matrix, center, width, frameHeight);
  const to = projectPoint(matrix, [center[0], center[1] + extent / 4, 0], width, frameHeight);
  const north = from && to ? (Math.atan2(to[0] - from[0], -(to[1] - from[1])) * 180) / Math.PI : 0;
  const labels = camera
    ? []
    : scheme.objects.flatMap((object) => {
        const [x, y] = labelAnchor(object.shape);
        const at = projectPoint(matrix, [x, y, objectTopHeight(object) + 0.3], width, frameHeight);
        return at && at[0] >= 0 && at[0] <= width && at[1] >= 0 && at[1] <= frameHeight
          ? [{ id: object.id, name: object.name, at, chosen: object.id === selected }]
          : [];
      });

  const rotate = (azimuth: number, elevation: number): void => {
    turned.current = true;
    setOrbit((value) => ({ ...value, azimuth: (azimuth + 360) % 360, elevation: Math.min(85, Math.max(5, elevation)) }));
  };
  const zoom = (factor: number): void => {
    turned.current = true;
    setOrbit((value) => ({ ...value, distance: Math.min(extent * 6, Math.max(2, (value.distance ?? extent * 1.3) * factor)) }));
  };
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
      sx={{ position: 'relative', border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden', height: frameHeight }}
      data-volume-view=""
      data-triangles={vertices.triangles}
      data-orbit={`${Math.round(orbit.azimuth)},${Math.round(orbit.elevation)}`}
    >
      <canvas
        ref={canvasRef}
        role="application"
        aria-label={label}
        tabIndex={camera ? -1 : 0}
        style={{ display: 'block', width, height: frameHeight, cursor: camera ? 'default' : drag.current ? 'grabbing' : 'grab', touchAction: 'none' }}
        onKeyDown={keyDown}
        onPointerDown={(event) => {
          if (camera) return;
          drag.current = { x: event.clientX, y: event.clientY, azimuth: orbit.azimuth, elevation: orbit.elevation, moved: false };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start) return;
          if (!start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < CLICK_SLOP) return;
          start.moved = true;
          rotate(start.azimuth - (event.clientX - start.x) * 0.4, start.elevation + (event.clientY - start.y) * 0.3);
        }}
        onPointerUp={(event) => {
          const start = drag.current;
          drag.current = null;
          if (!start || start.moved || !onSelect) return;
          const box = event.currentTarget.getBoundingClientRect();
          const { origin, direction } = pixelRay(view, width, frameHeight, [event.clientX - box.left, event.clientY - box.top]);
          onSelect(pickObject(drawOrder(scheme.objects), origin, direction));
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
            bgcolor: item.chosen ? 'primary.main' : 'background.paper',
            color: item.chosen ? 'primary.contrastText' : 'text.primary',
            fontWeight: item.chosen ? 600 : undefined,
            opacity: item.chosen ? 1 : 0.9,
            whiteSpace: 'nowrap'
          }}
          data-volume-label={item.id}
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
