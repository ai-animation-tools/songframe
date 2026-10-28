/** Вопрос пакета и варианты ответа; ответ сразу выполняет приложение. */
import type { ReactElement } from 'react';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import EditIcon from '@mui/icons-material/Edit';
import SendIcon from '@mui/icons-material/Send';
import SaveIcon from '@mui/icons-material/Save';
import MovieIcon from '@mui/icons-material/Movie';
import ReplayIcon from '@mui/icons-material/Replay';
import { Alert, Box, TextField, Typography } from '@mui/material';
import type { PackageView } from '@shared/types';
import { BUSY_REASON, VERDICT_HINTS, VERDICT_LABELS } from '../constants';
import { useApp } from '../../../state';
import { aiActionProblem } from '@shared/ai-access';
import type { AiActionKind } from '@shared/ai-access';
import { LinkedText } from '../../../components/LinkedText';
import { ActionButton } from '../../../components/ActionButton';

/** Пример относится к текущему согласованию и помогает описать конкретное изменение. */
const REVISION_EXAMPLES: Record<string, string> = {
  description_review: 'Например: герой должен выйти из дома, а не остаться у окна.',
  keyframes_review: 'Например: в первом опорном кадре сохранить одежду героя из предыдущего плана.',
  prompt_review: 'Например: камера медленно приближается к герою, без смены ракурса.',
  request_choice: 'Например: заменить последнюю опору и уточнить движение камеры перед отправкой.',
  image_request_choice: 'Например: уточнить позу героя и освещение в запросе изображения.'
};

export function PackageDecision({
  pending,
  aiKind,
  sendingBlocked,
  note,
  setNote,
  busy,
  busyReason = BUSY_REASON,
  onDecide
}: {
  pending: PackageView['pendingDecision'];
  aiKind: AiActionKind;
  sendingBlocked?: boolean;
  note: string;
  setNote(value: string): void;
  busy: boolean;
  /** Почему busy блокирует ответы: идёт операция или нет Python. */
  busyReason?: string;
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
            Этот пакет ведёт приложение: нажатие кнопки сразу записывает ответ и выполняет действие. «Отправить» открывает подтверждение стоимости перед
            списанием, «Сохранить в очередь» переносит пакет в очередь, «Принять» открывает приёмку. Поле ниже нужно только для «Вернуть с замечанием»:
            замечание сохраняется в пакете и передаётся агенту, когда вы нажмёте «Запустить доработку с агентом» в блоке «Подготовка плана». Текст запроса здесь
            не редактируется.
          </Typography>
          {options.includes('revise') ? (
            <TextField
              size="small"
              fullWidth
              multiline
              minRows={3}
              maxRows={8}
              label="Что нужно исправить"
              placeholder={REVISION_EXAMPLES[pending.stage] ?? 'Например: укажите, что изменить в показанных материалах и каким должен быть результат.'}
              helperText={
                'Опишите нужные изменения. Обязательно только для «Вернуть с замечанием». Замечание сохранится вместе с ответом. Агент автоматически не запускается. После возврата нажмите «Запустить доработку с агентом» в блоке «Подготовка плана».'
              }
              value={note}
              onChange={(e) => setNote(e.target.value)}
              sx={{ mb: 1 }}
            />
          ) : null}
          {options.length > 1 ? (
            <Box component="ul" sx={{ m: 0, mb: 1, pl: 2.5 }}>
              {options.map((verdict) => (
                <Typography key={verdict} component="li" variant="caption" color="text.secondary">
                  <b>{VERDICT_LABELS[verdict]?.label ?? verdict}.</b> <LinkedText text={VERDICT_HINTS[verdict] ?? ''} />
                </Typography>
              ))}
            </Box>
          ) : null}
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {options.map((verdict) => {
              const paid = ['send', 'retry'].includes(verdict);
              const reason = paid ? problem : null;
              const disabledReason =
                reason ??
                (busy
                  ? busyReason
                  : sendingBlocked && paid
                    ? 'Исход отправки этой попытки ещё не известен: дождитесь его или разберите в блоке получения выше.'
                    : verdict === 'revise' && !note.trim()
                      ? 'Опишите в поле выше, что нужно исправить.'
                      : null);
              return (
                <ActionButton
                  key={verdict}
                  title={VERDICT_HINTS[verdict]}
                  disabledReason={disabledReason}
                  size="small"
                  variant={verdict === options[0] ? 'contained' : 'outlined'}
                  color={VERDICT_LABELS[verdict]?.color ?? 'inherit'}
                  disabled={!!reason || busy || (sendingBlocked && ['send', 'retry'].includes(verdict)) || (verdict === 'revise' && !note.trim())}
                  onClick={() => onDecide(verdict)}
                  startIcon={
                    verdict === 'send' ? (
                      <SendIcon />
                    ) : verdict === 'park' ? (
                      <SaveIcon />
                    ) : verdict === 'review' ? (
                      <MovieIcon />
                    ) : verdict === 'retry' ? (
                      <ReplayIcon />
                    ) : verdict === 'revise' ? (
                      <EditIcon />
                    ) : (
                      <CheckCircleIcon />
                    )
                  }
                >
                  {VERDICT_LABELS[verdict]?.label ?? verdict}
                </ActionButton>
              );
            })}
          </Box>
        </Alert>
      ) : null}
    </>
  );
}
