/**
 * Источник и луч эффекта на кадре плана — общее превью страницы «Эффекты» с включёнными ручками:
 * кадр превью в середине поля с запасом вокруг (пропорции поля те же 16:9, поэтому оно занимает
 * место обычного кадра) — источник
 * можно увести за край кадра. Ручки: источник, направление луча (на оси на постоянном расстоянии),
 * край конуса (ширина луча) и дальность (на оси, когда она помещается в поле). Щелчок по полю
 * ставит источник в эту точку; ручки двигаются и стрелками клавиатуры. Координаты — в пикселях
 * полного кадра, как их считает Go; новые значения уходят наверх тем же черновиком, что и поля.
 */
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react';
import { Box, Typography } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import type { EffectParamSpec } from '@shared/types';
import {
  BEAM_FRAME,
  beamGeometry,
  dragCone,
  dragDirection,
  dragRadius,
  dragSource,
  roundToStep,
  stepValue,
  withValue,
  type EffectBeam,
  type EffectStep
} from '@shared/effects';
import { effectsTexts as texts } from '@shared/texts/effects';

/** Запас поля вокруг кадра, доля его ширины и высоты с каждой стороны. */
const MARGIN = 0.4;
const VIEW = {
  x: -MARGIN * BEAM_FRAME.width,
  y: -MARGIN * BEAM_FRAME.height,
  width: (1 + 2 * MARGIN) * BEAM_FRAME.width,
  height: (1 + 2 * MARGIN) * BEAM_FRAME.height
};
/** Радиус ручки и толщина линий в единицах поля (пиксели полного кадра). */
const HANDLE = VIEW.width * 0.014;
const STROKE = VIEW.width * 0.003;
/** Расстояние ручек направления и края луча от источника, доля диагонали кадра. */
const ARM = 0.28 * Math.hypot(BEAM_FRAME.width, BEAM_FRAME.height);

type Handle = 'source' | 'direction' | 'cone' | 'radius';

/** Точка в поле: та же, если внутри, иначе — у края поля. */
function inside(x: number, y: number): { x: number; y: number; clamped: boolean } {
  const cx = Math.min(VIEW.x + VIEW.width - HANDLE, Math.max(VIEW.x + HANDLE, x));
  const cy = Math.min(VIEW.y + VIEW.height - HANDLE, Math.max(VIEW.y + HANDLE, y));
  return { x: cx, y: cy, clamped: cx !== x || cy !== y };
}

function within(x: number, y: number): boolean {
  return x >= VIEW.x && x <= VIEW.x + VIEW.width && y >= VIEW.y && y <= VIEW.y + VIEW.height;
}

export function BeamEditor({
  beam,
  specs,
  step,
  frameUrl,
  disabled,
  onChange
}: {
  beam: EffectBeam;
  /** Схемы параметров эффекта: пределы и шаг значений ручек. */
  specs: EffectParamSpec[];
  step: EffectStep;
  /** Кадр превью плана; null — пока не посчитан. */
  frameUrl: string | null;
  disabled?: boolean;
  onChange(step: EffectStep): void;
}): ReactElement {
  const theme = useTheme();
  const ref = useRef<SVGSVGElement>(null);
  const [active, setActive] = useState<Handle | null>(null);
  // id градиента без двоеточий useId: ссылка url(#…) с ними не разбирается.
  const gradient = `beam-light-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const spec = (name: string): EffectParamSpec => {
    const found = specs.find((item) => item.name === name);
    if (!found) throw new Error(`нет параметра ${name}`);
    return found;
  };
  const value = (name: string): number => stepValue(step, spec(name));
  const geometry = beamGeometry(beam, value);
  const set = (values: Record<string, number>): void => {
    let next = step;
    for (const [name, number] of Object.entries(values)) next = withValue(next, spec(name), number);
    onChange(next);
  };

  /** Точка указателя в пикселях полного кадра. */
  const at = (event: PointerEvent<SVGElement>): { x: number; y: number } | null => {
    const matrix = ref.current?.getScreenCTM();
    if (!matrix) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  };
  const move = (handle: Handle, x: number, y: number): void => {
    if (handle === 'source') {
      const next = dragSource({ x: spec(beam.x), y: spec(beam.y) }, x, y);
      set({ [beam.x]: next.x, [beam.y]: next.y });
    } else if (handle === 'direction') set({ [beam.direction]: dragDirection(spec(beam.direction), geometry, x, y) });
    else if (handle === 'cone') set({ [beam.cone]: dragCone(spec(beam.cone), geometry, x, y) });
    else set({ [beam.radius]: dragRadius(spec(beam.radius), geometry, x, y) });
  };
  const down = (handle: Handle) => (event: PointerEvent<SVGElement>) => {
    if (disabled) return;
    event.stopPropagation();
    // Захват держит перетаскивание за краем поля; без активного указателя (события из тестов)
    // браузер его отвергает, и ручка тянется, пока указатель над полем.
    try {
      ref.current?.setPointerCapture(event.pointerId);
    } catch {
      // перетаскивание продолжается без захвата
    }
    setActive(handle);
    if (handle === 'source') {
      const point = at(event);
      if (point) move('source', point.x, point.y);
    }
  };
  const nudge = (handle: Handle) => (event: KeyboardEvent<SVGElement>) => {
    if (disabled) return;
    const big = event.shiftKey ? 5 : 1;
    const dx = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const dy = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!dx && !dy) return;
    event.preventDefault();
    const shift = (name: string, delta: number): number => {
      const item = spec(name);
      return roundToStep(Math.min(item.max, Math.max(item.min, value(name) + delta * item.step * big)), item.step);
    };
    if (handle === 'source') set({ [beam.x]: shift(beam.x, dx), [beam.y]: shift(beam.y, dy) });
    else if (handle === 'direction') set({ [beam.direction]: (Math.round(value(beam.direction) - (dx || dy) * big) + 360) % 360 });
    else if (handle === 'cone') set({ [beam.cone]: shift(beam.cone, dx || -dy) });
    else set({ [beam.radius]: shift(beam.radius, dx || -dy) });
  };

  const along = (angle: number, distance: number): { x: number; y: number } => ({
    x: geometry.x + distance * Math.cos(angle),
    y: geometry.y - distance * Math.sin(angle)
  });
  const full = geometry.half >= Math.PI;
  const source = inside(geometry.x, geometry.y);
  const directionHandle = along(geometry.direction, ARM);
  const coneHandle = along(geometry.direction + Math.min(geometry.half, Math.PI), ARM * 0.8);
  const reach = along(geometry.direction, geometry.radius);
  const reachShown = within(reach.x, reach.y);
  const light = theme.palette.warning.main;
  const accent = disabled ? theme.palette.action.disabled : theme.palette.primary.main;
  let sector: string;
  if (full) sector = '';
  else {
    const a = along(geometry.direction + geometry.half, geometry.radius);
    const b = along(geometry.direction - geometry.half, geometry.radius);
    sector = `M ${geometry.x} ${geometry.y} L ${a.x} ${a.y} A ${geometry.radius} ${geometry.radius} 0 ${geometry.half * 2 > Math.PI ? 1 : 0} 1 ${b.x} ${b.y} Z`;
  }
  // Ручка края луча — кольцо, остальные — сплошные: на кадре их не спутать с источником.
  const handle = (name: Handle, x: number, y: number, label: string, fill: string, ring = false): ReactElement => (
    <circle
      cx={x}
      cy={y}
      r={active === name ? HANDLE * 1.25 : HANDLE}
      fill={ring ? theme.palette.background.paper : fill}
      stroke={ring ? fill : theme.palette.background.paper}
      strokeWidth={ring ? STROKE * 2.5 : STROKE}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-disabled={disabled}
      data-handle={name}
      onPointerDown={down(name)}
      onKeyDown={nudge(name)}
      style={{ cursor: disabled ? 'default' : 'grab', outline: 'none' }}
    />
  );
  return (
    <Box sx={{ width: '100%' }}>
      <Box
        sx={{
          aspectRatio: `${VIEW.width} / ${VIEW.height}`,
          borderRadius: 1,
          overflow: 'hidden',
          bgcolor: 'action.hover',
          '& [data-handle]:focus-visible': { stroke: theme.palette.text.primary, strokeWidth: STROKE * 2 }
        }}
      >
        <svg
          ref={ref}
          width="100%"
          height="100%"
          viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.width} ${VIEW.height}`}
          role="group"
          aria-label={texts.beam.label}
          data-testid="beam-editor"
          onPointerDown={down('source')}
          onPointerMove={(event) => {
            if (!active) return;
            const point = at(event);
            if (point) move(active, point.x, point.y);
          }}
          onPointerUp={() => setActive(null)}
          onLostPointerCapture={() => setActive(null)}
          onPointerCancel={() => setActive(null)}
          style={{ display: 'block', touchAction: 'none', cursor: disabled ? 'default' : 'crosshair' }}
        >
          <defs>
            <radialGradient id={gradient} gradientUnits="userSpaceOnUse" cx={geometry.x} cy={geometry.y} r={geometry.radius}>
              <stop offset="0" stopColor={light} stopOpacity={0.55} />
              <stop offset="1" stopColor={light} stopOpacity={0} />
            </radialGradient>
          </defs>
          {frameUrl ? <image href={frameUrl} x={0} y={0} width={BEAM_FRAME.width} height={BEAM_FRAME.height} preserveAspectRatio="none" /> : null}
          <rect x={0} y={0} width={BEAM_FRAME.width} height={BEAM_FRAME.height} fill="none" stroke={theme.palette.divider} strokeWidth={STROKE} />
          {full ? (
            <circle cx={geometry.x} cy={geometry.y} r={geometry.radius} fill={`url(#${gradient})`} />
          ) : (
            <path d={sector} fill={`url(#${gradient})`} stroke={alpha(light, 0.8)} strokeWidth={STROKE} strokeDasharray={`${STROKE * 4} ${STROKE * 3}`} />
          )}
          <circle
            cx={geometry.x}
            cy={geometry.y}
            r={geometry.radius}
            fill="none"
            stroke={alpha(light, 0.5)}
            strokeWidth={STROKE}
            strokeDasharray={`${STROKE * 2} ${STROKE * 4}`}
          />
          <line x1={geometry.x} y1={geometry.y} x2={directionHandle.x} y2={directionHandle.y} stroke={accent} strokeWidth={STROKE * 1.5} />
          {handle('direction', directionHandle.x, directionHandle.y, texts.beam.direction({ value: value(beam.direction) }), accent)}
          <line
            x1={geometry.x}
            y1={geometry.y}
            x2={coneHandle.x}
            y2={coneHandle.y}
            stroke={theme.palette.info.main}
            strokeWidth={STROKE}
            strokeDasharray={`${STROKE * 3} ${STROKE * 3}`}
          />
          {handle('cone', coneHandle.x, coneHandle.y, texts.beam.cone({ value: value(beam.cone) }), theme.palette.info.main, true)}
          {reachShown ? handle('radius', reach.x, reach.y, texts.beam.radius({ value: value(beam.radius) }), theme.palette.success.main) : null}
          {handle('source', source.x, source.y, texts.beam.source({ x: value(beam.x), y: value(beam.y) }), light)}
        </svg>
      </Box>
      {source.clamped ? (
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
          {texts.beam.outside}
        </Typography>
      ) : null}
    </Box>
  );
}
