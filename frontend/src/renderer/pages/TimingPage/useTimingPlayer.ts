import { type MouseEvent, type WheelEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '@mui/material';
import { timingTexts } from '@shared/texts/timing';
import { resolveTimingSections } from '@shared/timing-sections';
import type { TimingCandidate, TimingLine, TimingSection, TimingView } from '@shared/types';
import { timingPlaybackBounds } from './timingPlayback';
import { hasMinimumTimingLength } from '@shared/timing-validation';
import { hitTimingBlock, timingDragPatch, timingWaveLayout, type TimingDragMode } from './timingWaveGeometry';
import { timingPair, timingPairPatch, timingSelectionBounds, timingJoinBounds, timingZoomBounds, type TimingBounds } from './timingSelection';
import { WAVE_TOP } from './timingWaveGeometry';
import { decodePeaks, drawWaveform, type Peaks } from './waveform';

type Drag =
  | { id: number; mode: TimingDragMode; offset: number; original: TimingLine }
  | { mode: 'join'; ids: number[]; offset: number }
  | { mode: 'range'; start: number }
  | null;
type Preview = 'selection' | 'join';
type Range = { id: number; loop: boolean; selection?: { key: string; preview: Preview } };

export interface TimingPlayerOptions {
  manualMode?: boolean;
  view: TimingView | null;
  lines: TimingLine[];
  navigationLines?: TimingLine[];
  sectionLines?: TimingLine[];
  candidates?: TimingCandidate[];
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
  sectionLines,
  navigationLines,
  candidates,
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
  const [extraSelection, setExtraSelection] = useState<{ primary: number; secondary: number } | null>(null);
  const [rangeSelection, setRangeSelection] = useState<(TimingBounds & { key: number }) | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [selectionPreview, setPreview] = useState<Preview>('selection');
  const [joinPadding, setPadding] = useState(0.7);
  const rangeSequence = useRef(0);
  const pausedByUser = useRef(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<Drag>(null);
  const rangeRef = useRef<Range | null>(null);
  const [activeRange, setActiveRange] = useState<Range | null>(null);
  const rangeKey = useRef('');
  const playPending = useRef(false);
  const linesRef = useRef<TimingLine[]>([]);
  linesRef.current = lines;
  // Клавиатура должна применять правку к текущему черновику, даже без смены выделения.
  const updateLineRef = useRef(updateLine);
  updateLineRef.current = updateLine;
  const navigationLinesRef = useRef<TimingLine[]>([]);
  navigationLinesRef.current = navigationLines ?? lines;

  const rawDuration = peaks?.duration ?? view?.duration ?? 0;
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
  const selectionIds = useMemo(() => {
    if (rangeSelection || selected === null || !lines.some((line) => line.id === selected)) return [];
    const ids = [selected];
    if (extraSelection?.primary === selected && lines.some((line) => line.id === extraSelection.secondary)) ids.push(extraSelection.secondary);
    return ids;
  }, [selected, lines, extraSelection, rangeSelection]);
  const pair = useMemo(() => timingPair(lines, selectionIds), [lines, selectionIds]);
  const selectionKind = rangeSelection ? 'range' : selectionIds.length === 2 ? 'pair' : selectionIds.length === 1 ? 'line' : 'none';
  const selectionBounds = rangeSelection
    ? timingPlaybackBounds({ id: -1, source_line: -1, ...rangeSelection }, duration)
    : timingSelectionBounds(lines, selectionIds, duration);
  const selectionKey = rangeSelection ? `range:${rangeSelection.key}` : [...selectionIds].sort((a, b) => a - b).join(',');
  const selectionRef = useRef({ key: selectionKey, bounds: selectionBounds, pair, padding: joinPadding });
  selectionRef.current = { key: selectionKey, bounds: selectionBounds, pair, padding: joinPadding };
  const interactionDisabled = busy || generating || generateOpen;
  const layout = useMemo(() => timingWaveLayout(lines, pps, manualMode), [lines, pps, manualMode]);
  // URL меняется вместе с содержимым: плеер и волна не используют кэш прежнего track.mp3.
  const trackUrl = view?.trackPath ? `${window.api.shell.fileUrl(view.trackPath)}?v=${view.trackSha256 ?? ''}` : null;
  const sections = useMemo(
    () =>
      resolveTimingSections(
        savedSections.filter((section) => Number.isFinite(section.start) && Number.isFinite(section.end) && section.end > section.start),
        view?.lyrics ?? [],
        (sectionLines ?? lines).filter((line) => Number.isFinite(line.start) && Number.isFinite(line.end) && line.end > line.start),
        duration || null,
        candidates
      ),
    [savedSections, view?.lyrics, lines, sectionLines, candidates, duration]
  );

  useEffect(() => {
    let cancelled = false;
    const audio = audioRef.current;
    rangeRef.current = null;
    setActiveRange(null);
    rangeKey.current = '';
    setTime(0);
    setPlaying(false);
    setPeaks(null);
    setPeaksError(null);
    setPlaybackError(null);
    setExtraSelection(null);
    setRangeSelection(null);
    setSelectionError(null);
    setPreview('selection');
    pausedByUser.current = false;
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

  const stopLine = useCallback((): void => {
    rangeRef.current = null;
    setActiveRange(null);
    rangeKey.current = '';
    pausedByUser.current = false;
    audioRef.current?.pause();
    setPlaying(false);
  }, []);

  const playAudio = useCallback(
    (audio: HTMLAudioElement): void => {
      if (playPending.current) return;
      playPending.current = true;
      setPlaybackError(null);
      void audio
        .play()
        .catch((reason: unknown) => {
          if (audioRef.current !== audio || (reason instanceof DOMException && reason.name === 'AbortError')) return;
          stopLine();
          setPlaybackError(timingTexts.playbackFailed({ reason: describeError(reason) }));
        })
        .finally(() => {
          playPending.current = false;
        });
    },
    [describeError, stopLine]
  );

  // Цикл хранит ID, а не прежние секунды: ввод и drag сразу меняют слышимый интервал.
  // Незаконченная граница временно приостанавливает цикл; исправление возобновляет его без нового клика.
  useEffect(() => {
    let frame = 0;
    const tick = (): void => {
      const audio = audioRef.current;
      if (audio) {
        setTime(audio.currentTime);
        const range = rangeRef.current;
        if (range) {
          const selection = selectionRef.current;
          const bounds = range.selection
            ? range.selection.key !== selection.key
              ? null
              : range.selection.preview === 'join'
                ? selection.pair
                  ? timingJoinBounds(selection.pair, duration, selection.padding)
                  : null
                : selection.bounds
            : timingPlaybackBounds(
                linesRef.current.find((line) => line.id === range.id),
                duration
              );
          if (!bounds) {
            audio.pause();
            if (range.selection ? range.selection.key !== selection.key : !linesRef.current.some((line) => line.id === range.id)) stopLine();
            else if (range.loop) setPlaybackError(timingTexts.loopInvalidRange);
            else {
              stopLine();
              setPlaybackError(timingTexts.invalidPlaybackRange);
            }
          } else {
            const key = `${range.id}:${bounds.start}:${bounds.end}`;
            if (rangeKey.current !== key) {
              audio.currentTime = range.loop || range.selection ? bounds.start : Math.max(0, bounds.start - 0.15);
              rangeKey.current = key;
              setPlaybackError(null);
            }
            const stopAt = range.loop || range.selection ? bounds.end : Math.min(duration || Infinity, bounds.end + 0.1);
            if (audio.currentTime >= stopAt) {
              if (range.loop) audio.currentTime = bounds.start;
              else stopLine();
            }
            if (rangeRef.current?.loop && audio.paused && !playPending.current && !pausedByUser.current) playAudio(audio);
          }
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
  }, [pps, duration, playAudio, stopLine]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = scrollRef.current;
    if (!canvas || !container) return;
    drawWaveform({
      canvas,
      container,
      lines,
      sections,
      peaks,
      selected,
      selectedIds: selectionIds,
      selectionBounds,
      join: pair?.join !== null && pair?.join !== undefined ? { time: pair.join, locked: pair.locked } : null,
      pps,
      time,
      mode: theme.palette.mode,
      layout
    });
  }, [lines, peaks, pps, selected, selectionIds, selectionBounds, pair, theme.palette.mode, time, sections, layout]);

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

  /** Выделение не меняет документ. Ctrl выбирает пару, Shift задаёт произвольное окно звука. */
  const selectLine = (id: number | null, additive = false): void => {
    if (interactionDisabled) return;
    setSelectionError(null);
    if (!additive || id === null) {
      if (selectionKind !== 'line' || selectionIds[0] !== id) stopLine();
      setExtraSelection(null);
      setRangeSelection(null);
      setPreview('selection');
      setSelected(id);
      return;
    }
    if (selectionIds.includes(id)) {
      const remaining = selectionIds.filter((current) => current !== id);
      stopLine();
      setExtraSelection(null);
      setRangeSelection(null);
      setSelected(remaining[0] ?? null);
      return;
    }
    if (!selectionIds.length) {
      selectLine(id);
      return;
    }
    if (!navigationLinesRef.current.some((line) => line.id === id)) {
      setSelectionError(timingTexts.selectionNeedsVisible);
      return;
    }
    if (selectionIds.length === 2 || !timingPair(linesRef.current, [selectionIds[0], id])) {
      setSelectionError(timingTexts.selectionNeedsAdjacent);
      return;
    }
    stopLine();
    setPreview('selection');
    setExtraSelection({ primary: selectionIds[0], secondary: id });
  };

  const hitJoin = (clientX: number, clientY: number): boolean => {
    if (!pair || pair.join === null || !canvasRef.current) return false;
    const rect = canvasRef.current.getBoundingClientRect();
    const y = clientY - rect.top;
    const blocks = layout.blocks.filter((block) => selectionIds.includes(block.line.id));
    const bottom = Math.max(WAVE_TOP, ...blocks.map((block) => block.top + block.height));
    return Math.abs(timeAt(clientX, false) * pps - pair.join * pps) <= 8 && y >= WAVE_TOP - 5 && y <= bottom;
  };

  const onMouseDown = (event: MouseEvent): void => {
    if (!view || interactionDisabled || event.button !== 0) return;
    const t = timeAt(event.clientX, false);
    const hit = hitLine(event.clientX, event.clientY);
    dragRef.current = null;
    if (event.shiftKey) {
      stopLine();
      setExtraSelection(null);
      setSelected(null);
      setPreview('selection');
      const start = Math.max(0, Math.min(duration || Infinity, t));
      setRangeSelection({ start, end: start, key: ++rangeSequence.current });
      dragRef.current = { mode: 'range', start };
    } else if (event.ctrlKey || event.metaKey) {
      if (hit) selectLine(hit.line.id, true);
    } else if (hitJoin(event.clientX, event.clientY) && pair && pair.join !== null) {
      // Закреплённый стык нельзя обойти переносом незакреплённой половины пары.
      if (!pair.locked) dragRef.current = { mode: 'join', ids: [...selectionIds], offset: t - pair.join };
    } else if (hit) {
      selectLine(hit.line.id);
      if (hit.line.verified) return;
      const boundary = hit.mode === 'end' ? hit.line.end : hit.line.start;
      dragRef.current = { id: hit.line.id, mode: hit.mode, offset: t - boundary, original: { ...hit.line } };
    } else seek(t);
  };

  const onMouseMove = (event: MouseEvent): void => {
    const drag = dragRef.current;
    if (!drag) {
      const hit = hitLine(event.clientX, event.clientY);
      if (scrollRef.current)
        scrollRef.current.style.cursor = hitJoin(event.clientX, event.clientY)
          ? pair?.locked
            ? 'pointer'
            : 'ew-resize'
          : hit
            ? hit.line.verified
              ? 'pointer'
              : hit.mode === 'move'
                ? 'grab'
                : 'ew-resize'
            : 'text';
      return;
    }
    if (interactionDisabled) return;
    if (drag.mode === 'range') {
      const t = timeAt(event.clientX);
      setRangeSelection((current) => (current ? { ...current, start: Math.min(drag.start, t), end: Math.max(drag.start, t) } : null));
      return;
    }
    if (drag.mode === 'join') {
      const current = timingPair(linesRef.current, drag.ids);
      const patches = current && timingPairPatch(current, timeAt(event.clientX, false) - drag.offset, duration);
      if (patches) for (const { id, patch } of patches) updateLine(id, patch);
      return;
    }
    if (linesRef.current.find((line) => line.id === drag.id)?.verified) {
      dragRef.current = null;
      return;
    }
    const patch = timingDragPatch(drag.original, drag.mode, timeAt(event.clientX, false), drag.offset, linesRef.current, duration, manualMode);
    if (patch) updateLine(drag.id, patch);
  };

  const onMouseUp = (): void => {
    dragRef.current = null;
  };

  const onWheel = (event: WheelEvent): void => {
    if (event.ctrlKey || event.metaKey) {
      const t = timeAt(event.clientX);
      const next = Math.max(0.001, Math.min(400, pps * (event.deltaY < 0 ? 1.2 : 1 / 1.2)));
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
    rangeRef.current = null;
    setActiveRange(null);
    rangeKey.current = '';
    const bounded = Math.max(0, Math.min(duration || Infinity, t));
    audio.currentTime = bounded;
    setTime(bounded);
  };

  const togglePlay = (): void => {
    const audio = audioRef.current;
    if (!audio) return;
    rangeRef.current = null;
    setActiveRange(null);
    rangeKey.current = '';
    if (audio.paused) playAudio(audio);
    else audio.pause();
  };

  const startLine = (line: TimingLine, loop: boolean): void => {
    const audio = audioRef.current;
    if (!audio) return;
    const bounds = timingPlaybackBounds(line, duration);
    if (!bounds) {
      setPlaybackError(timingTexts.invalidPlaybackRange);
      return;
    }
    selectLine(line.id);
    pausedByUser.current = false;
    const next = { id: line.id, loop };
    rangeRef.current = next;
    setActiveRange(next);
    rangeKey.current = `${line.id}:${bounds.start}:${bounds.end}`;
    audio.currentTime = loop ? bounds.start : Math.max(0, bounds.start - 0.15);
    playAudio(audio);
    scrollTo(bounds.start);
  };
  const playLine = (line: TimingLine): void => {
    if (rangeRef.current?.id === line.id && !audioRef.current?.paused) stopLine();
    else startLine(line, false);
  };
  const toggleLoop = (line: TimingLine): void => {
    if (rangeRef.current?.id === line.id && rangeRef.current.loop) stopLine();
    else startLine(line, true);
  };

  const setSelectionPreview = (preview: Preview): void => {
    stopLine();
    setPreview(preview);
  };
  const startSelection = (preview: Preview, loop: boolean): void => {
    const audio = audioRef.current;
    if (!audio || interactionDisabled) return;
    const state = selectionRef.current;
    const bounds = preview === 'join' ? state.pair && timingJoinBounds(state.pair, duration, state.padding) : state.bounds;
    if (!bounds) {
      setPlaybackError(timingTexts.invalidPlaybackRange);
      return;
    }
    pausedByUser.current = false;
    setPreview(preview);
    const next: Range = { id: selectionIds[0] ?? -1, loop, selection: { key: state.key, preview } };
    rangeRef.current = next;
    setActiveRange(next);
    rangeKey.current = `${next.id}:${bounds.start}:${bounds.end}`;
    audio.currentTime = bounds.start;
    playAudio(audio);
    scrollTo(bounds.start);
  };
  const toggleSelectionPlayback = (): void => {
    if (interactionDisabled) return;
    const audio = audioRef.current;
    if (!audio) return;
    if (selectionKind === 'none') {
      togglePlay();
      return;
    }
    // После seek диапазон сброшен, но звук может продолжаться: видимая Pause всегда ставит его на паузу.
    if (!audio.paused) {
      pausedByUser.current = true;
      audio.pause();
      setPlaying(false);
      return;
    }
    const range = rangeRef.current;
    if (
      (range?.selection?.key === selectionKey && range.selection.preview === selectionPreview) ||
      (selectionKind === 'line' && range?.id === selected && !range.selection)
    ) {
      if (!audio.paused) {
        pausedByUser.current = true;
        audio.pause();
        setPlaying(false);
      } else {
        pausedByUser.current = false;
        playAudio(audio);
      }
    } else startSelection(selectionPreview, false);
  };
  const toggleSelectionLoop = (): void => {
    if (interactionDisabled) return;
    if (rangeRef.current?.selection?.key === selectionKey && rangeRef.current.loop) stopLine();
    else startSelection(selectionPreview, true);
  };
  const playJoin = (): void => startSelection('join', Boolean(rangeRef.current?.loop));
  const setJoinPadding = (value: number): void => {
    if (Number.isFinite(value)) setPadding(Math.max(0.1, Math.min(10, value)));
  };
  const joinAtPlayhead = (): void => {
    if (interactionDisabled || !pair) return;
    const patches = timingPairPatch(pair, audioRef.current?.currentTime ?? time, duration);
    if (patches) for (const { id, patch } of patches) updateLine(id, patch);
  };
  const applyZoom = (bounds: TimingBounds | null): void => {
    const container = scrollRef.current;
    if (!container || !bounds) return;
    const zoom = timingZoomBounds(bounds, container.clientWidth, duration);
    if (!zoom) return;
    setPps(zoom.pps);
    requestAnimationFrame(() => {
      container.scrollLeft = zoom.scrollLeft;
      setScrollLeft(zoom.scrollLeft);
    });
  };
  const zoomAll = (): void => applyZoom({ start: 0, end: duration });
  const zoomSelection = (): void => applyZoom(selectionBounds);
  const clearSelection = (): void => selectLine(null);

  useEffect(() => {
    if (busy || generating || generateOpen) stopLine();
  }, [busy, generating, generateOpen, stopLine]);

  // Смена рабочей строки прекращает её цикл до следующего явного прослушивания.
  useEffect(() => {
    const range = rangeRef.current;
    if (range && (range.selection ? range.selection.key !== selectionKey : range.id !== selected)) stopLine();
  }, [selected, selectionKey, stopLine]);

  useEffect(() => {
    if (
      extraSelection &&
      (extraSelection.primary !== selected ||
        !linesRef.current.some((line) => line.id === extraSelection.secondary) ||
        !navigationLinesRef.current.some((line) => line.id === extraSelection.secondary))
    )
      setExtraSelection(null);
    if (rangeSelection && selected !== null) setRangeSelection(null);
  }, [extraSelection, pair, selected, rangeSelection, navigationLines]);

  useEffect(() => {
    // Валидный зазор больше не является стыком; возвращаем пару без скрытой правки её границ.
    if (selectionPreview === 'join' && selectionBounds && pair?.join == null) {
      stopLine();
      setPreview('selection');
    }
  }, [selectionPreview, selectionBounds, pair, stopLine]);

  // Отказ декодера показывается в плеере; закрытая или заменённая дорожка не обновляет новый экран.
  // AbortError при обычной паузе или смене src не является ошибкой прослушивания.

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
      const current = selected === null ? null : navigationLinesRef.current.find((l) => l.id === selected);
      if (event.code === 'Space') {
        event.preventDefault();
        toggleSelectionPlayback();
      } else if (event.key === 'Enter' && (current || selectionKind === 'range')) {
        if (selectionKind === 'pair' || selectionKind === 'range') toggleSelectionPlayback();
        else if (current) toggleSelectionPlayback();
      } else if (event.key === '[' && current && selectionKind === 'line') {
        const patch = timingDragPatch(current, 'start', audioRef.current?.currentTime ?? 0, 0, linesRef.current, duration, manualMode);
        if (patch) updateLineRef.current(current.id, patch);
      } else if (event.key === ']' && current && selectionKind === 'line') {
        const patch = timingDragPatch(current, 'end', audioRef.current?.currentTime ?? 0, 0, linesRef.current, duration, manualMode);
        if (patch) updateLineRef.current(current.id, patch);
        // eslint-disable-next-line no-restricted-syntax -- Физическая горячая клавиша в русской раскладке, а не текст интерфейса.
      } else if ((event.code === 'KeyV' || event.key === 'v' || event.key === 'м') && current) {
        // Удержание V не должно многократно снимать и возвращать подтверждение.
        if (!event.repeat) {
          const currentPair = timingPair(linesRef.current, selectionIds);
          if (currentPair) {
            if (
              !currentPair.locked &&
              [currentPair.first, currentPair.second].some((line) => !timingPlaybackBounds(line, duration) || !hasMinimumTimingLength(line.start, line.end))
            )
              return;
            for (const line of [currentPair.first, currentPair.second]) updateLineRef.current(line.id, { verified: !currentPair.locked });
          } else updateLineRef.current(current.id, { verified: !current.verified });
        }
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const sorted = manualMode ? navigationLinesRef.current : [...navigationLinesRef.current].sort((a, b) => a.start - b.start);
        if (!sorted.length) return;
        event.preventDefault();
        const index = sorted.findIndex((l) => l.id === selected);
        const next = sorted[Math.max(0, Math.min(sorted.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
        stopLine();
        selectLine(next.id);
        scrollTo(next.start);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, selectionKey, selectionKind, selectionPreview, duration, pps, busy, generating, generateOpen, manualMode]);

  return {
    selectionIds,
    selectionBounds,
    selectionKind,
    selectionError: selectionError ?? (selectionKind === 'pair' && !pair ? timingTexts.selectionNeedsAdjacent : null),
    pair,
    selectionPlaying:
      playing &&
      (activeRange?.selection?.key === selectionKey ||
        (selectionKind === 'line' && activeRange?.id === selected && !activeRange.selection) ||
        (selectionKind === 'none' && !activeRange)),
    selectionLooping: !!activeRange?.selection && activeRange.loop,
    selectionPreview,
    setSelectionPreview,
    toggleSelectionPlayback,
    toggleSelectionLoop,
    playJoin,
    joinPadding,
    setJoinPadding,
    joinAtPlayhead,
    zoomAll,
    zoomSelection,
    selectLine,
    clearSelection,
    interactionDisabled,
    sections,
    canvasHeight: layout.canvasHeight,
    hitLine,
    lockedLineId: lines.find((line) => line.id === selected && line.verified)?.id ?? null,
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
    toggleLoop,
    stopLine,
    playingLineId: playing ? (activeRange?.id ?? null) : null,
    loopingLineId: activeRange?.loop ? activeRange.id : null,
    scrollTo,
    timeAt,
    onMouseDown,
    onMouseMove,
    onMouseUp,
    onWheel
  };
}

export type TimingPlayerController = ReturnType<typeof useTimingPlayer>;
