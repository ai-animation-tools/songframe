/** Сетка карточек планов, как на странице «Сцены»: состояние, предпросмотр, этап или ожидающее действие. */
import type { ReactElement } from 'react';
import { Alert, Box, Button, Chip, Paper, Stack, Typography } from '@mui/material';
import FilterAltOffIcon from '@mui/icons-material/FilterAltOff';
import NotificationImportantIcon from '@mui/icons-material/NotificationImportant';
import type { ShotProduction } from '@shared/types';
import { ShotCard } from '../../../components/ShotCard';
import { FILTER_EMPTY_HINTS, FILTER_LABELS, type ProductionFilter } from '../constants';
import { shotPreview } from '../preview';

export function ProductionShotList({
  shots,
  selected,
  onSelect,
  filter = 'all',
  onResetFilter,
  withDetails = false
}: {
  shots: ShotProduction[];
  selected: string | null;
  onSelect(id: string): void;
  filter?: ProductionFilter;
  onResetFilter?(): void;
  /** Рядом открыт выбранный план: при широком окне он занимает правую колонку, а список держит три карточки в ряд. */
  withDetails?: boolean;
}): ReactElement {
  // Пустой фильтр оформлен как пустая очередь: заголовок с числом, пояснение и путь назад к полному списку.
  if (!shots.length)
    return (
      <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }}>
        <Stack spacing={2}>
          <Typography variant="h6">{FILTER_LABELS[filter]} (0)</Typography>
          <Alert severity="info">{FILTER_EMPTY_HINTS[filter]}</Alert>
          {filter !== 'all' && onResetFilter ? (
            <Button size="small" startIcon={<FilterAltOffIcon />} onClick={onResetFilter} sx={{ alignSelf: 'start' }}>
              Показать все планы
            </Button>
          ) : null}
        </Stack>
      </Paper>
    );
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 220px), 1fr))',
        '@container workspace (min-width: 1100px)': withDetails ? { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' } : {},
        gap: 1.5,
        minWidth: 0
      }}
    >
      {shots.map((shot) => {
        const { videoPath, imagePath } = shotPreview(shot);
        return (
          <ShotCard
            key={shot.id}
            shot={shot}
            videoPath={videoPath}
            imagePath={imagePath}
            chips={
              shot.state === 'completed' && !shot.asset?.video ? <Chip size="small" color="warning" label="Видео отсутствует" sx={{ height: 18 }} /> : null
            }
            caption={shot.attention ? `ждёт вас: ${shot.attention}` : undefined}
            captionColor={shot.attention ? 'primary.main' : undefined}
            captionIcon={shot.attention ? <NotificationImportantIcon fontSize="inherit" color="primary" titleAccess="Ждёт вашего действия" /> : null}
            selected={shot.id === selected}
            onSelect={onSelect}
          />
        );
      })}
    </Box>
  );
}
