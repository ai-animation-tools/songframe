import { SwapHoriz } from '@mui/icons-material';
import type { ReactElement } from 'react';
import { Typography } from '@mui/material';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';

/** Открытие другого черновика не теряет несохранённый монтаж без отдельного решения. */
export function MontageDiscardDialog({ open, onClose, onContinue }: { open: boolean; onClose: () => void; onContinue: () => void }): ReactElement {
  return (
    <ConfirmationDialog
      open={open}
      onClose={onClose}
      title="Заменить текущий монтаж?"
      onConfirm={onContinue}
      confirmLabel="Заменить"
      confirmIcon={<SwapHoriz />}
      confirmColor="error"
      cancelLabel="Вернуться и сохранить"
    >
      <Typography>В текущем черновике есть несохранённые изменения. Сохраните его перед открытием другого или продолжите с заменой.</Typography>
    </ConfirmationDialog>
  );
}
