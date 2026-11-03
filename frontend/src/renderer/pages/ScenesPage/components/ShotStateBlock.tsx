import { scenesTexts } from '@shared/texts/scenes';
import type { ReactElement } from 'react';
import { Box, Typography } from '@mui/material';
import { BRIEF_STATE_UNSET_PREFIX, type DashboardShot } from '@shared/types';

/** Показывает вычисленное состояние и проверки непрерывности для одного края сцены. */
export function ShotStateBlock({ title, data }: { title: string; data: DashboardShot['before'] }): ReactElement {
  if (!data) return <Typography variant="body2">{scenesTexts.state.notComputed({ title })}</Typography>;
  const known = data.lines.filter((line) => !line.startsWith(BRIEF_STATE_UNSET_PREFIX));
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
          {scenesTexts.state.missing}
        </Typography>
      )}
      {data.checklist.length ? (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
          {scenesTexts.state.checklist({ checklist: data.checklist.join('; ') })}
        </Typography>
      ) : null}
    </Box>
  );
}
