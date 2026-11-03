import { castTexts } from '@shared/texts/cast';
import { commonTexts } from '@shared/texts/common';
import { navigationTexts } from '@shared/texts/navigation';
import type { ReactElement } from 'react';
import { PageActionBar } from '../../../components/PageActionBar';
import { Box, Chip, Typography } from '@mui/material';
import { ActionButton } from '../../../components/ActionButton';
import SaveIcon from '@mui/icons-material/Save';
import SyncIcon from '@mui/icons-material/Sync';

interface CastToolbarProps {
  busy: boolean;
  dirty: boolean;
  /** Что мешает сохранить черновик (например, ошибка словаря свойств); null — можно сохранять. */
  saveBlockedReason: string | null;
  hasManifest: boolean;
  hasCast: boolean;
  onInit: () => void;
  onSave: () => void;
}

/** Действия кастинга учитывают несохранённые изменения и выполняющуюся операцию. */
export function CastToolbar({ busy, dirty, saveBlockedReason, hasManifest, hasCast, onInit, onSave }: CastToolbarProps): ReactElement {
  // Дополнение перечитывает файл кастинга, поэтому несохранённые правки сначала нужно сохранить.
  const initBlockedReason = busy ? null : !hasManifest ? castTexts.sourcesRequired : dirty ? castTexts.saveFirst : null;
  const busyReason = commonTexts.operationPending;
  return (
    <PageActionBar>
      <Typography variant="h5">{navigationTexts.pages.cast}</Typography>
      {dirty ? <Chip size="small" color="warning" label={commonTexts.unsavedChanges} /> : null}
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
        {hasCast ? castTexts.supplement : castTexts.create}
      </ActionButton>
      <ActionButton
        variant="contained"
        startIcon={<SaveIcon />}
        disabled={busy || !dirty || Boolean(saveBlockedReason)}
        disabledReason={busy ? busyReason : !dirty ? commonTexts.noChangesToSave : saveBlockedReason}
        onClick={onSave}
      >
        {commonTexts.save}
      </ActionButton>
    </PageActionBar>
  );
}
