import { useCallback, useEffect, useRef } from 'react';

/** Уход с карточки и смена источника останавливают даже ещё не завершившийся запуск видео. */
export function useScenePreview(source: string | null) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hovered = useRef(false);

  const pause = useCallback((): void => {
    hovered.current = false;
    videoRef.current?.pause();
  }, []);

  const play = useCallback((): void => {
    hovered.current = true;
    const video = videoRef.current;
    if (!video) return;
    video.muted = true;
    void video
      .play()
      .then(() => {
        if (!hovered.current || videoRef.current !== video) video.pause();
      })
      .catch(() => {
        // Запрет автозапуска или прерывание загрузки не должны ломать выбор сцены.
      });
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    return () => {
      hovered.current = false;
      video?.pause();
    };
  }, [source]);

  return { videoRef, play, pause };
}
