import { productionTexts } from '@shared/texts/production';
/** Возврат утверждённой опоры: замечание обязательно, кандидат снимается, видеопромпт согласуется заново. */
import { useState, type ReactElement } from 'react';
import ReplayIcon from '@mui/icons-material/Replay';
import { TextField } from '@mui/material';
import type { KeyframeNoteScope } from '@shared/types';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { KeyframeNoteScopeField } from './KeyframeNoteScopeField';

export function KeyframeReopenDialog({
  frame,
  onClose,
  onConfirm
}: {
  frame: string;
  onClose(): void;
  onConfirm(note: string, scope: KeyframeNoteScope): void;
}): ReactElement {
  const [note, setNote] = useState('');
  const [scope, setScope] = useState<KeyframeNoteScope>('following');
  return (
    <ConfirmationDialog
      open
      title={productionTexts.keyframeReopenDialog.title({ frame })}
      description={productionTexts.keyframeReopenDialog.description({ frame })}
      confirmLabel={productionTexts.keyframeReopenDialog.confirm}
      confirmIcon={<ReplayIcon />}
      confirmColor="warning"
      confirmDisabled={!note.trim()}
      confirmDisabledReason={productionTexts.keyframeReopenDialog.reason}
      onClose={onClose}
      onConfirm={() => onConfirm(note.trim(), scope)}
    >
      <TextField
        autoFocus
        fullWidth
        multiline
        minRows={3}
        maxRows={8}
        label={productionTexts.keyframeReopenDialog.note}
        placeholder={productionTexts.keyframeReopenDialog.placeholder}
        helperText={productionTexts.keyframeReopenDialog.hint}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        sx={{ mt: 2, mb: 1 }}
      />
      <KeyframeNoteScopeField scope={scope} onChange={setScope} />
    </ConfirmationDialog>
  );
}
