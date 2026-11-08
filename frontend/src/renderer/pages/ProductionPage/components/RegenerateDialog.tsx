import { productionTexts } from '@shared/texts/production';
/** Подготовка новой попытки по сохранённому запросу без платной отправки. */
import type { ReactElement } from 'react';
import { Typography } from '@mui/material';
import ReplayIcon from '@mui/icons-material/Replay';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';

export function RegenerateDialog({
  shot,
  problem,
  onClose,
  onConfirm
}: {
  shot: string | null;
  problem?: string | null;
  onClose(): void;
  onConfirm(): void;
}): ReactElement {
  return (
    <ConfirmationDialog
      open={!!shot}
      onClose={onClose}
      title={productionTexts.regenerateDialog.title({ shot: shot ?? '' })}
      onConfirm={() => {
        if (!problem) onConfirm();
      }}
      confirmDisabled={!!problem}
      confirmDisabledReason={problem}
      confirmLabel={productionTexts.regenerateDialog.confirm}
      confirmIcon={<ReplayIcon />}
      confirmColor="warning"
    >
      <Typography variant="body2" sx={{ mt: 1 }}>
        {productionTexts.regenerateDialog.description}
      </Typography>
    </ConfirmationDialog>
  );
}
