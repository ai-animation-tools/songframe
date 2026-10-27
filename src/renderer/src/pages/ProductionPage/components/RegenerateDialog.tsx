/** Подготовка новой попытки по сохранённому запросу без платной отправки. */
import type { ReactElement } from 'react';
import { useApp } from '../../../state';
import { aiActionProblem } from '@shared/ai-access';
import { Alert, Typography } from '@mui/material';
import ReplayIcon from '@mui/icons-material/Replay';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';

export function RegenerateDialog({ shot, onClose, onConfirm }: { shot: string | null; onClose(): void; onConfirm(): void }): ReactElement {
  const { aiAccess } = useApp();
  const aiProblem = aiActionProblem(aiAccess, 'video');
  return (
    <ConfirmationDialog
      open={!!shot}
      onClose={onClose}
      title={`Подготовить повтор ${shot ?? ''}`}
      onConfirm={() => {
        if (!aiProblem) onConfirm();
      }}
      confirmDisabled={!!aiProblem}
      confirmLabel="Подготовить повтор"
      confirmIcon={<ReplayIcon />}
      confirmColor="warning"
    >
      {aiProblem ? <Alert severity="info">{aiProblem}</Alert> : null}
      <Typography variant="body2" sx={{ mt: 1 }}>
        Будет взят сохранённый запрос плана и создана новая попытка. Запрос не отправляется, кредиты не списываются. Перед платной отправкой приложение покажет
        новую таблицу параметров, входы и SHA256 запроса для отдельного подтверждения.
      </Typography>
    </ConfirmationDialog>
  );
}
