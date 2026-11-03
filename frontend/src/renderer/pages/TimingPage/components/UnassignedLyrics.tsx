import { timingTexts } from '@shared/texts/timing';
import type { ReactElement } from 'react';
import { Box, IconButton, Paper, Stack, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import type { LyricsLine } from '@shared/types';

interface UnassignedLyricsProps {
  lyrics: LyricsLine[];
  onAdd: (lyric: LyricsLine) => void;
}

/** Неразмеченные строки добавляются на текущую позицию плейхеда. */
export function UnassignedLyrics({ lyrics, onAdd }: UnassignedLyricsProps): ReactElement {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        {timingTexts.unassignedTitle({ count: lyrics.length })}
      </Typography>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
        {timingTexts.unassignedHelp}
      </Typography>
      <Stack spacing={0.5}>
        {lyrics.map((lyric) => (
          <Box key={lyric.number} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <IconButton
              size="small"
              color="success"
              aria-label={timingTexts.addLine({ line: lyric.number })}
              title={timingTexts.addLineHint}
              onClick={() => onAdd(lyric)}
            >
              <AddIcon fontSize="small" />
            </IconButton>
            <Typography variant="body2" color="text.secondary" sx={{ minWidth: 36 }}>
              {lyric.number}
            </Typography>
            <Typography variant="body2">{lyric.text}</Typography>
          </Box>
        ))}
      </Stack>
    </Paper>
  );
}
