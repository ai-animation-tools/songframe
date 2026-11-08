import { FPS } from '@shared/video';

type AudioClock = Pick<HTMLAudioElement, 'currentTime' | 'paused' | 'ended' | 'play' | 'pause'>;

interface PlaybackOptions {
  range: () => { start: number; end: number; loop: boolean };
  previewWindow?: () => { start: number; end: number } | null;
  onFrame: (frame: number) => void;
  onPlaying: (playing: boolean) => void;
  onError: (error: unknown) => void;
}

/** Границы проверки стыка выражены в кадрах относительно начала музыкального участка. */
export function cutPreviewWindow(cut: number, length: number): { start: number; end: number } | null {
  if (cut <= 0 || cut >= length) return null;
  return { start: Math.max(0, cut - 2 * FPS), end: Math.min(length, cut + 2 * FPS) };
}

/** Аудио ведёт часы; только явная перемотка и граница участка меняют его currentTime.
 * Номер запуска отделяет штатную отмену play() от ошибки актуального воспроизведения. */
export function createMontagePlayback(audio: AudioClock, options: PlaybackOptions) {
  let alive = true;
  let intended = false;
  let pending = false;
  let generation = 0;
  let published: number | undefined;

  const publish = (frame: number): void => {
    if (!alive || frame === published) return;
    published = frame;
    options.onFrame(frame);
  };

  const pause = (): void => {
    intended = false;
    pending = false;
    generation += 1;
    audio.pause();
    if (alive) options.onPlaying(false);
  };

  const play = (): void => {
    if (!alive || pending || (intended && !audio.paused && !audio.ended)) return;
    intended = true;
    pending = true;
    const request = ++generation;
    options.onPlaying(true);
    const fail = (error: unknown): void => {
      if (!alive || !intended || request !== generation) return;
      pause();
      options.onError(error);
    };
    try {
      void audio.play().then(() => {
        if (alive && request === generation) pending = false;
      }, fail);
    } catch (error) {
      fail(error);
    }
  };

  const seek = (frame: number): void => {
    if (!alive) return;
    const { start, end } = options.range();
    const length = Math.max(0, end - start);
    const position = Math.max(0, Math.min(Math.max(0, length - 1), frame));
    if (!length) pause();
    audio.currentTime = (start + position) / FPS;
    publish(position);
  };

  const finish = (): void => {
    if (!alive || !intended) return;
    const { start, end, loop } = options.range();
    const window = options.previewWindow?.();
    if (loop && end > start) {
      seek(window?.start ?? 0);
      // Внутри длинного файла seek сохраняет воспроизведение; play нужен лишь после естественного конца файла.
      if (audio.paused || audio.ended) play();
    } else {
      pause();
      if (window) seek(window.end - 1);
      else publish(Math.max(0, end - start - 1));
    }
  };

  return {
    play,
    pause,
    seek,
    isPlaying: (): boolean => alive && intended,
    tick: (): void => {
      if (!alive || !intended) return;
      const { start, end } = options.range();
      const length = Math.max(0, end - start);
      const relative = Math.floor(audio.currentTime * FPS + 0.0001) - start;
      const previewEnd = options.previewWindow?.()?.end ?? length;
      if (!length || audio.ended || (!audio.paused && relative >= previewEnd)) finish();
      else if (!audio.paused) publish(Math.max(0, relative));
    },
    onPause: (): void => {
      if (!alive || !audio.paused || !intended) return;
      if (audio.ended) finish();
      else pause();
    },
    onEnded: (): void => {
      // После уже обработанного loop событие ended может оставаться в очереди старого прохода.
      if (audio.ended) finish();
    },
    dispose: (): void => {
      alive = false;
      pause();
    }
  };
}

export type MontagePlayback = ReturnType<typeof createMontagePlayback>;
