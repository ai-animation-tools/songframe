import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactElement } from 'react';
import { Box, IconButton, Tooltip, useTheme } from '@mui/material';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import { schemesTexts } from '@shared/texts/schemes';
import type { Scheme, SchemeObject, SchemePoint } from '@shared/schemes';
import { drawOrder, ellipseOutline, labelAnchor, objectColor, rectCorners, schemeBounds, smoothCurve, type Bounds } from '@shared/scheme-editing';
import { fitViewport, snap, toScreen, toWorld, zoomViewportAt, type Viewport } from '@shared/scheme-canvas';
import { fovThrough, viewSector } from '@shared/viewpoint';

/**
 * Камера на мини-схеме: место на первом кадре и, если движется, на последнем; направление взгляда на каждом
 * (градусы против часовой от востока; null — сверху) и угол обзора.
 */
export interface PreviewCamera {
  start: SchemePoint;
  end?: SchemePoint;
  startHeading: number | null;
  endHeading: number | null;
  fov: number;
}

/** Герой на мини-схеме: подпись (имя и расстояние), путь и признак фокуса. */
export interface PreviewSubject {
  entity: string;
  label: string;
  start: SchemePoint;
  end?: SchemePoint;
  focus: boolean;
}

/**
 * Запас вокруг схемы при вписывании, доля большего размера рамки с каждой стороны: камеру общего плана ставят далеко
 * за краем локации, и для неё нужно место на мини-схеме.
 */
const AROUND = 0.5;
/** Сдвиг указателя, после которого нажатие сдвигает схему, а не ставит точку, px. */
const CLICK_SLOP = 4;

/** Длина сектора обзора в пикселях: заметен на схеме любого размера и не уходит далеко за её края. */
const SECTOR_PX = 160;

/**
 * Мини-схема вида сверху только для чтения: объекты схемы, север, камера с сектором обзора и герои. Движение
 * показано пунктирной стрелкой к месту на последнем кадре, там же пунктиром сектор конца. Щелчок по схеме сообщает
 * место в метрах (onPick), край сектора первого кадра тянется мышью и меняет угол обзора (onFov). Масштаб вписывает
 * схему и точки с запасом вокруг при смене схемы и ширины, а не при каждом сдвиге точки, чтобы схема не прыгала под
 * мышью. Колесо приближает у курсора, перетаскивание сдвигает схему, кнопка «Показать всё» возвращает вписанный вид.
 */
export function SchemePreview({
  scheme,
  label,
  camera = null,
  subjects = [],
  disabled = false,
  height = 300,
  onPick,
  onFov
}: {
  scheme: Scheme;
  /** Доступное имя области. */
  label: string;
  camera?: PreviewCamera | null;
  subjects?: readonly PreviewSubject[];
  disabled?: boolean;
  height?: number;
  onPick?(point: SchemePoint): void;
  onFov?(fov: number): void;
}): ReactElement {
  const theme = useTheme();
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(480);
  const [dragging, setDragging] = useState(false);
  // Свой вид человека (колесо, сдвиг) поверх вписанного; смена схемы или размера возвращает вписанный.
  const [own, setOwn] = useState<Pick<Viewport, 'center' | 'scale'> | null>(null);
  const press = useRef<{ x: number; y: number; center: SchemePoint; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const update = (): void => setWidth(Math.max(240, Math.round(box.getBoundingClientRect().width)));
    const observer = new ResizeObserver(update);
    observer.observe(box);
    update();
    return () => observer.disconnect();
  }, []);

  // Рамка вписывания: объекты схемы и все точки на момент смены схемы или ширины.
  const points: SchemePoint[] = [
    ...(camera ? [camera.start, ...(camera.end ? [camera.end] : [])] : []),
    ...subjects.flatMap((subject) => [subject.start, ...(subject.end ? [subject.end] : [])])
  ];
  const fitted: Viewport = useMemo(() => {
    let bounds: Bounds | null = schemeBounds(scheme.objects);
    for (const point of points) {
      bounds = bounds
        ? [Math.min(bounds[0], point[0]), Math.min(bounds[1], point[1]), Math.max(bounds[2], point[0]), Math.max(bounds[3], point[1])]
        : [point[0] - 5, point[1] - 5, point[0] + 5, point[1] + 5];
    }
    const around = bounds ? Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]) * AROUND : 0;
    return fitViewport(bounds && [bounds[0] - around, bounds[1] - around, bounds[2] + around, bounds[3] + around], width, height);
    // Точки не в зависимостях: их сдвиг не меняет масштаб.
  }, [scheme.id, scheme.objects, width, height]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setOwn(null), [scheme.id, width, height]);
  const viewport: Viewport = own ? { ...own, width, height } : fitted;

  // Колесо без пассивного слушателя: прокрутка страницы не должна срабатывать над схемой.
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const wheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const next = zoomViewportAt(viewportRef.current, [event.clientX - rect.left, event.clientY - rect.top], event.deltaY < 0 ? 1.15 : 1 / 1.15, 'top');
      setOwn({ center: next.center, scale: next.scale });
    };
    svg.addEventListener('wheel', wheel, { passive: false });
    return () => svg.removeEventListener('wheel', wheel);
  }, []);

  const screen = (point: SchemePoint): SchemePoint => toScreen(point, viewport, 'top');
  const path = (points: SchemePoint[], closed: boolean): string =>
    points.map((point, index) => `${index ? 'L' : 'M'}${screen(point).join(' ')}`).join(' ') + (closed ? ' Z' : '');
  const worldOf = (event: PointerEvent): SchemePoint => {
    const rect = event.currentTarget.closest('svg')!.getBoundingClientRect();
    const world = toWorld([event.clientX - rect.left, event.clientY - rect.top], viewport, 'top');
    return [snap(world[0], 0.1), snap(world[1], 0.1)];
  };

  const renderObject = (object: SchemeObject): ReactElement => {
    const color = objectColor(object);
    const common = { stroke: color, strokeWidth: 1.2, fill: color, fillOpacity: 0.25 };
    const { shape } = object;
    switch (shape.type) {
      case 'rect':
        return <path d={path(rectCorners(shape), true)} {...common} />;
      case 'ellipse':
        return <path d={path(ellipseOutline(shape), true)} {...common} />;
      case 'polygon':
        return <path d={path(shape.points, true)} {...common} />;
      case 'line': {
        const d = path(shape.smooth ? smoothCurve(shape.points, !!shape.closed) : shape.points, !!shape.closed && !shape.smooth);
        return (
          <g>
            {shape.width ? (
              <path d={d} fill="none" stroke={color} strokeOpacity={0.35} strokeWidth={shape.width * viewport.scale} strokeLinejoin="round" />
            ) : null}
            <path d={d} fill="none" stroke={color} strokeWidth={1.5} />
          </g>
        );
      }
      case 'point': {
        const [x, y] = screen(shape.at);
        return <circle cx={x} cy={y} r={4} fill={color} />;
      }
    }
  };
  const renderLabel = (object: SchemeObject): ReactElement => {
    const [x, y] = screen(labelAnchor(object.shape));
    return (
      <text
        x={x}
        y={object.shape.type === 'point' ? y - 8 : y}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={11}
        fill={theme.palette.text.primary}
        stroke={theme.palette.background.paper}
        strokeWidth={3}
        paintOrder="stroke"
      >
        {object.name}
      </text>
    );
  };

  const ordered = drawOrder(scheme.objects);
  const primary = theme.palette.primary.main;
  const accent = theme.palette.secondary.main;
  const sectorLength = SECTOR_PX / viewport.scale;
  const sector = camera && camera.startHeading !== null ? viewSector(camera.start, camera.startHeading, camera.fov, sectorLength) : null;
  const endSector = camera?.end && camera.endHeading !== null ? viewSector(camera.end, camera.endHeading, camera.fov, sectorLength) : null;
  const edge = sector ? screen(sector[1]) : null;
  // Пунктирная стрелка пути от первого кадра к последнему.
  const route = (from: SchemePoint, to: SchemePoint | undefined, color: string, marker: string): ReactElement | null => {
    if (!to) return null;
    const [x1, y1] = screen(from);
    const [x2, y2] = screen(to);
    return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={1.5} strokeDasharray="5 4" markerEnd={`url(#${marker})`} />;
  };

  return (
    <Box ref={boxRef} sx={{ position: 'relative', border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden', bgcolor: 'background.paper' }}>
      <svg
        ref={svgRef}
        role="application"
        aria-label={label}
        width={width}
        height={height}
        style={{ display: 'block', touchAction: 'none', cursor: dragging || press.current?.moved ? 'grabbing' : disabled || !onPick ? 'grab' : 'crosshair' }}
        onPointerDown={(event) => {
          press.current = { x: event.clientX, y: event.clientY, center: viewport.center, moved: false };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (dragging) {
            if (camera && camera.startHeading !== null && onFov) onFov(fovThrough(camera.start, camera.startHeading, worldOf(event)));
            return;
          }
          const start = press.current;
          if (!start) return;
          const dx = event.clientX - start.x;
          const dy = event.clientY - start.y;
          if (!start.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
          start.moved = true;
          setOwn({ center: [start.center[0] - dx / viewport.scale, start.center[1] + dy / viewport.scale], scale: viewport.scale });
        }}
        onPointerUp={(event) => {
          const start = press.current;
          press.current = null;
          if (dragging) {
            setDragging(false);
            return;
          }
          if (start && !start.moved && !disabled && onPick) onPick(worldOf(event));
        }}
      >
        <g style={{ pointerEvents: 'none' }}>
          {ordered.map((object) => (
            <g key={object.id}>{renderObject(object)}</g>
          ))}
          {ordered.map((object) => (
            <g key={`label-${object.id}`}>{renderLabel(object)}</g>
          ))}
        </g>
        <defs>
          <marker id="scheme-preview-camera-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 Z" fill={primary} />
          </marker>
          <marker id="scheme-preview-subject-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 Z" fill={accent} />
          </marker>
        </defs>
        {subjects.map((subject) => {
          const [x, y] = screen(subject.start);
          return (
            <g key={subject.entity} data-subject={subject.entity} style={{ pointerEvents: 'none' }}>
              {route(subject.start, subject.end, accent, 'scheme-preview-subject-arrow')}
              {subject.end ? (
                <circle cx={screen(subject.end)[0]} cy={screen(subject.end)[1]} r={5} fill={theme.palette.background.paper} stroke={accent} strokeWidth={2} />
              ) : null}
              <circle cx={x} cy={y} r={6} fill={subject.focus ? accent : theme.palette.background.paper} stroke={accent} strokeWidth={2} />
              <text
                x={x + 9}
                y={y - 9}
                fontSize={12}
                fontWeight={subject.focus ? 700 : 500}
                fill={theme.palette.text.primary}
                stroke={theme.palette.background.paper}
                strokeWidth={3}
                paintOrder="stroke"
              >
                {subject.label}
              </text>
            </g>
          );
        })}
        {camera ? (
          <g data-camera="">
            {sector ? (
              <path d={path(sector, true)} fill={primary} fillOpacity={0.15} stroke={primary} strokeWidth={1.5} style={{ pointerEvents: 'none' }} />
            ) : null}
            {endSector ? (
              <path
                d={path(endSector, true)}
                fill="none"
                stroke={primary}
                strokeWidth={1.2}
                strokeDasharray="4 3"
                data-camera-end=""
                style={{ pointerEvents: 'none' }}
              />
            ) : null}
            <g style={{ pointerEvents: 'none' }}>{route(camera.start, camera.end, primary, 'scheme-preview-camera-arrow')}</g>
            {camera.startHeading === null ? (
              <circle cx={screen(camera.start)[0]} cy={screen(camera.start)[1]} r={14} fill="none" stroke={primary} strokeDasharray="4 3" />
            ) : null}
            {camera.end ? (
              <circle
                cx={screen(camera.end)[0]}
                cy={screen(camera.end)[1]}
                r={6}
                fill={theme.palette.background.paper}
                stroke={primary}
                strokeWidth={2}
                style={{ pointerEvents: 'none' }}
              />
            ) : null}
            <circle
              cx={screen(camera.start)[0]}
              cy={screen(camera.start)[1]}
              r={7}
              fill={primary}
              stroke={theme.palette.background.paper}
              strokeWidth={2}
              style={{ pointerEvents: 'none' }}
            />
            {edge && !disabled && onFov ? (
              <circle
                data-fov-handle=""
                cx={edge[0]}
                cy={edge[1]}
                r={7}
                fill={theme.palette.background.paper}
                stroke={primary}
                strokeWidth={2}
                style={{ cursor: 'grab' }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  setDragging(true);
                  (event.target as Element).setPointerCapture?.(event.pointerId);
                }}
              />
            ) : null}
          </g>
        ) : null}
        <g transform={`translate(${width - 22} 26)`} style={{ pointerEvents: 'none' }}>
          <path d="M0 -14 L6 3 L0 0 L-6 3 Z" fill={theme.palette.text.primary} />
          <text y={15} textAnchor="middle" fontSize={11} fontWeight={600} fill={theme.palette.text.primary}>
            {schemesTexts.north}
          </text>
        </g>
      </svg>
      {own ? (
        <Tooltip title={schemesTexts.fit}>
          <IconButton
            size="small"
            aria-label={schemesTexts.fit}
            onClick={() => setOwn(null)}
            sx={{ position: 'absolute', left: 6, top: 6, bgcolor: 'background.paper', '&:hover': { bgcolor: 'action.hover' } }}
          >
            <FitScreenIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      ) : null}
    </Box>
  );
}
