import { productionTexts } from '@shared/texts/production';
/**
 * Работа агента в шагах пути: задание, предложение, следующее действие и доработка. Запрос видео
 * (следующий этап request) собирает приложение без агента: кнопка «Подготовить запрос» обычная.
 * Путь показывает панель в нескольких шагах, и каждая часть живёт в шаге своего этапа (parts):
 * задание и его предложение — в шаге этапа задания, доработка — в шаге этапа, который она переделает,
 * следующее действие — в текущем шаге. Предложение решается целиком в окне сравнения; на самом
 * шаге его текст не повторяется.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import EditNoteIcon from '@mui/icons-material/EditNote';
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined';
import VideoFileOutlinedIcon from '@mui/icons-material/VideoFileOutlined';
import type { ProductionPass, ProductionWorkflowStart } from '@shared/production-workflow';
import type { PackageView, PromptVariant } from '@shared/types';
import { DEFAULT_KEYFRAME_LIMIT, keyframeLimit, mediaProviderInfo } from '@shared/media-providers';
import { AgentButton } from '../../../components';
import { ActionButton } from '../../../components/ActionButton';
import { AgentJobCard } from '../../../components/AgentJobCard';
import type { ProductionWorkflow } from '../useProductionWorkflow';
import { ProductionProposalDialog } from './ProductionProposalDialog';
import { ReferencesMethodChoice, type AttemptMethod } from './ReferencesMethodChoice';
import { LinkedText } from '../../../components/LinkedText';
import { BUSY_REASON } from '../constants';

/** Подпись следующего прохода агента: кнопка называет шаг, а не «продолжить». */
const CONTINUE_LABELS: Partial<Record<ProductionPass, string>> = {
  prompt: productionTexts.productionWorkflowPanel.continuePrompt
};

/** Какие части панели показывает этот её экземпляр; без раскладки — все. */
export interface WorkflowPanelParts {
  /** Проблемы попытки и следующее действие агента: текущий шаг пути. */
  current: boolean;
  /** Карточка последнего задания и окно его предложения: шаг этапа задания. */
  job: boolean;
  /** Доработка с замечанием: шаг этапа, который она переделает (reviseStage). */
  revise: boolean;
  /** Ошибка запуска: шаг, откуда запускали, иначе шаг задания. */
  error: boolean;
}

const ALL_PARTS: WorkflowPanelParts = { current: true, job: true, revise: true, error: true };

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
  onWriteOwn,
  onOwnVideo,
  onBeforePrepare,
  descriptionReason,
  defaultMethod,
  parts = ALL_PARTS,
  onLaunch
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
  /** Принять предложение; у видеопромпта с переводом — с вариантом, выбранным к отправке. */
  onAcceptProposal(promptVariant?: PromptVariant): Promise<boolean>;
  onReviseProposal(note: string): Promise<boolean>;
  /**
   * Свой текст без агента: описание для плана без попытки (рядом с «Подготовить описание») или видеопромпт,
   * когда следующий этап попытки — промпт (рядом с его подготовкой агентом).
   */
  onWriteOwn?(): void;
  /** Своё готовое видео плана без описания, опор и промпта: рядом с подготовкой описания у плана без попытки. */
  onOwnVideo?(): void;
  /**
   * Проверка перед подготовкой описания агентом (сохранённые образы героев): вызывает proceed сразу или после ответа;
   * looks — выбранные герои с образами, если образов больше, чем примет модель.
   */
  onBeforePrepare?(proceed: (looks?: string[]) => void): void;
  /** Почему описание сейчас не начинается (идёт проверка перед ним); null — можно. */
  descriptionReason?: string | null;
  /** Способ последней попытки плана: с него начинается выбор способа новой попытки; нет — по опорам. */
  defaultMethod?: AttemptMethod;
  parts?: WorkflowPanelParts;
  /** Запуск агента из этого экземпляра: путь показывает ошибку запуска рядом с нажатой кнопкой. */
  onLaunch?(): void;
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
  // Способ новой попытки: по референсам без опор или по опорам; выбирается только до описания и только там, где Go его разрешает.
  const [methodChoice, setMethodChoice] = useState<AttemptMethod | null>(null);
  const method: AttemptMethod = view?.referencesAvailable ? (methodChoice ?? defaultMethod ?? 'keyframes') : 'keyframes';
  const byReferences = method === 'references';
  // Плану из опор видео не генерируется: предел провайдера видео к нему не относится. Одна опора — неподвижный
  // кадр с наездом сборки, больше — смены состояний.
  const limit = view?.staticShot ? DEFAULT_KEYFRAME_LIMIT : keyframeLimit(view?.videoProvider);
  useEffect(() => {
    if (reviseOpen) reviseArea.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [reviseOpen]);
  const errorAlert =
    workflow.error && parts.error ? (
      <Alert severity="error">
        <LinkedText text={workflow.error} />
      </Alert>
    ) : null;
  const start = async (action: ProductionWorkflowStart['action'], looks?: string[]): Promise<void> => {
    if (busy) return;
    if (action === 'revise' && !note.trim()) {
      setValidation(productionTexts.productionWorkflowPanel.noteRequired);
      return;
    }
    setValidation(null);
    setLastAction(action);
    onLaunch?.();
    const instructionText = action === 'continue' && promptNext ? instruction.trim() : '';
    await workflow.start(
      action,
      action === 'revise' ? note.trim() : instructionText || undefined,
      action === 'prepare' && !view?.singleFrame && !byReferences ? Math.min(keyframes, limit) : undefined,
      looks,
      action === 'prepare' && view?.referencesAvailable ? method : undefined
    );
  };
  const proposal = view?.proposal;
  const reviseStage = view?.reviseStage ?? undefined;
  // Кнопка просмотра есть только у законченного ответа: идущее задание и применённое предложение нечего решать.
  const reviewable = !!proposal && proposal.status !== 'running' && proposal.status !== 'applied';
  // Опора агента применяется сама; окно нужно, только если применить её нельзя.
  const quietFrames = proposal?.stage === 'frames' && proposal.status === 'ready' && !proposal.stale && !workflow.error;
  const canAct = !!view && !view.paid && !questionOpen && !view.job?.status.match(/running/) && !reviewable;
  const requestNext = view?.nextStage === 'request';
  const continueLabel = view?.nextStage ? CONTINUE_LABELS[view.nextStage] : undefined;
  const reason = busy ? BUSY_REASON : !packageDir ? view?.reasons.prepare : view?.reasons.continue;
  const primaryDisabled = busy || !(packageDir ? view?.canContinue : view?.canPrepare);
  return (
    <Stack spacing={1.5}>
      {parts.current && view?.problems.length ? (
        <Alert severity="warning">
          <LinkedText text={view.problems.join(' ')} />
        </Alert>
      ) : null}
      {parts.job && view?.job ? (
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
      {parts.job && reviewable && proposal && !quietFrames ? (
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
          // Исправления отказа: у новой попытки описание сразу готовится заново тем же выбором опор.
          fixRestarts={!packageDir}
          onFixScenario={async () => {
            if (!(await workflow.fixScenario())) return false;
            if (!packageDir) void start('prepare');
            return true;
          }}
        />
      ) : null}
      {parts.current && canAct && (!packageDir || continueLabel || requestNext) ? (
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
            <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
              {requestNext ? (
                <ActionButton
                  variant="contained"
                  startIcon={<ReceiptLongOutlinedIcon />}
                  disabled={primaryDisabled}
                  disabledReason={reason ?? productionTexts.productionWorkflowPanel.loadingReason}
                  title={productionTexts.productionWorkflowPanel.prepareRequestHint}
                  onClick={() => {
                    if (busy) return;
                    onLaunch?.();
                    void workflow.prepareRequest();
                  }}
                >
                  {productionTexts.productionWorkflowPanel.prepareRequest}
                </ActionButton>
              ) : (
                <AgentButton
                  variant="contained"
                  disabled={primaryDisabled}
                  disabledReason={reason ?? productionTexts.productionWorkflowPanel.loadingReason}
                  title={productionTexts.productionWorkflowPanel.continueHint}
                  onClick={() => void start('continue')}
                >
                  {continueLabel}
                </AgentButton>
              )}
              {onWriteOwn && promptNext ? (
                // Свой промпт не требует агента: доступен при той же готовности попытки, что и подготовка промпта.
                <ActionButton
                  startIcon={<EditNoteIcon />}
                  title={productionTexts.ownPromptDialog.writeOwnHint}
                  disabled={busy || !view?.canContinue}
                  disabledReason={busy ? BUSY_REASON : (view?.reasons.continue ?? productionTexts.productionWorkflowPanel.loadingReason)}
                  onClick={onWriteOwn}
                >
                  {productionTexts.ownDescriptionDialog.writeOwn}
                </ActionButton>
              ) : null}
            </Stack>
          ) : (
            <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
              {view?.referencesAvailable ? <ReferencesMethodChoice method={method} disabled={busy} onChange={setMethodChoice} /> : null}
              <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
                {byReferences ? null : (
                  <TextField
                    select
                    size="small"
                    sx={{ width: 120 }}
                    label={productionTexts.productionWorkflowPanel.keyframes}
                    // Речевой план ручной генерации делается по одной опоре: выбор заблокирован, причина — в подсказке.
                    value={view?.singleFrame ? 1 : Math.min(keyframes, limit)}
                    disabled={busy || !!view?.singleFrame}
                    title={
                      view?.singleFrame
                        ? productionTexts.productionWorkflowPanel.keyframesManual
                        : productionTexts.productionWorkflowPanel.keyframesHint({ limit })
                    }
                    onChange={(event) => setKeyframes(Number(event.target.value))}
                  >
                    {view?.singleFrame ? null : <MenuItem value={0}>{productionTexts.productionWorkflowPanel.keyframesAuto}</MenuItem>}
                    {Array.from({ length: limit }, (_, index) => index + 1).map((count) => (
                      <MenuItem key={count} value={count}>
                        {count}
                      </MenuItem>
                    ))}
                  </TextField>
                )}
                <AgentButton
                  variant="contained"
                  disabled={primaryDisabled || !!descriptionReason}
                  disabledReason={descriptionReason ?? reason ?? productionTexts.productionWorkflowPanel.loadingReason}
                  title={productionTexts.productionWorkflowPanel.prepareHint}
                  onClick={() => (onBeforePrepare ? onBeforePrepare((looks) => void start('prepare', looks)) : void start('prepare'))}
                >
                  {productionTexts.productionWorkflowPanel.prepare}
                </AgentButton>
                {onWriteOwn && !byReferences ? (
                  // Своё описание не требует агента: доступно при той же готовности плана, что и подготовка.
                  <ActionButton
                    startIcon={<EditNoteIcon />}
                    title={productionTexts.ownDescriptionDialog.writeOwnHint}
                    disabled={busy || !view?.canPrepare || !!descriptionReason}
                    disabledReason={busy ? BUSY_REASON : (descriptionReason ?? view?.reasons.prepare ?? productionTexts.productionWorkflowPanel.loadingReason)}
                    onClick={onWriteOwn}
                  >
                    {productionTexts.ownDescriptionDialog.writeOwn}
                  </ActionButton>
                ) : null}
                {onOwnVideo ? (
                  // Сервис и агент не участвуют: готовность плана проверяет Go при загрузке, отказ показывает окно.
                  <ActionButton
                    startIcon={<VideoFileOutlinedIcon />}
                    title={productionTexts.ownVideo.openHint}
                    disabled={busy || !!descriptionReason}
                    disabledReason={busy ? BUSY_REASON : (descriptionReason ?? null)}
                    onClick={onOwnVideo}
                  >
                    {productionTexts.ownVideo.open}
                  </ActionButton>
                ) : null}
              </Stack>
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
      {parts.revise && view?.canRevise && !(promptNext && decision?.verdict !== 'revise') && !reviewable && !questionOpen ? (
        reviseOpen || savedNote ? (
          <Stack spacing={1} ref={reviseArea}>
            <TextField
              label={
                savedNote
                  ? productionTexts.productionWorkflowPanel.savedNote
                  : reviseStage
                    ? reviseStage === 'description' && view?.generationMethod === 'references'
                      ? productionTexts.productionWorkflowPanel.noteForReferences
                      : productionTexts.productionWorkflowPanel.noteFor[reviseStage]
                    : productionTexts.productionWorkflowPanel.note
              }
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
            {reviseStage ? productionTexts.productionWorkflowPanel.reviseOpenFor[reviseStage] : productionTexts.productionWorkflowPanel.reviseOpen}
          </Button>
        )
      ) : null}
      {errorAlert}
    </Stack>
  );
}
