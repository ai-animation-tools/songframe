import { commonTexts } from '@shared/texts/common';
import { useState, type ReactElement } from 'react';
import { Alert, AlertTitle, Button, Stack } from '@mui/material';
import RestoreIcon from '@mui/icons-material/Restore';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import type { DraftOffer } from '../hooks/useDraftBackup';
import { formatDateTime } from '../format';
import { ConfirmationDialog } from './ConfirmationDialog';

/**
 * Предложение продолжить черновик, найденный при открытии страницы (useDraftBackup). Предупреждает, если файл на
 * диске изменился после начала правок. Отказ от черновика удаляет правки безвозвратно, поэтому подтверждается.
 */
export function DraftRestoreAlert<T>({ offer, onRestore, onDiscard }: { offer: DraftOffer<T>; onRestore(): void; onDiscard(): void }): ReactElement {
  const [confirm, setConfirm] = useState(false);
  return (
    <Alert
      severity="warning"
      data-draft-offer=""
      action={
        <Stack direction="row" spacing={1} sx={{ alignSelf: 'center' }}>
          <Button variant="contained" color="warning" startIcon={<RestoreIcon />} onClick={onRestore}>
            {commonTexts.draft.restore}
          </Button>
          <Button color="inherit" startIcon={<DeleteOutlineIcon />} onClick={() => setConfirm(true)}>
            {commonTexts.draft.discard}
          </Button>
        </Stack>
      }
    >
      <AlertTitle>{commonTexts.draft.title}</AlertTitle>
      {commonTexts.draft.text({ at: formatDateTime(offer.envelope.savedAt) })}
      {offer.baseChanged ? <div>{commonTexts.draft.baseChanged}</div> : null}
      <ConfirmationDialog
        open={confirm}
        title={commonTexts.draft.discardTitle}
        description={commonTexts.draft.discardText}
        confirmLabel={commonTexts.draft.discard}
        confirmIcon={<DeleteOutlineIcon />}
        confirmColor="error"
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          onDiscard();
        }}
      />
    </Alert>
  );
}
