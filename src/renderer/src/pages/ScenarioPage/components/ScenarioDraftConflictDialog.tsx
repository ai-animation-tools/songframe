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
      title="Есть несохранённые правки"
      onClose={onClose}
      cancelLabel="Вернуться к редактору"
      cancelDisabled={busy}
      cancelDisabledReason="Дождитесь сохранения правок."
      closeDisabled={busy}
      confirmDisabled={busy}
      confirmDisabledReason="Дождитесь сохранения правок."
      confirmLabel="Сохранить и продолжить"
      confirmIcon={<SaveIcon />}
      onConfirm={() => onResolve('save')}
      extraActions={
        <ActionButton startIcon={<UndoIcon />} disabled={busy} disabledReason="Дождитесь сохранения правок." color="error" onClick={() => onResolve('discard')}>
          Отменить правки и продолжить
        </ActionButton>
      }
    >
      <Stack spacing={2}>
        <Typography>Изменены: {[treatmentDirty && 'трактовка', scenesDirty && 'реестр сцен'].filter(Boolean).join(', ')}.</Typography>
        <Alert severity="warning">Сначала сохраните правки или явно отмените их. Агент получает только сохранённые данные проекта.</Alert>
      </Stack>
    </ConfirmationDialog>
  );
}
