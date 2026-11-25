/**
 * Шкала плана для моментов эффекта: строки песни в окне плана, отметки моментов (начало
 * нарастания, затухание и т. п.) и кадр превью. Щелчок по шкале или по строке показывает кадр
 * этого момента — так момент подбирается по словам песни и картинке, а не счётом секунд.
 */
import { useRef, type MouseEvent, type ReactElement } from 'react';
import { Box, ButtonBase, Tooltip, Typography } from '@mui/material';
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

export function PlanTimeline({
  duration,
  lines,
  lyricProblem,
  marks,
  current,
  onSeek
}: {
  /** Длина оси, секунды: время последнего кадра плана. */
  duration: number;
  lines: EffectLine[];
  lyricProblem: string | null;
  marks: PlanMark[];
  /** Время кадра превью. */
  current: number;
  onSeek(seconds: number): void;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const percent = (seconds: number): number => (duration > 0 ? Math.min(100, Math.max(0, (seconds / duration) * 100)) : 0);
  const seek = (event: MouseEvent<HTMLElement>): void => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || !box.width) return;
    onSeek(Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * duration);
  };
  return (
    <Box>
      <Box
        ref={ref}
        role="group"
        aria-label={texts.time.scale}
        data-testid="plan-timeline"
        onClick={seek}
        sx={{ position: 'relative', height: 44, borderRadius: 1, bgcolor: 'action.hover', cursor: 'pointer', overflow: 'hidden' }}
      >
        {lines.map((line, index) => (
          <ButtonBase
            key={index}
            title={texts.time.line({ text: line.text, start: formatSeconds(Math.max(0, line.start)) })}
            onClick={(event) => {
              event.stopPropagation();
              onSeek(Math.min(duration, Math.max(0, line.start)));
            }}
            sx={{
              position: 'absolute',
              top: 18,
              bottom: 2,
              left: `${percent(line.start)}%`,
              width: `${Math.max(1, percent(line.end) - percent(line.start))}%`,
              px: 0.5,
              borderRadius: 0.5,
              bgcolor: 'primary.main',
              color: 'primary.contrastText',
              justifyContent: 'flex-start',
              overflow: 'hidden'
            }}
          >
            <Typography variant="caption" noWrap>
              {line.text}
            </Typography>
          </ButtonBase>
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
          title={texts.time.frame({ seconds: formatSeconds(current) })}
          sx={{ position: 'absolute', top: 0, bottom: 0, left: `${percent(current)}%`, width: 2, bgcolor: 'error.main', pointerEvents: 'none' }}
        />
      </Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.25 }}>
        <Typography variant="caption" color="text.secondary">
          0
        </Typography>
        {!lines.length ? (
          <Typography variant="caption" color="text.secondary">
            {lyricProblem ?? texts.time.noLines}
          </Typography>
        ) : null}
        <Typography variant="caption" color="text.secondary">
          {formatSeconds(duration)}
        </Typography>
      </Box>
    </Box>
  );
}
