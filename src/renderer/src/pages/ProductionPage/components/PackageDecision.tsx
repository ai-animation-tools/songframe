/** Вопрос пакета и варианты ответа с учётом исполнителя приложения или внешнего агента. */
import type { ReactElement } from 'react';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import EditIcon from '@mui/icons-material/Edit';
import SendIcon from '@mui/icons-material/Send';
import SaveIcon from '@mui/icons-material/Save';
import MovieIcon from '@mui/icons-material/Movie';
import ReplayIcon from '@mui/icons-material/Replay';
import { Alert, Box, Button, TextField, Typography } from '@mui/material';
import type { PackageView } from '@shared/types';
import { VERDICT_HINTS, VERDICT_LABELS } from '../constants';
import { useApp } from '../../../state';
import { aiActionProblem } from '@shared/ai-access';
import type { AiActionKind } from '@shared/ai-access';
import { AgentIcon } from '../../../components';

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
              ? 'Приложение запишет ответ для внешнего агента. Он продолжит работу, когда прочитает ответ. Если агент остановлен, возобновите его во внешнем чате; приложение не запускает новый процесс.'
              : 'Этот пакет ведёт приложение: нажатие кнопки сразу записывает ответ и выполняет действие. «Отправить» открывает подтверждение стоимости перед списанием, «Сохранить в очередь» переносит пакет в очередь, «Принять» открывает приёмку. Поле ниже нужно только для «Вернуть с замечанием»: замечание сохраняется в пакете и передаётся агенту, когда вы нажмёте «Запустить доработку с агентом» в блоке «Подготовка плана». Текст запроса здесь не редактируется.'}
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
                'Опишите нужные изменения. Обязательно только для «Вернуть с замечанием». ' +
                (external
                  ? 'Замечание сохранится вместе с ответом для внешнего агента.'
                  : 'Замечание сохранится вместе с ответом. Агент автоматически не запускается. После возврата нажмите «Запустить доработку с агентом» в блоке «Подготовка плана».')
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
                  <b>{VERDICT_LABELS[verdict]?.label ?? verdict}.</b> {VERDICT_HINTS[verdict] ?? ''}
                </Typography>
              ))}
            </Box>
          ) : null}
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {options.map((verdict) => {
              const reason = ['send', 'retry'].includes(verdict) ? problem : null;
              return (
                <Button
                  title={reason ?? VERDICT_HINTS[verdict]}
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
                    ) : verdict === 'retry' ? (
                      <ReplayIcon />
                    ) : verdict === 'revise' ? (
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
