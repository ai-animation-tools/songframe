import type { ReactElement, ReactNode, Ref } from 'react';
import { Paper, type SxProps, type Theme } from '@mui/material';

/** Действия страницы остаются доступны при прокрутке под общей шапкой приложения. */
export function PageActionBar({
  children,
  position = 'top',
  sx,
  barRef
}: {
  children: ReactNode;
  position?: 'top' | 'bottom';
  sx?: SxProps<Theme>;
  barRef?: Ref<HTMLDivElement>;
}): ReactElement {
  return (
    <Paper
      ref={barRef}
      variant="outlined"
      sx={[
        {
          position: 'sticky',
          ...(position === 'top' ? { top: 49 } : { bottom: 0 }),
          zIndex: (theme) => theme.zIndex.appBar - 1,
          p: 1,
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 1,
          bgcolor: 'background.paper'
        },
        ...(sx ? (Array.isArray(sx) ? sx : [sx]) : [])
      ]}
    >
      {children}
    </Paper>
  );
}
