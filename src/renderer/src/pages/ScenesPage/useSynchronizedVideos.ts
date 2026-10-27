import { useCallback, useEffect, useRef, useState } from 'react';
import { mapAcceptedTime, type VideoComparisonEdit } from './videoComparison';

interface ComparisonOptions {
  edit: VideoComparisonEdit | null;
  originalPath: string | null;
  videoPath: string | null;
}

/** Принятый монтаж ведёт оба проигрывателя; оригинал повторяет обрезку, скорость и удержания рецепта. */
export function useSynchronizedVideos({ edit, originalPath, videoPath }: ComparisonOptions) {
  const originalRef = useRef<HTMLVideoElement>(null);
  const acceptedRef = useRef<HTMLVideoElement>(null);
  const toggleRef = useRef<() => void>(() => {});
  const [synchronized, setSynchronized] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const original = originalRef.current;
    const accepted = acceptedRef.current;
    setSynchronized(false);
    setReady(false);
    setError(null);
    if (!edit || !original || !accepted || !originalPath || !videoPath) {
      toggleRef.current = () => {};
      return;
    }

    let disposed = false;
    let active = false;
    let frame = 0;
    let epoch = 0;
    let originalRequest = 0;
    let originalPending = false;
    let settings: { muted: boolean; originalRate: number; acceptedRate: number } | null = null;
    const metadataReady = (): boolean => original.readyState >= 1 && accepted.readyState >= 1 && !original.error && !accepted.error;
    const updateReady = (): void => setReady(metadataReady());

    const stop = (): void => {
      active = false;
      epoch += 1;
      originalRequest += 1;
      originalPending = false;
      cancelAnimationFrame(frame);
      original.pause();
      accepted.pause();
      if (settings) {
        original.muted = settings.muted;
        original.playbackRate = settings.originalRate;
        accepted.playbackRate = settings.acceptedRate;
        settings = null;
      }
      if (!disposed) setSynchronized(false);
    };
    const fail = (reason: unknown): void => {
      stop();
      if (!disposed) setError(`Не удалось включить синхронное сравнение: ${reason instanceof Error ? reason.message : String(reason)}`);
    };

    const align = (force = false): void => {
      if (!active || disposed) return;
      const mapped = mapAcceptedTime(edit, accepted.currentTime, original.duration, accepted.duration);
      original.muted = true;
      accepted.playbackRate = 1;
      original.playbackRate = mapped.playbackRate;
      if (force || Math.abs(original.currentTime - mapped.sourceTime) > 0.08) original.currentTime = mapped.sourceTime;
      if (mapped.frozen) {
        // На удержаниях оставляем именно крайний кадр, а не продолжающий идти оригинал.
        originalRequest += 1;
        originalPending = false;
        original.pause();
        if (Math.abs(original.currentTime - mapped.sourceTime) > 0.001) original.currentTime = mapped.sourceTime;
      } else if (original.paused && !originalPending) {
        const request = ++originalRequest;
        const startedEpoch = epoch;
        originalPending = true;
        void original
          .play()
          .then(() => {
            if (disposed || !active || mapAcceptedTime(edit, accepted.currentTime, original.duration, accepted.duration).frozen) original.pause();
            if (request === originalRequest) originalPending = false;
          })
          .catch((reason: unknown) => {
            if (request === originalRequest) {
              originalPending = false;
              if (!disposed && active && epoch === startedEpoch) fail(reason);
            }
          });
      }
    };
    const tick = (): void => {
      if (!active || disposed) return;
      try {
        align();
        if (active) frame = requestAnimationFrame(tick);
      } catch (reason) {
        fail(reason);
      }
    };
    const onAcceptedSeek = (): void => {
      try {
        align(true);
      } catch (reason) {
        fail(reason);
      }
    };
    const onAcceptedPause = (): void => {
      if (active) {
        onAcceptedSeek();
        stop();
      }
    };
    const onAcceptedPlay = (): void => {
      if (active) onAcceptedSeek();
    };
    const onMediaError = (): void => {
      setReady(false);
      fail(new Error('Не удалось загрузить одно из видео.'));
    };
    const onEmptied = (): void => {
      if (active) stop();
      setReady(false);
    };

    toggleRef.current = (): void => {
      if (active) {
        stop();
        return;
      }
      if (disposed || !metadataReady()) return;
      setError(null);
      settings = { muted: original.muted, originalRate: original.playbackRate, acceptedRate: accepted.playbackRate };
      active = true;
      const startedEpoch = ++epoch;
      setSynchronized(true);
      if (accepted.ended || accepted.currentTime >= accepted.duration) accepted.currentTime = 0;
      // Оба play вызываются из пользовательского действия, а поздние ответы проверяют актуальность сессии.
      try {
        align(true);
        if (!active) return;
        void accepted
          .play()
          .then(() => {
            if (disposed || !active) accepted.pause();
          })
          .catch((reason: unknown) => {
            if (!disposed && active && epoch === startedEpoch) fail(reason);
          });
        frame = requestAnimationFrame(tick);
      } catch (reason) {
        fail(reason);
      }
    };

    for (const video of [original, accepted]) {
      video.addEventListener('loadedmetadata', updateReady);
      video.addEventListener('durationchange', updateReady);
      video.addEventListener('error', onMediaError);
      video.addEventListener('emptied', onEmptied);
    }
    accepted.addEventListener('play', onAcceptedPlay);
    accepted.addEventListener('pause', onAcceptedPause);
    accepted.addEventListener('ended', onAcceptedPause);
    accepted.addEventListener('seeking', onAcceptedSeek);
    accepted.addEventListener('seeked', onAcceptedSeek);
    updateReady();

    return () => {
      disposed = true;
      toggleRef.current = () => {};
      stop();
      for (const video of [original, accepted]) {
        video.removeEventListener('loadedmetadata', updateReady);
        video.removeEventListener('durationchange', updateReady);
        video.removeEventListener('error', onMediaError);
        video.removeEventListener('emptied', onEmptied);
      }
      accepted.removeEventListener('play', onAcceptedPlay);
      accepted.removeEventListener('pause', onAcceptedPause);
      accepted.removeEventListener('ended', onAcceptedPause);
      accepted.removeEventListener('seeking', onAcceptedSeek);
      accepted.removeEventListener('seeked', onAcceptedSeek);
    };
  }, [edit, originalPath, videoPath]);

  const toggle = useCallback(() => toggleRef.current(), []);
  return { originalRef, acceptedRef, synchronized, ready, error, toggle };
}
