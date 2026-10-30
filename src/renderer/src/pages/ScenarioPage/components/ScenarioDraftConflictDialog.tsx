import { commonTexts } from '@shared/texts/common';
import { scenarioTexts } from '@shared/texts/scenario';
import UndoIcon from '@mui/icons-material/Undo';
import SaveIcon from '@mui/icons-material/Save';
import type { ReactElement } from 'react';
import { Alert, Stack, Typography } from '@mui/material';
import { ActionButton } from '../../../components/ActionButton';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';

/** Несохранённые правки разрешаются явно до запуска, утверждения, обновления и применения. */
export function ScenarioDraftConflictDialog({
  open,
  treatmentDirty,
  scenesDirty,
  busy,
  onResolve,
  onClose
}: {
  open: boolean;
  treatmentDirty: boolean;
  scenesDirty: boolean;
  busy: boolean;
  onResolve(action: 'save' | 'discard'): void;
  onClose(): void;
}): ReactElement {
  return (
    <ConfirmationDialog
      open={open}
      title={commonTexts.unsavedChanges}
      onClose={onClose}
      cancelLabel={scenarioTexts.drafts.returnToEditor}
      cancelDisabled={busy}
      cancelDisabledReason={scenarioTexts.drafts.waitSaving}
      closeDisabled={busy}
      confirmDisabled={busy}
      confirmDisabledReason={scenarioTexts.drafts.waitSaving}
      confirmLabel={scenarioTexts.drafts.saveAndContinue}
      confirmIcon={<SaveIcon />}
      onConfirm={() => onResolve('save')}
      extraActions={
        <ActionButton
          startIcon={<UndoIcon />}
          disabled={busy}
          disabledReason={scenarioTexts.drafts.waitSaving}
          color="error"
          onClick={() => onResolve('discard')}
        >
          {scenarioTexts.drafts.discardAndContinue}
        </ActionButton>
      }
    >
      <Stack spacing={2}>
        <Typography>{scenarioTexts.drafts.changed({ treatment: treatmentDirty, scenes: scenesDirty })}</Typography>
        <Alert severity="warning">{scenarioTexts.drafts.resolveBeforeAgent}</Alert>
      </Stack>
    </ConfirmationDialog>
  );
}
