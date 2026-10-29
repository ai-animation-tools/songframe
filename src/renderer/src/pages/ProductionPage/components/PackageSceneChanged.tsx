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
      {SCENE_CHANGED} Пока это не решено, опоры, промпт и отправка для пакета недоступны.
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1 }}>
        <ActionButton
          size="small"
          variant="outlined"
          color="warning"
          startIcon={<TaskAltIcon />}
          disabled={busy || sent}
          disabledReason={busy ? busyReason : 'Попытка уже отправлялась по прежней постановке: подготовьте новый пакет.'}
          onClick={() => setConfirm(true)}
        >
          Оставить пакет для текущей постановки
        </ActionButton>
        <ActionButton size="small" startIcon={<EditNoteIcon />} disabled={busy} disabledReason={busyReason} onClick={onOpenRevision}>
          Доработать описание
        </ActionButton>
      </Box>
      <ConfirmationDialog
        open={confirm}
        title="Оставить пакет для текущей постановки?"
        description="Описание, опоры, видеопромпт и подготовленный запрос останутся как есть и будут считаться соответствующими текущему сценарию плана. Выбирайте это, если правка сценария их не меняет: например, сокращены формулировки или исправлена опечатка. Если изменились действие, положение героев или их состояние в кадре, лучше доработать описание."
        confirmLabel="Оставить пакет"
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
