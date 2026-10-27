import type { ReactElement } from 'react';
import { Box, Button, Chip, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { DashboardView } from '@shared/types';
import { formatClock } from '../../../format';

/** Показывает объём принятого материала и позволяет обновить сводку. */
export function ScenesSummary({ summary, onRefresh }: { summary: DashboardView['summary']; onRefresh(): void }): ReactElement {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
      <Typography variant="h5">Сцены</Typography>
      <Chip size="small" color="success" variant="outlined" label={`принято ${summary.completed}`} />
      <Chip size="small" color="warning" variant="outlined" label={`в работе ${summary.progress}`} />
      <Chip size="small" variant="outlined" label={`не начато ${summary.planned}`} />
      <Typography variant="caption" color="text.secondary">
        {formatClock(summary.completedSeconds)} из {formatClock(summary.duration)} принято
      </Typography>
      <Box sx={{ flex: 1 }} />
      <Button size="small" startIcon={<RefreshIcon />} onClick={onRefresh}>
        Обновить
      </Button>
    </Box>
  );
}
