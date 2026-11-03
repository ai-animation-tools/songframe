import { animaticTexts } from '@shared/texts/animatic';
/** Подтверждение изменения статуса принятия аниматика. */

import type { ReactElement } from 'react';
import { Typography } from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';

export function AnimaticConfirmDialog({
  confirm,
  running,
  onClose,
  onConfirm
}: {
  confirm: 'approved' | 'review' | null;
  running: boolean;
  onClose: () => void;
  onConfirm: (status: 'approved' | 'review') => Promise<void>;
}): ReactElement {
  return (
    <ConfirmationDialog
      open={!!confirm}
      onClose={onClose}
      title={confirm === 'approved' ? animaticTexts.confirm.approveTitle : animaticTexts.confirm.reviewTitle}
      onConfirm={() => {
        if (confirm) void onConfirm(confirm);
      }}
      confirmLabel={confirm === 'approved' ? animaticTexts.acceptance.approve : animaticTexts.confirm.return}
      confirmIcon={<CheckIcon />}
      confirmDisabled={running}
      confirmDisabledReason={animaticTexts.buildPending}
    >
      <Typography variant="body2">{confirm === 'approved' ? animaticTexts.confirm.approveDescription : animaticTexts.confirm.reviewDescription}</Typography>
    </ConfirmationDialog>
  );
}
