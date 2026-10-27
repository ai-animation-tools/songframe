/** Вопрос пакета и варианты ответа с учётом исполнителя приложения или внешнего агента. */
import type { ReactElement } from 'react';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import EditIcon from '@mui/icons-material/Edit';
import SendIcon from '@mui/icons-material/Send';
import SaveIcon from '@mui/icons-material/Save';
import MovieIcon from '@mui/icons-material/Movie';
import { Alert, Box, Button, TextField, Typography } from '@mui/material';
import type { PackageView } from '@shared/types';
import { VERDICT_LABELS } from '../constants';
import { useApp } from '../../../state';
import { aiActionProblem } from '@shared/ai-access';
import type { AiActionKind } from '@shared/ai-access';
import { AgentIcon } from '../../../components';

export function PackageDecision({
  pending,
  external,
  aiKind,
  sendingBlocked,
  note,
  setNote,
  busy,
  onDecide
}: {
  pending: PackageView['pendingDecision'];
  external: boolean;
  aiKind: AiActionKind;
  sendingBlocked?: boolean;
  note: string;
  setNote(value: string): void;
  busy: boolean;
  onDecide(verdict: string): void;
}): ReactElement {
  const { aiAccess } = useApp();
  const problem = aiActionProblem(aiAccess, aiKind);
  const options = pending?.options ?? [];
  return (
    <>
      {pending ? (
        <Alert severity="info" sx={{ mb: 2 }} icon={false}>
          <Typography fontWeight={600} gutterBottom>
            {pending.question}
          </Typography>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
            {external
              ? 'Внешний агент ждёт ответа. Отправку, сохранение и повтор после вашего ответа выполнит он.'
              : 'Ответ будет обработан приложением. Платная отправка требует подтверждения запроса.'}
          </Typography>
          {options.includes('revise') ? (
            <TextField
              size="small"
              fullWidth
              label="Замечание (обязательно для возврата)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              sx={{ mb: 1 }}
            />
          ) : null}
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {options.map((verdict) => {
              const reason = ['send', 'retry'].includes(verdict) ? problem : null;
              return (
                <Button
                  title={reason ?? undefined}
                  key={verdict}
                  size="small"
                  variant={verdict === options[0] ? 'contained' : 'outlined'}
                  color={VERDICT_LABELS[verdict]?.color ?? 'inherit'}
                  disabled={!!reason || busy || (sendingBlocked && ['send', 'retry'].includes(verdict)) || (verdict === 'revise' && !note.trim())}
                  startIcon={
                    external ? (
                      <AgentIcon provider={null} monochrome={verdict === options[0] || busy} />
                    ) : verdict === 'send' ? (
                      <SendIcon />
                    ) : verdict === 'park' ? (
                      <SaveIcon />
                    ) : verdict === 'review' ? (
                      <MovieIcon />
                    ) : ['revise', 'retry'].includes(verdict) ? (
                      <EditIcon />
                    ) : (
                      <CheckCircleIcon />
                    )
                  }
                  onClick={() => onDecide(verdict)}
                >
                  {VERDICT_LABELS[verdict]?.label ?? verdict}
                </Button>
              );
            })}
          </Box>
        </Alert>
      ) : null}
    </>
  );
}
