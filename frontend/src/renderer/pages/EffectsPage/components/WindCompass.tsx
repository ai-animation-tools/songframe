/**
 * Ветер дождя на мини-схеме: вид сверху, восток справа, север сверху, как на схемах локаций.
 * Сектор — взгляд камеры первого кадра плана, стрелка — куда дует ветер. Щелчок или
 * перетаскивание задают направление, стрелки клавиатуры поворачивают на 5° (с Shift — на 1°).
 * Градусы — против часовой стрелки от востока, как у направления камеры точки съёмки.
 */
import { useRef, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react';
import { Box } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { effectsTexts as texts } from '@shared/texts/effects';

const SIZE = 132;
const CENTER = SIZE / 2;
const RADIUS = SIZE / 2 - 14;
/** Половина сектора камеры, градусы: условный обзор, только чтобы показать сторону взгляда. */
const HALF_VIEW = 25;

/** Точка на окружности радиуса r под углом degrees (против часовой от востока). */
function point(degrees: number, r: number): [number, number] {
  const rad = (degrees * Math.PI) / 180;
  return [CENTER + r * Math.cos(rad), CENTER - r * Math.sin(rad)];
}

/** Направление 0–359 из точки указателя внутри компаса. */
export function directionAt(x: number, y: number): number {
  const degrees = (Math.atan2(CENTER - y, x - CENTER) * 180) / Math.PI;
  return Math.round((degrees + 360) % 360);
}

export function WindCompass({
  direction,
  heading,
  disabled,
  onChange
}: {
  direction: number;
  /** Направление камеры; null — у плана его нет. */
  heading: number | null;
  disabled?: boolean;
  onChange(direction: number): void;
}): ReactElement {
  const theme = useTheme();
  const ref = useRef<SVGSVGElement>(null);
  const pick = (event: PointerEvent<SVGSVGElement>): void => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || disabled) return;
    onChange(directionAt(((event.clientX - box.left) / box.width) * SIZE, ((event.clientY - box.top) / box.height) * SIZE));
  };
  const key = (event: KeyboardEvent<SVGSVGElement>): void => {
    if (disabled) return;
    const step = event.shiftKey ? 1 : 5;
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? step : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? -step : 0;
    if (!delta) return;
    event.preventDefault();
    onChange((Math.round(direction + delta) + 360) % 360);
  };
  const [tipX, tipY] = point(direction, RADIUS);
  const [tailX, tailY] = point(direction + 180, RADIUS * 0.55);
  const [leftX, leftY] = point(direction + 155, RADIUS * 0.28);
  const [rightX, rightY] = point(direction - 155, RADIUS * 0.28);
  const arrow = disabled ? theme.palette.action.disabled : theme.palette.primary.main;
  let sector: string | null = null;
  if (heading !== null) {
    const [ax, ay] = point(heading + HALF_VIEW, RADIUS);
    const [bx, by] = point(heading - HALF_VIEW, RADIUS);
    sector = `M ${CENTER} ${CENTER} L ${ax} ${ay} A ${RADIUS} ${RADIUS} 0 0 1 ${bx} ${by} Z`;
  }
  const label = (text: string, degrees: number): ReactElement => {
    const [x, y] = point(degrees, RADIUS + 8);
    return (
      <text x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize={10} fill={theme.palette.text.secondary}>
        {text}
      </text>
    );
  };
  return (
    <Box sx={{ width: SIZE, height: SIZE, flex: '0 0 auto' }}>
      <svg
        ref={ref}
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={texts.wind.compass({ direction })}
        aria-valuemin={0}
        aria-valuemax={359}
        aria-valuenow={direction}
        aria-disabled={disabled}
        onPointerDown={(event) => {
          if (disabled) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          pick(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) pick(event);
        }}
        onKeyDown={key}
        style={{ cursor: disabled ? 'default' : 'pointer', outlineOffset: 2, touchAction: 'none' }}
      >
        <circle cx={CENTER} cy={CENTER} r={RADIUS} fill={theme.palette.action.hover} stroke={theme.palette.divider} />
        {sector ? <path d={sector} fill={theme.palette.info.main} fillOpacity={0.25} stroke={theme.palette.info.main} strokeOpacity={0.6} /> : null}
        {label('С', 90)}
        {label('В', 0)}
        {label('Ю', 270)}
        {label('З', 180)}
        <line x1={tailX} y1={tailY} x2={tipX} y2={tipY} stroke={arrow} strokeWidth={3} strokeLinecap="round" />
        <polygon
          points={`${tipX},${tipY} ${tipX + (leftX - CENTER)},${tipY + (leftY - CENTER)} ${tipX + (rightX - CENTER)},${tipY + (rightY - CENTER)}`}
          fill={arrow}
        />
        <circle cx={CENTER} cy={CENTER} r={3} fill={theme.palette.text.primary} />
      </svg>
    </Box>
  );
}
