import { schemesTexts } from '@shared/texts/schemes';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react';
import { Box, useTheme } from '@mui/material';
import type { Scheme, SchemeObject, SchemePoint, SchemeShape, SchemeShapeType, SchemeViewKind } from '@shared/schemes';
import {
  appendPoint,
  createObject,
  createShape,
  ellipseOutline,
  objectColor,
  drawOrder,
  hasVertices,
  moveHandle,
  moveShape,
  rectCorners,
  removeHandle,
  schemeBounds,
  labelAnchor,
  shapeHandles,
  smoothCurve
} from '@shared/scheme-editing';
import { clampScale, fitViewport, formatMetres, gridStep, snap, toScreen, toWorld, zoomViewportAt, type Viewport } from '@shared/scheme-canvas';

/** Инструмент холста: выбор и перемещение или рисование фигуры. */
export type SchemeTool = 'select' | SchemeShapeType;

/** Наименьшая высота холста, px: страница растягивает его на свободную высоту окна. */
export const MIN_CANVAS_HEIGHT = 420;

/** Ширина невидимой полосы попадания вокруг линий и точек, px. */
const HIT_WIDTH = 16;

/** Текущее действие мышью: сдвиг вида, перенос объекта или вершины, протягивание рамки новой фигуры. */
type Drag =
  | { kind: 'pan'; from: SchemePoint; center: SchemePoint }
  | { kind: 'move'; id: string; from: SchemePoint; shape: SchemeShape; moved: boolean }
  | { kind: 'handle'; id: string; index: number; shape: SchemeShape }
  | { kind: 'frame'; type: 'rect' | 'ellipse'; from: SchemePoint; to: SchemePoint };

/**
 * Запомненный вид схемы из localStorage: центр в метрах и масштаб. Это предпочтение человека в окне, а не данные
 * клипа; недоступное хранилище или негодное значение — вид не запомнен.
 */
function readStoredView(key: string): Pick<Viewport, 'center' | 'scale'> | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as { center?: unknown; scale?: unknown } | null;
    const center = value?.center;
    const scale = value?.scale;
    if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite) || typeof scale !== 'number' || !Number.isFinite(scale)) return null;
    return { center: [center[0] as number, center[1] as number], scale: clampScale(scale) };
  } catch {
    return null;
  }
}

/** Запоминает вид схемы; хранилище, не принявшее запись, работе не мешает. */
function storeView(key: string, viewport: Viewport): void {
  try {
    localStorage.setItem(key, JSON.stringify({ center: viewport.center, scale: viewport.scale }));
  } catch {
    // Вид действует до закрытия окна.
  }
}

/**
 * Холст редактора схем: сетка в метрах, фигуры с подписями, выбор и перемещение, рисование выбранным инструментом.
 * Колесо меняет масштаб вокруг курсора, перетаскивание пустого места двигает вид. Вид, который человек выбрал
 * колесом, перетаскиванием или «Показать всё», запоминается под viewKey и возвращается при следующем открытии
 * схемы; без запомненного вида схема вписывается в холст. Все правки уходят в onChange
 * новой схемой; координаты прилипают к клеткам текущего масштаба (см. `snap`). Инструмент рисования остаётся
 * включённым после фигуры, Esc без черновика возвращает выбор.
 */
export function SchemeCanvas({
  scheme,
  tool,
  selected,
  fitSignal,
  height,
  viewKey,
  onSelect,
  onChange,
  onToolCancel
}: {
  scheme: Scheme;
  /** Высота холста, px: страница отдаёт ему свободную высоту окна под закреплённой панелью инструментов. */
  height: number;
  tool: SchemeTool;
  selected: string | null;
  /** Смена значения вписывает все объекты в холст (кнопка «Показать всё», смена схемы). */
  fitSignal: number;
  /** Ключ localStorage для вида схемы (центр и масштаб); нет — вид не запоминается. */
  viewKey?: string;
  onSelect(id: string | null): void;
  onChange(scheme: Scheme): void;
  /** Esc без черновика при включённом рисовании: страница возвращает инструмент выбора. */
  onToolCancel(): void;
}): ReactElement {
  const theme = useTheme();
  const view: SchemeViewKind = scheme.view;
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(800);
  const [viewport, setViewport] = useState<Viewport>(() => fitViewport(schemeBounds(scheme.objects), 800, height));
  const [drag, setDrag] = useState<Drag | null>(null);
  // Вершины линии или многоугольника, которые рисуются щелчками, и положение курсора для следующего отрезка.
  const [draft, setDraft] = useState<SchemePoint[]>([]);
  const [cursor, setCursor] = useState<SchemePoint | null>(null);
  const [handle, setHandle] = useState<number | null>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const update = (): void => setWidth(Math.max(320, Math.round(box.getBoundingClientRect().width)));
    const observer = new ResizeObserver(update);
    observer.observe(box);
    update();
    return () => observer.disconnect();
  }, []);

  // Вид выбран человеком (колесо, перетаскивание, «Показать всё» или запомненный): смена размера холста его
  // не сбрасывает и он запоминается. Невыбранный вид вписывает схему при каждом изменении размера.
  const chosen = useRef(false);
  const lastFit = useRef(fitSignal);
  const fit = (): void => setViewport(fitViewport(schemeBounds(scheme.objects), width, height));
  // Смена схемы: запомненный вид или вписывание. Объекты не в зависимостях: правка фигуры не меняет масштаб.
  useEffect(() => {
    const stored = viewKey ? readStoredView(viewKey) : null;
    chosen.current = !!stored;
    if (stored) setViewport((value) => ({ ...value, ...stored }));
    else fit();
  }, [scheme.id, viewKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!chosen.current) fit();
  }, [width, height]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (fitSignal === lastFit.current) return;
    lastFit.current = fitSignal;
    chosen.current = true;
    fit();
  }, [fitSignal]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (chosen.current && viewKey) storeView(viewKey, viewport);
  }, [viewport, viewKey]);

  useEffect(() => {
    setDraft([]);
    setHandle(null);
  }, [tool, scheme.id]);

  // Колесо без пассивного слушателя: прокрутка страницы не должна срабатывать над холстом.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const wheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const pixel: SchemePoint = [event.clientX - rect.left, event.clientY - rect.top];
      chosen.current = true;
      setViewport((current) => zoomViewportAt(current, pixel, event.deltaY < 0 ? 1.15 : 1 / 1.15, view));
    };
    svg.addEventListener('wheel', wheel, { passive: false });
    return () => svg.removeEventListener('wheel', wheel);
  }, [view]);

  const current: Viewport = { ...viewport, width, height };
  const step = gridStep(current.scale);
  const screen = (point: SchemePoint): SchemePoint => toScreen(point, current, view);
  const pixelOf = (event: PointerEvent): SchemePoint => {
    const rect = svgRef.current!.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };
  const worldOf = (event: PointerEvent): SchemePoint => {
    const world = toWorld(pixelOf(event), current, view);
    return [snap(world[0], step), snap(world[1], step)];
  };
  const replace = (id: string, shape: SchemeShape): void =>
    onChange({ ...scheme, objects: scheme.objects.map((object) => (object.id === id ? { ...object, shape } : object)) });
  const add = (shape: SchemeShape): void => {
    // Номер нового объекта — первый свободный: после удалений названия не повторяются.
    const names = new Set(scheme.objects.map((item) => item.name));
    let number = scheme.objects.length + 1;
    while (names.has(schemesTexts.newObject({ number }))) number += 1;
    const object = createObject(scheme, shape, schemesTexts.newObject({ number }));
    onChange({ ...scheme, objects: [...scheme.objects, object] });
    onSelect(object.id);
  };
  const finishDraft = (): void => {
    const minimum = tool === 'polygon' ? 3 : 2;
    if ((tool === 'polygon' || tool === 'line') && draft.length >= minimum) {
      add(tool === 'polygon' ? { type: 'polygon', points: draft } : { type: 'line', points: draft, smooth: false, closed: false });
    }
    setDraft([]);
  };

  const startBackground = (event: PointerEvent): void => {
    svgRef.current?.focus({ preventScroll: true });
    const world = worldOf(event);
    if (tool === 'select') {
      onSelect(null);
      setHandle(null);
      setDrag({ kind: 'pan', from: pixelOf(event), center: viewport.center });
    } else if (tool === 'rect' || tool === 'ellipse') {
      setDrag({ kind: 'frame', type: tool, from: world, to: world });
      onSelect(null);
    } else if (tool === 'point') {
      add(createShape('point', world));
    } else {
      setDraft((points) => appendPoint(points, world));
    }
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };
  const startObject = (event: PointerEvent, object: SchemeObject): void => {
    if (tool !== 'select') return;
    event.stopPropagation();
    svgRef.current?.focus({ preventScroll: true });
    onSelect(object.id);
    setHandle(null);
    setDrag({ kind: 'move', id: object.id, from: worldOf(event), shape: object.shape, moved: false });
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };
  const startHandle = (event: PointerEvent, object: SchemeObject, index: number): void => {
    event.stopPropagation();
    svgRef.current?.focus({ preventScroll: true });
    setHandle(index);
    setDrag({ kind: 'handle', id: object.id, index, shape: object.shape });
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };
  const move = (event: PointerEvent): void => {
    const world = worldOf(event);
    setCursor(world);
    if (!drag) return;
    if (drag.kind === 'pan') {
      const pixel = pixelOf(event);
      const sign = view === 'north' || view === 'west' ? -1 : 1;
      chosen.current = true;
      setViewport((value) => ({
        ...value,
        center: [drag.center[0] - (sign * (pixel[0] - drag.from[0])) / value.scale, drag.center[1] + (pixel[1] - drag.from[1]) / value.scale]
      }));
    } else if (drag.kind === 'move') {
      const dx = snap(world[0] - drag.from[0], step);
      const dy = snap(world[1] - drag.from[1], step);
      if (dx || dy || drag.moved) {
        replace(drag.id, moveShape(drag.shape, dx, dy));
        if (!drag.moved) setDrag({ ...drag, moved: true });
      }
    } else if (drag.kind === 'handle') {
      // От формы на начало перетаскивания: ручка рамки, протащенная за противоположную сторону, не скачет.
      replace(drag.id, moveHandle(drag.shape, drag.index, world));
    } else {
      setDrag({ ...drag, to: world });
    }
  };
  const end = (): void => {
    if (drag?.kind === 'frame') add(createShape(drag.type, drag.from, drag.to, step * 2));
    setDrag(null);
  };
  const key = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      setDraft([]);
      setHandle(null);
      if (draft.length) return;
      if (tool !== 'select') onToolCancel();
      else onSelect(null);
    } else if (event.key === 'Enter') {
      finishDraft();
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && selected) {
      event.preventDefault();
      const object = scheme.objects.find((item) => item.id === selected);
      if (!object) return;
      // Ручка вершины удаляет вершину (если фигура остаётся полной); ручка рамки и точка — весь объект.
      if (handle !== null && hasVertices(object.shape) && object.shape.type !== 'point') {
        replace(object.id, removeHandle(object.shape, handle));
        setHandle(null);
      } else {
        onChange({ ...scheme, objects: scheme.objects.filter((item) => item.id !== selected) });
        onSelect(null);
      }
    }
  };

  // Сетка видимой области в метрах.
  const corners = [toWorld([0, 0], current, view), toWorld([width, height], current, view)];
  const [minX, maxX] = [Math.min(corners[0][0], corners[1][0]), Math.max(corners[0][0], corners[1][0])];
  const [minY, maxY] = [Math.min(corners[0][1], corners[1][1]), Math.max(corners[0][1], corners[1][1])];
  const lines: ReactElement[] = [];
  for (let x = Math.ceil(minX / step) * step; x <= maxX; x += step) {
    const [px] = screen([x, 0]);
    lines.push(<line key={`x${x}`} x1={px} x2={px} y1={0} y2={height} stroke={theme.palette.divider} strokeWidth={x === 0 ? 1.5 : 0.5} />);
  }
  for (let y = Math.ceil(minY / step) * step; y <= maxY; y += step) {
    const [, py] = screen([0, y]);
    lines.push(<line key={`y${y}`} x1={0} x2={width} y1={py} y2={py} stroke={theme.palette.divider} strokeWidth={y === 0 ? 1.5 : 0.5} />);
  }
  const path = (points: SchemePoint[], closed: boolean): string =>
    points.map((point, index) => `${index ? 'L' : 'M'}${screen(point).join(' ')}`).join(' ') + (closed ? ' Z' : '');

  const renderShape = (object: SchemeObject): ReactElement => {
    const color = objectColor(object);
    const active = object.id === selected;
    const stroke = active ? theme.palette.primary.main : color;
    const common = {
      stroke,
      strokeWidth: active ? 2.5 : 1.5,
      onPointerDown: (event: PointerEvent) => startObject(event, object),
      style: { cursor: tool === 'select' ? 'move' : undefined, pointerEvents: tool === 'select' ? ('auto' as const) : ('none' as const) }
    };
    const { shape } = object;
    switch (shape.type) {
      case 'rect':
        return <path d={path(rectCorners(shape), true)} fill={color} fillOpacity={0.25} {...common} />;
      case 'ellipse':
        return <path d={path(ellipseOutline(shape), true)} fill={color} fillOpacity={0.25} {...common} />;
      case 'polygon':
        return <path d={path(shape.points, true)} fill={color} fillOpacity={0.25} {...common} />;
      case 'line': {
        const points = shape.smooth ? smoothCurve(shape.points, !!shape.closed) : shape.points;
        const d = path(points, !!shape.closed && !shape.smooth);
        return (
          <g>
            {shape.width ? (
              <path
                d={d}
                fill="none"
                stroke={color}
                strokeOpacity={0.35}
                strokeWidth={shape.width * current.scale}
                strokeLinejoin="round"
                strokeLinecap="round"
                style={common.style}
                onPointerDown={common.onPointerDown}
              />
            ) : null}
            <path d={d} fill="none" {...common} strokeWidth={active ? 3 : 2} />
            {/* Невидимая широкая полоса: тонкую линию легко поймать мышью. */}
            <path
              d={d}
              fill="none"
              stroke="transparent"
              strokeWidth={HIT_WIDTH}
              strokeLinejoin="round"
              strokeLinecap="round"
              data-hit-area=""
              style={{ ...common.style, pointerEvents: tool === 'select' ? 'stroke' : 'none' }}
              onPointerDown={common.onPointerDown}
            />
          </g>
        );
      }
      case 'point': {
        const [x, y] = screen(shape.at);
        return (
          <g>
            <circle cx={x} cy={y} r={6} fill={color} {...common} />
            <circle cx={x} cy={y} r={HIT_WIDTH / 2} fill="transparent" data-hit-area="" style={common.style} onPointerDown={common.onPointerDown} />
          </g>
        );
      }
    }
  };
  const label = (object: SchemeObject): ReactElement => {
    const [x, y] = screen(labelAnchor(object.shape));
    return (
      <text
        x={x}
        y={object.shape.type === 'point' ? y - 10 : y}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={12}
        fill={theme.palette.text.primary}
        stroke={theme.palette.background.paper}
        strokeWidth={3}
        paintOrder="stroke"
        style={{ pointerEvents: 'none', userSelect: 'none' }}
      >
        {object.name}
      </text>
    );
  };

  const ordered = drawOrder(scheme.objects);
  const selectedObject = scheme.objects.find((object) => object.id === selected);
  const preview = (): ReactElement | null => {
    if (drag?.kind === 'frame') {
      const shape = createShape(drag.type, drag.from, drag.to);
      const points = shape.type === 'rect' ? rectCorners(shape) : shape.type === 'ellipse' ? ellipseOutline(shape) : [];
      return <path d={path(points, true)} fill="none" stroke={theme.palette.primary.main} strokeDasharray="6 4" />;
    }
    if (draft.length) {
      const points = cursor ? [...draft, cursor] : draft;
      return <path d={path(points, tool === 'polygon')} fill="none" stroke={theme.palette.primary.main} strokeDasharray="6 4" strokeWidth={2} />;
    }
    return null;
  };

  // Подпись размера рядом с протягиваемой рамкой или ручкой рамки: сразу видно, сколько метров получается.
  const sizeLabel = (): ReactElement | null => {
    const shape =
      drag?.kind === 'frame'
        ? createShape(drag.type, drag.from, drag.to, step * 2)
        : drag?.kind === 'handle'
          ? scheme.objects.find((object) => object.id === drag.id)?.shape
          : undefined;
    if (!shape || !cursor || (shape.type !== 'rect' && shape.type !== 'ellipse')) return null;
    const size = shape.type === 'rect' ? shape.size : [shape.radii[0] * 2, shape.radii[1] * 2];
    const [x, y] = screen(cursor);
    return (
      <text
        x={x + 14}
        y={y - 14}
        fontSize={13}
        fontWeight={600}
        fill={theme.palette.primary.main}
        stroke={theme.palette.background.paper}
        strokeWidth={3}
        paintOrder="stroke"
        data-size-label=""
        style={{ pointerEvents: 'none' }}
      >
        {schemesTexts.frameSize({ width: formatMetres(size[0]), height: formatMetres(size[1]) })}
      </text>
    );
  };
  // Ширина плашки масштаба: отрезок клетки плюс подпись с координатами курсора.
  const statusWidth = Math.min(width - 12, 24 + step * current.scale + 230);

  return (
    <Box ref={boxRef} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden', bgcolor: 'background.paper' }}>
      <svg
        ref={svgRef}
        role="application"
        aria-label={schemesTexts.canvasLabel({ title: scheme.title })}
        tabIndex={0}
        width={width}
        height={height}
        style={{
          display: 'block',
          touchAction: 'none',
          outline: 'none',
          cursor: tool === 'select' ? (drag?.kind === 'pan' ? 'grabbing' : 'grab') : 'crosshair'
        }}
        onPointerDown={startBackground}
        onPointerMove={move}
        onPointerUp={end}
        onDoubleClick={finishDraft}
        onKeyDown={key}
      >
        <g>{lines}</g>
        {view !== 'top' ? (
          <g>
            <line x1={0} x2={width} y1={screen([0, 0])[1]} y2={screen([0, 0])[1]} stroke={theme.palette.text.secondary} strokeWidth={2} />
            <text x={8} y={screen([0, 0])[1] + 14} fontSize={11} fill={theme.palette.text.secondary}>
              {schemesTexts.ground}
            </text>
          </g>
        ) : null}
        {ordered.map((object) => (
          <g key={object.id} data-object-id={object.id}>
            {renderShape(object)}
          </g>
        ))}
        {ordered.map((object) => (
          <g key={`label-${object.id}`}>{label(object)}</g>
        ))}
        {selectedObject && tool === 'select'
          ? shapeHandles(selectedObject.shape).map((point, index) => {
              const [x, y] = screen(point);
              return (
                <g key={index} data-handle={index} style={{ cursor: 'pointer' }} onPointerDown={(event) => startHandle(event, selectedObject, index)}>
                  <rect
                    x={x - 5}
                    y={y - 5}
                    width={10}
                    height={10}
                    fill={index === handle ? theme.palette.primary.main : theme.palette.background.paper}
                    stroke={theme.palette.primary.main}
                    strokeWidth={1.5}
                  />
                  <rect x={x - HIT_WIDTH / 2} y={y - HIT_WIDTH / 2} width={HIT_WIDTH} height={HIT_WIDTH} fill="transparent" />
                </g>
              );
            })
          : null}
        {preview()}
        {view === 'top' ? (
          <g transform={`translate(${width - 28} 32)`} style={{ pointerEvents: 'none' }}>
            <path d="M0 -18 L7 4 L0 0 L-7 4 Z" fill={theme.palette.text.primary} />
            <text y={18} textAnchor="middle" fontSize={12} fontWeight={600} fill={theme.palette.text.primary}>
              {schemesTexts.north}
            </text>
          </g>
        ) : null}
        {sizeLabel()}
        <g style={{ pointerEvents: 'none' }}>
          <rect x={6} y={height - 30} width={statusWidth} height={24} rx={4} fill={theme.palette.background.paper} stroke={theme.palette.divider} />
          <line x1={14} x2={14 + step * current.scale} y1={height - 12} y2={height - 12} stroke={theme.palette.text.primary} strokeWidth={2} />
          <text x={22 + step * current.scale} y={height - 13} fontSize={13} fontWeight={600} fill={theme.palette.text.primary} data-scale-label="">
            {schemesTexts.cell({ value: formatMetres(step) })}
            {cursor ? ` · ${formatMetres(cursor[0])}; ${formatMetres(cursor[1])}` : ''}
          </text>
        </g>
      </svg>
    </Box>
  );
}
