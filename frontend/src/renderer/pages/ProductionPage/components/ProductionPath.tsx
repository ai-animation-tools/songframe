import { productionTexts } from '@shared/texts/production';
import { savedLooksTexts } from '@shared/texts/saved-looks';
/**
 * Вертикальный путь плана: открыт текущий шаг со всем, что нужно сейчас; пройденные шаги свёрнуты в
 * итог и открываются для чтения, будущие приглушены. Путь только компонует блоки: состояние и
 * решения остаются у useProductionPage и useProductionWorkflow, файлы и согласования — у Go.
 */
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Box, Chip, LinearProgress, Paper, Stack, Step, StepButton, StepContent, StepLabel, Stepper, Typography } from '@mui/material';
import { DEFAULT_KEYFRAME_LIMIT, keyframeLimit, mediaProviderInfo, normalizeMediaProvider } from '@shared/media-providers';
import type { KeyframeNoteScope, ManualVideo, PackageView, PromptVariant, ShotProduction } from '@shared/types';
import type { ProductionPass } from '@shared/production-workflow';
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
import { CompositionPanel } from './CompositionPanel';
import { PackageNotices } from './PackageNotices';
import { PackageRequest } from './PackageRequest';
import { PackageResult } from './PackageResult';
import { PackageResume } from './PackageResume';
import { PackageTextSection } from './PackageTextSection';
import { PromptLimitAlert } from './PromptLimitAlert';
import { PromptReopenDialog } from './PromptReopenDialog';
import { PromptVariantsText, promptVariantText } from './PromptVariantsText';
import { RequestChangeDialog } from './RequestChangeDialog';
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
import { StaticShotPanel } from './StaticShotPanel';
import type { ShotFrameSource } from './ShotFrameDialog';
import { useSavedLooksCheck } from '../useSavedLooksCheck';

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
  onRecut,
  onRegenerate,
  onContactSheet,
  onResume,
  onAttachResult,
  onAttachManual,
  onNotCreated,
  onSelectImage,
  onReopenFrame,
  onRestoreFrame,
  onReplaceFrame,
  onReplaceFrameWith,
  shotFrames,
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
  answerApplied(packageDir: string, verdict: 'approve' | 'revise', note: string, promptVariant?: PromptVariant): Promise<void>;
  /**
   * after выполняется после записи ответа: доработка запускает агента той же кнопкой. promptVariant — вариант
   * видеопромпта к отправке при его утверждении.
   */
  onDecide(verdict: string, noteScope?: KeyframeNoteScope, after?: () => Promise<void>, promptVariant?: PromptVariant): void;
  onSubmit(): void;
  onAccept(): void;
  /** «Изменить участок» принятого плана: окно приёмки с прежним участком комплекта. */
  onRecut(): void;
  onRegenerate(): void;
  onContactSheet(): void;
  onResume(): void;
  onAttachResult(files: string[]): void;
  /** Видео, созданное вне приложения по пакету ручной генерации. */
  onAttachManual(video: ManualVideo): void;
  onNotCreated(): void;
  onSelectImage(index: number): void;
  onReopenFrame(frame: string, note: string, scope: KeyframeNoteScope): void;
  /** Прежний вариант опоры снова кандидат. */
  onRestoreFrame(frame: string, variant: string): void;
  /** Свой файл вместо утверждённой опоры; без обработчика кнопки на карточке нет. */
  onReplaceFrame?(frame: string): void;
  /** Кадр принятого плана (путь из «Взять кадр») вместо утверждённой опоры; без обработчика кнопки нет. */
  onReplaceFrameWith?(frame: string, path: string): Promise<void>;
  /** Принятые планы клипа для «Взять кадр» у опор; без них кнопки нет. */
  shotFrames?: ShotFrameSource;
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
  // Шаг, из которого последний раз запускали агента: ошибка запуска показывается рядом с нажатой кнопкой.
  const [launchStep, setLaunchStep] = useState<PlanStepKey | null>(null);
  const [reopeningPrompt, setReopeningPrompt] = useState(false);
  // «Изменить» на вопросе «Отправить»: окно выбора модели и параметров запроса.
  const [changingRequest, setChangingRequest] = useState(false);
  // Своё описание: черновик открытого редактора; null — редактор закрыт.
  const [ownDescription, setOwnDescription] = useState<OwnDescriptionDraft | null>(null);
  // Свой видеопромпт: текст открытого редактора; null — редактор закрыт.
  const [ownPrompt, setOwnPrompt] = useState<string | null>(null);
  const [ownError, setOwnError] = useState<string | null>(null);
  // Перед описанием плана — вопрос о героях без сохранённого образа, если модель плана держит облик по образу.
  // План из опор видео не генерирует, ручная генерация получает текст без меток: им вопрос не задаётся.
  const looksCheck = useSavedLooksCheck(project, shot.id, pkg?.dir ?? '');
  const looksApply = !(view?.staticShot ?? shot.staticShot) && !view?.manual;
  const beforeDescription = (proceed: (looks?: string[]) => void, agent: boolean): void => (looksApply ? looksCheck.check(proceed, agent) : proceed());
  // Видеопромпт с переводом: к отправке выбирается оригинал или перевод, выбор относится к показанным текстам.
  const variants = pkg?.prompt?.variants;
  const variantsKey = `${pkg?.dir ?? ''}\0${variants?.original ?? ''}\0${variants?.translation ?? ''}`;
  const [sendChoice, setSendChoice] = useState<{ key: string; variant: PromptVariant }>({ key: variantsKey, variant: 'original' });
  const sendVariant: PromptVariant = !variants
    ? 'original'
    : pkg?.prompt?.approved
      ? variants.selected
      : sendChoice.key === variantsKey
        ? sendChoice.variant
        : 'original';
  // Пока промпт не утверждён, показанный вариант и есть выбранный к отправке: переключатель меняет оба.
  // Утверждённый промпт переключается только для просмотра, отправляемым остаётся сохранённый вариант.
  const [shownChoice, setShownChoice] = useState<{ key: string; variant: PromptVariant } | null>(null);
  const promptApproved = !!pkg?.prompt?.approved;
  const shownVariant = !promptApproved ? sendVariant : shownChoice?.key === variantsKey ? shownChoice.variant : sendVariant;
  const showVariant = (variant: PromptVariant): void => {
    if (promptApproved) setShownChoice({ key: variantsKey, variant });
    else setSendChoice({ key: variantsKey, variant });
  };
  // Промпт на согласовании длиннее предела провайдера: утвердить нельзя, только вернуть агенту. Предел — для выбранного варианта.
  const overLimit =
    pkg?.prompt && !pkg.prompt.approved ? promptOverLimit(promptVariantText(pkg.prompt.text, variants, sendVariant), view?.promptMaxChars) : null;
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
  const acceptProposal = (promptVariant?: PromptVariant): Promise<boolean> =>
    workflow.apply(async (applied) => {
      // Описание и видеопромпт, принятые в окне предложения, утверждаются сразу; опоры решаются на своём вопросе.
      // Видеопромпт утверждается с вариантом, выбранным к отправке в окне предложения.
      if (applied.packageDir && (stageOfProposal === 'description' || stageOfProposal === 'prompt'))
        await answerApplied(applied.packageDir, 'approve', '', stageOfProposal === 'prompt' ? promptVariant : undefined);
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
        manual: !!view?.singleFrame,
        staticShot: !!(view?.staticShot ?? shot.staticShot)
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
    // Свой промпт заменяет оригинал: редактор начинается с него, даже если к отправке выбран перевод.
    setOwnPrompt(pkg?.prompt?.variants?.original ?? pkg?.prompt?.text ?? '');
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
   * Вопрос о тексте того же этапа (промпт агента сверх предела) не мешает: свой текст заменит его. Видеопромпт
   * меняется и при вопросе об отправке, пока подготовленный запрос не отправлен: запрос соберётся заново (как Go
   * ownReplacesQuestion).
   */
  const replacesQuestion = (stage: 'description' | 'prompt'): boolean =>
    pkg?.pendingDecision?.stage === `${stage}_review` ||
    (stage === 'prompt' && pkg?.pendingDecision?.stage === 'request_choice' && pkg.request?.attemptStatus === 'prepared');
  const ownReasonFor = (stage: 'description' | 'prompt'): string | null | undefined =>
    blocked
      ? busyReason
      : view?.proposal && view.proposal.status !== 'applied'
        ? productionTexts.productionWorkflowPanel.loadingReason
        : pkg?.pendingDecision && !replacesQuestion(stage)
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

  // Части панели агента живут в шагах своих этапов: задание и его предложение — в шаге этапа задания,
  // доработка — в шаге этапа, который она переделает. Иначе завершённое описание и его доработка
  // висели бы в шаге опор. Этап без открытого шага в пути показывается в текущем шаге.
  const reachable = (pass: ProductionPass | null | undefined): PlanStepKey =>
    path.steps.find((step) => step.key === pass && step.status !== 'future')?.key ?? path.current;
  const jobStep = reachable(view?.job ? view.proposal?.stage : null);
  const reviseStep = reachable(view?.canRevise ? view.reviseStage : null);
  const panelSteps = new Set<PlanStepKey>([path.current, jobStep, reviseStep]);
  const errorStep = launchStep && panelSteps.has(launchStep) ? launchStep : jobStep;
  // Свёрнутый пройденный шаг раскрывается сам, когда в нём ждёт задание, предложение или открытая доработка.
  const proposalWaits = !!view?.proposal && view.proposal.status !== 'running' && view.proposal.status !== 'applied';
  const jobWaits = !!view?.job && (view.job.status === 'running' || view.job.status === 'failed' || proposalWaits);
  const attention = (key: PlanStepKey): boolean => (key === jobStep && jobWaits) || (key === reviseStep && reviseOpen);

  const panel = (step: PlanStepKey, questionOpen: boolean): ReactNode => (
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
      onWriteOwn={!pkg ? () => beforeDescription(openOwnDescription, false) : view?.nextStage === 'prompt' ? openOwnPrompt : undefined}
      onBeforePrepare={(proceed) => beforeDescription(proceed, true)}
      descriptionReason={looksCheck.checking ? savedLooksTexts.beforeChecking : null}
      onOwnVideo={!pkg ? onOwnVideo : undefined}
      parts={{ current: step === path.current, job: step === jobStep, revise: step === reviseStep, error: step === errorStep }}
      onLaunch={() => setLaunchStep(step)}
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
    // Подготовленный запрос видео собирает приложение: доработка на его вопросе меняет модель и параметры без агента.
    const requestChange = shown.stage === 'request_choice' && !manual && pkg.request?.kind !== 'image';
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
        onChangeRequest={requestChange ? () => setChangingRequest(true) : undefined}
        onDecide={(verdict, scope) => {
          // Без открытого вопроса приёмка и повтор не нуждаются в ответе: открываются сразу.
          if (!pending && verdict === 'accept') return onAccept();
          if (!pending && verdict === 'retry') return onRegenerate();
          const agentRevision = verdict === 'revise' && !shown.frame && shown.stage !== 'image_request_choice';
          const text = note.trim();
          const promptVariant = shown.stage === 'prompt_review' && verdict === 'approve' && variants ? sendVariant : undefined;
          onDecide(verdict, scope, agentRevision ? () => workflow.start('revise', text).then(() => undefined) : undefined, promptVariant);
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

  // Опора этой попытки создаётся: задание агента на опору (вид Go относится к выбранной попытке) или запрос
  // изображения у провайдера в пути. Общая занятость view.busy сюда не годится: она учитывает любые задания проекта.
  const frameRunning =
    (view?.proposal?.stage === 'frames' && (view.proposal.status === 'running' || view.job?.status === 'running')) ||
    (receiving && pkg?.request?.kind === 'image' && REQUEST_IN_FLIGHT.includes(attemptStatus));

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
            {current || (!path.finished && panelSteps.has(key)) ? panel(key, asked) : null}
            {current ? decision(key) : null}
          </>
        );
      case 'frames':
        return (
          <>
            {current && view?.composition ? (
              <CompositionPanel composition={view.composition} busy={blocked} onToggle={(enabled) => void workflow.setComposition(enabled)} />
            ) : null}
            {/* Пройденный шаг: снимок, по которому создавались опоры, — для сравнения с ними. */}
            {!current && view?.composition?.enabled && view.composition.frames.length ? <CompositionPanel composition={view.composition} /> : null}
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
                onRestore={onRestoreFrame}
                onReplace={onReplaceFrame}
                onReplaceWith={onReplaceFrameWith}
                shotFrames={shotFrames}
                onSetNote={onSetKeyframeNote}
                copies={Object.fromEntries((view?.framePrompts ?? []).flatMap((prompt) => (prompt.copyOf ? [[prompt.id, prompt.copyOf]] : [])))}
                composition={view?.composition?.enabled ? view.composition.frames : []}
                renderActions={
                  current && view
                    ? (frame) => (
                        <FrameActions
                          frame={frame}
                          view={view}
                          busy={blocked}
                          onGenerate={(instruction) => void createFrame(frame.id, instruction)}
                          onImport={workflow.importFrames}
                          shotFrames={shotFrames}
                        />
                      )
                    : undefined
                }
              />
            ) : null}
            {current || (!path.finished && panelSteps.has(key)) ? panel(key, asked) : null}
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
              <PromptVariantsText
                text={pkg.prompt.text}
                variants={variants}
                title={(characters) => productionTexts.packageCard.promptTitle({ approved: !!pkg.prompt?.approved, characters })}
                status={variants ? productionTexts.promptVariants.selected({ translation: sendVariant === 'translation' }) : undefined}
                statusHint={variants && !promptApproved ? productionTexts.promptVariants.sendHint : undefined}
                shown={shownVariant}
                onShownChange={showVariant}
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
            {current || (!path.finished && panelSteps.has(key)) ? panel(key, asked) : null}
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
            {current || (!path.finished && panelSteps.has(key)) ? panel(key, asked) : null}
          </>
        ) : (
          <>
            {current && methodShown && pkg?.prompt?.approved ? methodChoice : null}
            {/* Шаг «Речь» уже свёрнут: срез повторяется здесь, чтобы прослушать его перед отправкой. */}
            {pkg?.speech && pkg.request?.kind !== 'image' ? <SpeechSlice speech={pkg.speech} /> : null}
            {pkg?.request?.kind !== 'image' ? request : null}
            {current || (!path.finished && panelSteps.has(key)) ? panel(key, asked) : null}
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
      case 'assemble':
        return pkg ? <StaticShotPanel key={pkg.dir} project={project} packageDir={pkg.dir} hasAsset={!!shot.asset} onApplied={() => onApplied(null)} /> : null;
      case 'result':
        return (
          <>
            {pkg?.request?.kind !== 'image' ? result : null}
            {pkg?.request?.manualGeneration ? <ManualGenerationInfo record={pkg.request.manualGeneration} /> : null}
            {/* Решение о результате — сразу под ним: прежний принятый комплект ниже лишь для сравнения. */}
            {current ? decision(key) : null}
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
          </>
        );
    }
  };

  return (
    <Stack spacing={1.5}>
      {looksCheck.dialog}
      {ownDescription ? (
        <OwnDescriptionDialog
          project={project}
          shot={shot.id}
          windowSeconds={pkg?.timing?.window_seconds ?? shot.end - shot.start}
          initial={ownDescription}
          limit={view?.staticShot ? DEFAULT_KEYFRAME_LIMIT : keyframeLimit(view?.videoProvider)}
          manual={!!view?.singleFrame}
          busy={workflow.busy}
          error={ownError}
          onClose={() => setOwnDescription(null)}
          onSave={(draft) => void saveOwnDescription(draft)}
        />
      ) : null}
      {changingRequest && pkg ? (
        <RequestChangeDialog
          project={project}
          shot={shot.id}
          packageDir={pkg.dir}
          provider={view?.videoProvider}
          busy={workflow.busy}
          onClose={() => setChangingRequest(false)}
          onConfirm={(change) => workflow.prepareRequest(change)}
        />
      ) : null}
      {ownPrompt !== null ? (
        <OwnPromptDialog
          project={project}
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
        <PackageNotices
          pkg={pkg}
          busy={blocked}
          busyReason={busyReason}
          frameRunning={frameRunning}
          canOpenRevision={!!view?.canRevise}
          onKeepForScene={onKeepForScene}
          onOpenRevision={() => setReviseOpen(true)}
        />
      ) : null}
      {/* Приёмка удалила пакет попытки: шаги считались бы по пустоте, поэтому показывается принятый комплект. */}
      {!pkg && shot.asset && !newAttempt ? (
        <AcceptedKitPanel project={project} shot={shot} busy={busy} busyReason={busyReason} onRecut={onRecut} />
      ) : (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stepper orientation="vertical" nonLinear activeStep={path.steps.findIndex((step) => step.key === path.current)}>
            {path.steps.map((step) => {
              const done = step.status === 'done';
              const current = step.status === 'current' || (path.finished && step.key === 'result');
              const expanded = current || (done && (opened[step.key] ?? attention(step.key)));
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
                    <StepButton onClick={() => setOpened((value) => ({ ...value, [step.key]: !expanded }))}>{label}</StepButton>
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
