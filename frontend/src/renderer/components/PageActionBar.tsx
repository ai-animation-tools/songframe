import type { ReactElement, ReactNode, Ref } from 'react';
import { Paper, type SxProps, type Theme } from '@mui/material';
import { useHeaderHeight } from './headerHeight';

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
  const headerHeight = useHeaderHeight();
  return (
    <Paper
      ref={barRef}
      variant="outlined"
      // По метке прокрутка к цели ссылки учитывает закреплённую панель (PAGE_ACTION_BAR_ATTR в useAnchorTarget).
      data-page-action-bar={position}
      sx={[
        {
          position: 'sticky',
          ...(position === 'top' ? { top: headerHeight } : { bottom: 0 }),
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
