/**
 * Шкала плана под превью — единственный выбор кадра на странице «Эффекты»: строки песни в окне
 * плана, отметки моментов эффектов (начало нарастания, затухание и т. п.) и текущий кадр превью.
 * Щелчок и протяжка в любом месте шкалы, в том числе по строке песни, ставят кадр под указателем:
 * момент подбирается по словам песни и картинке, а не счётом секунд. С клавиатуры шкала — ползунок:
 * стрелки на кадр, Shift или Page Up/Down на десять кадров, Home/End к краям.
 */
import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react';
import { Box, Tooltip, Typography } from '@mui/material';
import type { EffectLine } from '@shared/effects';
import { effectsTexts as texts } from '@shared/texts/effects';

/** Секунды с двумя знаками и запятой. */
export function formatSeconds(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2).replace('.', ',');
}

export interface PlanMark {
  name: string;
  title: string;
  seconds: number;
}

/** Крупный шаг клавиатуры, кадры. */
const BIG_STEP = 10;

export function PlanTimeline({
  frames,
  fps,
  frame,
  lines,
  lyricProblem,
  marks,
  onFrame
}: {
  /** Число кадров плана; ось — от первого до последнего кадра. */
  frames: number;
  fps: number;
  /** Кадр превью. */
  frame: number;
  lines: EffectLine[];
  lyricProblem: string | null;
  marks: PlanMark[];
  onFrame(frame: number): void;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const last = Math.max(0, frames - 1);
  const duration = last / fps;
  const percent = (seconds: number): number => (duration > 0 ? Math.min(100, Math.max(0, (seconds / duration) * 100)) : 0);
  const clamp = (value: number): number => Math.min(last, Math.max(0, Math.round(value)));
  /** Кадр под указателем: доля ширины шкалы, округлённая до кадра. */
  const seek = (event: PointerEvent<HTMLElement>): void => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || !box.width) return;
    onFrame(clamp(((event.clientX - box.left) / box.width) * last));
  };
  const down = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    // Захват держит протяжку за краем шкалы; без активного указателя (события из тестов) браузер
    // его отвергает, и протяжка идёт, пока указатель над шкалой.
    try {
      ref.current?.setPointerCapture(event.pointerId);
    } catch {
      // протяжка продолжается без захвата
    }
    setDragging(true);
    seek(event);
  };
  const key = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? BIG_STEP : 1;
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowUp'
        ? frame + step
        : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
          ? frame - step
          : event.key === 'PageUp'
            ? frame + BIG_STEP
            : event.key === 'PageDown'
              ? frame - BIG_STEP
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? last
                  : null;
    if (next === null) return;
    event.preventDefault();
    onFrame(clamp(next));
  };
  const current = frame / fps;
  const position = texts.time.position({ frame, last, seconds: formatSeconds(current) });
  return (
    <Box>
      <Box
        ref={ref}
        role="slider"
        tabIndex={0}
        aria-label={texts.time.scale}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={frame}
        aria-valuetext={position}
        data-testid="plan-timeline"
        onPointerDown={down}
        onPointerMove={(event) => dragging && seek(event)}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onLostPointerCapture={() => setDragging(false)}
        onKeyDown={key}
        sx={{
          position: 'relative',
          height: 40,
          borderRadius: 1,
          bgcolor: 'action.hover',
          cursor: 'pointer',
          overflow: 'hidden',
          touchAction: 'none',
          userSelect: 'none',
          '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 }
        }}
      >
        {lines.map((line, index) => (
          <Box
            key={index}
            title={texts.time.line({ text: line.text, start: formatSeconds(Math.max(0, line.start)) })}
            data-line={index}
            sx={{
              position: 'absolute',
              top: 14,
              bottom: 2,
              left: `${percent(line.start)}%`,
              width: `${Math.max(1, percent(line.end) - percent(line.start))}%`,
              px: 0.5,
              borderRadius: 0.5,
              bgcolor: 'primary.main',
              color: 'primary.contrastText',
              display: 'flex',
              alignItems: 'center',
              overflow: 'hidden'
            }}
          >
            <Typography variant="caption" noWrap>
              {line.text}
            </Typography>
          </Box>
        ))}
        {marks.map((mark) => (
          <Tooltip key={mark.name} title={texts.time.mark({ title: mark.title, seconds: formatSeconds(mark.seconds) })}>
            <Box
              data-mark={mark.name}
              aria-label={texts.time.mark({ title: mark.title, seconds: formatSeconds(mark.seconds) })}
              role="img"
              sx={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: `calc(${percent(mark.seconds)}% - 5px)`,
                width: 10,
                display: 'flex',
                justifyContent: 'center',
                '&::before': { content: '""', width: 2, bgcolor: 'warning.main' },
                '&::after': {
                  content: '""',
                  position: 'absolute',
                  top: 0,
                  borderLeft: '5px solid transparent',
                  borderRight: '5px solid transparent',
                  borderTop: '8px solid',
                  borderTopColor: 'warning.main'
                }
              }}
            />
          </Tooltip>
        ))}
        <Box
          aria-hidden
          sx={{ position: 'absolute', top: 0, bottom: 0, left: `calc(${percent(current)}% - 1px)`, width: 3, bgcolor: 'error.main', pointerEvents: 'none' }}
        />
      </Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, mt: 0.25 }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
          {position}
        </Typography>
        {!lines.length ? (
          <Typography variant="caption" color="text.secondary">
            {lyricProblem ?? texts.time.noLines}
          </Typography>
        ) : null}
        <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
          {formatSeconds(duration)} с
        </Typography>
      </Box>
    </Box>
  );
}
