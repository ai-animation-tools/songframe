/** Загрузка сборки, наблюдение за заданиями и переходы плеера для страницы аниматика. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AnimaticShot, AnimaticView, JobInfo } from '@shared/types';
import { useApp } from '../../state';

export function useAnimaticPage() {
  const { state, notify, describeError, refresh } = useApp();
  const project = state?.current ?? '';
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<AnimaticView | null>(null);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [time, setTime] = useState(0);
  const [confirm, setConfirm] = useState<'approved' | 'review' | null>(null);
  const [params, setParams] = useSearchParams();
  const videoRef = useRef<HTMLVideoElement>(null);
  const requestedShot = params.get('shot');

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setView(await window.api.animatic.view(project));
    } catch (error) {
      setLoadError(describeError(error));
    }
  }, [project, describeError]);
  const loadJobs = useCallback(async () => setJobs((await window.api.jobs.list()).filter((j) => j.kind === 'animatic')), []);
  useEffect(() => {
    void load();
    void loadJobs();
  }, [load, loadJobs]);

  const running = jobs.some((j) => j.status === 'running');
  useEffect(() => {
    if (!running) return;
    const handle = setInterval(async () => {
      const before = jobs.filter((j) => j.status === 'running').map((j) => j.id);
      const after = await window.api.jobs.list();
      setJobs(after.filter((j) => j.kind === 'animatic'));
      const finished = after.filter((j) => before.includes(j.id) && j.status !== 'running');
      if (finished.length) {
        await load();
        await refresh();
        const failed = finished.filter((j) => j.status === 'failed');
        notify(failed.length ? `${failed[0].title}: ошибка, см. журнал` : `${finished[0].title}: готово`, failed.length ? 'error' : 'success');
      }
    }, 2000);
    return () => clearInterval(handle);
  }, [running, jobs, load, loadJobs, refresh, notify]);

  const shots = useMemo(() => view?.shots ?? [], [view]);
  const current = useMemo(
    () => shots.find((s) => time >= s.start && time < s.end) ?? (shots.length > 0 && time >= shots[shots.length - 1].end ? shots[shots.length - 1] : null),
    [shots, time]
  );
  const duration = view?.built?.duration ?? (shots.length ? shots[shots.length - 1].end : 0);

  const seek = (shot: AnimaticShot): void => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = shot.start + 0.001;
    setTime(shot.start + 0.001);
    setParams({ shot: shot.id }, { replace: true });
  };

  // Ссылка может измениться без размонтирования страницы; ждём метаданные нового видео.
  const seekRequested = useCallback(() => {
    const shot = shots.find((item) => item.id === requestedShot);
    const video = videoRef.current;
    if (!shot || !video || video.readyState < 1) return;
    video.currentTime = shot.start + 0.001;
    setTime(shot.start + 0.001);
  }, [requestedShot, shots]);
  useEffect(() => {
    seekRequested();
  }, [seekRequested]);

  const build = async (planOnly: boolean): Promise<void> => {
    try {
      await window.api.animatic.build(project, planOnly);
      await loadJobs();
    } catch (error) {
      notify(describeError(error), 'error');
    }
  };

  // Выполняющаяся сборка не должна менять статус принятия.
  const setStatus = async (status: 'approved' | 'review'): Promise<void> => {
    if (running) return;
    setConfirm(null);
    try {
      setView(await window.api.animatic.setStatus(project, status));
      await refresh();
      notify(status === 'approved' ? 'Результат принят' : 'Возвращено на просмотр', 'success');
    } catch (error) {
      notify(describeError(error), 'error');
    }
  };

  const built = view?.built;
  // Принятие сохраняет силу только для свежего реестра и текущего хеша видео.
  const accepted = !!view?.approval.current && !!built?.fresh;
  const videoUrl = built?.videoPath ? `${window.api.shell.fileUrl(built.videoPath)}?v=${built.videoSha256 ?? built.builtAt}` : undefined;
  const openFolder = (): void => {
    if (!built?.videoPath) return;
    void window.api.shell.openPath(built.videoPath.replace(/[\\/][^\\/]+$/, '')).catch((error) => notify(describeError(error), 'error'));
  };

  return {
    loadError,
    view,
    jobs,
    time,
    confirm,
    setConfirm,
    videoRef,
    running,
    shots,
    current,
    duration,
    seek,
    seekRequested,
    setTime,
    build,
    setStatus,
    load,
    loadJobs,
    accepted,
    videoUrl,
    openFolder
  };
}
