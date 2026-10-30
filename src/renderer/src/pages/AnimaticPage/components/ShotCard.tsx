import { commonTexts } from '@shared/texts/common';
import { SlottedText } from '../../../components/SlottedText';
import { animaticTexts } from '@shared/texts/animatic';
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
        {shot.lipsync ? <Chip size="small" variant="outlined" label={animaticTexts.shot.speech} /> : null}
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.secondary">
          {animaticTexts.shot.timing({ start: formatClock(shot.start), end: formatClock(shot.end), frames: shot.frames })}
        </Typography>
      </Box>
      <Typography variant="subtitle1" fontWeight={600}>
        {shot.title}
      </Typography>
      {shot.sequenceTitle ? (
        <Typography variant="caption" color="text.secondary">
          {animaticTexts.shot.sequence({ title: shot.sequenceTitle })}
        </Typography>
      ) : null}
      {shot.cardPath ? <img src={window.api.shell.fileUrl(shot.cardPath)} alt={shot.id} style={{ width: '100%', borderRadius: 4 }} /> : null}
      {shot.lastCardPath ? (
        <img
          src={window.api.shell.fileUrl(shot.lastCardPath)}
          alt={animaticTexts.shot.lastCard({ shot: shot.id })}
          style={{ width: '100%', borderRadius: 4 }}
        />
      ) : null}
      {shot.original ? (
        <Typography variant="body2" sx={{ fontStyle: 'italic' }}>
          {shot.original}
        </Typography>
      ) : null}
      <Typography variant="body2">
        <SlottedText
          text={commonTexts.staging.camera}
          slots={{ label: <b>{commonTexts.staging.cameraLabel}</b>, camera: shot.camera || commonTexts.staging.cameraMissing }}
        />
      </Typography>
      <Typography variant="body2">
        <SlottedText
          text={commonTexts.staging.action}
          slots={{ label: <b>{commonTexts.staging.actionLabel}</b>, action: shot.action || commonTexts.staging.actionMissing }}
        />
      </Typography>
    </Stack>
  );
}
