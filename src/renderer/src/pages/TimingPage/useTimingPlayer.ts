import { type MouseEvent, type WheelEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '@mui/material';
import { resolveTimingSections } from '@shared/timing-sections';
import type { TimingLine, TimingSection, TimingView } from '@shared/types';
import { MIN_LENGTH, neighbours, round } from './timing';
import { decodePeaks, drawWaveform, type Peaks, WAVE_TOP, WAVE_H } from './waveform';

type Drag = { id: number; mode: 'start' | 'end' | 'move'; offset: number; original: TimingLine } | null;

interface TimingPlayerOptions {
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
  describeError
}: TimingPlayerOptions) {
  const theme = useTheme();
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const [peaksError, setPeaksError] = useState<string | null>(null);
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

  const duration = peaks?.duration ?? view?.duration ?? 0;
  // URL меняется вместе с содержимым: плеер и волна не используют кэш прежнего track.mp3.
  const trackUrl = view?.trackPath ? `${window.api.shell.fileUrl(view.trackPath)}?v=${view.trackSha256 ?? ''}` : null;
  const sections = useMemo(
    () => resolveTimingSections(savedSections, view?.lyrics ?? [], lines, duration || null),
    [savedSections, view?.lyrics, lines, duration]
  );

  useEffect(() => {
    if (!trackUrl) return;
    let cancelled = false;
    stopAtRef.current = null;
    setTime(0);
    setPlaying(false);
    setPeaks(null);
    setPeaksError(null);
    decodePeaks(trackUrl)
      .then((p) => {
        if (!cancelled) setPeaks(p);
      })
      .catch((error) => {
        if (!cancelled) setPeaksError(describeError(error));
      });
    return () => {
      cancelled = true;
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
    drawWaveform({ canvas, container, lines, sections, peaks, selected, pps, time, mode: theme.palette.mode });
  }, [lines, peaks, pps, selected, theme.palette.mode, time, sections]);

  useEffect(() => {
    draw();
  }, [draw, scrollLeft]);

  useEffect(() => {
    const observer = new ResizeObserver(() => draw());
    if (scrollRef.current) observer.observe(scrollRef.current);
    return () => observer.disconnect();
  }, [draw]);

  const timeAt = (clientX: number): number => {
    // Рисование и мышь отсчитывают координату от самой канвы, без рамки контейнера.
    const rect = canvasRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration || Infinity, (clientX - rect.left + scrollRef.current!.scrollLeft) / pps));
  };

  const onMouseDown = (event: MouseEvent): void => {
    if (!view || busy || generating || generateOpen) return;
    const t = timeAt(event.clientX);
    const tolerance = 6 / pps;
    const y = event.clientY - canvasRef.current!.getBoundingClientRect().top;
    if (y >= WAVE_TOP && y <= WAVE_TOP + WAVE_H) {
      for (const line of lines) {
        if (Math.abs(t - line.start) <= tolerance) return startDrag(line, 'start', t);
        if (Math.abs(t - line.end) <= tolerance) return startDrag(line, 'end', t);
      }
      const inside = lines.find((l) => t >= l.start && t <= l.end);
      if (inside) {
        setSelected(inside.id);
        return startDrag(inside, 'move', t - inside.start);
      }
    }
    seek(t);
  };

  const startDrag = (line: TimingLine, mode: Drag extends null ? never : NonNullable<Drag>['mode'], offset: number): void => {
    dragRef.current = { id: line.id, mode, offset, original: line };
    setSelected(line.id);
  };

  const onMouseMove = (event: MouseEvent): void => {
    const drag = dragRef.current;
    const t = timeAt(event.clientX);
    if (!drag) {
      const tolerance = 6 / pps;
      const nearEdge = lines.some((l) => Math.abs(t - l.start) <= tolerance || Math.abs(t - l.end) <= tolerance);
      scrollRef.current!.style.cursor = nearEdge ? 'ew-resize' : lines.some((l) => t >= l.start && t <= l.end) ? 'grab' : 'text';
      return;
    }
    const { prevEnd, nextStart } = neighbours(drag.id, linesRef.current, duration);
    const line = linesRef.current.find((l) => l.id === drag.id);
    if (!line) return;
    if (drag.mode === 'start') updateLine(drag.id, { start: round(Math.max(prevEnd, Math.min(line.end - MIN_LENGTH, t))) });
    else if (drag.mode === 'end') updateLine(drag.id, { end: round(Math.min(nextStart, Math.max(line.start + MIN_LENGTH, t))) });
    else {
      const length = line.end - line.start;
      const start = Math.max(prevEnd, Math.min(nextStart - length, t - drag.offset));
      updateLine(drag.id, { start: round(start), end: round(start + length) });
    }
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
    if (!audio) return;
    stopAtRef.current = null;
    audio.currentTime = t;
    setTime(t);
  };

  const togglePlay = (): void => {
    const audio = audioRef.current;
    if (!audio) return;
    stopAtRef.current = null;
    if (audio.paused) void audio.play();
    else audio.pause();
  };

  const playLine = (line: TimingLine): void => {
    const audio = audioRef.current;
    if (!audio) return;
    setSelected(line.id);
    audio.currentTime = Math.max(0, line.start - 0.15);
    stopAtRef.current = line.end + 0.1;
    void audio.play();
    scrollTo(line.start);
  };

  const scrollTo = (t: number): void => {
    const container = scrollRef.current;
    if (!container) return;
    const x = t * pps;
    if (x < container.scrollLeft + 40 || x > container.scrollLeft + container.clientWidth - 40)
      container.scrollLeft = Math.max(0, x - container.clientWidth * 0.3);
  };

  // Клавиши: пробел, Enter, скобки, стрелки, V. В полях ввода не перехватываются.
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (busy || generating || generateOpen || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (target?.closest('input, textarea, select, button, a, [role="button"], [role="slider"], [role="dialog"], [contenteditable="true"]')) return;
      const current = selected === null ? null : linesRef.current.find((l) => l.id === selected);
      if (event.code === 'Space') {
        event.preventDefault();
        togglePlay();
      } else if (event.key === 'Enter' && current) {
        playLine(current);
      } else if (event.key === '[' && current) {
        const { prevEnd } = neighbours(current.id, linesRef.current, duration);
        updateLine(current.id, { start: round(Math.max(prevEnd, Math.min(current.end - MIN_LENGTH, audioRef.current?.currentTime ?? 0))) });
      } else if (event.key === ']' && current) {
        const { nextStart } = neighbours(current.id, linesRef.current, duration);
        updateLine(current.id, { end: round(Math.min(nextStart, Math.max(current.start + MIN_LENGTH, audioRef.current?.currentTime ?? 0))) });
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
  }, [selected, duration, pps, busy, generating, generateOpen]);

  return {
    sections,
    duration,
    time,
    playing,
    volume,
    setVolume,
    pps,
    setPps,
    peaks,
    peaksError,
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
