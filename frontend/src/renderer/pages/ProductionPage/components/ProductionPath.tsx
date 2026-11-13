import { productionTexts } from '@shared/texts/production';
/**
 * Вертикальный путь плана: открыт текущий шаг со всем, что нужно сейчас; пройденные шаги свёрнуты в
 * итог и открываются для чтения, будущие приглушены. Путь только компонует блоки: состояние и
 * решения остаются у useProductionPage и useProductionWorkflow, файлы и согласования — у Go.
 */
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Box, Chip, LinearProgress, Paper, Stack, Step, StepButton, StepContent, StepLabel, Stepper, Typography } from '@mui/material';
import { keyframeLimit, mediaProviderInfo, normalizeMediaProvider } from '@shared/media-providers';
import type { KeyframeNoteScope, ManualVideo, PackageView, ShotProduction } from '@shared/types';
import { BUSY_REASON } from '../constants';
import { manualGeneration, planPath, questionStep, REQUEST_IN_FLIGHT, type PlanPath, type PlanStepKey } from '../planPath';
import { useProductionWorkflow, type ProductionWorkflow } from '../useProductionWorkflow';
import { AcceptedAsset } from './AcceptedAsset';
import { AcceptedKitPanel } from './AcceptedKitPanel';
import { useApp } from '../../../state';
import { FrameActions, type FrameInstruction } from './FrameActions';
import UploadFileIcon from '@mui/icons-material/UploadFile';
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
import EditNoteIcon from '@mui/icons-material/EditNote';
import { initialDraft, ownText, type OwnDescriptionDraft } from '../ownDescription';
import { OwnDescriptionDialog } from './OwnDescriptionDialog';
import { OwnPromptDialog } from './OwnPromptDialog';
import { GenerationMethodChoice } from './GenerationMethodChoice';
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

/** Своё видео не повторяется по запросу и не дорабатывается агентом: у результата остаются приёмка и проба стыков. */
const OWN_VIDEO_EXCLUDED = ['retry', 'revise'];
function withoutAgentOptions(question: NonNullable<PackageView['pendingDecision']>, pkg: PackageView): NonNullable<PackageView['pendingDecision']> {
  return pkg.request?.ownVideo ? { ...question, options: question.options.filter((option) => !OWN_VIDEO_EXCLUDED.includes(option)) } : question;
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
  onSpeechPrepared,
  onOwnVideo,
  onReplaceVideo
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
  /** Открыть окно своего видео плана (новая попытка без описания, опор и промпта). */
  onOwnVideo?(): void;
  /** Заменить видео, загруженное вручную в попытку, пока результат не принят. */
  onReplaceVideo?(): void;
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
  // Своё описание: черновик открытого редактора; null — редактор закрыт.
  const [ownDescription, setOwnDescription] = useState<OwnDescriptionDraft | null>(null);
  // Свой видеопромпт: текст открытого редактора; null — редактор закрыт.
  const [ownPrompt, setOwnPrompt] = useState<string | null>(null);
  const [ownError, setOwnError] = useState<string | null>(null);
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

  /** Редактор своего описания: текущее описание и план опор попытки либо пустой черновик новой попытки. */
  const openOwnDescription = (): void => {
    setOwnError(null);
    setOwnDescription(
      initialDraft({
        description: pkg?.description,
        requestSeconds: pkg?.timing?.request_seconds,
        framePrompts: pkg ? (view?.framePrompts ?? []) : [],
        window: pkg?.timing?.window_seconds ?? shot.end - shot.start,
        manual: !!view?.singleFrame
      })
    );
  };
  // Сохранение сразу принимает описание: автор своего текста — сам пользователь.
  const saveOwnDescription = async (draft: OwnDescriptionDraft): Promise<void> => {
    setOwnError(null);
    const saved = await workflow.saveOwn(ownText(draft), async (applied) => {
      if (applied.packageDir) await answerApplied(applied.packageDir, 'approve', '');
    });
    if (saved) setOwnDescription(null);
  };
  const openOwnPrompt = (): void => {
    setOwnError(null);
    setOwnPrompt(pkg?.prompt?.text ?? '');
  };
  // Свой промпт тоже утверждается сразу; запрос после него готовится заново.
  const saveOwnPrompt = async (prompt: string): Promise<void> => {
    setOwnError(null);
    const saved = await workflow.saveOwn({ stage: 'prompt', prompt }, async (applied) => {
      if (applied.packageDir) await answerApplied(applied.packageDir, 'approve', '');
    });
    if (saved) setOwnPrompt(null);
  };
  // Ошибка сохранения видна в окне редактора: оно остаётся открытым для исправления.
  const ownOpen = ownDescription !== null || ownPrompt !== null;
  useEffect(() => {
    if (ownOpen && workflow.error) setOwnError(workflow.error);
  }, [ownOpen, workflow.error]);
  /**
   * Свой текст этапа доступен, пока агент не работает и нет непринятого предложения или открытого вопроса попытки.
   * Вопрос о тексте того же этапа (промпт агента сверх предела) не мешает: свой текст заменит его.
   */
  const ownReasonFor = (stage: 'description' | 'prompt'): string | null | undefined =>
    blocked
      ? busyReason
      : view?.proposal && view.proposal.status !== 'applied'
        ? productionTexts.productionWorkflowPanel.loadingReason
        : pkg?.pendingDecision && pkg.pendingDecision.stage !== `${stage}_review`
          ? productionTexts.main.workflow.resolveQuestionFirst
          : null;
  const ownReason = ownReasonFor('description');
  const promptReason = ownReasonFor('prompt');
  // Способ генерации меняется, пока запрос не подготовлен: до утверждения промпта — на шаге «Видеопромпт», после — на шаге
  // «Запрос» (свой промпт утверждается сразу при сохранении). Речевой план без липсинка — всегда вручную.
  // У способа видео проекта без сервиса все попытки ручные: выбирать нечего.
  const projectManual = !!mediaProviderInfo(view?.videoProvider, 'video')?.manual;
  const methodShown = !!pkg && !!view && !view.singleFrame && !projectManual && !view.paid && !pkg.request;
  const methodReason = view?.derivedFrom ? view.reasons.continue : promptReason;
  const methodChoice = (
    <GenerationMethodChoice
      method={view?.generationMethod ?? 'provider'}
      disabledReason={methodReason}
      onChange={(method) => void workflow.setGenerationMethod(method)}
    />
  );

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
      onWriteOwn={!pkg ? openOwnDescription : view?.nextStage === 'prompt' ? openOwnPrompt : undefined}
      onOwnVideo={!pkg ? onOwnVideo : undefined}
    />
  );

  const providerAvailable = providers[normalizeMediaProvider(pkg?.request?.provider) ?? ''] === true;
  const aiKind = pkg?.request?.kind === 'image' ? 'image' : 'video';
  const decision = (key: PlanStepKey): ReactNode => {
    if (!pkg) return null;
    const pending = pkg.pendingDecision && questionStep(pkg.pendingDecision.stage) === key ? pkg.pendingDecision : null;
    const asked = pending ?? (key === 'result' ? resultQuestion(pkg) : null);
    if (!asked) return null;
    const shown = withoutAgentOptions(asked, pkg);
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
            {pkg?.description && view ? (
              <ActionButton
                size="small"
                startIcon={<EditNoteIcon />}
                sx={{ alignSelf: 'flex-start' }}
                title={productionTexts.ownDescriptionDialog.editHint}
                disabled={!!ownReason}
                disabledReason={ownReason}
                onClick={openOwnDescription}
              >
                {productionTexts.ownDescriptionDialog.edit}
              </ActionButton>
            ) : null}
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
            {current && methodShown && !pkg?.prompt?.approved ? methodChoice : null}
            {view?.generationMethod === 'manual' && !(methodShown && current) ? (
              <Chip color="info" label={productionTexts.generationMethod.chosenManual} sx={{ alignSelf: 'flex-start' }} />
            ) : null}
            {overLimit ? <PromptLimitAlert over={overLimit} videoProvider={view?.videoProvider} /> : null}
            {pkg?.prompt ? (
              <PackageTextSection
                title={productionTexts.packageCard.promptTitle({ approved: pkg.prompt.approved, characters: pkg.prompt.text.length })}
                text={pkg.prompt.text}
                maxHeight={220}
              />
            ) : null}
            {pkg?.prompt && view && !view.paid && PROMPT_REOPEN_STAGES.includes(pkg.stage) ? (
              <ActionButton
                size="small"
                startIcon={<EditNoteIcon />}
                sx={{ alignSelf: 'flex-start' }}
                title={productionTexts.ownPromptDialog.editHint}
                disabled={!!promptReason}
                disabledReason={promptReason}
                onClick={openOwnPrompt}
              >
                {productionTexts.ownDescriptionDialog.edit}
              </ActionButton>
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
            {current && methodShown && pkg?.prompt?.approved ? methodChoice : null}
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
            {current && methodShown && pkg?.prompt?.approved ? methodChoice : null}
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
            {pkg?.request?.manualResult && pkg.stage !== 'accepted' && onReplaceVideo ? (
              <ActionButton
                size="small"
                startIcon={<UploadFileIcon />}
                sx={{ alignSelf: 'flex-start' }}
                title={productionTexts.ownVideo.replaceHint}
                disabled={blocked}
                disabledReason={busyReason}
                onClick={onReplaceVideo}
              >
                {productionTexts.ownVideo.replace}
              </ActionButton>
            ) : null}
            {shot.asset ? <AcceptedAsset asset={shot.asset} /> : null}
            {current ? decision(key) : null}
          </>
        );
    }
  };

  return (
    <Stack spacing={1.5}>
      {ownDescription ? (
        <OwnDescriptionDialog
          project={project}
          shot={shot.id}
          windowSeconds={pkg?.timing?.window_seconds ?? shot.end - shot.start}
          initial={ownDescription}
          limit={keyframeLimit(view?.videoProvider)}
          manual={!!view?.singleFrame}
          busy={workflow.busy}
          error={ownError}
          onClose={() => setOwnDescription(null)}
          onSave={(draft) => void saveOwnDescription(draft)}
        />
      ) : null}
      {ownPrompt !== null ? (
        <OwnPromptDialog
          shot={shot.id}
          initial={ownPrompt}
          limit={view?.promptMaxChars}
          busy={workflow.busy}
          error={ownError}
          onClose={() => setOwnPrompt(null)}
          onSave={(prompt) => void saveOwnPrompt(prompt)}
        />
      ) : null}
      {pkg ? (
        <PackageNotices pkg={pkg} busy={blocked} busyReason={busyReason} onKeepForScene={onKeepForScene} onOpenRevision={() => setReviseOpen(true)} />
      ) : null}
      {/* Приёмка удалила пакет попытки: шаги считались бы по пустоте, поэтому показывается принятый комплект. */}
      {!pkg && shot.asset && !newAttempt ? (
        <AcceptedKitPanel project={project} shot={shot} />
      ) : (
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
      )}
    </Stack>
  );
}
