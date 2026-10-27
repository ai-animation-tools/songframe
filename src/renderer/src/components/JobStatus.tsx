/** Рабочая страница показывает только ход операции; история доступна через постоянное меню. */
import type { ReactElement } from 'react';
import { CircularProgress, Stack, Typography } from '@mui/material';

export function JobStatus({ running = false, label }: { running?: boolean; label?: string }): ReactElement | null {
  if (!running && !label) return null;

  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
      {running && <CircularProgress size={14} />}
      <Typography variant="body2" color="text.secondary">
        {label ?? 'Выполняется'}
      </Typography>
    </Stack>
  );
}
