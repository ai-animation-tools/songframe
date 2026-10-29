/** Вопрос пакета и варианты ответа; ответ сразу выполняет приложение. */
import { useState, type ReactElement } from 'react';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import EditIcon from '@mui/icons-material/Edit';
import SendIcon from '@mui/icons-material/Send';
import SaveIcon from '@mui/icons-material/Save';
import MovieIcon from '@mui/icons-material/Movie';
import ReplayIcon from '@mui/icons-material/Replay';
import { Alert, Box, TextField, Typography } from '@mui/material';
import type { KeyframeNoteScope, PackageView } from '@shared/types';
import { BUSY_REASON, VERDICT_HINTS, VERDICT_LABELS } from '../constants';
import { useApp } from '../../../state';
import { aiActionProblem } from '@shared/ai-access';
import type { AiActionKind } from '@shared/ai-access';
import { LinkedText } from '../../../components/LinkedText';
import { ActionButton } from '../../../components/ActionButton';
import { KeyframeNoteScopeField } from './KeyframeNoteScopeField';

/** Пример относится к текущему согласованию и помогает описать конкретное изменение. */
const REVISION_EXAMPLES: Record<string, string> = {
  description_review: 'Например: герой должен выйти из дома, а не остаться у окна.',
  keyframes_review: 'Например: в первом опорном кадре сохранить одежду героя из предыдущего плана.',
  prompt_review: 'Например: камера медленно приближается к герою, без смены ракурса.',
  request_choice: 'Например: заменить последнюю опору и уточнить движение камеры перед отправкой.',
  image_request_choice: 'Например: уточнить позу героя и освещение в запросе изображения.'
};

/** Вопрос об одной опоре: ответы касаются только её, замечание уходит в следующее создание опоры. */
function frameHints(frame: string): Record<string, string> {
  return {
    approve: `Утверждает опору ${frame}: она станет референсом следующих опор, приложение спросит о следующем готовом кандидате.`,
    revise: `Снимает кандидата ${frame} и сохраняет замечание; опору создайте заново кнопкой «Создать ${frame}» в блоке «Подготовка плана».`
  };
}

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
  /** Для вопроса об опоре передаётся охват замечания: только эта опора или и следующие. */
  onDecide(verdict: string, noteScope?: KeyframeNoteScope): void;
}): ReactElement {
  const { aiAccess } = useApp();
  const problem = aiActionProblem(aiAccess, aiKind);
  const options = pending?.options ?? [];
  const frame = pending?.frame;
  // Отметка охвата относится к показанному вопросу: новый вопрос об опоре снова начинает с «и для следующих».
  const questionKey = `${frame ?? ''}\0${pending?.asked_at ?? ''}`;
  const [scopeDraft, setScopeDraft] = useState<{ key: string; scope: KeyframeNoteScope }>({ key: questionKey, scope: 'following' });
  const scope = scopeDraft.key === questionKey ? scopeDraft.scope : 'following';
  const hints = frame ? { ...VERDICT_HINTS, ...frameHints(frame) } : VERDICT_HINTS;
  const label = (verdict: string): string =>
    frame && verdict === 'approve' ? `Утвердить ${frame}` : frame && verdict === 'revise' ? `Доработать ${frame}` : (VERDICT_LABELS[verdict]?.label ?? verdict);
  return (
    <>
      {pending ? (
        <Alert severity="info" sx={{ mb: 2 }} icon={false}>
          {frame ? (
            <Typography variant="overline" color="text.secondary" display="block" sx={{ lineHeight: 1.6 }}>
              Опора {frame}
            </Typography>
          ) : null}
          <Typography fontWeight={600} gutterBottom>
            {pending.question}
          </Typography>
          {frame ? (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
              Кандидат {frame} показан в блоке «Опоры» выше (щелчок открывает его крупно). Опоры утверждаются по одной: «Утвердить {frame}» утверждает только
              её, «Доработать {frame}» снимает кандидата, а обязательное замечание получит агент при повторном создании опоры кнопкой «Создать {frame}» в блоке
              «Подготовка плана».
            </Typography>
          ) : (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
              Этот пакет ведёт приложение: нажатие кнопки сразу записывает ответ и выполняет действие. «Отправить» открывает подтверждение стоимости перед
              списанием, «Сохранить в очередь» переносит пакет в очередь, «Принять» открывает приёмку. Поле ниже нужно только для «Вернуть с замечанием»:
              замечание сохраняется в пакете и передаётся агенту, когда вы нажмёте «Запустить доработку с агентом» в блоке «Подготовка плана». Текст запроса
              здесь не редактируется.
            </Typography>
          )}
          {options.includes('revise') ? (
            <TextField
              size="small"
              fullWidth
              multiline
              minRows={3}
              maxRows={8}
              label={frame ? `Что исправить в опоре ${frame}` : 'Что нужно исправить'}
              placeholder={
                frame
                  ? 'Например: сохранить одежду героя из предыдущего плана, камера ниже, свет тёплый вечерний.'
                  : (REVISION_EXAMPLES[pending.stage] ?? 'Например: укажите, что изменить в показанных материалах и каким должен быть результат.')
              }
              helperText={
                frame
                  ? `Обязательно для «Доработать ${frame}». Замечание сохранится в списке замечаний к опорам и будет передано агенту при создании ${frame}.`
                  : 'Опишите нужные изменения. Обязательно только для «Вернуть с замечанием». Замечание сохранится вместе с ответом. Агент автоматически не запускается. После возврата нажмите «Запустить доработку с агентом» в блоке «Подготовка плана».'
              }
              value={note}
              onChange={(e) => setNote(e.target.value)}
              sx={{ mb: 1 }}
            />
          ) : null}
          {frame && options.includes('revise') ? (
            <Box sx={{ mb: 1 }}>
              <KeyframeNoteScopeField scope={scope} onChange={(next) => setScopeDraft({ key: questionKey, scope: next })} />
            </Box>
          ) : null}
          {options.length > 1 ? (
            <Box component="ul" sx={{ m: 0, mb: 1, pl: 2.5 }}>
              {options.map((verdict) => (
                <Typography key={verdict} component="li" variant="caption" color="text.secondary">
                  <b>{label(verdict)}.</b> <LinkedText text={hints[verdict] ?? ''} />
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
                      ? frame
                        ? `Опишите в поле выше, что исправить в опоре ${frame}.`
                        : 'Опишите в поле выше, что нужно исправить.'
                      : null);
              return (
                <ActionButton
                  key={verdict}
                  title={hints[verdict]}
                  disabledReason={disabledReason}
                  size="small"
                  variant={verdict === options[0] ? 'contained' : 'outlined'}
                  color={VERDICT_LABELS[verdict]?.color ?? 'inherit'}
                  disabled={!!reason || busy || (sendingBlocked && ['send', 'retry'].includes(verdict)) || (verdict === 'revise' && !note.trim())}
                  onClick={() => onDecide(verdict, frame && verdict === 'revise' ? scope : undefined)}
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
                  {label(verdict)}
                </ActionButton>
              );
            })}
          </Box>
        </Alert>
      ) : null}
    </>
  );
}
