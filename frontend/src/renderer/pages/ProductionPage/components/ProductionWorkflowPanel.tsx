import { productionTexts } from '@shared/texts/production';
/**
 * Работа агента внутри текущего шага пути: задание, предложение, следующее действие и доработка.
 * Предложение решается целиком в окне сравнения; на самом шаге его текст не повторяется.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import EditNoteIcon from '@mui/icons-material/EditNote';
import type { ProductionPass, ProductionWorkflowStart } from '@shared/production-workflow';
import type { PackageView } from '@shared/types';
import { keyframeLimit, mediaProviderInfo } from '@shared/media-providers';
import { AgentButton } from '../../../components';
import { ActionButton } from '../../../components/ActionButton';
import { AgentJobCard } from '../../../components/AgentJobCard';
import type { ProductionWorkflow } from '../useProductionWorkflow';
import { ProductionProposalDialog } from './ProductionProposalDialog';
import { LinkedText } from '../../../components/LinkedText';
import { BUSY_REASON } from '../constants';

/** Подпись следующего прохода агента: кнопка называет шаг, а не «продолжить». */
const CONTINUE_LABELS: Partial<Record<ProductionPass, string>> = {
  prompt: productionTexts.productionWorkflowPanel.continuePrompt,
  request: productionTexts.productionWorkflowPanel.continueRequest
};

export function ProductionWorkflowPanel({
  workflow,
  packageDir,
  decisionToken,
  decision,
  packageBusy,
  questionOpen = false,
  reviseOpen,
  onReviseOpen,
  onAcceptProposal,
  onReviseProposal,
  onWriteOwn
}: {
  workflow: ProductionWorkflow;
  packageDir: string | undefined;
  decisionToken?: string;
  decision?: PackageView['decision'];
  packageBusy: boolean;
  /** На шаге открыт вопрос попытки: действия агента ждут ответа и не показываются. */
  questionOpen?: boolean;
  reviseOpen: boolean;
  onReviseOpen(open: boolean): void;
  onAcceptProposal(): Promise<boolean>;
  onReviseProposal(note: string): Promise<boolean>;
  /** Своё описание без агента для плана без попытки; кнопка стоит рядом с «Подготовить описание». */
  onWriteOwn?(): void;
}): ReactElement {
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
  const reviseArea = useRef<HTMLDivElement>(null);
  // Указания перед видеопромптом необязательны и не записываются в попытку: они идут в задание агента.
  const promptNext = view?.nextStage === 'prompt';
  const [instructionOpen, setInstructionOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  // Число опор выбирается перед подготовкой описания; 0 — «авто». Речевой план ручной генерации — всегда одна опора.
  const [keyframes, setKeyframes] = useState(0);
  const limit = keyframeLimit(view?.videoProvider);
  useEffect(() => {
    if (reviseOpen) reviseArea.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [reviseOpen]);
  const errorAlert = workflow.error ? (
    <Alert severity="error">
      <LinkedText text={workflow.error} />
    </Alert>
  ) : null;
  const start = async (action: ProductionWorkflowStart['action']): Promise<void> => {
    if (busy) return;
    if (action === 'revise' && !note.trim()) {
      setValidation(productionTexts.productionWorkflowPanel.noteRequired);
      return;
    }
    setValidation(null);
    setLastAction(action);
    const instructionText = action === 'continue' && promptNext ? instruction.trim() : '';
    await workflow.start(
      action,
      action === 'revise' ? note.trim() : instructionText || undefined,
      action === 'prepare' && !view?.manual ? Math.min(keyframes, limit) : undefined
    );
  };
  const proposal = view?.proposal;
  // Кнопка просмотра есть только у законченного ответа: идущее задание и применённое предложение нечего решать.
  const reviewable = !!proposal && proposal.status !== 'running' && proposal.status !== 'applied';
  // Опора агента применяется сама; окно нужно, только если применить её нельзя.
  const quietFrames = proposal?.stage === 'frames' && proposal.status === 'ready' && !proposal.stale && !workflow.error;
  const canAct = !!view && !view.paid && !questionOpen && !view.job?.status.match(/running/) && !reviewable;
  const continueLabel = view?.nextStage ? CONTINUE_LABELS[view.nextStage] : undefined;
  const reason = busy ? BUSY_REASON : !packageDir ? view?.reasons.prepare : view?.reasons.continue;
  const primaryDisabled = busy || !(packageDir ? view?.canContinue : view?.canPrepare);
  return (
    <Stack spacing={1.5}>
      {view?.problems.length ? (
        <Alert severity="warning">
          <LinkedText text={view.problems.join(' ')} />
        </Alert>
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
      {reviewable && proposal && !quietFrames ? (
        <ProductionProposalDialog
          key={proposal.id}
          proposal={proposal}
          error={workflow.error}
          provider={view?.job?.provider ?? null}
          videoProvider={view?.videoProvider ?? null}
          promptMaxChars={view?.promptMaxChars}
          busy={busy}
          onApply={onAcceptProposal}
          onRevise={onReviseProposal}
          onDiscard={workflow.discard}
        />
      ) : null}
      {canAct && (!packageDir || continueLabel) ? (
        <Stack spacing={0.5} sx={{ alignItems: 'flex-start' }}>
          {packageDir && promptNext && instructionOpen ? (
            <TextField
              sx={{ alignSelf: 'stretch' }}
              label={productionTexts.productionWorkflowPanel.instruction}
              multiline
              fullWidth
              minRows={2}
              maxRows={8}
              autoFocus
              disabled={busy}
              helperText={productionTexts.productionWorkflowPanel.instructionHint}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
            />
          ) : null}
          {packageDir ? (
            <AgentButton
              variant="contained"
              disabled={primaryDisabled}
              disabledReason={reason ?? productionTexts.productionWorkflowPanel.loadingReason}
              title={productionTexts.productionWorkflowPanel.continueHint}
              onClick={() => void start('continue')}
            >
              {continueLabel}
            </AgentButton>
          ) : (
            <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <TextField
                select
                size="small"
                sx={{ width: 120 }}
                label={productionTexts.productionWorkflowPanel.keyframes}
                // Речевой план ручной генерации делается по одной опоре: выбор заблокирован, причина — в подсказке.
                value={view?.manual ? 1 : Math.min(keyframes, limit)}
                disabled={busy || !!view?.manual}
                title={
                  view?.manual ? productionTexts.productionWorkflowPanel.keyframesManual : productionTexts.productionWorkflowPanel.keyframesHint({ limit })
                }
                onChange={(event) => setKeyframes(Number(event.target.value))}
              >
                {view?.manual ? null : <MenuItem value={0}>{productionTexts.productionWorkflowPanel.keyframesAuto}</MenuItem>}
                {Array.from({ length: limit }, (_, index) => index + 1).map((count) => (
                  <MenuItem key={count} value={count}>
                    {count}
                  </MenuItem>
                ))}
              </TextField>
              <AgentButton
                variant="contained"
                disabled={primaryDisabled}
                disabledReason={reason ?? productionTexts.productionWorkflowPanel.loadingReason}
                title={productionTexts.productionWorkflowPanel.prepareHint}
                onClick={() => void start('prepare')}
              >
                {productionTexts.productionWorkflowPanel.prepare}
              </AgentButton>
              {onWriteOwn ? (
                // Своё описание не требует агента: доступно при той же готовности плана, что и подготовка.
                <ActionButton
                  startIcon={<EditNoteIcon />}
                  title={productionTexts.ownDescriptionDialog.writeOwnHint}
                  disabled={busy || !view?.canPrepare}
                  disabledReason={busy ? BUSY_REASON : (view?.reasons.prepare ?? productionTexts.productionWorkflowPanel.loadingReason)}
                  onClick={onWriteOwn}
                >
                  {productionTexts.ownDescriptionDialog.writeOwn}
                </ActionButton>
              ) : null}
            </Stack>
          )}
          {packageDir && promptNext && !instructionOpen ? (
            <Button size="small" startIcon={<EditIcon />} disabled={busy} onClick={() => setInstructionOpen(true)}>
              {productionTexts.productionWorkflowPanel.instructionOpen}
            </Button>
          ) : null}
          {primaryDisabled && !busy && reason && !view?.problems.includes(reason) ? (
            <Typography variant="caption" color="text.secondary">
              <LinkedText text={reason} />
            </Typography>
          ) : null}
        </Stack>
      ) : null}
      {/* Пока видеопромпта нет и ничего не возвращено на доработку, дорабатывать нечего: доработка повторила бы
          «Подготовить видеопромпт» с указаниями. */}
      {view?.canRevise && !(promptNext && decision?.verdict !== 'revise') && !reviewable && !questionOpen ? (
        reviseOpen || savedNote ? (
          <Stack spacing={1} ref={reviseArea}>
            <TextField
              label={savedNote ? productionTexts.productionWorkflowPanel.savedNote : productionTexts.productionWorkflowPanel.note}
              multiline
              fullWidth
              minRows={3}
              maxRows={8}
              autoFocus={!savedNote}
              helperText={productionTexts.productionWorkflowPanel.noteHint}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            {validation ? <Alert severity="warning">{validation}</Alert> : null}
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <AgentButton
                disabled={busy || !note.trim()}
                disabledReason={busy ? BUSY_REASON : productionTexts.productionWorkflowPanel.noteReason}
                onClick={() => void start('revise')}
              >
                {productionTexts.productionWorkflowPanel.revise}
              </AgentButton>
            </Stack>
          </Stack>
        ) : (
          <Button size="small" startIcon={<EditIcon />} sx={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => onReviseOpen(true)}>
            {productionTexts.productionWorkflowPanel.reviseOpen}
          </Button>
        )
      ) : null}
      {errorAlert}
    </Stack>
  );
}
