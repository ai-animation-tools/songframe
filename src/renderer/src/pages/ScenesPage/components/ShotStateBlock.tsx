import type { ReactElement } from 'react';
import { Box, Typography } from '@mui/material';
import type { DashboardShot } from '@shared/types';

/** Показывает вычисленное состояние и проверки непрерывности для одного края сцены. */
export function ShotStateBlock({ title, data }: { title: string; data: DashboardShot['before'] }): ReactElement {
  if (!data) return <Typography variant="body2">{title}: не вычислено.</Typography>;
  const known = data.lines.filter((line) => !line.startsWith('Состояние не задано'));
  return (
    <Box sx={{ p: 1, bgcolor: 'action.hover', borderRadius: 1 }}>
      <Typography variant="caption" fontWeight={600} display="block" gutterBottom>
        {title}
      </Typography>
      {known.length ? (
        known.map((line) => {
          const colon = line.indexOf(': ');
          return (
            <Typography key={line} variant="body2">
              <b>{colon > 0 ? line.slice(0, colon) : line}</b>
              {colon > 0 ? `: ${line.slice(colon + 2)}` : ''}
            </Typography>
          );
        })
      ) : (
        <Typography variant="body2" color="text.secondary">
          состояние не задано
        </Typography>
      )}
      {data.checklist.length ? (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
          Проверить по кадру: {data.checklist.join('; ')}
        </Typography>
      ) : null}
    </Box>
  );
}
