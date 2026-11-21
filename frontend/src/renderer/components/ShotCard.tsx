/**
 * Карточка плана в сетке: одинаковая на страницах «Сцены» и «Производство». Показывает изображение (обычно первую опору
 * плана), а не видео: на странице десятки карточек, и видео в каждой держало бы декодер WebKit, от чего страница
 * зависала. Видео смотрят в плеере выбранного плана.
 */
import { componentsTexts } from '@shared/texts/components';
import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { alpha } from '@mui/material/styles';
import { Box, Chip, Paper, Typography } from '@mui/material';
import type { ShotProductionState } from '@shared/types';
import { formatClock } from '../format';
import { SHOT_STATE_LABELS } from './shotState';

export interface ShotCardShot {
  id: string;
  title: string;
  start: number;
  end: number;
  lipsync: boolean;
  state: ShotProductionState;
  stageLabel: string;
}

/** Изображение плана; без него — заглушка той же формы. */
function ShotPreview({ id, imagePath }: { id: string; imagePath: string | null }): ReactElement {
  const style = { width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 4, display: 'block' } as const;
  if (imagePath) return <img src={window.api.shell.fileUrl(imagePath)} alt={id} style={style} />;
  return <Box sx={{ aspectRatio: '16 / 9', bgcolor: 'action.hover', borderRadius: 1 }} />;
}

export function ShotCard({
  shot,
  imagePath,
  chips,
  caption,
  captionColor = 'text.secondary',
  captionIcon,
  selected,
  onSelect
}: {
  shot: ShotCardShot;
  /** Изображение плана: первая опора принятого комплекта или попытки; null — заглушка. */
  imagePath: string | null;
  /** Дополнительные чипы после состояния, например «Видео отсутствует». */
  chips?: ReactNode;
  /** Нижняя строка; по умолчанию текущий этап плана. */
  caption?: string;
  captionColor?: string;
  captionIcon?: ReactNode;
  selected: boolean;
  onSelect(id: string): void;
}): ReactElement {
  const cardRef = useRef<HTMLDivElement>(null);
  const state = SHOT_STATE_LABELS[shot.state];
  const text = caption ?? shot.stageLabel;
  // Выбранный план (из адреса или после перехода с другой страницы) показывается без ручного поиска по сетке.
  useEffect(() => {
    if (selected) cardRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  return (
    <Paper
      ref={cardRef}
      variant="outlined"
      aria-current={selected ? 'true' : undefined}
      // Карточка — кнопка выбора плана: доступна с клавиатуры (Tab, Enter или пробел).
      role="button"
      tabIndex={0}
      onClick={() => onSelect(shot.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onSelect(shot.id);
      }}
      sx={{
        p: 1,
        minWidth: 0,
        cursor: 'pointer',
        // Кольцо фокуса снаружи карточки отличимо от внутренней рамки выбранного плана.
        '&:focus-visible': {
          outline: selected ? undefined : 'none',
          boxShadow: (theme) => `0 0 0 2px ${theme.palette.background.paper}, 0 0 0 4px ${theme.palette.primary.main}`
        },
        borderLeft: 4,
        borderLeftColor: state.bar,
        // Выбранный план выделен цветом темы: рамка поверх карточки (без сдвига сетки) и фон выбранного элемента.
        ...(selected
          ? {
              outline: 2,
              outlineColor: 'primary.main',
              outlineOffset: -1,
              bgcolor: (theme) => alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.18 : 0.08)
            }
          : {}),
        // Прокрутка к карточке учитывает шапку и закреплённую панель действий страницы; страница может уточнить отступ переменной.
        scrollMarginTop: 'var(--shot-card-scroll-margin, 130px)'
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.5, flexWrap: 'wrap' }}>
        <Typography variant="body2" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
          {shot.id}
        </Typography>
        <Chip size="small" color={state.color} label={state.label} sx={{ height: 18 }} />
        {chips}
        {shot.lipsync ? <Chip size="small" variant="outlined" label={componentsTexts.shot.speech} sx={{ height: 18 }} /> : null}
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.secondary" sx={{ width: '100%' }}>
          {formatClock(shot.start)}–{formatClock(shot.end)}
        </Typography>
      </Box>
      <ShotPreview id={shot.id} imagePath={imagePath} />
      <Typography variant="body2" noWrap title={shot.title} sx={{ mt: 0.5 }}>
        {shot.title}
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
        {captionIcon}
        <Typography variant="caption" color={captionColor} noWrap sx={{ minWidth: 0 }} title={text}>
          {text}
        </Typography>
      </Box>
    </Paper>
  );
}
