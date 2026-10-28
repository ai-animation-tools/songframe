import type { ReactElement } from 'react';
import { PageActionBar } from '../../../components/PageActionBar';
import { Box, Chip, Typography } from '@mui/material';
import { ActionButton } from '../../../components/ActionButton';
import SaveIcon from '@mui/icons-material/Save';
import SyncIcon from '@mui/icons-material/Sync';

interface CastToolbarProps {
  busy: boolean;
  dirty: boolean;
  hasManifest: boolean;
  hasCast: boolean;
  onInit: () => void;
  onSave: () => void;
}

/** Действия кастинга учитывают несохранённые изменения и выполняющуюся операцию. */
export function CastToolbar({ busy, dirty, hasManifest, hasCast, onInit, onSave }: CastToolbarProps): ReactElement {
  // Дополнение перечитывает файл кастинга, поэтому несохранённые правки сначала нужно сохранить.
  const initBlockedReason = busy ? null : !hasManifest ? 'Сначала загрузите исходники.' : dirty ? 'Сначала сохраните правки.' : null;
  const busyReason = 'Дождитесь завершения текущей операции.';
  return (
    <PageActionBar>
      <Typography variant="h5">Кастинг</Typography>
      {dirty ? <Chip size="small" color="warning" label="Есть несохранённые правки" /> : null}
      <Box sx={{ flex: 1 }} />
      {/* Действие добавляет сущности, поэтому зелёное; как второстепенное в панели — текстовое. */}
      <ActionButton
        variant="text"
        color="success"
        startIcon={<SyncIcon />}
        disabled={busy || !!initBlockedReason}
        disabledReason={busy ? busyReason : initBlockedReason}
        onClick={onInit}
      >
        {hasCast ? 'Дополнить из исходников' : 'Создать из исходников'}
      </ActionButton>
      <ActionButton
        variant="contained"
        startIcon={<SaveIcon />}
        disabled={busy || !dirty}
        disabledReason={busy ? busyReason : 'Нет изменений для сохранения.'}
        onClick={onSave}
      >
        Сохранить
      </ActionButton>
    </PageActionBar>
  );
}
