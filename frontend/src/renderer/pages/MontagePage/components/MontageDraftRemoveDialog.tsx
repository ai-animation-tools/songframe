import { montageTexts } from '@shared/texts/montage';
import { DeleteOutline } from '@mui/icons-material';
import type { ReactElement } from 'react';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';

interface Props {
  open: boolean;
  name: string;
  onClose: () => void;
  onConfirm: () => void;
}

/** Удаление черновика необратимо, поэтому по умолчанию предлагается отмена; сцены оно не затрагивает. */
export function MontageDraftRemoveDialog({ open, name, onClose, onConfirm }: Props): ReactElement {
  return (
    <ConfirmationDialog
      open={open}
      onClose={onClose}
      title={montageTexts.removeDraftTitle}
      description={montageTexts.removeDraftDescription({ name })}
      onConfirm={onConfirm}
      confirmLabel={montageTexts.removeDraftConfirm}
      confirmIcon={<DeleteOutline />}
      confirmColor="error"
      cancelAutoFocus
    />
  );
}
