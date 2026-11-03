import { productionTexts } from '@shared/texts/production';
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
const REVISION_EXAMPLES: Record<string, string> = productionTexts.revisionExamples;

/** Вопрос об одной опоре: ответы касаются только её, замечание уходит в следующее создание опоры. */
function frameHints(frame: string): Record<string, string> {
  return {
    approve: productionTexts.packageDecision.approveHint({ frame }),
    revise: productionTexts.packageDecision.reviseHint({ frame })
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
    frame && verdict === 'approve'
      ? productionTexts.packageDecision.approve({ frame })
      : frame && verdict === 'revise'
        ? productionTexts.packageDecision.revise({ frame })
        : (VERDICT_LABELS[verdict]?.label ?? verdict);
  return (
    <>
      {pending ? (
        <Alert severity="info" sx={{ mb: 2 }} icon={false}>
          {frame ? (
            <Typography variant="overline" color="text.secondary" display="block" sx={{ lineHeight: 1.6 }}>
              {productionTexts.packageDecision.frame({ frame })}
            </Typography>
          ) : null}
          <Typography fontWeight={600} gutterBottom>
            {pending.question}
          </Typography>
          {frame ? (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
              {productionTexts.packageDecision.candidateHint({ frame })}
            </Typography>
          ) : (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
              {productionTexts.packageDecision.workflowHint}
            </Typography>
          )}
          {options.includes('revise') ? (
            <TextField
              size="small"
              fullWidth
              multiline
              minRows={3}
              maxRows={8}
              label={frame ? productionTexts.packageDecision.frameNote({ frame }) : productionTexts.packageDecision.note}
              placeholder={frame ? productionTexts.packageDecision.frameExample : (REVISION_EXAMPLES[pending.stage] ?? productionTexts.packageDecision.example)}
              helperText={frame ? productionTexts.packageDecision.frameNoteHint({ frame }) : productionTexts.packageDecision.noteHint}
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
                    ? productionTexts.packageDecision.submissionUnknown
                    : verdict === 'revise' && !note.trim()
                      ? frame
                        ? productionTexts.packageDecision.frameNoteRequired({ frame })
                        : productionTexts.packageDecision.noteRequired
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
