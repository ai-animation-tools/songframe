import type { ReactElement } from 'react';
import { Box, Paper, Tooltip } from '@mui/material';
import type { ScenesFile } from '@shared/types';
import { formatClock } from '../../../format';
import { FPS } from '@shared/video';

/** Отображает части песни и планы на общей монтажной шкале. */
export function SceneTimeline({
  scenes,
  duration,
  selected,
  onSelect
}: {
  scenes: ScenesFile;
  duration: number;
  selected: string | null;
  onSelect(id: string): void;
}): ReactElement {
  const total = Math.max(duration * FPS, scenes.scenes.at(-1)?.end_frame_exclusive ?? 1);
  const colors = ['#4f81bd', '#9bbb59', '#c0504d', '#8064a2', '#f79646', '#4bacc6'];
  const seqIndex = new Map(scenes.sequences.map((s, i) => [s.id, i]));
  return (
    <Paper variant="outlined" sx={{ p: 1 }}>
      <Box sx={{ display: 'flex', height: 18, mb: 0.5 }}>
        {scenes.sequences.map((seq, i) => {
          const members = scenes.scenes.filter((s) => s.sequence === seq.id);
          if (!members.length) return null;
          const start = Math.min(...members.map((m) => m.start_frame));
          const end = Math.max(...members.map((m) => m.end_frame_exclusive));
          return (
            <Box
              key={seq.id}
              sx={{
                width: `${((end - start) / total) * 100}%`,
                bgcolor: colors[i % colors.length],
                opacity: 0.35,
                px: 0.5,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                fontSize: 11,
                lineHeight: '18px',
                borderRadius: 0.5
              }}
            >
              {seq.title || seq.id}
            </Box>
          );
        })}
      </Box>
      <Box sx={{ display: 'flex', height: 34 }}>
        {scenes.scenes.map((s) => (
          <Tooltip key={s.id} title={`${s.id} · ${formatClock(s.start_frame / FPS)}–${formatClock(s.end_frame_exclusive / FPS)}`}>
            <Box
              onClick={() => onSelect(s.id)}
              sx={{
                width: `${((s.end_frame_exclusive - s.start_frame) / total) * 100}%`,
                bgcolor: colors[(seqIndex.get(s.sequence) ?? 0) % colors.length],
                opacity: s.id === selected ? 1 : 0.6,
                outline: s.id === selected ? '2px solid' : '1px solid rgba(0,0,0,0.25)',
                outlineColor: s.id === selected ? 'text.primary' : undefined,
                cursor: 'pointer',
                fontSize: 10,
                color: '#fff',
                px: 0.25,
                overflow: 'hidden',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              {s.id.replace(/^M/, '')}
            </Box>
          </Tooltip>
        ))}
      </Box>
    </Paper>
  );
}
