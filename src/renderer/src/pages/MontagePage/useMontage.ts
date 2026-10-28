import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { MontageApi, MontageDraft, MontageSource, MontageView } from '@shared/montage';
import type { JobInfo } from '@shared/types';
import { useApp } from '../../state';
import { clipLength, historyReducer, initialDraft, montageLength, moveClip, sourceClip } from './model';

const EMPTY: MontageDraft = {
  schema_version: 1,
  name: 'Монтажная проба',
  audio: { path: '', start_frame: 0, end_frame_exclusive: 0 },
  clips: [],
  base_scenes_sha256: '',
  base_manifest_sha256: {}
};
const api = (): MontageApi => (window.api as typeof window.api & { montage: MontageApi }).montage;

/** Ответы старого проекта не попадают в новый монтаж; черновик хранит исходные хеши до явного переоткрытия. */
export function useMontage(project: string, shots: string[], preferred: Record<string, string> = {}) {
  const { describeError, notify } = useApp();
  const alive = useRef(true);
  const requestId = useRef(0);
  const metadata = useRef<Record<string, number>>({});
  const [view, setView] = useState<MontageView | null>(null);
  const [sources, setSources] = useState<MontageSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedId, setSavedId] = useState<string | undefined>();
  const [baseline, setBaseline] = useState<MontageDraft>(EMPTY);
  const [history, dispatch] = useReducer(historyReducer, { past: [], present: EMPTY, future: [] });
  const [selected, setSelected] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [seekVersion, setSeekVersion] = useState(0);
  const seek = (next: number): void => {
    setFrame(next);
    setSeekVersion((value) => value + 1);
  };
  const [job, setJob] = useState<JobInfo | null>(null);
  const [jobAction, setJobAction] = useState<'export' | 'apply' | null>(null);
  const [video, setVideo] = useState<string | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const draft = history.present;
  const commit = useCallback((next: MontageDraft) => dispatch({ type: 'commit', draft: next }), []);
  const snapshot = useCallback(
    (next: MontageDraft): MontageDraft => ({
      ...next,
      clips: next.clips.map((clip) => {
        const frames = metadata.current[clip.path];
        return frames
          ? {
              ...clip,
              source_frames: frames,
              source_start_frame: Math.min(clip.source_start_frame, frames - 1),
              source_end_frame_exclusive: Math.min(clip.source_end_frame_exclusive, frames)
            }
          : clip;
      })
    }),
    []
  );

  const load = useCallback(async (): Promise<void> => {
    const request = ++requestId.current;
    setError(null);
    setBusy(true);
    try {
      const next = await api().view(project);
      if (!alive.current || request !== requestId.current) return;
      setView(next);
      setSources(next.sources);
      const initial = snapshot(initialDraft(next, shots, next.trackPath ?? '', preferred));
      dispatch({ type: 'reset', draft: initial });
      // Новая проба ещё не сохранена, но само открытие не является правкой.
      setBaseline(initial);
      setSavedId(undefined);
      setSelected(initial.clips[0]?.id ?? null);
      setFrame(0);
      // Открытие черновика — явная перемотка, даже если путь музыки и границы участка совпадают.
      setSeekVersion((value) => value + 1);
      setJob(null);
      setVideo(null);
    } catch (cause) {
      if (alive.current && request === requestId.current) setError(describeError(cause));
    } finally {
      if (alive.current && request === requestId.current) setBusy(false);
    }
  }, [project, shots, preferred, snapshot, describeError]);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      requestId.current += 1;
    };
  }, [load]);

  const onMetadata = useCallback((path: string, frames: number): void => {
    if (!alive.current || metadata.current[path] === frames) return;
    metadata.current[path] = frames;
    setSources((current) => current.map((source) => (source.path === path ? { ...source, frames } : source)));
    dispatch({ type: 'metadata', path, frames });
  }, []);

  const operate = async (action: () => Promise<void>): Promise<void> => {
    const request = requestId.current;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      if (alive.current && requestId.current === request) setError(describeError(cause));
    } finally {
      if (alive.current && requestId.current === request) setBusy(false);
    }
  };
  const save = (asNew = false): Promise<void> =>
    operate(async () => {
      const captured = draft;
      const saved = await api().save(project, captured, asNew ? undefined : savedId);
      if (!alive.current) return;
      setSavedId(saved.id);
      setBaseline(captured);
      setView((current) => (current ? { ...current, saved: [saved, ...current.saved.filter((item) => item.id !== saved.id)] } : current));
      notify('Монтажный черновик сохранён', 'success');
    });
  const open = (id: string): Promise<void> =>
    operate(async () => {
      const saved = snapshot(await api().load(project, id));
      if (!alive.current) return;
      dispatch({ type: 'reset', draft: saved });
      setSavedId(id);
      setBaseline(saved);
      setSelected(saved.clips[0]?.id ?? null);
      setFrame(0);
      // Открытие черновика — явная перемотка, даже если путь музыки и границы участка совпадают.
      setSeekVersion((value) => value + 1);
      setVideo(null);
      setJob(null);
    });
  const exportVideo = (): Promise<void> =>
    operate(async () => {
      const exported = await api().export(project, draft);
      if (!alive.current) return;
      setJob(exported.job);
      setJobAction('export');
      setVideo(exported.video);
    });
  const apply = (): Promise<void> =>
    operate(async () => {
      const started = await api().apply(project, draft);
      if (!alive.current) return;
      setJob(started);
      setJobAction('apply');
      setVideo(null);
      setApplyOpen(false);
    });
  const saveVideo = (): Promise<void> =>
    operate(async () => {
      if (!video) return;
      const path = await api().saveVideo(project, video);
      if (alive.current && path) notify(`Проба сохранена: ${path}`, 'success');
    });

  const jobId = job?.id;
  const jobStatus = job?.status;
  useEffect(() => {
    if (!jobId || jobStatus !== 'running') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      try {
        const next = await window.api.jobs.get(jobId);
        if (cancelled || !alive.current) return;
        if (!next) {
          setError('Задание монтажа больше не найдено в истории.');
          return;
        }
        if (next.status === 'done' && jobAction === 'apply') {
          const refreshed = await api().view(project);
          if (cancelled || !alive.current) return;
          setView(refreshed);
          notify('Монтаж применён. Переоткройте материалы перед следующими изменениями сцен.', 'success');
        }
        setJob(next);
        if (next.status !== 'running') return;
      } catch (cause) {
        if (!cancelled && alive.current) setError(describeError(cause));
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 1200);
    };
    timer = setTimeout(() => void poll(), 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jobId, jobStatus, jobAction, project, notify, describeError]);

  useEffect(() => {
    if (view?.scenarioStatus !== 'ready') return;
    const handler = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || applyOpen || busy || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return;
      if ((event.target as HTMLElement)?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key.toLowerCase() === 'z') {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? 'redo' : 'undo' });
      }
      if (event.key.toLowerCase() === 'y') {
        event.preventDefault();
        dispatch({ type: 'redo' });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [applyOpen, busy, view?.scenarioStatus]);

  // Стабильный обработчик позволяет каталогу пропускать кадровые обновления плеера.
  const addSource = useCallback(
    (id: string, before: string | null = null): void => {
      const source = sources.find((item) => item.id === id);
      if (!source || !view) return;
      const existing = draft.clips.find((clip) => clip.scene === source.scene);
      const canonical = view.scenes.find((scene) => scene.id === source.scene);
      const clip = sourceClip(source, existing ? clipLength(existing) : canonical ? canonical.endFrame - canonical.startFrame : (source.frames ?? 1));
      if (existing) commit({ ...draft, clips: draft.clips.map((item) => (item.id === existing.id ? { ...clip, id: existing.id } : item)) });
      else {
        const clips = [...draft.clips, clip];
        const audio = draft.clips.length
          ? draft.audio
          : { ...draft.audio, start_frame: canonical?.startFrame ?? 0, end_frame_exclusive: canonical?.endFrame ?? clipLength(clip) };
        commit({ ...draft, audio, clips: moveClip(clips, clip.id, before) });
      }
      // При замене сохраняется id фрагмента на дорожке, поэтому выделение должно ссылаться на него же.
      setSelected(existing?.id ?? clip.id);
    },
    [sources, view, draft, commit]
  );
  const audioLength = draft.audio.end_frame_exclusive - draft.audio.start_frame;
  const length = montageLength(draft.clips);
  const stale =
    !!view &&
    (draft.base_scenes_sha256 !== view.scenesSha256 || draft.clips.some((clip) => draft.base_manifest_sha256[clip.scene] !== view.manifestSha256[clip.scene]));
  const unknown = draft.clips.some((clip) => clip.kind === 'video' && clip.source_frames === null);
  const exportProblem = !draft.clips.length
    ? 'Добавьте хотя бы один фрагмент.'
    : !draft.audio.path
      ? 'В проекте нет музыкальной дорожки.'
      : unknown
        ? 'Ожидаем метаданные длины видео. Если загрузка не завершится, проверьте доступность исходников.'
        : length !== audioLength
          ? `Музыка: ${audioLength} кадров, видео: ${length} кадров. Разница ${length - audioLength > 0 ? '+' : ''}${length - audioLength} кадров. Выровняйте выделение музыки или обрежьте видео.`
          : null;
  return {
    project,
    view,
    sources,
    error,
    setError,
    busy,
    draft,
    history,
    commit,
    dispatch,
    selected,
    setSelected,
    frame,
    setFrame,
    seek,
    seekVersion,
    savedId,
    // Прочитанная длительность видео уточняет и базу: метаданные не являются монтажной правкой.
    dirty: JSON.stringify(snapshot(baseline)) !== JSON.stringify(draft),
    save,
    open,
    load,
    addSource,
    onMetadata,
    exportVideo,
    apply,
    applyOpen,
    setApplyOpen,
    job,
    jobAction,
    video,
    saveVideo,
    stale,
    exportProblem,
    length,
    audioLength
  };
}
