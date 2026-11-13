/**
 * Разделитель двух панелей: управляет одним размером в пикселях — высотой верхней панели
 * (orientation="horizontal", граница плеера и шкалы монтажа) или шириной левой колонки
 * (orientation="vertical", граница списка и карточки). Перетаскивание и стрелки клавиатуры дают
 * одинаковый результат; Shift — крупный шаг, Home/End — пределы. Хранение размера — у владельца.
 */
import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react';
import { Box, type SxProps, type Theme } from '@mui/material';
import DragHandleIcon from '@mui/icons-material/DragHandle';

interface Props {
  value: number;
  min: number;
  max: number;
  /** Граница между панелями сверху и снизу (horizontal) или слева и справа (vertical), как aria-orientation. */
  orientation?: 'horizontal' | 'vertical';
  /** id панели, размер которой меняется. */
  controls?: string;
  label: string;
  hint: string;
  valueText: (value: number) => string;
  onChange: (value: number) => void;
  sx?: SxProps<Theme>;
  style?: CSSProperties;
}

export function SplitHandle({ value, min, max, orientation = 'horizontal', controls, label, hint, valueText, onChange, sx, style }: Props): ReactElement {
  const drag = useRef<{ start: number; value: number } | null>(null);
  const vertical = orientation === 'vertical';
  const clamp = (next: number): number => Math.max(min, Math.min(max, next));
  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 40 : 10;
    const [less, more] = vertical ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    const next = event.key === less ? value - step : event.key === more ? value + step : event.key === 'Home' ? min : event.key === 'End' ? max : null;
    if (next === null) return;
    event.preventDefault();
    onChange(clamp(next));
  };
  const position = (event: PointerEvent<HTMLDivElement>): number => (vertical ? event.clientX : event.clientY);
  const start = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    // preventDefault убирает выделение текста при перетаскивании, но и фокус: возвращаем его, чтобы после
    // щелчка разделитель двигался стрелками клавиатуры.
    event.preventDefault();
    event.currentTarget.focus();
    drag.current = { start: position(event), value };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  return (
    <Box
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-controls={controls}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      aria-valuetext={valueText(Math.round(value))}
      title={hint}
      onKeyDown={keyDown}
      onPointerDown={start}
      onPointerMove={(event) => {
        if (drag.current) onChange(clamp(drag.current.value + position(event) - drag.current.start));
      }}
      onPointerUp={(event) => {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      style={style}
      sx={[
        {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: vertical ? 'col-resize' : 'row-resize',
          touchAction: 'none',
          userSelect: 'none',
          color: 'text.secondary',
          borderRadius: 1,
          '&:hover': { bgcolor: 'action.hover' },
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
        },
        vertical ? { width: 12 } : { height: 20 },
        ...(Array.isArray(sx) ? sx : [sx])
      ]}
    >
      <DragHandleIcon fontSize="small" sx={vertical ? { transform: 'rotate(90deg)' } : undefined} />
    </Box>
  );
}
