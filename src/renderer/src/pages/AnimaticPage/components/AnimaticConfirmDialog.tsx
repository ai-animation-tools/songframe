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
      title={confirm === 'approved' ? 'Принять результат?' : 'Вернуть на просмотр?'}
      onConfirm={() => {
        if (confirm) void onConfirm(confirm);
      }}
      confirmLabel={confirm === 'approved' ? 'Принять' : 'Вернуть'}
      confirmIcon={<CheckIcon />}
      confirmDisabled={running}
      confirmDisabledReason="Дождитесь завершения сборки."
    >
      <Typography variant="body2">
        {confirm === 'approved'
          ? 'Результат будет отмечен как принятый. Если видео изменится после пересборки, просмотрите его и примите заново.'
          : 'Результат снова будет ожидать просмотра и принятия.'}
      </Typography>
    </ConfirmationDialog>
  );
}
