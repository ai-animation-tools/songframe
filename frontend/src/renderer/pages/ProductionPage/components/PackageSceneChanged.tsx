import { productionTexts } from '@shared/texts/production';
/** Пакет подготовлен по прежней постановке плана: объясняет выбор и даёт оставить пакет для текущей постановки. */
import { useState, type ReactElement } from 'react';
import { Alert, Box } from '@mui/material';
import TaskAltIcon from '@mui/icons-material/TaskAlt';
import EditNoteIcon from '@mui/icons-material/EditNote';
import type { PackageView } from '@shared/types';
import { SCENE_CHANGED } from '@shared/production-labels';
import { ActionButton } from '../../../components/ActionButton';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';

export function PackageSceneChanged({
  pkg,
  busy,
  busyReason,
  onKeep,
  onOpenRevision
}: {
  pkg: PackageView;
  busy: boolean;
  busyReason: string;
  onKeep(): void;
  onOpenRevision(): void;
}): ReactElement {
  const [confirm, setConfirm] = useState(false);
  // Отправленная попытка уже сделана по прежней постановке: оставить её для новой нельзя.
  const sent = !!pkg.request && pkg.request.attemptStatus !== 'prepared';
  return (
    <Alert severity="warning" sx={{ mb: 1 }}>
      {productionTexts.packageSceneChanged.blockedDescription({ reason: SCENE_CHANGED })}
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1 }}>
        <ActionButton
          size="small"
          variant="outlined"
          color="warning"
          startIcon={<TaskAltIcon />}
          disabled={busy || sent}
          disabledReason={busy ? busyReason : productionTexts.packageSceneChanged.sentReason}
          onClick={() => setConfirm(true)}
        >
          {productionTexts.packageSceneChanged.retain}
        </ActionButton>
        <ActionButton size="small" startIcon={<EditNoteIcon />} disabled={busy} disabledReason={busyReason} onClick={onOpenRevision}>
          {productionTexts.packageSceneChanged.revise}
        </ActionButton>
      </Box>
      <ConfirmationDialog
        open={confirm}
        title={productionTexts.packageSceneChanged.confirmTitle}
        description={productionTexts.packageSceneChanged.description}
        confirmLabel={productionTexts.packageSceneChanged.confirm}
        confirmColor="warning"
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          onKeep();
        }}
      />
    </Alert>
  );
}
