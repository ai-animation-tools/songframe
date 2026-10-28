/** Плеер собранного видео, полоса глав и сведения о сборке. */

import type { ReactElement, RefObject } from 'react';
import { Box, Button, Paper, Stack, Tooltip, Typography } from '@mui/material';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import type { AnimaticShot, AnimaticView } from '@shared/types';
import { formatClock } from '../../../format';
import { DateTime } from '../../../components/DateTime';
import { MEDIA_COLORS, MEDIA_LABELS } from '../media';

export function AnimaticPlayer({
  built,
  videoRef,
  videoUrl,
  seekRequested,
  setTime,
  shots,
  current,
  seek,
  duration,
  time,
  onOpenFolder
}: {
  built: NonNullable<AnimaticView['built']>;
  videoRef: RefObject<HTMLVideoElement | null>;
  videoUrl: string | undefined;
  seekRequested: () => void;
  setTime: (time: number) => void;
  shots: AnimaticShot[];
  current: AnimaticShot | null;
  seek: (shot: AnimaticShot) => void;
  duration: number;
  time: number;
  onOpenFolder: () => void;
}): ReactElement {
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <video
        ref={videoRef}
        controls
        key={videoUrl}
        src={videoUrl}
        onLoadedMetadata={seekRequested}
        style={{ width: '100%', borderRadius: 4, background: '#000' }}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
      />
      <Box sx={{ display: 'flex', height: 22, mt: 1, borderRadius: 1, overflow: 'hidden', border: 1, borderColor: 'divider', position: 'relative' }}>
        {shots.map((shot) => (
          <Tooltip key={shot.id} title={`${shot.id} · ${shot.title} · ${MEDIA_LABELS[shot.media]}`} placement="top">
            <Box
              onClick={() => seek(shot)}
              sx={{
                flex: Math.max(shot.end - shot.start, 0.01),
                bgcolor: MEDIA_COLORS[shot.media],
                opacity: current?.id === shot.id ? 1 : 0.55,
                borderRight: 1,
                borderColor: 'background.paper',
                cursor: 'pointer',
                '&:hover': { opacity: 1 }
              }}
            />
          </Tooltip>
        ))}
        {duration ? (
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${(time / duration) * 100}%`,
              width: 2,
              bgcolor: 'text.primary',
              pointerEvents: 'none'
            }}
          />
        ) : null}
      </Box>
      <Stack spacing={1} sx={{ mt: 1, alignItems: 'flex-start' }}>
        <Typography variant="caption" color="text.secondary">
          {formatClock(time)} / {formatClock(duration)} · {shots.length} планов: {built.counts.video} анимация, {built.counts.keyframes} опоры,{' '}
          {built.counts.cards} карточки · собрано <DateTime value={built.builtAt} />
        </Typography>
        <Button size="small" startIcon={<FolderOpenIcon />} onClick={onOpenFolder}>
          Открыть папку
        </Button>
      </Stack>
    </Paper>
  );
}
