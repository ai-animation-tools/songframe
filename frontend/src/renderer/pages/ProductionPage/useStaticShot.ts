/**
 * Шаг «Сборка» плана из опор: снимок production.staticShot, черновик моментов смены и
 * параметров, сборка предпросмотра и приёмка заданиями. Черновик живёт в панели до сохранения;
 * сборка сначала сохраняет изменённый черновик, чтобы предпросмотр соответствовал показанным
 * значениям. Принимается только свежий предпросмотр: это проверяет и Go.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobInfo, StaticShotRecipe, StaticShotView } from '@shared/types';
import { productionTexts } from '@shared/texts/production';
import { useApp } from '../../state';

const texts = productionTexts.staticShot;

/**
 * Черновик формы: кадры смены и растворение в секундах по порядку опор и параметры — строками,
 * как их набирает пользователь.
 */
export interface StaticShotDraft {
  from: string[];
  dissolve: string[];
  params: Record<string, string>;
}

/** Секунды растворения для поля: до сотых, без хвостовых нулей. */
function dissolveSeconds(frames: number, fps: number): string {
  return String(Math.round((frames / fps) * 100) / 100);
}

/** Черновик по сохранённому снимку. */
export function staticDraft(view: StaticShotView | null): StaticShotDraft {
  return {
    from: view?.states.map((state) => String(state.fromFrame)) ?? [],
    dissolve: view?.states.map((state) => dissolveSeconds(state.dissolveFrames, view.fps)) ?? [],
    params: Object.fromEntries((view?.specs ?? []).map((spec) => [spec.name, String(view?.params[spec.name] ?? spec.default)]))
  };
}

/** Растворение состояния в кадрах проекта по секундам поля; null — не число или меньше 0. */
export function dissolveFrames(text: string, fps: number): number | null {
  const value = Number(text.trim().replace(',', '.'));
  return text.trim() === '' || !Number.isFinite(value) || value < 0 ? null : Math.round(value * fps);
}

/**
 * Рецепт из черновика или текст первой ошибки: кадр смены — целое число, база с кадра 0, смены по
 * возрастанию внутри плана; растворение — секунды не меньше 0, кончается не позже следующей смены и
 * конца плана (у базовой опоры его нет); параметр — число в своём диапазоне, целое при шаге 1.
 */
export function staticRecipe(view: StaticShotView, draft: StaticShotDraft): StaticShotRecipe | string {
  const states: StaticShotRecipe['states'] = [];
  for (const [index, state] of view.states.entries()) {
    const text = draft.from[index]?.trim() ?? '';
    const frame = Number(text);
    if (text === '' || !Number.isInteger(frame)) return texts.frameInteger({ frame: state.frame });
    if (index === 0 && frame !== 0) return texts.baseFromZero;
    if (index > 0 && (frame <= states[index - 1].from_frame || frame >= view.frames)) return texts.frameOrder({ frame: state.frame, frames: view.frames });
    states.push({ frame: state.frame, from_frame: frame });
  }
  for (const [index, state] of states.entries()) {
    if (index === 0) continue;
    const frames = dissolveFrames(draft.dissolve[index] ?? '0', view.fps);
    if (frames === null) return texts.dissolveNumber({ frame: state.frame });
    const last = index === states.length - 1;
    const end = last ? view.frames : states[index + 1].from_frame;
    if (state.from_frame + frames > end) return texts.dissolveEnd({ frame: state.frame, end, last });
    if (frames > 0) state.dissolve_frames = frames;
  }
  const params: Record<string, number> = {};
  for (const spec of view.specs) {
    const text = draft.params[spec.name]?.trim() ?? '';
    const value = Number(text);
    if (text === '' || !Number.isFinite(value) || value < spec.min || value > spec.max || (spec.step >= 1 && !Number.isInteger(value)))
      return texts.paramRange({ title: spec.title, min: spec.min, max: spec.max });
    params[spec.name] = value;
  }
  return { schema_version: 1, states, params };
}

/** Опрос задания сборки или приёмки: чаще, чем снимок страницы, чтобы итог появился сразу. */
const JOB_POLL_MS = 1000;

export function useStaticShot(project: string, packageDir: string, hasAsset: boolean, onApplied: () => Promise<void>) {
  const { notify, describeError } = useApp();
  const [view, setView] = useState<StaticShotView | null>(null);
  const [draft, setDraft] = useState<StaticShotDraft>(() => staticDraft(null));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<{ kind: 'build' | 'accept'; info: JobInfo } | null>(null);
  const [replacement, setReplacement] = useState(false);
  const key = `${project}\0${packageDir}`;
  const current = useRef(key);
  current.current = key;
  const callbacks = useRef({ onApplied });
  callbacks.current = { onApplied };

  const load = useCallback(
    async (keepDraft: boolean) => {
      const asked = key;
      try {
        const next = await window.api.production.staticShot(project, packageDir);
        if (current.current !== asked) return;
        // Задание запущено до открытия панели (например, на другом плане): следим за ним дальше.
        if (next.jobId) {
          const info = await window.api.jobs.get(next.jobId).catch(() => null);
          if (current.current !== asked) return;
          if (info?.status === 'running') setJob((value) => (value?.info.id === info.id ? value : { kind: info.kind === 'accept' ? 'accept' : 'build', info }));
        }
        setView(next);
        if (!keepDraft) setDraft(staticDraft(next));
        setError(null);
      } catch (failure) {
        if (current.current === asked) setError(describeError(failure));
      }
    },
    [describeError, key, packageDir, project]
  );

  useEffect(() => {
    setView(null);
    setDraft(staticDraft(null));
    setJob(null);
    setError(null);
    setReplacement(false);
    void load(false);
  }, [load]);

  // Задание сборки или приёмки: по завершении снимок перечитывается, принятый план обновляет страницу.
  const jobId = job?.info.status === 'running' ? job.info.id : null;
  const jobKind = job?.kind;
  useEffect(() => {
    if (!jobId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      const info = await window.api.jobs.get(jobId).catch(() => null);
      if (!active) return;
      if (info && info.status !== 'running') {
        setJob((value) => (value && value.info.id === info.id ? { ...value, info } : value));
        if (info.status === 'done' && jobKind === 'accept') {
          notify(texts.accepted, 'success');
          await callbacks.current.onApplied();
        } else await load(true);
        return;
      }
      timer = setTimeout(() => void poll(), JOB_POLL_MS);
    };
    timer = setTimeout(() => void poll(), JOB_POLL_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [jobId, jobKind, load, notify]);

  const busy = pending || job?.info.status === 'running';
  const saved = staticDraft(view);
  const dirty = !!view && JSON.stringify(saved) !== JSON.stringify(draft);
  const recipe = view ? staticRecipe(view, draft) : null;
  const recipeProblem = typeof recipe === 'string' ? recipe : null;
  const reasons = {
    save: busy ? texts.busy : !dirty ? texts.noChanges : recipeProblem,
    build: busy ? texts.busy : (recipeProblem ?? (view?.problem || null)),
    accept: busy ? texts.busy : !view?.preview ? texts.previewMissing : dirty || !view.preview.fresh ? texts.previewStale : null
  };

  const guarded = async (action: () => Promise<void>): Promise<void> => {
    const asked = key;
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      if (current.current === asked) {
        const message = describeError(failure);
        setError(message);
        notify(message, 'error');
      }
    } finally {
      if (current.current === asked) setPending(false);
    }
  };

  const persist = async (): Promise<StaticShotView | null> => {
    if (!view || typeof recipe !== 'object' || !recipe) return null;
    const next = await window.api.production.saveStaticRecipe(project, packageDir, recipe);
    setView(next);
    setDraft(staticDraft(next));
    return next;
  };

  const save = (): Promise<void> =>
    reasons.save
      ? Promise.resolve()
      : guarded(async () => {
          if (await persist()) notify(texts.saved, 'success');
        });

  const build = (): Promise<void> =>
    reasons.build
      ? Promise.resolve()
      : guarded(async () => {
          if (dirty && !(await persist())) return;
          const info = await window.api.production.buildStatic(project, packageDir);
          setJob({ kind: 'build', info });
        });

  const accept = (replace: boolean): Promise<void> =>
    reasons.accept || !view
      ? Promise.resolve()
      : guarded(async () => {
          const info = await window.api.production.acceptStatic(project, view.shot, packageDir, replace);
          setReplacement(false);
          setJob({ kind: 'accept', info });
        });

  return {
    view,
    draft,
    busy,
    dirty,
    error,
    job: job?.info ?? null,
    reasons,
    change: (next: StaticShotDraft) => {
      if (!busy) setDraft(next);
    },
    reset: () => {
      if (!busy) setDraft(saved);
    },
    retry: () => load(true),
    save,
    build,
    /** Замена принятого комплекта — отдельное подтверждение; без комплекта приёмка сразу. */
    requestAccept: () => (hasAsset ? setReplacement(true) : void accept(false)),
    replacement,
    closeReplacement: () => setReplacement(false),
    confirmReplacement: () => accept(true)
  };
}
