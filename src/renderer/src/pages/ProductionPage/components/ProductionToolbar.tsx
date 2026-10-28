/** Итоги производства, фильтр планов и ручное обновление. */
import type { ReactElement } from 'react';
import { Box, Button, Chip, MenuItem, TextField, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import QueueIcon from '@mui/icons-material/Queue';
import type { ProductionView } from '@shared/types';
import type { ProductionFilter } from '../constants';
import { FILTER_LABELS } from '../constants';
import { isQueuedPackage } from '../decisions';

export function ProductionToolbar({
  view,
  filter,
  onFilter,
  onSelect,
  onRefresh
}: {
  view: ProductionView;
  filter: ProductionFilter;
  onFilter(value: ProductionFilter): void;
  onSelect(id: string): void;
  onRefresh(): void;
}): ReactElement {
  const counts = {
    planned: view.shots.filter((s) => s.state === 'planned').length,
    progress: view.shots.filter((s) => s.state === 'progress').length,
    completed: view.shots.filter((s) => s.state === 'completed').length
  };
  const waiting = view.shots.filter((s) => s.attention);
  const queued = view.shots.flatMap((shot) => shot.packages.filter(isQueuedPackage));

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
      <Typography variant="h5">Производство</Typography>
      {/* Счётчик появляется после создания планов: пустой проект ещё нечего принимать. */}
      {view.shots.length ? (
        <Chip
          size="small"
          label={`принято ${counts.completed} из ${view.shots.length}`}
          color={counts.completed === view.shots.length ? 'success' : 'default'}
        />
      ) : null}
      {counts.progress ? <Chip size="small" color="warning" label={`в работе ${counts.progress}`} /> : null}
      {waiting.length ? (
        <Chip
          size="small"
          color="primary"
          label={`ждут вас: ${waiting.map((s) => s.id).join(', ')}`}
          title="Планы, у которых пакет ждёт вашего действия; щелчок открывает первый"
          onClick={() => {
            onFilter('attention');
            onSelect(waiting[0].id);
          }}
        />
      ) : null}
      <Box sx={{ flex: 1 }} />
      <Button startIcon={<QueueIcon />} variant={filter === 'queued' ? 'contained' : 'outlined'} onClick={() => onFilter('queued')}>
        Очередь ({queued.length + view.broken.length})
      </Button>
      {/* Подпись остаётся видимой и после выбора конкретного состояния планов. */}
      <TextField select size="small" label="Показать" value={filter} onChange={(e) => onFilter(e.target.value as ProductionFilter)} sx={{ minWidth: 160 }}>
        {(Object.keys(FILTER_LABELS) as ProductionFilter[]).map((value) => (
          <MenuItem key={value} value={value}>
            {FILTER_LABELS[value]}
          </MenuItem>
        ))}
      </TextField>
      <Button size="small" startIcon={<RefreshIcon />} onClick={onRefresh}>
        Обновить
      </Button>
    </Box>
  );
}
