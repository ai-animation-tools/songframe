/** Текстовая часть пакета: описание плана или видеопромпт с ограничением высоты, разметка показана словами. */
import type { ReactElement } from 'react';
import { Box, Typography } from '@mui/material';
import { Prose } from '../../../components/Prose';

export function PackageTextSection({ title, text, maxHeight }: { title: string; text: string; maxHeight: number }): ReactElement {
  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        {title}
      </Typography>
      <Box sx={{ maxHeight, overflowY: 'auto', bgcolor: 'action.hover', p: 1.5, borderRadius: 1 }}>
        <Prose text={text} />
      </Box>
    </Box>
  );
}
