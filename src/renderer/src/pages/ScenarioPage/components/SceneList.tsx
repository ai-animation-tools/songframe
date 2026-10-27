import type { ReactElement } from 'react';
import { Box, Chip, Paper, Typography } from '@mui/material';
import type { ScenesFile } from '@shared/types';
import { formatClock } from '../../../format';
import { FPS } from '@shared/video';

/** Показывает список планов с таймингом и признаками заполнения. */
export function SceneList({ scenes, selected, onSelect }: { scenes: ScenesFile; selected: string | null; onSelect(id: string): void }): ReactElement {
  return (
    <Paper variant="outlined" sx={{ maxHeight: 'calc(100vh - 330px)', overflowY: 'auto' }}>
      {scenes.scenes.map((s) => {
        const filled = !s.action.startsWith('ЗАПОЛНИТЬ') && !s.camera.startsWith('ЗАПОЛНИТЬ');
        return (
          <Box
            key={s.id}
            onClick={() => onSelect(s.id)}
            sx={{
              px: 1.5,
              py: 0.75,
              cursor: 'pointer',
              borderLeft: 3,
              borderColor: s.id === selected ? 'primary.main' : 'transparent',
              bgcolor: s.id === selected ? 'action.selected' : undefined,
              '&:hover': { bgcolor: 'action.hover' }
            }}
          >
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <Typography fontWeight={600} sx={{ fontFamily: 'monospace' }}>
                {s.id}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {formatClock(s.start_frame / FPS)}–{formatClock(s.end_frame_exclusive / FPS)}
              </Typography>
              {!filled ? <Chip size="small" label="пусто" color="warning" variant="outlined" sx={{ height: 18 }} /> : null}
              {s.lipsync ? <Chip size="small" label="речь" sx={{ height: 18 }} /> : null}
            </Box>
            <Typography variant="caption" noWrap display="block" color="text.secondary">
              {s.original}
            </Typography>
          </Box>
        );
      })}
    </Paper>
  );
}
