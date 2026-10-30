import { scenesTexts } from '@shared/texts/scenes';
import { navigationTexts } from '@shared/texts/navigation';
import type { ReactElement } from 'react';
import { Chip, Typography } from '@mui/material';
import type { DashboardView } from '@shared/types';
import { formatClock } from '../../../format';

/** Заголовок панели и объём принятого материала; действия панели задаёт страница. */
export function ScenesSummary({ summary }: { summary: DashboardView['summary'] }): ReactElement {
  return (
    <>
      <Typography variant="h5">{navigationTexts.pages.scenes}</Typography>
      <Chip size="small" color="success" variant="outlined" label={scenesTexts.summary.completed({ count: summary.completed })} />
      {/* Принятые по прежней постановке планы не считаются принятыми: чип виден, только когда такие есть. */}
      {summary.stale ? (
        <Chip size="small" color="info" variant="outlined" label={scenesTexts.summary.stale({ count: summary.stale })} title={scenesTexts.summary.staleHint} />
      ) : null}
      <Chip size="small" color="warning" variant="outlined" label={scenesTexts.summary.progress({ count: summary.progress })} />
      <Chip size="small" variant="outlined" label={scenesTexts.summary.planned({ count: summary.planned })} />
      <Typography variant="caption" color="text.secondary">
        {scenesTexts.summary.acceptedDuration({ completed: formatClock(summary.completedSeconds), duration: formatClock(summary.duration) })}
      </Typography>
    </>
  );
}
