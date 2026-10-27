import { DeleteOutline } from '@mui/icons-material';
import type { ReactElement } from 'react';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';

interface Props {
  scene: string | undefined;
  onClose: () => void;
  onConfirm: () => void;
}

/** Подтверждение удаления с дорожки сохраняет исходник и по умолчанию предлагает отмену. */
export function MontageRemoveDialog({ scene, onClose, onConfirm }: Props): ReactElement {
  return (
    <ConfirmationDialog
      open={scene !== undefined}
      onClose={onClose}
      title="Удалить с дорожки?"
      description={`Фрагмент сцены «${scene}» будет удалён из монтажа. Исходный файл сохранится.`}
      onConfirm={onConfirm}
      confirmLabel="Удалить с дорожки"
      confirmIcon={<DeleteOutline />}
      confirmColor="error"
      cancelAutoFocus
    />
  );
}
