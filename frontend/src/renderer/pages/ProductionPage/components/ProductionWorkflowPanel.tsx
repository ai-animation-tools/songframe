import { productionTexts } from '@shared/texts/production';
/** Предметные действия работают только с выбранным пакетом; агент возвращает проверяемое предложение. */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Paper, Stack, TextField, Typography } from '@mui/material';
import type { ProductionWorkflowStart } from '@shared/production-workflow';
import type { PackageView } from '@shared/types';
import { mediaProviderInfo } from '@shared/media-providers';
import { AgentButton } from '../../../components';
import { AgentJobCard } from '../../../components/AgentJobCard';
import { useProductionWorkflow } from '../useProductionWorkflow';
import { ProductionProposalDialog } from './ProductionProposalDialog';
import { ProductionFrameImport } from './ProductionFrameImport';
import { ProductionFrameGenerationButton } from './ProductionFrameGenerationButton';
import { LinkedText } from '../../../components/LinkedText';
import { BUSY_REASON } from '../constants';
import { DerivedShotNotice } from './DerivedShotNotice';

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
  // Замечание к опоре уже в списке замечаний и уходит в создание опоры: в поле доработки агентом его не подставляем.
  const savedNote = decision?.verdict === 'revise' && decision.stage !== 'keyframes_review' ? (decision.note ?? '') : '';
  // Возврат уже содержит замечание: для явного запуска агенту не нужно вводить его второй раз.
  const [noteDraft, setNoteDraft] = useState<{ token?: string; text: string }>({ token: decisionToken, text: savedNote });
  const note = noteDraft.token === decisionToken ? noteDraft.text : savedNote;
  const setNote = (text: string): void => setNoteDraft({ token: decisionToken, text });
  const [lastAction, setLastAction] = useState<ProductionWorkflowStart['action'] | 'frames' | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const view = workflow.view;
  const busy = workflow.busy || packageBusy;
  const framesStage = view?.proposal?.stage === 'frames' || lastAction === 'frames';
  const reportBusy = useRef(onBusyChange);
  reportBusy.current = onBusyChange;
  useEffect(() => onBusyChange(workflow.busy), [workflow.busy, onBusyChange]);
  // После ухода с пакета его завершение больше не опрашивается этой панелью.
  useEffect(() => () => reportBusy.current(false), []);
  // Ошибка ставится у ряда кнопок, вызвавших действие: при закреплённой колонке начало панели может быть вне вида.
  const errorAlert = workflow.error ? (
    <Alert severity="error">
      <LinkedText text={workflow.error} />
    </Alert>
  ) : null;
  const reviseError = lastAction === 'revise' && view?.canRevise;
  const start = async (action: ProductionWorkflowStart['action']): Promise<void> => {
    if (busy) return;
    if (action === 'revise' && !note.trim()) {
      setValidation(productionTexts.productionWorkflowPanel.noteRequired);
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
          {productionTexts.productionWorkflowPanel.title({ shot })}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {packageDir ? productionTexts.productionWorkflowPanel.package({ packageDir }) : productionTexts.productionWorkflowPanel.newPreparation}{' '}
          {view?.paid ? productionTexts.productionWorkflowPanel.sent : productionTexts.productionWorkflowPanel.description}
        </Typography>
        {view?.derivedFrom ? <DerivedShotNotice source={view.derivedFrom} /> : null}
        {view?.problems.length ? (
          <Alert severity="warning">
            <LinkedText text={view.problems.join(' ')} />
          </Alert>
        ) : null}
        {view?.canRevise ? (
          <Stack spacing={1}>
            <Alert severity="info">{productionTexts.productionWorkflowPanel.revisionHint({ savedNote })}</Alert>
            <TextField
              label={savedNote ? productionTexts.productionWorkflowPanel.savedNote : productionTexts.productionWorkflowPanel.note}
              size="small"
              multiline
              fullWidth
              minRows={3}
              maxRows={8}
              helperText={productionTexts.productionWorkflowPanel.noteHint}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            {validation && <Alert severity="warning">{validation}</Alert>}
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <AgentButton
                disabled={busy || !note.trim()}
                disabledReason={busy ? BUSY_REASON : productionTexts.productionWorkflowPanel.noteReason}
                onClick={() => void start('revise')}
              >
                {productionTexts.productionWorkflowPanel.revise}
              </AgentButton>
            </Stack>
            {reviseError ? errorAlert : null}
          </Stack>
        ) : null}
        {view?.job ? (
          <AgentJobCard
            compact
            job={view.job}
            retryKind={framesStage ? 'image' : 'agent'}
            // Повтор опор выполняет программа-исполнитель провайдера изображений проекта, а не выбранный текстовый агент.
            retryProvider={framesStage ? (mediaProviderInfo(view.imageProvider, 'image')?.executor ?? view.job.provider) : undefined}
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
            videoProvider={view.videoProvider ?? null}
            busy={busy}
            onApply={workflow.apply}
            onDiscard={workflow.discard}
          />
        ) : null}
        {packageDir && view?.framePrompts.length ? (
          <ProductionFrameImport
            key={`${packageDir}:${decisionToken ?? ''}`}
            frames={view.framePrompts.filter((frame) => !view.approvedFrameIds.includes(frame.id))}
            busy={busy || !view.canGenerateFrames}
            busyReason={busy ? BUSY_REASON : (view.reasons.frames ?? productionTexts.productionWorkflowPanel.descriptionRequired)}
            onImport={workflow.importFrames}
          />
        ) : null}
        {view?.paid ? null : (
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <AgentButton
              disabled={busy || !view?.canPrepare}
              disabledReason={busy ? BUSY_REASON : (view?.reasons.prepare ?? productionTexts.productionWorkflowPanel.loadingReason)}
              title={productionTexts.productionWorkflowPanel.prepareHint}
              onClick={() => void start('prepare')}
            >
              {productionTexts.productionWorkflowPanel.prepare}
            </AgentButton>
            <AgentButton
              disabled={busy || !view?.canContinue}
              disabledReason={busy ? BUSY_REASON : (view?.reasons.continue ?? productionTexts.productionWorkflowPanel.loadingReason)}
              title={productionTexts.productionWorkflowPanel.continueHint}
              onClick={() => void start('continue')}
            >
              {productionTexts.productionWorkflowPanel.continue}
            </AgentButton>
            {view ? (
              <ProductionFrameGenerationButton
                provider={view.imageProvider}
                disabled={busy || !view.canGenerateFrames}
                disabledReason={busy ? BUSY_REASON : view.reasons.frames}
                frame={view.nextFrame}
                title={
                  view.nextFrame
                    ? productionTexts.productionWorkflowPanel.frameHint({ nextFrame: view.nextFrame })
                    : productionTexts.productionWorkflowPanel.createHint
                }
                onGenerate={() => {
                  setLastAction('frames');
                  void workflow.generateFrames();
                }}
              />
            ) : null}
          </Stack>
        )}
        {reviseError ? null : errorAlert}
      </Stack>
    </Paper>
  );
}
