/**
 * Состояние страницы «Эффекты»: снимок effects.view, выбранный план (?shot=), черновик цепочки
 * эффектов каждого плана, превью кадра «до» и «после», задание рендера и снятие эффекта.
 * Черновик живёт в странице до «Применить»: Go пишет рецепт только вместе с готовым роликом.
 * Превью пересчитывается с задержкой после правки; поздний ответ прежнего запроса отбрасывается.
 * На весь экран кадр запрашивается в полном размере ролика.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { JobInfo } from '@shared/types';
import { editableSteps, sameSteps, type EffectShot, type EffectStep, type EffectsView } from '@shared/effects';
import { effectsTexts as texts } from '@shared/texts/effects';
import { useApp } from '../../state';

/** Ширина кадра превью: вдвое меньше кадра ролика, этого хватает для подбора на глаз. */
export const PREVIEW_WIDTH = 960;
/** Ширина кадра на весь экран — полный кадр ролика: при уменьшении зерно и тонкие капли усредняются. */
export const FULL_WIDTH = 1920;
/** Задержка пересчёта превью после правки: ползунок не запускает кадр на каждом шаге. */
export const PREVIEW_DELAY_MS = 350;
const JOB_POLL_MS = 1000;

export type PreviewMode = 'after' | 'before';

export function useEffectsPage() {
  const { state, notify, describeError } = useApp();
  const project = state?.current ?? '';
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<EffectsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, EffectStep[]>>({});
  const [frames, setFrames] = useState<Record<string, number>>({});
  const [mode, setMode] = useState<PreviewMode>('after');
  // Кадр открыт на весь экран: превью запрашивается в полном размере.
  const [full, setFull] = useState(false);
  const [preview, setPreview] = useState<{ key: string; url: string | null; error: string | null; loading: boolean }>({
    key: '',
    url: null,
    error: null,
    loading: false
  });
  // Задание рендера и его план: одно за раз со страницы, итог показывается у своего плана.
  const [job, setJob] = useState<{ shot: string; info: JobInfo } | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Пока снимается эффект, плеер ролика с эффектом убран: в Windows открытый файл не удалить.
  const [releasing, setReleasing] = useState(false);
  const current = useRef(project);
  current.current = project;

  const load = useCallback(async () => {
    const asked = project;
    try {
      const next = await window.api.effects.view(project);
      if (current.current !== asked) return;
      setView(next);
      setLoadError(null);
    } catch (failure) {
      if (current.current === asked) setLoadError(describeError(failure));
    }
  }, [describeError, project]);

  useEffect(() => {
    setView(null);
    setDrafts({});
    setFrames({});
    setJob(null);
    void load();
  }, [load]);

  const shots = useMemo(() => view?.shots ?? [], [view]);
  const requested = params.get('shot');
  const selected: EffectShot | null = shots.find((shot) => shot.shot === requested) ?? shots[0] ?? null;
  const select = useCallback(
    (shot: string) => {
      setActionError(null);
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.set('shot', shot);
          return next;
        },
        { replace: true }
      );
    },
    [setParams]
  );

  const saved = useMemo(() => (selected ? editableSteps(selected.steps) : []), [selected]);
  const draft = selected ? (drafts[selected.shot] ?? saved) : [];
  const dirty = !!selected && !sameSteps(draft, saved);
  const frame = selected ? Math.min(frames[selected.shot] ?? Math.floor(selected.frames / 2), Math.max(0, selected.frames - 1)) : 0;

  const change = (steps: EffectStep[]): void => {
    if (selected) setDrafts((value) => ({ ...value, [selected.shot]: steps }));
  };
  const setFrame = (value: number): void => {
    if (selected) setFrames((frames) => ({ ...frames, [selected.shot]: value }));
  };

  // Превью: «до» — кадр без эффектов, «после» — с черновиком. Ключ запроса отличает поздние ответы.
  const previewSteps = mode === 'before' ? [] : draft;
  const width = full ? FULL_WIDTH : PREVIEW_WIDTH;
  const previewKey = selected && !selected.problem ? JSON.stringify([project, selected.shot, frame, previewSteps, width]) : '';
  useEffect(() => {
    if (!previewKey || !selected) {
      setPreview({ key: '', url: null, error: null, loading: false });
      return;
    }
    let active = true;
    setPreview((value) => ({ ...value, key: previewKey, loading: true }));
    const timer = setTimeout(() => {
      window.api.effects
        .preview(project, selected.shot, previewSteps, frame, width)
        .then((url) => {
          if (active) setPreview({ key: previewKey, url, error: null, loading: false });
        })
        .catch((failure: unknown) => {
          if (active) setPreview({ key: previewKey, url: null, error: describeError(failure), loading: false });
        });
    }, PREVIEW_DELAY_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // previewKey включает проект, план, кадр, шаги и ширину: остальные зависимости из него следуют.
  }, [previewKey]);

  // Задание рендера: запущенное здесь или идущее на открытом плане (из снимка, страница открыта заново).
  const running = job?.info.status === 'running' ? job : selected?.jobId ? { shot: selected.shot, id: selected.jobId } : null;
  const runningId = running ? ('info' in running ? running.info.id : running.id) : null;
  const runningShot = running?.shot ?? null;
  useEffect(() => {
    if (!runningId || !runningShot) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      const info = await window.api.jobs.get(runningId).catch(() => null);
      if (!active) return;
      if (info) setJob({ shot: runningShot, info });
      if (info && info.status !== 'running') {
        if (info.status === 'done') notify(texts.applied, 'success');
        await load();
        return;
      }
      timer = setTimeout(() => void poll(), JOB_POLL_MS);
    };
    timer = setTimeout(() => void poll(), JOB_POLL_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [load, notify, runningId, runningShot]);

  const busy = pending || !!runningId;
  const jobForShot = job && selected && job.shot === selected.shot ? job.info : null;

  const apply = async (): Promise<void> => {
    if (!selected || busy) return;
    const asked = project;
    setPending(true);
    setActionError(null);
    try {
      const info = await window.api.effects.render(project, selected.shot, draft);
      if (current.current === asked) setJob({ shot: selected.shot, info });
    } catch (failure) {
      if (current.current === asked) setActionError(describeError(failure));
    } finally {
      if (current.current === asked) setPending(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!selected || busy) return;
    const asked = project;
    setPending(true);
    setActionError(null);
    setReleasing(true);
    try {
      // Плеер успевает отпустить файл до удаления.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const next = await window.api.effects.remove(project, selected.shot);
      if (current.current !== asked) return;
      setView(next);
      setDrafts((value) => {
        const rest = { ...value };
        delete rest[selected.shot];
        return rest;
      });
      notify(texts.removed, 'success');
    } catch (failure) {
      if (current.current === asked) setActionError(describeError(failure));
    } finally {
      if (current.current === asked) {
        setPending(false);
        setReleasing(false);
      }
    }
  };

  const copyFrom = (source: EffectShot): void => {
    if (!selected || busy) return;
    change(editableSteps(source.steps));
    notify(texts.copied({ shot: source.shot }), 'info');
  };

  const reasons = {
    apply: busy ? texts.busy : !draft.length ? texts.noSteps : !dirty && selected?.applied && !selected.stale ? texts.noChanges : null,
    reset: busy ? texts.busy : !dirty ? texts.noChanges : null,
    remove: busy ? texts.busy : null
  };

  return {
    project,
    view,
    loadError,
    load,
    shots,
    selected,
    select,
    draft,
    dirty,
    change,
    reset: () => selected && !busy && change(saved),
    frame,
    setFrame,
    mode,
    setMode,
    full,
    setFull,
    // Пока считается новый кадр, прежний остаётся на экране с признаком загрузки.
    preview: preview.key === previewKey ? preview : { ...preview, error: null, loading: !!previewKey },
    busy,
    job: jobForShot,
    actionError,
    releasing,
    reasons,
    apply,
    remove,
    copyFrom
  };
}
