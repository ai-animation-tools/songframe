import { animaticTexts } from '@shared/texts/animatic';
/** Список глав с переходом плеера на выбранный план. */

import type { ReactElement } from 'react';
import { Box, Paper, Typography } from '@mui/material';
import type { AnimaticShot } from '@shared/types';
import { formatClock } from '../../../format';
import { MEDIA_COLORS } from '../media';

export function AnimaticChapters({
  shots,
  current,
  seek
}: {
  shots: AnimaticShot[];
  current: AnimaticShot | null;
  seek: (shot: AnimaticShot) => void;
}): ReactElement {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>
        {animaticTexts.chapters}
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr', xl: '1fr 1fr 1fr' }, gap: 1 }}>
        {shots.map((shot) => (
          <Box
            key={shot.id}
            onClick={() => seek(shot)}
            sx={{
              display: 'flex',
              gap: 1,
              alignItems: 'center',
              p: 0.75,
              borderRadius: 1,
              cursor: 'pointer',
              bgcolor: current?.id === shot.id ? 'action.selected' : undefined,
              '&:hover': { bgcolor: 'action.hover' }
            }}
          >
            <Box sx={{ width: 6, alignSelf: 'stretch', borderRadius: 1, bgcolor: MEDIA_COLORS[shot.media] }} />
            <Typography variant="body2" sx={{ fontFamily: 'monospace', minWidth: 44 }}>
              {shot.id}
            </Typography>
            <Typography variant="body2" noWrap sx={{ flex: 1 }} title={shot.title}>
              {shot.title}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
              {formatClock(shot.start)}–{formatClock(shot.end)}
            </Typography>
          </Box>
        ))}
      </Box>
    </Paper>
  );
}
