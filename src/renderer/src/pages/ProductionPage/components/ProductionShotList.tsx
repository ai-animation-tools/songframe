/** Навигация по планам с текущим этапом и ожидающим решением. */
import type { ReactElement } from 'react';
import { Box, Chip, Paper, Typography } from '@mui/material';
import type { ShotProduction } from '@shared/types';
import { formatClock } from '../../../format';
import { STATE_LABELS } from '../constants';

export function ProductionShotList({
  shots,
  selected,
  onSelect
}: {
  shots: ShotProduction[];
  selected: string | null;
  onSelect(id: string): void;
}): ReactElement {
  return (
    <Paper variant="outlined" sx={{ maxHeight: 'calc(100vh - 260px)', overflowY: 'auto' }}>
      {shots.map((s) => {
        const pending = s.packages.find((p) => p.pendingDecision);
        return (
          <Box
            key={s.id}
            onClick={() => onSelect(s.id)}
            sx={{
              px: 1.5,
              py: 1,
              cursor: 'pointer',
              borderLeft: 3,
              borderColor: s.id === selected ? 'primary.main' : 'transparent',
              bgcolor: s.id === selected ? 'action.selected' : undefined,
              '&:hover': { bgcolor: 'action.hover' }
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography fontWeight={600} sx={{ fontFamily: 'monospace' }}>
                {s.id}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {formatClock(s.start)}–{formatClock(s.end)}
              </Typography>
              <Box sx={{ flex: 1 }} />
              <Chip size="small" label={STATE_LABELS[s.state].label} color={STATE_LABELS[s.state].color} variant="outlined" sx={{ height: 20 }} />
            </Box>
            <Typography variant="caption" color={pending ? 'primary' : 'text.secondary'} noWrap display="block">
              {pending ? `ждёт решения: ${pending.pendingDecision!.question}` : s.stageLabel}
            </Typography>
          </Box>
        );
      })}
    </Paper>
  );
}
