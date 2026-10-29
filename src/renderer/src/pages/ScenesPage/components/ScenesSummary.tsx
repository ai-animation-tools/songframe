import type { ReactElement } from 'react';
import { Chip, Typography } from '@mui/material';
import type { DashboardView } from '@shared/types';
import { formatClock } from '../../../format';

/** Заголовок панели и объём принятого материала; действия панели задаёт страница. */
export function ScenesSummary({ summary }: { summary: DashboardView['summary'] }): ReactElement {
  return (
    <>
      <Typography variant="h5">Сцены</Typography>
      <Chip size="small" color="success" variant="outlined" label={`принято ${summary.completed}`} />
      {/* Принятые по прежней постановке планы не считаются принятыми: чип виден, только когда такие есть. */}
      {summary.stale ? (
        <Chip
          size="small"
          color="info"
          variant="outlined"
          label={`постановка изменена ${summary.stale}`}
          title="Комплект принят по прежней постановке: нужно новое производство"
        />
      ) : null}
      <Chip size="small" color="warning" variant="outlined" label={`в работе ${summary.progress}`} />
      <Chip size="small" variant="outlined" label={`не начато ${summary.planned}`} />
      <Typography variant="caption" color="text.secondary">
        {formatClock(summary.completedSeconds)} из {formatClock(summary.duration)} принято
      </Typography>
    </>
  );
}
