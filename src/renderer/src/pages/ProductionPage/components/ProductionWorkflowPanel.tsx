/** Предметные действия работают только с выбранным пакетом; агент возвращает проверяемое предложение. */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Box, Paper, Stack, TextField, Typography } from '@mui/material';
import type { ProductionWorkflowStart } from '@shared/production-workflow';
import type { PackageView } from '@shared/types';
import { AgentButton } from '../../../components';
import { AgentJobCard } from '../../../components/AgentJobCard';
import { useProductionWorkflow } from '../useProductionWorkflow';
import { ProductionProposalDialog } from './ProductionProposalDialog';
import { ProductionFrameImport } from './ProductionFrameImport';
import { ProductionFrameGenerationButton } from './ProductionFrameGenerationButton';

export function ProductionWorkflowPanel({
  project,
  shot,
  packageDir,
  decisionToken,
  decision,
  packageBusy,
  onBusyChange,
  onApplied
}: {
  project: string;
  shot: string;
  packageDir: string | undefined;
  decisionToken?: string;
  decision?: PackageView['decision'];
  packageBusy: boolean;
  onBusyChange(busy: boolean): void;
  onApplied(packageDir: string | null): Promise<void>;
}): ReactElement {
  const workflow = useProductionWorkflow(project, shot, packageDir, onApplied);
  const savedNote = decision?.verdict === 'revise' ? (decision.note ?? '') : '';
  // Возврат уже содержит замечание: для явного запуска агенту не нужно вводить его второй раз.
  const [noteDraft, setNoteDraft] = useState<{ token?: string; text: string }>({ token: decisionToken, text: savedNote });
  const note = noteDraft.token === decisionToken ? noteDraft.text : savedNote;
  const setNote = (text: string): void => setNoteDraft({ token: decisionToken, text });
  const [lastAction, setLastAction] = useState<ProductionWorkflowStart['action'] | 'frames' | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const view = workflow.view;
  const busy = workflow.busy || packageBusy;
  const reportBusy = useRef(onBusyChange);
  reportBusy.current = onBusyChange;
  useEffect(() => onBusyChange(workflow.busy), [workflow.busy, onBusyChange]);
  // После ухода с пакета его завершение больше не опрашивается этой панелью.
  useEffect(() => () => reportBusy.current(false), []);
  const start = async (action: ProductionWorkflowStart['action']): Promise<void> => {
    if (busy) return;
    if (action === 'revise' && !note.trim()) {
      setValidation('Напишите, что агенту нужно исправить.');
      return;
    }
    setValidation(null);
    setLastAction(action);
    await workflow.start(action, action === 'revise' ? note.trim() : undefined);
  };
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="subtitle1" fontWeight={600}>
          Подготовка плана {shot}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {packageDir ? `Выбран пакет: ${packageDir}` : 'Новая подготовка: папка пакета появится после применения описания.'}{' '}
          {view?.paid
            ? 'Запрос этой попытки уже отправлен: решения о результате принимаются в карточке пакета ниже. Возврат с замечанием создаст новый пакет для доработки.'
            : 'Описание, опоры, видеопромпт и запрос согласуются по отдельности. Отправка в Kling подтверждается отдельно.'}
        </Typography>
        {workflow.error && <Alert severity="error">{workflow.error}</Alert>}
        {view?.problems.length ? <Alert severity="warning">{view.problems.join(' ')}</Alert> : null}
        {view?.canRevise ? (
          <Stack spacing={1}>
            <Alert severity="info">
              {savedNote ? 'Замечание из возврата подставлено ниже. ' : ''}Агент автоматически не запускается. Проверьте замечание и нажмите «Запустить
              доработку с агентом». После завершения появится предложение для просмотра и отдельного применения.
            </Alert>
            <TextField
              label={savedNote ? 'Сохранённое замечание для доработки' : 'Что исправить в текущем этапе'}
              size="small"
              multiline
              fullWidth
              minRows={3}
              maxRows={8}
              helperText="Можно уточнить текст перед запуском. Генерация изображения или видео согласуется отдельно."
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            {validation && <Alert severity="warning">{validation}</Alert>}
            <Box>
              <AgentButton disabled={busy || !note.trim()} onClick={() => void start('revise')}>
                Запустить доработку с агентом
              </AgentButton>
            </Box>
          </Stack>
        ) : null}
        {view?.job ? (
          <AgentJobCard
            compact
            job={view.job}
            retryKind={view.proposal?.stage === 'frames' || lastAction === 'frames' ? 'image' : 'agent'}
            retryProvider={view.proposal?.stage === 'frames' || lastAction === 'frames' ? 'codex' : undefined}
            onCancel={workflow.cancel}
            onRetry={() => {
              const action =
                lastAction ?? (view.proposal?.stage === 'frames' ? 'frames' : view.canPrepare ? 'prepare' : view.canContinue ? 'continue' : 'revise');
              if (action === 'frames') {
                if (!busy && view.canGenerateFrames) void workflow.generateFrames();
              } else void start(action);
            }}
          />
        ) : null}
        {view?.proposal ? (
          <ProductionProposalDialog
            key={view.proposal.id}
            proposal={view.proposal}
            error={workflow.error}
            provider={view.job?.provider ?? null}
            busy={busy}
            onApply={workflow.apply}
            onDiscard={workflow.discard}
          />
        ) : null}
        {packageDir && view?.framePrompts.length ? (
          <ProductionFrameImport
            key={`${packageDir}:${decisionToken ?? ''}`}
            frames={view.framePrompts}
            busy={busy || !view.canGenerateFrames}
            onImport={workflow.importFrames}
          />
        ) : null}
        {view?.paid ? null : (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            <AgentButton disabled={busy || !view?.canPrepare} onClick={() => void start('prepare')}>
              Подготовить описание
            </AgentButton>
            <AgentButton disabled={busy || !view?.canContinue} onClick={() => void start('continue')}>
              Продолжить подготовку
            </AgentButton>
            {view ? (
              <ProductionFrameGenerationButton
                provider={view.imageProvider}
                disabled={busy || !view.canGenerateFrames}
                onGenerate={() => {
                  setLastAction('frames');
                  void workflow.generateFrames();
                }}
              />
            ) : null}
          </Box>
        )}
        {view && !view.paid ? (
          <Stack spacing={0.25}>
            {(
              [
                ['Подготовить описание', view.canPrepare ? null : view.reasons.prepare, 'начинает новый пакет с описания'],
                ['Продолжить подготовку', view.canContinue ? null : view.reasons.continue, 'готовит следующий этап: видеопромпт, затем запрос'],
                ['Создать опоры', view.canGenerateFrames ? null : view.reasons.frames, 'генерирует кандидатов опор по принятому описанию']
              ] as const
            ).map(([label, reason, purpose]) => (
              <Typography key={label} variant="caption" color={reason ? 'text.secondary' : 'success.main'}>
                «{label}» {purpose}. {reason ? `Недоступно: ${reason}.` : 'Доступно.'}
              </Typography>
            ))}
          </Stack>
        ) : null}
      </Stack>
    </Paper>
  );
}
