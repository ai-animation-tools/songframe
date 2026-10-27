import type { ComponentProps, ReactElement } from 'react';
import { Close } from '@mui/icons-material';
import { Box, Button, Drawer } from '@mui/material';
import { MontageSources } from './MontageSources';

interface Props extends ComponentProps<typeof MontageSources> {
  open: boolean;
  onClose: () => void;
  disabled: boolean;
}

/** Выбор материала не закрывает каталог: панель остаётся до явного закрытия, клика снаружи или Escape. */
export function MontageSourcesDrawer({ open, onClose, disabled, ...sources }: Props): ReactElement {
  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      slotProps={{
        paper: {
          role: 'dialog',
          'aria-modal': true,
          'aria-labelledby': 'montage-sources-title',
          // На широком экране каталог занимает хотя бы половину окна, а на узком — всю доступную ширину.
          sx: { width: 'min(100vw, max(720px, 50vw))', maxWidth: '100vw', overflow: 'hidden' }
        }
      }}
    >
      <Box sx={{ display: 'flex', minHeight: 0, flex: 1, pointerEvents: disabled ? 'none' : undefined, opacity: disabled ? 0.7 : 1 }}>
        <MontageSources {...sources} />
      </Box>
      <Box sx={{ p: 2 }}>
        <Button startIcon={<Close />} onClick={onClose}>
          Закрыть материалы сцен
        </Button>
      </Box>
    </Drawer>
  );
}
