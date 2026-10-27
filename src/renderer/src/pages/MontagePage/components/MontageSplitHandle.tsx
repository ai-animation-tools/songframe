import { useRef, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react';
import { Box } from '@mui/material';
import DragHandleIcon from '@mui/icons-material/DragHandle';

interface Props {
  value: number;
  min: number;
  max: number;
  controls: string;
  onChange: (height: number) => void;
}

/** Разделитель управляет одной высотой: перетаскивание и клавиатура дают одинаковый результат. */
export function MontageSplitHandle({ value, min, max, controls, onChange }: Props): ReactElement {
  const drag = useRef<{ y: number; height: number } | null>(null);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 40 : 10;
    const next =
      event.key === 'ArrowUp' ? value - step : event.key === 'ArrowDown' ? value + step : event.key === 'Home' ? min : event.key === 'End' ? max : null;
    if (next === null) return;
    event.preventDefault();
    onChange(Math.max(min, Math.min(max, next)));
  };
  const start = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { y: event.clientY, height: value };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  return (
    <Box
      role="separator"
      tabIndex={0}
      aria-label="Высота плеера и шкалы"
      aria-orientation="horizontal"
      aria-controls={controls}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`Высота верхней панели ${Math.round(value)} пикселей`}
      title="Перетащите разделитель или используйте стрелки вверх и вниз"
      onKeyDown={keyDown}
      onPointerDown={start}
      onPointerMove={(event) => {
        if (drag.current) onChange(Math.max(min, Math.min(max, drag.current.height + event.clientY - drag.current.y)));
      }}
      onPointerUp={(event) => {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      sx={{
        height: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'row-resize',
        touchAction: 'none',
        color: 'text.secondary',
        borderRadius: 1,
        '&:hover': { bgcolor: 'action.hover' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
      }}
    >
      <DragHandleIcon fontSize="small" />
    </Box>
  );
}
