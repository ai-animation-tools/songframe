/** Итоги производства, фильтр планов и ручное обновление. */
import type { ReactElement } from 'react';
import { Box, Button, Chip, MenuItem, TextField, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { ProductionView } from '@shared/types';
import type { ProductionFilter } from '../constants';

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
  const waiting = view.shots.filter((s) => s.packages.some((p) => p.pendingDecision));

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
        <Chip size="small" color="primary" label={`ждут решения: ${waiting.map((s) => s.id).join(', ')}`} onClick={() => onSelect(waiting[0].id)} />
      ) : null}
      <Box sx={{ flex: 1 }} />
      {/* Подпись остаётся видимой и после выбора конкретного состояния планов. */}
      <TextField
        select
        size="small"
        label="Состояние планов"
        value={filter}
        onChange={(e) => onFilter(e.target.value as ProductionFilter)}
        sx={{ minWidth: 160 }}
      >
        <MenuItem value="all">Все планы</MenuItem>
        <MenuItem value="progress">В работе</MenuItem>
        <MenuItem value="planned">Не начатые</MenuItem>
        <MenuItem value="completed">Принятые</MenuItem>
      </TextField>
      <Button size="small" startIcon={<RefreshIcon />} onClick={onRefresh}>
        Обновить
      </Button>
    </Box>
  );
}
