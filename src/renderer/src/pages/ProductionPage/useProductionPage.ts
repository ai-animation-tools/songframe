/** Состояние производства и действия выбранного пакета; платная отправка требует подтверждения снимка. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AcceptOptions, JobInfo, PackageView, ProductionView } from '@shared/types';
import { useApp } from '../../state';
import { VERDICT_LABELS, type ProductionFilter } from './constants';
import { decisionNoteKey, isExternalPackage, relocatedPackage, sendConfirmedRequest, type AcceptTarget } from './decisions';
import { completeInScope, RequestScope } from '../../hooks/requestScope';

export function useProductionPage() {
  const { state, refresh, notify, describeError } = useApp();
  const project = state?.current ?? '';
  const [view, setView] = useState<ProductionView | null>(null);
  const [params] = useSearchParams();
  const [selected, setSelected] = useState<string | null>(params.get('shot'));
  const [jobs, setJobs] = useState<JobInfo[]>([]);
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
  const [confirmSend, setConfirmSend] = useState<PackageView | null>(null);
  const [confirmRegenerate, setConfirmRegenerate] = useState<string | null>(null);
  const projectScope = useRef(new RequestScope()).current;
  projectScope.update(project);
  const sendScope = useRef(new RequestScope()).current;
  sendScope.update(confirmSend);
  useEffect(
    () => () => {
      projectScope.invalidate();
      sendScope.invalidate();
    },
    [projectScope, sendScope]
  );
  const loadVersion = useRef(0);
  const [selectedPackages, setSelectedPackages] = useState<Record<string, string>>({});
  const selectionKey = `${project}\0${selected ?? ''}`;

  const selectPackage = useCallback(
    (dir: string) => {
      setSelectedPackages((current) => ({ ...current, [selectionKey]: dir }));
    },
    [selectionKey]
  );

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    const current = projectScope.capture(project);
    const next = await window.api.production.view(project);
    if (!current() || loadVersion.current !== version) return;
    setView(next);
    setSelected((current) =>
      current && next.shots.some((shot) => shot.id === current)
        ? current
        : (next.shots.find((shot) => shot.state === 'progress')?.id ?? next.shots.find((shot) => shot.state === 'planned')?.id ?? next.shots[0]?.id ?? null)
    );
  }, [project, projectScope]);

  useEffect(() => {
    setView(null);
    setNotes({});
    setBusyPackages([]);
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

  const shot = view?.shots.find((item) => item.id === selected) ?? null;
  // После выбора пакет закреплён: появление новой попытки не переключает текущий просмотр.
  const rememberedPackage = selectedPackages[selectionKey];
  const packageSelection = rememberedPackage ?? (shot?.packages.length === 1 ? shot.packages[0].dir : shot?.packages.length ? '' : '__new__');
  const selectedPackage = shot?.packages.find((pkg) => pkg.dir === packageSelection) ?? null;
  useEffect(() => {
    if (rememberedPackage === undefined && shot?.packages.length === 1) selectPackage(shot.packages[0].dir);
  }, [rememberedPackage, shot, selectPackage]);
  const visible = useMemo(() => (view?.shots ?? []).filter((item) => filter === 'all' || item.state === filter), [view, filter]);

  const busyFor = (dir: string): boolean => busyPackages.includes(dir);
  const workflowBusyFor = (dir: string): boolean => !!workflowBusy[dir];
  const act = async (title: string, action: () => Promise<unknown>, dir = ''): Promise<void> => {
    const current = projectScope.capture(project);
    if (!current()) return;
    setBusyPackages((packages) => [...packages, dir]);
    try {
      await action();
      if (!current()) return;
      await load();
      await refresh();
      if (!current()) return;
      const nextJobs = await window.api.jobs.list();
      if (!current()) return;
      setJobs(nextJobs);
      notify(title, 'success');
    } catch (error) {
      if (current()) notify(describeError(error), 'error');
    } finally {
      if (current()) setBusyPackages((current) => current.filter((value) => value !== dir));
    }
  };

  const noteFor = (pkg: PackageView): string => notes[decisionNoteKey(pkg)] ?? '';
  const setNoteFor = (pkg: PackageView, value: string): void => setNotes((current) => ({ ...current, [decisionNoteKey(pkg)]: value }));
  const decide = (pkg: PackageView, verdict: string): void => {
    const note = noteFor(pkg).trim();
    if (verdict === 'revise' && !note) {
      notify('Для возврата напишите замечание: что исправить.', 'warning');
      return;
    }
    if (verdict === 'retry' && shot?.packages.some((item) => ['submission_unknown', 'submitting'].includes(item.request?.attemptStatus ?? ''))) {
      notify('Исход отправки ещё неизвестен. Продолжите получение по существующему ID.', 'warning');
      return;
    }
    if (verdict === 'send') {
      setConfirmSend(pkg);
      return;
    }
    const current = projectScope.capture(project);
    void act(
      `Ответ записан: ${VERDICT_LABELS[verdict]?.label ?? verdict}`,
      async () => {
        await window.api.production.decide(project, pkg.dir, verdict, note, pkg.decisionToken);
        const appExecutor = !isExternalPackage(pkg);
        if (verdict === 'park' && appExecutor) {
          await window.api.production.park(project, pkg.dir);
          if (!current()) return;
          const next = await window.api.production.view(project);
          if (!current()) return;
          const parked = relocatedPackage(pkg, next);
          ++loadVersion.current;
          setView(next);
          selectPackage(parked?.dir ?? '');
          if (!parked) notify('Пакет перенесён. Выберите нужный пакет из списка.', 'info');
        }
        if (!current()) return;
        setNoteFor(pkg, '');
        if (verdict === 'accept' && appExecutor) setAcceptDialog({ shot: pkg.shot, dir: pkg.dir, resultToken: pkg.resultToken });
        if (verdict === 'retry' && appExecutor) setConfirmRegenerate(pkg.shot);
      },
      pkg.dir
    );
  };

  // Выбор опоры связан с показанным оригиналом; это ещё не художественное утверждение кадра.
  const selectImage = (pkg: PackageView, index: number): void => {
    if (!pkg.resultToken) {
      notify('Результат не подтверждён. Обновите пакет перед выбором опоры.', 'warning');
      return;
    }
    void act(
      'Изображение выбрано как опора. Утвердите опоры отдельно.',
      () => window.api.production.selectImage(project, pkg.dir, index, pkg.resultToken!),
      pkg.dir
    );
  };

  const confirmRequest = async (quoteToken?: string, unknownCostConsentToken?: string): Promise<void> => {
    const pkg = confirmSend;
    if (!pkg) return;
    const currentProject = projectScope.capture(project);
    if (!currentProject()) return;
    const currentDialog = sendScope.capture();
    await completeInScope(
      sendConfirmedRequest(window.api, project, pkg, quoteToken, unknownCostConsentToken),
      () => currentProject() && currentDialog(),
      () => setConfirmSend(null)
    );
    if (currentProject()) await load();
  };

  const copy = async (text: string): Promise<void> => {
    await navigator.clipboard.writeText(text);
    notify('Скопировано', 'success');
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
    filter,
    setFilter,
    acceptDialog,
    setAcceptDialog,
    acceptOptions,
    setAcceptOptions,
    confirmSend,
    setConfirmSend,
    confirmRequest,
    confirmRegenerate,
    setConfirmRegenerate,
    load,
    shot,
    visible,
    act,
    decide,
    selectImage,
    copy,
    packageSelection,
    selectedPackage,
    selectPackage,
    reportWorkflowBusy,
    workflowBusyFor
  };
}
