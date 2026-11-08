import type { ReactElement, ReactNode } from 'react';
import { Box, Typography } from '@mui/material';

/** Сохраняет единый заголовок и отступы смыслового раздела подробностей сцены. */
export function ShotSection({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}
