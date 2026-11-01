import { type MouseEvent, type WheelEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '@mui/material';
import { timingTexts } from '@shared/texts/timing';
import { resolveTimingSections } from '@shared/timing-sections';
import type { TimingLine, TimingSection, TimingView } from '@shared/types';
import { hitTimingBlock, timingDragPatch, timingWaveLayout, type TimingDragMode } from './timingWaveGeometry';
import { decodePeaks, drawWaveform, type Peaks } from './waveform';

type Drag = { id: number; mode: TimingDragMode; offset: number; original: TimingLine } | null;

export interface TimingPlayerOptions {
  manualMode?: boolean;
  view: TimingView | null;
  lines: TimingLine[];
  sections: TimingSection[];
  selected: number | null;
  setSelected: (id: number | null) => void;
  updateLine: (id: number, patch: Partial<TimingLine>) => void;
  busy: boolean;
  generating: boolean;
  generateOpen: boolean;
  describeError: (error: unknown) => string;
}

/** Плеер, мышь и клавиатура используют одну шкалу времени и общие ограничения границ. */
export function useTimingPlayer({
  view,
  lines,
  sections: savedSections,
  selected,
  setSelected,
  updateLine,
  busy,
  generating,
  generateOpen,
  describeError,
  manualMode = false
}: TimingPlayerOptions) {
  const theme = useTheme();
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const [peaksError, setPeaksError] = useState<string | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [pps, setPps] = useState(48);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(1);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<Drag>(null);
  const stopAtRef = useRef<number | null>(null);
  const linesRef = useRef<TimingLine[]>([]);
  linesRef.current = lines;

  const rawDuration = peaks?.duration ?? view?.duration ?? 0;
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
  const layout = useMemo(() => timingWaveLayout(lines, pps, manualMode), [lines, pps, manualMode]);
  // URL меняется вместе с содержимым: плеер и волна не используют кэш прежнего track.mp3.
  const trackUrl = view?.trackPath ? `${window.api.shell.fileUrl(view.trackPath)}?v=${view.trackSha256 ?? ''}` : null;
  const sections = useMemo(
    () =>
      resolveTimingSections(
        savedSections.filter((section) => Number.isFinite(section.start) && Number.isFinite(section.end) && section.end > section.start),
        view?.lyrics ?? [],
        lines.filter((line) => Number.isFinite(line.start) && Number.isFinite(line.end) && line.end > line.start),
        duration || null
      ),
    [savedSections, view?.lyrics, lines, duration]
  );

  useEffect(() => {
    let cancelled = false;
    const audio = audioRef.current;
    stopAtRef.current = null;
    setTime(0);
    setPlaying(false);
    setPeaks(null);
    setPeaksError(null);
    setPlaybackError(null);
    if (trackUrl)
      decodePeaks(trackUrl)
        .then((p) => {
          if (!cancelled) setPeaks(p);
        })
        .catch((error) => {
          if (!cancelled) setPeaksError(describeError(error));
        });
    return () => {
      cancelled = true;
      audio?.pause();
    };
  }, [trackUrl, describeError]);

  useEffect(() => {
    // Громкость меняет только прослушивание, исходный трек и амплитуда волны остаются прежними.
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume, trackUrl]);

  // Плейхед и остановка в конце строки: кадр за кадром, пока идёт воспроизведение.
  useEffect(() => {
    let frame = 0;
    const tick = (): void => {
      const audio = audioRef.current;
      if (audio) {
        setTime(audio.currentTime);
        if (stopAtRef.current !== null && audio.currentTime >= stopAtRef.current) {
          audio.pause();
          stopAtRef.current = null;
        }
        const container = scrollRef.current;
        if (!audio.paused && container) {
          const x = audio.currentTime * pps;
          if (x < container.scrollLeft || x > container.scrollLeft + container.clientWidth - 40)
            container.scrollLeft = Math.max(0, x - container.clientWidth * 0.2);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [pps]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = scrollRef.current;
    if (!canvas || !container) return;
    drawWaveform({ canvas, container, lines, sections, peaks, selected, pps, time, mode: theme.palette.mode, layout });
  }, [lines, peaks, pps, selected, theme.palette.mode, time, sections, layout]);

  useEffect(() => {
    draw();
  }, [draw, scrollLeft]);

  useEffect(() => {
    const observer = new ResizeObserver(() => draw());
    if (scrollRef.current) observer.observe(scrollRef.current);
    return () => observer.disconnect();
  }, [draw]);

  const timeAt = (clientX: number, clampToTrack = true): number => {
    // Рисование и мышь отсчитывают координату от самой канвы, без рамки контейнера.
    const rect = canvasRef.current!.getBoundingClientRect();
    const position = (clientX - rect.left + scrollRef.current!.scrollLeft) / pps;
    return clampToTrack ? Math.max(0, Math.min(duration || Infinity, position)) : position;
  };

  const hitLine = (clientX: number, clientY: number): ReturnType<typeof hitTimingBlock> => {
    const canvas = canvasRef.current;
    const container = scrollRef.current;
    if (!canvas || !container) return null;
    const rect = canvas.getBoundingClientRect();
    return hitTimingBlock(layout, clientX - rect.left + container.scrollLeft, clientY - rect.top);
  };

  const onMouseDown = (event: MouseEvent): void => {
    if (!view || busy || generating || generateOpen || event.button !== 0) return;
    const t = timeAt(event.clientX, false);
    const hit = hitLine(event.clientX, event.clientY);
    if (hit) {
      const boundary = hit.mode === 'end' ? hit.line.end : hit.line.start;
      dragRef.current = { id: hit.line.id, mode: hit.mode, offset: t - boundary, original: { ...hit.line } };
      setSelected(hit.line.id);
    } else seek(t);
  };

  const onMouseMove = (event: MouseEvent): void => {
    const drag = dragRef.current;
    if (!drag) {
      const hit = hitLine(event.clientX, event.clientY);
      if (scrollRef.current) scrollRef.current.style.cursor = hit ? (hit.mode === 'move' ? 'grab' : 'ew-resize') : 'text';
      return;
    }
    if (busy || generating || generateOpen) return;
    const patch = timingDragPatch(drag.original, drag.mode, timeAt(event.clientX, false), drag.offset, linesRef.current, duration, manualMode);
    if (patch) updateLine(drag.id, patch);
  };

  const onMouseUp = (): void => {
    dragRef.current = null;
  };

  const onWheel = (event: WheelEvent): void => {
    if (event.ctrlKey || event.metaKey) {
      const t = timeAt(event.clientX);
      const next = Math.max(8, Math.min(400, pps * (event.deltaY < 0 ? 1.2 : 1 / 1.2)));
      const container = scrollRef.current!;
      const offset = event.clientX - canvasRef.current!.getBoundingClientRect().left;
      setPps(next);
      requestAnimationFrame(() => {
        container.scrollLeft = Math.max(0, t * next - offset);
      });
    } else if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      scrollRef.current!.scrollLeft += event.deltaY;
    }
  };

  const seek = (t: number): void => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(t)) return;
    stopAtRef.current = null;
    const bounded = Math.max(0, Math.min(duration || Infinity, t));
    audio.currentTime = bounded;
    setTime(bounded);
  };

  const togglePlay = (): void => {
    const audio = audioRef.current;
    if (!audio) return;
    stopAtRef.current = null;
    if (audio.paused) playAudio(audio);
    else audio.pause();
  };

  const playLine = (line: TimingLine): void => {
    const audio = audioRef.current;
    if (!audio) return;
    setSelected(line.id);
    // Невалидный ручной черновик не передаём браузерному audio; проверка нужна только по явному прослушиванию.
    if (!Number.isFinite(line.start) || !Number.isFinite(line.end) || line.start < 0 || line.end <= line.start || (duration > 0 && line.start >= duration)) {
      setPlaybackError(timingTexts.invalidPlaybackRange);
      return;
    }
    audio.currentTime = Math.max(0, line.start - 0.15);
    stopAtRef.current = line.end + 0.1;
    playAudio(audio);
    scrollTo(line.start);
  };

  // Отказ декодера показывается в плеере; закрытая или заменённая дорожка не обновляет новый экран.
  // AbortError при обычной паузе или смене src не является ошибкой прослушивания.
  const playAudio = (audio: HTMLAudioElement): void => {
    setPlaybackError(null);
    void audio.play().catch((reason: unknown) => {
      if (audioRef.current !== audio || (reason instanceof DOMException && reason.name === 'AbortError')) return;
      stopAtRef.current = null;
      setPlaying(false);
      setPlaybackError(timingTexts.playbackFailed({ reason: describeError(reason) }));
    });
  };

  const scrollTo = (t: number): void => {
    const container = scrollRef.current;
    if (!container || !Number.isFinite(t)) return;
    const x = t * pps;
    if (!Number.isFinite(x)) return;
    if (x < container.scrollLeft + 40 || x > container.scrollLeft + container.clientWidth - 40)
      container.scrollLeft = Math.max(0, x - container.clientWidth * 0.3);
  };

  // Клавиши: пробел, Enter, скобки, стрелки, V. В полях ввода не перехватываются.
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (busy || generating || generateOpen || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (
        target?.closest(
          'input, textarea, select, button, a, [role="button"], [role="slider"], [role="dialog"], [role="region"][tabindex], [contenteditable="true"]'
        )
      )
        return;
      const current = selected === null ? null : linesRef.current.find((l) => l.id === selected);
      if (event.code === 'Space') {
        event.preventDefault();
        togglePlay();
      } else if (event.key === 'Enter' && current) {
        playLine(current);
      } else if (event.key === '[' && current) {
        const patch = timingDragPatch(current, 'start', audioRef.current?.currentTime ?? 0, 0, linesRef.current, duration, manualMode);
        if (patch) updateLine(current.id, patch);
      } else if (event.key === ']' && current) {
        const patch = timingDragPatch(current, 'end', audioRef.current?.currentTime ?? 0, 0, linesRef.current, duration, manualMode);
        if (patch) updateLine(current.id, patch);
        // eslint-disable-next-line no-restricted-syntax -- Физическая горячая клавиша в русской раскладке, а не текст интерфейса.
      } else if ((event.key === 'v' || event.key === 'м') && current) {
        updateLine(current.id, { verified: !current.verified });
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const sorted = [...linesRef.current].sort((a, b) => a.start - b.start);
        if (!sorted.length) return;
        event.preventDefault();
        const index = sorted.findIndex((l) => l.id === selected);
        const next = sorted[Math.max(0, Math.min(sorted.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
        setSelected(next.id);
        scrollTo(next.start);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, duration, pps, busy, generating, generateOpen, manualMode]);

  return {
    sections,
    canvasHeight: layout.canvasHeight,
    hitLine,
    duration,
    time,
    playing,
    volume,
    setVolume,
    pps,
    setPps,
    peaks,
    peaksError,
    playbackError,
    trackUrl,
    audioRef,
    canvasRef,
    scrollRef,
    setPlaying,
    setScrollLeft,
    togglePlay,
    playLine,
    scrollTo,
    timeAt,
    onMouseDown,
    onMouseMove,
    onMouseUp,
    onWheel
  };
}

export type TimingPlayerController = ReturnType<typeof useTimingPlayer>;
