import { productionTexts } from '@shared/texts/production';
/** Состояние производства и действия выбранного пакета; платная отправка требует подтверждения снимка. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { AcceptOptions, BrokenPackage, JobInfo, KeyframeNoteScope, PackageView, ProductionView } from '@shared/types';
import { useApp } from '../../state';
import { VERDICT_LABELS, type ProductionFilter } from './constants';
import {
  decisionNoteKey,
  isQueuedPackage,
  regeneratedPackage,
  relocatedPackage,
  reviewMontageRoute,
  sendConfirmedRequest,
  acceptTargetFor,
  defaultAcceptOptions,
  type AcceptTarget
} from './decisions';
import { completeInScope, RequestScope } from '../../hooks/requestScope';

interface OperationResult {
  job?: JobInfo;
  error?: string;
  running?: boolean;
  label?: string;
}

// Завершённый ответ запуска не заменяется более старым снимком незавершённого опроса.
function operationJob(operation: OperationResult, jobs: JobInfo[]): JobInfo | undefined {
  return operation.job && operation.job.status !== 'running' ? operation.job : (jobs.find((job) => job.id === operation.job?.id) ?? operation.job);
}

export function useProductionPage() {
  const { state, refresh, notify, describeError } = useApp();
  const project = state?.current ?? '';
  const [view, setView] = useState<ProductionView | null>(null);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string | null>(params.get('shot'));
  // Переход по ссылке ?shot= на уже открытой странице (например, со «Сцен» или из уведомления) выбирает новый план.
  const shotParam = params.get('shot');
  useEffect(() => {
    if (shotParam) setSelected(shotParam);
  }, [shotParam]);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [operations, setOperations] = useState<Record<string, OperationResult>>({});
  const announcedJobs = useRef(new Set<string>());
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyPackages, setBusyPackages] = useState<string[]>([]);
  const [workflowBusy, setWorkflowBusy] = useState<Record<string, boolean>>({});
  const reportWorkflowBusy = useCallback(
    (dir: string, busy: boolean) => setWorkflowBusy((current) => (current[dir] === busy ? current : { ...current, [dir]: busy })),
    []
  );
  const [filter, setFilter] = useState<ProductionFilter>('all');
  const [acceptDialog, setAcceptDialog] = useState<AcceptTarget | null>(null);
  const [acceptOptions, setAcceptOptions] = useState<AcceptOptions>({ mode: 'full', cutStart: 0, cutEnd: 0, speed: '1', holdFirst: 0, holdLast: 0 });
  // Приёмка открывается с участком под окно плана, если длина оригинала заведомо другая.
  const openAccept = useCallback((pkg: PackageView, hasAsset: boolean, lipsync = false) => {
    const target = acceptTargetFor(pkg, hasAsset, lipsync);
    setAcceptOptions(defaultAcceptOptions(target));
    setAcceptDialog(target);
  }, []);
  const [confirmSend, setConfirmSend] = useState<PackageView | null>(null);
  const [confirmRegenerate, setConfirmRegenerate] = useState<string | null>(null);
  const projectScope = useRef(new RequestScope()).current;
  projectScope.update(project);
  const sendScope = useRef(new RequestScope()).current;
  const navigationScope = useRef(new RequestScope()).current;
  sendScope.update(confirmSend);
  useEffect(
    () => () => {
      projectScope.invalidate();
      sendScope.invalidate();
      navigationScope.invalidate();
    },
    [projectScope, sendScope, navigationScope]
  );
  const loadVersion = useRef(0);
  const [selectedPackages, setSelectedPackages] = useState<Record<string, string>>({});
  const selectionKey = `${project}\0${selected ?? ''}`;
  const operationKey = (dir: string, shotId: string | null = selected): string => `${project}\0${shotId ?? ''}\0${dir}`;
  const operationFor = (dir = ''): OperationResult => {
    const operation = operations[operationKey(dir)] ?? {};
    return { ...operation, job: operationJob(operation, jobs) };
  };

  const selectPackage = useCallback(
    (dir: string) => {
      setSelectedPackages((current) => ({ ...current, [selectionKey]: dir }));
    },
    [selectionKey]
  );
  const openQueuedPackage = (pkg: PackageView): void => {
    setSelected(pkg.shot);
    setSelectedPackages((current) => ({ ...current, [`${project}\0${pkg.shot}`]: pkg.dir }));
    setFilter('queued');
  };

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    const current = projectScope.capture(project);
    const next = await window.api.production.view(project);
    if (!current() || loadVersion.current !== version) return;
    setView(next);
    setSelected((current) =>
      current && next.shots.some((shot) => shot.id === current)
        ? current
        : // После планов в работе — принятые по прежней постановке: им нужно новое производство раньше не начатых.
          (next.shots.find((shot) => shot.state === 'progress')?.id ??
          next.shots.find((shot) => shot.state === 'stale')?.id ??
          next.shots.find((shot) => shot.state === 'planned')?.id ??
          next.shots[0]?.id ??
          null)
    );
  }, [project, projectScope]);

  useEffect(() => {
    setView(null);
    setNotes({});
    setBusyPackages([]);
    setJobs([]);
    setOperations({});
    setWorkflowBusy({});
    setConfirmSend(null);
    setConfirmRegenerate(null);
    setAcceptDialog(null);
  }, [project]);

  useEffect(() => {
    let active = true;
    const current = projectScope.capture(project);
    let timer: ReturnType<typeof setTimeout>;
    const read = async (): Promise<void> => {
      try {
        await load();
        const nextJobs = await window.api.jobs.list();
        if (active && current()) setJobs(nextJobs);
      } catch (error) {
        if (active && current()) notify(describeError(error), 'error');
      } finally {
        if (active) timer = setTimeout(() => void read(), 1800);
      }
    };
    void read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [load, project, projectScope, notify, describeError]);

  // Успешный IPC означает запуск, а не результат: уведомляем о завершении по состоянию задания.
  useEffect(() => {
    for (const [key, operation] of Object.entries(operations)) {
      const job = operationJob(operation, jobs);
      if (!job || job.status === 'running' || announcedJobs.current.has(job.id)) continue;
      announcedJobs.current.add(job.id);
      // Новая попытка по кнопке пользователя открывается сама: искать её в списке пакетов не нужно.
      const created = job.kind === 'regenerate' && job.status === 'done' ? regeneratedPackage(job.log) : null;
      if (created) {
        const shotId = key.split('\0')[1];
        setSelectedPackages((current) => ({ ...current, [`${project}\0${shotId}`]: created }));
        setSelected(shotId);
        setFilter((current) => (current === 'queued' ? 'all' : current));
      }
      notify(
        job.status === 'failed'
          ? productionTexts.useProductionPage.jobFailed({ title: job.title, error: job.error, code: job.code })
          : productionTexts.useProductionPage.jobDone({ title: job.title }),
        job.status === 'failed' ? 'error' : 'success'
      );
    }
  }, [jobs, operations, notify, project]);

  const shot = view?.shots.find((item) => item.id === selected) ?? null;
  // После выбора пакет закреплён: появление новой попытки не переключает текущий просмотр.
  const rememberedPackage = selectedPackages[selectionKey];
  // Непринятое предложение агента открывается сразу: выбирается его пакет или «Новая подготовка».
  const proposalSelection = shot?.proposal ? (shot.proposal.packageDir ?? '__new__') : undefined;
  const packageSelection =
    rememberedPackage ?? proposalSelection ?? (shot?.packages.length === 1 ? shot.packages[0].dir : shot?.packages.length ? '' : '__new__');
  const selectedPackage = shot?.packages.find((pkg) => pkg.dir === packageSelection) ?? null;
  navigationScope.update(`${project}\0${selected ?? ''}\0${packageSelection}\0${filter}`);
  useEffect(() => {
    if (rememberedPackage === undefined && !shot?.proposal && shot?.packages.length === 1) selectPackage(shot.packages[0].dir);
  }, [rememberedPackage, shot, selectPackage]);
  const queued = useMemo(() => (view?.shots ?? []).flatMap((item) => item.packages.filter(isQueuedPackage)), [view]);
  const visible = useMemo(
    () =>
      (view?.shots ?? []).filter(
        (item) =>
          filter === 'all' || (filter === 'queued' ? item.packages.some(isQueuedPackage) : filter === 'attention' ? !!item.attention : item.state === filter)
      ),
    [view, filter]
  );
  const changeFilter = (value: ProductionFilter): void => {
    if (value === 'queued' && queued.length) {
      const pkg = queued.find((item) => item.shot === selected && item.dir === packageSelection) ?? queued[0];
      openQueuedPackage(pkg);
      return;
    }
    // Как и очередь, фильтр «Ждут вашего действия» сразу открывает первый такой план, если выбранный не ждёт.
    const waiting = value === 'attention' ? (view?.shots ?? []).filter((item) => item.attention) : [];
    if (waiting.length && !waiting.some((item) => item.id === selected)) setSelected(waiting[0].id);
    setFilter(value);
  };

  const busyFor = (dir: string): boolean => busyPackages.includes(dir) || operationFor(dir).job?.status === 'running';
  const workflowBusyFor = (dir: string): boolean => !!workflowBusy[dir];
  const act = async (title: string, action: () => Promise<JobInfo | void>, dir = '', shotId: string | null = selected): Promise<void> => {
    const current = projectScope.capture(project);
    if (!current()) return;
    const key = operationKey(dir, shotId);
    setOperations((current) => ({ ...current, [key]: { running: true, label: productionTexts.useProductionPage.launchingAction } }));
    setBusyPackages((packages) => [...packages, dir]);
    let startedJob: JobInfo | void = undefined;
    try {
      const job = await action();
      startedJob = job;
      if (!current()) return;
      setOperations((current) => ({ ...current, [key]: job ? { job } : {} }));
      await load();
      await refresh();
      if (!current()) return;
      const nextJobs = await window.api.jobs.list();
      if (!current()) return;
      setJobs(nextJobs);
      if (!job) notify(title, 'success');
    } catch (error) {
      if (current()) {
        const message = describeError(error);
        // Сбой обновления страницы не отменяет уже запущенную операцию и не скрывает её результат.
        if (!startedJob) setOperations((current) => ({ ...current, [key]: { error: message } }));
        notify(message, 'error');
      }
    } finally {
      if (current()) setBusyPackages((current) => current.filter((value) => value !== dir));
    }
  };

  const noteFor = (pkg: PackageView): string => notes[decisionNoteKey(pkg)] ?? '';
  const setNoteFor = (pkg: PackageView, value: string): void => setNotes((current) => ({ ...current, [decisionNoteKey(pkg)]: value }));
  const decide = (pkg: PackageView, verdict: string, noteScope?: KeyframeNoteScope): void => {
    const note = noteFor(pkg).trim();
    const frame = pkg.pendingDecision?.frame;
    if (verdict === 'revise' && !note) {
      notify(productionTexts.useProductionPage.revisionNoteRequired, 'warning');
      return;
    }
    if (verdict === 'retry' && shot?.packages.some((item) => ['submission_unknown', 'submitting'].includes(item.request?.attemptStatus ?? ''))) {
      notify(productionTexts.useProductionPage.submissionUnknown, 'warning');
      return;
    }
    if (verdict === 'send') {
      setConfirmSend(pkg);
      return;
    }
    // Пробу собирает сам пользователь в монтаже; вопрос о результате остаётся открытым до его решения.
    if (verdict === 'review' && view) {
      navigate(reviewMontageRoute(view, pkg, project));
      return;
    }
    const current = projectScope.capture(project);
    const currentNavigation = navigationScope.capture();
    void act(
      verdict === 'park'
        ? productionTexts.useProductionPage.parked
        : verdict === 'revise' && frame
          ? productionTexts.useProductionPage.frameNoteSaved({ frame })
          : verdict === 'revise'
            ? productionTexts.useProductionPage.revisionSaved
            : verdict === 'approve' && frame
              ? productionTexts.useProductionPage.frameApproved({ frame })
              : productionTexts.useProductionPage.answerSaved({ label: VERDICT_LABELS[verdict]?.label ?? verdict }),
      async () => {
        await window.api.production.decide(project, pkg.dir, verdict, note, pkg.decisionToken, frame && verdict === 'revise' ? noteScope : undefined);
        if (verdict === 'park') {
          await window.api.production.park(project, pkg.dir);
          if (!current()) return;
          const next = await window.api.production.view(project);
          if (!current()) return;
          const parked = relocatedPackage(pkg, next);
          ++loadVersion.current;
          setView(next);
          if (parked) {
            const key = `${project}\0${pkg.shot}`;
            // Запоминаем новый путь и после ухода с плана, сохраняя последующий ручной выбор другого пакета.
            setSelectedPackages((current) => (current[key] === undefined || current[key] === pkg.dir ? { ...current, [key]: parked.dir } : current));
          }
          // Завершение переноса не возвращает пользователя к пакету, с которого он уже ушёл.
          if (parked && currentNavigation()) openQueuedPackage(parked);
          else if (!parked && currentNavigation()) {
            setFilter('queued');
            selectPackage('');
            notify(productionTexts.useProductionPage.relocated, 'info');
          }
        }
        if (!current()) return;
        setNoteFor(pkg, '');
        if (verdict === 'accept') openAccept(pkg, !!shot?.asset, !!shot?.lipsync);
        if (verdict === 'retry') setConfirmRegenerate(pkg.shot);
      },
      pkg.dir
    );
  };

  /** Возврат утверждённой опоры: главный процесс откажет, если видеопромпт или запрос видео уже построены на ней. */
  const reopenFrame = (pkg: PackageView, frame: string, note: string, scope: KeyframeNoteScope): void => {
    void act(
      productionTexts.useProductionPage.frameReopened({ frame }),
      () => window.api.production.reopenFrame(project, pkg.dir, frame, note, scope),
      pkg.dir
    );
  };

  /** Пользователь решил, что правка сценария не меняет материалы неотправленного пакета. */
  const keepPackageForScene = (pkg: PackageView): void => {
    void act(productionTexts.useProductionPage.sceneRetained, () => window.api.production.keepPackageForScene(project, pkg.dir), pkg.dir);
  };

  const setKeyframeNote = (pkg: PackageView, id: number, active: boolean): void => {
    void act(
      active ? productionTexts.useProductionPage.frameNoteActivated : productionTexts.useProductionPage.frameNoteDeactivated,
      () => window.api.production.setKeyframeNote(project, pkg.dir, id, active),
      pkg.dir
    );
  };

  // Выбор опоры связан с показанным оригиналом; это ещё не художественное утверждение кадра.
  const selectImage = (pkg: PackageView, index: number): void => {
    if (!pkg.resultToken) {
      notify(productionTexts.useProductionPage.candidateUnconfirmed, 'warning');
      return;
    }
    void act(productionTexts.useProductionPage.candidateSelected, () => window.api.production.selectImage(project, pkg.dir, index, pkg.resultToken!), pkg.dir);
  };

  const confirmRequest = async (quoteToken?: string, unknownCostConsentToken?: string): Promise<void> => {
    const pkg = confirmSend;
    if (!pkg) return;
    const currentProject = projectScope.capture(project);
    if (!currentProject()) return;
    const currentDialog = sendScope.capture();
    await completeInScope(
      sendConfirmedRequest(window.api, project, pkg, quoteToken, unknownCostConsentToken).then((job) => {
        if (job && currentProject()) {
          const key = operationKey(pkg.dir, pkg.shot);
          setOperations((current) => ({ ...current, [key]: { job } }));
          // Диалог закрывается сразу: подтверждаем, что платный запрос ушёл, а итог придёт отдельным уведомлением.
          notify(productionTexts.useProductionPage.requestSubmitted({ shot: pkg.shot }), 'info');
        }
      }),
      () => currentProject() && currentDialog(),
      () => setConfirmSend(null)
    );
    if (currentProject()) await load();
  };

  /** После удаления попытки выбор пакета возвращается к новой подготовке: другие пакеты плана пользователь выбирает сам. */
  const discardPackage = (pkg: PackageView): void => {
    void act(
      productionTexts.useProductionPage.attemptDeleted({ relative: pkg.relative }),
      async () => {
        await window.api.production.discardAttempt(project, pkg.dir);
        setSelectedPackages((current) => ({ ...current, [`${project}\0${pkg.shot}`]: '__new__' }));
      },
      pkg.dir,
      pkg.shot
    );
  };

  /** Повреждённая папка не является пакетом: удаление не трогает выбор и просто обновляет сводку. */
  const discardBroken = (item: BrokenPackage): void => {
    void act(
      productionTexts.useProductionPage.folderDeleted({ relative: item.relative }),
      () => window.api.production.discardAttempt(project, item.dir),
      item.dir,
      item.shot ?? selected
    );
  };

  return {
    project,
    view,
    selected,
    setSelected,
    jobs,
    noteFor,
    setNoteFor,
    busyFor,
    operationFor,
    filter,
    setFilter: changeFilter,
    queued,
    openQueuedPackage,
    acceptDialog,
    setAcceptDialog,
    openAccept,
    acceptOptions,
    setAcceptOptions,
    confirmSend,
    setConfirmSend,
    confirmRequest,
    confirmRegenerate,
    setConfirmRegenerate,
    discardPackage,
    discardBroken,
    load,
    shot,
    visible,
    act,
    decide,
    reopenFrame,
    keepPackageForScene,
    setKeyframeNote,
    selectImage,
    packageSelection,
    selectedPackage,
    selectPackage,
    reportWorkflowBusy,
    workflowBusyFor
  };
}
