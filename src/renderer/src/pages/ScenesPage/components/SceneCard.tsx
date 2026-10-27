import type { ReactElement } from 'react';
import { Box, Chip, Paper, Typography } from '@mui/material';
import type { DashboardShot } from '@shared/types';
import { formatClock } from '../../../format';
import { getSceneVideoPath } from '../helpers';
import { STATE_LABELS } from '../types';
import { useScenePreview } from '../useScenePreview';
import { SceneCardPreview } from './SceneCardPreview';

/** Карточка сцены запускает беззвучный предпросмотр при наведении на всю карточку. */
export function SceneCard({ shot, selected, onSelect }: { shot: DashboardShot; selected: boolean; onSelect(id: string): void }): ReactElement {
  const videoPath = getSceneVideoPath(shot);
  const { videoRef, play, pause } = useScenePreview(videoPath);
  return (
    <Paper
      variant={selected ? 'elevation' : 'outlined'}
      elevation={selected ? 4 : 0}
      onClick={() => onSelect(shot.id)}
      onMouseEnter={play}
      onMouseLeave={pause}
      sx={{ p: 1, minWidth: 0, cursor: 'pointer', borderLeft: 4, borderLeftColor: STATE_LABELS[shot.state].bar }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.5, flexWrap: 'wrap' }}>
        <Typography variant="body2" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
          {shot.id}
        </Typography>
        <Chip size="small" color={STATE_LABELS[shot.state].color} label={STATE_LABELS[shot.state].label} sx={{ height: 18 }} />
        {shot.state === 'completed' && !shot.asset?.video ? <Chip size="small" color="warning" label="Видео отсутствует" sx={{ height: 18 }} /> : null}
        {shot.lipsync ? <Chip size="small" variant="outlined" label="речь" sx={{ height: 18 }} /> : null}
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.secondary" sx={{ width: '100%' }}>
          {formatClock(shot.start)}–{formatClock(shot.end)}
        </Typography>
      </Box>
      <SceneCardPreview shot={shot} videoPath={videoPath} videoRef={videoRef} />
      <Typography variant="body2" noWrap title={shot.title} sx={{ mt: 0.5 }}>
        {shot.title}
      </Typography>
      <Typography variant="caption" color="text.secondary" noWrap display="block" title={shot.stageLabel}>
        {shot.stageLabel}
      </Typography>
    </Paper>
  );
}
