/** Чтение сохранённого отчёта и опрос только выполняющейся проверки выбранного пакета. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoReviewView } from '@shared/video-review';
import { videoReviewTexts } from '@shared/texts/video-review';
import { useApp } from '../../state';

const running = (view: VideoReviewView | null): boolean => view?.status === 'preparing' || view?.status === 'running';

export function useVideoReview(packageDir: string) {
  const { state, describeError, notify } = useApp();
  const project = state?.current ?? null;
  const context = `${project ?? ''}\0${packageDir}`;
  const contextRef = useRef(context);
  contextRef.current = context;
  const revision = useRef(0);
  const active = useRef(false);
  const mutating = useRef(false);
  const reading = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef<VideoReviewView | null>(null);
  const [snapshot, setSnapshot] = useState<{ context: string; view: VideoReviewView | null }>({ context, view: null });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const invalidate = useCallback(() => {
    revision.current++;
  }, []);
  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const show = useCallback(
    (next: VideoReviewView, announce = true) => {
      if (announce && running(current.current) && !running(next)) {
        if (next.status === 'completed') notify(videoReviewTexts.readyNotice, 'success');
        else if (next.status === 'failed') notify(next.error ?? videoReviewTexts.main.jobFailed, 'error');
        else if (next.status === 'cancelled') notify(videoReviewTexts.main.cancelled, 'info');
      }
      current.current = next;
      setSnapshot({ context, view: next });
    },
    [context, notify]
  );

  const read = useCallback(
    async (manual = false): Promise<void> => {
      if (!project || mutating.current || reading.current) return;
      clearTimer();
      const version = ++revision.current;
      const valid = (): boolean => active.current && contextRef.current === context && revision.current === version;
      if (manual) {
        reading.current = true;
        setRefreshing(true);
        setPending(true);
      }
      let poll = false;
      try {
        const next = await window.api.videoReview.view(project, packageDir);
        if (!valid()) return;
        // Успешное ручное чтение сохранённого failed не является новой ошибкой запуска агента.
        show(next, !manual);
        setError(null);
        if (manual) notify(next.status === 'failed' ? videoReviewTexts.refreshedFailed : videoReviewTexts.refreshed, 'info');
        poll = running(next);
      } catch (reason) {
        if (!valid()) return;
        const message = describeError(reason);
        setError(message);
        if (manual) notify(message, 'error');
        // Ошибка опроса оставляет последнее выполняющееся задание и его отмену доступными.
        poll = running(current.current);
      } finally {
        if (valid()) {
          if (manual) {
            reading.current = false;
            setRefreshing(false);
            setPending(false);
          }
          if (poll) timer.current = setTimeout(() => void read(), 1500);
        }
      }
    },
    [project, packageDir, context, clearTimer, show, describeError, notify]
  );

  useEffect(() => {
    active.current = true;
    invalidate();
    current.current = null;
    mutating.current = false;
    reading.current = false;
    setRefreshing(false);
    setSnapshot({ context, view: null });
    setError(null);
    setPending(false);
    void read();
    return () => {
      active.current = false;
      invalidate();
      clearTimer();
    };
  }, [context, read, clearTimer, invalidate]);

  const execute = useCallback(
    async (operation: 'start' | 'cancel'): Promise<void> => {
      if (!project || mutating.current || reading.current) return;
      clearTimer();
      mutating.current = true;
      const version = ++revision.current;
      const valid = (): boolean => active.current && contextRef.current === context && revision.current === version;
      setPending(true);
      setError(null);
      try {
        const next = await window.api.videoReview[operation](project, packageDir);
        if (!valid()) return;
        show(next);
      } catch (reason) {
        if (!valid()) return;
        const message = describeError(reason);
        setError(message);
        notify(message, 'error');
      } finally {
        if (valid()) {
          mutating.current = false;
          setPending(false);
          // Новый опрос не конкурирует с командой запуска/отмены и не затирает её ошибку немедленно.
          if (running(current.current)) timer.current = setTimeout(() => void read(), 1500);
        }
      }
    },
    [project, packageDir, context, clearTimer, show, describeError, notify, read]
  );

  return {
    view: snapshot.context === context ? snapshot.view : null,
    error,
    pending,
    refreshing,
    projectAvailable: !!project,
    refresh: () => read(true),
    start: () => execute('start'),
    cancel: () => execute('cancel')
  };
}
