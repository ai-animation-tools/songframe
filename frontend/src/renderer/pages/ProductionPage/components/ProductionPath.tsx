import { productionTexts } from '@shared/texts/production';
/**
 * Вертикальный путь плана: открыт текущий шаг со всем, что нужно сейчас; пройденные шаги свёрнуты в
 * итог и открываются для чтения, будущие приглушены. Путь только компонует блоки: состояние и
 * решения остаются у useProductionPage и useProductionWorkflow, файлы и согласования — у Go.
 */
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Box, LinearProgress, Paper, Stack, Step, StepButton, StepContent, StepLabel, Stepper, Typography } from '@mui/material';
import { normalizeMediaProvider } from '@shared/media-providers';
import type { KeyframeNoteScope, ManualVideo, PackageView, ShotProduction } from '@shared/types';
import { BUSY_REASON } from '../constants';
import { manualGeneration, planPath, questionStep, REQUEST_IN_FLIGHT, type PlanPath, type PlanStepKey } from '../planPath';
import { useProductionWorkflow, type ProductionWorkflow } from '../useProductionWorkflow';
import { AcceptedAsset } from './AcceptedAsset';
import { useApp } from '../../../state';
import { FrameActions, type FrameInstruction } from './FrameActions';
import { ManualGeneration, ManualGenerationInfo } from './ManualGeneration';
import { PackageDecision } from './PackageDecision';
import { PackageKeyframes } from './PackageKeyframes';
import { PackageNotices } from './PackageNotices';
import { PackageRequest } from './PackageRequest';
import { PackageResult } from './PackageResult';
import { PackageResume } from './PackageResume';
import { PackageTextSection } from './PackageTextSection';
import { PromptLimitAlert } from './PromptLimitAlert';
import { PromptReopenDialog } from './PromptReopenDialog';
import { ActionButton } from '../../../components/ActionButton';
import { promptOverLimit } from '../promptLimit';
import ReplayIcon from '@mui/icons-material/Replay';
import { ProductionSpeechPanel, SpeechSlice } from './ProductionSpeechPanel';
import { ProductionWorkflowPanel } from './ProductionWorkflowPanel';

/** Вопросы результата на случай, когда прежний ответ уже записан: решение доступно всегда. */
function resultQuestion(pkg: PackageView): NonNullable<PackageView['pendingDecision']> | null {
  if (pkg.stage !== 'downloaded' && pkg.stage !== 'edit_review') return null;
  return {
    stage: pkg.stage,
    question: productionTexts.planPath.resultQuestion,
    options: pkg.stage === 'downloaded' ? ['accept', 'retry', 'review', 'revise'] : ['accept', 'revise']
  };
}

/** Этапы, на которых Go принимает возврат утверждённого видеопромпта (shot_workflow reopen-prompt). */
const PROMPT_REOPEN_STAGES = ['prompt_review', 'request_choice'];
/** Где кнопка возврата видна: в очереди (ready) она недоступна с объяснением, после отправки не нужна. */
const PROMPT_REOPEN_SHOWN = [...PROMPT_REOPEN_STAGES, 'ready'];

export function ProductionPath({
  project,
  shot,
  pkg,
  packageSelection,
  newAttempt,
  note,
  setNote,
  busy,
  busyReason = BUSY_REASON,
  providers,
  speechBusy,
  onBusyChange,
  onApplied,
  onPath,
  answerApplied,
  onDecide,
  onSubmit,
  onAccept,
  onRegenerate,
  onContactSheet,
  onResume,
  onAttachResult,
  onAttachManual,
  onNotCreated,
  onSelectImage,
  onReopenFrame,
  onReopenPrompt,
  onKeepForScene,
  onSetKeyframeNote,
  onSpeechPrepared
}: {
  project: string;
  shot: ShotProduction;
  pkg: PackageView | null;
  /** Выбор попытки: ключ панели, смена сбрасывает её черновики. */
  packageSelection: string;
  /** Пользователь сам начал новую попытку: принятый план не показывается пройденным. */
  newAttempt: boolean;
  note: string;
  setNote(value: string): void;
  busy: boolean;
  busyReason?: string;
  /** Найдена ли программа каждого платного провайдера (по id). */
  providers: Record<string, boolean>;
  speechBusy: boolean;
  onBusyChange(busy: boolean): void;
  onApplied(packageDir: string | null): Promise<void>;
  /** Шапка плана показывает фразу «Сейчас»: путь сообщает её наверх. */
  onPath(path: PlanPath): void;
  /** Ответ на вопрос, который задало применение предложения: токен берётся из свежего снимка попытки. */
  answerApplied(packageDir: string, verdict: 'approve' | 'revise', note: string): Promise<void>;
  /** after выполняется после записи ответа: доработка запускает агента той же кнопкой. */
  onDecide(verdict: string, noteScope?: KeyframeNoteScope, after?: () => Promise<void>): void;
  onSubmit(): void;
  onAccept(): void;
  onRegenerate(): void;
  onContactSheet(): void;
  onResume(): void;
  onAttachResult(files: string[]): void;
  /** Видео, созданное вне приложения по пакету ручной генерации. */
  onAttachManual(video: ManualVideo): void;
  onNotCreated(): void;
  onSelectImage(index: number): void;
  onReopenFrame(frame: string, note: string, scope: KeyframeNoteScope): void;
  /** Вернуть утверждённый видеопромпт на доработку с замечанием, пока запрос не отправлен. */
  onReopenPrompt(note: string): void;
  onKeepForScene(): void;
  onSetKeyframeNote(id: number, active: boolean): void;
  onSpeechPrepared(): Promise<void>;
}): ReactElement {
  const packageDir = pkg?.dir;
  const workflow: ProductionWorkflow = useProductionWorkflow(project, shot.id, packageDir, onApplied);
  const view = workflow.view;
  const { notify, describeError } = useApp();
  // Занятость читается у Go: задание получения переживает уход со страницы, а локальное состояние — нет.
  const receiving = !!view?.busy;
  const path = planPath(shot, pkg, view, newAttempt, receiving);
  const manual = manualGeneration(pkg, view);
  // Решения ждут и операции страницы, и задания агента; панель учитывает задание сама.
  const blocked = busy || workflow.busy;
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [reviseOpen, setReviseOpen] = useState(false);
  const [reopeningPrompt, setReopeningPrompt] = useState(false);
  // Промпт на согласовании длиннее предела провайдера: утвердить нельзя, только вернуть агенту.
  const overLimit = pkg?.prompt && !pkg.prompt.approved ? promptOverLimit(pkg.prompt.text, view?.promptMaxChars) : null;
  const reportBusy = useRef(onBusyChange);
  reportBusy.current = onBusyChange;
  useEffect(() => reportBusy.current(workflow.busy), [workflow.busy]);
  // После ухода с попытки её завершение больше не опрашивается этой панелью.
  useEffect(() => () => reportBusy.current(false), []);
  const reportPath = useRef(onPath);
  reportPath.current = onPath;
  const pathKey = `${path.now}\0${path.tone}\0${path.current}`;
  useEffect(() => reportPath.current(path), [pathKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const stageOfProposal = view?.proposal?.stage;
  const acceptProposal = (): Promise<boolean> =>
    workflow.apply(async (applied) => {
      // Запрос после принятия ждёт отдельного решения об отправке; остальные шаги утверждаются сразу.
      if (applied.packageDir && (stageOfProposal === 'description' || stageOfProposal === 'prompt')) await answerApplied(applied.packageDir, 'approve', '');
    });
  const reviseProposal = (text: string): Promise<boolean> =>
    workflow.apply(async (applied) => {
      if (!applied.packageDir) return;
      await answerApplied(applied.packageDir, 'revise', text);
      await window.api.productionWorkflow.start({ project, shot: shot.id, packageDir: applied.packageDir, action: 'revise', note: text });
    });

  /** Указание записывается замечанием к опоре до запуска: так агент получит его обычным путём. */
  const createFrame = async (frame: string, instruction?: FrameInstruction): Promise<void> => {
    if (instruction && pkg) {
      try {
        await window.api.production.addKeyframeNote(project, pkg.dir, frame, instruction.note, instruction.scope);
        await onApplied(pkg.dir);
      } catch (error) {
        notify(describeError(error), 'error');
        return;
      }
    }
    await workflow.generateFrames();
  };

  const panel = (questionOpen: boolean): ReactNode => (
    <ProductionWorkflowPanel
      key={`${project}:${shot.id}:${packageSelection}`}
      workflow={workflow}
      packageDir={packageDir}
      decisionToken={pkg?.decisionToken}
      decision={pkg?.decision}
      packageBusy={busy}
      questionOpen={questionOpen}
      reviseOpen={reviseOpen}
      onReviseOpen={setReviseOpen}
      onAcceptProposal={acceptProposal}
      onReviseProposal={reviseProposal}
    />
  );

  const providerAvailable = providers[normalizeMediaProvider(pkg?.request?.provider) ?? ''] === true;
  const aiKind = pkg?.request?.kind === 'image' ? 'image' : 'video';
  const decision = (key: PlanStepKey): ReactNode => {
    if (!pkg) return null;
    const pending = pkg.pendingDecision && questionStep(pkg.pendingDecision.stage) === key ? pkg.pendingDecision : null;
    const shown = pending ?? (key === 'result' ? resultQuestion(pkg) : null);
    if (!shown) return null;
    return (
      <PackageDecision
        aiKind={aiKind}
        verdictReasons={key === 'prompt' && overLimit ? { approve: productionTexts.promptLimit.approveReason(overLimit) } : undefined}
        suggestedNote={key === 'prompt' && overLimit ? productionTexts.promptLimit.reviseNote(overLimit) : undefined}
        sendingBlocked={['submitting', 'submission_unknown'].includes(pkg.request?.attemptStatus ?? '')}
        pending={shown}
        note={note}
        setNote={setNote}
        busy={blocked}
        busyReason={busyReason}
        revisionByAgent={!shown.frame && shown.stage !== 'image_request_choice'}
        onDecide={(verdict, scope) => {
          // Без открытого вопроса приёмка и повтор не нуждаются в ответе: открываются сразу.
          if (!pending && verdict === 'accept') return onAccept();
          if (!pending && verdict === 'retry') return onRegenerate();
          const agentRevision = verdict === 'revise' && !shown.frame && shown.stage !== 'image_request_choice';
          const text = note.trim();
          onDecide(verdict, scope, agentRevision ? () => workflow.start('revise', text).then(() => undefined) : undefined);
        }}
      />
    );
  };

  const request = pkg ? <PackageRequest pkg={pkg} busy={blocked} busyReason={busyReason} providerAvailable={providerAvailable} onSubmit={onSubmit} /> : null;
  const resume = pkg ? (
    <PackageResume
      key={`${pkg.dir}:${pkg.request?.generationId ?? ''}`}
      pkg={pkg}
      busy={blocked}
      busyReason={busyReason}
      providerAvailable={providerAvailable}
      onResume={onResume}
      onAttach={onAttachResult}
      onNotCreated={onNotCreated}
    />
  ) : null;
  const result = pkg ? <PackageResult pkg={pkg} busy={blocked} busyReason={busyReason} onContactSheet={onContactSheet} onSelectImage={onSelectImage} /> : null;

  // Заметная индикация ожидания сервиса: и для видео, и для платной опоры.
  const attemptStatus = pkg?.request?.attemptStatus ?? '';
  const waiting =
    receiving && REQUEST_IN_FLIGHT.includes(attemptStatus) ? (
      <Stack spacing={1}>
        <LinearProgress aria-label={productionTexts.planPath.titles.generation} />
        <Typography variant="body2" color="text.secondary">
          {attemptStatus === 'submitting' ? productionTexts.planPath.submissionWait : productionTexts.planPath.generationWait}
        </Typography>
      </Stack>
    ) : null;

  // Почему опору нельзя создать или поставить: одна подпись на шаг, а не под каждой опорой.
  const framesReason =
    view && !blocked && !view.canGenerateFrames && !view.replaceFrame
      ? (view.reasons.frames ?? productionTexts.productionWorkflowPanel.descriptionRequired)
      : null;

  /** Содержимое шага: current — рабочий вид, иначе только чтение материалов. */
  const body = (key: PlanStepKey, current: boolean): ReactNode => {
    const asked = !!pkg?.pendingDecision && questionStep(pkg.pendingDecision.stage) === key;
    switch (key) {
      case 'description':
        return (
          <>
            {pkg?.description ? <PackageTextSection title={productionTexts.packageCard.description} text={pkg.description} maxHeight={260} /> : null}
            {current ? panel(asked) : null}
            {current ? decision(key) : null}
          </>
        );
      case 'frames':
        return (
          <>
            {current && framesReason ? (
              <Typography variant="body2" color="text.secondary">
                {framesReason}
              </Typography>
            ) : null}
            {pkg ? (
              <PackageKeyframes
                pkg={pkg}
                busy={blocked}
                busyReason={busyReason}
                onReopen={onReopenFrame}
                onSetNote={onSetKeyframeNote}
                renderActions={
                  current && view
                    ? (frame) => (
                        <FrameActions
                          frame={frame}
                          view={view}
                          busy={blocked}
                          onGenerate={(instruction) => void createFrame(frame.id, instruction)}
                          onImport={workflow.importFrames}
                        />
                      )
                    : undefined
                }
              />
            ) : null}
            {current ? panel(asked) : null}
            {current && pkg?.request?.kind === 'image' ? (
              <>
                {waiting}
                {request}
                {resume}
                {result}
              </>
            ) : null}
            {current ? decision(key) : null}
          </>
        );
      case 'prompt':
        return (
          <>
            {overLimit ? <PromptLimitAlert over={overLimit} videoProvider={view?.videoProvider} /> : null}
            {pkg?.prompt ? (
              <PackageTextSection
                title={productionTexts.packageCard.promptTitle({ approved: pkg.prompt.approved, characters: pkg.prompt.text.length })}
                text={pkg.prompt.text}
                maxHeight={220}
              />
            ) : null}
            {pkg?.prompt?.approved && PROMPT_REOPEN_SHOWN.includes(pkg.stage) ? (
              <ActionButton
                size="small"
                startIcon={<ReplayIcon />}
                sx={{ alignSelf: 'flex-start' }}
                title={productionTexts.promptReopenDialog.hint}
                disabled={blocked || !PROMPT_REOPEN_STAGES.includes(pkg.stage)}
                disabledReason={blocked ? busyReason : productionTexts.promptReopenDialog.unavailable}
                onClick={() => setReopeningPrompt(true)}
              >
                {productionTexts.promptReopenDialog.confirm}
              </ActionButton>
            ) : null}
            {reopeningPrompt && pkg ? (
              <PromptReopenDialog
                request={
                  pkg.stage === 'request_choice' && pkg.request && pkg.request.kind !== 'image' ? (pkg.request.dir.split('/').pop() ?? pkg.request.dir) : null
                }
                onClose={() => setReopeningPrompt(false)}
                onConfirm={(text) => {
                  setReopeningPrompt(false);
                  onReopenPrompt(text);
                }}
              />
            ) : null}
            {current ? panel(asked) : null}
            {current ? decision(key) : null}
          </>
        );
      case 'speech':
        return pkg ? (
          <ProductionSpeechPanel
            key={`speech:${pkg.dir}`}
            project={project}
            pkg={pkg}
            busy={speechBusy}
            busyReason={busyReason}
            onPrepared={onSpeechPrepared}
          />
        ) : null;
      case 'request':
        return manual ? (
          <>
            {pkg ? (
              <ManualGeneration
                key={`manual:${pkg.dir}:${pkg.request?.dir ?? ''}`}
                pkg={pkg}
                view={view}
                busy={blocked}
                busyReason={busyReason}
                onBuild={() => void workflow.buildManual()}
                onAttach={onAttachManual}
              />
            ) : null}
            {current ? panel(asked) : null}
          </>
        ) : (
          <>
            {/* Шаг «Речь» уже свёрнут: срез повторяется здесь, чтобы прослушать его перед отправкой. */}
            {pkg?.speech && pkg.request?.kind !== 'image' ? <SpeechSlice speech={pkg.speech} /> : null}
            {pkg?.request?.kind !== 'image' ? request : null}
            {current ? panel(asked) : null}
            {current ? decision(key) : null}
          </>
        );
      case 'generation':
        return (
          <>
            {current ? waiting : null}
            {pkg?.request?.kind !== 'image' ? resume : null}
          </>
        );
      case 'result':
        return (
          <>
            {pkg?.request?.kind !== 'image' ? result : null}
            {pkg?.request?.manualGeneration ? <ManualGenerationInfo record={pkg.request.manualGeneration} /> : null}
            {shot.asset ? <AcceptedAsset asset={shot.asset} /> : null}
            {current ? decision(key) : null}
          </>
        );
    }
  };

  return (
    <Stack spacing={1.5}>
      {pkg ? (
        <PackageNotices pkg={pkg} busy={blocked} busyReason={busyReason} onKeepForScene={onKeepForScene} onOpenRevision={() => setReviseOpen(true)} />
      ) : null}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stepper orientation="vertical" nonLinear activeStep={path.steps.findIndex((step) => step.key === path.current)}>
          {path.steps.map((step) => {
            const done = step.status === 'done';
            const current = step.status === 'current' || (path.finished && step.key === 'result');
            const expanded = current || (done && !!opened[step.key]);
            const label = (
              <Box>
                <Typography variant="subtitle2" color={step.status === 'future' ? 'text.secondary' : undefined}>
                  {step.title}
                </Typography>
                {step.summary ? (
                  <Typography variant="caption" color="text.secondary">
                    {step.summary}
                  </Typography>
                ) : null}
              </Box>
            );
            return (
              <Step key={step.key} completed={done} active={current} expanded={expanded} disabled={step.status === 'future'} data-plan-step={step.key}>
                {done ? (
                  <StepButton onClick={() => setOpened((value) => ({ ...value, [step.key]: !value[step.key] }))}>{label}</StepButton>
                ) : (
                  <StepLabel>{label}</StepLabel>
                )}
                <StepContent>
                  <Stack spacing={1.5} sx={{ pt: 1, minWidth: 0 }}>
                    {expanded ? body(step.key, current && !path.finished) : null}
                  </Stack>
                </StepContent>
              </Step>
            );
          })}
        </Stepper>
      </Paper>
    </Stack>
  );
}
