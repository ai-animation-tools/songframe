import { Paper, Stack, Typography, type SxProps, type Theme } from '@mui/material';
import type { ReactNode } from 'react';
import { SHELL_HEADER_HEIGHT } from './ShellLayout';

/** Панель остаётся под общей шапкой при прокрутке и принадлежит всей странице. */
export function PageActionBar({ title, children, sx }: { title: string; children?: ReactNode; sx?: SxProps<Theme> }) {
  return (
    <Paper elevation={0} sx={{ position: 'sticky', top: SHELL_HEADER_HEIGHT, zIndex: 2, py: 1.5, borderBottom: 1, borderColor: 'divider', ...sx }}>
      <Stack direction="row" alignItems="center" gap={1} useFlexGap flexWrap="wrap">
        <Typography variant="h5" component="h1" sx={{ flex: 1 }}>
          {title}
        </Typography>
        {children}
      </Stack>
    </Paper>
  );
}
