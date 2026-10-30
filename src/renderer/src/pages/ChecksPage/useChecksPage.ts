import { checksTexts } from '@shared/texts/checks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CheckId, CheckInfo, JobInfo, ReviewInfo, ShotProduction } from '@shared/types';
import { useApp } from '../../state';
import type { CheckOutcome } from './types';
import { selectShot, type ShotSelection } from './shot-selection';

const JOB_KINDS = new Set(['check', 'review', 'tool']);

/** Загружает данные панели, отслеживает задания и сохраняет параметры запуска. */
export function useChecksPage() {
  const { state, notify, describeError } = useApp();
  const project = state?.current ?? '';
  const [checks, setChecks] = useState<CheckInfo[]>([]);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [reviews, setReviews] = useState<ReviewInfo[]>([]);
  const [shots, setShots] = useState<ShotProduction[]>([]);
  const [pythonAvailable, setPythonAvailable] = useState(true);
  const [strict, setStrict] = useState(false);
  const [next, setNext] = useState(false);
  const [planOnly, setPlanOnly] = useState(false);
  const [selection, setSelection] = useState<ShotSelection & { project: string }>({ project, selected: [], anchor: null });
  const [openReview, setOpenReview] = useState<ReviewInfo | null>(null);
  const [deletingReview, setDeletingReview] = useState<string | null>(null);
  const removingReview = useRef(false);
  /** Последнее задание каждой проверки: по нему строка показывает итог. */
  const [lastJob, setLastJob] = useState<Record<string, string>>({});

  const loadJobs = useCallback(async () => setJobs((await window.api.jobs.list()).filter((j) => JOB_KINDS.has(j.kind))), []);
  const loadReviews = useCallback(async () => setReviews(await window.api.checks.listReviews(project)), [project]);

  useEffect(() => {
    window.api.checks
      .list()
      .then(setChecks)
      .catch(() => undefined);
    window.api.environment
      .check()
      .then((list) => setPythonAvailable(list.find((c) => c.id === 'python')?.ok ?? false))
      .catch(() => undefined);
    window.api.production
      .view(project)
      .then((view) => setShots(view.shots))
      .catch(() => undefined);
    void loadJobs();
    void loadReviews();
  }, [project, loadJobs, loadReviews]);

  const running = jobs.some((j) => j.status === 'running');
  useEffect(() => {
    if (!running) return;
    const handle = setInterval(async () => {
      const before = jobs.filter((j) => j.status === 'running').map((j) => j.id);
      await loadJobs();
      const after = await window.api.jobs.list();
      const finished = before.filter((id) => after.find((j) => j.id === id)?.status !== 'running');
      if (finished.length) {
        await loadReviews();
        const failed = after.filter((j) => finished.includes(j.id) && j.status === 'failed');
        // Называем завершившиеся задания: страница запускает разные проверки, и общее «Задание завершено» не говорит, что именно готово.
        const titles = after.filter((j) => finished.includes(j.id)).map((j) => j.title);
        notify(failed.length ? checksTexts.jobsFailed(failed.map((j) => j.title)) : checksTexts.jobsDone(titles), failed.length ? 'warning' : 'success');
      }
    }, 1500);
    return () => clearInterval(handle);
  }, [running, jobs, loadJobs, loadReviews, notify]);

  const start = async (action: () => Promise<JobInfo>, checkId?: string): Promise<void> => {
    try {
      const job = await action();
      if (checkId) setLastJob((prev) => ({ ...prev, [checkId]: job.id }));
      await loadJobs();
    } catch (error) {
      notify(describeError(error), 'error');
    }
  };

  const runAll = (): Promise<void> =>
    start(async () => {
      const job = await window.api.checks.runAll(project, { strict, next });
      setLastJob(Object.fromEntries(checks.map((c) => [c.id, job.id])));
      return job;
    });

  const options = (id: CheckId): { strict?: boolean; next?: boolean } => (id === 'lint' ? { strict } : id === 'status' ? { next } : {});
  // Список прочитан для этой страницы, тогда как сводка проекта могла остаться от момента до создания сценария.
  const scenesReady = shots.length > 0;
  const byId = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);

  /** Итог проверки: по её собственному заданию или по шагу общего задания. */
  const outcome = (check: CheckInfo): CheckOutcome | null => {
    const job = byId.get(lastJob[check.id]);
    if (!job) return null;
    const step = job.steps.length > 1 ? job.steps.find((s) => s.tool === check.tool) : job.steps[0];
    // Прерванное закрытием программы задание для итога проверки равно неудачному.
    if (!step) return { job, status: job.status === 'interrupted' ? 'failed' : job.status, code: job.code };
    // После остановки задания незапущенные шаги больше не выполняются.
    const stepStatus = step.status === 'pending' ? (job.status === 'running' ? 'running' : 'skipped') : step.status;
    return { job, status: stepStatus, code: step.code };
  };

  // Выбор и начало диапазона принадлежат текущему проекту; удалённые планы не отправляются в сборку.
  const selected = selection.project === project ? shots.filter((shot) => selection.selected.includes(shot.id)).map((shot) => shot.id) : [];
  const toggleShot = (id: string, extend = false): void =>
    setSelection((previous) => ({
      project,
      ...selectShot(
        previous.project === project ? previous : { selected: [], anchor: null },
        shots.map((shot) => shot.id),
        id,
        extend
      )
    }));
  const clearSelection = (): void => setSelection({ project, selected: [], anchor: null });

  const buildReview = (): Promise<void> =>
    start(async () => {
      const job = await window.api.checks.buildReview(project, { shots: selected, planOnly });
      return job;
    });

  /** Удаляется только выбранная пара MP4 и рецепта; закрываем плеер до обращения к файлу. */
  const removeReview = async (review: ReviewInfo): Promise<void> => {
    if (removingReview.current) return;
    removingReview.current = true;
    setDeletingReview(review.video);
    setOpenReview((current) => (current?.video === review.video ? null : current));
    try {
      await window.api.checks.removeReview(project, review.video);
      setReviews((current) => current.filter((item) => item.video !== review.video));
      await loadReviews();
      notify(checksTexts.reviewRemoved, 'success');
    } catch (error) {
      notify(describeError(error), 'error');
    } finally {
      removingReview.current = false;
      setDeletingReview(null);
    }
  };

  return {
    project,
    checks,
    jobs,
    reviews,
    shots,
    pythonAvailable,
    strict,
    next,
    planOnly,
    selected,
    openReview,
    deletingReview,
    running,
    scenesReady,
    setStrict,
    setNext,
    setPlanOnly,
    clearSelection,
    setOpenReview,
    loadJobs,
    loadReviews,
    runAll,
    outcome,
    toggleShot,
    buildReview,
    removeReview,
    runCheck: (check: CheckInfo) => start(() => window.api.checks.run(project, check.id, options(check.id)), check.id),
    updateViews: (check: CheckInfo) => start(() => window.api.checks.updateViews(project), check.id),
    openDirectory: (dir: string) => window.api.shell.openPath(dir).catch((error) => notify(describeError(error), 'error'))
  };
}
