/**
 * Полноэкранный просмотр видео средствами приложения. WebKitGTK на части видеокарт показывает в
 * полноэкранном режиме самого элемента <video> чёрный кадр, хотя видео в странице воспроизводится.
 * Поэтому полный экран — это полноэкранный Dialog MUI с отдельным <video> того же файла, а окно
 * приложения разворачивает Go (window.api.shell.setFullscreen). Положение, громкость и
 * воспроизведение переходят в диалог и обратно, исходный элемент на это время ставится на паузу.
 * Кнопка полного экрана встроенных элементов управления перехватывается тем же путём.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Dialog, IconButton } from '@mui/material';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import { componentsTexts } from '@shared/texts/components';

/** Состояние видео при переходе: адрес, позиция в секундах, громкость и шло ли воспроизведение. */
interface VideoState {
  src: string;
  time: number;
  volume: number;
  muted: boolean;
  playing: boolean;
}

/** Видео с полноэкранным режимом WebKit, которого нет в стандартных типах DOM. */
type WebkitVideo = HTMLVideoElement & { webkitExitFullscreen?: () => void };

/** Снимок состояния элемента для переноса в другой элемент. */
function snapshot(video: HTMLVideoElement): VideoState {
  return { src: video.currentSrc || video.src, time: video.currentTime, volume: video.volume, muted: video.muted, playing: !video.paused && !video.ended };
}

/** Применяет снимок к элементу; play() может быть отклонён WebView — тогда видео остаётся на паузе. */
function restore(video: HTMLVideoElement, state: VideoState): void {
  video.volume = state.volume;
  video.muted = state.muted;
  if (Number.isFinite(state.time)) video.currentTime = state.time;
  if (state.playing) void video.play().catch(() => undefined);
}

/** Режим окна; отказ не мешает просмотру: диалог и так занимает всё окно. */
function setWindowFullscreen(fullscreen: boolean): void {
  void window.api.shell.setFullscreen(fullscreen).catch(() => undefined);
}

/**
 * Полный экран для видео, которое возвращает getVideo. open — вход по кнопке страницы, dialog —
 * элемент, который страница выводит рядом с видео. Выход — Escape или кнопка в углу.
 */
export function useVideoFullscreen(getVideo: () => HTMLVideoElement | null, label?: string): { open: () => void; dialog: ReactElement | null } {
  const [state, setState] = useState<VideoState | null>(null);
  const fullscreen = useRef<HTMLVideoElement | null>(null);
  const source = useRef(getVideo);
  source.current = getVideo;

  const open = useCallback(() => {
    const video = source.current();
    if (!video || !(video.currentSrc || video.src)) return;
    const current = snapshot(video);
    video.pause();
    setState(current);
    setWindowFullscreen(true);
  }, []);

  const close = useCallback(() => {
    const video = source.current();
    if (fullscreen.current && video) restore(video, snapshot(fullscreen.current));
    setState(null);
    setWindowFullscreen(false);
  }, []);

  // Полный экран самого элемента (кнопка встроенных элементов управления) сразу отменяется и
  // заменяется просмотром приложения; в открытом диалоге та же кнопка только отменяется. WebKit
  // сообщает о нём либо как о полном экране элемента (fullscreenchange), либо как о полноэкранном
  // режиме видео (webkitbeginfullscreen, не всплывает — поэтому слушатель в фазе захвата).
  useEffect(() => {
    const intercept = (element: Element | null, exit: () => void): void => {
      if (!element) return;
      if (element === fullscreen.current) exit();
      else if (element === source.current()) {
        exit();
        open();
      }
    };
    const exitDocument = (): void => void document.exitFullscreen().catch(() => undefined);
    const onElement = (): void => intercept(document.fullscreenElement, exitDocument);
    const onVideo = (event: Event): void => {
      const video = event.target as WebkitVideo;
      intercept(video, () => video.webkitExitFullscreen?.());
    };
    document.addEventListener('fullscreenchange', onElement);
    document.addEventListener('webkitbeginfullscreen', onVideo, true);
    return () => {
      document.removeEventListener('fullscreenchange', onElement);
      document.removeEventListener('webkitbeginfullscreen', onVideo, true);
    };
  }, [open]);

  // Страница ушла, пока видео на весь экран: окно возвращается в обычный режим.
  const active = state !== null;
  useEffect(() => {
    if (!active) return undefined;
    return () => setWindowFullscreen(false);
  }, [active]);

  const dialog = state ? (
    <Dialog fullScreen open onClose={close} aria-label={label ?? componentsTexts.videoFullscreen.video} slotProps={{ paper: { sx: { bgcolor: '#000' } } }}>
      <video
        ref={fullscreen}
        src={state.src}
        controls
        autoFocus
        aria-label={label ?? componentsTexts.videoFullscreen.video}
        onLoadedMetadata={(event) => restore(event.currentTarget, state)}
        style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000', display: 'block' }}
      />
      <IconButton
        onClick={close}
        title={componentsTexts.videoFullscreen.exit}
        aria-label={componentsTexts.videoFullscreen.exit}
        sx={{ position: 'absolute', top: 16, right: 16, color: '#fff', bgcolor: 'rgba(0, 0, 0, 0.5)', '&:hover': { bgcolor: 'rgba(0, 0, 0, 0.7)' } }}
      >
        <FullscreenExitIcon />
      </IconButton>
    </Dialog>
  ) : null;

  return { open, dialog };
}
