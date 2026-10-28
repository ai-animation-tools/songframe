/** Карточка плана в сетке: одинаковая на страницах «Сцены» и «Производство», предпросмотр запускается при наведении. */
import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { alpha } from '@mui/material/styles';
import { Box, Chip, Paper, Typography } from '@mui/material';
import type { ShotProductionState } from '@shared/types';
import { formatClock } from '../format';
import { useShotPreview } from '../hooks/useShotPreview';
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

/** Видео заменяет статичную миниатюру; без видео остаётся изображение или заглушка той же формы. */
function ShotPreview({
  id,
  videoPath,
  imagePath,
  videoRef
}: {
  id: string;
  videoPath: string | null;
  imagePath: string | null;
  videoRef: ReturnType<typeof useShotPreview>['videoRef'];
}): ReactElement {
  const style = { width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 4, display: 'block' } as const;
  if (videoPath) {
    return (
      <video
        key={videoPath}
        ref={videoRef}
        src={window.api.shell.fileUrl(videoPath)}
        poster={imagePath ? window.api.shell.fileUrl(imagePath) : undefined}
        muted
        playsInline
        preload="metadata"
        style={style}
      />
    );
  }
  if (imagePath) return <img src={window.api.shell.fileUrl(imagePath)} alt={id} style={style} />;
  return <Box sx={{ aspectRatio: '16 / 9', bgcolor: 'action.hover', borderRadius: 1 }} />;
}

export function ShotCard({
  shot,
  videoPath,
  imagePath,
  chips,
  caption,
  captionColor = 'text.secondary',
  captionIcon,
  selected,
  onSelect
}: {
  shot: ShotCardShot;
  /** Принятое или полученное видео; при наведении воспроизводится без звука. */
  videoPath: string | null;
  /** Постер видео или миниатюра без него. */
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
  const { videoRef, play, pause } = useShotPreview(videoPath);
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
      onClick={() => onSelect(shot.id)}
      onMouseEnter={play}
      onMouseLeave={pause}
      sx={{
        p: 1,
        minWidth: 0,
        cursor: 'pointer',
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
        {shot.lipsync ? <Chip size="small" variant="outlined" label="речь" sx={{ height: 18 }} /> : null}
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.secondary" sx={{ width: '100%' }}>
          {formatClock(shot.start)}–{formatClock(shot.end)}
        </Typography>
      </Box>
      <ShotPreview id={shot.id} videoPath={videoPath} imagePath={imagePath} videoRef={videoRef} />
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
