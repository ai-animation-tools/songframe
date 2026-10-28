/** Принятие текущей сборки или возврат на просмотр с учётом её свежести. */

import type { ReactElement } from 'react';
import { Box, Paper, Typography } from '@mui/material';
import { ActionButton } from '../../../components/ActionButton';
import UndoIcon from '@mui/icons-material/Undo';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import type { AnimaticApproval, AnimaticView } from '@shared/types';

export function AnimaticAcceptance({
  built,
  accepted,
  approval,
  running,
  onConfirm
}: {
  built: NonNullable<AnimaticView['built']>;
  accepted: boolean;
  approval: AnimaticApproval;
  running: boolean;
  onConfirm: (status: 'approved' | 'review') => void;
}): ReactElement {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', flexDirection: 'column', gap: 1.5 }}>
        <Typography variant="subtitle1" fontWeight={600}>
          Принятие
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
          {accepted
            ? 'Текущий результат принят.'
            : approval.status === 'approved'
              ? !built.fresh
                ? 'Сценарий изменился после сборки. Пересоберите видео и просмотрите результат.'
                : 'После пересборки результат изменился. Просмотрите его и примите заново.'
              : 'Просмотрите видео целиком. Если результат устраивает, нажмите «Принять».'}
        </Typography>
        {approval.current ? (
          <ActionButton
            size="small"
            disabled={running}
            disabledReason="Дождитесь завершения сборки."
            startIcon={<UndoIcon />}
            onClick={() => onConfirm('review')}
          >
            Вернуть на просмотр
          </ActionButton>
        ) : (
          <ActionButton
            size="small"
            variant="contained"
            color="primary"
            startIcon={<CheckCircleIcon />}
            disabled={running || !built.fresh || !built.videoPath}
            disabledReason={
              running
                ? 'Дождитесь завершения сборки.'
                : !built.fresh
                  ? 'Сценарий изменился после сборки: пересоберите видео.'
                  : !built.videoPath
                    ? 'Видео ещё не собрано: нажмите «Собрать».'
                    : null
            }
            onClick={() => onConfirm('approved')}
          >
            Принять
          </ActionButton>
        )}
      </Box>
    </Paper>
  );
}
