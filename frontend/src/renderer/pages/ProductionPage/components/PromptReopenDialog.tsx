import { productionTexts } from '@shared/texts/production';
/** Возврат утверждённого видеопромпта: замечание обязательно, описание и опоры остаются, неотправленный запрос — в истории попытки. */
import { useState, type ReactElement } from 'react';
import ReplayIcon from '@mui/icons-material/Replay';
import { TextField } from '@mui/material';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';

export function PromptReopenDialog({
  request,
  onClose,
  onConfirm
}: {
  /** Папка подготовленного, но не отправленного запроса; null — запроса нет. */
  request: string | null;
  onClose(): void;
  onConfirm(note: string): void;
}): ReactElement {
  const [note, setNote] = useState('');
  return (
    <ConfirmationDialog
      open
      explicitCancelOnly={!!note}
      title={productionTexts.promptReopenDialog.title}
      description={productionTexts.promptReopenDialog.description({ request })}
      confirmLabel={productionTexts.promptReopenDialog.confirm}
      confirmIcon={<ReplayIcon />}
      confirmColor="warning"
      confirmDisabled={!note.trim()}
      confirmDisabledReason={productionTexts.promptReopenDialog.reason}
      onClose={onClose}
      onConfirm={() => onConfirm(note.trim())}
    >
      <TextField
        autoFocus
        fullWidth
        multiline
        minRows={3}
        maxRows={8}
        label={productionTexts.promptReopenDialog.note}
        placeholder={productionTexts.promptReopenDialog.placeholder}
        helperText={productionTexts.promptReopenDialog.hint}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        sx={{ mt: 2, mb: 1 }}
      />
    </ConfirmationDialog>
  );
}
