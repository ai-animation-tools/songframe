import { montageTexts } from '@shared/texts/montage';
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
      title={montageTexts.replaceTitle}
      onConfirm={onContinue}
      confirmLabel={montageTexts.replace}
      confirmIcon={<SwapHoriz />}
      confirmColor="error"
      cancelLabel={montageTexts.returnAndSave}
    >
      <Typography>{montageTexts.replaceWarning}</Typography>
    </ConfirmationDialog>
  );
}
