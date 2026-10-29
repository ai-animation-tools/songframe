import type { ReactElement } from 'react';
import { Box, Typography } from '@mui/material';
import { mergeChecklist } from '../briefComparison';

/** Пункты, по которым сверяют опоры и результат генерации; общие для обеих границ плана показаны один раз. */
export function BriefChecklist({ before, after }: { before: string[]; after: string[] }): ReactElement | null {
  const items = mergeChecklist(before, after);
  if (!items.length) return null;
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="subtitle2">Что сверить в опорах и результате</Typography>
      <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
        {items.map((item) => (
          <Typography key={`${item.phase ?? 'both'}:${item.text}`} component="li" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            {item.text}
            {item.phase ? (
              <Typography component="span" variant="caption" color="text.secondary">
                {' '}
                · {item.phase === 'before' ? 'первый кадр' : 'последний кадр'}
              </Typography>
            ) : null}
          </Typography>
        ))}
      </Box>
    </Box>
  );
}
