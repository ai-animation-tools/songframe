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
      title={`Вернуть опору ${frame} на доработку`}
      description={`Утверждение ${frame} будет снято, файл кандидата останется в папке пакета. Опору нужно создать заново кнопкой «Создать ${frame}» в блоке «Подготовка плана», затем снова утвердить; видеопромпт после этого согласуется заново.`}
      confirmLabel="Вернуть на доработку"
      confirmIcon={<ReplayIcon />}
      confirmColor="warning"
      confirmDisabled={!note.trim()}
      confirmDisabledReason="Опишите, что исправить в опоре."
      onClose={onClose}
      onConfirm={() => onConfirm(note.trim(), scope)}
    >
      <TextField
        autoFocus
        fullWidth
        multiline
        minRows={3}
        maxRows={8}
        label="Что исправить в опоре"
        placeholder="Например: сохранить одежду героя из предыдущего плана, свет — тёплый вечерний."
        helperText="Обязательно. Замечание сохраняется в пакете и передаётся агенту при создании опоры."
        value={note}
        onChange={(event) => setNote(event.target.value)}
        sx={{ mt: 2, mb: 1 }}
      />
      <KeyframeNoteScopeField scope={scope} onChange={setScope} />
    </ConfirmationDialog>
  );
}
