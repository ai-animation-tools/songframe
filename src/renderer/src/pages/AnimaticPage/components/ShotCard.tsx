/** Карточка текущего плана с опорами, камерой и действием. */

import type { ReactElement } from 'react';
import { Box, Chip, Stack, Typography } from '@mui/material';
import type { AnimaticShot } from '@shared/types';
import { formatClock } from '../../../format';
import { MEDIA_COLORS, MEDIA_LABELS } from '../media';

export function ShotCard({ shot }: { shot: AnimaticShot }): ReactElement {
  return (
    <Stack spacing={1}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="h6" sx={{ fontFamily: 'monospace' }}>
          {shot.id}
        </Typography>
        <Chip size="small" label={MEDIA_LABELS[shot.media]} sx={{ bgcolor: MEDIA_COLORS[shot.media], color: 'common.white' }} />
        {shot.lipsync ? <Chip size="small" variant="outlined" label="речь" /> : null}
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.secondary">
          {formatClock(shot.start)}–{formatClock(shot.end)} · {shot.frames} кадров
        </Typography>
      </Box>
      <Typography variant="subtitle1" fontWeight={600}>
        {shot.title}
      </Typography>
      {shot.sequenceTitle ? (
        <Typography variant="caption" color="text.secondary">
          Часть: {shot.sequenceTitle}
        </Typography>
      ) : null}
      {shot.cardPath ? <img src={window.api.shell.fileUrl(shot.cardPath)} alt={shot.id} style={{ width: '100%', borderRadius: 4 }} /> : null}
      {shot.lastCardPath ? (
        <img src={window.api.shell.fileUrl(shot.lastCardPath)} alt={`${shot.id} последняя опора`} style={{ width: '100%', borderRadius: 4 }} />
      ) : null}
      {shot.original ? (
        <Typography variant="body2" sx={{ fontStyle: 'italic' }}>
          {shot.original}
        </Typography>
      ) : null}
      <Typography variant="body2">
        <b>Камера.</b> {shot.camera || 'не задана'}
      </Typography>
      <Typography variant="body2">
        <b>Действие.</b> {shot.action || 'не задано'}
      </Typography>
    </Stack>
  );
}
