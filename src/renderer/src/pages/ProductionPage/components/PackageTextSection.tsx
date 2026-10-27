/** Текстовая часть пакета: описание плана или видеопромпт с ограничением высоты. */
import type { ReactElement } from 'react';
import { Box, Typography } from '@mui/material';

export function PackageTextSection({ title, text, maxHeight }: { title: string; text: string; maxHeight: number }): ReactElement {
  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        {title}
      </Typography>
      <Typography
        component="pre"
        variant="body2"
        sx={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', m: 0, maxHeight, overflowY: 'auto', bgcolor: 'action.hover', p: 1.5, borderRadius: 1 }}
      >
        {text}
      </Typography>
    </Box>
  );
}
